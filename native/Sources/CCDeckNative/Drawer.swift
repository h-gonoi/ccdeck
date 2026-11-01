import AppKit

/// 右の引き出し。いま打っているセッションの場所の git。差分・編集・コミット・push。
final class Drawer: NSView, NSTextViewDelegate {
    weak var c: Controller!

    private let branch = label("", size: 12, color: Palette.text, weight: .medium, mono: true)
    private let track = label("", size: 11, color: Palette.faint, mono: true)
    private let close = Button("×", style: .icon)
    private let changes = vstack([], spacing: 0)
    private let empty = paragraph("変更はありません。", color: Palette.faint)
    private var changeScroll: NSScrollView!

    private let tabDiff = Button("差分", style: .plain, size: 11)
    private let tabEdit = Button("編集", style: .plain, size: 11)
    private let openFile = label("", size: 11, color: Palette.faint, mono: true)
    private let save = Button("保存 ⌘S", style: .link, size: 11)
    private let viewer = NSTextView()
    private var viewerScroll: NSScrollView!
    private let paneBox = NSView()

    private let message = NSTextView()
    private let stageAll = Button("全部ステージ", style: .ghost)
    private let commit = Button("コミット", style: .primary)
    private let push = Button("push", style: .ghost)
    private let log = paragraph("", color: Palette.faint)

    private(set) var git: GitStatus?
    private(set) var cwd: String?
    private var file: GitFile?
    private var mode = "diff"
    private var editing = false

    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = Palette.panel.cgColor

        close.toolTip = "閉じる"
        close.onPress = { [weak self] in self?.c.toggleDrawer(false) }
        let head = hstack([branch, track, NSView(), close], spacing: 8)

        changeScroll = scrollingStack(changes)
        let changeBox = vstack([], spacing: 0)
        changeBox.fill(changeScroll)
        changeBox.fill(empty, inset: 14)

        tabDiff.onPress = { [weak self] in self?.setMode("diff") }
        tabEdit.onPress = { [weak self] in self?.setMode("edit") }
        save.onPress = { [weak self] in self?.saveFile() }
        openFile.lineBreakMode = .byTruncatingHead
        let tabs = hstack([tabDiff, tabEdit, openFile, NSView(), save], spacing: 4)

        viewer.isRichText = false
        viewer.font = Fonts.mono(11)
        viewer.textColor = Palette.text
        viewer.backgroundColor = Palette.bg
        viewer.insertionPointColor = Palette.amber
        viewer.selectedTextAttributes = [.backgroundColor: Palette.hex(0xe0a145, alpha: 0.2)]
        viewer.isAutomaticQuoteSubstitutionEnabled = false
        viewer.isAutomaticDashSubstitutionEnabled = false
        viewer.isAutomaticTextReplacementEnabled = false
        viewer.isAutomaticSpellingCorrectionEnabled = false
        viewer.isContinuousSpellCheckingEnabled = false
        viewer.textContainerInset = NSSize(width: 6, height: 6)
        viewer.isHorizontallyResizable = true
        viewer.textContainer?.widthTracksTextView = false
        viewer.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        viewer.autoresizingMask = [.width]
        viewerScroll = NSScrollView()
        viewerScroll.documentView = viewer
        viewerScroll.hasVerticalScroller = true
        viewerScroll.hasHorizontalScroller = true
        viewerScroll.autohidesScrollers = true
        viewerScroll.drawsBackground = true
        viewerScroll.backgroundColor = Palette.bg

        message.isRichText = false
        message.font = Fonts.ui(12)
        message.textColor = Palette.text
        message.backgroundColor = Palette.bg
        message.insertionPointColor = Palette.amber
        message.textContainerInset = NSSize(width: 6, height: 6)
        message.delegate = self
        let messageScroll = NSScrollView()
        messageScroll.documentView = message
        message.autoresizingMask = [.width]
        messageScroll.wantsLayer = true
        messageScroll.layer?.borderWidth = 1
        messageScroll.layer?.borderColor = Palette.line.cgColor
        messageScroll.layer?.cornerRadius = 3
        messageScroll.heightAnchor.constraint(equalToConstant: 48).isActive = true

        stageAll.onPress = { [weak self] in self?.stageEverything() }
        commit.onPress = { [weak self] in self?.commitNow() }
        push.onPress = { [weak self] in self?.pushNow() }

        let foot = vstack([], spacing: 8)
        foot.fill(messageScroll)
        foot.fill(hstack([stageAll, commit, push, NSView()]))
        foot.fill(log)
        placeholder()

        let pane = vstack([], spacing: 4)
        pane.fill(tabs, inset: 10)
        pane.fill(viewerScroll)
        for v in [pane] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            paneBox.addSubview(v)
            NSLayoutConstraint.activate([
                v.leadingAnchor.constraint(equalTo: paneBox.leadingAnchor),
                v.trailingAnchor.constraint(equalTo: paneBox.trailingAnchor),
                v.topAnchor.constraint(equalTo: paneBox.topAnchor, constant: 6),
                v.bottomAnchor.constraint(equalTo: paneBox.bottomAnchor),
            ])
        }
        paneBox.isHidden = true

        let rules = (0..<2).map { _ -> NSView in
            let v = NSView()
            v.wantsLayer = true
            v.layer?.backgroundColor = Palette.line.cgColor
            return v
        }
        for v in [head, changeBox, rules[0], paneBox, rules[1], foot] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            addSubview(v)
        }
        NSLayoutConstraint.activate([
            head.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            head.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            head.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            head.heightAnchor.constraint(equalToConstant: 24),

            changeBox.topAnchor.constraint(equalTo: head.bottomAnchor, constant: 10),
            changeBox.leadingAnchor.constraint(equalTo: leadingAnchor),
            changeBox.trailingAnchor.constraint(equalTo: trailingAnchor),
            changeBox.heightAnchor.constraint(equalTo: heightAnchor, multiplier: 0.3),

            rules[0].topAnchor.constraint(equalTo: changeBox.bottomAnchor),
            rules[0].leadingAnchor.constraint(equalTo: leadingAnchor),
            rules[0].trailingAnchor.constraint(equalTo: trailingAnchor),
            rules[0].heightAnchor.constraint(equalToConstant: 1),

            paneBox.topAnchor.constraint(equalTo: rules[0].bottomAnchor),
            paneBox.leadingAnchor.constraint(equalTo: leadingAnchor),
            paneBox.trailingAnchor.constraint(equalTo: trailingAnchor),
            paneBox.bottomAnchor.constraint(equalTo: rules[1].topAnchor),

            rules[1].leadingAnchor.constraint(equalTo: leadingAnchor),
            rules[1].trailingAnchor.constraint(equalTo: trailingAnchor),
            rules[1].heightAnchor.constraint(equalToConstant: 1),
            rules[1].bottomAnchor.constraint(equalTo: foot.topAnchor, constant: -14),

            foot.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            foot.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            foot.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -14),
        ])
        setMode("diff", load: false)
    }

    required init?(coder: NSCoder) { fatalError() }

    // コミットメッセージの空欄に薄い案内を出す
    private func placeholder() {
        message.setValue(NSAttributedString(string: "コミットメッセージ",
                                            attributes: [.foregroundColor: Palette.faint, .font: Fonts.ui(12)]),
                         forKey: "placeholderAttributedString")
    }

    var changeCount: Int { git?.files.count ?? 0 }

    func load(_ cwd: String?) {
        guard let cwd else { return }
        if cwd != self.cwd {
            file = nil
            paneBox.isHidden = true
        }
        self.cwd = cwd
        Task { @MainActor in
            do { git = try await c.deck.gitStatus(cwd) }
            catch { git = GitStatus(branch: "?", ahead: nil, behind: nil, files: []) }
            guard self.cwd == cwd else { return }
            render()
            c.renderStage()
        }
    }

    private func render() {
        guard let git else { return }
        branch.stringValue = git.branch
        var t: [String] = []
        if let a = git.ahead, a > 0 { t.append("↑\(a)") }
        if let b = git.behind, b > 0 { t.append("↓\(b)") }
        track.stringValue = t.joined(separator: " ")

        empty.isHidden = !git.files.isEmpty
        changeScroll.isHidden = git.files.isEmpty
        changes.setViews([])
        for f in git.files {
            let row = RowView()
            row.background = f.path == file?.path ? Palette.raised : nil
            row.toolTip = f.path
            row.onClick = { [weak self] _ in self?.show(f) }
            let mark = f.untracked ? "?" : (f.index != " " ? f.index : f.work)
            let markColor: NSColor = mark == "M" ? Palette.amber : (mark == "A" || mark == "?") ? Palette.run : mark == "D" ? Palette.dead : Palette.dim
            let path = label(f.path, size: 11.5, color: Palette.dim, mono: true)
            path.lineBreakMode = .byTruncatingHead   // 長いパスは先頭を削る
            var views: [NSView] = [label(mark, size: 11, color: markColor, mono: true), path, NSView()]
            if f.staged { views.append(label("●", size: 10, color: Palette.run)) }
            let body = hstack(views, spacing: 8)
            body.translatesAutoresizingMaskIntoConstraints = false
            row.addSubview(body)
            NSLayoutConstraint.activate([
                body.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 14),
                body.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -14),
                body.topAnchor.constraint(equalTo: row.topAnchor, constant: 4),
                body.bottomAnchor.constraint(equalTo: row.bottomAnchor, constant: -4),
            ])
            changes.fill(row)
        }
    }

    private func show(_ f: GitFile) {
        file = f
        render()
        paneBox.isHidden = false
        openFile.stringValue = f.path
        setMode(mode)
    }

    private func setMode(_ next: String, load: Bool = true) {
        mode = next
        tabDiff.on = mode == "diff"
        tabEdit.on = mode == "edit"
        save.isHidden = mode != "edit"
        guard load, let file, let cwd else { return }
        if mode == "diff" { loadDiff(file, cwd: cwd) } else { loadEdit(file, cwd: cwd) }
    }

    private func loadDiff(_ f: GitFile, cwd: String) {
        editing = false
        viewer.isEditable = false
        Task { @MainActor in
            let diff = (try? await c.deck.gitDiff(cwd, file: f.path, staged: f.staged && f.work == " ")) ?? ""
            guard file?.path == f.path, mode == "diff" else { return }
            let out = NSMutableAttributedString()
            let para = NSMutableParagraphStyle()
            para.lineSpacing = 1
            for line in diff.split(separator: "\n", omittingEmptySubsequences: false) {
                var color = Palette.faint
                var bg: NSColor? = nil
                if line.hasPrefix("+") && !line.hasPrefix("+++") { color = Palette.hex(0xa5c8a7); bg = Palette.hex(0x6f9a72, alpha: 0.11) }
                else if line.hasPrefix("-") && !line.hasPrefix("---") { color = Palette.hex(0xd29b96); bg = Palette.hex(0xa8615b, alpha: 0.11) }
                else if line.hasPrefix("@@") { bg = Palette.raised }
                var attrs: [NSAttributedString.Key: Any] = [.foregroundColor: color, .font: Fonts.mono(11), .paragraphStyle: para]
                if let bg { attrs[.backgroundColor] = bg }
                out.append(NSAttributedString(string: (line.isEmpty ? " " : String(line)) + "\n", attributes: attrs))
            }
            viewer.textStorage?.setAttributedString(out)
            viewer.scroll(.zero)
        }
    }

    // エディタは補助機能。等幅の素の文字で開き、⌘S で書き戻す。
    private func loadEdit(_ f: GitFile, cwd: String) {
        Task { @MainActor in
            do {
                let content = try await c.deck.readFile(cwd, path: f.path)
                guard file?.path == f.path, mode == "edit" else { return }
                editing = true
                viewer.isEditable = true
                viewer.textStorage?.setAttributedString(NSAttributedString(string: content, attributes: [
                    .foregroundColor: Palette.text, .font: Fonts.mono(11.5),
                ]))
                viewer.typingAttributes = [.foregroundColor: Palette.text, .font: Fonts.mono(11.5)]
                viewer.scroll(.zero)
                window?.makeFirstResponder(viewer)
            } catch {
                say(error.localizedDescription)
            }
        }
    }

    var canSave: Bool { editing && !isHidden && file != nil }

    func saveFile() {
        guard canSave, let file, let cwd else { return }
        let content = viewer.string
        Task { @MainActor in
            do {
                try await c.deck.writeFile(cwd, path: file.path, content: content)
                say("保存しました · \(file.path)")
                load(cwd)
            } catch { say(error.localizedDescription) }
        }
    }

    private func say(_ text: String) { log.stringValue = text }

    private func stageEverything() {
        guard let cwd, let git else { return }
        Task { @MainActor in
            do {
                try await c.deck.gitStage(cwd, files: git.files.map(\.path))
                say("全ファイルをステージしました")
                load(cwd)
            } catch { say(error.localizedDescription) }
        }
    }

    private func commitNow() {
        guard let cwd else { return }
        let text = message.string.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { say("コミットメッセージを入れてください"); return }
        Task { @MainActor in
            do {
                let output = try await c.deck.gitCommit(cwd, message: text)
                message.string = ""
                say(output.trimmingCharacters(in: .whitespacesAndNewlines))
                load(cwd)
            } catch { say(error.localizedDescription) }
        }
    }

    private func pushNow() {
        guard let cwd else { return }
        say("push 中…")
        Task { @MainActor in
            do {
                let output = try await c.deck.gitPush(cwd).trimmingCharacters(in: .whitespacesAndNewlines)
                say(output.isEmpty ? "push 完了" : output)
                load(cwd)
            } catch { say(error.localizedDescription) }
        }
    }
}
