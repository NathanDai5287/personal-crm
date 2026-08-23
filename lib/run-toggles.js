'use strict';
// lib/run-toggles.js — per-job on/off switches for the periodic runs.
//
// A tiny JSON state file the web UI writes and the job scripts read, so a
// scheduled PAID run can be PAUSED without touching the scheduler (systemd timer /
// Task Scheduler / cron). Only the two model jobs have a switch:
//   ingest — crm-daily.js  (merge + Timeline); pausing avoids spend.
//   todo   — crm-todo-scan.js; pausing avoids the extraction call.
// The free sweeps (sweep / deep-sweep) are NOT gated here — they always run, since
// pausing archiving would risk losing disappearing messages for no cost saving.
// Timeline has NO switch — it is a step inside ingest (see lib/jobs.js), so the
// ingest switch pauses it too.
//
// SEMANTICS. A toggle gates AUTOMATIC runs only. A run started by hand from the
// web UI passes --force and always proceeds (the confirm modal already shows its
// cost), so the switch never blocks a deliberate click — it only pauses the
// unattended schedule. Absent/true = enabled (default, matches pre-toggle
// behaviour); false = paused. A paused job that would have found work does NOT
// advance its cursor, so nothing is lost — it catches up on the next run after
// you switch it back on.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { MODEL_JOBS } = require('./jobs');

const FILE = path.posix.join(DATA_DIR, 'crm-run-toggles.json');
// Only the PAID jobs carry a pause switch. The free sweeps are never gated here —
// pausing archiving would risk losing disappearing messages for no cost saving, so
// they always run. See lib/jobs.js.
const JOBS = MODEL_JOBS; // ['ingest','todo']

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

// { sweep: bool, 'deep-sweep': bool, ingest: bool, todo: bool } — every job resolved, default ON.
function getToggles() {
  const s = read();
  const out = {};
  for (const j of JOBS) out[j] = s[j] !== false;
  return out;
}

function isEnabled(job) { return read()[job] !== false; }

// THE ONE pause-gate every scheduled job shares, so the "does this run
// pause?" rule cannot drift per script (it did once: compact's gate only tripped
// under --write, so its timer dry-ran forever). A run pauses iff it is a real
// (non-dry-run) automatic run whose toggle is off. `--force` (a hand-started UI
// run) and `--dry-run` (a free preview) both fall through and proceed.
// Usage, identical in crm-daily / crm-todo-scan / crm-archive:
//   if (paused('ingest', { dryRun: DRY_RUN, force: FORCE })) { log(pauseMessage('ingest')); return; }
function paused(job, { dryRun = false, force = false } = {}) {
  return !dryRun && !force && !isEnabled(job);
}

function pauseMessage(job) {
  return `${job}: PAUSED via the web UI toggle — skipping (enable it in the UI, or pass --force).`;
}

function setToggle(job, enabled) {
  if (!JOBS.includes(job)) throw new Error(`unknown job: ${job}`);
  const s = read();
  s[job] = !!enabled;
  const tmp = `${FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, FILE);
  return getToggles();
}

module.exports = { JOBS, FILE, getToggles, isEnabled, setToggle, paused, pauseMessage };
