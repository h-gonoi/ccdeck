import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const MAX_READ = 1024 * 1024;
const MAX_HANDOFF = 48_000;
const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

const claudeRoot = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const codexRoot = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');

function readTail(file, maxBytes = MAX_READ) {
  const stat = fs.statSync(file);
  const size = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(size);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, size, stat.size - size);
  } finally {
    fs.closeSync(fd);
  }
  let text = buffer.toString('utf8');
  if (stat.size > size) text = text.slice(text.indexOf('\n') + 1);
  return text;
}

function readFirstLine(file, maxBytes = 64 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const size = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, size).toString('utf8').split('\n', 1)[0];
  } finally {
    fs.closeSync(fd);
  }
}

function jsonLines(file) {
  return readTail(file).split('\n').flatMap((line) => {
    try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
  });
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (typeof block === 'string') return block;
    if (!block || typeof block !== 'object') return '';
    if (typeof block.text === 'string') return block.text;
    if (block.type === 'tool_use') {
      return `[tool: ${block.name ?? 'unknown'}]\n${JSON.stringify(block.input ?? {})}`;
    }
    if (block.type === 'tool_result') return contentText(block.content);
    return '';
  }).filter(Boolean).join('\n');
}

function trimHandoff(parts) {
  return parts.filter(Boolean).join('\n\n').slice(-MAX_HANDOFF);
}

function parseClaude(file) {
  const parts = [];
  for (const entry of jsonLines(file)) {
    if (!['user', 'assistant'].includes(entry.type)) continue;
    const role = entry.message?.role || entry.type;
    const text = contentText(entry.message?.content);
    if (text) parts.push(`${role.toUpperCase()}:\n${text}`);
  }
  return trimHandoff(parts);
}

function parseCodex(file) {
  const parts = [];
  for (const entry of jsonLines(file)) {
    if (entry.type === 'turn_context' && typeof entry.payload?.summary === 'string') {
      parts.push(`SESSION SUMMARY:\n${entry.payload.summary}`);
      continue;
    }
    if (entry.type !== 'response_item') continue;
    const item = entry.payload;
    if (item?.type === 'message' && ['user', 'assistant'].includes(item.role)) {
      const text = contentText(item.content);
      if (text) parts.push(`${item.role.toUpperCase()}:\n${text}`);
    } else if (item?.type === 'function_call') {
      parts.push(`[tool: ${item.name ?? 'unknown'}]\n${item.arguments ?? ''}`);
    } else if (item?.type === 'function_call_output') {
      const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
      if (output) parts.push(`TOOL RESULT:\n${output}`);
    }
  }
  return trimHandoff(parts);
}

/**
 * ps を 1 回だけ叩いて親子表を作る。
 * 何本ものセッションをまとめて調べるときは、これを使い回して ps の連打を避ける。
 */
export function procChildren() {
  const children = new Map();
  let rows;
  try {
    rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
  } catch {
    return children;
  }
  for (const line of rows.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || !ppid) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  return children;
}

function descendants(rootPid, children = procChildren()) {
  const found = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    for (const pid of children.get(queue.shift()) ?? []) {
      if (!found.has(pid)) { found.add(pid); queue.push(pid); }
    }
  }
  return found;
}

// 名前が条件に合う最初のファイルを返す。深さは切る（プロジェクト置き場は広い）。
function findFile(root, match, depth = 0) {
  if (depth > 4) return null;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && match(entry.name)) return full;
    if (entry.isDirectory()) {
      const found = findFile(full, match, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// Claude Code は cwd を英数字以外ハイフンに潰した名前で会話を置く
const claudeProjectDir = (cwd) => path.join(claudeRoot(), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));

// macOS のファイルシステムは大文字小文字を区別しない。ccdeck が /Users/x/projects で
// 立てたセッションを、CLI 側は /Users/x/Projects と書くことがある。
// 文字列で突き合わせると同じ場所を別物と見なして会話 ID を取り逃がすので、inode で見る。
function nodeKey(dir) {
  try {
    const stat = fs.statSync(dir);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

const sameDir = (a, b, keyOfB) => a === b || (Boolean(keyOfB) && nodeKey(a) === keyOfB);

/**
 * いま走っているセッションが書いている会話の ID。
 * Claude Code 自身が ~/.claude/sessions/<PID>.json に書くので、それを PID で突き合わせる。
 * /clear などで途中から変わるため、欲しくなったときに読み直すこと。
 */
function claudeSessionId(session, children) {
  const pid = session.pty?.pid;
  if (!pid) return null;
  const livePids = descendants(pid, children);
  let names;
  try { names = fs.readdirSync(path.join(claudeRoot(), 'sessions')); } catch { return null; }
  const want = nodeKey(session.cwd);
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(claudeRoot(), 'sessions', name), 'utf8'));
      if (!livePids.has(info.pid) || !info.sessionId) continue;
      if (sameDir(info.cwd, session.cwd, want)) return info.sessionId;
    } catch { /* 書き込み途中や消滅直後は次を見る */ }
  }
  return null;
}

function claudeTranscript(session, children) {
  const id = claudeSessionId(session, children);
  if (!id) return null;
  const expected = path.join(claudeProjectDir(session.cwd), `${id}.jsonl`);
  if (fs.existsSync(expected)) return expected;
  return findFile(path.join(claudeRoot(), 'projects'), (name) => name === `${id}.jsonl`);
}

function nearbyDays(at) {
  const days = [];
  for (const offset of [-1, 0, 1]) {
    const date = new Date(at + offset * 86400_000);
    days.push([
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ]);
  }
  return days;
}

// Codex は状態ファイルを持たないので、cwd と開始時刻がいちばん近い記録を選ぶ。
function codexTranscript(session) {
  const candidates = [];
  const want = nodeKey(session.cwd);
  for (const parts of nearbyDays(session.createdAt)) {
    const dir = path.join(codexRoot(), ...parts);
    let names;
    try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')); } catch { continue; }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const first = readFirstLine(file);
        const meta = JSON.parse(first);
        if (meta.type !== 'session_meta') continue;
        if (!sameDir(meta.payload?.cwd, session.cwd, want)) continue;
        const stat = fs.statSync(file);
        const started = Date.parse(meta.payload?.timestamp || meta.timestamp) || stat.birthtimeMs;
        if (started >= session.createdAt - 5000) {
          candidates.push({ file, distance: Math.abs(started - session.createdAt) });
        }
      } catch { /* 壊れた候補は無視 */ }
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0]?.file ?? null;
}

// rollout-2026-08-26T23-32-37-<uuid>.jsonl の末尾が resume に使う ID
function codexSessionId(session) {
  const file = codexTranscript(session);
  if (!file) return null;
  return UUID.exec(path.basename(file, '.jsonl'))?.[1] ?? null;
}

/**
 * 走っているセッションを、次の起動で resume するための ID。
 * 取れないこともある（起動直後や、記録を切っている場合）。そのときは null。
 */
export function vendorSessionId(session, children) {
  try {
    return session.agent === 'claude'
      ? claudeSessionId(session, children)
      : codexSessionId(session);
  } catch {
    return null;
  }
}

/**
 * その ID がまだ resume できるか。
 * 消えた会話を --resume に渡すと CLI が即座に落ちるので、渡す前にここで確かめる。
 * createdAt は Codex の日付ディレクトリを絞るためのヒント（無ければ今日の前後を見る）。
 */
export function resumeAvailable(agent, cwd, id, createdAt = Date.now()) {
  if (!id || !cwd) return false;
  try {
    if (agent === 'claude') {
      if (fs.existsSync(path.join(claudeProjectDir(cwd), `${id}.jsonl`))) return true;
      return Boolean(findFile(path.join(claudeRoot(), 'projects'), (name) => name === `${id}.jsonl`));
    }
    for (const parts of nearbyDays(createdAt)) {
      const dir = path.join(codexRoot(), ...parts);
      let names;
      try { names = fs.readdirSync(dir); } catch { continue; }
      if (names.some((name) => name.endsWith(`${id}.jsonl`))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function transcriptFor(session) {
  try {
    const file = session.agent === 'claude'
      ? claudeTranscript(session)
      : codexTranscript(session);
    if (!file) return '';
    return session.agent === 'claude' ? parseClaude(file) : parseCodex(file);
  } catch {
    return '';
  }
}

/* 会話を「発言の並び」として返す。ターミナルの生画面ではなく、
   スマホで読める形に組み替えるために使う。
   ツールの実行は名前だけ拾って畳む（中身は長すぎて読めない）。 */
function turnsClaude(file, limit) {
  const turns = [];
  for (const entry of jsonLines(file)) {
    if (!['user', 'assistant'].includes(entry.type)) continue;
    const role = entry.message?.role || entry.type;
    const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
    const tools = blocks.filter((b) => b?.type === 'tool_use').map((b) => b.name).filter(Boolean);
    const text = blocks
      .filter((b) => typeof b?.text === 'string')
      .map((b) => b.text).join('\n').trim()
      || (typeof entry.message?.content === 'string' ? entry.message.content.trim() : '');
    // ツール結果だけの user 発言は、こちらの発言ではないので出さない
    const onlyResult = role === 'user' && !text && blocks.some((b) => b?.type === 'tool_result');
    if (onlyResult) continue;
    if (!text && !tools.length) continue;
    turns.push({ role, text, tools });
  }
  return turns.slice(-limit);
}

function turnsCodex(file, limit) {
  const turns = [];
  for (const entry of jsonLines(file)) {
    if (entry.type !== 'response_item') continue;
    const item = entry.payload;
    if (item?.type === 'message' && ['user', 'assistant'].includes(item.role)) {
      const text = contentText(item.content).trim();
      if (text) turns.push({ role: item.role, text, tools: [] });
    } else if (item?.type === 'function_call' && item.name) {
      const last = turns[turns.length - 1];
      if (last && last.role === 'assistant') last.tools.push(item.name);
      else turns.push({ role: 'assistant', text: '', tools: [item.name] });
    }
  }
  return turns.slice(-limit);
}

export function conversationFor(session, limit = 24) {
  try {
    const file = session.agent === 'claude' ? claudeTranscript(session) : codexTranscript(session);
    if (!file) return [];
    return session.agent === 'claude' ? turnsClaude(file, limit) : turnsCodex(file, limit);
  } catch {
    return [];
  }
}
