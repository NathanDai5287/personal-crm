// Local-only CRM data versioning. Commits the personal-crm data/ tree into a
// SEPARATE git history (GITDIR) that has no remote and lives outside any
// public workspace repo. Usage: node memory-commit.js "commit message"
//
// ARGV, NOT A SHELL STRING. This used to build one `git ... -m <json>` command
// and hand it to execSync. That worked only for single-line messages: passing a
// message through JSON.stringify turns a newline into the two characters
// backslash-n, and the shell then puts those two characters into the commit
// message literally. Chunk commits now carry git trailers (Model:, Prompt:,
// Run:) on their own lines, which that path would have silently flattened into
// one unparseable line. execFileSync with an argv array has no quoting layer to
// get wrong, and also removes a shell-injection surface from paths.
const { execFileSync } = require('child_process');
const { GITDIR, ROOT } = require('../lib/config');

const WT = ROOT;

// WHAT BELONGS IN A VERSION HISTORY: text that is worth diffing and cannot be
// regenerated. Everything below fails one of those two tests, and `add -f`
// force-adds even ignored files, so each has to be excluded explicitly.
//
//   crm.db          20MB of SQLite. Binary, delta-compresses badly, and a
//                   98-chunk backfill would commit it 98 times (~2GB) while
//                   stalling every chunk on a 20MB hash. It DOES need backing
//                   up — it holds disappearing messages that no longer exist in
//                   Signal — but with a periodic .backup, not per-merge git.
//   signal-key.txt  The Signal DB cipher key. Never belongs in any history.
//   web-password.txt  Dashboard credential. Same reason.
//   contacts/_raw   Bulk message dumps (katia's is 1.4MB). Regenerable from the
//                   archive, so history buys nothing.
//
// KEPT deliberately: contacts/*.md (the whole point), the small state JSONs, and
// contacts/_refresh — the refresh ledgers are overwritten per chunk, so
// committing them captures the exact input that produced each merge.
const PATHS = ['data'];
const EXCLUDE = [
  ':(exclude)data/crm.db',
  ':(exclude)data/crm.db-wal',
  ':(exclude)data/crm.db-shm',
  ':(exclude)data/signal-key.txt',
  ':(exclude)data/web-password.txt',
  ':(exclude)data/contacts/_raw',
];

const msg = process.argv[2] || 'memory snapshot';
const git = (...args) => execFileSync(
  'git',
  ['--git-dir', GITDIR, '--work-tree', WT, ...args],
  { cwd: WT, encoding: 'utf8' },
);

// Anything excluded above that is ALREADY tracked keeps getting committed
// forever, because exclusion only governs `add`. Untrack them once; the blobs
// stay in past commits (harmless — this history has no remote) but stop being
// written to new ones. --ignore-unmatch so a clean repo is not an error.
try {
  git('rm', '--cached', '-r', '--quiet', '--ignore-unmatch',
    'data/crm.db', 'data/crm.db-wal', 'data/crm.db-shm',
    'data/signal-key.txt', 'data/web-password.txt', 'data/contacts/_raw');
} catch (e) {
  const out = (e.stdout || '') + (e.stderr || '');
  if (!/did not match|pathspec/i.test(out)) console.log('untrack issue:', out || e.message);
}

// A REAL failure here must be visible to the caller (crm-daily gates its
// crash-safe snapshot on this process succeeding), so set a non-zero exit code
// rather than logging and exiting 0. "nothing to commit" is NOT a failure.
try {
  git('add', '-f', ...PATHS, ...EXCLUDE);
} catch (e) {
  console.log('add issue:', (e.stdout || '') + (e.stderr || '') || e.message);
  process.exitCode = 1;
}
try {
  git('commit', '-m', msg);
  console.log('committed:', msg.split('\n')[0]);
} catch (e) {
  const out = (e.stdout || '') + (e.stderr || '');
  if (/nothing to commit|no changes added/i.test(out)) console.log('no changes to commit');
  else { console.log('commit issue:', out || e.message); process.exitCode = 1; }
}
