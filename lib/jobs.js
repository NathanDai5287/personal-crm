'use strict';
// lib/jobs.js — THE canonical list of periodic jobs. One entry per job the
// system runs on a schedule. This is the single source of truth the rest of the
// code reads from, so "what jobs exist" is defined in exactly one place.
//
// THE MENTAL MODEL (mirror this in docs/AGENTS.md if you change it):
//   There are FOUR jobs. Each runs periodically on its own cycle. Every period a
//   job checks its enable flag (lib/run-toggles); if enabled, it does its work.
//     sweep       — copy new Signal messages into crm.db          (free, no model)
//     deep-sweep  — re-walk ALL history to catch reused row ids    (free, no model)
//     ingest      — read waiting messages into a profile: MERGE (prose) then
//                   TIMELINE (chronology). Timeline is ingest's second half, NOT
//                   a job of its own.                              (spends model)
//     todo        — scan messages for "make sure …" commitments    (spends model
//                   only when a line matches)
//
//   `Timeline` (formerly "compaction"/"compact") is a STEP inside ingest, built by
//   scripts/crm-timeline.js. It has no flag and no schedule of its own — it runs
//   because ingest runs. Do not reintroduce it as a separate job.
//
// spendsModel drives two things: whether the job carries a model-picker in the UI
// (lib/run-models) and how the confirm modal colours its cost. sweep/deep-sweep
// are free; their flag pauses the schedule for operational reasons only (e.g. a
// noisy sweep), and pausing them stops archiving — including disappearing
// messages before they vanish — so it defaults on and is rarely touched.
const JOBS = [
  { id: 'sweep', label: 'Sweep', spendsModel: false },
  { id: 'deep-sweep', label: 'Deep sweep', spendsModel: false },
  { id: 'ingest', label: 'Ingest', spendsModel: true },
  { id: 'todo', label: 'Todo', spendsModel: true },
];

const JOB_IDS = JOBS.map((j) => j.id);
const MODEL_JOBS = JOBS.filter((j) => j.spendsModel).map((j) => j.id);

function isJob(id) { return JOB_IDS.includes(id); }
function labelFor(id) { const j = JOBS.find((x) => x.id === id); return j ? j.label : id; }

module.exports = { JOBS, JOB_IDS, MODEL_JOBS, isJob, labelFor };
