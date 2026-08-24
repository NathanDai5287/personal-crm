'use strict';
// lib/censor-hold.js — per-contact "held for censor review" state.
//
// WHY. When a model provider rejects a merge chunk on content grounds (HTTP 400
// content_filter), we do NOT auto-guess a replacement. Nathan's call: he chooses the
// masking wording himself. So instead of learning-and-retrying, the whole rejected chunk
// is PARKED here and the contact is HELD:
//   - crm-daily skips a held contact (its cursor stays put — nothing is lost);
//   - ingest resumes for them only after Nathan adds a censor rule (lib/redact) and
//     releases the hold (scripts/crm-censor.js).
// The hold IS the presence of the review file — one artifact per held contact, no extra
// index to keep in sync. The file holds the UNCENSORED chunk on purpose: the entire point
// is for Nathan to SEE the offending words and decide how to mask them. It therefore must
// never enter the memory history (excluded in scripts/memory-commit.js).
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { fmtLocal } = require('./weeks');

const DIR = path.join(DATA_DIR, 'censor-review');
const fileFor = (slug) => path.join(DIR, `${slug}.txt`);

function isHeld(slug) {
  try { return fs.existsSync(fileFor(slug)); } catch { return false; }
}

// Every currently-held slug (the review dir's *.txt files).
function held() {
  try { return fs.readdirSync(DIR).filter((f) => f.endsWith('.txt')).map((f) => f.slice(0, -4)); }
  catch { return []; }
}

// Park a rejected chunk and hold the contact. `chunk` is the full uncensored ledger the
// provider rejected; `error` is the provider's message. Overwrites any prior hold for the
// slug (the newest rejection is the one worth looking at). Returns the file path.
function hold(slug, chunk, error, nowMs) {
  fs.mkdirSync(DIR, { recursive: true });
  const when = fmtLocal(nowMs != null ? nowMs : Date.now());
  const header = [
    '# HELD FOR CENSOR REVIEW',
    `# slug:  ${slug}`,
    `# held:  ${when} Pacific`,
    `# error: ${String(error || '').replace(/\s+/g, ' ').slice(0, 300)}`,
    '#',
    '# A model provider rejected this chunk on content grounds. Find the offending',
    '# word(s) below and choose how to mask them yourself, then release the hold:',
    `#   node scripts/crm-censor.js resolve ${slug} <word> <replacement...>`,
    '# (or, for a regex/substring rule, use node lib/redact.js add-regex ... then',
    `#  node scripts/crm-censor.js release ${slug}). The next ingest re-merges them.`,
    `# ${'-'.repeat(70)}`,
    '',
  ].join('\n');
  const target = fileFor(slug);
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, header + String(chunk == null ? '' : chunk));
  fs.renameSync(tmp, target);
  return target;
}

function release(slug) {
  try { fs.unlinkSync(fileFor(slug)); return true; } catch { return false; }
}

module.exports = { DIR, fileFor, isHeld, held, hold, release };
