import pty from 'node-pty';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import xtermHeadless from '@xterm/headless';
import xtermSerialize from '@xterm/addon-serialize';
// どちらも CommonJS。named import は使えないので分解する。
const { Terminal } = xtermHeadless;
const { SerializeAddon } = xtermSerialize;

// ccdeck 自体を claude セッション内から起動すると、これらが子へ継承されて
// 「Transcript saving is off」になったり親子関係が壊れる。起動時に必ず落とす。
const POISON_ENV = [
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_EXECPATH',
];

// Claude Code は待機中もステータスラインを更新し続けるので「出力がある＝実行中」は成立しない。
// 出力は再評価のトリガーにだけ使い、状態は必ず画面の中身から判定する。
const EVAL_MS = 250;          // 画面を再分類する最小間隔
const REPLAY_LIMIT = 512 * 1024; // 再接続時に再生する生出力の上限

// 画面テキストから状態を推定する。ANSI を正規表現で殴るのは脆いので、
// headless な xterm に食わせて「実際に描画された画面」で判定する。
const PATTERNS = {
  running: /esc to interrupt|ctrl\+c to (?:stop|cancel)/i,
  attention: /Do you want|Would you like|Choose an option|❯\s*1\.|\b1\.\s*Yes\b|Press Enter to continue/i,
};

function classify(screen) {
  if (PATTERNS.running.test(screen)) return 'running';
  if (PATTERNS.attention.test(screen)) return 'attention';
  return 'idle';
}

export class Session extends EventEmitter {
  constructor({ cwd, title, cols = 120, rows = 34, command }) {
    super();
    this.id = randomUUID().slice(0, 8);
    this.cwd = cwd;
    this.title = title || path.basename(cwd);
    this.command = command || 'claude';
    this.cols = cols;
    this.rows = rows;
    this.status = 'starting';
    this.unread = false;
    this.bell = false;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.exitCode = null;
    this.replay = [];
    this.replayBytes = 0;
    this._evalTimer = null;
    this._serializer = null;   // snapshot() を初めて呼ばれたときに作る

    // 状態判定専用の仮想画面。描画はせず判定にだけ使う。
    this.screen = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });

    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    for (const key of POISON_ENV) delete env[key];

    this.pty = pty.spawn(process.env.SHELL || '/bin/zsh', ['-lc', this.command], {
      name: 'xterm-256color', cols, rows, cwd, env,
    });

    this.pty.onData((data) => this._onData(data));
    this.pty.onExit(({ exitCode }) => {
      this.exitCode = exitCode;
      this._setStatus('exited');
      this.emit('exit', exitCode);
    });
  }

  _onData(data) {
    this.lastActivity = Date.now();
    this.screen.write(data);

    this.replay.push(data);
    this.replayBytes += data.length;
    while (this.replayBytes > REPLAY_LIMIT && this.replay.length > 1) {
      this.replayBytes -= this.replay.shift().length;
    }

    if (data.includes('\x07')) {
      this.bell = true;
      this.emit('meta');
    }

    this._scheduleEval();
    this.emit('data', data);
  }

  _scheduleEval() {
    if (this._evalTimer) return;
    this._evalTimer = setTimeout(() => {
      this._evalTimer = null;
    this._serializer = null;   // snapshot() を初めて呼ばれたときに作る
      this._evaluate();
    }, EVAL_MS);
  }

  _evaluate() {
    if (this.exitCode !== null) return;
    const buf = this.screen.buffer.active;
    const lines = [];
    for (let i = 0; i < this.screen.rows; i++) {
      const line = buf.getLine(buf.viewportY + i);
      if (line) lines.push(line.translateToString(true));
    }
    this._setStatus(classify(lines.join('\n')));
  }

  _setStatus(next) {
    if (this.status === next) return;
    const prev = this.status;
    this.status = next;
    // 「自分の番が回ってきた」瞬間だけを未読にする。
    // 承認待ちは常に自分の番。実行中だったものが止まったのも自分の番。
    const actionable = next === 'attention' || (prev === 'running' && next === 'idle');
    if (prev !== 'starting' && actionable) this.unread = true;
    this.emit('status', next, prev);
  }

  write(input) {
    this.pty.write(input);
    // 自分で打った直後は当然未読ではない
    this.unread = false;
    this.bell = false;
  }

  resize(cols, rows) {
    if (!cols || !rows || this.exitCode !== null) return;
    this.cols = cols; this.rows = rows;
    try {
      this.pty.resize(cols, rows);
      this.screen.resize(cols, rows);
    } catch { /* プロセス終了直後は無視 */ }
  }

  markRead() {
    this.unread = false;
    this.bell = false;
    this.emit('meta');
  }

  getReplay() {
    return this.replay.join('');
  }

  // いま見えている画面だけを ANSI に直して返す。
  // 判定用の headless xterm は scrollback: 0 なので、出るのはちょうど 1 画面。
  // 512KB の replay を毎回流せない相手（スマホの復帰など）はこちらを使う。
  snapshot() {
    if (!this._serializer) {
      this._serializer = new SerializeAddon();
      this.screen.loadAddon(this._serializer);
    }
    try {
      return this._serializer.serialize();
    } catch {
      return '';
    }
  }

  kill() {
    try { this.pty.kill(); } catch { /* すでに終了 */ }
  }

  toJSON() {
    return {
      id: this.id, title: this.title, cwd: this.cwd, command: this.command,
      status: this.status, unread: this.unread, bell: this.bell,
      cols: this.cols, rows: this.rows,
      exitCode: this.exitCode, createdAt: this.createdAt, lastActivity: this.lastActivity,
    };
  }
}

export class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
  }

  create(opts) {
    const session = new Session(opts);
    this.sessions.set(session.id, session);
    const bump = () => this.emit('sessions');
    session.on('status', bump);
    session.on('meta', bump);
    session.on('exit', bump);
    this.emit('sessions');
    return session;
  }

  get(id) { return this.sessions.get(id); }

  list() {
    return [...this.sessions.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((s) => s.toJSON());
  }

  remove(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.kill();
    this.sessions.delete(id);
    this.emit('sessions');
    return true;
  }

  killAll() {
    for (const session of this.sessions.values()) session.kill();
  }
}
