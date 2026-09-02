/* エージェントの返答（Markdown）を HTML にする小さな変換器。
   会話を描く WebView に渡す。外の実装を入れないのは、生の HTML を通さないため
   （返答に <script> が混ざっても文字として出す）。扱うのは Claude / Codex がよく使うものだけ:
   見出し・段落・箇条書き（入れ子）・番号付き・コード（囲みと行内）・太字・斜体・リンク・引用・表・罫線。 */

const esc = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(src: string): string {
  const codes: string[] = [];
  // 行内コードは先に退避する。退避印に < を使うのは、エスケープ済みの文には現れないため
  let t = esc(src).replace(/`([^`\n]+)`/g, (_, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `<c${codes.length - 1}>`;
  });
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>');
  t = t.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1 <span class="url">$2</span>');
  t = t.replace(/<c(\d+)>/g, (_, i: string) => codes[Number(i)]);
  return t;
}

type Item = { indent: number; ordered: boolean; text: string };

function list(lines: string[], start: number): [string, number] {
  const items: Item[] = [];
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (m) {
      items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] });
      i += 1;
    } else if (items.length && lines[i].trim() && /^\s{2,}/.test(lines[i])) {
      items[items.length - 1].text += ` ${lines[i].trim()}`;   // 折り返しの続き
      i += 1;
    } else {
      break;
    }
  }
  let html = '';
  const stack: { indent: number; ordered: boolean }[] = [];
  for (const it of items) {
    while (stack.length && it.indent < stack[stack.length - 1].indent) {
      html += stack.pop()!.ordered ? '</ol>' : '</ul>';
    }
    const top = stack[stack.length - 1];
    // 同じ深さで印が変わったら、いったん閉じて開き直す（- と 1. が混ざっても崩れない）
    if (top && it.indent === top.indent && it.ordered !== top.ordered) {
      html += stack.pop()!.ordered ? '</ol>' : '</ul>';
    }
    if (!stack.length || it.indent > stack[stack.length - 1].indent) {
      stack.push({ indent: it.indent, ordered: it.ordered });
      html += it.ordered ? '<ol>' : '<ul>';
    }
    html += `<li>${inline(it.text)}</li>`;
  }
  while (stack.length) html += stack.pop()!.ordered ? '</ol>' : '</ul>';
  return [html, i];
}

function table(lines: string[], start: number): [string, number] {
  const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const head = cells(lines[start]);
  let i = start + 2;
  let html = `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>`;
  while (i < lines.length && /^\s*\|/.test(lines[i])) {
    html += `<tr>${cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`;
    i += 1;
  }
  return [`${html}</tbody></table>`, i];
}

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r/g, '').split('\n');
  const out: string[] = [];
  const para: string[] = [];
  const flush = () => {
    if (!para.length) return;
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para.length = 0;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i += 1;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flush(); i += 1; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      const level = Math.min(3, h[1].length);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); i += 1; continue; }
    if (/^\s*>/.test(line)) {
      flush();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const [html, next] = list(lines, i);
      out.push(html);
      i = next;
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const [html, next] = table(lines, i);
      out.push(html);
      i = next;
      continue;
    }
    para.push(line);
    i += 1;
  }
  flush();
  return out.join('');
}
