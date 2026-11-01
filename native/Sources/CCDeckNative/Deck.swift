import Foundation

typealias JSON = [String: Any]

// サーバーが返すセッション。画面で使うものだけ拾う。
struct Session: Decodable, Equatable {
    let id: String
    let title: String?
    let cwd: String
    let agent: String?
    let status: String
    let unread: Bool?
    let cols: Int?
    let rows: Int?
    let model: String?
    let vendorId: String?
    let lastActivity: Double?

    var name: String { title ?? id }
    var agentKey: String { agent ?? "claude" }
}

struct Project: Decodable {
    let path: String
    let name: String
    let branch: String?
    var pinned: Bool?
    var lastUsed: Double?
    let changes: Int?
}

/// ccdeck 以外で立てられた Claude Code（server/external.js）
struct External: Decodable {
    let pid: Int
    let title: String
    let cwd: String?
    let status: String
    let waitingFor: String?
    let tty: String?
}

struct PastRow: Decodable {
    let id: String
    let name: String
    let cwd: String
    let preview: String?
    let at: Double?
}

struct GitFile: Decodable {
    let path: String
    let index: String
    let work: String
    let staged: Bool
    let untracked: Bool
}

struct GitStatus: Decodable {
    let branch: String
    let ahead: Int?
    let behind: Int?
    let files: [GitFile]
}

struct Device: Decodable {
    let id: String
    let name: String
    let platform: String?
    let createdAt: Double?
    let lastSeen: Double?
}

struct PairCode: Decodable {
    let code: String?
    let expiresAt: Double?
}

struct Health: Decodable {
    let lan: Bool?
    let address: String?
    let port: Int?
}

struct DeckError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

protocol DeckDelegate: AnyObject {
    func deckHello(_ msg: JSON)
    func deckSessions(_ sessions: [Session])
    func deckExternal(_ sessions: [External])
    func deckButler(_ state: JSON?)
    func deckReplay(id: String, data: String)
    func deckOutput(id: String, data: String)
    func deckSizeOwner(id: String, mine: Bool, cols: Int, rows: Int)
}

/// ccdeck サーバーとのつながり。ブラウザ版の main.js の WebSocket と api.js にあたる。
/// PTY も状態判定もサーバーが持つので、こちらは描いて打鍵を返すだけ。
final class Deck {
    let base: URL
    weak var delegate: DeckDelegate?

    private let http = URLSession(configuration: .ephemeral)
    private var socket: URLSessionWebSocketTask?
    private var generation = 0
    private var pinger: Timer?

    init(port: Int) {
        base = URL(string: "http://127.0.0.1:\(port)")!
    }

    // ---------- WebSocket ----------

    func connect() {
        generation += 1
        let mine = generation
        socket?.cancel(with: .goingAway, reason: nil)
        var ws = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        ws.scheme = "ws"
        ws.path = "/ws"
        let task = http.webSocketTask(with: ws.url!)
        task.maximumMessageSize = 64 * 1024 * 1024   // replay は数百 KB になる
        socket = task
        task.resume()
        receive(task, generation: mine)

        // 繋がったつもりのまま黙る状態を断ち切る
        pinger?.invalidate()
        pinger = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
            task.sendPing { error in
                if error != nil { DispatchQueue.main.async { self?.reconnect(from: mine) } }
            }
        }
    }

    private func reconnect(from gen: Int) {
        guard gen == generation else { return }   // 二重に繋ぎ直さない
        generation += 1
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        // サーバーの入れ替えに自力で追従する
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in self?.connect() }
    }

    private func receive(_ task: URLSessionWebSocketTask, generation gen: Int) {
        task.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self, gen == self.generation else { return }
                switch result {
                case .failure:
                    self.reconnect(from: gen)
                case .success(let message):
                    switch message {
                    case .string(let text): self.handle(Data(text.utf8))
                    case .data(let data): self.handle(data)
                    @unknown default: break
                    }
                    self.receive(task, generation: gen)
                }
            }
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, _ value: Any?) -> T? {
        guard let value, JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    private func handle(_ raw: Data) {
        guard let msg = (try? JSONSerialization.jsonObject(with: raw)) as? JSON,
              let type = msg["type"] as? String else { return }
        let id = msg["id"] as? String ?? ""
        switch type {
        case "hello":
            delegate?.deckHello(msg)
        case "sessions":
            if let sessions = decode([Session].self, msg["sessions"]) { delegate?.deckSessions(sessions) }
        case "external":
            if let list = decode([External].self, msg["sessions"]) { delegate?.deckExternal(list) }
        case "butler":
            delegate?.deckButler(msg["state"] as? JSON)
        case "replay", "snapshot":
            delegate?.deckReplay(id: id, data: msg["data"] as? String ?? "")
        case "output":
            delegate?.deckOutput(id: id, data: msg["data"] as? String ?? "")
        case "sizeOwner":
            delegate?.deckSizeOwner(id: id, mine: msg["mine"] as? Bool ?? false,
                                    cols: msg["cols"] as? Int ?? 0, rows: msg["rows"] as? Int ?? 0)
        default:
            break
        }
    }

    func send(_ payload: JSON) {
        guard let socket, let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else { return }
        socket.send(.string(text)) { _ in }
    }

    // ---------- REST ----------

    private func call(_ method: String, _ path: String, query: [String: String] = [:],
                      body: JSON? = nil) async throws -> Data {
        var comps = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = method
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await http.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let json = (try? JSONSerialization.jsonObject(with: data)) as? JSON
            throw DeckError(message: json?["error"] as? String ?? "\(status) \(HTTPURLResponse.localizedString(forStatusCode: status))")
        }
        return data
    }

    private func get<T: Decodable>(_ path: String, _ query: [String: String] = [:]) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await call("GET", path, query: query))
    }

    private func post<T: Decodable>(_ path: String, _ body: JSON = [:]) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await call("POST", path, body: body))
    }

    private func postJSON(_ path: String, _ body: JSON = [:]) async throws -> JSON {
        let data = try await call("POST", path, body: body)
        return (try? JSONSerialization.jsonObject(with: data)) as? JSON ?? [:]
    }

    private struct Output: Decodable { let output: String? }
    private struct DiffBody: Decodable { let diff: String }
    private struct FileBody: Decodable { let content: String }
    private struct Focused: Decodable { let app: String? }

    func health() async throws -> Health { try await get("api/health") }
    func projects() async throws -> [Project] { try await get("api/projects") }
    func past(agent: String) async throws -> [PastRow] { try await get("api/past", ["agent": agent]) }

    // command は送らない（サーバーも受けない）。agent だけ渡して固定コマンドに変えてもらう。
    func createSession(cwd: String, title: String?, agent: String, cols: Int?, rows: Int?,
                       resumeId: String?) async throws -> Session {
        var body: JSON = ["cwd": cwd, "agent": agent]
        if let title { body["title"] = title }
        if let cols, let rows { body["cols"] = cols; body["rows"] = rows }
        if let resumeId { body["resumeId"] = resumeId }
        return try await post("api/sessions", body)
    }

    func handoff(_ id: String, agent: String) async throws -> Session {
        try await post("api/sessions/\(id)/handoff", ["agent": agent])
    }

    func killSession(_ id: String) async throws { _ = try await call("DELETE", "api/sessions/\(id)") }

    func gitStatus(_ cwd: String) async throws -> GitStatus { try await get("api/git/status", ["cwd": cwd]) }
    func gitDiff(_ cwd: String, file: String, staged: Bool) async throws -> String {
        let body: DiffBody = try await get("api/git/diff", ["cwd": cwd, "file": file, "staged": staged ? "1" : "0"])
        return body.diff
    }
    func gitStage(_ cwd: String, files: [String]) async throws { _ = try await postJSON("api/git/stage", ["cwd": cwd, "files": files]) }
    func gitCommit(_ cwd: String, message: String) async throws -> String {
        let out: Output = try await post("api/git/commit", ["cwd": cwd, "message": message])
        return out.output ?? ""
    }
    func gitPush(_ cwd: String) async throws -> String {
        let out: Output = try await post("api/git/push", ["cwd": cwd])
        return out.output ?? ""
    }

    func readFile(_ cwd: String, path: String) async throws -> String {
        let body: FileBody = try await get("api/files/read", ["cwd": cwd, "path": path])
        return body.content
    }
    func writeFile(_ cwd: String, path: String, content: String) async throws {
        _ = try await postJSON("api/files/write", ["cwd": cwd, "path": path, "content": content])
    }

    func focusExternal(tty: String?) async throws -> String {
        let body: Focused = try await post("api/external/focus", ["tty": tty ?? NSNull()])
        return body.app ?? "ターミナル"
    }

    func pairCode() async throws -> PairCode { try await get("api/pair/code") }
    func makePairCode() async throws -> PairCode { try await post("api/pair/code") }
    func cancelPairCode() async throws { _ = try await call("DELETE", "api/pair/code") }
    func devices() async throws -> [Device] { try await get("api/devices") }
    func revokeDevice(_ id: String) async throws { _ = try await call("DELETE", "api/devices/\(id)") }

    func butlerAssess(cwds: [String], agent: String) async throws { _ = try await postJSON("api/butler/assess", ["cwds": cwds, "agent": agent]) }
    func butlerApprove(planId: Any, picks: [String: [Int]]) async throws { _ = try await postJSON("api/butler/approve", ["planId": planId, "picks": picks]) }
    func butlerCancel() async throws { _ = try await postJSON("api/butler/cancel") }
    func butlerDismiss() async throws { _ = try await postJSON("api/butler/dismiss") }
    func butlerStep(planId: Any, cwd: String, index: Int, instruction: String) async throws {
        _ = try await postJSON("api/butler/step", ["planId": planId, "cwd": cwd, "index": index, "instruction": instruction])
    }
    func butlerConfig(agent: String) async throws { _ = try await postJSON("api/butler/config", ["agent": agent]) }
}
