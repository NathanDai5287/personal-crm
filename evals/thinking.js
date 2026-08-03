'use strict';
// evals/thinking.js — pull a model's reasoning out of a pi session directory.
//
// pi never prints thinking to stdout; it only persists it to the session JSONL,
// which is why the eval harness runs with --session-dir instead of --no-session.
//
// PROVIDER DIFFERENCE THAT MATTERS HERE: Anthropic returns thinking with an
// encrypted `thinkingSignature`, and the `thinking` text is a redacted summary.
// Moonshot returns `thinkingSignature: "reasoning_content"` with the raw chain in
// plaintext. So K3's traces are fully readable and Claude's are not — any
// comparison of *trace content* between the two is not apples-to-apples, and the
// absence of a finding on the Anthropic side is not evidence of absence.

const fs = require('fs');
const path = require('path');

// pi namespaces sessions by cwd under the dir it is given, so walk.
function sessionFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  })(dir);
  return out;
}

// Returns { blocks: [{ turn, model, provider, encrypted, text }], models, chars }.
function extractThinking(dir) {
  const blocks = [];
  const models = new Set();
  for (const f of sessionFiles(dir)) {
    let turn = 0;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const msg = o && o.message;
      if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
      turn += 1;
      if (msg.model) models.add(`${msg.provider || '?'}/${msg.model}`);
      for (const b of msg.content) {
        if (b && b.type === 'thinking' && b.thinking) {
          blocks.push({
            turn,
            model: msg.model || null,
            provider: msg.provider || null,
            // Moonshot's literal marker for "this is the raw chain, not a signature".
            encrypted: b.thinkingSignature !== 'reasoning_content',
            text: String(b.thinking),
          });
        }
      }
    }
  }
  return {
    blocks,
    models: [...models],
    chars: blocks.reduce((a, b) => a + b.text.length, 0),
  };
}

// Human/LLM-readable dump. Written per (variant, case) so a reviewing pass can
// be pointed at one file and cite turn numbers.
function formatTrace(meta, extracted) {
  const head = [
    `# thinking trace`,
    `case:      ${meta.case}`,
    `variant:   ${meta.variant}`,
    `model:     ${meta.model}`,
    `thinking:  ${meta.thinking || '(pi default)'}`,
    `blocks:    ${extracted.blocks.length}`,
    `chars:     ${extracted.chars}`,
    `readable:  ${extracted.blocks.some((b) => !b.encrypted) ? 'yes (plaintext reasoning)' : 'no (encrypted/summarised)'}`,
    '',
  ].join('\n');
  const body = extracted.blocks.map((b) => (
    `\n===== turn ${b.turn} · ${b.provider || '?'}/${b.model || '?'}`
    + `${b.encrypted ? ' · ENCRYPTED-OR-SUMMARY' : ' · RAW'} =====\n${b.text}\n`
  )).join('');
  return head + (body || '\n(no thinking blocks recorded)\n');
}

module.exports = { extractThinking, formatTrace, sessionFiles };
