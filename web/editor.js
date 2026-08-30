import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { oneDark } from '@codemirror/theme-one-dark';

// oneDark は青寄りなので、地の色だけ ccdeck の温かいダークに寄せる
const skin = EditorView.theme({
  '&': { backgroundColor: '#131311', color: '#e6e3dc' },
  '.cm-content': { caretColor: '#e0a145' },
  '.cm-gutters': { backgroundColor: '#191917', color: '#5c5a54', borderRight: '1px solid #232220' },
  '.cm-activeLine': { backgroundColor: 'rgba(224, 161, 69, 0.05)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#8d8a82' },
  '&.cm-focused .cm-cursor': { borderLeftColor: '#e0a145' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'rgba(224, 161, 69, 0.20)',
  },
}, { dark: true });

function languageOf(path = '') {
  if (/\.(ts|tsx)$/.test(path)) return javascript({ typescript: true, jsx: path.endsWith('x') });
  if (/\.(js|jsx|mjs|cjs)$/.test(path)) return javascript({ jsx: path.endsWith('x') });
  if (/\.py$/.test(path)) return python();
  if (/\.(json|jsonc)$/.test(path)) return json();
  return [];
}

export class Editor {
  constructor(host, { onSave }) {
    this.host = host;
    this.onSave = onSave;
    this.view = null;
    this.path = null;
  }

  load(path, content) {
    this.path = path;
    const saveKey = keymap.of([{
      key: 'Mod-s',
      preventDefault: true,
      run: () => { this.onSave(this.path, this.value()); return true; },
    }]);
    const state = EditorState.create({
      doc: content,
      extensions: [basicSetup, languageOf(path), oneDark, skin, saveKey],
    });
    if (this.view) this.view.setState(state);
    else this.view = new EditorView({ state, parent: this.host });
  }

  value() { return this.view ? this.view.state.doc.toString() : ''; }
  focus() { this.view?.focus(); }
}
