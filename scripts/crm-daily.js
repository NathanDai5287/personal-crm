// crm-daily.js — the full daily personal-CRM pipeline orchestrator.
//
// Sequential, crash-safe, silent-on-success, loud-on-failure:
//   1. memory-commit.js "daily pre-refresh snapshot"      (isolated git history; safe)
//   2. crm-autopromote.js --write                          (non-fatal on failure)
//   3. crm-refresh.js                                      (fatal if it throws)
//   4. per-contact merge + CURSOR COMMIT (crash-safe, see below)
//   5. crm-compact.js --write                               (non-fatal on failure)
//   6. memory-commit.js "daily post-refresh"
//   7. logs/last-run.json + logs/daily.log
//   8. health warning if Signal Desktop looks closed
//   9. exit 0 iff no merge failures and no fatal step failed; best-effort toast otherwise
//
// CRASH-SAFE CURSOR COMMIT: crm-refresh.js deliberately never writes
// REFRESH_STATE (see its header). This orchestrator is the only writer of
// REFRESH_STATE, and it advances ONE contact's cursor at a time, immediately
// after that contact's merge succeeds, via a tmp-file + rename (atomic on
// the same filesystem). So if the process is killed mid-run — between
// merging contact N and contact N+1 — every contact up through N keeps its
// advanced cursor (their messages are safely folded into their profile) and
// every contact from N+1 onward simply keeps its old cursor, so their new
// messages get retried (not lost, not double-merged-and-dropped) on the next
// run. A merge that fails for a contact leaves that contact's cursor
// untouched for the same reason — the unmerged messages get retried later.
//
// Usage:
//   node scripts/crm-daily.js              # run the full pipeline
//   node scripts/crm-daily.js --only <slug> # ONE contact: refresh --only + merge +
//                                          # cursor commit. Skips autopromote and
//                                          # compact (both are inherently all-contact
//                                          # passes); they run on the next full run.
//   node scripts/crm-daily.js --dry-run    # steps 1-3 + merge/cursor PLANNING only;
//                                          # never invokes pi, never writes REFRESH_STATE,
//                                          # never runs compact --write or the post-commit.
//                                          # DEVIATION: also runs autopromote WITHOUT --write
//                                          # (its own dry-run) rather than --write, so a
//                                          # --dry-run of the orchestrator never mutates
//                                          # crm-tracked.json / crm.db / creates stub files —
//                                          # matching the spirit of "dry run" and the build
//                                          # instruction to never invoke --write during testing.

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const { ROOT, LOGS_DIR, REFRESH_STATE, CONTACTS_DIR, GITDIR } = require('../lib/config');
const { mergeContact } = require('./crm-merge');
const { validateCitations } = require('../lib/archive');
const { openCrmDb } = require('../lib/signal-db');

const DRY_RUN = process.argv.includes('--dry-run');
const ONLY_IDX = process.argv.indexOf('--only');
const ONLY = ONLY_IDX !== -1 ? process.argv[ONLY_IDX + 1] : null;
if (ONLY_IDX !== -1 && !ONLY) {
  console.error('crm-daily: --only requires a contact slug');
  process.exit(2);
}

const SCRIPTS = {
  memoryCommit: path.join(ROOT, 'scripts', 'memory-commit.js'),
  autopromote: path.join(ROOT, 'scripts', 'crm-autopromote.js'),
  refresh: path.join(ROOT, 'scripts', 'crm-refresh.js'),
  compact: path.join(ROOT, 'scripts', 'crm-compact.js'),
};

function nowIso() {
  return new Date().toISOString();
}

// HEAD of the private snapshot history (see memory-commit.js). Captured after
// the pre- and post-run snapshots so the runs UI can diff exactly what a run
// changed in each profile. Returns null if the history is unreadable.
function gitHeadSha() {
  try {
    return execSync(`git --git-dir="${GITDIR}" rev-parse HEAD`, { cwd: ROOT, encoding: 'utf8', timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

function runNode(scriptPath, args, { timeout = 120_000 } = {}) {
  // Always resolves (never throws): returns { ok, output, error }.
  try {
    const output = execFileSync(process.execPath, [scriptPath, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, output };
  } catch (e) {
    const output = (e && e.stdout) || '';
    const error = String((e && e.stderr) || (e && e.message) || e);
    return { ok: false, output, error };
  }
}

function isSignalRunning() {
  try {
    const out = execSync('tasklist', { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    return /signal/i.test(out);
  } catch {
    return null; // detection failed — unknown, not "closed"
  }
}

function tryNotify(title, message) {
  // Best-effort Windows toast. Never throws, never affects the exit code.
  try {
    const esc = (s) => String(s).replace(/`/g, '``').replace(/"/g, '`"').replace(/\$/g, '`$');
    const ps = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
      '[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
      '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] > $null',
      '$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
      '$textNodes = $template.GetElementsByTagName("text")',
      `$textNodes.Item(0).AppendChild($template.CreateTextNode("${esc(title)}")) > $null`,
      `$textNodes.Item(1).AppendChild($template.CreateTextNode("${esc(message)}")) > $null`,
      '$toast = [Windows.UI.Notifications.ToastNotification]::new($template)',
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("personal-crm").Show($toast)',
    ].join('; ');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 10_000 });
  } catch {
    // best-effort only — swallow
  }
}

function atomicWriteJson(file, obj) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function loadRefreshState() {
  try {
    const raw = JSON.parse(fs.readFileSync(REFRESH_STATE, 'utf8'));
    if (raw && raw.cursors && typeof raw.cursors === 'object') return { cursors: { ...raw.cursors }, ranAt: raw.ranAt || null };
  } catch {}
  return { cursors: {}, ranAt: null };
}

function parseRefreshManifest(output) {
  const manifest = [];
  if (!output) return manifest;
  if (/^CRM_REFRESH: no new messages/m.test(output)) return manifest;
  for (const line of output.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      manifest.push(JSON.parse(t));
    } catch {
      // ignore unparsable line
    }
  }
  return manifest;
}

function main() {
  const startedAt = Date.now();
  const warnings = [];
  let fatal = false;
  const logLines = [`\n===== crm-daily ${DRY_RUN ? '[DRY-RUN] ' : ''}${ONLY ? `[ONLY ${ONLY}] ` : ''}run @ ${nowIso()} =====`];

  // Structured run record for the web UI's /runs page. `steps` mirrors the
  // numbered pipeline stages; `contactDetails` carries per-contact merge info.
  const steps = [];
  const contactDetails = [];
  const timed = (name, fn) => {
    const t0 = Date.now();
    const r = fn();
    steps.push({ name, ok: !!r.ok, ms: Date.now() - t0, note: String(r.output || r.error || '').trim().slice(0, 4000) });
    return r;
  };
  const skipped = (name, why) => steps.push({ name, skipped: true, note: why });

  // ---- 1. pre-refresh snapshot ------------------------------------------------
  const preCommit = timed('snapshot (pre)', () => runNode(SCRIPTS.memoryCommit, ['daily pre-refresh snapshot']));
  const preSha = DRY_RUN ? null : gitHeadSha();
  logLines.push(`[1] memory-commit (pre): ${preCommit.ok ? 'ok' : 'FAILED'}`);
  if (!preCommit.ok) {
    warnings.push(`pre-refresh memory-commit failed: ${preCommit.error}`);
    fatal = true; // can't safely proceed if we can't even snapshot before mutating
    logLines.push(preCommit.error);
  } else if (preCommit.output) {
    logLines.push(preCommit.output.trim());
  }

  // ---- 2. autopromote ----------------------------------------------------------
  let promoted = 0;
  if (ONLY) {
    logLines.push('[2] autopromote: skipped (--only mode)');
    skipped('autopromote', '--only mode');
  } else {
    const autopromoteArgs = DRY_RUN ? [] : ['--write'];
    const autopromote = timed('autopromote', () => runNode(SCRIPTS.autopromote, autopromoteArgs));
    logLines.push(`[2] autopromote ${DRY_RUN ? '(dry-run)' : '--write'}: ${autopromote.ok ? 'ok' : 'FAILED (non-fatal)'}`);
    logLines.push(autopromote.output || autopromote.error || '');
    if (!autopromote.ok) warnings.push(`autopromote failed (non-fatal): ${autopromote.error}`);
    const promotedMatch = /promoted (\d+);/.exec(autopromote.output || '');
    promoted = promotedMatch ? Number(promotedMatch[1]) : 0;
  }

  // ---- 3. refresh ---------------------------------------------------------------
  let manifest = [];
  if (!fatal) {
    const refresh = timed('refresh', () => runNode(SCRIPTS.refresh, ONLY ? ['--only', ONLY] : [], { timeout: 300_000 }));
    logLines.push(`[3] refresh: ${refresh.ok ? 'ok' : 'FAILED'}`);
    logLines.push(refresh.output || refresh.error || '');
    if (!refresh.ok) {
      warnings.push(`refresh failed: ${refresh.error}`);
      fatal = true;
    } else {
      manifest = parseRefreshManifest(refresh.output);
    }
  }

  // ---- health check: Signal Desktop running? -----------------------------------
  if (manifest.length === 0) {
    const running = isSignalRunning();
    if (running === false) {
      warnings.push('Signal Desktop may be closed — no messages synced');
    }
  }

  // ---- 4. merge + per-contact cursor commit ------------------------------------
  const merged = [];
  const mergeFailures = [];
  if (!fatal && manifest.length > 0) {
    if (DRY_RUN) {
      logLines.push(`[4] merge/cursor PLANNING (--dry-run, pi not invoked):`);
      const state = loadRefreshState();
      for (const m of manifest) {
        const plan = mergeContact(m.slug, { dryRun: true });
        logLines.push(`  - would merge ${m.slug} (${m.count} msgs); cursor ${state.cursors[m.slug] ?? '(none — backfill)'} -> ${m.proposedCursor}`);
        logLines.push(`    argv: ${JSON.stringify(plan.argv)}`);
      }
    } else {
      const state = loadRefreshState();
      for (const m of manifest) {
        const detail = {
          slug: m.slug,
          name: m.name,
          count: m.count,
          cursorBefore: Object.prototype.hasOwnProperty.call(state.cursors, m.slug) ? state.cursors[m.slug] : null,
          cursorAfter: null,
          ok: false,
          ms: 0,
          error: null,
          citations: null,
        };
        const t0 = Date.now();
        const result = mergeContact(m.slug, { dryRun: false });
        detail.ms = Date.now() - t0;
        if (result.ok) {
          state.cursors[m.slug] = m.proposedCursor;
          state.ranAt = Date.now();
          atomicWriteJson(REFRESH_STATE, state); // commit THIS contact's cursor immediately
          merged.push(m.slug);
          detail.ok = true;
          detail.cursorAfter = m.proposedCursor;
          logLines.push(`[4] merge ${m.slug}: ok, cursor -> ${m.proposedCursor}`);
          // PROVENANCE CHECK (non-fatal): every ⟨m…⟩ id the model cited in the
          // profile must exist in the crm.db archive — a miss means the model
          // hallucinated or mangled a citation.
          try {
            const cdb = openCrmDb();
            const profileText = fs.readFileSync(path.join(CONTACTS_DIR, `${m.slug}.md`), 'utf8');
            const v = validateCitations(cdb, profileText);
            cdb.close();
            detail.citations = { cited: v.cited, missing: v.missing };
            if (v.missing.length > 0) {
              const msg = `citation check ${m.slug}: ${v.missing.length}/${v.cited} cited ids NOT in archive: ${v.missing.slice(0, 10).join(', ')}`;
              warnings.push(msg);
              logLines.push(`[4] ${msg}`);
            } else if (v.cited > 0) {
              logLines.push(`[4] citation check ${m.slug}: ${v.cited} cited ids, all resolve`);
            }
          } catch (e) {
            logLines.push(`[4] citation check ${m.slug}: skipped (${String(e).slice(0, 120)})`);
          }
        } else {
          mergeFailures.push({ slug: m.slug, error: result.error });
          detail.error = result.error;
          logLines.push(`[4] merge ${m.slug}: FAILED (cursor NOT advanced, will retry): ${result.error}`);
        }
        contactDetails.push(detail);
      }
    }
  } else if (!fatal) {
    logLines.push('[4] merge: nothing to merge (no contacts with new activity)');
  }

  // ---- 5. compact ----------------------------------------------------------------
  let compactChanged = 0;
  if (ONLY) {
    logLines.push('[5] compact: skipped (--only mode — runs on the next full run)');
    skipped('compact', '--only mode');
  } else if (!fatal && !DRY_RUN) {
    // Compaction makes one pi call per aged-out day/week per conversation, so
    // first runs after a gap can take a while — give it half an hour.
    const compact = timed('compact', () => runNode(SCRIPTS.compact, ['--write'], { timeout: 1_800_000 }));
    logLines.push(`[5] compact --write: ${compact.ok ? 'ok' : 'FAILED (non-fatal)'}`);
    logLines.push(compact.output || compact.error || '');
    if (!compact.ok) warnings.push(`compact failed (non-fatal): ${compact.error}`);
    compactChanged = ((compact.output || '').match(/changed=true/g) || []).length;
  } else if (DRY_RUN) {
    logLines.push('[5] compact --write: skipped (--dry-run)');
  }

  // ---- 6. post-refresh snapshot ---------------------------------------------------
  let postSha = null;
  if (!fatal && !DRY_RUN) {
    const postCommit = timed('snapshot (post)', () => runNode(SCRIPTS.memoryCommit, ['daily post-refresh']));
    postSha = gitHeadSha();
    logLines.push(`[6] memory-commit (post): ${postCommit.ok ? 'ok' : 'FAILED (non-fatal)'}`);
    if (!postCommit.ok) warnings.push(`post-refresh memory-commit failed (non-fatal): ${postCommit.error}`);
    else if (postCommit.output) logLines.push(postCommit.output.trim());
  } else if (DRY_RUN) {
    logLines.push('[6] memory-commit (post): skipped (--dry-run)');
  }

  const endedAt = Date.now();
  const summary = {
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    dryRun: DRY_RUN,
    only: ONLY,
    promoted,
    contactsWithActivity: manifest.length,
    merged,
    mergeFailures,
    compactChanged,
    warnings,
  };

  // ---- 7. logs --------------------------------------------------------------------
  if (!DRY_RUN) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    atomicWriteJson(path.join(LOGS_DIR, 'last-run.json'), summary);
    // Structured record for the web UI's /runs page — one file per run.
    const runsDir = path.join(LOGS_DIR, 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const runId = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
    atomicWriteJson(path.join(runsDir, `${runId}.json`), {
      id: runId,
      ...summary,
      steps,
      contacts: contactDetails,
      preSha,
      postSha,
    });
    const oneLine = `${nowIso()} durationMs=${summary.durationMs} promoted=${promoted} activity=${manifest.length} merged=${merged.length} mergeFailures=${mergeFailures.length} compactChanged=${compactChanged} warnings=${warnings.length}`;
    fs.appendFileSync(path.join(LOGS_DIR, 'daily.log'), `${oneLine}\n${logLines.join('\n')}\n`);
  } else {
    console.log(logLines.join('\n'));
    console.log('\n----- dry-run summary -----');
    console.log(JSON.stringify(summary, null, 2));
  }

  const exitNonZero = fatal || mergeFailures.length > 0;
  if (exitNonZero && !DRY_RUN) {
    tryNotify(
      'personal-crm: daily run had issues',
      `mergeFailures=${mergeFailures.length} fatal=${fatal}. See ${path.join(LOGS_DIR, 'last-run.json')}`,
    );
  }
  process.exit(exitNonZero ? 1 : 0);
}

main();
