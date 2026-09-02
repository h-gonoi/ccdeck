// scene/*.html から src/scene/*.ts を生む。Metro は .html を文字列として import できないので、
// ここで TS に畳む。フォント（2MB）は import 時に差し込む（__FONT__ のまま残す）。
//   node scripts/build-scene.mjs            → src/scene/html.ts（部屋）と src/scene/chatHtml.ts（会話）
//   node scripts/build-scene.mjs preview    → scene/preview.html（部屋を ?mock 付きでブラウザで開く）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const sprites = JSON.stringify(JSON.parse(read('scene', 'sprites.json')));

const PAGES = [
  { html: 'scene.html', out: 'html.ts', name: 'SCENE_HTML' },
  { html: 'chat.html', out: 'chatHtml.ts', name: 'CHAT_HTML' },
];

if (process.argv[2] === 'preview') {
  const font = read('src', 'scene', 'font.ts');
  const uri = font.slice(font.indexOf("'data:") + 1, font.lastIndexOf("'"));
  const merged = read('scene', 'scene.html').replace('__SPRITES__', sprites).replace('__FONT__', uri);
  const out = path.join(root, 'scene', 'preview.html');
  fs.writeFileSync(out, merged);
  console.log('wrote', out);
} else {
  for (const page of PAGES) {
    const merged = read('scene', page.html).replace('__SPRITES__', sprites);
    const body = [
      `// 生成物。手で直さず scene/${page.html} を直して \`npm run scene\` を叩くこと。`,
      "import { DOT_FONT } from './font';",
      '',
      `const RAW = ${JSON.stringify(merged)};`,
      '',
      `export const ${page.name} = RAW.replace('__FONT__', DOT_FONT);`,
      '',
    ].join('\n');
    const out = path.join(root, 'src', 'scene', page.out);
    fs.writeFileSync(out, body);
    console.log('wrote', out, body.length, 'bytes');
  }
}
