import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isRepo, info, status } from './git.js';

const SKIP_DIRS = new Set([
  'node_modules', 'vendor', 'dist', 'build', 'out', '.next', '.nuxt', '.venv',
  'venv', '__pycache__', 'Library', 'Applications', 'Pods', 'DerivedData',
  'target', '.git', 'coverage', '.cache',
]);

export const CONFIG_DIR = path.join(os.homedir(), '.ccdeck');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
// 「最近使った」は設定ではなく履歴なので、手で書き換える config.json とは分けて持つ。
export const RECENT_PATH = path.join(CONFIG_DIR, 'recent.json');
const RECENT_MAX = 40;

const DEFAULT_CONFIG = {
  roots: [
    path.join(os.homedir(), 'projects'),
    path.join(os.homedir(), 'dev'),
    path.join(os.homedir(), 'Documents'),
  ],
  maxDepth: 2,
  pinned: [],
};

export async function loadConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
  return config;
}

// macOS のファイルシステムは大文字小文字を区別しない。
// /Users/x/projects と /Users/x/Projects は同じ場所なのに文字列としては別物で、
// realpath も綴りを直してくれない。だから同一判定は inode で行う。
// （これを怠ると、同じリポジトリが一覧に二つ並ぶ）
async function nodeKey(dir) {
  try {
    const stat = await fs.stat(dir);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;   // 消えた場所
  }
}

// 同じ場所を指す綴り違いをまとめ、消えた場所は落とす
async function dedupe(entries) {
  const seen = new Map();
  for (const [dir, at] of Object.entries(entries)) {
    if (typeof at !== 'number') continue;
    const key = await nodeKey(dir);
    if (!key) continue;
    const prev = seen.get(key);
    if (!prev || at > prev.at) seen.set(key, { dir, at });
  }
  return Object.fromEntries([...seen.values()].map(({ dir, at }) => [dir, at]));
}

// 書いているのはこのプロセスだけなので、読み直さずメモリの写しを正とする。
let recentCache = null;

export async function loadRecent() {
  if (recentCache) return recentCache;
  let raw = {};
  try {
    const parsed = JSON.parse(await fs.readFile(RECENT_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object') raw = parsed;
  } catch { /* 無ければ空から始める */ }
  recentCache = await dedupe(raw);
  return recentCache;
}

// セッションを立てたときに呼ぶ。ここが「最近使った」の唯一の入口。
export async function touchRecent(dir, at = Date.now()) {
  if (!dir) return {};
  const merged = await dedupe({ ...(await loadRecent()), [dir]: at });
  // 際限なく増やさない。古いものから落とす。
  recentCache = Object.fromEntries(
    Object.entries(merged).sort((a, b) => b[1] - a[1]).slice(0, RECENT_MAX),
  );
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(RECENT_PATH, JSON.stringify(recentCache, null, 2));
  return recentCache;
}

// 並びの決めごと：ピン → 最近使った順 → 名前。
// 画面側（web/main.js の sortProjects）も同じ順で並べること。
export function compareProjects(a, b) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const [ua, ub] = [a.lastUsed || 0, b.lastUsed || 0];
  if (ua !== ub) return ub - ua;
  return a.name.localeCompare(b.name);
}

async function walk(dir, depth, found) {
  if (depth < 0) return;
  if (await isRepo(dir)) { found.push(dir); return; } // リポジトリの中は掘らない
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) return;
    await walk(path.join(dir, entry.name), depth - 1, found);
  }));
}

export async function scan() {
  const [config, recent] = await Promise.all([loadConfig(), loadRecent()]);
  const found = [];
  await Promise.all(config.roots.map((root) => walk(root, config.maxDepth, found)));
  // ピンと最近使ったものは roots の外にあっても拾う（消えていれば isRepo で落ちる）
  for (const dir of [...config.pinned, ...Object.keys(recent)]) {
    if (await isRepo(dir)) found.push(dir);
  }

  // 綴り違いの重複を落とす。先に見つけたもの（＝スキャンで出た綴り）を採る。
  const dirs = new Map();
  for (const dir of found) {
    const key = await nodeKey(dir);
    if (key && !dirs.has(key)) dirs.set(key, dir);
  }
  const asKeys = async (list) => new Set(
    (await Promise.all(list.map(nodeKey))).filter(Boolean),
  );
  const [pinnedKeys, recentKeys] = await Promise.all([
    asKeys(config.pinned),
    (async () => {
      const map = new Map();
      for (const [dir, at] of Object.entries(recent)) {
        const key = await nodeKey(dir);
        if (key) map.set(key, at);
      }
      return map;
    })(),
  ]);

  const projects = await Promise.all([...dirs].map(async ([key, dir]) => {
    const base = {
      path: dir,
      name: path.basename(dir),
      pinned: pinnedKeys.has(key),
      lastUsed: recentKeys.get(key) || 0,
    };
    try {
      const [meta, files] = await Promise.all([info(dir), status(dir)]);
      return { ...base, ...meta, changes: files.length };
    } catch {
      return { ...base, branch: '?', changes: 0 };
    }
  }));

  return projects.sort(compareProjects);
}
