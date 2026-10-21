import { clipText, esc } from './utils.js';

// Format tokens rather than reserializing parsed values: large numbers, duplicate
// keys and escape sequences in frozen requests must remain unchanged on screen.
export function previewCodeHtml(value, emptyText) {
  const source = value == null ? '' : String(value);
  if (!source) return `<div class="empty-state">${esc(emptyText)}</div>`;
  const plain = () => `<pre class="preview-code"><code>${esc(clipText(source))}</code></pre>`;
  const limit = 400000;
  if (source.length > limit) return plain();
  let tokens;
  try {
    JSON.parse(source);
    tokens = source.match(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]/g);
  } catch {
    return plain();
  }

  const html = [];
  let depth = 0;
  // Bound indentation and rendered length even for deeply nested input.
  let length = 0;
  const indent = () => '  '.repeat(Math.min(depth, 40));
  const append = (text, type) => {
    const visible = text.slice(0, Math.max(0, limit - length));
    html.push(type ? `<span class="json-${type}">${esc(visible)}</span>` : esc(visible));
    length += text.length;
  };
  for (let i = 0; i < tokens.length && length <= limit; i++) {
    const token = tokens[i];
    if (token === '{' || token === '[') {
      append(token, 'punctuation');
      if (tokens[i + 1] !== (token === '{' ? '}' : ']')) {
        depth++;
        append('\n' + indent());
      }
    } else if (token === '}' || token === ']') {
      if (tokens[i - 1] !== (token === '}' ? '{' : '[')) {
        depth--;
        append('\n' + indent());
      }
      append(token, 'punctuation');
    } else if (token === ',') {
      append(token, 'punctuation');
      append('\n' + indent());
    } else if (token === ':') {
      append(': ', 'punctuation');
    } else {
      const type = token[0] === '"' ? (tokens[i + 1] === ':' ? 'key' : 'string')
        : token === 'null' ? 'null' : token === 'true' || token === 'false' ? 'boolean' : 'number';
      append(token, type);
    }
  }
  if (length > limit) html.push(esc('\n\n… 显示内容已截断；完整内容请导出批次 JSON。'));
  return `<pre class="preview-code json-code"><code>${html.join('')}</code></pre>`;
}
