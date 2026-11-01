import AppKit
import UserNotifications

/// 画面の状態を持つまとめ役。web/main.js の state と、それを動かす関数たちにあたる。
final class Controller: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuItemValidation, DeckDelegate,
                        UNUserNotificationCenterDelegate {
    let deck: Deck
    private var window: NSWindow!
    private let root = RootView()
    private let picker = Picker()

    // ---- state（web/main.js と同じ名前にそろえてある） ----
    var sessions: [Session] = []
    var projects: [Project] = []
    var external: [External] = []
    var panes: [String] = []          // いま画面に並べているセッション（最大12）
    var activeId: String?             // キー入力の行き先
    var confirmKill: String?          // 終了確認を出している行
    var health: Health?               // LAN に出ているかはここで判る
    var devices: [Device] = []
    var pairCode: PairCode?
    var confirmRevoke: String?
    var handoffBusy = false
    var butler: JSON?
    var butlerPick: Set<String>?      // 見立てに出すプロジェクト。nil は未選択＝既定
    var butlerOpen = Set<String>()    // 提案で本文を開いている手順 "cwd#index"
    var butlerEdit: String?           // 書き換え中の手順 "cwd#index"
    var butlerSkip: [String: Bool] = [:]   // 承認前に外した手順（サーバーには承認時にまとめて渡す）
    private var butlerPlanId: String?

    private var paneViews: [String: PaneView] = [:]
    private var attached = Set<String>()
    private var restored = false
    var sessionsLoaded: Bool { restored }
    private var toldRevived = false
    private var previousStates: [String: String] = [:]
    private var previousExternal: [Int: String] = [:]
    private var owned: [String: Bool] = [:]
    private var claimedAt: [String: Date] = [:]   // 取り返した時刻。往復よけ
    private var killArmed: String?    // 「本当に終了」を出しているセッション。入力先が替われば解く
    private var pairTimer: Timer?

    // 開き直したときに同じ並びへ戻れるように覚えておく（web 版の localStorage にあたる）
    private let paneStore = "ccdeck.panes"
    private let railStore = "ccdeck.rail"

    init(port: Int) {
        deck = Deck(port: port)
        super.init()
        deck.delegate = self
    }

    // ---------- 起動 ----------

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1400, height: 860),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = Palette.bg
        window.appearance = NSAppearance(named: .darkAqua)
        window.minSize = NSSize(width: 720, height: 420)
        window.contentView = root
        window.delegate = self
        window.setFrameAutosaveName("ccdeck.main")
        if !window.setFrameUsingName("ccdeck.main") { window.center() }

        root.rail.c = self
        root.drawer.c = self
        picker.c = self
        root.rail.newButton.onPress = { [weak self] in self?.togglePicker() }
        root.grid.onDrop = { [weak self] kind, id, index in
            if kind == .ccdeckPane { self?.movePane(id, to: index) } else { self?.insertPane(id, at: index) }
        }
        wireStageHead()
        root.railShown = UserDefaults.standard.string(forKey: railStore) != "1"

        // どの枠を押したかで入力先を切り替える。TerminalView がクリックを食べるので、ここで先に見る
        NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
            self?.activatePane(at: event)
            return event
        }
        // 相対時刻を静かに更新する
        Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            guard let self, !self.sessions.isEmpty else { return }
            self.root.rail.renderSessions()
        }

        root.rail.renderAll()
        renderStage()
        window.makeKeyAndOrderFront(nil)
        deck.connect()
        Task { @MainActor in
            await loadProjects()
            root.rail.renderButler()   // プロジェクトが揃ってから候補を出す
            await loadMobile()
        }
        NSApp.activate(ignoringOtherApps: true)
        installSnapshotHook()
        setUpNotifications()
    }

    // 確かめ用。CCDECK_SNAPSHOT=<path> で起こし、SIGUSR1 を送ると窓の中身だけを PNG に書く。
    // 画面収録の権限を求めずに、自分の窓を自分で描いて残す。
    private var snapshotSource: DispatchSourceSignal?

    // 枠や帯の見た目を確かめるためのもの。ターミナルの中身はここでは写らない（白くなる）
    private func writeSnapshot(of window: NSWindow, to path: String) {
        guard let view = window.contentView?.superview ?? window.contentView, let layer = view.layer else { return }
        let scale = window.backingScaleFactor
        let size = view.bounds.size
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale),
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let ctx = NSGraphicsContext(bitmapImageRep: rep)?.cgContext else { return }
        ctx.scaleBy(x: scale, y: scale)
        layer.render(in: ctx)
        try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
    }
    private func installSnapshotHook() {
        guard let path = ProcessInfo.processInfo.environment["CCDECK_SNAPSHOT"] else { return }
        signal(SIGUSR1, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
        source.setEventHandler { [weak self] in
            guard let self else { return }
            self.writeSnapshot(of: self.window, to: path)
            // ＋ の板は別の窓なので、出ていれば並べて書く
            if self.picker.isOpen, let board = self.picker.view.window {
                self.writeSnapshot(of: board, to: path.replacingOccurrences(of: ".png", with: "-picker.png"))
            }
        }
        source.resume()
        snapshotSource = source
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // ---------- DeckDelegate ----------

    func deckHello(_ msg: JSON) {
        // 繋ぎ直したらサーバー側の購読は消えている。もう一度 attach し直す
        attached.removeAll()
        owned.removeAll()
        announceRevived(msg["revived"] as? JSON)
        if restored { syncPanes() }
    }

    // 起動時に前回の続きを起こしていたら一度だけ伝える
    private func announceRevived(_ revived: JSON?) {
        guard !toldRevived, let revived, let total = revived["total"] as? Int, total > 0 else { return }
        toldRevived = true
        let resumed = revived["resumed"] as? Int ?? 0
        var parts = ["前回のセッション \(total) 本を復元しました"]
        if total - resumed > 0 { parts.append("\(total - resumed) 本は会話を引き継げず新規で開いています") }
        if let dropped = revived["dropped"] as? Int, dropped > 0 { parts.append("\(dropped) 本は上限を超えたため戻していません") }
        toast(parts.joined(separator: " · "), seconds: 7)
    }

    func deckSessions(_ next: [Session]) {
        // 「実行中だったものが要対応になった」瞬間だけ通知する
        for s in next {
            if let before = previousStates[s.id], before != "attention", s.status == "attention",
               s.id != activeId || !NSApp.isActive {
                notify(title: "\(s.name) が待っています", body: "承認を求めています", id: s.id)
            }
        }
        previousStates = Dictionary(next.map { ($0.id, $0.status) }, uniquingKeysWith: { a, _ in a })
        sessions = next
        if let id = confirmKill, !next.contains(where: { $0.id == id }) { confirmKill = nil }

        if !restored {
            restored = true
            restorePanes()
        }
        syncPanes()
        root.rail.renderSessions()
        if butlerPick == nil { root.rail.renderButler() }
        renderStage()
        updateBadge()
    }

    func deckExternal(_ list: [External]) {
        for s in list {
            if let before = previousExternal[s.pid], before != "attention", s.status == "attention" {
                notify(title: "\(s.title) が待っています", body: "承認を求めています", id: "ext-\(s.pid)")
            }
        }
        previousExternal = Dictionary(list.map { ($0.pid, $0.status) }, uniquingKeysWith: { a, _ in a })
        external = list
        root.rail.renderExternal()
        updateBadge()
    }

    func deckButler(_ next: JSON?) {
        let before = (butler?["plan"] as? JSON)?["state"] as? String
        butler = next
        let plan = next?["plan"] as? JSON
        let id = plan.map { "\($0["id"] ?? "")" }
        if id != butlerPlanId {
            butlerPlanId = id
            butlerSkip = [:]
            butlerEdit = nil
        }
        // 提案が届いた瞬間だけ知らせる
        if plan?["state"] as? String == "proposed" && before != "proposed" {
            toast("執事から提案があります")
            if !NSApp.isActive { notify(title: "ccdeck · 執事", body: "ご提案があります", id: "butler") }
        }
        root.rail.renderButler()
    }

    func deckReplay(id: String, data: String) { paneViews[id]?.replay(data) }
    func deckOutput(id: String, data: String) { paneViews[id]?.write(data) }

    // サイズの持ち主が変わったとき。通知のたびに測り直して送り返すと、窓が二つあるだけで
    // 持ち主が秒に何十回も入れ替わる往復になる（CLAUDE.md の落とし穴）。web/main.js の onSizeOwner と同じ判断。
    func deckSizeOwner(id: String, mine: Bool, cols: Int, rows: Int) {
        let before = owned[id]
        owned[id] = mine
        guard let pane = paneViews[id] else { return }
        let ours = pane.size
        let differs = ours.cols != cols || ours.rows != rows
        if mine {
            if differs { pane.reportSize(force: true) }
            return
        }
        // 奪われた側は、手前に居て桁数が違うときだけ取り返す。取り返しは 10 秒に一度まで。
        if differs && panes.contains(id) && window.isKeyWindow && NSApp.isActive && window.occlusionState.contains(.visible)
            && Date().timeIntervalSince(claimedAt[id] ?? .distantPast) > 10 {
            claimedAt[id] = Date()
            deck.send(["type": "claimSize", "id": id, "cols": ours.cols, "rows": ours.rows])
            return
        }
        if before == true && !mine {
            let name = sessions.first { $0.id == id }?.name ?? id
            toast("\(name) の画面サイズは他の端末が持っています")
        }
    }

    // ---------- 通知 ----------

    // 通知センターは .app に包んだときだけ使える（素の実行ファイルで触ると落ちる）。
    // 包んでいなければ Dock を跳ねさせるだけにする。
    private var canNotify: Bool { Bundle.main.bundleIdentifier != nil }

    // 許可は起動したときに求める。セッションを立てたときだけ求める形だと、
    // 立てずに使っている間は一度も聞かれず、黙って何も届かない（実際にそうなった）。
    private func setUpNotifications() {
        guard canNotify else { return }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            DispatchQueue.main.async {
                if let error {
                    NSLog("ccdeck: 通知の許可を求められませんでした: %@", error.localizedDescription)
                    self.toast("通知を使えません: \(error.localizedDescription)", seconds: 7)
                } else if !granted {
                    self.toast("通知が切られています。システム設定 › 通知 › ccdeck で入れられます", seconds: 7)
                }
                // 確かめ用。--notify-test で起こすと、許可のあとに一件だけ出す
                if granted && CommandLine.arguments.contains("--notify-test") {
                    self.notify(title: "ccdeck の通知", body: "通知センターに届いていれば成功です", id: "notify-test")
                }
            }
        }
    }

    private func notify(title: String, body: String, id: String) {
        NSApp.requestUserAttention(.informationalRequest)
        guard canNotify else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.userInfo = ["session": id]
        content.sound = .default   // 「あなたの番」は気づいてほしいので鳴らす（ブラウザ版は無音だった）
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { error in
            if let error { NSLog("ccdeck: 通知を出せませんでした: %@", error.localizedDescription) }
        }
    }

    // ccdeck が手前にあっても出す。既定のままだと、手前で別の枠を見ている間の「要対応」が届かない
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .list, .sound])
    }

    // 通知を押したら、そのセッションを開く
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        let id = response.notification.request.content.userInfo["session"] as? String
        DispatchQueue.main.async {
            NSApp.activate(ignoringOtherApps: true)
            self.window.makeKeyAndOrderFront(nil)
            if let id, self.sessions.contains(where: { $0.id == id }) {
                if self.panes.contains(id) { self.setActive(id) } else { self.selectSession(id) }
            }
            done()
        }
    }

    // 要対応の件数は Dock のバッジに出す（ブラウザ版ではタブのタイトルに出していたもの）
    private func updateBadge() {
        let waiting = sessions.filter { $0.status == "attention" }.count + external.filter { $0.status == "attention" }.count
        let unread = sessions.contains { $0.unread == true }
        NSApp.dockTile.badgeLabel = waiting > 0 ? String(waiting) : unread ? "•" : nil
        window.title = waiting > 0 ? "(\(waiting)) ccdeck" : "ccdeck"
    }

    func toast(_ text: String, seconds: Double = 3.2) { root.toast.show(text, seconds: seconds) }

    // ---------- 枠 ----------

    private func pane(for id: String) -> PaneView {
        if let pane = paneViews[id] { return pane }
        let pane = PaneView(id: id)
        pane.onInput = { [weak self] id, data in self?.deck.send(["type": "input", "id": id, "data": data]) }
        pane.onResize = { [weak self] id, cols, rows in
            self?.deck.send(["type": "resize", "id": id, "cols": cols, "rows": rows])
        }
        pane.onClose = { [weak self] id in self?.removePane(id) }
        paneViews[id] = pane
        return pane
    }

    /// 表示枠を実際の画面と購読に反映する。
    /// サイズを確定させてから attach しないと、replay が古い桁数で流れて TUI が崩れる。
    /// だから show（実寸が決まり resize が飛ぶ）→ attach（replay を受ける）の順を守る。
    private func syncPanes() {
        let live = Set(sessions.map(\.id))
        panes = Array(panes.filter { live.contains($0) }.prefix(12))
        // 消えたセッションの枠は捨てる
        for id in Array(paneViews.keys) where !live.contains(id) {
            paneViews[id] = nil
            attached.remove(id)
        }

        root.grid.show(panes.map { pane(for: $0) })

        for id in attached where !panes.contains(id) {
            deck.send(["type": "detach", "id": id])
            attached.remove(id)
        }
        for id in panes where !attached.contains(id) {
            paneViews[id]?.reportSize(force: true)
            deck.send(["type": "attach", "id": id])
            attached.insert(id)
        }

        if activeId == nil || !panes.contains(activeId!) { activeId = panes.first }
        for id in panes {
            let s = sessions.first { $0.id == id }
            paneViews[id]?.update(title: s?.name, status: s?.status)
            paneViews[id]?.isActive = id == activeId
        }
        UserDefaults.standard.set(["panes": panes, "active": activeId ?? ""], forKey: paneStore)
    }

    private func restorePanes() {
        let saved = UserDefaults.standard.dictionary(forKey: paneStore)
        let live = Set(sessions.map(\.id))
        panes = (saved?["panes"] as? [String] ?? []).filter { live.contains($0) }
        let active = saved?["active"] as? String
        activeId = panes.contains(active ?? "") ? active : panes.first
        if let activeId { DispatchQueue.main.async { self.setActive(activeId) } }
    }

    func setActive(_ id: String) {
        if killArmed != id { killArmed = nil }
        activeId = id
        for (key, pane) in paneViews { pane.isActive = key == id }
        focusActive()
        if let session = sessions.first(where: { $0.id == id }) {
            deck.send(["type": "read", "id": id])
            root.drawer.load(session.cwd)
        }
        root.rail.renderSessions()
        renderStage()
        updateBadge()
    }

    func focusActive() {
        if let id = activeId, let pane = paneViews[id], pane.superview != nil { window.makeFirstResponder(pane.term) }
    }

    private func activatePane(at event: NSEvent) {
        guard event.window === window else { return }
        for pane in root.grid.panes {
            let point = pane.convert(event.locationInWindow, from: nil)
            if pane.bounds.contains(point) {
                if pane.id != activeId { setActive(pane.id) }
                return
            }
        }
    }

    // 通常クリック：その1本だけを大きく出す
    func selectSession(_ id: String) {
        panes = [id]
        syncPanes()
        setActive(id)
    }

    // ⌘クリック：並べている枠に足す・外す
    func togglePane(_ id: String) {
        if panes.contains(id) {
            if panes.count == 1 { return }
            removePane(id)
            return
        }
        if panes.count >= 12 { return }
        panes.append(id)
        syncPanes()
        setActive(id)
    }

    func removePane(_ id: String) {
        panes.removeAll { $0 == id }
        syncPanes()
        if let activeId { setActive(activeId) } else { root.rail.renderSessions(); renderStage() }
    }

    func insertPane(_ id: String, at index: Int) {
        guard sessions.contains(where: { $0.id == id }) else { return }
        if panes.contains(id) { return movePane(id, to: index) }
        if panes.count >= 12 { toast("並べられるのは12枠までです"); return }
        panes.insert(id, at: min(index, panes.count))
        syncPanes()
        setActive(id)
    }

    func movePane(_ id: String, to index: Int) {
        guard let from = panes.firstIndex(of: id), from != index else { return }
        panes.remove(at: from)
        panes.insert(id, at: min(from < index ? index - 1 : index, panes.count))
        syncPanes()
        root.rail.renderSessions()
    }

    // 走っているものを全部並べる／1本に戻す
    @objc func tileAll() {
        let all = Array(sessions.map(\.id).prefix(12))
        if panes.count > 1 {
            panes = activeId.map { [$0] } ?? Array(all.prefix(1))
        } else {
            panes = all
        }
        syncPanes()
        if let activeId { setActive(activeId) }
    }

    // 「次に自分の手を必要としているセッション」へ飛ぶ。複数並行の要はこれ。
    @objc func jumpToNext() {
        func weight(_ s: Session) -> Int { s.status == "attention" ? 0 : s.unread == true ? 1 : 2 }
        let order = sessions.sorted { weight($0) < weight($1) }
        guard let target = order.first(where: { $0.id != activeId && ($0.status == "attention" || $0.unread == true) }) else { return }
        // 並べているときは枠はそのままに、入力先だけ移す
        if panes.contains(target.id) { setActive(target.id) } else { selectSession(target.id) }
    }

    @objc func jumpToIndex(_ item: NSMenuItem) {
        guard sessions.indices.contains(item.tag) else { return }
        let target = sessions[item.tag]
        if panes.contains(target.id) { setActive(target.id) } else { selectSession(target.id) }
    }

    // ---------- セッション ----------

    func openSession(cwd: String, title: String?, agent: String = "claude", resumeId: String? = nil) {
        let size = activeId.flatMap { paneViews[$0]?.size }
        Task { @MainActor in
            do {
                let session = try await deck.createSession(cwd: cwd, title: title, agent: agent,
                                                           cols: size?.cols, rows: size?.rows, resumeId: resumeId)
                markRecent(cwd)
                if !sessions.contains(where: { $0.id == session.id }) { sessions.append(session) }
                // 並べている最中なら、そこに足す方が自然
                if panes.count > 1 && panes.count < 12 {
                    panes.append(session.id)
                    syncPanes()
                    setActive(session.id)
                } else {
                    selectSession(session.id)
                }
            } catch { toast(error.localizedDescription) }
        }
    }

    func openProject(_ p: Project, newOne: Bool) {
        if let existing = sessions.first(where: { $0.cwd == p.path }), !newOne { selectSession(existing.id) }
        else { openSession(cwd: p.path, title: p.name) }
    }

    func switchAgent(_ agent: String) {
        guard let source = sessions.first(where: { $0.id == activeId }), source.agentKey != agent, !handoffBusy else { return }
        handoffBusy = true
        renderStage()
        Task { @MainActor in
            defer { handoffBusy = false; renderStage() }
            do {
                let target = try await deck.handoff(source.id, agent: agent)
                if !sessions.contains(where: { $0.id == target.id }) { sessions.append(target) }
                selectSession(target.id)
                toast("\(AGENT_LABEL[agent] ?? agent) に引き継ぎました")
            } catch { toast(error.localizedDescription) }
        }
    }

    func killSession(_ s: Session) {
        confirmKill = nil
        Task { @MainActor in
            do {
                try await deck.killSession(s.id)
                toast("\(s.name) を終了しました")
            } catch { toast(error.localizedDescription) }
            root.rail.renderSessions()
        }
    }

    private func killMany(_ list: [Session]) {
        Task { @MainActor in
            for s in list { try? await deck.killSession(s.id) }
            toast("\(list.count) 本を終了しました")
        }
    }

    func focusExternal(_ s: External) {
        Task { @MainActor in
            do {
                let app = try await deck.focusExternal(tty: s.tty)
                toast("\(s.title) を \(app) で開きました")
            } catch { toast("\(s.title): \(error.localizedDescription)") }
        }
    }

    /* スラッシュコマンドの送り方。先頭の / を打鍵として送り、残りを貼り付けてから Enter。
       まとめて貼るとコマンドとして扱われないことがある。スマホ側（deck.ts の sendText）・
       web/main.js の sendCommand と同じ順序・同じ間隔にしてある。 */
    private func sendCommand(_ id: String, _ text: String) {
        let gap = 0.06
        let esc = "\u{1b}"
        deck.send(["type": "input", "id": id, "data": String(text.prefix(1))])
        DispatchQueue.main.asyncAfter(deadline: .now() + gap) {
            self.deck.send(["type": "input", "id": id, "data": "\(esc)[200~\(text.dropFirst())\(esc)[201~"])
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + gap * 2) {
            self.deck.send(["type": "input", "id": id, "data": "\r"])
        }
    }

    // ---------- 右クリックの操作盤 ----------

    func contextMenu(for s: Session) -> NSMenu {
        let menu = NSMenu()
        let head = NSMenuItem(title: s.name, action: nil, keyEquivalent: "")
        head.isEnabled = false
        menu.addItem(head)
        menu.addItem(.separator())
        let add = { (title: String, run: @escaping () -> Void) -> NSMenuItem in
            let item = NSMenuItem(title: title, action: #selector(ActionTarget.fire), keyEquivalent: "")
            let target = ActionTarget(run)
            item.target = target
            item.representedObject = target   // 弱参照の target を生かしておく
            menu.addItem(item)
            return item
        }
        if panes.contains(s.id) {
            if panes.count > 1 { _ = add("この枠を外す") { [weak self] in self?.removePane(s.id) } }
            if activeId != s.id { _ = add("入力先にする") { [weak self] in self?.setActive(s.id) } }
        } else {
            _ = add("大きく開く") { [weak self] in self?.selectSession(s.id) }
            _ = add("並べて表示に足す") { [weak self] in self?.togglePane(s.id) }
        }
        _ = add("このセッションを終了") { [weak self] in
            self?.confirmKill = s.id
            self?.root.rail.renderSessions()
        }
        // 同じプロジェクトで何本も開いてしまったときの片付け口。戻せないので、もう一段だけ聞く
        let siblings = sessions.filter { $0.cwd == s.cwd && $0.id != s.id }
        if !siblings.isEmpty {
            let item = NSMenuItem(title: "同じ場所の他 \(siblings.count) 本を終了", action: nil, keyEquivalent: "")
            let sub = NSMenu()
            let really = NSMenuItem(title: "本当に \(siblings.count) 本を終了する", action: #selector(ActionTarget.fire), keyEquivalent: "")
            let target = ActionTarget { [weak self] in self?.killMany(siblings) }
            really.target = target
            really.representedObject = target
            sub.addItem(really)
            item.submenu = sub
            menu.addItem(item)
        }
        return menu
    }

    // ---------- プロジェクト ----------

    // 並びはサーバー（server/projects.js の compareProjects）と同じ決めごと：
    // ピン → 最近使った順 → 名前。片方だけ直すと画面と再スキャンで順が食い違う。
    private func sortProjects(_ list: [Project]) -> [Project] {
        list.sorted { a, b in
            if (a.pinned ?? false) != (b.pinned ?? false) { return a.pinned ?? false }
            let (ua, ub) = (a.lastUsed ?? 0, b.lastUsed ?? 0)
            if ua != ub { return ua > ub }
            return a.name.localizedCompare(b.name) == .orderedAscending
        }
    }

    // セッションを立てた場所は、再スキャンを待たずにその場で上へ来てほしい
    private func markRecent(_ cwd: String) {
        guard let i = projects.firstIndex(where: { $0.path == cwd }) else { return }
        projects[i].lastUsed = Date().timeIntervalSince1970 * 1000
        projects = sortProjects(projects)
        root.rail.renderProjects()
    }

    @MainActor private func loadProjects() async {
        do { projects = sortProjects(try await deck.projects()) } catch { toast(error.localizedDescription) }
        root.rail.renderProjects()
    }

    func rescan() { Task { @MainActor in await loadProjects() } }

    // ---------- ＋ ----------

    @objc func togglePicker() {
        if picker.isOpen { picker.close(); return }
        let anchor: NSView = root.railShown ? root.rail.newButton : root.head.rail
        picker.open(from: anchor)
    }

    // ---------- スマホ ----------

    @MainActor private func loadMobile() async {
        health = try? await deck.health()
        if health?.lan == true {
            let code = try? await deck.pairCode()
            pairCode = code?.code == nil ? nil : code
            devices = (try? await deck.devices()) ?? []
        }
        renderMobile()
    }

    private func renderMobile() {
        root.rail.renderMobile()
        let live = (pairCode?.expiresAt ?? 0) > Date().timeIntervalSince1970 * 1000
        if live && pairTimer == nil {
            pairTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.renderMobile() }
        } else if !live {
            pairCode = nil
            pairTimer?.invalidate()
            pairTimer = nil
        }
    }

    func togglePairCode() {
        Task { @MainActor in
            do {
                if pairCode != nil {
                    try await deck.cancelPairCode()
                    pairCode = nil
                } else {
                    pairCode = try await deck.makePairCode()
                }
                renderMobile()
            } catch { toast(error.localizedDescription) }
        }
    }

    func revokeDevice(_ device: Device) {
        confirmRevoke = nil
        Task { @MainActor in
            do {
                try await deck.revokeDevice(device.id)
                devices = try await deck.devices()
                toast("\(device.name) を失効させました")
            } catch { toast(error.localizedDescription) }
            renderMobile()
        }
    }

    // ---------- 執事 ----------

    // 見立てに出す既定の候補：いま開いているプロジェクト。無ければ最近使った上位。
    func butlerCandidates() -> ([Project], Set<String>) {
        let live = Set(sessions.filter { $0.status != "exited" }.map(\.cwd))
        var list = projects.filter { live.contains($0.path) }
        for p in projects where list.count < 8 && !list.contains(where: { $0.path == p.path }) { list.append(p) }
        return (list, live)
    }

    func stepState(_ key: String, server: String) -> String {
        if let skip = butlerSkip[key] { return skip ? "skipped" : (server == "skipped" ? "pending" : server) }
        return server
    }

    func butlerPicks(_ plan: JSON) -> [String: [Int]] {
        var picks: [String: [Int]] = [:]
        for item in plan["items"] as? [JSON] ?? [] {
            let cwd = item["cwd"] as? String ?? ""
            let steps = item["steps"] as? [JSON] ?? []
            picks[cwd] = steps.enumerated().compactMap { k, step in
                let state = stepState("\(cwd)#\(k)", server: step["state"] as? String ?? "pending")
                return state == "skipped" || state == "done" ? nil : k
            }
        }
        return picks
    }

    private func butlerRun(_ work: @escaping () async throws -> Void) {
        Task { @MainActor in
            do { try await work() } catch { toast(error.localizedDescription) }
        }
    }

    func butlerAssess(cwds: [String]? = nil) {
        let agent = butler?["agent"] as? String ?? "claude"
        let list = cwds ?? Array(butlerPick ?? [])
        butlerRun { try await self.deck.butlerAssess(cwds: list, agent: agent) }
    }
    func butlerApprove(planId: Any, picks: [String: [Int]]) { butlerRun { try await self.deck.butlerApprove(planId: planId, picks: picks) } }
    func butlerCancel() { butlerRun { try await self.deck.butlerCancel() } }
    func butlerDismiss() { butlerRun { try await self.deck.butlerDismiss() } }
    func butlerEditStep(planId: Any, cwd: String, index: Int, instruction: String) {
        butlerRun { try await self.deck.butlerStep(planId: planId, cwd: cwd, index: index, instruction: instruction) }
    }
    func toggleButlerAgent() {
        let next = butler?["agent"] as? String == "codex" ? "claude" : "codex"
        butlerRun { try await self.deck.butlerConfig(agent: next) }
    }
    func openButlerItem(sessionId: String?, cwd: String) {
        if let s = sessions.first(where: { $0.id == sessionId }) ?? sessions.first(where: { $0.cwd == cwd }) { selectSession(s.id) }
        else { toast("まだセッションはありません") }
    }

    // ---------- 上の帯 ----------

    private func wireStageHead() {
        let head = root.head
        head.rail.onPress = { [weak self] in self?.toggleRail() }
        head.claude.onPress = { [weak self] in self?.switchAgent("claude") }
        head.codex.onPress = { [weak self] in self?.switchAgent("codex") }
        // モデルの切り替えは CLI に任せる。/model を開けば、その場の正しい一覧が出る
        head.model.onPress = { [weak self] in
            guard let self, let id = self.activeId else { return }
            self.sendCommand(id, "/model")
        }
        head.tile.onPress = { [weak self] in self?.tileAll() }
        head.git.onPress = { [weak self] in self?.toggleDrawer() }
        // 終了は二段階。一度目で「本当に終了」に変わり、4 秒で戻る
        head.kill.onPress = { [weak self] in
            guard let self, let id = self.activeId, let s = self.sessions.first(where: { $0.id == id }) else { return }
            if self.killArmed == id {
                self.killArmed = nil
                self.killSession(s)
            } else {
                self.killArmed = id
                self.renderStage()
                // 古い押下のタイマーで、押し直した方まで解かない
                DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
                    guard let self, self.killArmed == id else { return }
                    self.killArmed = nil
                    self.renderStage()
                }
            }
        }
    }

    func renderStage() {
        let head = root.head
        let session = sessions.first { $0.id == activeId }
        let tiled = panes.count > 1
        head.setIdentityHidden(panes.isEmpty)
        head.tile.title = tiled ? "1つに戻す" : "並べる"
        head.git.title = "変更 \(root.drawer.changeCount)"
        head.kill.title = killArmed != nil && killArmed == activeId ? "本当に終了" : "終了"
        for (button, agent) in [(head.claude, "claude"), (head.codex, "codex")] {
            let selected = (session?.agentKey ?? "claude") == agent
            button.on = selected
            button.isEnabled = !handoffBusy && !selected
            button.alphaValue = 1
            button.toolTip = selected ? "\(AGENT_LABEL[agent] ?? agent) で実行中" : "\(AGENT_LABEL[agent] ?? agent) にコンテキストを引き継ぐ"
        }
        head.model.isHidden = tiled || session == nil
        if let session, !tiled { head.model.title = session.model ?? "モデル" }
        guard let session else { return }
        head.dot.layer?.backgroundColor = Palette.status(session.status).cgColor
        head.name.stringValue = tiled ? "\(panes.count) 枠を表示中" : session.name
        head.path.stringValue = tiled ? "入力先: \(session.name)" : homeTilde(session.cwd)
    }

    @objc func toggleRail() {
        root.railShown.toggle()
        UserDefaults.standard.set(root.railShown ? "0" : "1", forKey: railStore)
    }

    @objc func toggleDrawer(_ open: Any? = nil) {
        root.drawerShown = (open as? Bool) ?? !root.drawerShown
        if root.drawerShown, let session = sessions.first(where: { $0.id == activeId }) { root.drawer.load(session.cwd) }
        if !root.drawerShown { focusActive() }
    }

    @objc func saveFile() { root.drawer.saveFile() }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(saveFile) { return root.drawer.canSave }
        return true
    }

    // ---------- メニュー（ショートカットの持ち主） ----------

    private func buildMenu() {
        let main = NSMenu()
        func menu(_ title: String, _ items: [NSMenuItem]) {
            let holder = NSMenuItem()
            let sub = NSMenu(title: title)
            items.forEach { sub.addItem($0) }
            holder.submenu = sub
            main.addItem(holder)
        }
        func item(_ title: String, _ action: Selector, _ key: String, target: AnyObject? = nil,
                  mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let it = NSMenuItem(title: title, action: action, keyEquivalent: key)
            it.keyEquivalentModifierMask = mods
            it.target = target
            return it
        }

        menu("ccdeck", [
            item("ccdeck を隠す", #selector(NSApplication.hide(_:)), "h"),
            .separator(),
            item("ccdeck を終了", #selector(NSApplication.terminate(_:)), "q"),
        ])
        menu("ファイル", [
            item("新しいセッション", #selector(togglePicker), "n", target: self),
            item("保存", #selector(saveFile), "s", target: self),
        ])
        // ⌘C / ⌘V / ⌘A を TerminalView や入力欄に届けるには Edit メニューが要る
        menu("編集", [
            item("取り消す", Selector(("undo:")), "z"),
            item("やり直す", Selector(("redo:")), "z", mods: [.command, .shift]),
            .separator(),
            item("カット", #selector(NSText.cut(_:)), "x"),
            item("コピー", #selector(NSText.copy(_:)), "c"),
            item("ペースト", #selector(NSText.paste(_:)), "v"),
            item("すべてを選択", #selector(NSText.selectAll(_:)), "a"),
        ])
        var jumps: [NSMenuItem] = []
        for n in 1...9 {
            let it = item("セッション \(n)", #selector(jumpToIndex(_:)), "\(n)", target: self)
            it.tag = n - 1
            jumps.append(it)
        }
        menu("表示", [
            item("サイドバーの開閉", #selector(toggleRail), "b", target: self),
            item("変更（git）", #selector(toggleDrawer(_:)), "g", target: self),
            item("並べる / 1つに戻す", #selector(tileAll), "e", target: self),
            item("次の要対応へ", #selector(jumpToNext), "j", target: self),
            .separator(),
        ] + jumps)
        menu("ウインドウ", [
            item("しまう", #selector(NSWindow.miniaturize(_:)), "m"),
            item("閉じる", #selector(NSWindow.performClose(_:)), "w"),
        ])
        NSApp.mainMenu = main
    }
}
