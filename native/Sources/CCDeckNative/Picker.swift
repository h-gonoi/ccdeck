import AppKit

/// ＋ から出すプロジェクト選び。モーダルではなく、外を押せば消える板（NSPopover）。
///   新規 … プロジェクトを選んで新しく立てる（既定）
///   過去セッション … CLI が残した会話を選んで続きから開く
final class Picker: NSViewController, NSTextFieldDelegate, NSPopoverDelegate {
    weak var c: Controller!
    let popover = NSPopover()

    private var mode = "new"
    private var agent = "claude"
    private var query = ""
    private var index = 0
    private var past: [PastRow] = []
    private var loading = false
    private var pastError = ""
    private var rows: [RowView] = []

    private let modeNew = Button("新規", style: .plain, size: 11)
    private let modePast = Button("過去セッション", style: .plain, size: 11)
    private let agentClaude = Button("Claude Code", style: .plain, size: 11)
    private let agentCodex = Button("Codex", style: .plain, size: 11)
    private let input = NSTextField()
    private let list = vstack([], spacing: 0)
    private var scroll: NSScrollView!
    private let empty = paragraph("", color: Palette.faint)

    override func loadView() {
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 420, height: 440))
        root.wantsLayer = true
        root.layer?.backgroundColor = Palette.panel.cgColor

        modeNew.onPress = { [weak self] in self?.setMode("new") }
        modePast.onPress = { [weak self] in self?.setMode("past") }
        agentClaude.onPress = { [weak self] in self?.setAgent("claude") }
        agentCodex.onPress = { [weak self] in self?.setAgent("codex") }

        input.placeholderString = "プロジェクトを選ぶ"
        input.font = Fonts.ui(13)
        input.textColor = Palette.text
        input.backgroundColor = Palette.bg
        input.drawsBackground = true
        input.isBordered = false
        input.focusRingType = .none
        input.delegate = self
        let inputBox = NSView()
        inputBox.wantsLayer = true
        inputBox.layer?.backgroundColor = Palette.bg.cgColor
        inputBox.layer?.borderWidth = 1
        inputBox.layer?.borderColor = Palette.line.cgColor
        inputBox.layer?.cornerRadius = 3
        input.translatesAutoresizingMaskIntoConstraints = false
        inputBox.addSubview(input)
        NSLayoutConstraint.activate([
            input.leadingAnchor.constraint(equalTo: inputBox.leadingAnchor, constant: 8),
            input.trailingAnchor.constraint(equalTo: inputBox.trailingAnchor, constant: -8),
            input.centerYAnchor.constraint(equalTo: inputBox.centerYAnchor),
            inputBox.heightAnchor.constraint(equalToConstant: 30),
        ])

        scroll = scrollingStack(list)
        let body = vstack([], spacing: 8)
        body.edgeInsets = NSEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
        body.fill(hstack([label("起動", size: 10.5, color: Palette.faint), modeNew, modePast, NSView()], spacing: 4), inset: 12)
        body.fill(hstack([label("Agent", size: 10.5, color: Palette.faint), agentClaude, agentCodex, NSView()], spacing: 4), inset: 12)
        body.fill(inputBox, inset: 12)
        body.fill(empty, inset: 14)
        body.fill(scroll, inset: 6)
        body.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(body)
        NSLayoutConstraint.activate([
            body.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            body.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            body.topAnchor.constraint(equalTo: root.topAnchor),
            body.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 200),
        ])
        view = root

        popover.contentViewController = self
        popover.behavior = .transient
        popover.appearance = NSAppearance(named: .darkAqua)
        popover.delegate = self
    }

    var isOpen: Bool { popover.isShown }

    func open(from anchor: NSView) {
        _ = view
        if c.projects.isEmpty {
            c.toast("プロジェクトが見つかりません。左の「更新」で探し直せます")
            return
        }
        mode = "new"
        agent = "claude"
        query = ""
        input.stringValue = ""
        past = []
        pastError = ""
        // いま打っているセッションの場所を最初に当てておく（⌘N → Enter で「もう1本」）
        let active = c.sessions.first { $0.id == c.activeId }
        index = max(0, c.projects.firstIndex { $0.path == active?.cwd } ?? 0)
        renderToggles()
        render()
        popover.show(relativeTo: anchor.bounds, of: anchor, preferredEdge: .maxY)
        view.window?.makeFirstResponder(input)
    }

    func close() { popover.performClose(nil) }

    func popoverDidClose(_ notification: Notification) { c.focusActive() }

    private func renderToggles() {
        modeNew.on = mode == "new"
        modePast.on = mode == "past"
        agentClaude.on = agent == "claude"
        agentCodex.on = agent == "codex"
        input.placeholderString = mode == "past" ? "会話を探す" : "プロジェクトを選ぶ"
    }

    private func setMode(_ next: String) {
        guard mode != next else { return }
        mode = next
        index = 0
        renderToggles()
        render()
        if mode == "past" { loadPast() }
        view.window?.makeFirstResponder(input)
    }

    private func setAgent(_ next: String) {
        agent = next
        renderToggles()
        render()
        if mode == "past" { loadPast() }
        view.window?.makeFirstResponder(input)
    }

    // 続きから開ける会話を取りに行く。走っている会話は外す
    // （同じ会話に CLI を二重にぶら下げると、どちらの書き込みも壊れる）。
    private func loadPast() {
        let want = agent
        loading = true
        past = []
        pastError = ""
        render()
        Task { @MainActor in
            var rows: [PastRow] = []
            do { rows = try await c.deck.past(agent: want) }
            catch {
                // この口を知らないサーバー（入れ替え前）だと 404 が返る
                pastError = error.localizedDescription.contains("404")
                    ? "このサーバーはまだ対応していません（stop → start で入れ替えてください）。"
                    : "過去の会話を読めませんでした。"
            }
            guard isOpen, agent == want, mode == "past" else { return }
            let live = Set(c.sessions.compactMap(\.vendorId))
            past = rows.filter { !live.contains($0.id) }
            loading = false
            index = 0
            render()
        }
    }

    private enum Item { case project(Project), past(PastRow) }

    private var items: [Item] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        if mode == "past" {
            return past.filter { q.isEmpty || "\($0.name) \($0.cwd) \($0.preview ?? "")".lowercased().contains(q) }.map { .past($0) }
        }
        return c.projects.filter { q.isEmpty || $0.name.lowercased().contains(q) || $0.path.lowercased().contains(q) }.map { .project($0) }
    }

    private func render() {
        let items = self.items
        index = min(max(index, 0), max(items.count - 1, 0))
        empty.isHidden = !items.isEmpty
        empty.stringValue = mode == "past"
            ? (loading ? "探しています…" : pastError.isEmpty ? "続きから開ける会話がありません。" : pastError)
            : "合うプロジェクトがありません。"

        list.setViews([])
        rows = []
        let cut = mode == "new" ? recentCount(items.compactMap { if case .project(let p) = $0 { return p } else { return nil } }) : 0
        for (i, item) in items.enumerated() {
            if cut > 0 && i == cut {
                let line = NSView()
                line.wantsLayer = true
                line.layer?.backgroundColor = Palette.lineSoft.cgColor
                line.heightAnchor.constraint(equalToConstant: 1).isActive = true
                list.fill(line, inset: 8)
            }
            let row = RowView()
            row.background = i == index ? Palette.raised : nil
            row.onClick = { [weak self] _ in self?.choose(i) }
            var lines: [NSView]
            switch item {
            case .project(let p):
                row.toolTip = p.path
                var top: [NSView] = [label(p.name, size: 12.5, color: Palette.text), NSView()]
                let live = c.sessions.filter { $0.cwd == p.path && $0.agentKey == agent }.count
                if live > 0 { top.append(label("\(live)本", size: 10.5, color: Palette.run)) }
                top.append(label(relTime(p.lastUsed), size: 10.5, color: Palette.faint))
                lines = [hstack(top)]
            case .past(let r):
                row.toolTip = r.cwd
                lines = [hstack([label(r.name, size: 12.5, color: Palette.text), NSView(),
                                 label(relTime(r.at), size: 10.5, color: Palette.faint)])]
                if let preview = r.preview, !preview.isEmpty { lines.append(label(preview, size: 11, color: Palette.dim)) }
            }
            let body = vstack(lines, spacing: 2)
            body.translatesAutoresizingMaskIntoConstraints = false
            row.addSubview(body)
            NSLayoutConstraint.activate([
                body.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 10),
                body.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -10),
                body.topAnchor.constraint(equalTo: row.topAnchor, constant: 6),
                body.bottomAnchor.constraint(equalTo: row.bottomAnchor, constant: -6),
            ])
            for line in lines {
                line.translatesAutoresizingMaskIntoConstraints = false
                line.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
            }
            list.fill(row)
            rows.append(row)
        }
        scrollToCurrent()
    }

    private func scrollToCurrent() {
        guard rows.indices.contains(index) else { return }
        let row = rows[index]
        DispatchQueue.main.async { row.scrollToVisible(row.bounds) }
    }

    private func move(_ step: Int) {
        let count = rows.count
        guard count > 0 else { return }
        let old = index
        index = min(max(index + step, 0), count - 1)
        if rows.indices.contains(old) { rows[old].background = nil }
        rows[index].background = Palette.raised
        scrollToCurrent()
    }

    private func choose(_ i: Int) {
        let items = self.items
        guard items.indices.contains(i) else { return }
        let picked = agent
        close()
        switch items[i] {
        case .project(let p): c.openSession(cwd: p.path, title: p.name, agent: picked)
        case .past(let r): c.openSession(cwd: r.cwd, title: r.name, agent: picked, resumeId: r.id)
        }
    }

    // ---------- 入力欄 ----------

    func controlTextDidChange(_ obj: Notification) {
        query = input.stringValue
        index = 0
        render()
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        switch selector {
        case #selector(NSResponder.moveDown(_:)): move(1); return true
        case #selector(NSResponder.moveUp(_:)): move(-1); return true
        case #selector(NSResponder.insertNewline(_:)): choose(index); return true
        case #selector(NSResponder.cancelOperation(_:)): close(); return true
        default: return false
        }
    }
}
