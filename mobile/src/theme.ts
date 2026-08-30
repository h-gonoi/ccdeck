import { Platform } from 'react-native';

// PC 側（web/style.css）と同じ色を使う。別の色を足さないこと。
// 琥珀は「あなたの番です」にだけ使う。他へ広げると信号が薄まる。
export const C = {
  bg: '#131311',
  panel: '#191917',
  raised: '#201f1c',
  line: '#2b2a26',
  lineSoft: '#232220',

  text: '#e6e3dc',
  dim: '#8d8a82',
  faint: '#5c5a54',

  amber: '#e0a145',
  amberSoft: 'rgba(224, 161, 69, 0.11)',
  run: '#6f9a72',
  dead: '#a8615b',
};

export const RADIUS = 3;
export const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

export const STATE_LABEL: Record<string, string> = {
  starting: '起動中', running: '実行中', attention: '要対応', idle: '待機', exited: '終了',
};

// 状態の色。待っていればいいものは目立たせない。
export function stateColor(status: string): string {
  if (status === 'attention') return C.amber;
  if (status === 'running') return C.run;
  if (status === 'exited') return C.dead;
  return C.faint;
}

export function relTime(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 45) return 'たった今';
  if (sec < 3600) return `${Math.floor(sec / 60)}分前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}時間前`;
  return `${Math.floor(sec / 86400)}日前`;
}
