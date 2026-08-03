'use strict';
// crm-tasks.js — extract COMMITMENTS from a ledger into draft tasks.
//
//   node scripts/crm-tasks.js --slug charles-wu            # dry run, prints only
//   node scripts/crm-tasks.js --slug charles-wu --write    # insert drafts
//   node scripts/crm-tasks.js --slug charles-wu --ledger <path>
//   node scripts/crm-tasks.js --all --write                # every tracked contact
//
// This is the third LLM call site (merge, compact, tasks). Like compact it runs with
// NO TOOLS and reads the ledger from stdin; unlike either, it returns JSON and
// writes to a table rather than to markdown.
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
const { render, loadTemplate } = require('../lib/compact-prompt');
const { openCrmDb } = require('../lib/signal-db');
const TASKS = require('../lib/tasks');

// Same template mechanism as compaction, different placeholders.
const TASK_SLOTS = ['CONTACT_NAME', 'TODAY', 'MESSAGES'];
const PROMPT_FILE = process.env.CRM_TASKS_PROMPT || path.posix.join(ROOT, 'prompts', 'tasks.md');
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

function callModel(user, system, model = MODEL) {
  const argv = [PI_CLI, '-p', '--no-session', '-nc', '--no-extensions', '--no-skills', '--no-tools', '--model', model];
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

// opts.promptFile / opts.model let the eval sweep variants without going through env
// vars — the module-level PROMPT_FILE and MODEL are read once at require time, so
// evals/tasks-run.js could not vary them per call otherwise.
function extractFor(slug, ledgerPath, today, opts = {}) {
  const ledger = fs.readFileSync(ledgerPath, 'utf8');
  const ids = ledgerIds(ledger);
  const tpl = loadTemplate(opts.promptFile || PROMPT_FILE);
  const { user, system } = render(tpl, {
    CONTACT_NAME: opts.contactName || contactName(slug),
    TODAY: today,
    MESSAGES: ledger,
  }, TASK_SLOTS);
  const raw = callModel(user, system, opts.model || MODEL);
  const arr = extractArray(raw);
  if (!Array.isArray(arr)) return { ok: false, error: `unparseable reply: ${raw.slice(0, 160)}`, tasks: [] };

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
    tasks.push({
      slug,
      contactName: contactName(slug),
      title: String(t.title),
      description: t.description ? String(t.description) : null,
      owner: t.owner,
      deadline: t.deadline || null,
      confidence: t.confidence,
      msgId: mid,
    });
  }
  return { ok: true, tasks, rejected };
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
  const write = argv.includes('--write');
  const today = arg('--today', new Date().toISOString().slice(0, 10));

  if (!fs.existsSync(PROMPT_FILE)) {
    console.error(`no prompt at ${PROMPT_FILE} — write prompts/tasks.md first`);
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
  console.log(`model: ${MODEL}${MODEL.startsWith(FREE_PREFIX) ? '  (subscription — free)' : '  ** PAID **'}`);
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
      try { res = extractFor(slug, lp, today); } catch (e) {
        console.log(`${slug}: FAILED (${String(e.message).slice(0, 140)})`);
        continue;
      }
      if (!res.ok) { console.log(`${slug}: ${res.error}`); continue; }
      console.log(`${slug}: ${res.tasks.length} commitment(s)${res.rejected.length ? `, ${res.rejected.length} rejected` : ''}`);
      for (const r of res.rejected) console.log(`   ! ${r}`);
      for (const t of res.tasks) {
        // No owner badge: everything that reaches here is Nathan's by construction.
        console.log(`   - ${t.title}${t.deadline ? `  (due ${t.deadline})` : ''}  ⟨m${t.msgId}⟩ ${t.confidence}`);
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
