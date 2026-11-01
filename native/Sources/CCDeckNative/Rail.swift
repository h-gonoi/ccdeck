import AppKit

/// 左の帯。セッション・他で動いているもの・執事・プロジェクト・スマホ。
/// 節ごとに作り直す（行の数は多くても数十なので、差分を取るより作り直す方が素直）。
final class Rail: NSView {
    weak var c: Controller!

    let newButton = Button("＋", style: .icon, size: 16)
    private let stack = NSStackView()
    private var scroll: NSScrollView!

    private let upgradeBody = vstack([], spacing: 6)
    private let sessionTitle = NSStackView()
    private let sessionList = vstack([], spacing: 1)
    private let sessionEmpty = paragraph("走っているセッションはありません。\n下のプロジェクトを選ぶと始まります。")
    private let externalTitle = NSStackView()
    private let externalList = vstack([], spacing: 1)
    private let butlerTitle = NSStackView()
    private let butlerBody = vstack([], spacing: 6)
    private let projectTitle = NSStackView()
    private let projectList = vstack([], spacing: 0)
    private let mobileTitle = NSStackView()
    private let mobileBody = vstack([], spacing: 6)

    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = Palette.panel.cgColor

        let brand = label("ccdeck", size: 13, color: Palette.text, weight: .semibold)
        newButton.toolTip = "新しいセッション (⌘N)"
        let head = hstack([brand, NSView(), newButton])
        head.translatesAutoresizingMaskIntoConstraints = false
        addSubview(head)

        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 4
        stack.edgeInsets = NSEdgeInsets(top: 4, left: 0, bottom: 24, right: 0)
        scroll = scrollingStack(stack)
        scroll.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scroll)

        NSLayoutConstraint.activate([
            // 上は信号機ボタンのぶん空ける
            head.topAnchor.constraint(equalTo: topAnchor, constant: 34),
            head.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            head.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            scroll.topAnchor.constraint(equalTo: head.bottomAnchor, constant: 10),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        for (view, gap) in [(upgradeBody, 0.0), (sessionTitle, 4.0), (sessionList, 0), (sessionEmpty, 0),
                            (externalTitle, 14), (externalList, 0),
                            (butlerTitle, 14), (butlerBody, 0),
                            (projectTitle, 14), (projectList, 0),
                            (mobileTitle, 14), (mobileBody, 0)] as [(NSView, CGFloat)] {
            let isList = view === sessionList || view === externalList || view === projectList
            stack.fill(view, inset: isList ? 6 : 16)
            if gap > 0, let prev = stack.arrangedSubviews.dropLast().last { stack.setCustomSpacing(gap, after: prev) }
        }
        [sessionTitle, externalTitle, butlerTitle, projectTitle, mobileTitle].forEach {
            $0.orientation = .horizontal
            $0.spacing = 6
            $0.alignment = .centerY
        }
    }

    required init?(coder: NSCoder) { fatalError() }

    private func title(_ into: NSStackView, _ text: String, count: String = "", accessory: [NSView] = [],
                       countColor: NSColor = Palette.faint) {
        let name = label(text.uppercased(), size: 10.5, color: Palette.faint, weight: .semibold)
        let n = label(count, size: 10.5, color: countColor)
        into.setViews([name, n, NSView()] + accessory)
    }

    func renderAll() {
        renderUpgrade()
        renderSessions()
        renderExternal()
        renderButler()
        renderProjects()
        renderMobile()
    }

    // ---------- 新しい版 ----------

    private static let waitReason = [
        "starting": "起動中", "running": "作業中", "attention": "承認待ち", "draft": "打ちかけ", "butler": "見立て・手順の途中",
    ]

    // 新しい版があるときだけ出す。琥珀は「あなたの番」専用なので使わない
    func renderUpgrade() {
        let up = c.upgrade
        let stale = up?["stale"] as? Bool ?? false
        let armed = up?["armed"] as? Bool ?? false
        let restarting = up?["restarting"] as? Bool ?? false
        let waiting = up?["waiting"] as? [JSON] ?? []
        upgradeBody.isHidden = !stale && !restarting
        guard !upgradeBody.isHidden else { upgradeBody.setViews([]); return }

        var text = "新しい版があります。"
        if restarting { text = "入れ替えています…" }
        else if armed && !waiting.isEmpty {
            let who = waiting.map { w -> String in
                let name = w["title"] as? String ?? w["id"] as? String ?? "?"
                let reason = w["reason"] as? String ?? ""
                return "\(name)（\(Rail.waitReason[reason] ?? reason)）"
            }
            text = "手が空くのを待っています: " + who.joined(separator: "、")
        } else if armed { text = "全員の手が空いています。まもなく入れ替えます。" }

        var views: [NSView] = [paragraph(text, size: 11.5)]
        if !restarting {
            views.append(armed
                ? Button("やめる", style: .link) { [weak self] in self?.c.cancelUpgrade() }
                : Button("手が空いたら入れ替える", style: .ghost) { [weak self] in self?.c.armUpgrade() })
        }
        upgradeBody.setViews(views)
        stack.setCustomSpacing(14, after: upgradeBody)   // 下のセッション見出しと詰まらないように
    }

    // ---------- セッション ----------

    func renderSessions() {
        let sessions = c.sessions
        title(sessionTitle, "セッション", count: sessions.isEmpty ? "" : "\(sessions.count)")
        sessionEmpty.isHidden = !sessions.isEmpty
        sessionList.setViews([])
        for s in sessions { sessionList.fill(sessionRow(s)) }
    }

    private func sessionRow(_ s: Session) -> NSView {
        let paned = c.panes.contains(s.id)
        let active = s.id == c.activeId
        let row = RowView()
        row.background = paned || active ? Palette.raised : nil
        row.toolTip = paned ? "⌘クリックで枠から外す" : "⌘クリックで並べて表示"
        row.dragPayload = (.ccdeckSession, s.id)
        row.onClick = { [weak self] flags in
            guard let c = self?.c else { return }
            flags.contains(.command) ? c.togglePane(s.id) : c.selectSession(s.id)
        }
        row.menuProvider = { [weak self] in self?.c.contextMenu(for: s) }

        // 左の細い帯で状態を示す（web の ::before）
        let bar = NSView()
        bar.wantsLayer = true
        bar.layer?.backgroundColor = (s.status == "idle" || s.status == "starting" ? NSColor.clear : Palette.status(s.status)).cgColor
        bar.translatesAutoresizingMaskIntoConstraints = false

        let name = label(s.name, size: 12.5, color: active || paned ? Palette.text : Palette.dim, weight: active ? .medium : .regular)
        var top: [NSView] = [name, NSView()]
        if s.unread == true && !active { top.append(dotView(Palette.amber)) }
        let kill = Button("×", style: .icon, size: 12) { [weak self] in
            self?.c.confirmKill = s.id
            self?.renderSessions()
        }
        kill.toolTip = "このセッションを終了する"
        top.append(kill)

        let state = label(STATE_LABEL[s.status] ?? s.status, size: 10.5, color: s.status == "idle" ? Palette.faint : Palette.status(s.status))
        var meta: NSView = hstack([state, label("·", size: 10.5, color: Palette.faint),
                                   label(AGENT_LABEL[s.agentKey] ?? "Claude Code", size: 10.5, color: Palette.faint),
                                   label("·", size: 10.5, color: Palette.faint),
                                   label(relTime(s.lastActivity), size: 10.5, color: Palette.faint)], spacing: 4)
        if c.confirmKill == s.id {
            // 戻せない操作なので、行の中でもう一度だけ聞く
            meta = hstack([label(s.status == "running" ? "作業中です。終了？" : "終了しますか？", size: 11, color: Palette.dead),
                           Button("終了", style: .danger) { [weak self] in self?.c.killSession(s) },
                           Button("やめる", style: .ghost) { [weak self] in
                               self?.c.confirmKill = nil
                               self?.renderSessions()
                           }], spacing: 6)
        }

        let body = vstack([hstack(top, spacing: 4), meta], spacing: 2)
        body.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(bar)
        row.addSubview(body)
        let topRow = body.arrangedSubviews[0]
        topRow.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            bar.leadingAnchor.constraint(equalTo: row.leadingAnchor),
            bar.topAnchor.constraint(equalTo: row.topAnchor, constant: 6),
            bar.bottomAnchor.constraint(equalTo: row.bottomAnchor, constant: -6),
            bar.widthAnchor.constraint(equalToConstant: 2),
            body.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 12),
            body.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -6),
            body.topAnchor.constraint(equalTo: row.topAnchor, constant: 6),
            body.bottomAnchor.constraint(equalTo: row.bottomAnchor, constant: -6),
            topRow.widthAnchor.constraint(equalTo: body.widthAnchor),
        ])
        if active {
            let edge = NSView()
            edge.wantsLayer = true
            edge.layer?.backgroundColor = Palette.amber.cgColor
            edge.translatesAutoresizingMaskIntoConstraints = false
            row.addSubview(edge)
            NSLayoutConstraint.activate([
                edge.trailingAnchor.constraint(equalTo: row.trailingAnchor),
                edge.topAnchor.constraint(equalTo: row.topAnchor),
                edge.bottomAnchor.constraint(equalTo: row.bottomAnchor),
                edge.widthAnchor.constraint(equalToConstant: 1),
            ])
        }
        return row
    }

    // ---------- 他で動いている ----------

    func renderExternal() {
        let list = c.external
        externalTitle.isHidden = list.isEmpty
        externalList.isHidden = list.isEmpty
        title(externalTitle, "他で動いている", count: list.isEmpty ? "" : "\(list.count)")
        externalList.setViews([])
        for s in list {
            let row = RowView()
            row.toolTip = "\(s.cwd ?? "")\n\(s.tty ?? "ターミナル不明")"
            row.onClick = { [weak self] _ in self?.c.focusExternal(s) }
            let state = s.waitingFor == "input needed" ? "要対応" : (STATE_LABEL[s.status] ?? s.status)
            let body = vstack([
                hstack([label(s.title, size: 12.5, color: Palette.dim), NSView(), label("↗", size: 11, color: Palette.faint)]),
                hstack([label(state, size: 10.5, color: s.status == "idle" ? Palette.faint : Palette.status(s.status)),
                        label("·", size: 10.5, color: Palette.faint),
                        label((s.tty ?? "").replacingOccurrences(of: "/dev/", with: "").isEmpty ? "外部" : (s.tty ?? "").replacingOccurrences(of: "/dev/", with: ""),
                              size: 10.5, color: Palette.faint)], spacing: 4),
            ], spacing: 2)
            pin(body, in: row)
            externalList.fill(row)
        }
    }

    private func pin(_ body: NSStackView, in row: NSView, left: CGFloat = 12) {
        body.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(body)
        NSLayoutConstraint.activate([
            body.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: left),
            body.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -8),
            body.topAnchor.constraint(equalTo: row.topAnchor, constant: 6),
            body.bottomAnchor.constraint(equalTo: row.bottomAnchor, constant: -6),
        ])
        for sub in body.arrangedSubviews {
            sub.translatesAutoresizingMaskIntoConstraints = false
            sub.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
        }
    }

    // ---------- プロジェクト ----------

    func renderProjects() {
        title(projectTitle, "プロジェクト", accessory: [Button("更新", style: .link, size: 10.5) { [weak self] in self?.c.rescan() }])
        projectList.setViews([])
        let list = c.projects
        let cut = recentCount(list)
        for (index, p) in list.enumerated() {
            if cut > 0 && index == cut { projectList.fill(separator(), inset: 10) }
            let row = RowView()
            row.toolTip = p.lastUsed.map { "\(p.path)\n最後に開いたのは \(relTime($0))" } ?? p.path
            row.onClick = { [weak self] flags in self?.c.openProject(p, newOne: flags.contains(.command)) }
            var views: [NSView] = [label(p.name, size: 12, color: Palette.dim), NSView()]
            if let n = p.changes, n > 0 { views.append(label("\(n)", size: 10, color: Palette.amber.withAlphaComponent(0.75), mono: true)) }
            let branch = label(p.branch ?? "", size: 10, color: Palette.faint, mono: true)
            branch.lineBreakMode = .byTruncatingHead
            branch.widthAnchor.constraint(lessThanOrEqualToConstant: 110).isActive = true
            views.append(branch)
            let body = vstack([hstack(views, spacing: 6)])
            pin(body, in: row, left: 10)
            projectList.fill(row)
        }
    }

    private func separator() -> NSView {
        let line = NSView()
        line.wantsLayer = true
        line.layer?.backgroundColor = Palette.lineSoft.cgColor
        line.heightAnchor.constraint(equalToConstant: 1).isActive = true
        return line
    }

    // ---------- スマホ ----------
    // LAN に出していないときは、この節ごと出さない。閉じているものを説明しても仕方がない。

    func renderMobile() {
        let lan = c.health?.lan == true
        mobileTitle.isHidden = !lan
        mobileBody.isHidden = !lan
        guard lan, let health = c.health else { return }
        title(mobileTitle, "スマホ")
        var views: [NSView] = [label("\(health.address ?? ""):\(health.port ?? 0)", size: 11, color: Palette.dim, mono: true)]

        let now = Date().timeIntervalSince1970 * 1000
        if let code = c.pairCode, let digits = code.code, let until = code.expiresAt, until > now {
            let left = Int((until - now) / 1000)
            views.append(hstack([label(digits, size: 20, color: Palette.text, weight: .medium, mono: true),
                                 label(String(format: "あと %d:%02d", left / 60, left % 60), size: 11, color: Palette.faint)], spacing: 10))
            views.append(Button("コードを消す", style: .ghost) { [weak self] in self?.c.togglePairCode() })
        } else {
            views.append(Button("コードを出す", style: .ghost) { [weak self] in self?.c.togglePairCode() })
        }

        for device in c.devices {
            var line: [NSView] = [label(device.name, size: 12, color: Palette.dim), NSView(),
                                  label(relTime(device.lastSeen), size: 10.5, color: Palette.faint)]
            if c.confirmRevoke == device.id {
                // 戻せない操作なので、行の中でもう一度だけ聞く（母体の終了確認と同じ作法）
                line += [Button("失効", style: .danger) { [weak self] in self?.c.revokeDevice(device) },
                         Button("やめる", style: .ghost) { [weak self] in
                             self?.c.confirmRevoke = nil
                             self?.renderMobile()
                         }]
            } else {
                let drop = Button("×", style: .icon, size: 12) { [weak self] in
                    self?.c.confirmRevoke = device.id
                    self?.renderMobile()
                }
                drop.toolTip = "この端末を失効させる"
                line.append(drop)
            }
            let row = hstack(line)
            row.toolTip = "\(device.platform ?? "") · 登録 \(relTime(device.createdAt))"
            views.append(row)
        }
        mobileBody.setViews([])
        for view in views {
            if view is NSStackView && view !== views.first { mobileBody.fill(view) } else { mobileBody.addArrangedSubview(view) }
        }
    }

    // ---------- 執事 ----------
    // 見立て（提案）→ 承認 → 実行、を左の帯の中で回す。モーダルは出さない。
    // 琥珀は「承認を待っている」ときだけ。走っている間は控えめに。

    static let planLabel = ["assessing": "見立て中", "proposed": "承認待ち", "running": "進めています", "done": "一巡",
                            "failed": "失敗", "cancelled": "止めた", "paused": "止まっている"]
    static let stepMark = ["pending": "·", "sent": "▶", "done": "✓", "skipped": "–", "failed": "×"]

    func renderButler() {
        guard let b = c.butler else {
            butlerTitle.isHidden = true
            butlerBody.isHidden = true
            return
        }
        // 書き換え中の手順があるときは作り直さない（打ちかけが消える）
        if c.butlerEdit != nil, butlerBody.window?.firstResponder is EditBox { return }
        butlerTitle.isHidden = false
        butlerBody.isHidden = false

        let plan = b["plan"] as? JSON
        let planState = plan?["state"] as? String
        let agent = b["agent"] as? String ?? "claude"
        let brain = Button(agent == "codex" ? "Codex" : "Claude", style: .link, size: 10.5) { [weak self] in self?.c.toggleButlerAgent() }
        brain.toolTip = "執事の頭脳を切り替える"
        brain.isEnabled = !(b["busy"] as? Bool ?? false)
        title(butlerTitle, "執事", count: planState.map { Rail.planLabel[$0] ?? $0 } ?? "",
              accessory: [brain], countColor: planState == "proposed" ? Palette.amber : Palette.faint)

        var views: [NSView] = []
        defer {
            butlerBody.setViews([])
            for view in views { butlerBody.fill(view) }
        }

        guard let plan, let planState else {
            let (list, live) = c.butlerCandidates()
            if c.butlerPick == nil && c.sessionsLoaded { c.butlerPick = Set(list.filter { live.contains($0.path) }.map(\.path)) }
            if list.isEmpty {
                views.append(paragraph("プロジェクトが見つかりません。下の「プロジェクト」に出てから頼めます。"))
                return
            }
            for p in list {
                let box = NSButton(checkboxWithTitle: p.name, target: nil, action: nil)
                box.state = c.butlerPick?.contains(p.path) == true ? .on : .off
                box.attributedTitle = NSAttributedString(string: p.name, attributes: [.foregroundColor: Palette.dim, .font: Fonts.ui(12)])
                let target = ActionTarget { [weak self] in
                    guard let self else { return }
                    if box.state == .on { self.c.butlerPick?.insert(p.path) } else { self.c.butlerPick?.remove(p.path) }
                    self.renderButler()
                }
                box.target = target
                box.action = #selector(ActionTarget.fire)
                objc_setAssociatedObject(box, &ActionTarget.key, target, .OBJC_ASSOCIATION_RETAIN)
                var line: [NSView] = [box, NSView()]
                if live.contains(p.path) { line.append(label("開いている", size: 10, color: Palette.faint)) }
                views.append(hstack(line))
            }
            let count = c.butlerPick?.count ?? 0
            let go = Button("見立てを頼む（\(count)）", style: .ghost) { [weak self] in self?.c.butlerAssess() }
            go.isEnabled = count > 0
            views.append(hstack([go]))
            let models = b["models"] as? JSON
            views.append(paragraph("執事が各プロジェクトを読み取り専用で見て回り、次に渡す手順を提案します。手順が動くのは承認のあとだけです。頭脳は "
                                   + (agent == "codex" ? "Codex" : "Claude（\(models?["claude"] as? String ?? "")）") + "。"))
            return
        }

        // ---- 提案・実行の一覧 ----
        let editable = planState == "proposed" || planState == "paused"
        let items = plan["items"] as? [JSON] ?? []
        for item in items {
            let cwd = item["cwd"] as? String ?? ""
            let itemState = item["state"] as? String ?? ""
            let steps = item["steps"] as? [JSON] ?? []
            let done = steps.filter { $0["state"] as? String == "done" }.count
            let counted = steps.filter { $0["state"] as? String != "skipped" }.count
            let badge = ["assessing": "見立て中…", "proposed": "", "approved": "待機", "running": "\(done)/\(counted)",
                         "done": "済", "failed": "失敗", "skipped": "見送り", "paused": "停止"][itemState] ?? ""

            let name = Button(item["title"] as? String ?? cwd, style: .link, size: 12) { [weak self] in
                self?.c.openButlerItem(sessionId: item["sessionId"] as? String, cwd: cwd)
            }
            name.toolTip = cwd
            var lines: [NSView] = [hstack([name, NSView(), label(badge, size: 10.5, color: Palette.faint)])]
            if let text = item["situation"] as? String, !text.isEmpty { lines.append(paragraph(text, color: Palette.dim)) }
            if let text = item["risk"] as? String, !text.isEmpty { lines.append(paragraph("⚠ \(text)", color: Palette.amber)) }
            if let text = item["error"] as? String, !text.isEmpty { lines.append(paragraph(text, color: Palette.dead)) }
            if itemState == "proposed" && steps.isEmpty { lines.append(paragraph("渡す手順はありません。", color: Palette.faint)) }

            for (k, step) in steps.enumerated() {
                let key = "\(cwd)#\(k)"
                let state = c.stepState(key, server: step["state"] as? String ?? "pending")
                let mark: NSView
                if editable {
                    let check = NSButton(checkboxWithTitle: "", target: nil, action: nil)
                    check.state = state == "skipped" ? .off : .on
                    let target = ActionTarget { [weak self] in
                        self?.c.butlerSkip[key] = check.state == .off
                        self?.renderButler()
                    }
                    check.target = target
                    check.action = #selector(ActionTarget.fire)
                    objc_setAssociatedObject(check, &ActionTarget.key, target, .OBJC_ASSOCIATION_RETAIN)
                    mark = check
                } else {
                    mark = label(Rail.stepMark[state] ?? "·", size: 11, color: state == "failed" ? Palette.dead : state == "done" ? Palette.run : Palette.faint, mono: true)
                }
                let stepTitle = Button(step["title"] as? String ?? "", style: .link, size: 11.5) { [weak self] in
                    guard let self else { return }
                    if self.c.butlerOpen.contains(key) { self.c.butlerOpen.remove(key) } else { self.c.butlerOpen.insert(key) }
                    self.renderButler()
                }
                lines.append(hstack([mark, stepTitle, NSView()], spacing: 4))

                guard c.butlerOpen.contains(key) else { continue }
                let instruction = step["instruction"] as? String ?? ""
                if c.butlerEdit == key {
                    let edit = EditBox.make(text: instruction) { [weak self] value in
                        self?.c.butlerEdit = nil
                        if let value, value.trimmingCharacters(in: .whitespacesAndNewlines) != instruction {
                            self?.c.butlerEditStep(planId: plan["id"] as Any, cwd: cwd, index: k, instruction: value)
                        }
                        DispatchQueue.main.async { self?.renderButler() }
                    }
                    lines.append(edit)
                } else {
                    let text = RowView()
                    let body = paragraph(instruction, size: 11, color: Palette.dim, mono: true)
                    body.isSelectable = false
                    pin(vstack([body]), in: text, left: 8)
                    text.background = Palette.bg
                    if editable {
                        text.toolTip = "押すと書き換えられます"
                        text.onClick = { [weak self] _ in
                            self?.c.butlerEdit = key
                            self?.renderButler()
                        }
                    }
                    lines.append(text)
                }
            }

            let box = vstack(lines, spacing: 4)
            for line in lines {
                line.translatesAutoresizingMaskIntoConstraints = false
                line.widthAnchor.constraint(equalTo: box.widthAnchor).isActive = true
            }
            let wrap = NSView()
            let edge = NSView()
            edge.wantsLayer = true
            edge.layer?.backgroundColor = (itemState == "running" ? Palette.run : itemState == "failed" ? Palette.dead : Palette.line).cgColor
            for v in [edge, box] { v.translatesAutoresizingMaskIntoConstraints = false; wrap.addSubview(v) }
            NSLayoutConstraint.activate([
                edge.leadingAnchor.constraint(equalTo: wrap.leadingAnchor),
                edge.topAnchor.constraint(equalTo: wrap.topAnchor),
                edge.bottomAnchor.constraint(equalTo: wrap.bottomAnchor),
                edge.widthAnchor.constraint(equalToConstant: 2),
                box.leadingAnchor.constraint(equalTo: wrap.leadingAnchor, constant: 8),
                box.trailingAnchor.constraint(equalTo: wrap.trailingAnchor),
                box.topAnchor.constraint(equalTo: wrap.topAnchor),
                box.bottomAnchor.constraint(equalTo: wrap.bottomAnchor),
            ])
            views.append(wrap)
        }

        if let note = plan["note"] as? String, !note.isEmpty { views.append(paragraph(note)) }

        // ---- 動かすボタン ----
        var actions: [NSView] = []
        if planState == "assessing" || planState == "running" {
            actions.append(Button("止める", style: .ghost) { [weak self] in self?.c.butlerCancel() })
        }
        if editable {
            let picks = c.butlerPicks(plan)
            let total = picks.values.reduce(0) { $0 + $1.count }
            let approve = Button(planState == "paused" ? "続ける（\(total)）" : "承認して進める（\(total)）", style: .approve) { [weak self] in
                self?.c.butlerApprove(planId: plan["id"] as Any, picks: picks)
            }
            approve.isEnabled = total > 0
            actions.append(approve)
            actions.append(Button("見送る", style: .ghost) { [weak self] in self?.c.butlerDismiss() })
        }
        if ["done", "failed", "cancelled"].contains(planState) {
            let cwds = items.compactMap { $0["cwd"] as? String }
            actions.append(Button("次の見立てを頼む", style: .ghost) { [weak self] in self?.c.butlerAssess(cwds: cwds) })
            actions.append(Button("閉じる", style: .ghost) { [weak self] in self?.c.butlerDismiss() })
        }
        if !actions.isEmpty { views.append(hstack(actions + [NSView()])) }

        let log = (plan["log"] as? [JSON] ?? []).prefix(4)
        for entry in log {
            views.append(hstack([label(relTime(entry["at"] as? Double), size: 10, color: Palette.faint),
                                 label(entry["text"] as? String ?? "", size: 10.5, color: Palette.dim)], spacing: 8))
        }
    }
}

// 上に寄せた「最近使った」の本数。全部が最近なら区切る意味がないので 0 を返す。
func recentCount(_ list: [Project]) -> Int {
    var n = 0
    while n < list.count && n < 5 && (list[n].lastUsed ?? 0) > 0 { n += 1 }
    return n == list.count ? 0 : n
}

/// NSButton の target は弱参照なので、閉包を持たせる受け皿を本体に結びつけておく。
final class ActionTarget: NSObject {
    static var key = 0
    let run: () -> Void
    init(_ run: @escaping () -> Void) { self.run = run }
    @objc func fire() { run() }
}

/// 執事の手順を書き換える欄。離れたら保存、Esc で取りやめ。
final class EditBox: NSTextView {
    var onDone: ((String?) -> Void)?
    private var finished = false

    static func make(text: String, onDone: @escaping (String?) -> Void) -> NSView {
        let scroll = NSScrollView()
        let box = EditBox()
        box.string = text
        box.onDone = onDone
        box.font = Fonts.mono(11)
        box.textColor = Palette.text
        box.backgroundColor = Palette.bg
        box.insertionPointColor = Palette.amber
        box.isRichText = false
        box.isAutomaticQuoteSubstitutionEnabled = false
        box.isAutomaticDashSubstitutionEnabled = false
        box.isAutomaticTextReplacementEnabled = false
        box.textContainerInset = NSSize(width: 4, height: 4)
        box.isVerticallyResizable = true
        box.autoresizingMask = [.width]
        scroll.documentView = box
        scroll.hasVerticalScroller = true
        scroll.borderType = .noBorder
        scroll.wantsLayer = true
        scroll.layer?.borderWidth = 1
        scroll.layer?.borderColor = Palette.line.cgColor
        scroll.layer?.cornerRadius = 3
        let lines = min(12, text.split(separator: "\n", omittingEmptySubsequences: false).count + 2)
        scroll.heightAnchor.constraint(equalToConstant: CGFloat(lines) * 15 + 10).isActive = true
        DispatchQueue.main.async { box.window?.makeFirstResponder(box) }
        return scroll
    }

    private func finish(_ value: String?) {
        guard !finished else { return }
        finished = true
        onDone?(value)
    }

    override func cancelOperation(_ sender: Any?) { finish(nil) }

    override func resignFirstResponder() -> Bool {
        let ok = super.resignFirstResponder()
        if ok { finish(string) }
        return ok
    }
}
