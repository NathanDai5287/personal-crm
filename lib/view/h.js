'use strict';
// Hyperscript that renders to an HTML string. `h(tag, props, ...children)` reads
// like JSX; text children are escaped, nested h() output is trusted. Components
// are plain functions that call h() and are invoked directly (Card(x)), so there
// is no framework and no build step — the output is a string the server sends.

const HTML = Symbol('html');
const raw = (html) => ({ [HTML]: html });

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]);

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'link', 'meta']);

function render(node) {
  if (node == null || node === false || node === true) return '';
  if (node[HTML] !== undefined) return node[HTML];
  if (Array.isArray(node)) return node.map(render).join('');
  return escape(node);
}

function attributes(props) {
  if (!props) return '';
  let out = '';
  for (const [name, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    out += value === true ? ` ${name}` : ` ${name}="${escape(value)}"`;
  }
  return out;
}

function h(tag, props, ...children) {
  const open = `<${tag}${attributes(props)}>`;
  if (VOID_TAGS.has(tag)) return raw(open);
  return raw(`${open}${render(children)}</${tag}>`);
}

module.exports = { h, render };
