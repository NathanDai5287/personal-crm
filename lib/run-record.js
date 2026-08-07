'use strict';
// Shared writer for the /admin/runs ledger.
//
// crm-daily writes its own richer record inline (it carries per-chunk steps and
// diffs). Sweep and compact use this helper so EVERY pass — not just ingest —
// lands in logs/runs/ with a `kind`, and the dashboard (crm-web runsPage) reads
// them all and colours each row by kind. No-op sweeps (0 inserted) are still
// recorded here; the UI hides them so the hourly cadence doesn't bury the weekly
// AI runs, but the on-disk ledger stays a complete record of every pass.
const fs = require('fs');
const path = require('path');
const { LOGS_DIR } = require('./config');

// record must carry { startedAt (ms), kind }. Returns the record id (== filename
// stem). Write is atomic (tmp + rename) so a reader never sees a half-written
// file. Errors propagate to the caller, which logs them non-fatally — a missing
// ledger row must never fail the pass that produced it.
function writeRunRecord(record) {
  const runsDir = path.join(LOGS_DIR, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  // Same ISO-derived stem as crm-daily, plus a -kind suffix. The pipeline lock
  // serialises all passes so two records can't share a startedAt, but the suffix
  // is cheap insurance and makes logs/runs/ self-describing at a glance.
  const id = new Date(record.startedAt).toISOString().replace(/[:.]/g, '-')
    + (record.kind ? `-${record.kind}` : '');
  const full = { id, ...record };
  const tmp = path.join(runsDir, `.${id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(full, null, 2));
  fs.renameSync(tmp, path.join(runsDir, `${id}.json`));
  return id;
}

module.exports = { writeRunRecord };
