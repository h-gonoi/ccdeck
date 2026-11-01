import AppKit
import SwiftTerm

// 分割すると 1 枠が細くなる。Claude Code の TUI は桁数が足りないと崩れるので、
// 枠の実寸に合わせて文字を詰める（web/term.js の fontSizeFor と同じ段）。
func fontSizeFor(width: CGFloat) -> CGFloat {
    if width > 1000 { return 12 }
    if width > 700 { return 11 }
    if width > 500 { return 10 }
    if width > 380 { return 9 }
    return 8
}

/// 1 セッションぶんの枠。見出し（状態の点・名前・×）とターミナル。
/// 見出しを掴んで枠ごと並べ替えられる。
final class PaneView: NSView, TerminalViewDelegate {
    let id: String
    let term: TerminalView
    var onInput: ((String, String) -> Void)?
    var onResize: ((String, Int, Int) -> Void)?
    var onClose: ((String) -> Void)?

    private let head = RowView()
    private let dot = NSView()
    private let name = NSTextField(labelWithString: "")
    private let close = Button("×", style: .icon, size: 13)
    private let dropMark = NSView()
    private var lastSize = ""
    private static let headHeight: CGFloat = 24

    var isActive = false { didSet { updateHead() } }
    var dropHint = false { didSet { dropMark.isHidden = !dropHint } }

    init(id: String) {
        self.id = id
        term = TerminalView(frame: .zero, font: PaneView.font(12),
                            options: TerminalOptions(scrollback: 8000))
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = Palette.bg.cgColor

        head.layer?.cornerRadius = 0
        head.dragPayload = (.ccdeckPane, id)
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 3
        name.font = Fonts.ui(11)
        name.textColor = Palette.dim
        name.lineBreakMode = .byTruncatingTail
        close.toolTip = "この枠から外す"
        close.onPress = { [weak self] in
            guard let self else { return }
            self.onClose?(self.id)
        }
        head.addSubview(dot)
        head.addSubview(name)
        head.addSubview(close)
        addSubview(head)

        term.terminalDelegate = self
        term.optionAsMetaKey = true   // web 版の macOptionIsMeta と同じ
        term.nativeBackgroundColor = Palette.bg
        term.nativeForegroundColor = Palette.text
        term.caretColor = Palette.amber
        term.selectedTextBackgroundColor = Palette.hex(0xe0a145, alpha: 0.22)
        term.installColors(Palette.ansi.map {
            Color(red: UInt16(($0 >> 16) & 0xff) * 257,
                  green: UInt16(($0 >> 8) & 0xff) * 257,
                  blue: UInt16($0 & 0xff) * 257)
        })
        addSubview(term)

        // 落とし先の印。ドラッグ中だけ枠の縁を琥珀にしない（琥珀は「あなたの番」専用）ので淡い線
        dropMark.wantsLayer = true
        dropMark.layer?.borderWidth = 2
        dropMark.layer?.borderColor = Palette.dim.cgColor
        dropMark.isHidden = true
        addSubview(dropMark)
        updateHead()
    }

    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }

    private static func font(_ size: CGFloat) -> NSFont { Fonts.mono(size) }

    override func layout() {
        super.layout()
        let h = PaneView.headHeight
        head.frame = NSRect(x: 0, y: 0, width: bounds.width, height: h)
        dot.frame = NSRect(x: 10, y: (h - 6) / 2, width: 6, height: 6)
        close.frame = NSRect(x: bounds.width - 26, y: 0, width: 24, height: h)
        name.frame = NSRect(x: 22, y: (h - 14) / 2, width: max(0, bounds.width - 52), height: 14)
        dropMark.frame = bounds

        let size = fontSizeFor(width: bounds.width)
        if term.font.pointSize != size { term.font = PaneView.font(size) }
        term.frame = NSRect(x: 0, y: h, width: bounds.width, height: max(0, bounds.height - h))
        reportSize()
    }

    /// いまの桁数を、変わっていればサーバーへ送る。
    func reportSize(force: Bool = false) {
        let dims = term.terminalDimensions
        guard dims.cols > 0, dims.rows > 0, !isHiddenOrHasHiddenAncestor, bounds.width > 0 else { return }
        let key = "\(dims.cols)x\(dims.rows)"
        if !force && key == lastSize { return }
        lastSize = key
        onResize?(id, dims.cols, dims.rows)
    }

    var size: (cols: Int, rows: Int) {
        let dims = term.terminalDimensions
        return (dims.cols, dims.rows)
    }

    func update(title: String?, status: String?) {
        if let title { name.stringValue = title }
        dot.layer?.backgroundColor = Palette.status(status).cgColor
    }

    private func updateHead() {
        name.textColor = isActive ? Palette.text : Palette.dim
        head.background = isActive ? Palette.raised : Palette.panel
    }

    func replay(_ data: String) {
        term.resetToInitialState()
        term.feed(text: data)
    }

    func write(_ data: String) { term.feed(text: data) }

    // ---------- TerminalViewDelegate ----------

    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        onInput?(id, String(decoding: data, as: UTF8.self))
    }

    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) { reportSize() }
    func setTerminalTitle(source: TerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func scrolled(source: TerminalView, position: Double) {}
    func bell(source: TerminalView) {}
    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
    func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}

    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        // http(s) だけ開く。file: などを素通しにしない
        guard let url = URL(string: link), ["http", "https"].contains(url.scheme ?? "") else { return }
        NSWorkspace.shared.open(url)
    }

    func clipboardCopy(source: TerminalView, content: Data) {
        guard let text = String(data: content, encoding: .utf8) else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    // 端末側のプログラムからクリップボードを読ませない（OSC 52 の読み出し）
    func clipboardRead(source: TerminalView) -> Data? { nil }
}
