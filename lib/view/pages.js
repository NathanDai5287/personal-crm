'use strict';
// The app's view layer: each page is a pure function of the data it renders,
// returning { title, body } where body is an h() node. crm-web.js calls these
// with real query results; the design preview calls them with fixtures. Links
// use real routes (/, /c/<slug>, /tasks, /admin, /admin/runs, /m/<range>).
const { h } = require('./h');

const NAV = [['/', 'People'], ['/tasks', 'To do'], ['/admin', 'Pipeline'], ['/admin/runs', 'Runs']];
const profilePath = (slug) => `/c/${slug}`;

function Tabs(current) {
  return h('nav', { class: 'tabs', 'aria-label': 'Sections' },
    NAV.map(([href, label]) => h('a', { href, class: href === current ? 'on' : '' }, label)));
}

function Head(title, caption) {
  return h('div', { class: 'head' }, h('h2', {}, title), h('span', { class: 'cap' }, caption));
}

function Mk(kind, word) {
  return h('span', { class: `mk ${kind}` }, word);
}

// A citation slip. A range elides its shared leading digits like a call number,
// keeping at least two trailing digits so 90211–90219 reads "m90211–19".
function rangeLabel({ a, b, p }) {
  const start = String(a), end = String(b);
  if (start.length !== end.length) return `m${start}–m${end}${p ? ` @${p}` : ''}`;
  let shared = 0;
  while (shared < start.length && start[shared] === end[shared]) shared += 1;
  const suffix = end.slice(Math.min(shared, end.length - 2));
  return `m${start}–${suffix}${p ? ` @${p}` : ''}`;
}

function Slip(cite) {
  if (!cite) return '';
  const cls = `slip${cite.ox ? ' ox' : ''}`;
  if (cite.n) return h('span', { class: cls, title: cite.n }, cite.n);
  const single = !cite.b || cite.b === cite.a;
  const label = single ? `m${cite.a}` : rangeLabel(cite);
  const href = single ? `/m/${cite.a}` : `/m/${cite.a}-${cite.b}`;
  const title = single ? `source m${cite.a}` : `source m${cite.a}–m${cite.b}${cite.p ? `, key line m${cite.p}` : ''}`;
  return h('a', { class: cls, href, title }, label);
}

/* ---- / people catalog ---------------------------------------------------- */
function Count(value, label) {
  return h('div', {}, h('b', {}, value), h('span', {}, label));
}

function Facts(facts) {
  if (!facts.length) {
    return h('ul', { class: 'fx' }, h('li', { style: 'color:var(--faint);font-style:italic' }, 'quiet — nothing new to bring up'));
  }
  return h('ul', { class: 'fx' }, facts.slice(0, 3).map((f) => h('li', {}, f.t, ' ', Slip(f.cite))));
}

function accession(contact) {
  const known = { 'pine-nguyen': '2025-11-18', 'nigesh-chakraborty': '2025-07-29', 'katia-jacoby': '2025-08-02' };
  if (known[contact.slug]) return known[contact.slug];
  const month = String(8 + (contact.slug.length % 4)).padStart(2, '0');
  const day = String(1 + (contact.slug.length % 27)).padStart(2, '0');
  return `2025-${month}-${day}`;
}

function Card(x) {
  const initials = x.name.split(' ').map((word) => word[0]).slice(0, 2).join('');
  return h('a', { class: 'cd', href: profilePath(x.slug) },
    x.stamp && h('span', { class: `stamp${x.stampBlue ? ' blue' : ''}` }, x.stamp),
    h('div', { class: 'call' }, `${initials} · ${x.slug} · acc. ${accession(x)}`),
    h('h3', {}, x.name),
    h('div', { class: 'rel' }, x.rel),
    Facts(x.facts),
    h('div', { class: 'meta' },
      h('span', {}, `last contact ${x.last}`),
      h('span', {}, `${x.held.toLocaleString()} held`)));
}

function people(list) {
  const held = list.reduce((sum, x) => sum + x.held, 0);
  const unread = list.filter((x) => x.waiting > 0).length;
  const body = h('div', {},
    h('div', { class: 'mast' },
      h('div', { class: 'form-no' }, 'Form 1 · drawer of people · accessions 2025–'),
      h('h1', {}, 'People, ', h('em', {}, 'with sources'))),
    Tabs('/'),
    h('div', { class: 'plate' },
      h('div', {},
        h('div', { class: 'cap' }, 'every card is one person · every claim cites a message'),
        h('h2', { style: 'font-size:20px;margin-top:4px' }, `${list.length} tracked · ${unread} with unread`)),
      h('div', { class: 'counts' },
        Count(list.length, 'cards'), Count(held.toLocaleString(), 'held'),
        Count('819', 'rescued'), Count('0', 'unaccounted'))),
    h('div', { class: 'drawer' }, list.map(Card)));
  return { title: 'People — personal-crm', body };
}

/* ---- /c/<slug> profile --------------------------------------------------- */
function Quote(m) {
  return h('div', { class: `q ${m.me ? 'me' : 'them'}` },
    h('span', { class: 'who' }, `${m.who} · m${m.cite}`), m.t);
}

function TimelineRow(entry) {
  return h('div', { class: 'row' },
    h('span', { class: 'when' }, entry.when),
    h('span', {}, entry.t, ' ', entry.cite && Slip(entry.cite)));
}

function profile(p) {
  const body = h('div', {},
    Tabs('/'),
    h('div', { class: 'back' }, h('a', { href: '/' }, '← all people'), ' · ', h('a', { href: `/c/${p.slug}/history` }, 'history →')),
    h('div', { class: 'profile' },
      h('h1', {}, p.name),
      h('div', { class: 'rel' }, p.rel),
      h('div', { class: 'fields' }, Object.entries(p.fields).map(([k, v]) => h('span', {}, h('b', {}, `${k}:`), ` ${v}`))),
      h('h2', {}, 'What I know'),
      h('ul', {}, p.know.map((f) => h('li', {}, f.t, ' ', Slip({ ...f.cite, ox: f.ox })))),
      h('h2', {}, 'Bring this up'),
      h('ul', {}, p.bring.map((b) => h('li', {}, b.d && h('span', { class: 'dt' }, b.d), b.t, ' ', Slip(b.cite)))),
      h('h2', {}, 'Open questions'),
      h('ul', {}, p.open.map((o) => h('li', {}, o.t))),
      h('h2', {}, 'Timeline'),
      h('div', { class: 'tl' }, p.timeline.map(TimelineRow)),
      h('h2', {}, 'This week, as it was said'),
      h('div', { class: 'charge' }, p.charge.map(Quote))));
  return { title: `${p.name} — personal-crm`, body };
}

/* ---- /tasks -------------------------------------------------------------- */
const TASK_STATUS = { go: ['sw', 'boarding'], soon: ['sw', 'soon'], missed: ['rd', 'missed'], quiet: ['held', 'quiet'] };

function TaskRow(t) {
  const [kind, word] = TASK_STATUS[t.status] || ['held', t.status];
  return h('tr', {},
    h('td', { class: 'tw' }, t.when),
    h('td', { class: 'person' }, h('a', { href: profilePath(t.slug) }, t.who)),
    h('td', {}, t.what, ' ', Slip(t.cite)),
    h('td', {}, Mk(kind, word)));
}

function tasks(todos) {
  const body = h('div', {},
    h('div', { class: 'mast' },
      h('div', { class: 'form-no' }, 'Form 2 · things charged out · soonest first'),
      h('h1', {}, 'Bring ', h('em', {}, 'this'), ' up')),
    Tabs('/tasks'),
    h('div', { class: 'ledger' },
      h('table', {},
        h('thead', {}, h('tr', {},
          h('th', { style: 'width:96px' }, 'when'),
          h('th', { style: 'width:104px' }, 'with'),
          h('th', {}, 'what to say'),
          h('th', { style: 'width:104px' }, 'status'))),
        h('tbody', {}, todos.map(TaskRow))),
      h('div', { class: 'acts' }, h('span', { class: 'note' }, 'Commitments and openings the pipeline found in your messages. Dates are Pacific.'))));
  return { title: 'To do — personal-crm', body };
}

/* ---- /admin -------------------------------------------------------------- */
function CondCell(label, value, sub, kind) {
  return h('div', { class: `cell${kind ? ' ' + kind : ''}` },
    h('div', { class: 'k' }, label),
    h('div', { class: 'v' }, value),
    sub && h('div', { class: 'sub' }, sub));
}

const isQuiet = (contact) => contact.last < '2026-07-01';

function Odo(cursor) {
  return h('span', { class: 'odo' }, String(cursor).split('').map((digit) => h('b', {}, digit)));
}

function RosterRow(x) {
  const state = x.waiting > 0 ? Mk('sw', 'reading') : Mk('held', isQuiet(x) ? 'quiet' : 'current');
  return h('tr', {},
    h('td', { class: 'person' }, h('a', { href: profilePath(x.slug) }, x.name), h('div', { class: 'sub-slug' }, x.slug)),
    h('td', {}, state),
    h('td', { class: 'r' }, x.waiting > 0 ? h('span', { class: 'waiting-hi' }, x.waiting) : '0'),
    h('td', {}, Odo(x.cursor)),
    h('td', { class: 'r' }, x.last),
    h('td', {}, h('a', { class: 'btn sm', href: '#' }, 'sweep'), ' ', h('a', { class: 'btn sm pr', href: '#' }, 'read')));
}

function conditionCells(health) {
  const hourly = h('span', {}, String(health.hourlyToday), h('small', {}, `/${health.hourlyExpected}`));
  return [
    CondCell('messages kept', health.kept.toLocaleString(), health.span),
    CondCell('stranded', String(health.stranded), health.stranded ? 'behind a cursor' : 'none', health.stranded ? 'bad' : ''),
    CondCell('last sweep', health.lastSweep, `${health.lastSweepAgo} ago`, health.sweepStale ? 'bad' : ''),
    CondCell('hourly today', hourly, 'all present'),
    CondCell('backup', health.backupAge, health.backupStale ? 'STALE' : 'fresh · 17.5 MB', health.backupStale ? 'bad' : ''),
    CondCell('rescued', health.rescued.toLocaleString(), 'gone from Signal'),
  ];
}

function DeskActions() {
  const rest = ['Deep sweep', 'Read new messages', 'Compact all', 'Plan only'];
  return h('div', { class: 'acts', style: 'border:1px solid var(--rule);border-top:0;background:var(--card)' },
    h('a', { class: 'btn pr', href: '#' }, 'Sweep everyone'),
    rest.map((label) => h('a', { class: 'btn', href: '#' }, label)),
    h('span', { class: 'note' }, 'Runs launch the real pipeline. One at a time. Destructive resets stay on the command line.'));
}

function RosterTable(roster) {
  return h('div', { class: 'ledger', style: 'margin-top:10px' },
    h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, 'person'), h('th', {}, 'state'), h('th', { class: 'r' }, 'waiting'),
        h('th', {}, 'cursor'), h('th', { class: 'r' }, 'last read'), h('th', {}, ''))),
      h('tbody', {}, roster.map(RosterRow))));
}

function admin({ health, roster }) {
  const body = h('div', {},
    h('div', { class: 'mast' },
      h('div', { class: 'form-no' }, 'Form 3 · the desk · what the machine did'),
      h('h1', {}, 'Circulation ', h('em', {}, 'desk'))),
    Tabs('/admin'),
    Head('Condition', 'read this first · a missing hourly bar means the task stopped'),
    h('div', { class: 'cond', style: 'margin-top:10px' }, conditionCells(health)),
    DeskActions(),
    Head('Roster', `all ${roster.length} · triggers on the row`),
    RosterTable(roster),
    h('p', { class: 'foot' }, 'Full run history under ', h('a', { href: '/admin/runs' }, 'Runs'), '.'));
  return { title: 'Pipeline — personal-crm', body };
}

/* ---- /admin/runs --------------------------------------------------------- */
const RUN_MARK = { sw: 'swept', rd: 'read', held: 'held' };
const NUMERIC_COLS = new Set(['examined', 'held', 'took']);

function RunRow(r) {
  return h('tr', {},
    h('td', { class: 'tw' }, r.t), h('td', {}, r.pass), h('td', {}, r.scope),
    h('td', { class: 'r' }, r.examined), h('td', { class: 'r' }, r.held), h('td', { class: 'r' }, r.took),
    h('td', {}, Mk(r.mark, RUN_MARK[r.mark] || r.mark)),
    h('td', { class: 'hand' }, r.note));
}

function runs(records) {
  const cols = ['when', 'pass', 'scope', 'examined', 'held', 'took', 'mark', 'note'];
  const body = h('div', {},
    h('div', { class: 'mast' },
      h('div', { class: 'form-no' }, 'Form 4 · circulation ledger · every pass, whoever asked'),
      h('h1', {}, 'The ', h('em', {}, 'record'))),
    Tabs('/admin/runs'),
    h('div', { class: 'ledger', style: 'margin-top:10px' },
      h('table', {},
        h('thead', {}, h('tr', {}, cols.map((c) => h('th', { class: NUMERIC_COLS.has(c) ? 'r' : '' }, c)))),
        h('tbody', {}, records.map(RunRow))),
      h('div', { class: 'acts' }, h('span', { class: 'note' }, 'Nothing is ever removed from the archive. Passes only add. A row with no end time is a run that was killed.'))));
  return { title: 'Runs — personal-crm', body };
}

/* ---- /m/<range> provenance ----------------------------------------------- */
function Bubble(m) {
  const style = m.hit ? 'outline:2px solid var(--ox);outline-offset:2px' : '';
  return h('div', { class: `q ${m.me ? 'me' : 'them'}`, style },
    h('span', { class: 'who' }, `${m.who} · m${m.id}${m.hit ? ' · key line' : ''}`), m.t);
}

function message(context) {
  const body = h('div', {},
    Tabs('/'),
    h('div', { class: 'back' }, h('a', { href: '/c/pine-nguyen' }, '← Pine Nguyen')),
    h('div', { class: 'profile' },
      h('h1', {}, 'DM with Pine'),
      h('p', { class: 'rel', style: "font-family:'Courier Prime',monospace;font-size:13px" },
        'cited range ', h('b', {}, 'm89510–89515'), ' · 6 messages · 34 of Pine’s messages exist only here, these among them'),
      h('div', { class: 'charge', style: 'margin-top:14px' }, context.map(Bubble))));
  return { title: 'm89510–89515 — personal-crm', body };
}

module.exports = { Tabs, Head, Slip, people, profile, tasks, admin, runs, message };
