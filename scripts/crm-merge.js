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
const { ROOT, PI_CLI, MODEL, MERGE_PROMPT } = require('../lib/config');

function buildArgs(slug, mergePromptText) {
  return [
    '-p',
    '--no-session',
    '-nc',
    '--no-extensions',
    '--no-skills',
    '--model', MODEL,
    '--tools', 'read,edit',
    '--system-prompt', mergePromptText,
    `@data/contacts/${slug}.md`,
    `@data/contacts/_refresh/${slug}.new.txt`,
    'Merge the new messages into this profile per your instructions.',
  ];
}

// Returns { ok: true, output } or { ok: false, error }. Never throws.
function mergeContact(slug, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  let mergePromptText;
  try {
    mergePromptText = fs.readFileSync(MERGE_PROMPT, 'utf8');
  } catch (e) {
    const error = `could not read MERGE_PROMPT (${MERGE_PROMPT}): ${e.message}`;
    console.log(`crm-merge: ${slug}: FAIL (${error})`);
    return { ok: false, error };
  }

  const piArgs = buildArgs(slug, mergePromptText);
  const argv = [process.execPath, PI_CLI, ...piArgs];

  if (dryRun) {
    console.log(JSON.stringify(argv));
    console.log(`cwd: ${ROOT}`);
    return { ok: true, dryRun: true, argv, cwd: ROOT };
  }

  try {
    const output = execFileSync(process.execPath, [PI_CLI, ...piArgs], {
      cwd: ROOT,
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
