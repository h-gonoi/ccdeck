import { promises as fs } from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.venv', '__pycache__', '.cache']);
const MAX_FILE = 2 * 1024 * 1024;

// API 越しに任意のパスを読み書きさせない。必ずプロジェクト配下に閉じ込める。
export function resolveInside(root, relative) {
  const base = path.resolve(root);
  const target = path.resolve(base, relative || '.');
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error('プロジェクト外のパスは扱えません');
  }
  return target;
}

export async function listDir(root, relative = '.') {
  const dir = resolveInside(root, relative);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => !SKIP.has(e.name))
    .map((e) => ({
      name: e.name,
      path: path.relative(root, path.join(dir, e.name)),
      dir: e.isDirectory(),
    }))
    .sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
}

export async function readFile(root, relative) {
  const target = resolveInside(root, relative);
  const st = await fs.stat(target);
  if (st.size > MAX_FILE) throw new Error(`ファイルが大きすぎます (${Math.round(st.size / 1024)}KB)`);
  const content = await fs.readFile(target, 'utf8');
  return { path: relative, content, size: st.size };
}

export async function writeFile(root, relative, content) {
  const target = resolveInside(root, relative);
  await fs.writeFile(target, content, 'utf8');
  return { path: relative, size: Buffer.byteLength(content) };
}
