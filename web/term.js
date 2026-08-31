import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// 画面のデザイントークンとそろえる。ターミナルだけ浮かないように。
const THEME = {
  background: '#131311',
  foreground: '#e6e3dc',
  cursor: '#e0a145',
  cursorAccent: '#131311',
  selectionBackground: 'rgba(224, 161, 69, 0.22)',
  black: '#131311', red: '#c9756e', green: '#7fa882', yellow: '#e0a145',
  blue: '#7c9cbf', magenta: '#b58bb0', cyan: '#83a9a6', white: '#d8d4cc',
  brightBlack: '#5c5a54', brightRed: '#dc8d86', brightGreen: '#98c09b',
  brightYellow: '#edb15b', brightBlue: '#95b4d6', brightMagenta: '#cba3c6',
  brightCyan: '#9cc0bd', brightWhite: '#f2efe8',
};

// 分割すると1ペインが細くなる。Claude Code の TUI は桁数が足りないと崩れるので、
// ペインの実寸に合わせて文字を詰める。
function fontSizeFor(width) {
  if (width > 1000) return 12;
  if (width > 700) return 11;
  if (width > 500) return 10;
  if (width > 380) return 9;
  return 8;
}

export class TerminalPool {
  constructor(host, { onInput, onResize, onActivate, onClose }) {
    this.host = host;
    this.onInput = onInput;
    this.onResize = onResize;
    this.onActivate = onActivate;
    this.onClose = onClose;

    this.entries = new Map();   // id -> { term, fit, wrapper, body, dot, name, lastSize }
    this.visible = [];
    this.activeId = null;

    this.observer = new ResizeObserver(() => this.fitAll());
    this.observer.observe(host);
  }

  ensure(id, meta = {}) {
    if (this.entries.has(id)) return this.entries.get(id);

    const wrapper = document.createElement('div');
    wrapper.className = 'pane';
    wrapper.hidden = true;
    wrapper.dataset.id = id;

    const head = document.createElement('div');
    head.className = 'pane__head';
    head.draggable = true;   // 枠ごと掴んで並べ替えられる
    head.ondragstart = (event) => {
      event.dataTransfer.setData('application/x-ccdeck-pane', id);
      event.dataTransfer.effectAllowed = 'move';
    };
    const dot = document.createElement('span');
    dot.className = 'pane__dot';
    const name = document.createElement('span');
    name.className = 'pane__name';
    name.textContent = meta.title ?? '';
    const close = document.createElement('button');
    close.className = 'pane__close';
    close.textContent = '×';
    close.title = 'この枠から外す';
    close.onclick = (event) => { event.stopPropagation(); this.onClose(id); };
    head.append(dot, name, close);

    const body = document.createElement('div');
    body.className = 'pane__body';

    wrapper.append(head, body);
    wrapper.onmousedown = () => this.onActivate(id);
    this.host.appendChild(wrapper);

    const term = new Terminal({
      theme: THEME,
      fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 8000,
      allowProposedApi: true,
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(body);
    term.onData((data) => this.onInput(id, data));

    const entry = { term, fit, wrapper, body, dot, name, lastSize: '' };
    this.entries.set(id, entry);
    return entry;
  }

  /** 表示するセッションを並び順で指定する。ここでレイアウトが決まる。 */
  setVisible(ids) {
    this.visible = ids.filter((id) => this.entries.has(id));
    for (const [id, entry] of this.entries) entry.wrapper.hidden = !this.visible.includes(id);
    for (const id of this.visible) this.host.appendChild(this.entries.get(id).wrapper); // 並び順を DOM に反映
    this.host.dataset.count = String(Math.min(this.visible.length, 12));
    this.fitAll();
  }

  setActive(id) {
    this.activeId = id;
    for (const [key, entry] of this.entries) {
      entry.wrapper.classList.toggle('pane--active', key === id);
    }
    const entry = this.entries.get(id);
    if (entry && !entry.wrapper.hidden) entry.term.focus();
  }

  updateMeta(id, { title, status }) {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (title != null) entry.name.textContent = title;
    if (status != null) entry.dot.className = `pane__dot pane__dot--${status}`;
  }

  // サイズの持ち主が変わったと教わったら、測り直して送り直す。
  // 桁数を決める権利はサーバーが判断するので、こちらは黙って測るだけでよい。
  setOwned(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.lastSize = null;
    this.fitAll();
  }

  fitAll() {
    for (const id of this.visible) {
      const entry = this.entries.get(id);
      if (!entry || entry.wrapper.hidden) continue;
      const width = entry.body.clientWidth;
      if (!width) continue;

      const size = fontSizeFor(width);
      if (entry.term.options.fontSize !== size) entry.term.options.fontSize = size;
      try { entry.fit.fit(); } catch { continue; }
      const dims = `${entry.term.cols}x${entry.term.rows}`;
      if (dims !== entry.lastSize) {
        entry.lastSize = dims;
        this.onResize(id, entry.term.cols, entry.term.rows);
      }
    }
  }

  write(id, data) { this.entries.get(id)?.term.write(data); }

  replay(id, data) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.term.reset();
    entry.term.write(data);
  }

  dispose(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.term.dispose();
    entry.wrapper.remove();
    this.entries.delete(id);
    this.visible = this.visible.filter((x) => x !== id);
    if (this.activeId === id) this.activeId = null;
  }

  size(id) {
    const entry = this.entries.get(id);
    return entry ? { cols: entry.term.cols, rows: entry.term.rows } : { cols: 120, rows: 34 };
  }
}
