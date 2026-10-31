import AppKit

// 画面のデザイントークン。web/style.css の :root とそろえる。
enum Palette {
    static func hex(_ value: UInt32, alpha: CGFloat = 1) -> NSColor {
        NSColor(srgbRed: CGFloat((value >> 16) & 0xff) / 255,
                green: CGFloat((value >> 8) & 0xff) / 255,
                blue: CGFloat(value & 0xff) / 255, alpha: alpha)
    }
    static let bg = hex(0x131311)
    static let panel = hex(0x191917)
    static let raised = hex(0x201f1c)
    static let line = hex(0x2b2a26)
    static let lineSoft = hex(0x232220)
    static let text = hex(0xe6e3dc)
    static let dim = hex(0x8d8a82)
    static let faint = hex(0x5c5a54)
    static let amber = hex(0xe0a145)          // 「あなたの番です」にだけ使う
    static let amberSoft = hex(0xe0a145, alpha: 0.11)
    static let run = hex(0x6f9a72)            // 実行中は「待てばいい」ので控えめに
    static let dead = hex(0xa8615b)

    static func status(_ status: String?) -> NSColor {
        switch status {
        case "running": return run
        case "attention": return amber
        case "exited": return dead
        default: return faint
        }
    }

    // web/term.js の THEME と同じ並び（black, red, green, yellow, blue, magenta, cyan, white, bright…）
    static let ansi: [UInt32] = [
        0x131311, 0xc9756e, 0x7fa882, 0xe0a145, 0x7c9cbf, 0xb58bb0, 0x83a9a6, 0xd8d4cc,
        0x5c5a54, 0xdc8d86, 0x98c09b, 0xedb15b, 0x95b4d6, 0xcba3c6, 0x9cc0bd, 0xf2efe8,
    ]
}

enum Fonts {
    static func ui(_ size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont {
        .systemFont(ofSize: size, weight: weight)
    }
    static func mono(_ size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont {
        .monospacedSystemFont(ofSize: size, weight: weight)
    }
}

let STATE_LABEL = ["starting": "起動中", "running": "実行中", "attention": "要対応", "idle": "待機", "exited": "終了"]
let AGENT_LABEL = ["claude": "Claude Code", "codex": "Codex"]

func relTime(_ ms: Double?) -> String {
    guard let ms, ms > 0 else { return "" }
    let sec = Int(Date().timeIntervalSince1970 - ms / 1000)
    if sec < 45 { return "たった今" }
    if sec < 3600 { return "\(sec / 60)分前" }
    if sec < 86400 { return "\(sec / 3600)時間前" }
    return "\(sec / 86400)日前"
}

func homeTilde(_ path: String) -> String {
    let home = NSHomeDirectory()
    return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
}

func label(_ text: String, size: CGFloat = 12, color: NSColor = Palette.text,
           weight: NSFont.Weight = .regular, mono: Bool = false) -> NSTextField {
    let field = NSTextField(labelWithString: text)
    field.font = mono ? Fonts.mono(size, weight) : Fonts.ui(size, weight)
    field.textColor = color
    field.lineBreakMode = .byTruncatingTail
    field.maximumNumberOfLines = 1
    field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    return field
}

/// 折り返す文。説明や執事の見立てに使う。
func paragraph(_ text: String, size: CGFloat = 11, color: NSColor = Palette.dim, mono: Bool = false) -> NSTextField {
    let field = NSTextField(wrappingLabelWithString: text)
    field.font = mono ? Fonts.mono(size) : Fonts.ui(size)
    field.textColor = color
    field.isSelectable = true
    field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    return field
}

func dotView(_ color: NSColor, size: CGFloat = 6) -> NSView {
    let view = NSView()
    view.wantsLayer = true
    view.layer?.cornerRadius = size / 2
    view.layer?.backgroundColor = color.cgColor
    view.translatesAutoresizingMaskIntoConstraints = false
    view.widthAnchor.constraint(equalToConstant: size).isActive = true
    view.heightAnchor.constraint(equalToConstant: size).isActive = true
    return view
}

func hstack(_ views: [NSView], spacing: CGFloat = 6) -> NSStackView {
    let stack = NSStackView(views: views)
    stack.orientation = .horizontal
    stack.alignment = .centerY
    stack.spacing = spacing
    return stack
}

func vstack(_ views: [NSView], spacing: CGFloat = 4) -> NSStackView {
    let stack = NSStackView(views: views)
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = spacing
    return stack
}

/// 押すと閉包を呼ぶボタン。見た目は web の ghost / link / icon / primary にそろえる。
final class Button: NSButton {
    enum Style { case ghost, danger, primary, approve, link, icon, plain }
    var onPress: (() -> Void)?
    private let style: Style
    var on = false { didSet { restyle() } }

    init(_ title: String, style: Style = .ghost, size: CGFloat? = nil, action: (() -> Void)? = nil) {
        self.style = style
        self.onPress = action
        super.init(frame: .zero)
        self.title = title
        isBordered = false
        bezelStyle = .regularSquare
        setButtonType(.momentaryChange)
        target = self
        self.action = #selector(pressed)
        wantsLayer = true
        layer?.cornerRadius = 3
        font = Fonts.ui(size ?? (style == .icon ? 14 : 11.5))
        restyle()
    }

    required init?(coder: NSCoder) { fatalError() }

    override var title: String { didSet { restyle() } }
    override var isEnabled: Bool { didSet { alphaValue = isEnabled ? 1 : 0.4 } }

    @objc private func pressed() { onPress?() }

    private func restyle() {
        var color = Palette.dim
        var border: NSColor? = nil
        var fill: NSColor? = nil
        switch style {
        case .ghost: border = Palette.line
        case .danger: border = Palette.line; color = Palette.dead
        case .primary: fill = Palette.amber; color = Palette.hex(0x1b1508)
        case .approve: border = Palette.amber; color = Palette.amber; fill = Palette.amberSoft
        case .link: color = Palette.faint
        case .icon: color = Palette.dim
        case .plain: color = on ? Palette.text : Palette.faint; fill = on ? Palette.raised : nil
        }
        layer?.borderWidth = border == nil ? 0 : 1
        layer?.borderColor = border?.cgColor
        layer?.backgroundColor = fill?.cgColor
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        paragraph.lineBreakMode = .byTruncatingTail
        attributedTitle = NSAttributedString(string: title, attributes: [
            .foregroundColor: color, .font: font ?? Fonts.ui(11.5), .paragraphStyle: paragraph,
        ])
    }

    override var intrinsicContentSize: NSSize {
        let size = super.intrinsicContentSize
        switch style {
        case .ghost, .danger, .approve: return NSSize(width: size.width + 18, height: 24)
        case .primary: return NSSize(width: size.width + 26, height: 24)
        case .plain: return NSSize(width: size.width + 12, height: 22)
        case .icon: return NSSize(width: 24, height: 24)
        case .link: return NSSize(width: size.width + 4, height: 18)
        }
    }
}

/// 押せる行。クリック・右クリック・ドラッグ開始を受ける。
class RowView: NSView, NSDraggingSource {
    var onClick: ((NSEvent.ModifierFlags) -> Void)?
    var menuProvider: (() -> NSMenu?)?
    /// ドラッグで運ぶもの（型と中身）。nil ならドラッグしない
    var dragPayload: (NSPasteboard.PasteboardType, String)?
    var background: NSColor? { didSet { layer?.backgroundColor = background?.cgColor } }

    private var downEvent: NSEvent?
    private var dragging = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 3
    }

    required init?(coder: NSCoder) { fatalError() }

    override func mouseDown(with event: NSEvent) {
        downEvent = event
        dragging = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let down = downEvent, !dragging, let payload = dragPayload else { return }
        let dx = event.locationInWindow.x - down.locationInWindow.x
        let dy = event.locationInWindow.y - down.locationInWindow.y
        guard dx * dx + dy * dy > 16 else { return }
        dragging = true
        let item = NSPasteboardItem()
        item.setString(payload.1, forType: payload.0)
        let dragItem = NSDraggingItem(pasteboardWriter: item)
        dragItem.setDraggingFrame(bounds, contents: snapshot())
        beginDraggingSession(with: [dragItem], event: down, source: self)
    }

    override func mouseUp(with event: NSEvent) {
        defer { downEvent = nil }
        guard !dragging, let down = downEvent else { return }
        onClick?(down.modifierFlags)
    }

    override func menu(for event: NSEvent) -> NSMenu? { menuProvider?() }

    func draggingSession(_ session: NSDraggingSession,
                         sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        context == .withinApplication ? [.copy, .move] : []
    }

    private func snapshot() -> NSImage {
        guard let rep = bitmapImageRepForCachingDisplay(in: bounds) else { return NSImage() }
        cacheDisplay(in: bounds, to: rep)
        let image = NSImage(size: bounds.size)
        image.addRepresentation(rep)
        return image
    }
}

final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

/// 縦に積む中身を持つスクロール。中身の幅はスクロールの幅に合わせる。
func scrollingStack(_ stack: NSStackView) -> NSScrollView {
    let scroll = NSScrollView()
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    scroll.scrollerStyle = .overlay
    let doc = FlippedView()
    doc.translatesAutoresizingMaskIntoConstraints = false
    stack.translatesAutoresizingMaskIntoConstraints = false
    doc.addSubview(stack)
    scroll.documentView = doc
    NSLayoutConstraint.activate([
        doc.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
        doc.trailingAnchor.constraint(equalTo: scroll.contentView.trailingAnchor),
        doc.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
        stack.leadingAnchor.constraint(equalTo: doc.leadingAnchor),
        stack.trailingAnchor.constraint(equalTo: doc.trailingAnchor),
        stack.topAnchor.constraint(equalTo: doc.topAnchor),
        stack.bottomAnchor.constraint(equalTo: doc.bottomAnchor),
    ])
    return scroll
}

extension NSStackView {
    func setViews(_ views: [NSView]) {
        arrangedSubviews.forEach { $0.removeFromSuperview() }
        views.forEach { addArrangedSubview($0) }
    }

    /// 子を横いっぱいに伸ばす（vertical のときの既定は中身の幅）
    func fill(_ view: NSView, inset: CGFloat = 0) {
        addArrangedSubview(view)
        view.translatesAutoresizingMaskIntoConstraints = false
        view.leadingAnchor.constraint(equalTo: leadingAnchor, constant: inset).isActive = true
        view.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -inset).isActive = true
    }
}

/// 下に出て消える知らせ。モーダルは出さない。
final class Toast: NSView {
    private let text = label("", size: 12, color: Palette.text)
    private var timer: Timer?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 3
        layer?.backgroundColor = Palette.raised.cgColor
        layer?.borderWidth = 1
        layer?.borderColor = Palette.line.cgColor
        text.maximumNumberOfLines = 3
        text.lineBreakMode = .byWordWrapping
        text.preferredMaxLayoutWidth = 420
        text.translatesAutoresizingMaskIntoConstraints = false
        addSubview(text)
        NSLayoutConstraint.activate([
            text.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            text.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            text.topAnchor.constraint(equalTo: topAnchor, constant: 9),
            text.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -9),
            widthAnchor.constraint(lessThanOrEqualToConstant: 450),
        ])
        isHidden = true
    }

    required init?(coder: NSCoder) { fatalError() }

    func show(_ message: String, seconds: Double = 3.2) {
        text.stringValue = message
        isHidden = false
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            self?.isHidden = true
        }
    }
}

extension NSPasteboard.PasteboardType {
    static let ccdeckSession = NSPasteboard.PasteboardType("jp.ccdeck.session")
    static let ccdeckPane = NSPasteboard.PasteboardType("jp.ccdeck.pane")
}
