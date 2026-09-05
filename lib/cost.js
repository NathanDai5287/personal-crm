'use strict';
// lib/cost.js — one place that turns "how much model work" into "how many dollars".
//
// IMPORTANT: this is an ESTIMATE, never a bill, so every surface that shows a number
// labels it "est.". We price a run by counting the model CALLS it will make and
// pricing each against pi's own model catalog (chars/2.4 tokens for sizes).
//
// TWO ESTIMATES, ONE TRUTH. The call COUNT comes from replaying the real ingest gate
// (estIngestFromRows -> lib/weeks gateBuckets + planChunks), so it matches what the
// pipeline will actually do rather than a one-merge-per-week proxy. The per-call
// PRICE is self-calibrating: crm-daily records (input base, real billed USD) pairs
// from actual merges and fitCostModel() fits the two unknowns that dominate a bill —
// effective agentic turns and output+reasoning tokens — per model (see the fit block
// below). Until a model has enough samples we fall back to evals/estimate.js's
// midpoint guesses (3 turns / 5,000 out).
//
// WHY CALL COUNT DOMINATES: each agentic turn re-sends the system prompt + the whole
// profile + pi's tool scaffold, and the merge loops a few turns. That fixed payload
// dwarfs the ledger, so cost tracks the NUMBER of merges far more than the number of
// messages — a 1-message merge and a 200-message merge cost nearly the same.
//
// AUTH: anthropic/* models bill $0 (Claude subscription auth); moonshotai/* bill
// per token. isFree() encodes that split, matching lib/config.js.
const fs = require('fs');
const path = require('path');
const {
  MERGE_PROMPT, TIMELINE_PROMPT, COST_SAMPLES, COST_MODEL,
  INGEST_N, INGEST_FLOOR_DAYS, INGEST_CEILING_DAYS,
} = require('./config');
const { gateBuckets, planChunks, lastCompleteWeekStart } = require('./weeks');
const { writeJsonAtomic } = require('./atomic-write');

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
const TIMELINE_OUT = 300;     // one short timeline line + light reasoning
const DEFAULT_PROFILE_TOK = 1_600; // a mid-size profile, re-sent each merge turn

function tok(s) { return Math.round(String(s).length / CHARS_PER_TOKEN); }
function isFree(model) { return String(model || '').startsWith('anthropic/'); }

// System-prompt sizes, read once from the actual prompt files.
let _sys = null;
function sysTokens() {
  if (_sys) return _sys;
  const read = (p, fallback) => { try { return tok(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
  _sys = { merge: read(MERGE_PROMPT, 2_700), timeline: read(TIMELINE_PROMPT, 300) };
  return _sys;
}

// { input, output } dollars-per-million, or { free:true } for subscription auth,
// or null when the model isn't in pi's catalog (caller shows "—").
let _store = null;
function priceOf(model) {
  if (isFree(model)) return { input: 0, output: 0, free: true };
  // Strip a trailing `:<thinking>` variant so "kimi-k3:thinking" still matches the
  // catalog id "kimi-k3" (config allows the ':<thinking>' suffix) instead of
  // falling through to null and rendering "—".
  const id = String(model || '').split('/').pop().split(':')[0];
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

// Per-turn INPUT tokens for one merge: the fixed payload (system prompt + profile +
// ledger + tool scaffold) re-sent on every agentic turn. Billed input ≈ this × the
// turn count, which is what the fit below actually learns.
function mergeInputBase(opts = {}) {
  const profileTok = opts.profileTokens != null ? opts.profileTokens : DEFAULT_PROFILE_TOK;
  return sysTokens().merge + (opts.ledgerTokens || 0) + profileTok + SCAFFOLD + 100;
}

// ---- self-calibrating fit ------------------------------------------------------
// Two things dominate a real bill and neither is knowable up front: how many
// agentic turns the merge loops (input is re-sent each turn) and how many
// output+reasoning tokens it emits. Rather than freeze evals/estimate.js's guesses
// (3 turns / 5,000 out) for every model forever, we harvest (base, real-USD) pairs
// from ACTUAL merges — recordCostSample(), called by crm-daily whenever pi reports a
// real cost — and least-squares fit, per model,
//     usd ≈ A·base + B      with A = price_in·turns, B = price_out·out
// so turns = A/price_in and out = B/price_out become measured, model-specific
// coefficients. Re-fitting after each run (fitCostModel) keeps them current as
// prompts and models drift. Until a model has enough samples we keep the defaults.
let _fit = null;
function loadFit() {
  if (_fit) return _fit;
  try { _fit = JSON.parse(fs.readFileSync(COST_MODEL, 'utf8')) || {}; } catch { _fit = {}; }
  return _fit;
}

function recordCostSample(model, opts = {}) {
  if (opts.usd == null || isFree(model)) return;
  const row = JSON.stringify({ model, base: mergeInputBase(opts), usd: opts.usd, at: Date.now() });
  try { fs.appendFileSync(COST_SAMPLES, `${row}\n`); } catch { /* non-fatal telemetry */ }
}

const FIT_MIN_SAMPLES = 5; // fewer than this is noise — keep the estimate.js defaults

function fitCostModel() {
  let lines = [];
  try { lines = fs.readFileSync(COST_SAMPLES, 'utf8').split('\n').filter(Boolean); } catch { return loadFit(); }
  const byModel = {};
  for (const l of lines) {
    try { const s = JSON.parse(l); if (s && s.usd > 0 && s.base > 0) (byModel[s.model] = byModel[s.model] || []).push(s); } catch { /* skip bad line */ }
  }
  const fit = {};
  for (const [model, samples] of Object.entries(byModel)) {
    if (samples.length < FIT_MIN_SAMPLES) continue;
    const p = priceOf(model);
    if (!p || p.free || !p.input || !p.output) continue;
    const n = samples.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const s of samples) { sx += s.base; sy += s.usd; sxx += s.base * s.base; sxy += s.base * s.usd; }
    const denom = n * sxx - sx * sx;
    if (denom === 0) continue; // all samples share one base — can't separate slope/intercept
    // The priced equation is usd = (base·turns·price_in + out·price_out) / 1e6
    // (see mergeCallUsd), so the fitted slope/intercept are A = price_in·turns/1e6
    // and B = price_out·out/1e6. Invert WITH the 1e6, or `out` comes back ~1e6×
    // too small, rounds to 0, passes the bounds, and silently zeroes output cost
    // in every later estimate (and the fit feeds itself).
    const A = (n * sxy - sx * sy) / denom; // = price_in · turns / 1e6
    const B = (sy - A * sx) / n;           // = price_out · out / 1e6
    const turns = (A * 1e6) / p.input;
    const out = (B * 1e6) / p.output;
    // Accept the fit only if BOTH coefficients are sane; else keep BOTH defaults.
    // Accepting one and defaulting the other mixes a measured coefficient with a
    // guessed one into an incoherent price.
    const sane = turns >= 0.5 && turns <= 20 && out >= 0 && out <= 100_000;
    fit[model] = {
      turns: sane ? Number(turns.toFixed(2)) : MERGE_TURNS,
      out: sane ? Math.round(out) : MERGE_OUT,
      n,
      updatedAt: Date.now(),
    };
  }
  try { writeJsonAtomic(COST_MODEL, fit); } catch { /* non-fatal */ }
  _fit = fit;
  return fit;
}

// One merge (ingest) model call. Returns dollars, 0 for free models, or null if
// the price is unknown. Uses the fitted turns/out for this model when available,
// else evals/estimate.js's midpoint defaults.
function mergeCallUsd(model, opts = {}) {
  const p = priceOf(model);
  if (!p) return null;
  if (p.free) return 0;
  const f = loadFit()[model];
  const turns = f && f.turns ? f.turns : MERGE_TURNS;
  const out = f && f.out != null ? f.out : MERGE_OUT;
  return (mergeInputBase(opts) * turns * p.input + out * p.output) / 1e6;
}

// One single-shot short model call — a Timeline summary or a todo extraction.
// No tools, short output. Named generically because both callers share it.
function shortCallUsd(model, opts = {}) {
  const p = priceOf(model);
  if (!p) return null;
  if (p.free) return 0;
  const perTurn = sysTokens().timeline + (opts.bucketTokens != null ? opts.bucketTokens : 800) + SCAFFOLD + 100;
  return (perTurn * p.input + (opts.out != null ? opts.out : TIMELINE_OUT) * p.output) / 1e6;
}

// ---- DURATION estimation -------------------------------------------------------
// Calibrated against a real K3 backfill (per-chunk git-commit timings): each merge
// is dominated by a fixed model-latency/reasoning cost with a sub-linear ledger
// term, so a base + capped-linear fit tracks the median well. Duration is noisy
// (reasoning time varies run to run) — this is a ballpark, shown as "~Xm".
const MERGE_BASE_SEC = 22;
const MERGE_SEC_PER_TOK = 0.011;
const MERGE_TOK_CAP = 8_000;   // beyond this the model reads more but doesn't take proportionally longer
const TIMELINE_SEC = 9;         // one short summary call

function mergeCallSeconds(opts = {}) {
  return MERGE_BASE_SEC + Math.min(opts.ledgerTokens || 0, MERGE_TOK_CAP) * MERGE_SEC_PER_TOK;
}
function timelineCallSeconds() { return TIMELINE_SEC; }

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
// rows { sent_at, blen } (blen = char length of the body). Replays the REAL gate
// (lib/weeks gateBuckets) and the week/token chunker on those rows, so `calls` is
// the number of merges the pipeline will ACTUALLY make under the current policy —
// not the old one-merge-per-active-week proxy, which over-counted quiet rosters and
// under-counted the busiest contacts. rows carry no rowid, so we order by sent_at
// (an estimate can ignore the rare late-sync inversion). Adds one Timeline
// call per merge. Returns { calls, usd|null, seconds }; usd is null when the model
// price is unknown.
function estIngestFromRows(mergeModel, timelineModel, rows) {
  if (!rows || !rows.length) return { calls: 0, usd: 0, seconds: 0 };
  const msgs = rows.slice().sort((a, b) => a.sent_at - b.sent_at)
    .map((r, i) => ({ rid: i + 1, sent_at: r.sent_at, body: ' '.repeat(r.blen || 0) }));
  const buckets = gateBuckets(msgs, {
    N: INGEST_N, floorDays: INGEST_FLOOR_DAYS, ceilingDays: INGEST_CEILING_DAYS,
    endMs: lastCompleteWeekStart(Date.now()),
  });
  const chunks = buckets.flatMap((b) => planChunks(b));
  let usd = 0;
  let seconds = 0;
  let known = true;
  for (const c of chunks) {
    const m = mergeCallUsd(mergeModel, { ledgerTokens: c.tokens });
    const cp = shortCallUsd(timelineModel, { bucketTokens: Math.min(c.tokens, 4_000) });
    if (m == null || cp == null) known = false;
    else usd += m + cp;
    // Duration is model-independent (latency-bound), so always known; the merge plus
    // its Timeline summary run back-to-back per chunk.
    seconds += mergeCallSeconds({ ledgerTokens: c.tokens }) + timelineCallSeconds();
  }
  return { calls: chunks.length, usd: known ? usd : null, seconds };
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

// The model's REPLY text, read back from a pi session directory: every `text`
// block of every assistant message in the newest session file, concatenated in
// order. This is where the
// merge's final DONE/NO-OP line and its [[NICKNAMES]] block live — pi records the
// assistant turns as session JSONL, and the reply is never written to any file, so
// the transcript is the only place to read it back (production inherits stdout, so
// it can't be captured that way). Best-effort like sumSessionCostUsd: returns '' on
// an unreadable/empty dir. A retried merge leaves one session file per attempt;
// only the newest (successful) attempt is authoritative. Unioning attempts can
// leak a failed attempt's structured blocks into the successful commit.
function sessionAssistantText(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return ''; }
  files = files.map((f) => {
    try { return { f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.mtime - a.mtime || b.f.localeCompare(a.f));
  if (files.length) files = [files[0].f];
  const parts = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const ln of text.split(/\r?\n/)) {
      if (!ln) continue;
      let o;
      try { o = JSON.parse(ln); } catch { continue; }
      const m = (o && o.message) || o;
      if (!m || m.role !== 'assistant') continue;
      const content = m.content;
      if (typeof content === 'string') { parts.push(content); continue; }
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
        }
      }
    }
  }
  return parts.join('\n');
}

// Format a dollar amount for a UI cell. free:true (a subscription/anthropic run)
// reads "on plan" — it adds no metered per-token charge, but the Claude plan it
// rides is itself paid, so it is never labelled "free" or "$0". null reads "—".
function fmtUsd(v, opts = {}) {
  if (opts.free) return 'on plan';
  if (v == null || !Number.isFinite(v)) return '—'; // NaN/Infinity -> "—", never "$NaN"
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
  mergeCallUsd, shortCallUsd, mergeCallSeconds, timelineCallSeconds,
  ingestUsd, estIngestFromRows, fmtUsd, fmtDur,
  sumSessionCostUsd, sessionAssistantText,
  mergeInputBase, recordCostSample, fitCostModel, loadFit,
};
