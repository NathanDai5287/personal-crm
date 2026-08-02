'use strict';
// Single source of truth for the personal-crm pipeline. Every script/tool should
// pull paths and constants from here instead of hardcoding them, so the whole
// pipeline can be relocated or reconfigured by editing exactly one file.
const path = require('path');

const ROOT = 'C:/Users/natha/Programming/personal-crm';

const DATA_DIR = path.posix.join(ROOT, 'data');
const CONTACTS_DIR = path.posix.join(DATA_DIR, 'contacts');
const GROUPS_DIR = path.posix.join(DATA_DIR, 'groups');
const REFRESH_DIR = path.posix.join(CONTACTS_DIR, '_refresh');
const BACKUP_DIR = path.posix.join(DATA_DIR, '_compact-backup');

const CRM_DB = path.posix.join(DATA_DIR, 'crm.db');
const TRACKED = path.posix.join(DATA_DIR, 'crm-tracked.json');
const TRACKED_GROUPS = path.posix.join(DATA_DIR, 'crm-tracked-groups.json');
const NICKNAMES = path.posix.join(DATA_DIR, 'crm-nicknames.json');
const REFRESH_STATE = path.posix.join(DATA_DIR, 'crm-refresh-state.json');
const ARCHIVE_STATE = path.posix.join(DATA_DIR, 'crm-archive-state.json');
const COMPACT_STATE = path.posix.join(DATA_DIR, 'crm-compact-state.json');

const SIGNAL_DB = 'C:/Users/natha/AppData/Roaming/Signal/sql/db.sqlite';
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

const PI_CLI = 'C:/Users/natha/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js';

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
// Known-good alternatives: 'moonshotai/kimi-k3' (1M context, always-on
// reasoning), 'moonshotai/kimi-k2.6' (256K, ~6x cheaper than Opus 5),
// 'moonshotai/kimi-k2.7-code-highspeed' (smoke-tested end-to-end 2026-07-23).
const MERGE_MODEL = process.env.CRM_MERGE_MODEL || 'anthropic/claude-opus-5';
const COMPACT_MODEL = process.env.CRM_COMPACT_MODEL || 'anthropic/claude-opus-5';
// Deprecated single-model alias, kept so any older script/tool still resolves.
const MODEL = MERGE_MODEL;

const LOGS_DIR = path.posix.join(ROOT, 'logs');
const MERGE_PROMPT = path.posix.join(ROOT, 'prompts', 'merge.md');
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
  REFRESH_STATE,
  ARCHIVE_STATE,
  COMPACT_STATE,
  SIGNAL_DB,
  SIGNAL_KEY_FALLBACK,
  MY_SERVICE_ID,
  BOT_SERVICE_ID,
  PI_CLI,
  MERGE_MODEL,
  COMPACT_MODEL,
  MODEL,
  LOGS_DIR,
  MERGE_PROMPT,
  GITDIR,
  WEB_PORT,
  WEB_USER,
  WEB_PASSWORD_FILE,
};
