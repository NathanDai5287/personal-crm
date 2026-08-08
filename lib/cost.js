'use strict';
// lib/cost.js — one place that turns "how much model work" into "how many dollars".
//
// IMPORTANT: this is an ESTIMATE, never a bill. The pipeline captures no real
// usage — crm-merge runs pi with --no-session and streams its output straight to
// the monitor, so token counts are never read back. So we price from the same
// inputs evals/estimate.js does (chars/2.4 tokens, pi's own model catalog), and
// every surface that shows a number labels it "est.".
//
// WHY CALL COUNT DOMINATES: each agentic turn re-sends the system prompt + the
// whole profile + pi's tool scaffold, and the merge loops 2-4 turns. For a normal
// week that fixed payload dwarfs the ledger, so cost tracks the NUMBER of model
// calls far more than the number of messages. A 1-message week and a 200-message
// week cost nearly the same. That is why the dashboard estimate counts active
// weeks (one merge call each), not messages.
//
// AUTH: anthropic/* models bill $0 (Claude subscription auth); moonshotai/* bill
// per token. isFree() encodes that split, matching lib/config.js.
const fs = require('fs');
const path = require('path');
const { MERGE_PROMPT, COMPACT_PROMPT } = require('./config');
const { weekStart } = require('./weeks');

const STORE = path.join(process.env.USERPROFILE || process.env.HOME || '', '.pi', 'agent', 'models-store.json');

// Kept identical to lib/weeks.js so chunk planning and cost estimation never
// disagree about what a token is.
const CHARS_PER_TOKEN = 2.4;

// evals/estimate.js's assumptions, collapsed to a single representative midpoint
// so one headline figure can stand in for its low/high band. The band still
// lives in estimate.js for planning a large backfill.
const SCAFFOLD = 2_000;      // pi tool schemas + agent preamble, per turn
const MERGE_TURNS = 3;       // agentic read+edit loop (estimate.js: 2-4)
const MERGE_OUT = 5_000;     // output incl. reasoning (estimate.js: 2,500-9,000)
const COMPACT_OUT = 300;     // one short timeline line + light reasoning
const LINE_OVERHEAD_CHARS = 41; // ledger line prefix, per lib/weeks.js
const DEFAULT_PROFILE_TOK = 1_600; // a mid-size profile, re-sent each merge turn

function tok(s) { return Math.round(String(s).length / CHARS_PER_TOKEN); }
function isFree(model) { return String(model || '').startsWith('anthropic/'); }

// System-prompt sizes, read once from the actual prompt files.
let _sys = null;
function sysTokens() {
  if (_sys) return _sys;
  const read = (p, fallback) => { try { return tok(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
  _sys = { merge: read(MERGE_PROMPT, 2_700), compact: read(COMPACT_PROMPT, 300) };
  return _sys;
}

// { input, output } dollars-per-million, or { free:true } for subscription auth,
// or null when the model isn't in pi's catalog (caller shows "—").
let _store = null;
function priceOf(model) {
  if (isFree(model)) return { input: 0, output: 0, free: true };
  const id = String(model || '').split('/').pop();
  try {
    if (!_store) _store = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    let found = null;
    const walk = (o) => {
      if (Array.isArray(o)) return o.forEach(walk);
      if (o && typeof o === 'object') { if (o.id === id && o.cost) found = o; Object.values(o).forEach(walk); }
    };
    walk(_store);
    if (found && found.cost) return { input: found.cost.input, output: found.cost.output, free: false };
  } catch { /* no catalog on this box */ }
  return null;
}

// One merge (ingest) model call. Returns dollars, 0 for free models, or null if
// the price is unknown.
function mergeCallUsd(model, opts = {}) {
  const p = priceOf(model);
  if (!p) return null;
  if (p.free) return 0;
  const profileTok = opts.profileTokens != null ? opts.profileTokens : DEFAULT_PROFILE_TOK;
  const ledgerTok = opts.ledgerTokens || 0;
  const perTurn = sysTokens().merge + profileTok + ledgerTok + SCAFFOLD + 100;
  return (perTurn * MERGE_TURNS * p.input + MERGE_OUT * p.output) / 1e6;
}

// One compact (timeline) or todo model call — single-shot, no tools, short out.
function compactCallUsd(model, opts = {}) {
  const p = priceOf(model);
  if (!p) return null;
  if (p.free) return 0;
  const perTurn = sysTokens().compact + (opts.bucketTokens != null ? opts.bucketTokens : 800) + SCAFFOLD + 100;
  return (perTurn * p.input + (opts.out != null ? opts.out : COMPACT_OUT) * p.output) / 1e6;
}

// ---- DURATION estimation -------------------------------------------------------
// Calibrated against a real K3 backfill (per-chunk git-commit timings): each merge
// is dominated by a fixed model-latency/reasoning cost with a sub-linear ledger
// term, so a base + capped-linear fit tracks the median well. Duration is noisy
// (reasoning time varies run to run) — this is a ballpark, shown as "~Xm".
const MERGE_BASE_SEC = 22;
const MERGE_SEC_PER_TOK = 0.011;
const MERGE_TOK_CAP = 8_000;   // beyond this the model reads more but doesn't take proportionally longer
const COMPACT_SEC = 9;         // one short summary call

function mergeCallSeconds(opts = {}) {
  return MERGE_BASE_SEC + Math.min(opts.ledgerTokens || 0, MERGE_TOK_CAP) * MERGE_SEC_PER_TOK;
}
function compactCallSeconds() { return COMPACT_SEC; }

// Sum an array of already-planned chunks ({ tokens }) into a merge-side cost.
// Returns null if the model price is unknown.
function ingestUsd(model, chunks, opts = {}) {
  if (isFree(model)) return 0;
  if (!chunks || !chunks.length) return 0;
  let sum = 0;
  for (const c of chunks) {
    const v = mergeCallUsd(model, { ledgerTokens: c.tokens || 0, profileTokens: opts.profileTokens });
    if (v == null) return null;
    sum += v;
  }
  return sum;
}

// Estimate the cost of ingesting a contact's WAITING messages, from lightweight
// rows { sent_at, blen } (blen = byte/char length of the message body). Buckets
// by Pacific week (one merge call per active week, matching planChunks maxWeeks:1)
// and adds a compact call per active week for the Timeline half — so one figure
// covers the whole combined "Ingest" job. Returns { calls, usd|null }.
function estIngestFromRows(mergeModel, compactModel, rows) {
  if (!rows || !rows.length) return { calls: 0, usd: 0 };
  const byWeek = new Map();
  for (const r of rows) {
    const ws = weekStart(r.sent_at);
    const b = byWeek.get(ws) || { chars: 0 };
    b.chars += (r.blen || 0) + LINE_OVERHEAD_CHARS;
    byWeek.set(ws, b);
  }
  const weeks = [...byWeek.values()];
  const calls = weeks.length;
  let usd = 0;
  let seconds = 0;
  let known = true;
  for (const w of weeks) {
    const ledgerTok = Math.round(w.chars / CHARS_PER_TOKEN);
    const m = mergeCallUsd(mergeModel, { ledgerTokens: ledgerTok });
    const c = compactCallUsd(compactModel, { bucketTokens: Math.min(ledgerTok, 4_000) });
    if (m == null || c == null) known = false;
    else usd += m + c;
    // Duration is model-independent here (latency-bound), so it's always known;
    // the merge plus its Timeline summary run back-to-back for this week.
    seconds += mergeCallSeconds({ ledgerTokens: ledgerTok }) + compactCallSeconds();
  }
  return { calls, usd: known ? usd : null, seconds };
}

// ACTUAL (post-run) cost, read back from a pi session directory. pi records real
// per-turn usage — including a computed cost.total in the model's own prices
// (cache reads/writes included) — into each assistant message of the session
// JSONL. Summing cost.total across every turn in every session file under `dir`
// is the true billed cost of that run, not an estimate. Returns { costUsd, turns }
// or null when the dir has no usage to read (unreadable, empty, or a model that
// reported none). crm-merge writes to a throwaway session dir under data/ purely
// to read this back, then deletes it — production is otherwise --no-session.
function sumSessionCostUsd(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return null; }
  if (!files.length) return null;
  let total = 0;
  let turns = 0;
  let saw = false;
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const ln of text.split(/\r?\n/)) {
      if (!ln) continue;
      let o;
      try { o = JSON.parse(ln); } catch { continue; }
      const u = (o.message && o.message.usage) || o.usage;
      if (u && u.cost && typeof u.cost.total === 'number') { total += u.cost.total; turns += 1; saw = true; }
    }
  }
  return saw ? { costUsd: total, turns } : null;
}

// Format a dollar amount for a UI cell. free:true (subscription) reads "$0 · sub"
// so the reason it's free is legible; null reads "—".
function fmtUsd(v, opts = {}) {
  if (opts.free) return '$0 · sub';
  if (v == null) return '—';
  if (v === 0) return '$0';
  if (v < 0.01) return '<$0.01';
  if (v < 10) return `$${v.toFixed(2)}`;
  if (v < 100) return `$${v.toFixed(1)}`;
  return `$${v.toFixed(0)}`;
}

// Human duration for a UI cell: "45s", "6m", "1h 5m". null → "—".
function fmtDur(sec) {
  if (sec == null) return '—';
  sec = Math.round(sec);
  if (sec < 90) return `${sec}s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

module.exports = {
  CHARS_PER_TOKEN, tok, isFree, priceOf,
  mergeCallUsd, compactCallUsd, mergeCallSeconds, compactCallSeconds,
  ingestUsd, estIngestFromRows, fmtUsd, fmtDur,
  sumSessionCostUsd,
};
