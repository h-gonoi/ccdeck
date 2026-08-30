// アプリを落とすとセッションの PTY は道連れに死ぬ。それ自体は避けようがないが、
// 「何がどこで走っていたか」まで一緒に消えると取り戻しようがない。
// だから生きているセッションの会話 ID だけを台帳に残し、次の起動でそのまま resume する。
//
// 台帳に残るのは「殺されて終わったもの」だけ。自分で × を押したものと、
// 自然に終わったものは載せない（次の起動で勝手に生き返ると鬱陶しい）。
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './projects.js';
import { AGENT_COMMANDS } from './sessions.js';
import { procChildren, resumeAvailable, vendorSessionId } from './transcripts.js';

export const LEDGER_PATH = path.join(CONFIG_DIR, 'sessions.json');
// 事故のとき手で控えたものを一度だけ拾うための口。取り込んだら .imported に退ける。
const LEGACY_PATH = path.join(CONFIG_DIR, 'session-resume-backup.json');

const MAX_RESTORE = 12;              // 画面に並べられる枠と同じ
const MAX_AGE_MS = 7 * 86400_000;    // これより古い台帳は復元しない
const SAVE_DEBOUNCE_MS = 1000;
const REFRESH_MS = 60_000;           // /clear などで会話 ID が変わるので定期的に読み直す
// 起動直後は会話 ID がまだ書かれていない。落ち着いた頃にもう一度だけ見に行く。
const SETTLE_MS = [5000, 20_000];

const entryOf = (session) => ({
  id: session.id,
  title: session.title,
  cwd: session.cwd,
  agent: session.agent,
  familyId: session.familyId,
  resumeId: session.vendorId ?? session.resumeId ?? null,
  createdAt: session.createdAt,
  lastActivity: session.lastActivity,
});

function liveEntries(manager) {
  return [...manager.sessions.values()]
    .filter((session) => session.exitCode === null)
    .map(entryOf);
}

const payload = (manager) => JSON.stringify({
  version: 1, savedAt: Date.now(), sessions: liveEntries(manager),
}, null, 2);

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; }
}

function sane(entry) {
  if (!entry || typeof entry.cwd !== 'string' || !entry.cwd) return null;
  if (!Object.hasOwn(AGENT_COMMANDS, entry.agent)) return null;
  try {
    if (!fs.statSync(entry.cwd).isDirectory()) return null;   // 消えた場所には戻れない
  } catch {
    return null;
  }
  const createdAt = Number(entry.createdAt) || Date.now();
  if (Date.now() - createdAt > MAX_AGE_MS) return null;
  // 消えた会話を --resume に渡すと CLI が即落ちする。無ければ素で開き直す。
  const resumeId = resumeAvailable(entry.agent, entry.cwd, entry.resumeId, createdAt)
    ? entry.resumeId
    : null;
  return {
    id: typeof entry.id === 'string' && entry.id ? entry.id : null,
    title: entry.title || path.basename(entry.cwd),
    cwd: entry.cwd,
    agent: entry.agent,
    familyId: typeof entry.familyId === 'string' ? entry.familyId : null,
    resumeId,
    createdAt,
    lastActivity: Number(entry.lastActivity) || createdAt,
  };
}

/**
 * 前回落ちたときに生きていたセッション。読んだ台帳はその場で退ける
 * （復元に失敗しても、同じものを毎回起こしにいかないため）。
 */
export async function takePending() {
  const found = [];
  for (const [file, data] of [
    [LEDGER_PATH, await readJson(LEDGER_PATH)],
    [LEGACY_PATH, await readJson(LEGACY_PATH)],
  ]) {
    if (!Array.isArray(data?.sessions)) continue;
    found.push(...data.sessions);
    await fsp.rename(file, `${file}.imported`).catch(() => {});
  }

  const seen = new Set();
  const pending = [];
  for (const raw of found) {
    const entry = sane(raw);
    if (!entry) continue;
    const key = `${entry.agent}:${entry.resumeId ?? entry.cwd}`;
    if (seen.has(key)) continue;      // 台帳と控えに同じものが載っていることがある
    seen.add(key);
    pending.push(entry);
  }
  // 新しいものから埋める。溢れた分は諦める（一度に 12 本以上は並べられない）
  pending.sort((a, b) => b.lastActivity - a.lastActivity);
  return { restore: pending.slice(0, MAX_RESTORE), dropped: Math.max(0, pending.length - MAX_RESTORE) };
}

/**
 * 会話 ID を読み直す。ps は 1 回で済ませる。
 * 起動直後のセッションはまだ ID を持っていないので、取れなくても消さない。
 */
export function refresh(manager) {
  const sessions = [...manager.sessions.values()].filter((s) => s.exitCode === null);
  if (!sessions.length) return;
  const children = procChildren();
  for (const session of sessions) {
    const id = vendorSessionId(session, children);
    if (id) session.vendorId = id;
  }
}

// 台帳に効く部分だけを取り出した指紋。
// sessions イベントは状態が動くたびに飛んでくる（実行中は毎秒でも飛ぶ）が、
// 「実行中か待機中か」は台帳に載らない。ここが同じなら書き直す意味がない。
const digest = (manager) => JSON.stringify(
  liveEntries(manager).map((e) => [e.id, e.cwd, e.agent, e.title, e.resumeId]),
);

/** セッションの出入りに合わせて台帳を書き続ける。 */
export function follow(manager) {
  let timer = null;
  let last = null;
  const settling = [];

  const save = () => {
    timer = null;
    fsp.mkdir(CONFIG_DIR, { recursive: true })
      .then(() => fsp.writeFile(LEDGER_PATH, payload(manager)))
      .catch(() => { last = null; });   // 書けなかったら次の機会にもう一度
  };

  const saveSoon = () => {
    const now = digest(manager);
    if (now === last) return;
    last = now;
    if (!timer) timer = setTimeout(save, SAVE_DEBOUNCE_MS);
  };

  // 立った直後は会話 ID がまだ書かれていない。落ち着いた頃に拾い直す。
  // 何本も続けて立てても ps を連打しないよう、予約は常に貼り直して最後の一組だけ残す。
  const settle = () => {
    for (const t of settling) clearTimeout(t);
    settling.length = 0;
    for (const delay of SETTLE_MS) {
      settling.push(setTimeout(() => { refresh(manager); saveSoon(); }, delay));
    }
  };

  manager.on('sessions', () => { saveSoon(); settle(); });
  setInterval(() => { refresh(manager); saveSoon(); }, REFRESH_MS);
  saveSoon();
}

/**
 * 落ちる直前に、いまの会話 ID ごと書き切る。
 * ここは非同期にできない（process.exit に間に合わない）。
 */
export function saveSync(manager) {
  try {
    refresh(manager);
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(LEDGER_PATH, payload(manager));
  } catch { /* 書けなくても停止は止めない */ }
}
