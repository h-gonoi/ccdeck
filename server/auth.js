// LAN に出すときの認証。ccdeck は PTY を作れるので、素で外に出すことは
// その Wi-Fi にいる全員にシェルを配るのと同じになる。ここが唯一の関所。
//
// 決めごと:
//   - ループバックからの接続は素通し（既存の PC 画面を壊さないため）
//   - それ以外は端末ごとのトークンが要る。共有パスワードにはしない
//   - トークンの平文は保存しない。持つのは SHA-256 だけ
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { CONFIG_DIR } from './projects.js';

export const DEVICES_PATH = path.join(CONFIG_DIR, 'devices.json');
export const AUDIT_PATH = path.join(CONFIG_DIR, 'audit.log');

const CODE_TTL_MS = 120 * 1000;   // ペアリングコードの寿命
const CODE_MAX_MISS = 5;          // 総当たり対策。外したらコードごと捨てる
const SEEN_FLUSH_MS = 30 * 1000;  // lastSeen は毎回書かない

// ループバックはこの Mac 自身。req.socket.remoteAddress は ::ffff:127.0.0.1 の形も来る。
// X-Forwarded-For の類は信用しない（詐称できるため）。
export function isLoopback(address) {
  if (!address) return false;
  const addr = address.replace(/^::ffff:/, '');
  return addr === '127.0.0.1' || addr === '::1' || addr.startsWith('127.');
}

export const LOCAL = Object.freeze({ local: true, id: 'local', name: 'この Mac' });

let ledger = null;      // { devices: [...] }
let seenDirty = false;
let seenTimer = null;

async function load() {
  if (ledger) return ledger;
  try {
    const raw = JSON.parse(await fs.readFile(DEVICES_PATH, 'utf8'));
    ledger = { devices: Array.isArray(raw.devices) ? raw.devices : [] };
  } catch {
    ledger = { devices: [] };
  }
  return ledger;
}

async function save() {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(DEVICES_PATH, JSON.stringify(ledger, null, 2), { mode: 0o600 });
}

// 起動時に一度読んでおく。以降の照合はメモリ上で済ませる。
export const ready = load();

const sha256 = (text) => crypto.createHash('sha256').update(text).digest();

// ---- ペアリング ----
// 同時に生きているコードはひとつだけ。出し直せば前のは無効になる。
let pending = null;

export function createPairingCode() {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  pending = { code, expiresAt: Date.now() + CODE_TTL_MS, misses: 0 };
  return { code, expiresAt: pending.expiresAt };
}

export function pairingCode() {
  if (pending && pending.expiresAt <= Date.now()) pending = null;
  return pending ? { code: pending.code, expiresAt: pending.expiresAt } : null;
}

export function cancelPairing() { pending = null; }

export async function consumePairingCode(code, { name, platform } = {}) {
  if (!pending || pending.expiresAt <= Date.now()) {
    pending = null;
    throw new Error('コードが出ていないか、期限が切れています');
  }
  const given = String(code || '');
  const ok = given.length === pending.code.length
    && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(pending.code));
  if (!ok) {
    pending.misses += 1;
    if (pending.misses >= CODE_MAX_MISS) pending = null;   // 総当たりは打ち切る
    throw new Error('コードが違います');
  }

  pending = null;   // 使い切り
  const token = crypto.randomBytes(32).toString('base64url');
  const device = {
    id: crypto.randomUUID().slice(0, 8),
    name: String(name || '名前のない端末').slice(0, 40),
    platform: String(platform || '?').slice(0, 16),
    tokenHash: sha256(token).toString('hex'),
    createdAt: Date.now(),
    lastSeen: Date.now(),
    pushToken: null,
  };
  (await load()).devices.push(device);
  await save();
  return { device: publicDevice(device), token };
}

// ---- 照合 ----
export function verifyToken(token) {
  if (!token || !ledger) return null;
  const given = sha256(token);
  for (const device of ledger.devices) {
    const stored = Buffer.from(device.tokenHash, 'hex');
    if (stored.length === given.length && crypto.timingSafeEqual(stored, given)) {
      touchSeen(device);
      return device;
    }
  }
  return null;
}

function touchSeen(device) {
  device.lastSeen = Date.now();
  seenDirty = true;
  if (seenTimer) return;
  // 接続のたびに書かない。落ちても失うのは「最終接続時刻」だけ。
  seenTimer = setTimeout(() => {
    seenTimer = null;
    if (!seenDirty) return;
    seenDirty = false;
    save().catch(() => {});
  }, SEEN_FLUSH_MS);
  seenTimer.unref?.();
}

const bearer = (req) => {
  const header = req.headers?.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
};

// クエリのトークンはブラウザから WebSocket を張る用の逃げ道。
// アクセスログや Referer に残るので、アプリはヘッダを使うこと。
const fromQuery = (req) => {
  try {
    return new URL(req.url, 'http://x').searchParams.get('token');
  } catch { return null; }
};

// 誰から来たか。ループバックなら LOCAL、登録済みなら端末、それ以外は null。
export function identify(req) {
  if (isLoopback(req.socket?.remoteAddress)) return LOCAL;
  return verifyToken(bearer(req) || fromQuery(req));
}

// ---- 台帳 ----
const publicDevice = (d) => ({
  id: d.id, name: d.name, platform: d.platform,
  createdAt: d.createdAt, lastSeen: d.lastSeen, push: Boolean(d.pushToken),
});

export function listDevices() {
  return (ledger?.devices ?? []).map(publicDevice);
}

export async function revokeDevice(id) {
  const store = await load();
  const before = store.devices.length;
  store.devices = store.devices.filter((d) => d.id !== id);
  if (store.devices.length === before) return false;
  await save();
  return true;
}

export async function setPushToken(deviceId, pushToken) {
  const store = await load();
  const device = store.devices.find((d) => d.id === deviceId);
  if (!device) return false;
  device.pushToken = pushToken || null;
  await save();
  return true;
}

// ---- 記録 ----
// LAN から何が行われたかは残す。書けなくても本筋は止めない。
export function audit(who, action, detail = '') {
  if (!who || who.local) return;
  const line = [new Date().toISOString(), `${who.name}(${who.id})`, action, detail].join('\t');
  fs.appendFile(AUDIT_PATH, `${line}\n`, { mode: 0o600 }).catch(() => {});
}

// ---- 待ち受け先 ----
export function lanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}
