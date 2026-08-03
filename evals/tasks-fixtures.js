'use strict';
// evals/tasks-fixtures.js — freeze ledgers for the tasks eval and generate the
// labelling checklists that become ground truth.
//
//   node evals/tasks-fixtures.js            # build fixtures + checklists
//   node evals/tasks-fixtures.js --status   # how much labelling is left
//
// WHY FROZEN FIXTURES: `data/contacts/_refresh/*.new.txt` is scratch. It is rewritten
// every run, and its window moves (only 3 of 34 contacts have a cursor; the rest fall
// back to a 30-day lookback). Two agents once disagreed about whether a line existed
// and both were right — they had read different generations of the same path. Ground
// truth cannot sit on top of that, so the ledger text is copied once, here, and never
// regenerated. Rebuilding a fixture invalidates its labels.
//
// WHY UNDER data/: these files contain private message content and hand-written task
// titles. data/ is gitignored in the repo that has a GitHub remote, and versioned in
// the local-only .memory-history.git, which is exactly the protection this needs.
//
// CONTAMINATION: prompts/tasks.md and its v2/v3 variants were written while reading
// arshia, charles, nigesh, pine and liang. Measuring a prompt on ledgers it was
// designed against reports its study material back as a score, which is the mistake
// that made merge-v5 unrankable on its own fixtures. Those five are refused here.
//
// THE CHECKLIST IS DELIBERATELY OVER-INCLUSIVE. A gold set is the set of message ids
// that DO create a task; anything a prompt emits outside that set counts as a false
// positive. So a real commitment missing from the checklist would be scored as an
// extraction error forever after. Recall of the candidate scan matters far more than
// its precision — showing Nathan a hundred junk lines costs him minutes, missing one
// costs the eval its validity.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { CRM_DB, DATA_DIR } = require('../lib/config');

const OUT_DIR = path.posix.join(DATA_DIR, '_eval-tasks');
const LEDGER_DIR = path.posix.join(OUT_DIR, 'ledgers');
const GOLD_DIR = path.posix.join(OUT_DIR, 'gold');

// Read while writing prompts/tasks*.md — cannot be ground truth.
const CONTAMINATED = new Set([
  'arshia-nayebnazar', 'charles-wu', 'nigesh-chakraborty', 'pine-nguyen', 'liang-dai',
]);

// Chosen for volume and for register variety, so the eval is not tuned to one kind of
// relationship. Windows are per-contact so each yields a comparable amount to label.
// Windows are tuned so the whole set is labellable in one sitting (~120 candidates).
// Volume is not the goal — coverage of the borderline cases is. A bigger katia window
// mostly adds more of the same domestic logistics, while a second register adds a
// failure mode the eval could not otherwise see.
const GOLD_CONTACTS = [
  { slug: 'katia-jacoby', days: 7, note: 'partner — dense domestic logistics, highest commitment rate' },
  { slug: 'vlad-munteanu', days: 240, note: 'friend, low volume — sparse-thread control' },
  { slug: 'caden-chiang', days: 90, note: 'friend' },
  { slug: 'runqi-gao', days: 365, note: 'friend, sparse' },
  { slug: 'ken-chessmore', days: 180, note: 'acquaintance — near-zero expected, a negative control' },
];

const DAY = 86_400_000;

// ---- candidate scan -------------------------------------------------------------
// Two tiers. VERBOSE patterns are self-evidently commitment-shaped and stand alone.
// AFFIRMATIVE patterns are bare acceptances — "ye", "bet" — which are meaningless in
// isolation and enormously common, so they only qualify when they follow a request
// within a short window. Fable named these the top false-positive source for the
// prompt, which makes them exactly the lines the gold set must cover.
const VERBOSE = [
  /\bi'?\s?(?:will|ll)\b/i, /\bi'?m gonna\b/i, /\bim gonna\b/i, /\bi'?m going to\b/i,
  /\bim?ma\b/i, /\blemme\b/i, /\blet me\b/i, /\bi can\b/i, /\bi could\b/i,
  /\bi'?ll try\b/i, /\bi should\b/i, /\bi need to\b/i, /\bi'?ve got to\b/i, /\bi gotta\b/i,
  /\bwant me to\b/i, /\bshould i\b/i, /\bdo you want me\b/i, /\bshall i\b/i,
  /\bi owe\b/i, /\bvenmo\b/i, /\bremind me\b/i, /\bi'?ll send\b/i, /\bsend (?:you|u|it|them)\b/i,
  /\bpick (?:it |them |that )?up\b/i, /\bdrop (?:it |them |that )?off\b/i, /\bbring\b/i,
  /\bby (?:tonight|tomorrow|friday|monday|tuesday|wednesday|thursday|saturday|sunday)\b/i,
];
// Negated forms that the patterns above would otherwise catch. "I can't sleep because
// I'm sad" is not an undertaking, and `\bi can\b` matches it.
const NEGATED = /\bi\s?(?:can'?t|cant|won'?t|wont|shouldn'?t|couldn'?t|couldnt|am not|'?m not)\b/i;
const REQUEST = [
  /\bcan (?:you|u)\b/i, /\bcould (?:you|u)\b/i, /\bwould (?:you|u)\b/i, /\bwill (?:you|u)\b/i,
  /\bplease\b/i, /\bpls\b/i, /\bplz\b/i, /\bmind (?:sending|grabbing|picking|doing)\b/i,
  /\byou should\b/i, /\bdon'?t forget\b/i, /\bmake sure (?:you|u)\b/i,
];
const AFFIRMATIVE = /^(?:ye+|yea+h?|yes+|ok+(?:ay)?|k+|bet|sure|word|ight|aight|will do|got it|sounds good|np|deal|fine|yep|yup|mhm|👍|✅)[\s!.,]*$/i;

const AFFIRMATIVE_WINDOW = 6;   // messages after a request in which a bare "ye" counts

// A `[re Nathan: "…"]` prefix is the archive quoting the message being replied to. Its
// text belongs to the OTHER speaker, so matching against it attributes their words to
// this sender — it flagged Katia's "thanks ❤️" as an undertaking because the line she
// was replying to contained "i will take it out". Strip every bracketed enrichment
// before pattern matching; keep the raw body for display.
function spoken(body) {
  return String(body || '').replace(/\[(?:re [^\]]*|photo|link:[^\]]*|PDF:[^\]]*|[a-z ]+)\]/gi, ' ');
}

function isVerbose(b) { return !NEGATED.test(b) && VERBOSE.some((r) => r.test(b)); }
function isRequest(b) { return REQUEST.some((r) => r.test(b)); }

function findCandidates(msgs) {
  const out = [];
  let lastRequestIdx = -Infinity;
  msgs.forEach((m, i) => {
    const b = spoken(m.body);
    if (!b.trim()) return;
    // A request from EITHER side can set up an acceptance, so this is tracked for all
    // senders...
    if (isRequest(b)) lastRequestIdx = i;
    // ...but only Nathan's own words can put Nathan on the hook, so only his lines are
    // candidates. The contact's promises are never his tasks (prompts/tasks.md,
    // "Whose commitments"), so labelling them would be busywork with a known answer.
    if (m.sender !== 'Nathan') return;
    let why = null;
    if (isVerbose(b)) why = 'undertaking';
    else if (AFFIRMATIVE.test(b.trim()) && i - lastRequestIdx <= AFFIRMATIVE_WINDOW) why = 'bare-accept';
    if (why) out.push({ i, why, m });
  });
  return out;
}

// ---- rendering ------------------------------------------------------------------

function fmt(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function ledgerText(name, msgs, label) {
  const head = [
    `# Messages with ${name} — ${label} (Pacific)`,
    `# FROZEN EVAL FIXTURE — do not regenerate; gold labels are keyed to these ids`,
    `# ${msgs.length} messages · ids m${msgs[0].id}–m${msgs[msgs.length - 1].id}`,
    '# sources: DM',
  ].join('\n');
  const lines = msgs.map((m) => `[${fmt(m.sent_at)}] ⟨m${m.id}⟩ ${m.sender}: ${m.body}`);
  return `${head}\n\n${lines.join('\n')}\n`;
}

// Each candidate ships with the surrounding turns, because a bare "ye" is unjudgeable
// alone — the whole question is what it is answering.
function checklistText(slug, name, msgs, cands) {
  const L = [
    `# Gold labels — ${name} (${slug})`,
    '',
    'Mark `[x]` if the line creates a task **for Nathan** — a specific action he agreed',
    'to, alone or jointly, that someone is waiting on. Leave `[ ]` otherwise.',
    '',
    'Say NO to: promises the contact made (those are never Nathan\'s tasks), vague intent',
    '("we should hang out"), things already done inside this ledger, and plans about',
    'himself nobody is waiting on ("i\'ll just get their api").',
    '',
    'Only the `[x]`/`[ ]` and the `m<id>` on each candidate line are parsed. Edit freely',
    'otherwise — add a note after `#` if a call was hard, it is worth recording.',
    '',
    `${cands.length} candidates from ${msgs.length} messages.`,
    '',
    '---',
    '',
  ];
  for (const c of cands) {
    const lo = Math.max(0, c.i - 3);
    const hi = Math.min(msgs.length - 1, c.i + 3);
    L.push(`- [ ] m${c.m.id}  (${c.why})  ${c.m.sender}: ${String(c.m.body).slice(0, 100)}`);
    for (let j = lo; j <= hi; j += 1) {
      const mark = j === c.i ? '>' : ' ';
      L.push(`      ${mark} [${fmt(msgs[j].sent_at)}] m${msgs[j].id} ${msgs[j].sender}: ${String(msgs[j].body).slice(0, 160)}`);
    }
    L.push('');
  }
  return L.join('\n');
}

// ---- gold parsing (used by tasks-run.js) ----------------------------------------
// Tolerant on purpose: this file is hand-edited. Anything that is not a recognisable
// candidate line is ignored rather than failing the run.
function parseGold(file) {
  const yes = new Set();
  const all = new Set();
  const due = new Map();
  let unlabelled = 0;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^- \[([ xX])\]\s*m(\d+)/.exec(line);
    if (!m) continue;
    const id = Number(m[2]);
    all.add(id);
    if (m[1].toLowerCase() === 'x') yes.add(id);
    // Optional, and genuinely optional — most commitments have no date. Present only
    // when Nathan typed one, so deadline accuracy is scored on the subset that has a
    // truth to compare against rather than penalising a correct `null`.
    const d = /\bdue=(\d{4}-\d{2}-\d{2})/.exec(line);
    if (d) due.set(id, d[1]);
  }
  // A checklist that is entirely unticked is far more likely to be unlabelled than to
  // be a genuine all-negative verdict, and scoring against it would report a perfect
  // precision of 0/0. The caller decides; we just report it.
  if (!yes.size) unlabelled = all.size;
  return { yes, all, due, unlabelled };
}

function goldStatus() {
  if (!fs.existsSync(GOLD_DIR)) return [];
  return fs.readdirSync(GOLD_DIR).filter((f) => f.endsWith('.md')).map((f) => {
    const g = parseGold(path.posix.join(GOLD_DIR, f));
    return { slug: f.replace(/\.md$/, ''), candidates: g.all.size, marked: g.yes.size, untouched: !g.yes.size };
  });
}

// ---- build ----------------------------------------------------------------------

function build(force = false) {
  fs.mkdirSync(LEDGER_DIR, { recursive: true });
  fs.mkdirSync(GOLD_DIR, { recursive: true });
  const db = new DatabaseSync(CRM_DB, { readOnly: true });
  const summary = [];
  try {
    for (const { slug, days, note } of GOLD_CONTACTS) {
      if (CONTAMINATED.has(slug)) { console.log(`${slug}: SKIPPED (contaminated)`); continue; }

      // FROZEN MEANS FROZEN. The window is anchored to MAX(sent_at), which advances as
      // new messages arrive, so a rebuild silently produces a different message set —
      // observed: 434 msgs -> 435, 21 candidates -> 22. Preserving the checklist while
      // regenerating the ledger underneath it is the worst of both: labels keyed to ids
      // that may no longer be in the fixture, and new candidates that were never shown.
      // An existing fixture is therefore never touched without --force.
      const lfExisting = path.posix.join(LEDGER_DIR, `${slug}.txt`);
      if (fs.existsSync(lfExisting) && !force) {
        const gfx = path.posix.join(GOLD_DIR, `${slug}.md`);
        const g = fs.existsSync(gfx) ? parseGold(gfx) : { yes: new Set(), all: new Set() };
        console.log(`${slug}: frozen (${g.yes.size}/${g.all.size} labelled) — --force to rebuild and DISCARD labels`);
        continue;
      }
      const last = db.prepare('SELECT MAX(sent_at) t, MAX(id) i FROM messages WHERE contact_slug = ?').get(slug);
      if (!last || !last.t) { console.log(`${slug}: no messages`); continue; }
      // Anchored to the contact's own last message, never wall-clock, so rebuilding
      // this file tomorrow produces the same window.
      const from = last.t - days * DAY;
      const msgs = db.prepare(
        'SELECT id, sent_at, sender, body FROM messages WHERE contact_slug = ? AND sent_at >= ? AND body IS NOT NULL AND TRIM(body) <> \'\' ORDER BY id',
      ).all(slug, from);
      if (!msgs.length) { console.log(`${slug}: nothing in window`); continue; }

      const nameRow = db.prepare('SELECT name FROM contacts WHERE file_path = ?').get(`data/contacts/${slug}.md`);
      const name = (nameRow && nameRow.name) || slug;
      const label = `${fmt(msgs[0].sent_at).slice(0, 10)}..${fmt(msgs[msgs.length - 1].sent_at).slice(0, 10)}`;

      const lf = path.posix.join(LEDGER_DIR, `${slug}.txt`);
      fs.writeFileSync(lf, ledgerText(name, msgs, label));

      const cands = findCandidates(msgs);
      const gf = path.posix.join(GOLD_DIR, `${slug}.md`);
      if (fs.existsSync(gf) && !force) {
        const g = parseGold(gf);
        console.log(`${slug}: checklist kept (${g.yes.size}/${g.all.size} marked)`);
      } else {
        // With --force the ledger has just been rewritten, so any prior labels are keyed
        // to a fixture that no longer exists. Keep a copy rather than deleting work
        // outright — recovering a mis-forced session by hand beats losing it.
        if (fs.existsSync(gf)) {
          const bak = `${gf}.${Date.now()}.bak`;
          fs.copyFileSync(gf, bak);
          console.log(`${slug}: prior labels saved to ${path.basename(bak)}`);
        }
        fs.writeFileSync(gf, checklistText(slug, name, msgs, cands));
      }
      summary.push({ slug, msgs: msgs.length, cands: cands.length, window: label, note });
      console.log(`${slug}: ${msgs.length} msgs (${label}) -> ${cands.length} candidates to label`);
    }
  } finally {
    try { db.close(); } catch { /* closed */ }
  }
  const total = summary.reduce((s, x) => s + x.cands, 0);
  console.log(`\nledgers: ${LEDGER_DIR}`);
  console.log(`gold:    ${GOLD_DIR}`);
  console.log(`\n${total} candidates across ${summary.length} contacts. Tick the real ones with [x].`);
}

function main() {
  if (process.argv.includes('--status')) {
    const st = goldStatus();
    if (!st.length) { console.log('no checklists yet — run without --status first'); return; }
    for (const s of st) {
      console.log(`${s.slug.padEnd(22)} ${String(s.marked).padStart(3)}/${String(s.candidates).padEnd(4)} marked${s.untouched ? '   <- UNLABELLED' : ''}`);
    }
    const ready = st.filter((s) => !s.untouched);
    console.log(`\n${ready.length} of ${st.length} contact(s) labelled and usable as gold.`);
    return;
  }
  build(process.argv.includes('--force'));
}

if (require.main === module) main();
module.exports = { parseGold, goldStatus, findCandidates, LEDGER_DIR, GOLD_DIR, GOLD_CONTACTS, CONTAMINATED };
