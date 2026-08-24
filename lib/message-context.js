'use strict';
// lib/message-context.js — the ONE place a message becomes readable context, so
// ingest, the Timeline, todo, and the UI all see the same thing.
//
// TWO LAYERS (see docs/ENGINEERING-LOG.md and AGENTS.md):
//   Layer 1 — ORIGINAL: the message as stored in crm.db — the sender's typed text
//     already carrying the sweep-time enrichments ([photo], [link: …], [re …],
//     quote/call text) — plus the real audio/video/image/file blobs on disk. The
//     permanent record; what ⟨m…⟩ citations point at.
//   Layer 2 — RENDERED: Layer 1 + machine OCR + speech-to-text folded in. Computed
//     ON READ (never stored), and it is what BOTH the models and the UI read.
//
// CENSORING IS NOT A LAYER. redact() (lib/redact) masks slurs ONLY to keep a model
// provider's content filter from rejecting a chunk. It applies at MODEL EGRESS —
// forModel() below, called at the boundary where text is handed to a provider —
// never to the UI or the stored record. So the UI shows Rendered uncensored, with a
// click-through to the Original (unredacted text / the media file); the model sees
// Rendered, then censored on the way out.
const { fmtLocal } = require('./weeks');
const { redact } = require('./redact');
const { foldSuffix } = require('./media');

// RENDERED body for one archived message row (needs `body` + `att_hashes`). Uncensored.
// `msg` is a crm.db `messages` row: { body, att_hashes, ... }. `cdb` is the archive
// handle (foldSuffix reads media_text). Whitespace-collapsed to one line, like the
// ledger has always been.
function renderedBody(cdb, msg) {
  const base = String(msg.body == null ? '' : msg.body).replace(/\s+/g, ' ').trim();
  return base + foldSuffix(cdb, msg.att_hashes);
}

// The canonical ledger LINE shape every model reader and the on-disk record share:
//   [YYYY-MM-DD HH:MM] ⟨m123⟩ (Group) Sender: <rendered body>
// `body` is a pre-rendered Rendered body (pass renderedBody()'s result); `prefix` is
// the optional group label with its trailing space; `sender` is the speaker label.
// Pure formatting — no DB, no censoring.
function formatLine({ sentAt, rid, prefix = '', sender, body }) {
  return `[${fmtLocal(sentAt)}] ⟨m${rid}⟩ ${prefix}${sender}: ${body}`;
}

// MODEL EGRESS: censor a Rendered string (a line, or a whole ledger) at the moment it
// is handed to a model provider. The only place slur-masking happens.
function forModel(text) {
  return redact(String(text == null ? '' : text));
}

module.exports = { renderedBody, formatLine, forModel };
