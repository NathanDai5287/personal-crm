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
const { execFileSync } = require('child_process');
const { ROOT, PI_CLI, MERGE_MODEL, MERGE_PROMPT } = require('../lib/config');
const { dateKey } = require('../lib/weeks');

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
    `@data/contacts/_refresh/${slug}.new.txt`,
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
        const r = h.prepare('select max(sent_at) t from messages where contact_slug = ?').get(slug);
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

  const piArgs = buildArgs(slug, mergePromptText, opts);
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

  try {
    const output = execFileSync(process.execPath, [PI_CLI, ...piArgs], {
      cwd,
      encoding: 'utf8',
      timeout: 600_000, // backfill ledgers can be thousands of messages; give the model room
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1' },
    });
    const fixed = normalizeLastContact(slug, cwd);
    if (fixed && fixed.error) console.log(`crm-merge: ${slug}: Last contact NOT normalised: ${fixed.error}`);
    else if (fixed) console.log(`crm-merge: ${slug}: Last contact ${fixed.from} -> ${fixed.to} (derived)`);
    console.log(`crm-merge: ${slug}: ok`);
    return { ok: true, output, lastContactFixed: fixed || undefined };
  } catch (e) {
    const error = String((e && e.stderr) || (e && e.message) || e).slice(0, 2000);
    console.log(`crm-merge: ${slug}: FAIL (${error.slice(0, 200)})`);
    return { ok: false, error };
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

module.exports = { mergeContact, buildArgs, normalizeLastContact };
