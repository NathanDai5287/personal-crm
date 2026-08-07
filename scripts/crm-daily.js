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
const {
  ROOT, LOGS_DIR, REFRESH_STATE, CONTACTS_DIR, GROUPS_DIR, GITDIR,
  MERGE_MODEL, COMPACT_MODEL, MERGE_PROMPT,
} = require('../lib/config');
const { mergeContact } = require('./crm-merge');
const { planAll, writeChunkLedger, chunkSummary } = require('./crm-refresh');
const { validateCitations } = require('../lib/archive');
const { openCrmDb, openSignalDb } = require('../lib/signal-db');

// REJECT UNKNOWN FLAGS BEFORE ANYTHING ELSE. Both flags here fail dangerously when
// misspelled rather than safely: `--dry-runn` performs a REAL run against every
// contact, and `--onlly <slug>` widens a one-contact run to all 34. Neither would
// print a warning. There is no safe default to fall back on, so a typo must abort.
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    if (a === '--dry-run') continue;
    if (a === '--only') { i += 1; continue; }
    console.error(`crm-daily: unknown flag '${a}'`);
    console.error('known: --dry-run, --only <slug>');
    process.exit(2);
  }
}

const DRY_RUN = process.argv.includes('--dry-run');
const ONLY_IDX = process.argv.indexOf('--only');
const ONLY = ONLY_IDX !== -1 ? process.argv[ONLY_IDX + 1] : null;
if (ONLY_IDX !== -1 && (!ONLY || ONLY.startsWith('--'))) {
  console.error('crm-daily: --only requires a contact slug');
  process.exit(2);
}

const SCRIPTS = {
  memoryCommit: path.join(ROOT, 'scripts', 'memory-commit.js'),
  autopromote: path.join(ROOT, 'scripts', 'crm-autopromote.js'),
  compact: path.join(ROOT, 'scripts', 'crm-compact.js'),
  backup: path.join(ROOT, 'scripts', 'crm-backup.js'),
  // NOTE: refresh is no longer spawned as a subprocess — crm-daily calls
  // planAll() from crm-refresh.js in-process so it gets real chunk objects.
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

// WHICH MODEL AND PROMPT PRODUCED THIS COMMIT. The chunk commit already records
// what went IN (slug, date span, message rowids); these record what did the
// work. Without them a mixed history — an Opus backfill followed by months of
// weekly K3 merges — is indistinguishable from a uniform one, and the question
// "is the cheap model eroding the prose" becomes unanswerable after the fact.
// Recorded as git trailers so `git log --grep='Model: moonshotai'` works.
//
// The prompt is identified by CONTENT hash, not just path: prompts/merge.md is
// production and gets overwritten when a variant is promoted, so the path alone
// would silently conflate two different prompts.
let promptShaCache = null;
function mergePromptSha() {
  if (promptShaCache !== null) return promptShaCache;
  try {
    const text = fs.readFileSync(MERGE_PROMPT, 'utf8');
    promptShaCache = require('crypto').createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
  } catch {
    promptShaCache = 'unknown';
  }
  return promptShaCache;
}

function provenanceTrailers(runTag) {
  const rel = path.relative(ROOT, MERGE_PROMPT).replace(/\\/g, '/');
  // TWO newlines. Git requires a BLANK line between the subject and the body,
  // and only parses trailers in the final paragraph. With a single newline it
  // folds the trailer lines into the subject and %(trailers:key=Model) returns
  // empty — the lines are there, but nothing can read them as trailers.
  return `\n\n${[`Model: ${MERGE_MODEL}`, `Prompt: ${rel}@${mergePromptSha()}`, `Run: ${runTag}`].join('\n')}`;
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

function main() {
  const startedAt = Date.now();
  // Same formula as the run-log id below, so a chunk commit's `Run:` trailer
  // joins straight to the run record in the dashboard.
  const runTag = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
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

  // ---- 0. archive backup --------------------------------------------------------
  // BEFORE anything else, because crm.db is the one file in this system that cannot
  // be regenerated (it holds messages Signal has already deleted) and step 3 writes
  // to it. Non-fatal: a failed backup is a reason to shout, not a reason to stop
  // ingesting — messages missed today are harder to recover than a skipped snapshot.
  // A run that reports a backup warning should not be followed by a backfill.
  let backupNote = null;
  if (DRY_RUN) {
    const chk = timed('backup (check)', () => runNode(SCRIPTS.backup, ['--check']));
    logLines.push(`[0] crm.db backup: check only (--dry-run) — ${chk.ok ? 'fresh' : 'STALE'}`);
    if (!chk.ok) warnings.push('crm.db backup is stale or missing');
  } else {
    const bk = timed('backup', () => runNode(SCRIPTS.backup, [], { timeout: 300_000 }));
    backupNote = String(bk.output || bk.error || '').split(/\r?\n/).find((l) => l.startsWith('wrote ')) || null;
    logLines.push(`[0] crm.db backup: ${bk.ok ? backupNote || 'ok' : 'FAILED (non-fatal)'}`);
    if (!bk.ok) {
      warnings.push(`crm.db backup FAILED (non-fatal, but do not backfill until fixed): ${String(bk.error).slice(0, 200)}`);
      logLines.push(bk.error || '');
    }
  }

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

  // ---- 3. refresh: plan week-aligned chunks --------------------------------------
  // Run IN-PROCESS (not as a subprocess) so the merge loop below gets the actual
  // chunk objects — messages included — instead of re-deriving them from parsed
  // stdout. A plan is a list of contacts, each holding an ordered list of chunks;
  // see crm-refresh.js / lib/weeks.js for how the boundaries are chosen.
  let plans = [];
  let totalChunks = 0;
  if (!fatal) {
    const t0 = Date.now();
    try {
      const cdb = openCrmDb();
      const sdb = openSignalDb();
      try {
        plans = planAll(cdb, sdb, {
          onlySlug: ONLY,
          // An on-demand single-contact run includes the in-progress week —
          // you press that button because you are seeing someone today.
          // Scheduled runs stop at the last complete Monday-04:00 week.
          includePartialWeek: Boolean(ONLY),
        });
      } finally {
        sdb.close();
        cdb.close();
      }
      totalChunks = plans.reduce((n, p) => n + p.chunks.length, 0);
      const note = plans.length === 0
        ? 'no unmerged messages for any tracked contact'
        : plans.map((p) => `${p.slug}: ${p.total} msgs / ${p.chunks.length} chunk(s)` +
            `${p.hasCursor ? '' : ' [backfill]'}`).join('\n');
      steps.push({ name: 'refresh (plan)', ok: true, ms: Date.now() - t0, note });
      logLines.push(`[3] refresh: ok — ${plans.length} contact(s), ${totalChunks} chunk(s)`);
      logLines.push(note);
    } catch (e) {
      const error = String((e && e.stack) || e).slice(0, 4000);
      steps.push({ name: 'refresh (plan)', ok: false, ms: Date.now() - t0, note: error });
      warnings.push(`refresh failed: ${error.slice(0, 300)}`);
      logLines.push(`[3] refresh: FAILED\n${error}`);
      fatal = true;
    }
  }

  // ---- health check: Signal Desktop running? -----------------------------------
  if (plans.length === 0) {
    const running = isSignalRunning();
    if (running === false) {
      warnings.push('Signal Desktop may be closed — no messages synced');
    }
  }

  // ---- 4. merge, chunk by chunk ---------------------------------------------------
  // One chunk = one week-aligned slice of one contact's messages = one merge =
  // one cursor advance = one git commit. Keeping those four things in lockstep is
  // what makes the history debuggable: every commit in the memory history is
  // exactly "these messages produced this profile change", and reverting one
  // chunk's commit undoes precisely that chunk. It is also the crash-safety
  // story — a failure stops that contact's remaining chunks (later chunks assume
  // earlier ones landed) but costs at most one chunk of re-work.
  const merged = [];
  const mergeFailures = [];
  if (!fatal && plans.length > 0) {
    if (DRY_RUN) {
      logLines.push('[4] merge PLANNING (--dry-run, pi not invoked):');
      const state = loadRefreshState();
      for (const p of plans) {
        logLines.push(`  ${p.slug} (${p.name}): ${p.total} msgs, ${p.chunks.length} chunk(s), ` +
          `cursor ${state.cursors[p.slug] ?? '(none — backfill)'}`);
        p.chunks.forEach((c, i) => {
          logLines.push(`    ${i + 1}/${p.chunks.length}  ${c.label}  ${c.count} msgs  ` +
            `~${Math.round(c.tokens / 1000)}k tok  m${c.ridStart}–m${c.ridEnd}` +
            `${c.partial ? '  [day-split]' : ''}  -> cursor ${c.ridEnd}`);
        });
        // Validate argv construction without dumping the whole system prompt.
        const plan = mergeContact(p.slug, { dryRun: true, quiet: true });
        const a = plan.argv;
        logLines.push(`    argv ok: --model ${a[a.indexOf('--model') + 1]}, ` +
          `--tools ${a[a.indexOf('--tools') + 1]}, ` +
          `system-prompt ${a[a.indexOf('--system-prompt') + 1].length} chars, ` +
          `attachments ${a.filter((x) => typeof x === 'string' && x.startsWith('@')).join(' ')}`);
      }
    } else {
      const state = loadRefreshState();
      for (const p of plans) {
        const total = p.chunks.length;
        let contactFailed = false;
        for (let i = 0; i < total && !contactFailed; i++) {
          const chunk = p.chunks[i];
          const detail = {
            ...chunkSummary(p, chunk, i + 1, total),
            cursorBefore: Object.prototype.hasOwnProperty.call(state.cursors, p.slug) ? state.cursors[p.slug] : null,
            cursorAfter: null,
            ok: false,
            ms: 0,
            error: null,
            citations: null,
            preSha: gitHeadSha(),
            postSha: null,
          };

          // Write this chunk's ledger, overwriting the previous chunk's. The
          // per-chunk commit below captures each version, so the memory history
          // holds every ledger ever fed to a merge.
          writeChunkLedger(p, chunk, i + 1, total);

          const t0 = Date.now();
          // stream:true pipes pi's output live to our stdout so the web job
          // monitor shows the model working instead of a silent gap; label names
          // the chunk in that live banner.
          const result = mergeContact(p.slug, {
            dryRun: false,
            stream: true,
            label: `${i + 1}/${total} ${chunk.label} · ${chunk.count} msgs`,
          });
          detail.ms = Date.now() - t0;

          if (result.ok) {
            // Cursor advances to this chunk's last message id — NOT the
            // contact's overall max — so an interrupted backfill resumes at the
            // right week instead of skipping the chunks it never merged.
            state.cursors[p.slug] = chunk.ridEnd;
            state.ranAt = Date.now();
            atomicWriteJson(REFRESH_STATE, state);
            detail.ok = true;
            detail.cursorAfter = chunk.ridEnd;
            logLines.push(`[4] merge ${p.slug} ${i + 1}/${total} (${chunk.label}, ${chunk.count} msgs): ok, cursor -> ${chunk.ridEnd}`);

            // PROVENANCE CHECK (non-fatal): every ⟨m…⟩ id the model cited must
            // exist in the archive. Catches fabricated or mangled ids; cannot
            // catch a real id attached to the wrong claim.
            try {
              const cdb = openCrmDb();
              const profileText = fs.readFileSync(path.join(CONTACTS_DIR, `${p.slug}.md`), 'utf8');
              const v = validateCitations(cdb, profileText);
              cdb.close();
              detail.citations = { cited: v.cited, missing: v.missing };
              if (v.missing.length > 0) {
                const msg = `citation check ${p.slug} chunk ${i + 1}/${total}: ${v.missing.length}/${v.cited} cited ids NOT in archive: ${v.missing.slice(0, 10).join(', ')}`;
                warnings.push(msg);
                logLines.push(`[4] ${msg}`);
              }
            } catch (e) {
              logLines.push(`[4] citation check ${p.slug} chunk ${i + 1}: skipped (${String(e).slice(0, 120)})`);
            }

            // ONE COMMIT PER CHUNK, carrying the message span. This is what makes
            // `git log -- data/contacts/<slug>.md` a readable history of why the
            // profile says what it says.
            const msg = `merge ${p.slug} ${chunk.label} (${chunk.count} msgs, m${chunk.ridStart}..m${chunk.ridEnd}) [${i + 1}/${total}]`
              + provenanceTrailers(runTag);
            const commit = runNode(SCRIPTS.memoryCommit, [msg]);
            if (commit.ok) {
              detail.postSha = gitHeadSha();
            } else {
              warnings.push(`chunk commit failed for ${p.slug} ${chunk.label}: ${commit.error}`);
              logLines.push(`[4] commit ${p.slug} ${chunk.label}: FAILED (non-fatal): ${commit.error}`);
            }
          } else {
            contactFailed = true;
            mergeFailures.push({ slug: p.slug, chunk: chunk.label, chunkIndex: i + 1, chunkTotal: total, error: result.error });
            detail.error = result.error;
            logLines.push(`[4] merge ${p.slug} ${i + 1}/${total} (${chunk.label}): FAILED — cursor NOT advanced, ` +
              `remaining ${total - i - 1} chunk(s) deferred to the next run: ${result.error}`);
          }
          contactDetails.push(detail);
        }
        if (!contactFailed) merged.push(p.slug);
      }
    }
  } else if (!fatal) {
    logLines.push('[4] merge: nothing to merge (no unmerged messages)');
  }

  // ---- 5. compact ----------------------------------------------------------------
  let compactChanged = 0;
  let compactCitations = null;
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

    // PROVENANCE CHECK for compaction (non-fatal). Compaction writes ⟨m…⟩ ids
    // into ## Timeline itself, and it runs AFTER the merges — so the per-merge
    // check above never sees a single line of its output. Re-validate every file
    // it may have touched. This matters most when COMPACT_MODEL is set to a
    // cheaper model than the one whose citation fidelity you already trust:
    // copying ids verbatim is exactly the skill weaker models drop first.
    try {
      const cdb = openCrmDb();
      const mds = (dir) => {
        try {
          return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f));
        } catch { return []; }
      };
      const files = [...mds(CONTACTS_DIR), ...mds(GROUPS_DIR)];
      let cited = 0;
      const bad = [];
      for (const f of files) {
        const v = validateCitations(cdb, fs.readFileSync(f, 'utf8'));
        cited += v.cited;
        if (v.missing.length > 0) bad.push(`${path.basename(f, '.md')}(${v.missing.slice(0, 5).join(',')})`);
      }
      cdb.close();
      compactCitations = { files: files.length, cited, bad };
      if (bad.length > 0) {
        const msg = `citation check post-compact: unresolvable ids in ${bad.length} file(s): ${bad.slice(0, 10).join(' ')}`;
        warnings.push(msg);
        logLines.push(`[5] ${msg}`);
      } else {
        logLines.push(`[5] citation check post-compact: ${cited} cited ids across ${files.length} files, all resolve`);
      }
    } catch (e) {
      logLines.push(`[5] citation check post-compact: skipped (${String(e).slice(0, 120)})`);
    }
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
    // Which model did which half of the work. Recorded per run so a profile diff
    // is always attributable to a model — the whole point of being able to A/B
    // MERGE_MODEL on one contact and compare the output.
    models: { merge: MERGE_MODEL, compact: COMPACT_MODEL },
    promoted,
    contactsWithActivity: plans.length,
    totalChunks,
    chunksMerged: contactDetails.filter((c) => c.ok).length,
    messagesMerged: contactDetails.filter((c) => c.ok).reduce((n, c) => n + c.count, 0),
    merged,
    mergeFailures,
    compactChanged,
    compactCitations,
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
      // One entry per CHUNK (was per contact before week-aligned chunking).
      // Each carries its own preSha/postSha so the UI can diff that chunk alone.
      chunks: contactDetails,
      preSha,
      postSha,
    });
    const oneLine = `${nowIso()} durationMs=${summary.durationMs} promoted=${promoted} activity=${plans.length} chunks=${summary.chunksMerged}/${totalChunks} merged=${merged.length} mergeFailures=${mergeFailures.length} compactChanged=${compactChanged} warnings=${warnings.length}`;
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

// Guarded, like every other script here. Unguarded, `require('./crm-daily.js')` — the
// obvious way to reach in for a helper, or to check the file parses — silently executes
// a full ingest: refresh, merges, real pi calls, cursor writes. That happened on
// 2026-08-03. Use `node --check` to validate syntax.
if (require.main === module) {
  // Cross-process pipeline lock (see lib/pipeline-lock.js). Ingest reads the
  // archive and rewrites profiles; it must not overlap a sweep or another
  // ingest. Runs the lock as `ingest` (this script's dashboard name).
  const lock = require('../lib/pipeline-lock').acquire('ingest');
  if (!lock.ok) { console.log(`crm-daily: skipped, run in progress (${lock.holderDesc}).`); process.exit(0); }
  try { main(); } finally { lock.release(); }
}
module.exports = { main };
