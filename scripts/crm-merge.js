// crm-merge.js — merges one contact's new-messages file into their profile
// via a headless `pi` invocation, using prompts/merge.md as the system prompt.
//
// Usage:
//   node scripts/crm-merge.js <slug>              # actually invoke pi
//   node scripts/crm-merge.js <slug> --dry-run    # print the argv it WOULD run, don't invoke pi
//
// Also usable as a library: const { mergeContact } = require('./crm-merge');
// crm-daily.js calls mergeContact(slug) in-process for each manifest entry
// coming out of crm-refresh.js, so it can commit that contact's rowid cursor
// immediately after a successful merge (see crm-daily.js for the crash-safe
// per-contact commit sequence).
//
// IMPORTANT: `pi` may not have an Anthropic API key configured in this
// environment, so a real invocation can fail on auth. That's expected here —
// mergeContact() always catches the failure and returns { ok: false, error },
// it never throws uncaught, so a broken/unconfigured `pi` never crashes the
// caller. Use --dry-run to validate the argv construction independent of
// whether `pi` can actually authenticate.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { ROOT, DATA_DIR, PI_CLI, MERGE_MODEL, MERGE_PROMPT, BOT_SERVICE_ID } = require('../lib/config');
const { dateKey } = require('../lib/weeks');
const { sumSessionCostUsd, sessionAssistantText } = require('../lib/cost');
const { storeNicknameProposals } = require('../lib/nicknames');
const { buildResolver } = require('../lib/people-resolve');
const { applyStructuredReply, renderStructuredProfile, profileCitationIds } = require('../lib/structured-person');
const { openCrmDb } = require('../lib/signal-db');
const { ensureMessagesTable, markMerged } = require('../lib/archive');

// Resolver for nickname TARGETS (feature 2): maps a name the model names in a
// `target | nickname | ids` line to a contact slug (or Nathan). Built once per
// process from the contacts table — contacts are ~static across a run, and mergeContact
// runs in-process per chunk under crm-daily, so this is cached, not rebuilt per merge.
let _resolver;
function nickResolver() {
  if (_resolver) return _resolver;
  try {
    const { openCrmDb } = require('../lib/signal-db');
    const cdb = openCrmDb();
    const contacts = cdb.prepare('SELECT file_path, name FROM contacts').all()
      .map((r) => ({ slug: r.file_path ? r.file_path.replace('data/contacts/', '').replace(/\.md$/, '') : null, name: r.name }))
      .filter((c) => c.slug);
    cdb.close();
    _resolver = buildResolver(contacts);
  } catch { _resolver = { resolve: () => null }; }
  return _resolver;
}
const { detect, redact } = require('../lib/redact');

// Bucket a failed pi run so the retry loop knows what to do:
//   content_filter — a provider rejected the prompt on content grounds; retrying
//                    verbatim is pointless, so the contact is held for manual review
//                    (see the content_filter branch in mergeContact + lib/censor-hold).
//   auth           — bad/absent credentials; retrying will never help. Surface now.
//   transient      — rate limit, 5xx, timeout, socket/DNS. Back off and retry.
//   unknown        — anything else; treated as transient (bounded retries).
function classifyPiError(text) {
  const t = String(text || '').toLowerCase();
  if (/content_filter|considered high risk|content policy|content[ _]moderation/.test(t)) return 'content_filter';
  if (/\b40[13]\b|unauthor|invalid[ _]api[ _]key|no api key|missing api key|authentication|forbidden/.test(t)) return 'auth';
  if (/\b429\b|rate[ _-]?limit|too many requests|overloaded|capacity|quota/.test(t)) return 'transient';
  if (/\b5\d\d\b|timeout|timed out|etimedout|econnreset|econnrefused|socket hang|network|fetch failed|enotfound|eai_again|esockettimedout/.test(t)) return 'transient';
  return 'unknown';
}

// The default user turn. Prompt variants may replace it (see opts.userMessage):
// one of the review's high-severity findings is that ALL run-specific context —
// which file, which person, what today's date is — is withheld from the model,
// and the user turn is where that context belongs.
const DEFAULT_USER_MESSAGE = 'Merge the new messages into this profile per your instructions.';

// opts: { model, userMessage } — both default to production behaviour. They exist
// so evals/run.js can drive this exact code path with a different model or a
// different prompt variant, rather than reimplementing the invocation and then
// testing something that isn't what ships.
function buildArgs(slug, mergePromptText, opts = {}) {
  // Without --thinking, pi applies its own configured default (currently 'high'
  // via ~/.pi/agent/settings.json). That is an invisible dependency on a machine
  // setting: the same command could reason at a different level on another box,
  // and the first K3 comparison silently ran one tier below the model's ceiling.
  // Passing it explicitly makes the level part of the experiment.
  const thinking = opts.thinking || process.env.CRM_MERGE_THINKING || null;
  // Production stays ephemeral (--no-session): a merge is a pure function of
  // profile + ledger and leaving session files around would accumulate copies of
  // private message content outside data/. The eval harness passes sessionDir to
  // capture the model's THINKING blocks, which pi only persists to a session
  // file — they never appear on stdout. Moonshot returns reasoning unencrypted
  // (thinkingSignature: "reasoning_content"), so K3's traces are readable text;
  // Anthropic's are opaque signatures.
  const sessionArgs = opts.sessionDir
    ? ['--session-dir', opts.sessionDir]
    : ['--no-session'];
  return [
    '-p',
    ...sessionArgs,
    '-nc',
    '--no-extensions',
    '--no-skills',
    '--model', opts.model || MERGE_MODEL,
    ...(thinking ? ['--thinking', thinking] : []),
    '--tools', 'read,edit',
    '--system-prompt', mergePromptText,
    `@data/contacts/${slug}.md`,
    // The model reads the CENSORED copy (.pi.txt), written from the uncensored
    // .new.txt at merge time (see mergeContact). Censoring is model-egress only; the
    // committed .new.txt stays uncensored — the faithful Rendered record.
    `@data/contacts/_refresh/${slug}.pi.txt`,
    opts.userMessage || DEFAULT_USER_MESSAGE,
  ];
}

// `Last contact` is DERIVED, not judged. It is the latest date in the ledger —
// something the harness can read directly — so asking a model to copy a date it
// can see is asking it to make a mistake it has no reason to make. K3 at
// thinking=high did exactly that on one eval case, writing 2026-06-17 when the
// ledger ended 2026-06-16, and the only way more reasoning "fixed" it was by
// costing 3.6x more. Setting it in code removes the error class outright.
//
// The prompt still instructs the model to update the line — that instruction is
// harmless and keeps the field correct when this runs in a context that skips
// normalisation. This is the authority, not the request.
function normalizeLastContact(slug, cwd) {
  try {
    const profile = path.join(cwd, 'data', 'contacts', `${slug}.md`);
    const ledger = path.join(cwd, 'data', 'contacts', '_refresh', `${slug}.new.txt`);
    if (!fs.existsSync(profile) || !fs.existsSync(ledger)) return null;

    // GROUND TRUTH FIRST. "Last contact" is the date of the newest message with
    // this person, which the archive knows exactly. Deriving it from the current
    // chunk's ledger instead only approximates it, and every heuristic built on
    // that approximation is wrong somewhere: forward-only can't correct a
    // fabricated future date, and unconditional-set rewinds the field during a
    // backfill that replays chunks oldest-first.
    let latest = null;
    const db = path.join(cwd, 'data', 'crm.db');
    if (fs.existsSync(db)) {
      try {
        const { DatabaseSync } = require('node:sqlite');
        const h = new DatabaseSync(db, { readOnly: true });
        const r = h.prepare('select max(sent_at) t from messages where contact_slug = ? and src is not ?').get(slug, BOT_SERVICE_ID);
        h.close();
        // PACIFIC, NOT UTC. Every date this repo prints — ledger lines, week
        // boundaries, checkLastContact's ledgerMaxDate — is America/Los_Angeles
        // via lib/weeks.js. toISOString() here spoke UTC, so any message after
        // 5pm Pacific wrote a Last contact one day AHEAD of what the ledger
        // shows. Found via the first arena session: vlad's last message is
        // 2026-06-17T00:01Z == 2026-06-16 5:01pm Pacific, one instant, two
        // calendar dates, and the profile carried the UTC one.
        if (r && r.t) latest = dateKey(r.t);
      } catch { /* fall through to the ledger */ }
    }
    // No archive rows to go on, so the ledger is the best available answer — and in
    // the eval sandbox it IS the answer, because a sandbox run is a single chunk.
    // The sandbox does now carry a `data/crm.db`, but it is a zero-row stand-in
    // (evals/sandbox.js): the query above opens it fine and returns NULL, which
    // lands here exactly as the no-file case did. Verified 2026-08-04.
    if (!latest) {
      for (const line of fs.readFileSync(ledger, 'utf8').split('\n')) {
        const m = /^\[(\d{4}-\d{2}-\d{2})[\s\]]/.exec(line);
        if (m && (!latest || m[1] > latest)) latest = m[1];
      }
    }
    if (!latest) return null;

    const text = fs.readFileSync(profile, 'utf8');
    const re = /^(- \*\*Last contact:\*\*\s*)(\S+)\s*$/m;
    const cur = re.exec(text);
    if (!cur) return null;
    if (cur[2] === latest) return null;

    // RETRY THE WRITE. This runs microseconds after pi exited, and on Windows a
    // just-closed handle from its edit tool can still hold the file long enough
    // for one writeFileSync to fail with EBUSY/EPERM. The first production
    // backfill lost this write on 5 of 6 chunks to exactly that race. Verified
    // in isolation that the logic itself is correct, so retry rather than
    // redesign.
    const out = text.replace(re, `$1${latest}`);
    let lastErr = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.writeFileSync(profile, out);
        return { from: cur[2], to: latest, attempts: attempt + 1 };
      } catch (e) {
        lastErr = e;
        // Synchronous backoff: this is a CLI step, not a server, so blocking a
        // few ms is fine and keeps the function callable from sync code.
        const until = Date.now() + 40 * (attempt + 1);
        while (Date.now() < until) { /* spin */ }
      }
    }
    throw lastErr;
  } catch (e) {
    // Bookkeeping must never fail a merge — but it must not fail SILENTLY
    // either. The first production run swallowed something here and the field
    // simply never moved, with nothing anywhere saying why.
    return { error: String((e && e.message) || e).slice(0, 200) };
  }
}

// Returns { ok: true, output } or { ok: false, error }. Never throws.
//
// opts: { dryRun, quiet, cwd, promptFile, model, thinking, userMessage, sessionDir }. cwd/promptFile let
// the eval harness point this at a throwaway copy of data/ with a candidate
// prompt, so a bad prompt under test can never touch a real profile.
function mergeContact(slug, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const cwd = opts.cwd || ROOT;
  const promptFile = opts.promptFile || MERGE_PROMPT;
  let mergePromptText;
  try {
    mergePromptText = fs.readFileSync(promptFile, 'utf8');
  } catch (e) {
    const error = `could not read merge prompt (${promptFile}): ${e.message}`;
    console.log(`crm-merge: ${slug}: FAIL (${error})`);
    return { ok: false, error };
  }

  // ACTUAL-COST CAPTURE. Production is normally --no-session (no copies of private
  // content outside data/). To read back pi's real per-turn cost we point this one
  // merge at a THROWAWAY session dir UNDER data/ (already gitignored, never
  // committed), sum its usage after the run, then delete it in `finally` — so
  // nothing accumulates and the privacy rationale holds. Evals that pass their own
  // sessionDir keep it: we read cost from it but never delete it. Dry-runs create
  // nothing.
  let tempSession = null;
  let sessionDir = opts.sessionDir || null;
  if (!dryRun && !sessionDir) {
    try {
      const base = path.join(DATA_DIR, '_session-tmp');
      fs.mkdirSync(base, { recursive: true });
      tempSession = fs.mkdtempSync(path.join(base, 'm-'));
      sessionDir = tempSession;
    } catch { tempSession = null; sessionDir = null; }
  }

  const piArgs = buildArgs(slug, mergePromptText, { ...opts, sessionDir });
  const argv = [process.execPath, PI_CLI, ...piArgs];

  if (dryRun) {
    // `quiet` is for library callers (crm-daily plans dozens of chunks and would
    // otherwise dump the entire system prompt once per chunk).
    if (!opts.quiet) {
      console.log(JSON.stringify(argv));
      console.log(`cwd: ${cwd}`);
    }
    return { ok: true, dryRun: true, argv, cwd };
  }

  // RETRY WITH ERROR HANDLING. A weekly run must not fail on a transient blip, so
  // transient errors back off and retry up to `maxAttempts`; only an exhausted or
  // unrecoverable error surfaces. content_filter is special: retrying verbatim is
  // useless and we do NOT auto-guess a replacement (Nathan picks the wording), so the
  // chunk is parked for review and the contact is HELD (see the content_filter branch
  // below and lib/censor-hold.js) — no retry, no spend.
  const maxAttempts = opts.maxAttempts != null ? opts.maxAttempts : Number(process.env.CRM_MERGE_RETRIES || 3);
  const ledgerPath = path.join(cwd, 'data', 'contacts', '_refresh', `${slug}.new.txt`);
  const profileFilePath = path.join(cwd, 'data', 'contacts', `${slug}.md`);
  let profileBefore = null;
  try { profileBefore = fs.readFileSync(profileFilePath, 'utf8'); } catch { /* merge will report its own file error */ }
  const restoreProfile = () => {
    if (profileBefore == null) return;
    try { fs.writeFileSync(profileFilePath, profileBefore); } catch { /* caller still sees failure */ }
  };
  // CENSOR AT MODEL EGRESS (lib/message-context): the committed ledger (.new.txt) is
  // the uncensored Rendered record; pi reads a censored copy (.pi.txt) written from
  // it here and re-written by the content-filter path below. Deleted in the finally
  // so it never enters the committed memory history.
  const piLedgerPath = path.join(cwd, 'data', 'contacts', '_refresh', `${slug}.pi.txt`);
  const writePiLedger = () => { try { fs.writeFileSync(piLedgerPath, redact(fs.readFileSync(ledgerPath, 'utf8'))); return true; } catch { return false; } };
  writePiLedger();
  const piEnv = { ...process.env, PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1' };
  let attempt = 0;
  let lastError = null;
  let lastClass = null;
  try {
    while (true) {
      attempt += 1;
      let stderrCap = '';
      try {
        let output;
        if (opts.stream) {
          // PRODUCTION (crm-daily) path. stdout stays inherited so the model's work
          // shows live in the monitor; stderr is PIPED so a provider error (e.g. a
          // 400 content_filter) can be read back and classified, then re-emitted so
          // the monitor still shows it.
          console.log(`crm-merge: ${slug}: -> ${opts.model || MERGE_MODEL}${opts.label ? ` [${opts.label}]` : ''}${attempt > 1 ? ` (attempt ${attempt})` : ''} ...`);
          const r = spawnSync(process.execPath, [PI_CLI, ...piArgs], {
            cwd, stdio: ['ignore', 'inherit', 'pipe'], timeout: 600_000, env: piEnv,
            encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
          });
          stderrCap = r.stderr || '';
          if (stderrCap) process.stderr.write(stderrCap);
          if (r.error) throw r.error;
          if (r.status !== 0) throw new Error(`pi exited ${r.status}${r.signal ? ` on ${r.signal}` : ''} (see output above)`);
          output = '';
        } else {
          output = execFileSync(process.execPath, [PI_CLI, ...piArgs], {
            cwd, encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024, env: piEnv,
          });
        }
        const fixed = normalizeLastContact(slug, cwd);
        if (fixed && fixed.error) console.log(`crm-merge: ${slug}: Last contact NOT normalised: ${fixed.error}`);
        else if (fixed) console.log(`crm-merge: ${slug}: Last contact ${fixed.from} -> ${fixed.to} (derived)`);
        // Real billed cost of this merge, summed from pi's session usage (all
        // attempts' sessions land in the same dir, so this is the true total spend).
        let costUsd = null;
        if (sessionDir) { const c = sumSessionCostUsd(sessionDir); if (c) costUsd = c.costUsd; }
        // Read the model's reply once (from the session transcript) — used for both
        // the acknowledgment check and nicknames.
        let reply = '';
        if (sessionDir) { try { reply = sessionAssistantText(sessionDir) || ''; } catch { /* no transcript */ } }

        // ACKNOWLEDGMENT CHECK (P3-5). A genuine no-op and a SILENT no-edit failure
        // both exit 0 — a turn-limit cutoff, a refusal, or a silently-failed edit tool
        // all look like success. The prompt's contract is a `DONE …` or `NO-OP` line;
        // its ABSENCE means the merge did not actually happen. Treat that as a failure
        // so crm-daily does NOT mark these messages merged (which would lose them from
        // the profile forever). Conservative: only fails when we HAVE reply text that
        // lacks the ack — an unreadable transcript falls through to success as before,
        // and a false negative merely re-merges next run (never loses data).
        if (reply && !/(^|\n)\s*(DONE\b|NO-?OP\b)/i.test(reply)) {
          restoreProfile();
          return { ok: false, error: 'merge produced no DONE/NO-OP acknowledgment — treated as a failed merge (messages NOT marked merged)', errorClass: 'no_ack', attempts: attempt };
        }

        // STRUCTURED PERSON. Production replies must carry a complete FACTS block
        // (person-to-person mentions are no longer emitted by the model — the
        // deterministic name scan, crm-mention-scan.js, writes the graph). Validate
        // every source against the archive, write the facts in one transaction, then
        // deterministically render What-I-know/identity fields.
        // Evals use throwaway zero-row archives and score the prose edit itself, so
        // they deliberately skip this production write seam.
        let factsStored = 0;
        let mentionsStored = 0;
        if (!opts.deferStructured && opts.structured !== false && cwd === ROOT) {
          try {
            const cdb = openCrmDb();
            try {
              ensureMessagesTable(cdb);
              const profilePath = path.join(cwd, 'data', 'contacts', `${slug}.md`);
              const before = fs.readFileSync(profilePath, 'utf8');
              const ledger = fs.readFileSync(ledgerPath, 'utf8');
              const validMessageIds = [...new Set([...ledger.matchAll(/⟨m(\d+)⟩/g)].map((m) => Number(m[1])))];
              if (!validMessageIds.length) throw new Error('merge ledger contains no message ids');
              cdb.exec('BEGIN IMMEDIATE');
              try {
                const structured = applyStructuredReply(cdb, slug, reply, {
                  required: true, runId: opts.runId || null, resolve: nickResolver().resolve,
                  validMessageIds,
                  validFactMessageIds: [...validMessageIds, ...profileCitationIds(profileBefore || '')],
                  transaction: false,
                });
                const timeline = before.match(/^## Timeline\s*$[\s\S]*/m)?.[0] || null;
                const rendered = renderStructuredProfile(before, structured.facts);
                const afterTimeline = rendered.match(/^## Timeline\s*$[\s\S]*/m)?.[0] || null;
                if (timeline !== afterTimeline) throw new Error('structured renderer changed Timeline bytes');
                fs.writeFileSync(profilePath, rendered);
                markMerged(cdb, slug, validMessageIds, Date.now(), { transaction: false });
                cdb.exec('COMMIT');
                factsStored = structured.factsStored;
                mentionsStored = structured.mentionsStored;
              } catch (e) {
                try { cdb.exec('ROLLBACK'); } catch { /* original error wins */ }
                throw e;
              }
            } finally { cdb.close(); }
          } catch (e) {
            restoreProfile();
            return { ok: false, error: `structured person output rejected: ${e.message}`, errorClass: 'structured_output', attempts: attempt };
          }
        }

        // NICKNAMES. The model emits nicknames as a [[NICKNAMES]] block in its REPLY
        // (never in the profile — the merge prompt forbids that). The store dedups and
        // filters against the per-contact denylist, so re-storing across a retry is
        // free. Best-effort: a parse/store failure must never fail a merge.
        let nicksStored = 0;
        if (reply) {
          try {
            // The ids that ACTUALLY appear in this chunk's ledger — a nickname cite
            // outside this set is a hallucination and is dropped (membership check).
            let validIds = null;
            try {
              const led = fs.readFileSync(path.join(cwd, 'data', 'contacts', '_refresh', `${slug}.new.txt`), 'utf8');
              validIds = new Set([...led.matchAll(/⟨m(\d+)⟩/g)].map((m) => Number(m[1])));
            } catch { /* no ledger — skip membership, still parses/dedups */ }
            nicksStored = storeNicknameProposals(slug, reply, { resolve: nickResolver().resolve, validIds });
          } catch { /* non-fatal telemetry */ }
        }
        console.log(`crm-merge: ${slug}: ok${costUsd != null ? ` ($${costUsd.toFixed(4)})` : ''}${factsStored ? ` (+${factsStored} facts)` : ''}${mentionsStored ? ` (+${mentionsStored} mentions)` : ''}${nicksStored ? ` (+${nicksStored} nickname${nicksStored === 1 ? '' : 's'})` : ''}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
        return { ok: true, output, reply, profileBefore, costUsd, attempts: attempt, factsStored, mentionsStored, nicksStored, lastContactFixed: fixed || undefined };
      } catch (e) {
        restoreProfile();
        lastError = String((e && e.stderr) || stderrCap || (e && e.message) || e).slice(0, 2000);
        lastClass = classifyPiError(lastError);
        // If we couldn't capture the error text but the ledger holds a known slur,
        // it is almost certainly a content filter — treat it as one.
        if (lastClass === 'unknown') {
          try { if (detect(fs.readFileSync(ledgerPath, 'utf8')).length) lastClass = 'content_filter'; } catch { /* no ledger */ }
        }

        if (lastClass === 'content_filter') {
          // HOLD FOR MANUAL REVIEW — do NOT auto-guess a replacement. Nathan's call: he
          // chooses the masking wording himself (see lib/censor-hold.js). We park the
          // whole UNCENSORED rejected chunk so he can SEE the offending words, hold the
          // contact, and stop — no retry, no further spend. crm-daily leaves this
          // contact's cursor untouched and skips held contacts on later runs; ingest
          // resumes for them once he adds a rule and releases the hold
          // (scripts/crm-censor.js). The .pi.txt copy is cleaned up in the finally below.
          let parkedTo = null;
          try {
            const chunk = fs.readFileSync(ledgerPath, 'utf8'); // uncensored .new.txt — the point is to see the words
            parkedTo = require('../lib/censor-hold').hold(slug, chunk, lastError);
          } catch { /* best-effort; the failure below still surfaces */ }
          const rel = parkedTo ? path.relative(cwd, parkedTo) : null;
          console.log(`crm-merge: ${slug}: HELD for censor review — provider rejected the chunk on content grounds.${rel ? ` Chunk saved to ${rel}.` : ''} Resolve with: node scripts/crm-censor.js resolve ${slug} <word> <replacement...>`);
          lastError = `content filter — held for manual censor review${rel ? ` (${rel})` : ''}`;
          lastClass = 'content_filter_held';
          break;
        }
        if (lastClass === 'auth') {
          console.log(`crm-merge: ${slug}: FAIL — auth error, not retrying: ${lastError.slice(0, 160)}`);
          break;
        }
        if (attempt >= maxAttempts) {
          console.log(`crm-merge: ${slug}: FAIL — ${lastClass} error, ${attempt}/${maxAttempts} attempts exhausted: ${lastError.slice(0, 160)}`);
          break;
        }
        const backoffMs = Math.min(60_000, 5_000 * (3 ** (attempt - 1))); // 5s, 15s, 45s
        console.log(`crm-merge: ${slug}: ${lastClass} error on attempt ${attempt}/${maxAttempts}, retrying in ${Math.round(backoffMs / 1000)}s: ${lastError.slice(0, 120)}`);
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoffMs); } catch { /* SAB unavailable — retry immediately */ }
      }
    }
    return { ok: false, error: lastError, errorClass: lastClass, attempts: attempt };
  } finally {
    if (tempSession) { try { fs.rmSync(tempSession, { recursive: true, force: true }); } catch { /* best-effort */ } }
    // The censored model-copy is transient — never let it reach the committed history.
    try { fs.unlinkSync(piLedgerPath); } catch { /* already gone */ }
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const slug = args.find((a) => !a.startsWith('--'));
  if (!slug) {
    console.error('usage: node scripts/crm-merge.js <slug> [--dry-run]');
    process.exit(1);
  }
  const result = mergeContact(slug, { dryRun });
  process.exit(result.ok ? 0 : 1);
}

module.exports = { mergeContact, buildArgs, normalizeLastContact, classifyPiError };
