// scene/scene.html と scene/sprites.json から src/scene/html.ts を生む。
// Metro は .html を文字列として import できないので、ここで TS に畳む。
// フォント（2MB）は import 時に差し込む（__FONT__ のまま残す）。
//   node scripts/build-scene.mjs            → src/scene/html.ts
//   node scripts/build-scene.mjs preview    → scene/preview.html（ブラウザで ?mock を付けて開く）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'scene', 'scene.html'), 'utf8');
const sprites = fs.readFileSync(path.join(root, 'scene', 'sprites.json'), 'utf8');
const merged = html.replace('__SPRITES__', JSON.stringify(JSON.parse(sprites)));

if (process.argv[2] === 'preview') {
  const font = fs.readFileSync(path.join(root, 'src', 'scene', 'font.ts'), 'utf8');
  const uri = font.slice(font.indexOf("'data:") + 1, font.lastIndexOf("'"));
  const out = path.join(root, 'scene', 'preview.html');
  fs.writeFileSync(out, merged.replace('__FONT__', uri));
  console.log('wrote', out);
} else {
  const out = path.join(root, 'src', 'scene', 'html.ts');
  const body = [
    '// 生成物。手で直さず scene/scene.html を直して `npm run scene` を叩くこと。',
    "import { DOT_FONT } from './font';",
    '',
    `const RAW = ${JSON.stringify(merged)};`,
    '',
    "export const SCENE_HTML = RAW.replace('__FONT__', DOT_FONT);",
    '',
  ].join('\n');
  fs.writeFileSync(out, body);
  console.log('wrote', out, body.length, 'bytes');
}
