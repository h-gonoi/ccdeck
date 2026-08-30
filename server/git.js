import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 24 * 1024 * 1024;

export async function git(cwd, args, { timeout = 20000 } = {}) {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: MAX_BUFFER, timeout });
  return stdout;
}

export async function isRepo(dir) {
  try {
    const st = await fs.stat(path.join(dir, '.git'));
    return st.isDirectory() || st.isFile(); // worktree では .git がファイル
  } catch { return false; }
}

// --porcelain=v1 -z を素直にパースする。リネームは「新パス\0旧パス」で来る。
export async function status(cwd) {
  const raw = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const parts = raw.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 3) continue;
    const index = entry[0];
    const work = entry[1];
    const filePath = entry.slice(3);
    let from = null;
    if (index === 'R' || index === 'C') from = parts[++i] ?? null;
    files.push({
      path: filePath,
      from,
      index,
      work,
      staged: index !== ' ' && index !== '?',
      untracked: index === '?',
      deleted: index === 'D' || work === 'D',
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function info(cwd) {
  let branch = '';
  try { branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); } catch { branch = '(no commits)'; }
  let upstream = null, ahead = 0, behind = 0;
  try {
    upstream = (await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).trim();
    const counts = (await git(cwd, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])).trim().split(/\s+/);
    behind = Number(counts[0]) || 0;
    ahead = Number(counts[1]) || 0;
  } catch { /* upstream 未設定 */ }
  return { branch, upstream, ahead, behind };
}

export async function diff(cwd, file, { staged = false } = {}) {
  const args = ['diff', '--no-color'];
  if (staged) args.push('--cached');
  args.push('--', file);
  let out = await git(cwd, args);
  if (!out.trim() && !staged) {
    // 未追跡ファイルは通常の diff に現れないので /dev/null と比較する。
    // --no-index は差分があると exit 1 を返すため stdout を拾う。
    try {
      out = await git(cwd, ['diff', '--no-color', '--no-index', '--', '/dev/null', file]);
    } catch (err) {
      out = err.stdout || '';
    }
  }
  return out;
}

export const stage = (cwd, files) => git(cwd, ['add', '--', ...files]);
export const unstage = (cwd, files) => git(cwd, ['restore', '--staged', '--', ...files]);
export const discard = (cwd, files) => git(cwd, ['checkout', '--', ...files]);

export async function commit(cwd, message) {
  return git(cwd, ['commit', '-m', message]);
}

export async function push(cwd) {
  const { branch, upstream } = await info(cwd);
  const args = upstream ? ['push'] : ['push', '-u', 'origin', branch];
  return git(cwd, args, { timeout: 120000 });
}

export async function log(cwd, limit = 15) {
  const out = await git(cwd, ['log', `-${limit}`, '--pretty=format:%h%x1f%an%x1f%ar%x1f%s']);
  return out.split('\n').filter(Boolean).map((line) => {
    const [hash, author, date, subject] = line.split('\x1f');
    return { hash, author, date, subject };
  });
}
