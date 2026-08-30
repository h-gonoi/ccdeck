import Cocoa

// ccdeck のメニューバー常駐アプリ。
// 目的はひとつ、「自分の番が来たセッションがあるか」を画面の隅で伝えること。
let PORT = 7788
let BASE = "http://127.0.0.1:\(PORT)"
let DECK = NSString(string: "~/projects/ccdeck/bin/ccdeck").expandingTildeInPath

struct Item {
    let title: String
    let status: String
    let external: Bool
    let tty: String?
}

let AMBER = NSColor(red: 0.88, green: 0.63, blue: 0.27, alpha: 1)

func mark(_ status: String) -> String {
    switch status {
    case "attention": return "●"
    case "running":   return "▶"
    case "exited":    return "✕"
    default:          return "○"
    }
}

func label(_ status: String) -> String {
    switch status {
    case "attention": return "要対応"
    case "running":   return "実行中"
    case "exited":    return "終了"
    default:          return "待機"
    }
}

@discardableResult
func shell(_ args: [String]) -> Int32 {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/bin/zsh")
    task.arguments = ["-lc"] + args
    try? task.run()
    return 0
}

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var timer: Timer?
    var items: [Item] = []
    var serverUp = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .medium)
        render()
        ensureServer()
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    // MARK: - 取得

    // サーバーが無いとメニューバーは何も分からない。起動時に一度だけ面倒を見る。
    // （以降は自動で立て直さない。「止める」を選んだ意思を上書きしないため）
    func ensureServer() {
        fetch("/api/sessions") { result in
            if result == nil { shell(["'\(DECK)' start"]) }
        }
    }

    func refresh() {
        fetch("/api/sessions") { own in
            self.fetch("/api/external") { ext in
                DispatchQueue.main.async {
                    if own == nil && ext == nil {
                        self.serverUp = false
                        self.items = []
                    } else {
                        self.serverUp = true
                        self.items = (own ?? []).map {
                            Item(title: $0["title"] as? String ?? "?",
                                 status: $0["status"] as? String ?? "idle",
                                 external: false, tty: nil)
                        } + (ext ?? []).map {
                            Item(title: $0["title"] as? String ?? "?",
                                 status: $0["status"] as? String ?? "idle",
                                 external: true, tty: $0["tty"] as? String)
                        }
                    }
                    self.render()
                }
            }
        }
    }

    func fetch(_ path: String, done: @escaping ([[String: Any]]?) -> Void) {
        guard let url = URL(string: BASE + path) else { return done(nil) }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { data, _, _ in
            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
            else { return done(nil) }
            done(json)
        }.resume()
    }

    // MARK: - 表示

    func render() {
        guard let button = statusItem.button else { return }
        let waiting = items.filter { $0.status == "attention" }.count
        let running = items.filter { $0.status == "running" }.count

        if !serverUp {
            button.attributedTitle = NSAttributedString(
                string: "cc",
                attributes: [.foregroundColor: NSColor.tertiaryLabelColor])
        } else if waiting > 0 {
            // 自分の番があるときだけ色を使う。それ以外は目に入らないくらいでいい。
            button.attributedTitle = NSAttributedString(
                string: "● \(waiting)",
                attributes: [.foregroundColor: AMBER])
        } else if running > 0 {
            button.attributedTitle = NSAttributedString(
                string: "▶ \(running)",
                attributes: [.foregroundColor: NSColor.secondaryLabelColor])
        } else {
            button.attributedTitle = NSAttributedString(
                string: "cc",
                attributes: [.foregroundColor: NSColor.secondaryLabelColor])
        }

        statusItem.menu = buildMenu(waiting: waiting)
    }

    func buildMenu(waiting: Int) -> NSMenu {
        let menu = NSMenu()

        if !serverUp {
            menu.addItem(disabled("ccdeck は動いていません"))
            menu.addItem(NSMenuItem.separator())
            menu.addItem(action("ccdeck を起動する", #selector(openDeck), key: "o"))
        } else {
            let summary = waiting > 0
                ? "\(items.count) 本 · \(waiting) 件が待っています"
                : "\(items.count) 本 稼働中"
            menu.addItem(disabled(summary))
            menu.addItem(NSMenuItem.separator())

            for (index, item) in items.enumerated() {
                let entry = NSMenuItem(
                    title: "\(mark(item.status))  \(item.title)  —  \(label(item.status))",
                    action: #selector(openItem(_:)), keyEquivalent: "")
                entry.target = self
                entry.tag = index
                if item.status == "attention" {
                    entry.attributedTitle = NSAttributedString(
                        string: entry.title,
                        attributes: [.foregroundColor: AMBER])
                }
                if item.external {
                    entry.toolTip = "別のターミナルで動いています。選ぶとそのウィンドウを前に出します"
                }
                menu.addItem(entry)
            }
            menu.addItem(NSMenuItem.separator())
            menu.addItem(action("ccdeck を開く", #selector(openDeck), key: "o"))
            menu.addItem(action("サーバーを止める", #selector(stopDeck), key: ""))
        }

        menu.addItem(NSMenuItem.separator())
        menu.addItem(action("終了", #selector(quit), key: "q"))
        return menu
    }

    func disabled(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    func action(_ title: String, _ selector: Selector, key: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        item.target = self
        return item
    }

    // MARK: - 操作

    @objc func openItem(_ sender: NSMenuItem) {
        guard sender.tag < items.count else { return }
        let item = items[sender.tag]
        // 外のセッションはそのターミナルを、ccdeck のものは ccdeck を開く
        if item.external, let tty = item.tty {
            let payload = "{\"tty\":\"\(tty)\"}"
            shell(["curl -s -X POST \(BASE)/api/external/focus -H 'Content-Type: application/json' -d '\(payload)'"])
        } else {
            openDeck()
        }
    }

    @objc func openDeck() { shell(["'\(DECK)' open"]) }
    @objc func stopDeck() { shell(["'\(DECK)' stop"]) }
    @objc func quit() { NSApplication.shared.terminate(nil) }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)   // Dock に出さず、メニューバーだけに置く
app.run()
