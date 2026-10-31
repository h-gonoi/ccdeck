import AppKit

/// 枠の並べ方。web/style.css の .terms[data-count] と同じ列数で敷き詰める。
/// 一覧の行や枠の見出しを落とすと、そこへ差し込む・並べ替える。
final class GridView: NSView {
    private(set) var panes: [PaneView] = []
    var onDrop: ((_ kind: NSPasteboard.PasteboardType, _ id: String, _ index: Int) -> Void)?

    private let welcome = vstack([
        label("まだ何も走っていません。", size: 15, color: Palette.text),
        paragraph("左のプロジェクトをクリックすると Claude Code、＋からは Codex も選んで立ち上げられます。\n"
                  + "複数立ち上げても、手が空いたセッションは左のリストが琥珀色で教えます。", size: 12),
    ], spacing: 10)
    private var dropIndex: Int?

    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = Palette.lineSoft.cgColor   // 1px の隙間から地の色を透かす
        welcome.translatesAutoresizingMaskIntoConstraints = false
        addSubview(welcome)
        NSLayoutConstraint.activate([
            welcome.centerXAnchor.constraint(equalTo: centerXAnchor),
            welcome.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -40),
            welcome.widthAnchor.constraint(lessThanOrEqualToConstant: 460),
        ])
        registerForDraggedTypes([.ccdeckSession, .ccdeckPane])
        updateEmpty()
    }

    required init?(coder: NSCoder) { fatalError() }

    static func columns(for count: Int) -> Int {
        switch count {
        case ...1: return 1
        case 2, 4: return 2
        case 3, 5...9: return 3
        default: return 4
        }
    }

    /// 表示する枠を並び順で差し替える。ここで実寸が決まり、桁数が送られる。
    func show(_ next: [PaneView]) {
        for pane in panes where !next.contains(where: { $0 === pane }) { pane.removeFromSuperview() }
        for pane in next where pane.superview !== self { addSubview(pane) }
        panes = next
        updateEmpty()
        needsLayout = true
        layoutSubtreeIfNeeded()
    }

    private func updateEmpty() {
        welcome.isHidden = !panes.isEmpty
        layer?.backgroundColor = (panes.isEmpty ? Palette.bg : Palette.lineSoft).cgColor
    }

    override func layout() {
        super.layout()
        let count = panes.count
        guard count > 0 else { return }
        let cols = GridView.columns(for: count)
        let rows = Int(ceil(Double(count) / Double(cols)))
        let gap: CGFloat = 1
        let w = (bounds.width - gap * CGFloat(cols - 1)) / CGFloat(cols)
        let h = (bounds.height - gap * CGFloat(rows - 1)) / CGFloat(rows)
        for (i, pane) in panes.enumerated() {
            let c = i % cols, r = i / cols
            pane.frame = NSRect(x: (w + gap) * CGFloat(c), y: (h + gap) * CGFloat(r),
                                width: w, height: h).integral
            pane.layoutSubtreeIfNeeded()
        }
    }

    // ---------- ドラッグで枠に並べる ----------

    private func kind(_ info: NSDraggingInfo) -> NSPasteboard.PasteboardType? {
        let types = info.draggingPasteboard.types ?? []
        if types.contains(.ccdeckPane) { return .ccdeckPane }
        if types.contains(.ccdeckSession) { return .ccdeckSession }
        return nil
    }

    private func clearHints() {
        panes.forEach { $0.dropHint = false }
        layer?.borderWidth = 0
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { draggingUpdated(sender) }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard let kind = kind(sender) else { return [] }
        clearHints()
        let point = convert(sender.draggingLocation, from: nil)
        if let index = panes.firstIndex(where: { $0.frame.contains(point) }) {
            panes[index].dropHint = true
            dropIndex = index
        } else {
            layer?.borderWidth = 2
            layer?.borderColor = Palette.dim.cgColor
            dropIndex = panes.count
        }
        return kind == .ccdeckPane ? .move : .copy
    }

    override func draggingExited(_ sender: NSDraggingInfo?) { clearHints() }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        defer { clearHints(); dropIndex = nil }
        guard let kind = kind(sender), let id = sender.draggingPasteboard.string(forType: kind) else { return false }
        onDrop?(kind, id, dropIndex ?? panes.count)
        return true
    }
}

/// 上の帯。いま打っているセッションの名前と、操作のボタン。
final class StageHead: NSView {
    let rail = Button("☰", style: .icon)
    let dot = dotView(Palette.faint, size: 7)
    let name = label("", size: 12.5, weight: .medium)
    let path = label("", size: 11, color: Palette.faint)
    let claude = Button("Claude Code", style: .plain, size: 10.5)
    let codex = Button("Codex", style: .plain, size: 10.5)
    let model = Button("モデル", style: .ghost)
    let tile = Button("並べる", style: .ghost)
    let git = Button("変更 0", style: .ghost)
    let kill = Button("終了", style: .danger)
    private let identity: NSStackView
    private let actions: NSStackView

    override init(frame: NSRect) {
        identity = hstack([dot, name, path], spacing: 8)
        let agents = hstack([claude, codex], spacing: 2)
        agents.wantsLayer = true
        agents.layer?.borderWidth = 1
        agents.layer?.borderColor = Palette.line.cgColor
        agents.layer?.cornerRadius = 3
        agents.edgeInsets = NSEdgeInsets(top: 1, left: 1, bottom: 1, right: 1)
        actions = hstack([agents, model, tile, git, kill], spacing: 6)
        let bar = hstack([rail, identity], spacing: 10)
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = Palette.bg.cgColor

        rail.toolTip = "サイドバーの開閉 (⌘B)"
        model.toolTip = "モデルを切り替える（CLI の /model を開きます）"
        tile.toolTip = "走っているセッションを並べる (⌘E)"
        git.toolTip = "変更 (⌘G)"
        path.lineBreakMode = .byTruncatingHead

        for view in [bar, actions] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
        }
        let rule = NSView()
        rule.wantsLayer = true
        rule.layer?.backgroundColor = Palette.line.cgColor
        rule.translatesAutoresizingMaskIntoConstraints = false
        addSubview(rule)

        let pinned = bar.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10)
        NSLayoutConstraint.activate([
            pinned,
            bar.centerYAnchor.constraint(equalTo: centerYAnchor),
            actions.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            actions.centerYAnchor.constraint(equalTo: centerYAnchor),
            bar.trailingAnchor.constraint(lessThanOrEqualTo: actions.leadingAnchor, constant: -12),
            rule.leadingAnchor.constraint(equalTo: leadingAnchor),
            rule.trailingAnchor.constraint(equalTo: trailingAnchor),
            rule.bottomAnchor.constraint(equalTo: bottomAnchor),
            rule.heightAnchor.constraint(equalToConstant: 1),
        ])
        barLeading = pinned
        actions.setContentHuggingPriority(.required, for: .horizontal)
        actions.setContentCompressionResistancePriority(.required, for: .horizontal)
    }

    private var barLeading: NSLayoutConstraint?

    /// 一覧を畳んだときは信号機ボタンの右へずらす
    func setInset(_ inset: CGFloat) { barLeading?.constant = inset }

    required init?(coder: NSCoder) { fatalError() }

    func setIdentityHidden(_ hidden: Bool) {
        identity.isHidden = hidden
        actions.isHidden = hidden
    }
}

/// 全体の器。左に一覧、中に枠、右に git の引き出し。区切りは 1px の線だけ（カードで囲まない）。
final class RootView: NSView {
    let rail = Rail()
    let head = StageHead()
    let grid = GridView()
    let drawer = Drawer()
    let toast = Toast()
    private let railRule = NSView()
    private let drawerRule = NSView()

    static let railWidth: CGFloat = 264
    static let drawerWidth: CGFloat = 380   // 左右であえて幅を揃えない
    static let headHeight: CGFloat = 40

    var railShown = true { didSet { needsLayout = true } }
    var drawerShown = false { didSet { needsLayout = true } }

    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = Palette.bg.cgColor
        for rule in [railRule, drawerRule] {
            rule.wantsLayer = true
            rule.layer?.backgroundColor = Palette.line.cgColor
        }
        addSubview(rail)
        addSubview(railRule)
        addSubview(head)
        addSubview(grid)
        addSubview(drawerRule)
        addSubview(drawer)
        toast.translatesAutoresizingMaskIntoConstraints = false
        addSubview(toast)
        toastLeading = toast.leadingAnchor.constraint(equalTo: leadingAnchor, constant: RootView.railWidth + 22)
        NSLayoutConstraint.activate([
            toastLeading!,
            toast.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -22),
        ])
    }

    private var toastLeading: NSLayoutConstraint?

    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        let railW = railShown ? RootView.railWidth : 0
        let drawerW = drawerShown ? RootView.drawerWidth : 0
        rail.isHidden = !railShown
        railRule.isHidden = !railShown
        drawer.isHidden = !drawerShown
        drawerRule.isHidden = !drawerShown

        rail.frame = NSRect(x: 0, y: 0, width: railW, height: bounds.height)
        railRule.frame = NSRect(x: railW, y: 0, width: 1, height: bounds.height)
        let stageX = railShown ? railW + 1 : 0
        let stageW = bounds.width - stageX - (drawerShown ? drawerW + 1 : 0)
        head.frame = NSRect(x: stageX, y: 0, width: stageW, height: RootView.headHeight)
        // 一覧を畳んでいるときは、信号機ボタンが帯に乗るのでよける
        head.setInset(railShown ? 10 : 78)
        grid.frame = NSRect(x: stageX, y: RootView.headHeight, width: stageW,
                            height: bounds.height - RootView.headHeight)
        drawerRule.frame = NSRect(x: stageX + stageW, y: 0, width: 1, height: bounds.height)
        drawer.frame = NSRect(x: stageX + stageW + 1, y: 0, width: drawerW, height: bounds.height)
        toastLeading?.constant = stageX + 22
    }
}
