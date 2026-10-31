import AppKit

// ccdeck のネイティブ画面。Chrome も WebView も使わず、AppKit と SwiftTerm だけで描く。
// サーバー（server/）はそのまま。ブラウザ版と同じ WebSocket・REST に繋ぐ、もう一つの受け手。
//
//   CCDECK_PORT=7799 swift run    … 試験サーバーに繋ぐ（既定は 7788）
//   open build/ccdeck.app --args --port 7799

// .app を open で起こすと環境変数が渡らないので、--port でも受ける
let args = CommandLine.arguments
let portArg = args.firstIndex(of: "--port").flatMap { args.indices.contains($0 + 1) ? Int(args[$0 + 1]) : nil }
let port = portArg ?? Int(ProcessInfo.processInfo.environment["CCDECK_PORT"] ?? "") ?? 7788
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let controller = Controller(port: port)
app.delegate = controller
app.run()
