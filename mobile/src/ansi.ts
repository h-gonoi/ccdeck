// M1 は色を捨てて素のテキストで見せる（xterm.js を積むのは M2）。
// サーバーが送ってくるのは「いま見えている 1 画面」ぶんの ANSI。
const ESC = '\u001b';
const BEL = '\u0007';

const OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g');
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const OTHER = new RegExp(`${ESC}[@-Z_]`, 'g');

export function toPlain(ansi: string): string {
  const text = ansi
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(OTHER, '')
    .replace(/\r/g, '');
  // 末尾の空行は落とす。画面の下半分が空でも縦に間延びさせない。
  return text.replace(/\s+$/, '');
}
