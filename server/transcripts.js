import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const MAX_READ = 1024 * 1024;
const MAX_HANDOFF = 48_000;

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

function descendants(rootPid) {
  let rows;
  try {
    rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
  } catch {
    return new Set([rootPid]);
  }
  const children = new Map();
  for (const line of rows.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || !ppid) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const found = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    for (const pid of children.get(queue.shift()) ?? []) {
      if (!found.has(pid)) { found.add(pid); queue.push(pid); }
    }
  }
  return found;
}

function findNamed(root, name, depth = 0) {
  if (depth > 4) return null;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const found = findNamed(full, name, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function claudeTranscript(session) {
  const root = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const livePids = descendants(session.pty?.pid);
  let statuses;
  try { statuses = fs.readdirSync(path.join(root, 'sessions')); } catch { return null; }
  for (const name of statuses) {
    if (!name.endsWith('.json')) continue;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(root, 'sessions', name), 'utf8'));
      if (!livePids.has(info.pid) || info.cwd !== session.cwd || !info.sessionId) continue;
      const project = session.cwd.replace(/[^a-zA-Z0-9]/g, '-');
      const expected = path.join(root, 'projects', project, `${info.sessionId}.jsonl`);
      return fs.existsSync(expected)
        ? expected
        : findNamed(path.join(root, 'projects'), `${info.sessionId}.jsonl`);
    } catch { /* 書き込み途中や消滅直後は次を見る */ }
  }
  return null;
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

function codexTranscript(session) {
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const candidates = [];
  for (const parts of nearbyDays(session.createdAt)) {
    const dir = path.join(root, ...parts);
    let names;
    try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')); } catch { continue; }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const first = readFirstLine(file);
        const meta = JSON.parse(first);
        if (meta.type !== 'session_meta' || meta.payload?.cwd !== session.cwd) continue;
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
