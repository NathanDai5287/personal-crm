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
const { execFileSync } = require('child_process');
const { ROOT, PI_CLI, MERGE_MODEL, MERGE_PROMPT } = require('../lib/config');

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
  return [
    '-p',
    '--no-session',
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

// Returns { ok: true, output } or { ok: false, error }. Never throws.
//
// opts: { dryRun, quiet, cwd, promptFile, model, userMessage }. cwd/promptFile let
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
    console.log(`crm-merge: ${slug}: ok`);
    return { ok: true, output };
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

module.exports = { mergeContact, buildArgs };
