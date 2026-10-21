import test from 'node:test';
import assert from 'node:assert/strict';
import { previewCodeHtml } from './js/json-preview.js';

function visibleText(html) {
  const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
  return html.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => entities[entity]);
}

test('formatting preserves numeric lexemes, duplicate keys and escaped strings', () => {
  const source = '{"n":9007199254740993,"n":-0,"exp":1.2300e+400,"text":"\\u4e2d\\n","items":[true,false,null,{},[]]}';
  const html = previewCodeHtml(source, 'empty');
  assert.equal(visibleText(html), '{\n  "n": 9007199254740993,\n  "n": -0,\n  "exp": 1.2300e+400,\n  "text": "\\u4e2d\\n",\n  "items": [\n    true,\n    false,\n    null,\n    {},\n    []\n  ]\n}');
  for (const type of ['key', 'number', 'string', 'boolean', 'null', 'punctuation']) {
    assert.ok(html.includes(`class="json-${type}"`), `missing ${type} highlighting`);
  }
});

test('upstream strings cannot inject HTML in JSON or plain text', () => {
  for (const source of ['{"html":"</code><img src=x onerror=alert(1)> & \\"quoted\\""}', '<script>alert(1)</script> & broken {"json":']) {
    const html = previewCodeHtml(source, 'empty');
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('<script'));
    assert.equal(visibleText(html).replace(/\s/g, ''), source.replace(/\s/g, ''));
  }
});

test('malformed JSON and ordinary text remain verbatim', () => {
  for (const source of ['{"broken":', 'line one\n  line two\n', '[1,]', '  undefined  ']) {
    const html = previewCodeHtml(source, 'empty');
    assert.equal(visibleText(html), source);
    assert.ok(!html.includes('json-code'));
  }
});

test('JSON scalars and empty containers are formatted without extra newlines', () => {
  for (const source of ['null', 'true', 'false', '0', '-0', '""', '{}', '[]']) {
    assert.equal(visibleText(previewCodeHtml(`  ${source}\n`, 'empty')), source);
  }
});

test('large or deeply nested content is bounded with a visible truncation notice', () => {
  const long = 'x'.repeat(400001);
  const text = visibleText(previewCodeHtml(long, 'empty'));
  assert.ok(text.startsWith('x'.repeat(400000)));
  assert.ok(text.includes('已截断'));
  const nested = '['.repeat(10000) + '0' + ']'.repeat(10000);
  const nestedText = visibleText(previewCodeHtml(nested, 'empty'));
  assert.ok(nestedText.length < 401000);
  assert.ok(nestedText.includes('截断'));
});
