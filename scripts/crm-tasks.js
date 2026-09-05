'use strict';
// crm-tasks.js — extract COMMITMENTS from a ledger into draft tasks.
//
//   node scripts/crm-tasks.js --slug charles-wu            # dry run, prints only
//   node scripts/crm-tasks.js --slug charles-wu --write    # insert drafts
//   node scripts/crm-tasks.js --slug charles-wu --ledger <path>
//   node scripts/crm-tasks.js --all --write                # every tracked contact
//
// This is the third LLM call site (merge, timeline, tasks). Like the Timeline step it runs with
// NO TOOLS and reads from stdin; unlike either, it returns JSON and writes to a table
// rather than to markdown.
//
// A REGEX DECIDES WHETHER, THE MODEL DECIDES WHAT. lib/task-trigger.js scans for Nathan
// saying "i'll make sure to …", and only the matched lines plus their context reach the
// model, which then works out what "it" referred to and fills in the fields. A ledger with
// no trigger costs ZERO model calls.
//
// This replaced an LLM pass that judged an entire ledger for commitments. That question had
// no stable answer — four rounds of amendments grew the prompt to 27KB and the eval still
// landed at 80% precision / 67% recall, with every round being Nathan correcting the
// model's taste. That prompt and its whole eval apparatus were DELETED, not retired —
// Nathan's call, after deciding retroactive capture is not worth having. Recoverable from
// git history at 2303da2 if a one-off sweep is ever wanted.
//
// WHY A SEPARATE PASS instead of asking the merge for tasks: a merge edits prose and
// is judged on prose. Bolting a JSON side-channel onto it would couple two failure
// modes — a bad task extraction could corrupt a profile — and would make the merge
// eval score two unrelated things at once. Separate call, separate prompt, separate
// eval, and a failure here cannot touch a profile.
//
// DRY RUN BY DEFAULT. --write is required to insert.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PI_CLI, TRACKED, CONTACTS_DIR, REFRESH_DIR, ROOT } = require('../lib/config');
const { render, loadTemplate } = require('../lib/timeline-prompt');
const { openCrmDb } = require('../lib/signal-db');
const TASKS = require('../lib/tasks');
const TRIGGER = require('../lib/task-trigger');

// Same template mechanism as the Timeline step, different placeholders.
const TASK_SLOTS = ['CONTACT_NAME', 'MESSAGES'];
const PROMPT_FILE = process.env.CRM_TASKS_PROMPT || path.posix.join(ROOT, 'prompts', 'tasks-trigger.md');
const MODEL = process.env.CRM_TASKS_MODEL || 'anthropic/claude-opus-5';
const FREE_PREFIX = 'anthropic/';

function contactName(slug) {
  try {
    const md = fs.readFileSync(path.posix.join(CONTACTS_DIR, `${slug}.md`), 'utf8');
    const t = md.split(/\r?\n/).find((l) => l.startsWith('# '));
    if (t) return t.slice(2).trim();
  } catch { /* fall through */ }
  return slug;
}

function callModel(user, system, model = MODEL, sessionDir = null) {
  // A sessionDir makes pi persist the turn (with real per-turn cost.total) so the
  // caller can read the ACTUAL billed cost back via sumSessionCostUsd. Default stays
  // --no-session (evals and dry paths want no side effects).
  const argv = [PI_CLI, '-p', ...(sessionDir ? ['--session-dir', sessionDir] : ['--no-session']),
    '-nc', '--no-extensions', '--no-skills', '--no-tools', '--model', model];
  if (system) argv.push('--system-prompt', system);
  return execFileSync(process.execPath, argv, {
    input: user,                       // stdin: a ledger blows the ~32KB argv limit
    cwd: require('os').tmpdir(),
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1' },
  });
}

// Brace/bracket-balanced scan for the JSON array. Same reasoning as the judges: a
// model occasionally wraps output in prose or a fence, and one malformed reply must
// not take down the run.
function extractArray(s) {
  const start = s.indexOf('[');
  if (start === -1) return null;
  const stack = [];
  let inStr = false, esc = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '[' || c === '{') stack.push(c === '[' ? ']' : '}');
    else if (c === ']' || c === '}') {
      stack.pop();
      if (!stack.length) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

// The ledger is the contract for which ids are citable. An extraction naming a
// message that is not in the ledger it was shown is a hallucination, and the whole
// point of source_msg_id is that it can be trusted.
function ledgerIds(text) {
  const s = new Set();
  for (const m of String(text).matchAll(/^\[[^\]]+\]\s*⟨m(\d+)⟩/gm)) s.add(Number(m[1]));
  return s;
}

// opts.promptFile / opts.model override the module-level PROMPT_FILE and MODEL, which are
// read once at require time and so cannot be varied per call by an env var. Kept for
// testing a prompt variant against a fixture without touching the environment.
function extractFor(slug, ledgerPath, opts = {}) {
  const ledger = fs.readFileSync(ledgerPath, 'utf8');
  const ids = ledgerIds(ledger);

  // THE CHEAP PATH, and the usual one. No trigger, no model call, no cost.
  // opts.window overrides the {before, after} context size. It exists so evals can vary
  // how much context the model gets; production leaves it unset and takes the defaults in
  // lib/task-trigger.js. Without this the window was fixed at 25/8 regardless of how large
  // a ledger it was handed, which silently made "does more context help?" untestable.
  const { windows, nearMisses, total } = TRIGGER.findTriggers(ledger, opts.window || {});
  if (!windows.length) {
    return { ok: true, tasks: [], rejected: [], scanned: total, triggers: 0, nearMisses };
  }

  const tpl = loadTemplate(opts.promptFile || PROMPT_FILE);
  const { user, system } = render(tpl, {
    CONTACT_NAME: opts.contactName || contactName(slug),
    MESSAGES: TRIGGER.renderWindows(windows),
  }, TASK_SLOTS);
  // opts.captureCost (todo scan) runs the model in a throwaway session dir purely
  // to read the ACTUAL billed cost back. This cost is tracked on the run record but
  // is DELIBERATELY kept out of the self-calibrating estimator — extractFor never
  // calls recordCostSample, and todo's own estimate never reads the fitted model.
  let sess = null;
  if (opts.captureCost) {
    try { sess = fs.mkdtempSync(path.join(require('os').tmpdir(), 'crm-todo-sess-')); } catch { sess = null; }
  }
  const raw = callModel(user, system, opts.model || MODEL, sess);
  let costUsd = null;
  if (sess) {
    try { const c = require('../lib/cost').sumSessionCostUsd(sess); if (c) costUsd = c.costUsd; } catch { /* best-effort */ }
    try { fs.rmSync(sess, { recursive: true, force: true }); } catch { /* gone */ }
  }
  const arr = extractArray(raw);
  if (!Array.isArray(arr)) return { ok: false, error: `unparseable reply: ${raw.slice(0, 160)}`, tasks: [] };
  // The regex already decided these are tasks, so a short reply means the model dropped
  // something Nathan explicitly asked to track — the one unrecoverable failure here.
  const dropped = windows.filter((w) => !arr.some((t) => Number(t && t.msg_id) === w.msgId));

  const tasks = [];
  const rejected = [];
  for (const t of arr) {
    if (!t || typeof t !== 'object' || !t.title) { rejected.push('missing title'); continue; }
    const mid = Number(t.msg_id);
    if (!Number.isInteger(mid) || !ids.has(mid)) {
      rejected.push(`m${t.msg_id} not in this ledger — "${String(t.title).slice(0, 48)}"`);
      continue;
    }
    // This is Nathan's todo list only. The prompt is told to emit `owner: "nathan"`
    // and nothing else, so anything here is a regression — rejected loudly rather
    // than inserted, because insertDraft's `OWNERS.has(t.owner) ? t.owner : 'nathan'`
    // would otherwise silently relabel someone else's promise as Nathan's.
    if (t.owner !== 'nathan') {
      rejected.push(`owner "${t.owner}" — not Nathan's commitment: "${String(t.title).slice(0, 48)}"`);
      continue;
    }
    // The semantic citation range (Nathan, 2026-08-10): the stretch a reader
    // needs to understand the task on its own, model-picked, server-clamped.
    // Both endpoints must be lines the model could actually SEE (this trigger's
    // window) and the trigger must sit inside the range — anything else degrades
    // loudly to citing the trigger alone, because a bad range must never mint
    // provenance the way a bad msg_id would.
    const w = windows.find((x) => x.msgId === mid);
    const wIds = new Set(w ? w.ids : [mid]);
    let rs = Number(t.range_start);
    let re = Number(t.range_end);
    if (!Number.isInteger(rs) || !Number.isInteger(re) || !wIds.has(rs) || !wIds.has(re) || rs > mid || re < mid) {
      if (t.range_start != null || t.range_end != null) {
        rejected.push(`range m${t.range_start}-m${t.range_end} not in ⟨m${mid}⟩'s window — citing the trigger alone: "${String(t.title).slice(0, 48)}"`);
      }
      rs = mid; re = mid;
    }
    tasks.push({
      slug,
      contactName: contactName(slug),
      title: String(t.title),
      description: t.description ? String(t.description) : null,
      owner: t.owner,
      // Deadline in, importance derived downstream. `actionable` is coerced rather than
      // rejected: a missing value should cost the task one importance point, not the task
      // itself.
      deadline: t.deadline || null,
      actionable: t.actionable === true,
      msgId: mid,
      rangeStart: rs,
      rangeEnd: re,
    });
  }
  for (const d of dropped) {
    rejected.push(`DROPPED a trigger — model returned nothing for ⟨m${d.msgId}⟩: "${d.body.slice(0, 60)}"`);
  }
  // `dropped` is returned STRUCTURALLY (not only as rejected strings) so the caller can
  // decline to advance its cursor past a trigger the model silently dropped — otherwise
  // an explicit "make sure"/"eod" commitment is lost the moment the cursor steps past it.
  return {
    ok: true, tasks, rejected, scanned: total, triggers: windows.length, nearMisses, costUsd,
    dropped: dropped.map((d) => ({ msgId: d.msgId, body: String(d.body || '').slice(0, 120) })),
  };
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
  const write = argv.includes('--write');

  if (!fs.existsSync(PROMPT_FILE)) {
    console.error(`no prompt at ${PROMPT_FILE} — write prompts/tasks-trigger.md first`);
    process.exit(2);
  }
  if (!MODEL.startsWith(FREE_PREFIX) && !argv.includes('--allow-paid')) {
    console.error(`REFUSING to run '${MODEL}': bills per token. Re-run with --allow-paid if intended.`);
    process.exit(2);
  }

  let slugs;
  if (argv.includes('--all')) slugs = JSON.parse(fs.readFileSync(TRACKED, 'utf8')).slugs || [];
  else {
    const s = arg('--slug', null);
    if (!s) { console.error('usage: node scripts/crm-tasks.js --slug <slug> [--write] | --all --write'); process.exit(2); }
    slugs = [s];
  }

  const explicitLedger = arg('--ledger', null);
  console.log(`model: ${MODEL}${MODEL.startsWith(FREE_PREFIX) ? '  (on plan — no metered cost)' : '  ** PAID **'}`);
  console.log(`prompt: ${PROMPT_FILE}`);
  console.log(write ? 'MODE: --write (drafts will be inserted)\n' : 'MODE: dry run (nothing written)\n');

  let cdb = null;
  if (write) cdb = openCrmDb();
  let totalNew = 0;
  try {
    for (const slug of slugs) {
      const lp = explicitLedger || path.posix.join(REFRESH_DIR, `${slug}.new.txt`);
      if (!fs.existsSync(lp)) { console.log(`${slug}: no ledger at ${lp} — skipped`); continue; }
      let res;
      try { res = extractFor(slug, lp); } catch (e) {
        console.log(`${slug}: FAILED (${String(e.message).slice(0, 140)})`);
        continue;
      }
      if (!res.ok) { console.log(`${slug}: ${res.error}`); continue; }
      if (!res.triggers) {
        console.log(`${slug}: no "i'll make sure" in ${res.scanned} messages — no model call`);
      } else {
        console.log(`${slug}: ${res.triggers} trigger(s) -> ${res.tasks.length} task(s)${res.rejected.length ? `, ${res.rejected.length} rejected` : ''}`);
      }
      // A near-miss is a line where Nathan said "make sure" in a form the scan does not
      // accept. Silence here is the failure mode of the whole design: he thinks he
      // flagged something and nothing happened. Always print them.
      for (const nm of res.nearMisses || []) {
        console.log(`   ~ near-miss, NOT tracked: "${String(nm.body).slice(0, 70)}"`);
      }
      for (const r of res.rejected) console.log(`   ! ${r}`);
      res.tasks.sort((a, b) => TASKS.deriveImportance(b) - TASKS.deriveImportance(a));
      for (const t of res.tasks) {
        // No owner badge: everything that reaches here is Nathan's by construction.
        const imp = TASKS.deriveImportance(t);
        const cite = t.rangeStart && t.rangeStart !== t.rangeEnd
          ? `⟨m${t.rangeStart}-m${t.rangeEnd} @m${t.msgId}⟩` : `⟨m${t.msgId}⟩`;
        console.log(`   [${imp}] ${t.title}${t.deadline ? `  (due ${t.deadline})` : ''}${t.actionable ? '' : '  [blocked]'}  ${cite}`);
        if (write) {
          if (TASKS.insertDraft(cdb, t) === 'inserted') totalNew += 1;
        }
      }
    }
  } finally {
    if (cdb) try { cdb.close(); } catch { /* closed */ }
  }
  if (write) console.log(`\ninserted ${totalNew} new draft(s) (duplicates and previously dismissed keys skipped)`);
  else console.log('\ndry run — re-run with --write to insert');
}

if (require.main === module) main();
module.exports = { extractFor, extractArray, ledgerIds };
