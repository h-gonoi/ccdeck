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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CCDECK_PORT) || 7788;

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

// ---- プロジェクト ----
app.get('/api/projects', wrap(async (req, res) => res.json(await scan())));
app.get('/api/config', wrap(async (req, res) => res.json(await loadConfig())));
app.post('/api/config', wrap(async (req, res) => res.json(await saveConfig(req.body))));

// ---- セッション ----
app.get('/api/sessions', (req, res) => res.json(manager.list()));

app.post('/api/sessions', wrap(async (req, res) => {
  const { cwd, title, command, cols, rows } = req.body;
  if (!cwd) throw new Error('cwd は必須です');
  const session = manager.create({ cwd, title, command, cols, rows });
  // 「最近使った」の記録に失敗しても、セッションそのものは通す
  touchRecent(cwd).catch(() => {});
  res.json(session.toJSON());
}));

app.delete('/api/sessions/:id', (req, res) => {
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
const wss = new WebSocketServer({ server, path: '/ws' });

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
      case 'input': session?.write(msg.data); break;
      case 'resize': session?.resize(msg.cols, msg.rows); break;
      case 'read': session?.markRead(); break;
    }
  });

  ws.on('close', () => { for (const id of [...attached]) detach(id); });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ccdeck → http://127.0.0.1:${PORT}`);
});

const shutdown = () => { manager.killAll(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
