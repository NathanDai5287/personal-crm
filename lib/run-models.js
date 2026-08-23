'use strict';
// lib/run-models.js — per-job model overrides chosen from the web UI.
//
// A sibling of lib/run-toggles.js: a small JSON state file (data/crm-run-models.json)
// the pipeline-desk dropdowns write and the model-calling scripts read at startup.
// Maps a job to a model id; absent = use the script's env/default. Only ids from the
// curated MODELS list below are accepted, so the UI can never point a job at a typo.
//
// Resolution precedence in each script: an explicit --model flag > this UI override
// > the CRM_*_MODEL env var > the hardcoded default.
//
// NOTE on the ingest card: it governs the whole weekly run — crm-daily uses the
// 'ingest' model for BOTH the merge and its Timeline step — so a run can't
// silently split across a free merge model and a paid Timeline model. Only the
// model-spending jobs (ingest, todo) carry a picker; the free sweeps do not, and
// Timeline is not a job (it rides ingest's model).
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { MODEL_JOBS } = require('./jobs');

const FILE = path.posix.join(DATA_DIR, 'crm-run-models.json');
const JOBS = MODEL_JOBS; // ['ingest','todo'] — the jobs that spend model tokens

// Curated selectable models. `paid` = bills per token (moonshotai/*); anthropic/*
// are $0 under the Claude subscription auth (matches lib/cost.js isFree). Keep this
// list short and meaningful — it is the dropdown the user picks from.
const MODELS = [
  { id: 'anthropic/claude-opus-4-8', label: 'Opus 4.8', paid: false },
  { id: 'anthropic/claude-opus-5', label: 'Opus 5', paid: false },
  { id: 'anthropic/claude-fable-5', label: 'Fable 5', paid: false },
  { id: 'anthropic/claude-sonnet-5', label: 'Sonnet 5', paid: false },
  { id: 'anthropic/claude-haiku-4-5', label: 'Haiku 4.5', paid: false },
  { id: 'moonshotai/kimi-k3', label: 'Kimi K3', paid: true },
];
const ALLOWED = new Set(MODELS.map((m) => m.id));

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

// The UI-selected model id for `job`, or null when none is set (or the stored id is
// no longer in the allowed list — treated as unset so a retired model self-heals).
function getModel(job) {
  const m = read()[job];
  return m && ALLOWED.has(m) ? m : null;
}

// Every job resolved to its selected id or null. For rendering the dropdowns.
function getModels() {
  const out = {};
  for (const j of JOBS) out[j] = getModel(j);
  return out;
}

// Set (or clear, with a falsy/empty model) a job's model override.
function setModel(job, model) {
  if (!JOBS.includes(job)) throw new Error(`unknown job: ${job}`);
  if (model && !ALLOWED.has(model)) throw new Error(`unknown model: ${model}`);
  const s = read();
  if (model) s[job] = model; else delete s[job];
  const tmp = `${FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, FILE);
  return getModel(job);
}

module.exports = { JOBS, MODELS, FILE, getModel, getModels, setModel };
