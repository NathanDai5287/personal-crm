// Local-only CRM data versioning. Commits the personal-crm data/ tree into a
// SEPARATE git history (GITDIR) that has no remote and lives outside any
// public workspace repo. Usage: node memory-commit.js "commit message"
const { execSync } = require('child_process');
const { GITDIR, ROOT } = require('../lib/config');

const WT = ROOT;
const PATHS = ['data'];

const msg = process.argv[2] || 'memory snapshot';
const git = (args) => execSync(`git --git-dir="${GITDIR}" --work-tree="${WT}" ${args}`, { cwd: WT, encoding: 'utf8' });

try {
  git(`add -f ${PATHS.join(' ')}`);
} catch (e) {
  console.log('add issue:', (e.stdout || '') + (e.stderr || '') || e.message);
}
try {
  git(`commit -m ${JSON.stringify(msg)}`);
  console.log('committed:', msg);
} catch (e) {
  const out = (e.stdout || '') + (e.stderr || '');
  if (/nothing to commit|no changes added/i.test(out)) console.log('no changes to commit');
  else console.log('commit issue:', out || e.message);
}
