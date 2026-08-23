'use strict';
// lib/run-toggles.js — per-job on/off switches for the PAID (LLM) periodic runs.
//
// A tiny JSON state file the web UI writes and the paid scripts read, so a
// scheduled run that would spend money can be PAUSED without touching the
// scheduler (systemd timer / Task Scheduler / cron). The free archive sweep is
// never gated here — only the jobs that call a model:
//   ingest  — crm-daily.js  (merge + Timeline)
//   todo    — crm-todo-scan.js (the extraction model call; the regex scan stays free)
//   compact — crm-compact.js (standalone Timeline summaries, when on a paid model)
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

const FILE = path.posix.join(DATA_DIR, 'crm-run-toggles.json');
const JOBS = ['ingest', 'todo', 'compact'];

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

// { ingest: bool, todo: bool, compact: bool } — every job resolved, default ON.
function getToggles() {
  const s = read();
  const out = {};
  for (const j of JOBS) out[j] = s[j] !== false;
  return out;
}

function isEnabled(job) { return read()[job] !== false; }

// THE ONE pause-gate every scheduled model job shares, so the "does this run
// pause?" rule cannot drift per script (it did once: compact's gate only tripped
// under --write, so its timer dry-ran forever). A run pauses iff it is a real
// (non-dry-run) automatic run whose toggle is off. `--force` (a hand-started UI
// run) and `--dry-run` (a free preview) both fall through and proceed.
// Usage, identical in crm-daily / crm-todo-scan / crm-compact:
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
