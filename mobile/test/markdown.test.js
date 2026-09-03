/* 返答の Markdown を HTML に直す。生の HTML は通さない（返答に紛れ込んでも文字として出す）。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderMarkdown } = require('../.test-build/markdown.js');

test('HTML は素通しせず、文字として出す', () => {
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('行内コードの中の記号も逃がす', () => {
  assert.ok(renderMarkdown('`a<b && "c"`').includes('<code>a&lt;b &amp;&amp; &quot;c&quot;</code>'));
});

test('見出し・太字・囲みコード', () => {
  assert.ok(renderMarkdown('# 見出し').includes('<h1>見出し</h1>'));
  assert.ok(renderMarkdown('**太字**').includes('<b>太字</b>'));
  assert.ok(renderMarkdown('```js\nconst a = 1 < 2;\n```').includes('<pre><code>const a = 1 &lt; 2;</code></pre>'));
});

test('箇条書きと番号付きが混ざっても入れ子が崩れない', () => {
  const html = renderMarkdown('- 一つ\n- 二つ\n  - 入れ子\n1. 番号\n2. 番号');
  assert.equal((html.match(/<ul>/g) || []).length, (html.match(/<\/ul>/g) || []).length);
  assert.equal((html.match(/<ol>/g) || []).length, (html.match(/<\/ol>/g) || []).length);
  assert.ok(html.includes('<ol>'), '同じ深さで印が変わったら開き直す');
});

test('表と引用', () => {
  assert.ok(renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |').includes('<th>a</th>'));
  assert.ok(renderMarkdown('> 引用').includes('<blockquote>'));
});

test('空でも落ちない', () => {
  assert.equal(renderMarkdown(''), '');
});
