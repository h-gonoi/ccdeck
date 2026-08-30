import * as SecureStore from 'expo-secure-store';
import type { Link } from './types';

// トークンは端末の安全な置き場にだけ置く。平文で持ち歩かない。
const KEY = 'ccdeck_link';

export async function loadLink(): Promise<Link | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    return raw ? (JSON.parse(raw) as Link) : null;
  } catch {
    return null;
  }
}

export async function saveLink(link: Link): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(link));
}

export async function clearLink(): Promise<void> {
  try { await SecureStore.deleteItemAsync(KEY); } catch { /* 無ければそれでいい */ }
}
