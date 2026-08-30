import type { Health, Link } from './types';

// 電波が悪いときに黙って固まらないよう、必ず時間を切る。
const TIMEOUT_MS = 6000;

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: abort.signal });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || `${res.status} ${res.statusText}`);
    return body as T;
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error('応答がありません。アドレスと Wi-Fi を確かめてください');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export const httpBase = (host: string) => `http://${host}`;
export const wsBase = (host: string) => `ws://${host}`;

// ペアリング前でも叩ける。繋がるか・版が合うかをここで確かめる。
export const health = (host: string) => call<Health>(`${httpBase(host)}/api/health`);

export const pair = (host: string, code: string, name: string, platform: string) =>
  call<{ device: { id: string; name: string }; token: string }>(`${httpBase(host)}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, name, platform }),
  });

export const authed = <T>(link: Link, path: string, init: RequestInit = {}) =>
  call<T>(`${httpBase(link.host)}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${link.token}` },
  });
