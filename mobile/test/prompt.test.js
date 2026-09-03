/* 承認待ちの画面から選択肢を取り出せるかを、実際に採った画面で固定する。
   相手は Claude Code の描画で、こちらが決められない。枠線が一本増えただけで壊れるので、
   採った画面をそのまま置いてある（test/screens/）。壊れたら、まず新しい画面を採って足すこと。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parsePrompt, keysFor } = require('../.test-build/prompt.js');

const ESC = String.fromCharCode(27);
const screen = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'screens', `${name}.json`), 'utf8')).join('\n');

test('選択肢が 6 つある問いを、質問文ごと取り出す', () => {
  const prompt = parsePrompt(screen('ask-question'));
  assert.equal(prompt.options.length, 6, '末尾を数行だけ切ると先頭の選択肢が落ちる');
  assert.ok(prompt.question.includes('どの色にしますか？'));
  assert.deepEqual(prompt.options.map((o) => o.label), [
    'Red', 'Blue', 'Green', 'Yellow', 'Type something.', 'Chat about this',
  ]);
  assert.equal(prompt.options[0].selected, true);
  assert.equal(prompt.options[0].detail, '赤を選びます。', '選択肢の説明も拾う');
  assert.deepEqual(keysFor(prompt, prompt.options[5]), ['6']);
});

test('/model の一覧を取り出す。前の会話は問いに混ぜない', () => {
  const prompt = parsePrompt(screen('model-picker'));
  assert.equal(prompt.options.length, 5);
  assert.equal(prompt.question[0], 'Select model');
  assert.ok(!prompt.question.some((l) => l.includes('Brewed')), '罫線の上は前の会話なので切る');
  assert.equal(prompt.options[1].selected, true, '❯ の位置がそのまま選択中');
});

test('枠で囲まれた許可の問いも同じように取り出す', () => {
  const prompt = parsePrompt(screen('permission'));
  assert.equal(prompt.options.length, 3);
  assert.ok(prompt.question.includes('Do you want to proceed?'));
  assert.equal(prompt.options[0].label, 'Yes');
  assert.deepEqual(keysFor(prompt, prompt.options[2]), ['3']);
});

test('番号の無い問いは ❯ の桁に揃う行を選択肢にする', () => {
  const prompt = parsePrompt(screen('trust-folder'));
  assert.deepEqual(prompt.options.map((o) => o.label), ['No, exit', 'Yes, I trust this folder']);
  assert.equal(prompt.options[0].selected, true, '既定は No, exit。ここで Enter を送ると CLI が落ちる');
  assert.deepEqual(keysFor(prompt, prompt.options[1]), [`${ESC}[B`, '\r'], '番号が無いので矢印で動かす');
});

test('問いが出ていない画面では null', () => {
  assert.equal(parsePrompt(screen('no-prompt')), null);
  assert.equal(parsePrompt(''), null);
  assert.equal(parsePrompt(undefined), null);
});

test('いま選ばれているものを選び直しても、余計な矢印は送らない', () => {
  const prompt = parsePrompt(screen('trust-folder'));
  assert.deepEqual(keysFor(prompt, prompt.options[0]), ['\r']);
});
