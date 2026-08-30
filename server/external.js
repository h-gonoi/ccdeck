import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SESSION_DIR = path.join(os.homedir(), '.claude', 'sessions');

// Claude Code 自身が書き出す状態を、そのまま ccdeck の言葉に置き換える。
// 画面を解析するより正確で、ターミナルから起動されたセッションにも効く。
const STATUS_MAP = { busy: 'running', waiting: 'attention', idle: 'idle' };

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ps を1回だけ叩いて 親子関係と tty をまとめて引く
async function procTable() {
  const parent = new Map();
  const ttys = new Map();
  try {
    const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,ppid=,tty=']);
    for (const line of stdout.split('\n')) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 2) continue;
      const pid = Number(cols[0]);
      parent.set(pid, Number(cols[1]));
      if (cols[2] && cols[2] !== '??') ttys.set(pid, `/dev/${cols[2]}`);
    }
  } catch { /* ps が使えなければ親子判定を諦める */ }
  return { parent, ttys };
}

function descendsFrom(pid, roots, parent) {
  let cur = pid;
  for (let i = 0; i < 16 && cur > 1; i++) {
    if (roots.has(cur)) return true;
    cur = parent.get(cur) ?? 0;
  }
  return false;
}

/**
 * ccdeck が抱えていない claude セッションを返す。
 * ownPids には ccdeck が spawn したシェルの PID を渡す（claude はその子なので辿って除外する）。
 */
export async function listExternal(ownPids = new Set()) {
  let files;
  try { files = await fs.readdir(SESSION_DIR); } catch { return []; }

  const { parent, ttys } = await procTable();
  const sessions = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    let data;
    try {
      data = JSON.parse(await fs.readFile(path.join(SESSION_DIR, file), 'utf8'));
    } catch { continue; }

    if (data.kind !== 'interactive') continue;      // cloud や Remote Control は対象外
    if (!data.pid || !alive(data.pid)) continue;    // 終了済みの残骸を除く
    if (descendsFrom(data.pid, ownPids, parent)) continue;

    sessions.push({
      pid: data.pid,
      title: data.name || path.basename(data.cwd || ''),
      cwd: data.cwd,
      status: STATUS_MAP[data.status] ?? 'idle',
      waitingFor: data.waitingFor ?? null,
      version: data.version,
      createdAt: data.startedAt,
      lastActivity: data.statusUpdatedAt || data.updatedAt || data.startedAt,
      tty: ttys.get(data.pid) ?? null,
      external: true,
    });
  }

  return sessions.sort((a, b) => a.createdAt - b.createdAt);
}

// 外部セッションには入力を送れない（PTY を持っているのは向こうのターミナル）。
// 代わりに、その tty を抱えているウィンドウを前面に出して、すぐ打てる状態にする。
const FOCUS_SCRIPTS = {
  Terminal: (tty) => `
    tell application "Terminal"
      repeat with w in windows
        repeat with t in tabs of w
          try
            if (tty of t) is "${tty}" then
              set selected tab of w to t
              set index of w to 1
              activate
              return "ok"
            end if
          end try
        end repeat
      end repeat
    end tell
    return "none"`,
  iTerm: (tty) => `
    tell application "iTerm"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            try
              if (tty of s) is "${tty}" then
                select w
                select t
                select s
                activate
                return "ok"
              end if
            end try
          end repeat
        end repeat
      end tell
    return "none"`,
};

export async function focusTty(tty) {
  if (!tty) throw new Error('このセッションのターミナルが特定できません');
  for (const [app, build] of Object.entries(FOCUS_SCRIPTS)) {
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', build(tty)], { timeout: 8000 });
      if (stdout.trim() === 'ok') return { app };
    } catch { /* そのアプリが無い・権限が無い場合は次を試す */ }
  }
  throw new Error('Terminal / iTerm に見つかりません（Cursor などの内蔵ターミナルは前面化できません）');
}
