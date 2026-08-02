'use strict';
// lib/compact-prompt.js — build the compaction prompt from a template file.
//
// WHY THIS EXISTS: the compaction prompt used to be a string literal inside
// scripts/crm-compact.js. That made it the only model instruction in the
// pipeline that could not be versioned, diffed, or A/B'd — and it is arguably
// the higher-stakes of the two, because compaction is a ONE-WAY RATCHET: its
// output replaces raw message lines that are then dropped from the profile. A
// bad merge can be re-run against the archive; a bad Timeline summary is only
// recoverable from .memory-history.git.
//
// Templates are plain text with {{PLACEHOLDER}} slots. A template may also carry
// an optional YAML-ish front matter block delimited by `---` lines, whose only
// supported key today is `system:` — the compaction prompt historically had NO
// system prompt at all (the whole contract sat in one user turn interleaved with
// the data), which was the review's top finding. A variant that wants a system
// prompt declares it there; v1 does not, preserving the original behaviour
// exactly so it stays a faithful control.

const fs = require('fs');

const SLOTS = ['PERIOD_SENTENCE', 'STYLE_INSTRUCTION', 'MESSAGES'];

// Split `---\nsystem: |\n  …\n---\n<body>` into { system, body }. Anything
// without the leading delimiter is all body, which is the v1 case.
function parseTemplate(text) {
  const t = String(text).replace(/^﻿/, '');
  if (!t.startsWith('---')) return { system: null, body: t };
  const end = t.indexOf('\n---', 3);
  if (end === -1) return { system: null, body: t };
  const head = t.slice(3, end);
  const body = t.slice(end + 4).replace(/^\r?\n/, '');
  const m = /(^|\n)system:\s*\|\s*\r?\n([\s\S]*?)(?=\n\w+:|$)/.exec(head);
  if (!m) return { system: null, body };
  // Strip the common leading indentation of the block scalar.
  const raw = m[2].replace(/\s+$/, '').split('\n');
  const indent = Math.min(...raw.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return { system: raw.map((l) => l.slice(indent)).join('\n').trim(), body };
}

// vals: { PERIOD_SENTENCE, STYLE_INSTRUCTION, MESSAGES }
// Throws on an unknown or missing slot rather than silently emitting a prompt
// with a literal "{{MESSAGES}}" in it — a template typo must fail loudly, not
// produce hundreds of garbage Timeline lines.
function render(template, vals) {
  const { system, body } = parseTemplate(template);
  let out = body;
  for (const k of SLOTS) {
    if (!(k in vals)) throw new Error(`compact prompt: missing value for {{${k}}}`);
    out = out.split(`{{${k}}}`).join(vals[k]);
  }
  const leftover = out.match(/\{\{([A-Z_]+)\}\}/);
  if (leftover) throw new Error(`compact prompt: unknown placeholder {{${leftover[1]}}}`);
  // Trailing newline trimmed so a template file (which ends with one) renders
  // byte-identically to the string concatenation this replaced — v1 has to be a
  // faithful control, not a nearly-faithful one.
  return { system, user: out.replace(/\s+$/, '') };
}

function loadTemplate(file) {
  return fs.readFileSync(file, 'utf8');
}

module.exports = { render, parseTemplate, loadTemplate, SLOTS };
