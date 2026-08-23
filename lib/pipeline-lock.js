'use strict';
// A single advisory lock shared by every pipeline entry point — the web job
// runner and the crm-archive / crm-daily / crm-timeline CLIs — so a manually
// triggered run and a scheduled one can never write crm.db or the same profile
// at the same moment. The web server's in-memory single-job guard only covers
// jobs it started itself; THIS file is what makes mutual exclusion cross-process.
//
// Design:
//   - One lock file, data/pipeline.lock, holding {pid, name, startedAt} JSON.
//   - acquire() creates it with O_EXCL. If it already exists, the holder counts
//     as live only if its pid is still running AND the lock is younger than
//     STALE_MS; otherwise it is stolen, because a crashed run must not wedge the
//     whole pipeline forever.
//   - NESTING: the web runner acquires the lock and then SPAWNS crm-archive /
//     crm-daily as children; those children would otherwise deadlock on the
//     parent's own lock. acquire() treats the env var CRM_PIPELINE_LOCK_HELD
//     (set on any real acquisition, inherited by children) as "already held by
//     my run" and hands back a no-op handle. Only the outermost process holds
//     the real file; everything it spawns runs under that one lock.
//
// acquire() never throws on an ordinary conflict — it returns { ok: false, ... }
// so a scheduled loser can log "skipped, run in progress" and exit 0. This is
// best-effort mutual exclusion, not a transaction; crm.db's busy_timeout still
// backstops the raw sqlite writes underneath.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const LOCK_FILE = path.posix.join(DATA_DIR, 'pipeline.lock');
const ENV_FLAG = 'CRM_PIPELINE_LOCK_HELD';
// No pipeline run should ever approach this. A first full-history backfill is the
// longest thing here and still finishes in well under a few hours; 12h exists
// only to reclaim a lock whose holder crashed AND whose pid was later reused.
const STALE_MS = 12 * 60 * 60 * 1000;

// One exit handler for the whole module (not one per acquisition — the web
// server acquires once per job over a long life and would otherwise leak
// listeners). At most one real lock is ever active in a process, because the
// second acquire() sees ENV_FLAG and returns a no-op.
let activeRelease = null;
process.on('exit', () => { if (activeRelease) activeRelease(); });

function pidAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // exists, just not ours to signal
}

function readHolder() {
  try {
    const h = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    return (h && typeof h === 'object') ? h : null;
  } catch { return null; }
}

function holderDesc(h) {
  if (!h) return 'unknown holder';
  const age = h.startedAt ? `, ${Math.round((Date.now() - h.startedAt) / 1000)}s ago` : '';
  return `${h.name || 'run'} pid ${h.pid || '?'}${age}`;
}

function isStale(h) {
  if (!h) return true;                // unparseable -> treat as abandoned
  if (!pidAlive(h.pid)) return true;  // holder process is gone
  if (h.startedAt && (Date.now() - h.startedAt) > STALE_MS) return true;
  return false;
}

// acquire(name) -> { ok: true, release }        on a real acquisition
//                  { ok: true, inherited, release }  when already inside a locked run
//                  { ok: false, holder, holderDesc } when a live run holds it
function acquire(name) {
  // Already inside a locked run (a child of the web runner or of a CLI main).
  if (process.env[ENV_FLAG]) return { ok: true, inherited: true, release() {} };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx'); // O_CREAT | O_EXCL
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, name: name || 'pipeline', startedAt: Date.now() }));
      fs.closeSync(fd);
      process.env[ENV_FLAG] = String(process.pid);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        activeRelease = null;
        delete process.env[ENV_FLAG];
        const h = readHolder();
        if (!h || h.pid === process.pid) { try { fs.unlinkSync(LOCK_FILE); } catch { /* already gone */ } }
      };
      activeRelease = release;
      return { ok: true, release };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const h = readHolder();
      if (isStale(h)) { try { fs.unlinkSync(LOCK_FILE); } catch { /* raced */ } continue; }
      return { ok: false, holder: h, holderDesc: holderDesc(h) };
    }
  }
  const h = readHolder(); // lost a steal race twice — report whoever holds it now
  return { ok: false, holder: h, holderDesc: holderDesc(h) };
}

module.exports = { acquire, LOCK_FILE };
