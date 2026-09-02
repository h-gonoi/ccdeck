/* 承認待ちの画面から「問い」と「選択肢」を取り出す。
   Claude Code の問いは二通りある。囲み枠のある許可の問いと、枠のない選択の問い。
   どちらも「選択肢が並び、いま選ばれているものに ❯ が付き、下に案内が出る」形は同じなので、
   案内の行を起点に上へ遡って組み立てる。

   ここを「末尾から何行か」で切ると、選択肢が 4 つ以上あるときに質問文と先頭の選択肢が切れる（実際に切れた）。 */

export type PromptOption = { index: number; number: number | null; label: string; detail: string; selected: boolean };
export type Prompt = { question: string[]; options: PromptOption[]; footer: string };

// 選択の案内。これが出ていれば、その上は問いの箱
const FOOTER = /Enter to (select|confirm|continue)|↑\/↓|Esc to cancel|esc to cancel|Press Enter/i;
// 罫線だけの行。落とす
const RULE = /^[─━▔▁▂▃╌╍┄┅╭╮╰╯┌┐└┘├┤┬┴┼\s]+$/;
const NUMBERED = /^(❯|>)?\s*(\d+)[.)]\s+(.*)$/;
// 画面の下にある入力欄や状態行。問いの一部ではない
const CHROME = /auto mode on|shift\+tab to cycle|bypass permissions|esc to interrupt/i;

// 枠の縦線を空白に均してから測る（枠の中でも桁位置を保つ）
const flat = (line: string) => line.replace(/[│┃|]/g, ' ').replace(/\s+$/, '');
const strip = (line: string) => flat(line).trim();
// 印（❯）を空白に均したときの、文字の始まる桁。選択肢どうしはこれが揃う
function textCol(line: string): number {
  const s = flat(line).replace(/❯|>/, ' ');
  const m = s.match(/^\s*/);
  return s.trim() ? (m ? m[0].length : 0) : -1;
}

export function parsePrompt(screen?: string): Prompt | null {
  if (!screen) return null;
  const raw = screen.split('\n');
  while (raw.length && !raw[raw.length - 1].trim()) raw.pop();

  let foot = -1;
  for (let i = raw.length - 1; i >= 0 && i >= raw.length - 12; i--) {
    if (FOOTER.test(raw[i])) { foot = i; break; }
  }
  if (foot < 0) return null;

  const options: PromptOption[] = [];
  let top = foot;

  // 番号付きの選択肢。案内の上から遡る。間に説明・空行・罫線が挟まってもよい
  let pending: string[] = [];
  for (let i = foot - 1; i >= 0 && i >= foot - 40; i--) {
    const line = strip(raw[i]);
    if (!line || RULE.test(raw[i])) { if (!options.length) top = i; continue; }
    if (CHROME.test(line)) break;
    const m = line.match(NUMBERED);
    if (m) {
      options.unshift({
        index: 0, number: Number(m[2]), label: m[3].trim(),
        detail: pending.reverse().join(' '), selected: Boolean(m[1]),
      });
      pending = [];
      top = i;
      continue;
    }
    if (!options.length) { top = i; continue; }
    // 選択肢より深く下げた行は、その選択肢の説明
    if (textCol(raw[i]) > textCol(raw[top])) { pending.push(line); continue; }
    break;
  }

  // 番号が無い問い（フォルダの信頼など）。❯ の桁に揃う行を上下に集める
  if (!options.length) {
    let point = -1;
    for (let i = foot - 1; i >= 0 && i >= foot - 14; i--) {
      if (/(❯|>)\s+\S/.test(flat(raw[i]))) { point = i; break; }
    }
    if (point < 0) return null;
    const col = textCol(raw[point]);
    const rows: number[] = [];
    for (let i = point; i >= 0 && i >= point - 8; i--) {
      if (!strip(raw[i])) break;
      if (textCol(raw[i]) !== col) break;
      rows.unshift(i);
    }
    for (let i = point + 1; i < foot; i++) {
      if (!strip(raw[i])) break;
      if (textCol(raw[i]) !== col) break;
      rows.push(i);
    }
    for (const i of rows) {
      options.push({
        index: 0, number: null, label: strip(raw[i]).replace(/^(❯|>)\s*/, ''),
        detail: '', selected: /(❯|>)\s+\S/.test(flat(raw[i])),
      });
    }
    top = rows[0];
  }
  if (!options.length) return null;
  options.forEach((o, k) => { o.index = k; });

  // 選択肢の上にある文。空行が二つ続くところで切る（前の会話まで持ってこない）
  const question: string[] = [];
  let blanks = 0;
  for (let i = top - 1; i >= 0 && question.length < 10; i--) {
    const line = strip(raw[i]);
    // 罫線は箱の上端。そこで切らないと、前の会話まで問いに混ざる
    if (line && RULE.test(raw[i])) break;
    if (!line) {
      blanks += 1;
      if (blanks >= 2 && question.length) break;
      continue;
    }
    if (CHROME.test(line)) break;
    if (/^(❯|>)\s/.test(line) && !NUMBERED.test(line)) break;   // 自分が打った文まで遡らない
    blanks = 0;
    question.unshift(line);
  }

  return { question, options, footer: strip(raw[foot]) };
}

/* 選んだ手を打鍵に直す。番号があればその数字。無ければ ❯ の位置から矢印で動かして Enter。 */
export function keysFor(prompt: Prompt, option: PromptOption): string[] {
  const ESC = String.fromCharCode(27);
  if (option.number !== null && option.number >= 1 && option.number <= 9) return [String(option.number)];
  const from = prompt.options.findIndex((o) => o.selected);
  const step = option.index - (from < 0 ? 0 : from);
  const arrow = step > 0 ? `${ESC}[B` : `${ESC}[A`;
  return [...Array(Math.abs(step)).fill(arrow), '\r'];
}
