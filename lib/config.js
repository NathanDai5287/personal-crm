'use strict';
// Single source of truth for the personal-crm pipeline. Every script/tool should
// pull paths and constants from here instead of hardcoding them, so the whole
// pipeline can be relocated or reconfigured by editing exactly one file.
const path = require('path');
const { ROOT } = require('./env'); // loads .env and resolves the repo root

const DATA_DIR = path.posix.join(ROOT, 'data');
const CONTACTS_DIR = path.posix.join(DATA_DIR, 'contacts');
const GROUPS_DIR = path.posix.join(DATA_DIR, 'groups');
const REFRESH_DIR = path.posix.join(CONTACTS_DIR, '_refresh');
const BACKUP_DIR = path.posix.join(DATA_DIR, '_compact-backup');

const CRM_DB = path.posix.join(DATA_DIR, 'crm.db');
const TRACKED = path.posix.join(DATA_DIR, 'crm-tracked.json');
const TRACKED_GROUPS = path.posix.join(DATA_DIR, 'crm-tracked-groups.json');
const NICKNAMES = path.posix.join(DATA_DIR, 'crm-nicknames.json');
// Same-person, multiple Signal identities. Maps a contact's CANONICAL serviceId
// to older/alternate ones (e.g. after re-registering with a new number), so a
// split history is treated as one contact by resolveSources. Absent file = none.
const ALIASES = path.posix.join(DATA_DIR, 'crm-aliases.json');
const REFRESH_STATE = path.posix.join(DATA_DIR, 'crm-refresh-state.json');
const ARCHIVE_STATE = path.posix.join(DATA_DIR, 'crm-archive-state.json');
const COMPACT_STATE = path.posix.join(DATA_DIR, 'crm-compact-state.json');
// Self-calibrating cost model (lib/cost.js). COST_SAMPLES is an append-only ledger
// of (input-token base, real billed USD) pairs harvested from actual merges;
// COST_MODEL holds the coefficients (effective turns + output tokens per model)
// fitted to them, so estimates track what the model ACTUALLY costs instead of the
// hardcoded guesses. Both live in data/ (per-machine, never committed).
const COST_SAMPLES = path.posix.join(DATA_DIR, 'crm-cost-samples.jsonl');
const COST_MODEL = path.posix.join(DATA_DIR, 'crm-cost-model.json');

// Machine-specific paths — set in .env (see .env.example). The defaults are the
// original Windows install locations so this checkout keeps working if .env is
// ever absent; on macOS/Linux you MUST override CRM_SIGNAL_DB / CRM_PI_CLI.
const SIGNAL_DB = process.env.CRM_SIGNAL_DB || 'C:/Users/natha/AppData/Roaming/Signal/sql/db.sqlite';
// Known-good Signal DB cipher key, as of migration time. lib/signal-key.js can
// attempt to rederive the current key from Signal's config.json (via Windows
// DPAPI) in case Signal ever rotates it; this file is the fallback/seed. It
// lives in data/ (never committed to the code repo) — a hardcoded constant
// here would leak the key to anywhere the code is pushed.
const SIGNAL_KEY_FALLBACK = (() => {
  try { return require('fs').readFileSync(path.posix.join(DATA_DIR, 'signal-key.txt'), 'utf8').trim() || null; } catch { return null; }
})();
// Nathan's own Signal serviceId — the sourceServiceId on every OUTGOING message.
// Used to attribute speakers and to identify "the other party" in group chats.
const MY_SERVICE_ID = '7544be1b-d515-455f-a210-a050a04f7ef6';
// The old OpenClaw bot's Signal serviceId. It is still a member of some group
// conversations (e.g. "Nat & Kat"), so it must be excluded when deciding who a
// group's "other party" is, and its messages are dropped from ledgers.
const BOT_SERVICE_ID = '159bb267-7503-4af8-8886-e387c1a69392';

const PI_CLI = process.env.CRM_PI_CLI || 'C:/Users/natha/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js';

// SECONDARY-DEVICE ARCHIVE OFFSET. When this machine's archive was seeded by
// COPYING another device's crm.db (the DUNA->MINMUS migration), the copied rows
// are keyed by the ORIGINAL device's Signal rowids. This machine's own Signal DB
// numbers the same messages differently, so mirroring its sweeps at raw rowids
// would collide with the copied ids. Setting CRM_ARCHIVE_ID_OFFSET makes every
// message this machine mirrors store at id = signal_rowid + offset — a disjoint
// band above the copied ids and below the reuse SYNTH_BAND (1e9). Combined with
// content-dedup in lib/archive.js (a message already present by sent_at+type is
// skipped), re-sweeping the overlap is a no-op and only genuinely-new messages
// land. 0 = off (a primary device that owns its own rowids, e.g. DUNA).
const ARCHIVE_ID_OFFSET = Number(process.env.CRM_ARCHIVE_ID_OFFSET) || 0;

// GATED INGEST POLICY (steady-state cadence + backfill bucketing). The decision
// to merge lives in the planner (crm-refresh), not the scheduler: on each run a
// contact merges only once it has accumulated >= INGEST_N unmerged messages and
// the floor has elapsed, or the ceiling forces it. Because the rule is a pure
// function of (backlog, last-merge time, effective date), a from-scratch backfill
// emits the identical merge sequence as running it forward day by day (the
// BACKFILL == PLAY-IT-FORWARD invariant — see AGENTS.md and lib/weeks gateBuckets)
// — so the cron stays dumb (it just runs; the logic decides). Overridable per-run
// via env.
//
// WHY 200 / 7 / 30: chosen with the interactive cadence simulator against the real
// message history. Floor 7d keeps the weekly rhythm as a MINIMUM; ceiling 30d caps
// how stale a quiet contact's profile gets; N=200 is where a full-archive backfill
// drops from ~390 merges (one-per-active-week) to ~213 — a ~45% cost cut — without
// materially worsening median freshness (the savings come off the long quiet tail,
// not the busy contacts). Retune with the simulator if the roster's volume shifts.
const INGEST_N = Number(process.env.CRM_INGEST_N) || 200;          // message cutoff
const INGEST_FLOOR_DAYS = Number(process.env.CRM_INGEST_FLOOR_DAYS) || 7;   // min days between merges
const INGEST_CEILING_DAYS = Number(process.env.CRM_INGEST_CEILING_DAYS) || 30; // force a merge by this age

// ---- models -------------------------------------------------------------------
// The pipeline runs the model in TWO very different shapes, so each gets its own
// setting. Format: 'provider/model-id' (optionally ':<thinking>'), passed to
// pi's --model. This is what makes the pipeline model-agnostic.
//
//   MERGE_MODEL   — crm-merge.js. Reads a whole profile + a message ledger and
//                   rewrites What I know / Talking points / Open questions with
//                   ⟨m…⟩ citations, using the read+edit tools, while leaving the
//                   ## Timeline block untouched. This is the judgment-heavy step
//                   (what is worth remembering about a person) and the one whose
//                   output you actually read. Spend here.
//   COMPACT_MODEL — crm-compact.js. Condenses one day's or one week's messages
//                   into a single Timeline line, no tools, short output. Mostly
//                   mechanical — a cheaper model is a reasonable trade. NOTE it
//                   must still copy ⟨m…⟩ ids verbatim (see prompt in summarize()),
//                   so it is not purely mechanical; crm-daily validates the
//                   resulting Timeline citations after compaction.
//
// Both are overridable per-invocation via env (CRM_MERGE_MODEL /
// CRM_COMPACT_MODEL) so a single contact can be A/B'd against another model
// without editing this file:
//   CRM_MERGE_MODEL=moonshotai/kimi-k3 node scripts/crm-daily.js --only <slug>
//
// AUTH: anthropic/* models use `pi`'s Claude-subscription auth (done 2026-07-24
// via pi's interactive `/login`; see ~/.pi/agent/auth.json) and cost nothing
// per token. moonshotai/* models bill per token and need MOONSHOT_API_KEY in the
// environment — so switching a step to Kimi opens a real bill. If Anthropic auth
// is ever lost, re-login the same way or set ANTHROPIC_API_KEY /
// ANTHROPIC_OAUTH_TOKEN (the dry-run ledger step needs no auth at all).
//
// Known-good alternatives: 'moonshotai/kimi-k3' (1M context, 131K max output,
// reasoning + images — requires pi >= 0.83.0, which is where its model catalog
// first carries a k3 entry; 0.81.1 resolves only the k2.x line. Verified against
// the installed 0.83.0 + Moonshot key on 2026-08-02), 'moonshotai/kimi-k2.6'
// (256K, ~6x cheaper than Opus 5), 'moonshotai/kimi-k2.7-code-highspeed'
// (smoke-tested end-to-end 2026-07-23).
//
// NOTE the 1M context on k3 does not obsolete week-chunking: chunks exist to keep
// each merge's JUDGMENT tractable and its git commit reviewable, not because the
// ledger wouldn't fit. Bigger context buys headroom, not a reason to stop.
// Kimi K3 (moonshotai) is the pipeline default — bills per token (needs
// MOONSHOT_API_KEY), unlike the anthropic/* subscription which is $0. Chosen so
// a backfill matches playing-forward on the same model. Override per-invocation
// with CRM_MERGE_MODEL / CRM_COMPACT_MODEL (e.g. anthropic/claude-opus-5 for a
// free run).
const MERGE_MODEL = process.env.CRM_MERGE_MODEL || 'moonshotai/kimi-k3';
const COMPACT_MODEL = process.env.CRM_COMPACT_MODEL || 'moonshotai/kimi-k3';
// Deprecated single-model alias, kept so any older script/tool still resolves.
const MODEL = MERGE_MODEL;

const LOGS_DIR = path.posix.join(ROOT, 'logs');
const MERGE_PROMPT = path.posix.join(ROOT, 'prompts', 'merge.md');
// The compaction prompt was a string literal in crm-compact.js until it became
// clear it is the higher-stakes of the two: compaction REPLACES raw message
// lines that are then dropped from the profile, so unlike a merge it cannot be
// re-run from the archive. Overridable so evals/ can point at a candidate.
const COMPACT_PROMPT = process.env.CRM_COMPACT_PROMPT || path.posix.join(ROOT, 'prompts', 'compact.md');
const GITDIR = path.posix.join(ROOT, '.memory-history.git');

// Local profile-viewer web app (scripts/crm-web.js). Serves the rendered
// contact profiles at http://localhost:WEB_PORT behind HTTP basic auth.
// Local-only by default. The password is read from env CRM_WEB_PASSWORD, else
// from WEB_PASSWORD_FILE; if neither exists the server generates a random one,
// writes it to WEB_PASSWORD_FILE, and prints it once on startup.
const WEB_PORT = Number(process.env.CRM_WEB_PORT) || 8787;
const WEB_USER = process.env.CRM_WEB_USER || 'natha';
const WEB_PASSWORD_FILE = path.posix.join(DATA_DIR, 'web-password.txt');

module.exports = {
  ROOT,
  DATA_DIR,
  CONTACTS_DIR,
  GROUPS_DIR,
  REFRESH_DIR,
  BACKUP_DIR,
  CRM_DB,
  TRACKED,
  TRACKED_GROUPS,
  NICKNAMES,
  ALIASES,
  REFRESH_STATE,
  ARCHIVE_STATE,
  COMPACT_STATE,
  COST_SAMPLES,
  COST_MODEL,
  SIGNAL_DB,
  SIGNAL_KEY_FALLBACK,
  MY_SERVICE_ID,
  BOT_SERVICE_ID,
  PI_CLI,
  ARCHIVE_ID_OFFSET,
  INGEST_N,
  INGEST_FLOOR_DAYS,
  INGEST_CEILING_DAYS,
  MERGE_MODEL,
  COMPACT_MODEL,
  MODEL,
  LOGS_DIR,
  MERGE_PROMPT,
  COMPACT_PROMPT,
  GITDIR,
  WEB_PORT,
  WEB_USER,
  WEB_PASSWORD_FILE,
};
