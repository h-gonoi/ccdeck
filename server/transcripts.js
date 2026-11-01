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

// 会話 ID から記録の場所を引く。ID が判っていれば ps は要らない。
function claudeFileById(cwd, id) {
  if (!id) return null;
  const expected = path.join(claudeProjectDir(cwd), `${id}.jsonl`);
  if (fs.existsSync(expected)) return expected;
  return findFile(path.join(claudeRoot(), 'projects'), (name) => name === `${id}.jsonl`);
}

function claudeTranscript(session, children) {
  return claudeFileById(session.cwd, claudeSessionId(session, children));
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
  // resume で続けている会話は、始めた日の記録に書き足される（ID は変わらない）。
  // 開始時刻で探すと、後から同じ場所で立てた別の会話を拾ってしまうので、判っている ID を使う。
  if (session.resumeId) return session.resumeId;
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
 */
export function resumeAvailable(agent, cwd, id) {
  if (!id || !cwd) return false;
  try {
    if (agent === 'claude') {
      if (fs.existsSync(path.join(claudeProjectDir(cwd), `${id}.jsonl`))) return true;
      return Boolean(findFile(path.join(claudeRoot(), 'projects'), (name) => name === `${id}.jsonl`));
    }
    // Codex は日付ごとのディレクトリに置くが、その日付は会話を始めた日であって
    // 復元した日ではない。何日目かを推測すると外すので、ID で素直に探す
    // （実測 3736 件・10ms。起動時に数本ぶん呼ぶだけなので割に合う）。
    return Boolean(findFile(codexRoot(), (name) => name.endsWith(`${id}.jsonl`)));
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
/* ツールは名前だけでなく短い中身も添える。スマホでは「Bash」とだけ出ても
   何をしたのか判らない。Bash は説明文（無ければコマンド）、ファイル系はファイル名、
   質問はその文面。長いものは切る。 */
const TOOL_DETAIL_MAX = 72;
function toolLabel(block) {
  const name = block.name || 'tool';
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  const str = (v) => (typeof v === 'string' ? v : '');
  let detail = '';
  if (name === 'Bash') detail = str(input.description) || str(input.command);
  else if (name === 'AskUserQuestion' && Array.isArray(input.questions)) {
    const q = input.questions[0] ?? {};
    const opts = Array.isArray(q.options) ? q.options.map((o) => str(o?.label)).filter(Boolean) : [];
    detail = [str(q.question), opts.length ? `(${opts.join(' / ')})` : ''].filter(Boolean).join(' ');
  }
  else if (str(input.file_path)) detail = path.basename(input.file_path);
  else if (str(input.notebook_path)) detail = path.basename(input.notebook_path);
  else if (str(input.pattern)) detail = input.pattern;
  else if (str(input.skill)) detail = input.skill;
  else if (str(input.url)) detail = input.url;
  else if (str(input.query)) detail = input.query;
  else if (str(input.description)) detail = input.description;
  else if (str(input.command)) detail = input.command;
  detail = detail.replace(/\s+/g, ' ').trim();
  const max = name === 'AskUserQuestion' ? TOOL_DETAIL_MAX * 2 : TOOL_DETAIL_MAX;
  if (detail.length > max) detail = `${detail.slice(0, max - 1)}…`;
  return detail ? `${name}: ${detail}` : name;
}

function turnsClaude(file, limit) {
  const turns = [];
  for (const entry of jsonLines(file)) {
    if (!['user', 'assistant'].includes(entry.type)) continue;
    const role = entry.message?.role || entry.type;
    const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
    const tools = blocks.filter((b) => b?.type === 'tool_use').map(toolLabel);
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

/* いま使っているモデル。CLI が記録に書いた最後の "model" を拾う。
   記録が変わっていなければ読み直さない（状態が変わるたびに数百 KB 読むのは重い）。 */
const modelCache = new Map();   // file -> { key, model }
const MODEL_TAIL = 64 * 1024;

// claude-fable-5-1 → Fable 5.1。CLI が自分の画面に出すのと同じ書き方に寄せる。
// 当てはまらないものはそのまま返す（gpt-5.6-sol など）。
export function prettyModel(id) {
  if (!id) return null;
  const m = String(id).match(/^claude-([a-z]+)-(\d+(?:-\d+)*)(?:-\d{8})?$/);
  if (!m) return String(id);
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2].replace(/-/g, '.')}`;
}

export function modelFor(session) {
  try {
    /* 状態が変わるたびに呼ばれる。会話 ID がもう判っているなら、そこから記録へ直接辿る。
       ここで claudeTranscript() を素通しすると、内部で PID から辿るために ps を起こし、
       セッションの数だけプロセスを生やすことになる（このツールの値打ちは軽さなので割に合わない）。 */
    const file = session.agent === 'claude'
      ? (session.vendorId ? claudeFileById(session.cwd, session.vendorId) : claudeTranscript(session))
      : codexTranscript(session);
    if (!file) return null;
    const stat = fs.statSync(file);
    const key = `${stat.size}:${stat.mtimeMs}`;
    const hit = modelCache.get(file);
    if (hit && hit.key === key) return hit.model;
    const text = readTail(file, MODEL_TAIL);
    let model = null;
    const re = /"model"\s*:\s*"([^"]+)"/g;
    let m;
    // <synthetic> のような差し込みは本当のモデルではない。飛ばす
    while ((m = re.exec(text))) if (!m[1].startsWith('<')) model = m[1];
    const label = prettyModel(model);
    if (modelCache.size > 64) modelCache.clear();
    modelCache.set(file, { key, model: label });
    return label;
  } catch {
    return null;
  }
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

/* ---------- 続きから開ける会話を並べる ----------
   ＋ の「過去セッション」が使う。CLI が残した記録そのものを見るので、
   ccdeck で立てたものでも、ターミナルで立てたものでも同じように出る。
   記録の場所は agent ごとに違う:
     Claude … ~/.claude/projects/<cwd を潰した名前>/<会話 ID>.jsonl
     Codex  … ~/.codex/sessions/YYYY/MM/DD/rollout-<日時>-<会話 ID>.jsonl
   cwd はファイルの中にしか無い（Claude の名前は潰してあり、元の綴りに戻せない）ので、
   頭のほうだけ読んで拾う。 */

const PAST_HEAD = 128 * 1024;   // 頭のここまでで cwd と最初の発言を探す
const PAST_TTL = 5000;          // 続けて開いたときに走査し直さない
const pastCache = new Map();    // agent -> { at, rows }

function headLines(file, maxBytes = PAST_HEAD) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const size = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, size).toString('utf8').split('\n');
  } finally {
    fs.closeSync(fd);
  }
}

// 人が打った文だけを見出しにしたい。CLI が自分で足す <system-reminder> や
// <command-name> の類は、外すと空になることが多いので、そのときは次の発言を見る。
function humanText(text) {
  const bare = String(text ?? '').replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return bare.length > 120 ? `${bare.slice(0, 119)}…` : bare;
}

function claudeHead(file) {
  let cwd = null;
  let preview = '';
  for (const line of headLines(file)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!cwd && typeof row.cwd === 'string') cwd = row.cwd;
    if (!preview && row.type === 'user' && !row.isSidechain) {
      preview = humanText(contentText(row.message?.content));
    }
    if (cwd && preview) break;
  }
  return { cwd, preview };
}

// Codex は画像を base64 のまま同じ行に書くので、1 行が頭の読み取り幅を超えて
// 途中で切れることがある。切れた行からでも本文だけは拾えるようにする。
function textFromBroken(line) {
  // 画像の直前に "<image …>" だけの塊が入ることがある。中身のある塊まで見る。
  const all = line.matchAll(/"type"\s*:\s*"input_text"\s*,\s*"text"\s*:\s*("(?:[^"\\]|\\.)*")/g);
  for (const hit of all) {
    let text;
    try { text = JSON.parse(hit[1]); } catch { continue; }
    const bare = humanText(text);
    if (bare) return bare;
  }
  return '';
}

function isCodexExec(file) {
  try { return JSON.parse(readFirstLine(file)).payload?.source === 'exec'; } catch { return false; }
}

function codexHead(file, maxBytes = PAST_HEAD) {
  let cwd = null;
  let preview = '';
  for (const line of headLines(file, maxBytes)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      if (!preview) preview = textFromBroken(line);
      continue;
    }
    const payload = row.payload ?? {};
    if (!cwd && row.type === 'session_meta' && typeof payload.cwd === 'string') cwd = payload.cwd;
    if (!preview && row.type === 'response_item' && payload.role === 'user') {
      preview = humanText(contentText(payload.content));
    }
    if (cwd && preview) break;
  }
  return { cwd, preview };
}

// 新しい順に並べたいだけなので、中身は開かずに mtime で拾う
function jsonlFiles(dirs) {
  const files = [];
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        if (stat.size > 0) files.push({ file, at: stat.mtimeMs });
      } catch { /* 消えた直後は飛ばす */ }
    }
  }
  return files.sort((a, b) => b.at - a.at);
}

function subdirs(root, depth) {
  if (depth === 0) return [root];
  let names;
  try { names = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return names.filter((e) => e.isDirectory())
    .flatMap((e) => subdirs(path.join(root, e.name), depth - 1));
}

/**
 * 続きから開ける会話を新しい順に返す。
 * cwd が消えているものは外す（そこでは開けないので出しても押せない）。
 */
export function pastSessions(agent, limit = 30) {
  const cached = pastCache.get(agent);
  if (cached && Date.now() - cached.at < PAST_TTL) return cached.rows.slice(0, limit);

  const claude = agent === 'claude';
  // Codex は画像を base64 のまま同じ行に書くので、頭を広めに読まないと本文に届かない
  const head = claude ? PAST_HEAD : PAST_HEAD * 4;
  const dirs = claude
    ? subdirs(path.join(claudeRoot(), 'projects'), 1)
    : subdirs(codexRoot(), 3);          // sessions/YYYY/MM/DD

  const rows = [];
  for (const { file, at } of jsonlFiles(dirs)) {
    if (rows.length >= limit) break;
    const id = claude
      ? path.basename(file, '.jsonl')
      : UUID.exec(path.basename(file, '.jsonl'))?.[1];
    if (!id) continue;
    // codex exec（スキルやレビューが裏で回す非対話の実行）は続きから開きたい会話ではない。
    // 実データでは一覧の 9 割近くを占め、人の会話を押し出していた。先頭行の session_meta だけで見分ける
    if (!claude && isCodexExec(file)) continue;
    let headInfo;
    try { headInfo = claude ? claudeHead(file) : codexHead(file, head); } catch { continue; }
    if (!headInfo.cwd) continue;
    try { if (!fs.statSync(headInfo.cwd).isDirectory()) continue; } catch { continue; }
    rows.push({
      id,
      agent,
      cwd: headInfo.cwd,
      name: path.basename(headInfo.cwd),
      preview: headInfo.preview,
      at: Math.round(at),
    });
  }
  pastCache.set(agent, { at: Date.now(), rows });
  return rows;
}
