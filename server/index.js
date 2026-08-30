import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { SessionManager } from './sessions.js';
import * as git from './git.js';
import * as files from './files.js';
import { scan, loadConfig, saveConfig, touchRecent } from './projects.js';
import { listExternal, focusTty } from './external.js';
import * as auth from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CCDECK_PORT) || 7788;

// LAN に出すのは明示したときだけ。既定は今まで通りループバックに閉じる。
const LAN = process.argv.includes('--lan') || process.env.CCDECK_LAN === '1';
const HOST = LAN ? '0.0.0.0' : '127.0.0.1';
const VERSION = JSON.parse(
  fsSync.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
).version;

const app = express();
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, '..', 'dist')));

const manager = new SessionManager();

// サーバーを入れ替えたら、開きっぱなしの画面が古いままにならないよう合図する
const BUILD_ID = String(Date.now());

const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    res.status(400).json({ error: err.message || String(err) });
  });
};

// ---- 認証 ----
// ループバックは素通し、それ以外は端末トークン。health と pair だけ開けておく
// （アプリがペアリング前に「繋がるか・版が合うか」を確かめられるように）。
const OPEN = new Set(['/health', '/pair']);

app.use('/api', (req, res, next) => {
  if (OPEN.has(req.path)) return next();
  const who = auth.identify(req);
  if (!who) return res.status(401).json({ error: 'この端末は登録されていません' });
  req.who = who;
  next();
});

// 端末の出し入れは、この Mac の前に座っている人だけができる
const localOnly = (req, res, next) => {
  if (req.who?.local) return next();
  res.status(403).json({ error: 'この操作は Mac 側の画面からのみ行えます' });
};

app.get('/api/health', (req, res) => res.json({
  name: 'ccdeck',
  version: VERSION,
  buildId: BUILD_ID,
  hostname: os.hostname(),
  lan: LAN,
  address: LAN ? auth.lanAddress() : '127.0.0.1',
  port: PORT,
  capabilities: ['sessions', 'external', 'git', 'files', 'pair'],
}));

// ---- 端末 ----
app.post('/api/pair', wrap(async (req, res) => {
  const { device, token } = await auth.consumePairingCode(req.body?.code, req.body);
  auth.audit(device, 'paired', device.platform);
  res.json({ device, token });
}));

app.get('/api/pair/code', localOnly, (req, res) => res.json(auth.pairingCode() ?? {}));
app.post('/api/pair/code', localOnly, (req, res) => res.json(auth.createPairingCode()));
app.delete('/api/pair/code', localOnly, (req, res) => { auth.cancelPairing(); res.json({ ok: true }); });

app.get('/api/devices', localOnly, (req, res) => res.json(auth.listDevices()));
app.delete('/api/devices/:id', localOnly, wrap(async (req, res) => {
  res.json({ ok: await auth.revokeDevice(req.params.id) });
}));

app.post('/api/push/register', wrap(async (req, res) => {
  if (req.who.local) throw new Error('端末から登録してください');
  res.json({ ok: await auth.setPushToken(req.who.id, req.body?.pushToken) });
}));

// ---- プロジェクト ----
app.get('/api/projects', wrap(async (req, res) => res.json(await scan())));
app.get('/api/config', wrap(async (req, res) => res.json(await loadConfig())));
app.post('/api/config', wrap(async (req, res) => res.json(await saveConfig(req.body))));

// ---- セッション ----
app.get('/api/sessions', (req, res) => res.json(manager.list()));

app.post('/api/sessions', wrap(async (req, res) => {
  const { cwd, title, command, cols, rows } = req.body;
  if (!cwd) throw new Error('cwd は必須です');
  // LAN からの command は受けない。ここを緩めると LAN 越しの任意コマンド実行になる。
  const session = manager.create({
    cwd, title, cols, rows, command: req.who.local ? command : undefined,
  });
  auth.audit(req.who, 'session.create', cwd);
  // 「最近使った」の記録に失敗しても、セッションそのものは通す
  touchRecent(cwd).catch(() => {});
  res.json(session.toJSON());
}));

app.delete('/api/sessions/:id', (req, res) => {
  auth.audit(req.who, 'session.kill', manager.get(req.params.id)?.cwd ?? req.params.id);
  res.json({ ok: manager.remove(req.params.id) });
});

app.post('/api/sessions/:id/read', (req, res) => {
  manager.get(req.params.id)?.markRead();
  res.json({ ok: true });
});

// ---- 他で動いているセッション ----
// ccdeck が spawn したシェルの PID。この子孫は「外部」から除く。
const ownPids = () => new Set(
  [...manager.sessions.values()].map((s) => s.pty?.pid).filter(Boolean)
);

app.get('/api/external', wrap(async (req, res) => res.json(await listExternal(ownPids()))));

app.post('/api/external/focus', wrap(async (req, res) => res.json(await focusTty(req.body.tty))));

// ---- git ----
const repoOf = (req) => {
  const cwd = req.query.cwd || req.body?.cwd;
  if (!cwd) throw new Error('cwd は必須です');
  return cwd;
};

app.get('/api/git/status', wrap(async (req, res) => {
  const cwd = repoOf(req);
  const [meta, changed] = await Promise.all([git.info(cwd), git.status(cwd)]);
  res.json({ ...meta, files: changed });
}));

app.get('/api/git/diff', wrap(async (req, res) => {
  const cwd = repoOf(req);
  res.json({ diff: await git.diff(cwd, req.query.file, { staged: req.query.staged === '1' }) });
}));

app.get('/api/git/log', wrap(async (req, res) => res.json(await git.log(repoOf(req)))));

app.post('/api/git/stage', wrap(async (req, res) => {
  await git.stage(req.body.cwd, req.body.files); res.json({ ok: true });
}));
app.post('/api/git/unstage', wrap(async (req, res) => {
  await git.unstage(req.body.cwd, req.body.files); res.json({ ok: true });
}));
app.post('/api/git/commit', wrap(async (req, res) => {
  if (!req.body.message?.trim()) throw new Error('コミットメッセージが空です');
  res.json({ output: await git.commit(req.body.cwd, req.body.message) });
}));
app.post('/api/git/push', wrap(async (req, res) => {
  res.json({ output: await git.push(req.body.cwd) });
}));

// ---- ファイル ----
app.get('/api/files/list', wrap(async (req, res) => {
  res.json(await files.listDir(req.query.cwd, req.query.path || '.'));
}));
app.get('/api/files/read', wrap(async (req, res) => {
  res.json(await files.readFile(req.query.cwd, req.query.path));
}));
app.post('/api/files/write', wrap(async (req, res) => {
  res.json(await files.writeFile(req.body.cwd, req.body.path, req.body.content));
}));

// ---- WebSocket ----
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// upgrade を自分で受けて、通す前に相手を確かめる。
// verifyClient に頼らないのは、断るときに 401 を返したいため。
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
  const who = auth.identify(req);
  if (!who) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.who = who;
    wss.emit('connection', ws, req);
  });
});

const broadcast = (payload) => {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
};

manager.on('sessions', () => broadcast({ type: 'sessions', sessions: manager.list() }));

// 外部セッションは Claude Code が書く状態ファイルを見張る。
// 変化がなければ何も流さないので、開きっぱなしでも負荷にならない。
let lastExternal = '';
let externalTimer = null;

async function pushExternal(force = false) {
  let list;
  try { list = await listExternal(ownPids()); } catch { return; }
  const json = JSON.stringify(list);
  if (!force && json === lastExternal) return;
  lastExternal = json;
  broadcast({ type: 'external', sessions: list });
}

const scheduleExternal = () => {
  clearTimeout(externalTimer);
  externalTimer = setTimeout(() => pushExternal(), 250);
};

try {
  fsSync.watch(path.join(os.homedir(), '.claude', 'sessions'), scheduleExternal);
} catch { /* ディレクトリが無い環境では諦める */ }
setInterval(() => pushExternal(), 3000);    // watch の取りこぼし対策

wss.on('connection', (ws) => {
  // このクライアントが画面に出しているセッション。出力はここに限って流す。
  const attached = new Set();
  const pumps = new Map();
  const typed = new Set();   // このつながりで入力を始めたセッション（記録の重複よけ）

  const send = (payload) => { if (ws.readyState === 1) ws.send(JSON.stringify(payload)); };
  send({ type: 'hello', buildId: BUILD_ID });
  send({ type: 'sessions', sessions: manager.list() });
  listExternal(ownPids()).then((list) => send({ type: 'external', sessions: list })).catch(() => {});

  const detach = (id) => {
    const session = manager.get(id);
    const pump = pumps.get(id);
    if (session && pump) session.off('data', pump);
    pumps.delete(id);
    attached.delete(id);
  };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const session = msg.id ? manager.get(msg.id) : null;

    switch (msg.type) {
      case 'attach': {
        if (!session || attached.has(msg.id)) return;
        attached.add(msg.id);
        send({ type: 'replay', id: msg.id, data: session.getReplay() });
        const pump = (data) => send({ type: 'output', id: msg.id, data });
        pumps.set(msg.id, pump);
        session.on('data', pump);
        session.markRead();
        break;
      }
      case 'detach': detach(msg.id); break;
      case 'input': {
        if (!session) break;
        // 打鍵の中身は残さない（パスワードが混ざる）。触り始めたことだけ一度書く。
        if (!typed.has(msg.id)) { typed.add(msg.id); auth.audit(ws.who, 'input', session.cwd); }
        session.write(msg.data);
        break;
      }
      case 'resize': session?.resize(msg.cols, msg.rows); break;
      case 'read': session?.markRead(); break;
    }
  });

  ws.on('close', () => { for (const id of [...attached]) detach(id); });
});

// 台帳を読み終える前に受け付けると、登録済みの端末を弾いてしまう
await auth.ready;

server.listen(PORT, HOST, () => {
  if (!LAN) {
    console.log(`ccdeck → http://127.0.0.1:${PORT}`);
    return;
  }
  const address = auth.lanAddress() ?? '（アドレス不明）';
  console.log(`ccdeck → http://${address}:${PORT}  (LAN に出しています)`);
  console.log('  ⚠ 同じ Wi-Fi にいる誰でもここに到達できます。');
  console.log('    繋げるのは登録した端末だけです。登録は Mac の画面から行ってください。');
  console.log(`  記録: ${auth.AUDIT_PATH}`);
});

const shutdown = () => { manager.killAll(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
