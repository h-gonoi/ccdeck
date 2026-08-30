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

// 書いているのはこのプロセスだけなので、読み直さずメモリの写しを正とする。
let recentCache = null;

export async function loadRecent() {
  if (recentCache) return recentCache;
  try {
    const raw = JSON.parse(await fs.readFile(RECENT_PATH, 'utf8'));
    recentCache = raw && typeof raw === 'object' ? raw : {};
  } catch {
    recentCache = {};
  }
  return recentCache;
}

// セッションを立てたときに呼ぶ。ここが「最近使った」の唯一の入口。
export async function touchRecent(dir, at = Date.now()) {
  if (!dir) return {};
  const merged = { ...(await loadRecent()), [dir]: at };
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
    if (!found.includes(dir) && await isRepo(dir)) found.push(dir);
  }

  const projects = await Promise.all([...new Set(found)].map(async (dir) => {
    const base = {
      path: dir,
      name: path.basename(dir),
      pinned: config.pinned.includes(dir),
      lastUsed: recent[dir] || 0,
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
