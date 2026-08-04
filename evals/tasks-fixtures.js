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

// ROUTINE COORDINATION. Literally commitments, but not todo items: arrival times,
// habitual handovers, who is picking up whom. Nathan's own example was "im getting off
// work at 6 and i'll come by 7". The test he gave is whether it would still matter
// tomorrow if forgotten.
const ROUTINE = new RegExp([
  'come by', 'be there', 'on my way', 'omw', 'otw', 'heading (?:over|out|back|home)',
  'get(?:ting)? off work', 'leaving (?:now|soon|work)', 'see (?:you|u|ya)', 'be home',
  'almost there', 'running late', 'on the way', 'be over', 'head(?:ing)? (?:to|there)',
  // Rides and pickups in both directions. "Can u pick me up at 5:30" is the same class
  // of everyday logistics as "I'll come by at 7" — it was landing in the strong tier
  // because only "pick you up" was covered.
  'pick (?:you|u|me|him|her|them|us) up', 'drop (?:you|u|me|him|her|them|us) off',
  'give (?:you|u|me) a ride', 'drive (?:you|u|me)',
  // Standing meal/plan chatter.
  'grab (?:food|lunch|dinner|breakfast|coffee|boba)', 'get (?:food|lunch|dinner|dinner)',
  'wake (?:you|u|me) up', 'call (?:you|u) (?:later|tonight|tmr|tomorrow)',
].map((s) => `\\b${s}\\b`).join('|'), 'i');

// An ASK by the contact. Broader than REQUEST because it also has to catch an
// acceptance of Nathan's offer — "want me to X?" -> "yes pls" is a request too, it just
// arrives second. Deliberately generous: a missed ask silently drops a real commitment
// from the gold set, and the tiering below means a false one only costs a glance.
const ASK = /\b(?:can|could|would|will|cud|cn)\s?(?:you|u|y|ya)\b|\bpls\b|\bplease\b|\bplz\b|\bdon'?t forget\b|\bmake sure\b|\b(?:u|you) should\b|\bmind (?:sending|grabbing|picking|doing)\b|\bsend me\b|\bhelp me\b|\bremind me\b|\bneed (?:you|u|ur|your)\b|\byes pls\b|\byea do\b|\bdo it\b|\bgo ahead\b/i;

const ASK_LOOKBACK = 6;          // messages before an assent in which an ask counts
const THREAD_GAP_MS = 2 * 3600 * 1000;
// Gap-based merging chains transitively: in a conversation where every message is
// within the gap of the previous one, a whole day collapses into a single "thread".
// Observed — nine candidates from "i'll become a youtuber" onward merged into one
// unreviewable block. A thread is also capped on total span and member count.
const THREAD_MAX_SPAN_MS = 12 * 3600 * 1000;
const THREAD_MAX_MEMBERS = 4;

// A THREAD, NOT A MESSAGE, IS THE UNIT. Nathan: "it is possible that a group of
// messages over a long period correspond to a single todo item." His own labels proved
// it — he ticked two separate lines (m2998, m3062) that are one commitment to build one
// app, and the Caden thread spans four messages over two days. Labelling per message
// asks the same question repeatedly and produces a gold set whose ids do not correspond
// to the tasks a prompt actually emits (one per thread).
//
// TIERED, because 158 candidates yielding 4 marks is a labelling job nobody finishes.
// `strong` requires an ask from the contact and is not routine — that is Nathan's own
// stated rule ("it should be things that the other person specifically asks and i
// confirm"). Everything else stays available as `weak` rather than being discarded,
// because gold-set recall is what protects a correct extraction from being scored a
// false positive.
function findCandidates(msgs) {
  const out = [];
  let lastRequestIdx = -Infinity;
  msgs.forEach((m, i) => {
    const b = spoken(m.body);
    if (!b.trim()) return;
    if (isRequest(b)) lastRequestIdx = i;
    if (m.sender !== 'Nathan') return;
    let why = null;
    if (isVerbose(b)) why = 'undertaking';
    else if (AFFIRMATIVE.test(b.trim()) && i - lastRequestIdx <= AFFIRMATIVE_WINDOW) why = 'bare-accept';
    if (why) out.push({ i, why, m });
  });
  return out;
}

// Attach the contact ask that prompted each assent, if there is one.
function withAsks(msgs, cands) {
  return cands.map((c) => {
    let askIdx = -1;
    for (let j = Math.max(0, c.i - ASK_LOOKBACK); j < c.i; j += 1) {
      if (msgs[j].sender !== 'Nathan' && ASK.test(spoken(msgs[j].body))) askIdx = j;
    }
    const routine = ROUTINE.test(spoken(c.m.body)) || (askIdx >= 0 && ROUTINE.test(spoken(msgs[askIdx].body)));
    return { ...c, askIdx, routine, tier: (askIdx >= 0 && !routine) ? 'strong' : 'weak' };
  });
}

// Collapse candidates that sit inside the same conversation burst into one thread. Six
// hours is long enough to hold a morning's back-and-forth together and short enough not
// to merge two unrelated days.
function toThreads(msgs, cands) {
  const threads = [];
  for (const c of cands) {
    const t = msgs[c.i].sent_at;
    const last = threads[threads.length - 1];
    if (last && last.tier === c.tier
        && t - last.endAt <= THREAD_GAP_MS
        && t - last.startAt <= THREAD_MAX_SPAN_MS
        && last.members.length < THREAD_MAX_MEMBERS) {
      last.members.push(c);
      last.endAt = t;
      if (c.askIdx >= 0 && last.askIdx < 0) last.askIdx = c.askIdx;
      continue;
    }
    threads.push({ tier: c.tier, members: [c], askIdx: c.askIdx, startAt: t, endAt: t });
  }
  // The id a prompt would cite is Nathan's assent, so the thread is keyed on the FIRST
  // assent in it — matching what prompts/tasks.md is told to emit.
  return threads.map((t) => ({
    ...t,
    id: t.members[0].m.id,
    lo: Math.min(t.askIdx >= 0 ? t.askIdx : Infinity, ...t.members.map((m) => m.i)),
    hi: Math.max(...t.members.map((m) => m.i)),
    ids: t.members.map((m) => m.m.id),
  }));
}

function buildThreads(msgs) {
  const all = toThreads(msgs, withAsks(msgs, findCandidates(msgs)));
  return {
    strong: all.filter((t) => t.tier === 'strong'),
    weak: all.filter((t) => t.tier === 'weak'),
  };
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

function threadBlock(msgs, t) {
  const L = [];
  const idList = t.ids.join(',');
  const head = msgs[t.members[0].i];
  L.push(`- [ ] m${t.id} (${t.tier}) ids=${idList}  ${head.sender}: ${String(head.body).slice(0, 90)}`);
  if (t.askIdx >= 0) L.push(`      ASK  m${msgs[t.askIdx].id} ${msgs[t.askIdx].sender}: ${String(msgs[t.askIdx].body).slice(0, 140)}`);
  for (const mem of t.members) {
    L.push(`      SAID m${mem.m.id} ${String(mem.m.body).slice(0, 140)}`);
  }
  L.push('');
  return L.join('\n');
}

// Each candidate ships with the surrounding turns, because a bare "ye" is unjudgeable
// alone — the whole question is what it is answering.
function checklistText(slug, name, msgs, threads) {
  const L = [
    `# Gold labels — ${name} (${slug})`,
    '',
    // REVIEWED IS SEPARATE FROM ANY TICK. "I read it and there is nothing here" and
    // "I have not opened this yet" are both zero ticks, and the difference decides
    // whether the contact can be scored at all. ken-chessmore exists precisely as a
    // near-zero negative control — the most direct measure of precision there is — and
    // without this line it could never be used, because an honest all-no verdict is
    // indistinguishable from an untouched file.
    'reviewed: no',
    '',
    'One entry = one COMMITMENT THREAD, not one message. A thread may span several turns',
    'and several days; tick it once.',
    '',
    'Tick `[x]` when the contact asked for something and Nathan agreed to do it, and it',
    'would still matter tomorrow if he forgot. Add `imp=1|2|3` for importance —',
    '3 = someone is blocked or it costs real money/time, 2 = ordinary obligation,',
    '1 = minor but real. Optionally `due=YYYY-MM-DD`; most tasks have no deadline.',
    '',
    'Say NO to: routine coordination ("I\'ll come by at 7"), things Nathan volunteered',
    'unprompted, promises the CONTACT made, vague intent, and anything already done',
    'inside this ledger.',
    '',
    'Parsed from each entry: the `[x]`, `m<id>`, `ids=`, `imp=`, `due=`. Edit anything else.',
    '',
    `STRONG: ${threads.strong.length} (contact asked, non-routine) · WEAK: ${threads.weak.length} (no ask, or routine)`,
    `from ${msgs.length} messages.`,
    '',
    '---',
    '',
    '## Strong candidates — review these',
    '',
  ];
  for (const t of threads.strong) L.push(threadBlock(msgs, t));
  L.push('');
  L.push('## Weak candidates — Nathan volunteered it, or it is routine');
  L.push('');
  L.push('Kept so a correct extraction here is not scored a false positive. Skim; most are no.');
  L.push('');
  for (const t of threads.weak) L.push(threadBlock(msgs, t));
  return L.join('\n');
}

// ---- gold parsing (used by tasks-run.js) ----------------------------------------
// Tolerant on purpose: this file is hand-edited. Anything that is not a recognisable
// candidate line is ignored rather than failing the run.
// THREAD-AWARE. A thread is one task but spans several message ids, and a prompt may
// legitimately cite any of them as the point of agreement. Scoring on the primary id
// alone would mark a correct extraction wrong for choosing a different turn of the same
// exchange, so `yes` contains EVERY id of every ticked thread and `threads` carries the
// grouping the runner needs to count one task per thread rather than one per id.
function parseGold(file) {
  const yes = new Set();
  const all = new Set();
  const due = new Map();
  const importance = new Map();
  const threads = [];
  let unlabelled = 0;
  // Separate from any tick. "I read it and found nothing" is a valid, useful verdict;
  // "I have not opened this" is not — and both are zero ticks.
  const reviewed = /^reviewed:\s*yes\s*$/im.test(fs.readFileSync(file, 'utf8'));
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^- \[([ xX])\]\s*m(\d+)/.exec(line);
    if (!m) continue;
    const id = Number(m[2]);
    const idsMatch = /\bids=([\d,]+)/.exec(line);
    const ids = idsMatch ? idsMatch[1].split(',').map(Number).filter(Boolean) : [id];
    const checked = m[1].toLowerCase() === 'x';
    const tierMatch = /^- \[[ xX]\]\s*m\d+\s*\((\w+)\)/.exec(line);
    for (const x of ids) all.add(x);
    const imp = /\bimp=([123])/.exec(line);
    // Optional, and genuinely optional — most commitments have no date. Present only
    // when Nathan typed one, so deadline accuracy is scored on the subset that has a
    // truth to compare against rather than penalising a correct `null`.
    const d = /\bdue=(\d{4}-\d{2}-\d{2})/.exec(line);
    if (checked) {
      for (const x of ids) yes.add(x);
      if (d) due.set(id, d[1]);
      if (imp) importance.set(id, Number(imp[1]));
    }
    threads.push({ id, ids, checked, tier: tierMatch ? tierMatch[1] : 'strong', due: d ? d[1] : null, importance: imp ? Number(imp[1]) : null });
  }
  // A checklist that is entirely unticked is far more likely to be unlabelled than to
  // be a genuine all-negative verdict, and scoring against it would report a perfect
  // precision of 0/0. The caller decides; we just report it.
  if (!yes.size) unlabelled = all.size;
  return { yes, all, due, importance, threads, reviewed, unlabelled };
}

function goldStatus() {
  if (!fs.existsSync(GOLD_DIR)) return [];
  return fs.readdirSync(GOLD_DIR).filter((f) => f.endsWith('.md')).map((f) => {
    const g = parseGold(path.posix.join(GOLD_DIR, f));
    // Threads, not member ids: a two-turn thread is ONE judgement, and counting ids made
    // caden read as "2/16 marked" when Nathan had made a single decision.
    const strong = g.threads.filter((t) => t.tier === 'strong');
    return {
      slug: f.replace(/\.md$/, ''),
      candidates: strong.length,
      total: g.threads.length,
      marked: g.threads.filter((t) => t.checked).length,
      reviewed: g.reviewed,
      untouched: !g.reviewed,
    };
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

      const threads = buildThreads(msgs);
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
        fs.writeFileSync(gf, checklistText(slug, name, msgs, threads));
      }
      summary.push({ slug, msgs: msgs.length, cands: threads.strong.length, weak: threads.weak.length, window: label, note });
      console.log(`${slug}: ${msgs.length} msgs (${label}) -> ${threads.strong.length} strong, ${threads.weak.length} weak`);
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
      console.log(`${s.slug.padEnd(22)} ${String(s.marked).padStart(2)} task(s) · ${String(s.candidates).padStart(2)} strong / ${String(s.total).padStart(3)} total`
        + `${s.reviewed ? '   reviewed' : '   <- NOT REVIEWED'}`);
    }
    const ready = st.filter((s) => s.reviewed);
    console.log(`\n${ready.length} of ${st.length} contact(s) reviewed and usable as gold.`);
    if (ready.length < st.length) {
      console.log('A reviewed contact with ZERO tasks is still valid gold — it is the');
      console.log('cleanest measure of precision there is. Mark it reviewed either way.');
    }
    return;
  }
  build(process.argv.includes('--force'));
}

if (require.main === module) main();
module.exports = { parseGold, goldStatus, findCandidates, buildThreads, withAsks, toThreads, LEDGER_DIR, GOLD_DIR, GOLD_CONTACTS, CONTAMINATED };
