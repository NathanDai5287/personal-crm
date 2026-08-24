'use strict';
// The app's view layer: each page is a pure function of the data it renders,
// returning { title, body } where body is an h() node. crm-web.js calls these
// with real query results; the design preview calls them with fixtures. Links
// use real routes (/, /c/<slug>, /tasks, /admin, /admin/runs, /m/<range>).
const { h, raw } = require('./h');
const { dateKey } = require('../weeks');

const NAV = [['/', 'People'], ['/tasks', 'To do'], ['/admin', 'Pipeline'], ['/admin/runs', 'Runs'], ['/me', 'Me']];
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
  const href = single ? `/m/${cite.a}` : `/m/${cite.a}-${cite.b}${cite.p ? `#m${cite.p}` : ''}`;
  const title = (single ? `source m${cite.a}` : `source m${cite.a}–m${cite.b}${cite.p ? `, key line m${cite.p}` : ''}`)
    + (cite.sd ? ` · sent ${cite.sd}` : '');
  // The slip's face is the send date when the caller resolved one (cite.d);
  // the id/range is clutter, so it lives in the hover title with the exact
  // date, and provenance opens in a new tab. No date falls back to a dagger.
  return h('a', { class: cls, href, title, target: '_blank', rel: 'noopener' }, cite.d || '†');
}

/* ---- / people catalog ---------------------------------------------------- */
function Count(value, label) {
  return h('div', {}, h('b', {}, value), h('span', {}, label));
}

// `facts` are trusted HTML strings (citations already rendered by the caller),
// so real profiles keep their ⟨m…⟩ slips and the fixtures render the same way.
function Facts(facts) {
  if (!facts.length) {
    return h('ul', { class: 'fx' }, h('li', { style: 'color:var(--faint);font-style:italic' }, 'quiet — nothing new to bring up'));
  }
  return h('ul', { class: 'fx' }, facts.slice(0, 3).map((html) => h('li', {}, raw(html))));
}

// A card is a <div>, not an <a>: its facts carry citation slips (anchors), and
// an anchor inside an anchor is invalid — the browser closes the card early and
// the rest spills into the grid. Instead the name is the link, stretched over
// the whole card via .cardlink::after; slips sit above it with z-index and stay
// independently clickable.
function Card(x) {
  const initials = x.name.split(' ').map((word) => word[0]).slice(0, 2).join('');
  return h('div', { class: `cd${x.heldReview ? ' held-card' : ''}` },
    x.heldReview
      ? h('span', { class: 'stamp held', title: 'ingest paused — a message was flagged by the content filter; resolve with crm-censor' }, 'held · review')
      : (x.stamp && h('span', { class: `stamp${x.stampBlue ? ' blue' : ''}` }, x.stamp)),
    h('div', { class: 'call' }, `${initials} · ${x.slug}`),
    h('h3', {}, h('a', { class: 'cardlink', href: profilePath(x.slug) }, x.name)),
    h('div', { class: 'rel' }, x.rel),
    Facts(x.facts),
    h('div', { class: 'meta' },
      h('span', {}, `last contact ${x.last || '—'}`),
      h('span', {}, `${(x.held || 0).toLocaleString()} held`)));
}

function people(list, opts = {}) {
  const held = list.reduce((sum, x) => sum + (x.held || 0), 0);
  const unread = list.filter((x) => x.waiting > 0).length;
  const body = h('div', {},
    h('div', { class: 'mast' },
      h('div', { class: 'form-no' }, 'Form 1 · drawer of people'),
      h('h1', {}, 'People, ', h('em', {}, 'with sources'))),
    Tabs('/'),
    NnInbox(opts.suggestions, opts.contacts),
    h('div', { class: 'plate' },
      h('div', {},
        h('div', { class: 'cap' }, 'every card is one person · every claim cites a message'),
        h('h2', { style: 'font-size:20px;margin-top:4px' }, `${list.length} tracked · ${unread} with unread`)),
      h('div', { class: 'counts' },
        Count(list.length, 'cards'), Count(held.toLocaleString(), 'held'), Count(String(unread), 'unread'))),
    h('div', { class: 'drawer' }, list.map(Card)));
  return { title: 'People — personal-crm', body };
}

/* ---- nickname suggestions inbox (People tab) ----------------------------- */
// Every unconfirmed nickname to triage, in one place on the People tab. An ASSIGNED
// suggestion (the model tied it to a contact) shows that contact + a Confirm; an
// UNASSIGNED one shows a contact picker + Assign. Both offer Dismiss. Actions POST
// by id (see NN_INBOX_JS / applyNickInbox in crm-web) and swap this whole block. The
// container always renders (hidden when empty) so the client can reveal/hide it.
function NnInboxCite(c) {
  return h('a', { class: 'nn-cite', href: `/m/${c.a}`, target: '_blank', rel: 'noopener',
    title: `source m${c.a}${c.sd ? ` · sent ${c.sd}` : ''}` }, c.d || '†');
}
function NnInboxItem(s, contacts) {
  const cites = (s.cites || []).map(NnInboxCite);
  const target = s.slug
    ? h('span', { class: 'nn-for' }, 'for ', h('b', {}, s.name || s.slug))
    : h('select', { class: 'nn-assign-sel', 'aria-label': `assign "${s.text}" to a contact` },
      h('option', { value: '' }, 'assign to…'),
      (contacts || []).map((c) => h('option', { value: c.slug }, c.name)));
  return h('li', { class: 'nn-inbox-item', 'data-nn-id': s.id },
    h('span', { class: 'nn-word' }, s.text),
    cites.length ? h('span', { class: 'nn-cites' }, cites) : '',
    target,
    h('span', { class: 'nn-ctl' },
      s.slug
        ? h('button', { type: 'button', class: 'nn-ok', 'data-act': 'confirm' }, raw('&#10003; confirm'))
        : h('button', { type: 'button', class: 'nn-assign', 'data-act': 'assign' }, 'assign'),
      h('button', { type: 'button', class: 'nn-del', 'data-act': 'dismiss' }, 'dismiss')));
}
function NnInbox(suggestions, contacts) {
  const items = suggestions || [];
  return h('div', { class: 'nn-inbox', id: 'nnInbox', hidden: items.length ? undefined : true },
    Head('Nickname suggestions', `${items.length} to review · confirm, assign to a person, or dismiss`),
    h('ul', { class: 'nn-inbox-list' }, items.map((s) => NnInboxItem(s, contacts))));
}

/* ---- nicknames (shown in the profile's identity block) ------------------- */
// The model proposes nicknames it saw in the chats; each stays unverified until you
// confirm it. Each nickname is a tag pill: confirmed reads as a solid stamp-blue
// tint, suggested as an amber dashed outline, and it carries its proof — faint plain
// citation links, each opening that message thread in a new tab. Hover (or focus) a
// pill for its controls — ✓ confirm (suggested only) · ✎ edit · 🗑 delete (a
// two-click confirm). Confirmed nicknames keep edit + delete.
// The trash glyph for the delete control — an outline SVG that inks up from
// currentColor, so it follows the control's faint→danger colouring.
const TRASH_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6.5 7l.8 12a1 1 0 0 0 1 .9h7.4a1 1 0 0 0 1-.9l.8-12"/><path d="M10 11v5M14 11v5"/></svg>';
function NnItem(nick) {
  const suggested = nick.status !== 'confirmed';
  // Provenance rides inside the pill as faint plain links (not the tilted .slip
  // chips) — each opens its source thread in a new tab; a dagger stands in with no date.
  const cites = (nick.cites || []).map((c) => h('a', {
    class: 'nn-cite', href: `/m/${c.a}`, target: '_blank', rel: 'noopener',
    title: `source m${c.a}${c.sd ? ` · sent ${c.sd}` : ''}`,
  }, c.d || '†'));
  // The control span always renders; only ✓ confirm is suggested-only. ✎ edit and
  // 🗑 delete are on every item so a confirmed/hand-added nickname can still be changed.
  return h('span', { class: `nn-tag ${suggested ? 'new' : 'on'}`, 'data-nn-id': nick.id },
    h('span', { class: 'nn-word', title: suggested ? 'suggested — not yet confirmed' : 'confirmed' }, nick.text),
    cites.length ? h('span', { class: 'nn-cites' }, cites) : '',
    h('span', { class: 'nn-ctl' },
      suggested ? h('button', { type: 'button', class: 'nn-ok', title: `confirm "${nick.text}"`, 'aria-label': `confirm ${nick.text}` }, raw('&#10003;')) : '',
      h('button', { type: 'button', class: 'nn-edit', title: `edit "${nick.text}"`, 'aria-label': `edit ${nick.text}` }, raw('&#9998;')),
      h('button', { type: 'button', class: 'nn-del', title: `delete "${nick.text}"`, 'aria-label': `delete ${nick.text}` }, raw(TRASH_SVG))));
}

// Always renders the `.nn` container so every profile can hand-add a nickname: the
// dashed "+ nickname" pill flows inline with the tags and is always present, while the
// label appears only once there are items — an empty profile stays nearly clean.
function Nicks(nicks) {
  const items = nicks || [];
  return h('div', { class: 'nn' },
    items.length ? h('span', { class: 'nn-label' }, 'nicknames') : '',
    h('div', { class: 'nn-tags' },
      items.map(NnItem),
      h('button', { type: 'button', class: 'nn-add', title: 'add a nickname', 'aria-label': 'add a nickname' }, '+ nickname')));
}

/* ---- /c/<slug> profile --------------------------------------------------- */
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
      h('div', { class: 'tl' }, p.timeline.map(TimelineRow))));
  return { title: `${p.name} — personal-crm`, body };
}

/* ---- /me : the owner's own page ------------------------------------------ */
// Nathan isn't a tracked contact (no profile is written ABOUT him), but people
// address him by nicknames ("Wayne") and the merge model needs to know them. This
// page reuses the exact same nickname block + NN_JS as a contact profile — the host
// selector NN_JS looks for is `.phead-id`, so the block sits inside one here too.
function me(nicks) {
  const body = h('div', {},
    h('div', { class: 'mast' },
      h('div', { class: 'form-no' }, 'Form 0 · the reader'),
      h('h1', {}, h('em', {}, 'Me'))),
    Tabs('/me'),
    h('div', { class: 'profile' },
      h('h1', {}, 'Nathan'),
      h('div', { class: 'rel' }, 'you — the person every profile is written for'),
      h('div', { class: 'phead-id' }, Nicks(nicks)),
      h('p', { style: 'margin-top:14px;color:var(--soft)' },
        'Nicknames other people use for you. Add or confirm them here — the merge model is handed your confirmed nicknames so it can tell when a message is about you.')));
  return { title: 'Me — personal-crm', body };
}

/* ---- /tasks -------------------------------------------------------------- */
// Importance is derived (1 + has_deadline + actionable): 3 is due and yours to
// start, 1 is undated or blocked. 2 is the common case and goes unmarked so the
// marks that show mean something. Rendered as a rubber-stamp, like the cards.
const IMP_MARK = { 3: 'high', 1: 'minor' };
const IMP_OPTS = [[3, 'High'], [2, 'Normal'], [1, 'Minor']];
const IMP_HELP = 'Priority — High: has a deadline and is yours to start · Minor: undated, or waiting on someone';

function ImpMark(importance) {
  const word = IMP_MARK[Number(importance)];
  return word ? h('span', { class: `impmark ${word}` }, word) : '';
}

function ImpSelect(value) {
  return h('span', { class: 'selwrap' },
    h('select', { name: 'importance', class: 'fld tw', title: IMP_HELP, 'aria-label': 'priority' },
      IMP_OPTS.map(([v, label]) => h('option', { value: v, selected: Number(value) === v ? true : undefined }, label))));
}

// Where the task came from: the person, and the message where it was agreed.
function TaskSource(t) {
  return h('div', { class: 'tasksrc' },
    t.slug ? ['from ', h('a', { href: profilePath(t.slug) }, t.name || t.slug)] : 'added by hand',
    t.msgId ? [' · agreed ', Slip({ a: t.rangeStart || t.msgId, b: t.rangeEnd || t.msgId, p: t.msgId, d: t.sentD, sd: t.sentKey })] : '',
    t.owner && t.owner !== 'nathan' ? ` · owner ${t.owner}` : '',
    t.probable ? [' · ', h('span', { class: 'prob' }, 'probable')] : '');
}

// Tasks edit in place, like the profile's hand-owned fields: the value is the
// control (click it, or the hover pencil), a seamless editor swaps in, and the
// shared bottom bar saves everything dirty at once. No edit page.
const IMP_WORD = { 1: 'minor', 2: 'norm', 3: 'high' };

function Pencil(label) {
  return h('button', { type: 'button', class: 'ebtn', title: `edit ${label}`, 'aria-label': `edit ${label}` }, raw('&#9998;'));
}

// One inline-editable value: display span, hidden seamless editor, pencil.
// The enclosing .efield carries data-f, the /tasks/edit column the editor feeds.
function TaskField(label, display, value, opts) {
  return [
    h('span', { class: 'efield-val' }, display),
    opts.multiline
      ? h('textarea', { class: 'efield-input', hidden: true, rows: '2', spellcheck: 'false', 'aria-label': label }, value)
      : h('input', { class: 'efield-input', hidden: true, maxlength: opts.maxlength, value,
          placeholder: opts.placeholder || '', 'aria-label': label }),
    Pencil(label)];
}

// Layout is fixed so cards line up: the title always starts at the same column
// (right of the checkbox), the importance mark and due date live in the right
// aside so a "HIGH" stamp never shifts the title, and delete is pinned to the
// bottom-left of every card regardless of what else the card holds. The note
// and due-date fields render even when empty — they surface on card hover so
// there is always somewhere to click — and the importance stamp is a button
// that cycles minor → norm → high, staging like any other field.
function TaskCard(t, today) {
  const done = t.status === 'done';
  const overdue = t.deadline && t.deadline < today && !done;
  const impWord = IMP_WORD[Number(t.importance)] || 'norm';
  return h('div', { class: `taskcard${done ? ' done' : ''}`, 'data-id': t.id },
    h('input', { type: 'checkbox', class: 'taskbox', checked: done ? true : undefined,
      'data-id': t.id, 'aria-label': done ? `reopen ${t.title}` : `mark ${t.title} done` }),
    h('div', { class: 'taskbody' },
      h('div', { class: 'tasktitle efield', 'data-f': 'title' },
        TaskField('title', t.title, t.title, { maxlength: '300' })),
      h('div', { class: `taskdesc efield${t.description ? '' : ' none'}`, 'data-f': 'description' },
        TaskField('note', t.descHtml ? raw(t.descHtml) : h('em', { class: 'tnone' }, 'add a note'),
          t.description || '', { multiline: true })),
      TaskSource(t),
      h('div', { class: 'taskfoot' },
        // Delete is a dismissal, not a row DELETE: the task's key must survive
        // so a re-ingest of the same ledger can never re-draft it.
        h('form', { method: 'post', action: '/tasks/delete', class: 'inl',
          onsubmit: "return confirm('Delete this task? It will not come back, even if a re-ingest finds it again.')" },
          h('input', { type: 'hidden', name: 'id', value: t.id }),
          h('button', { type: 'submit', class: 'btn sm' }, 'delete')))),
    h('div', { class: 'taskaside' },
      h('div', { class: `taskdue efield${overdue ? ' od' : ''}${t.deadline ? '' : ' none'}`, 'data-f': 'deadline' },
        h('span', { class: 'due-k' }, 'due'),
        TaskField('due date', t.deadline || h('em', { class: 'tnone' }, '—'), t.deadline || '',
          { maxlength: '30', placeholder: 'eod, monday…' })),
      h('button', { type: 'button', class: `impmark impbtn ${impWord}`, 'data-val': t.importance,
        title: `${IMP_HELP} · click to change` }, impWord)));
}

function AddSlip() {
  return h('form', { method: 'post', action: '/tasks/add', class: 'slipform' },
    h('input', { class: 'fld', name: 'title', placeholder: 'Add a task yourself…', maxlength: '300', required: true }),
    h('input', { class: 'fld tw', name: 'deadline', placeholder: 'due — eod, monday, aug 15…', maxlength: '30', title: 'Type eod, tomorrow, a weekday, "aug 15", or a date' }),
    ImpSelect(2),
    h('button', { type: 'submit', class: 'btn pr' }, 'Add'));
}

function DraftCard(d) {
  return h('div', { class: 'draftcard' },
    h('div', { class: 'draft-h' }, ImpMark(d.importance), h('span', { class: 'draft-t' }, d.title)),
    d.descHtml ? h('div', { class: 'draft-d' }, raw(d.descHtml)) : '',
    h('div', { class: 'draft-m' },
      d.name || d.slug,
      d.deadline ? ` · due ${d.deadline}` : '',
      d.msgId ? [' · ', Slip({ a: d.rangeStart || d.msgId, b: d.rangeEnd || d.msgId, p: d.msgId, d: d.sentD, sd: d.sentKey })] : '',
      d.probable ? [' · ', h('span', { class: 'prob' }, 'probable')] : ''),
    h('div', { class: 'draft-a' },
      h('form', { method: 'post', action: '/tasks/accept', class: 'inl' },
        h('input', { type: 'hidden', name: 'id', value: d.id }), h('button', { type: 'submit', class: 'btn pr' }, '+ add')),
      h('form', { method: 'post', action: '/tasks/dismiss', class: 'inl' },
        h('input', { type: 'hidden', name: 'id', value: d.id }), h('button', { type: 'submit', class: 'btn' }, 'dismiss'))));
}

function tasks({ counts, active, done, drafts, today }) {
  const doneCount = counts.done || 0;
  const activeCount = counts.active || 0;
  const body = h('div', {},
    h('div', { class: 'mast' },
      h('div', { class: 'form-no' }, 'Form 2 · things charged out · soonest first'),
      h('h1', {}, 'Bring ', h('em', {}, 'this'), ' up')),
    Tabs('/tasks'),
    h('div', { class: 'plate tasktally' },
      h('div', { class: 'cap' }, 'commitments you made · highest priority first'),
      h('div', { class: 'tally' },
        h('span', {}, h('b', { id: 'cActive' }, String(activeCount)), ' active'),
        h('span', {}, h('b', { id: 'cDone' }, String(doneCount)), ' done'),
        h('span', {}, h('b', {}, String(drafts.length)), ' in-tray'))),
    h('div', { class: 'tododesk' },
      h('div', {},
        AddSlip(),
        // The lists carry ids and the empty states hide/show instead of
        // disappearing, so the toggle script can move a card between Active and
        // Done in place — completed items always sit at the bottom, live.
        h('div', { id: 'activeList' },
          active.map((t) => TaskCard(t, today)),
          h('p', { class: 'emptyline', id: 'noActive', style: active.length ? 'display:none' : undefined },
            'Nothing charged out. Add one above, or accept a draft from the in-tray.')),
        h('div', { id: 'doneWrap', style: doneCount ? undefined : 'display:none' },
          Head('Done', 'checked off · kept on file'),
          h('div', { id: 'doneList' }, done.map((t) => TaskCard(t, today))))),
      h('div', { class: 'intray' },
        Head('In-tray', `${drafts.length} found in your messages`),
        h('p', { class: 'intray-note' }, 'Commitments an ingest run pulled from your messages — things you said you would do. Add one to make it yours, then edit.'),
        drafts.length
          ? drafts.map(DraftCard)
          : h('p', { class: 'emptyline' }, 'None. Drafts appear after an ingest run extracts commitments.'))),
    // The same quiet bottom bar the profile page shows while anything is dirty.
    h('div', { class: 'editbar', id: 'editbar', hidden: true },
      h('span', { class: 'editbar-n', id: 'editbarN' }),
      h('button', { type: 'button', class: 'btn sm', id: 'btnCancel' }, 'Cancel'),
      h('button', { type: 'button', class: 'btn sm pr', id: 'btnSave' }, 'Save')));
  return { title: 'To do — personal-crm', body };
}

/* ---- /admin -------------------------------------------------------------- */
function CondCell(label, value, sub, kind) {
  return h('div', { class: `cell${kind ? ' ' + kind : ''}` },
    h('div', { class: 'k' }, label),
    h('div', { class: 'v' }, value),
    sub && h('div', { class: 'sub' }, sub));
}

// A contact is "quiet" when their last contact predates a rolling window (Pacific),
// not a hardcoded date. 30 days: long enough that a normal lull doesn't read as
// quiet, short enough to flag a genuinely cooled relationship. `last` is a Pacific
// YYYY-MM-DD, so a string compare against the same-format threshold is correct.
const QUIET_DAYS = 30;
const isQuiet = (contact) => contact.last < dateKey(Date.now() - QUIET_DAYS * 86_400_000);

// The ingest progress bar. Its full length is the messages COPIED into crm.db for this
// person (x.held); it splits into what's been INGESTED (folded into the profile) and
// what's still WAITING (copied, not yet read). A held contact — ingest paused because a
// message tripped the provider's content filter (lib/censor-hold) — can't advance until
// Nathan resolves it, so its bar and label read oxblood.
function ProgressBar(x) {
  const total = x.held || 0;
  const waiting = Math.max(0, Math.min(x.waiting || 0, total));
  const ingested = total - waiting;
  const pct = (n) => (total > 0 ? (n / total) * 100 : 0);
  const done = total > 0 && waiting === 0;
  const label = total === 0
    ? 'no messages yet'
    : done ? `all ${ingested.toLocaleString()} ingested`
      : `${ingested.toLocaleString()} / ${total.toLocaleString()} ingested`;
  return h('div', { class: 'pcell' },
    h('div', {
      class: `pbar${done ? ' done' : ''}${x.heldReview ? ' held' : ''}`,
      role: 'img', 'aria-label': `${label}${waiting ? `, ${waiting} waiting` : ''}${x.heldReview ? ', held for censor review' : ''}`,
      title: total ? `${ingested.toLocaleString()} ingested · ${waiting.toLocaleString()} waiting · ${total.toLocaleString()} copied to crm.db` : 'nothing archived yet',
    },
      total > 0 ? h('span', { class: 'seg ing', style: `width:${pct(ingested).toFixed(1)}%` }) : null,
      total > 0 && waiting > 0 ? h('span', { class: 'seg wait', style: `width:${pct(waiting).toFixed(1)}%` }) : null),
    h('div', { class: 'pmeta' },
      x.heldReview
        ? h('span', { class: 'held-badge', title: `ingest held — the provider's content filter flagged a message. Resolve in a terminal:\n  node scripts/crm-censor.js resolve ${x.slug} <word> <replacement>` }, 'held · review')
        : h('span', { class: 'plabel' }, label),
      waiting > 0 && !x.heldReview ? h('span', { class: 'pwait' }, `${waiting.toLocaleString()} waiting`) : null,
      isQuiet(x) && !x.heldReview ? h('span', { class: 'pquiet' }, 'quiet') : null,
      h('span', { class: 'plast' }, x.last ? `last ${x.last}` : '—')));
}

function RosterRow(x) {
  return h('tr', x.heldReview ? { class: 'held-row' } : {},
    h('td', { class: 'pickcell' }, h('input', { type: 'checkbox', class: 'pick', name: 'who', value: x.slug,
      'data-cost': x.estCostUsd == null ? '' : String(x.estCostUsd), 'data-calls': String(x.estCalls || 0),
      'data-dur': String(Math.round(x.estDurSec || 0)),
      'aria-label': `select ${x.name}` })),
    h('td', { class: 'person' },
      h('a', { href: profilePath(x.slug) }, x.name),
      ' ',
      h('a', { class: 'ren', href: `/c/${x.slug}/rename`, title: `rename ${x.name}` }, '✎'),
      h('div', { class: 'sub-slug' }, x.slug)),
    h('td', { class: 'prog' }, ProgressBar(x)),
    h('td', {},
      jobButton('sweep', `sweep:${x.slug}`, 'sm'), ' ',
      jobButton('ingest', `ingest:${x.slug}`, 'sm pr')));
}

function conditionCells(health) {
  const strandedBad = typeof health.stranded === 'number' && health.stranded > 0;
  return [
    CondCell('messages kept', health.kept, health.span),
    CondCell('stranded', String(health.stranded), health.strandedSub, strandedBad ? 'bad' : ''),
    CondCell('last sweep', health.lastSweep, health.lastSweepSub, health.sweepStale ? 'bad' : ''),
    CondCell('waiting', health.waiting, health.waitingSub),
    ...(health.heldReview ? [CondCell('held · review', String(health.heldReview), 'censor filter', 'bad')] : []),
    CondCell('backup', health.backupAge, health.backupStale ? 'STALE' : health.backupSub, health.backupStale ? 'bad' : ''),
    CondCell('tracked', health.tracked, 'people'),
  ];
}

const DIAL_RADIUS = 32;
const DIAL_CIRC = 2 * Math.PI * DIAL_RADIUS;

function dialTicks() {
  return Array.from({ length: 12 }, (_, i) => {
    const angle = (i / 12) * 2 * Math.PI - Math.PI / 2;
    const inner = i % 3 === 0 ? 37 : 40;
    return h('line', { class: 'tick',
      x1: (45 + inner * Math.cos(angle)).toFixed(1), y1: (45 + inner * Math.sin(angle)).toFixed(1),
      x2: (45 + 44 * Math.cos(angle)).toFixed(1), y2: (45 + 44 * Math.sin(angle)).toFixed(1) });
  });
}

// Only the PAID jobs carry a per-dial pause switch — the sweeps always run
// (see lib/jobs.js / lib/run-toggles.js). Timeline is not a job and has no dial.
const { MODEL_JOBS } = require('../jobs');
const TOGGLE_SET = new Set(MODEL_JOBS);
// The jobs that expose a model dropdown on their card — only the model-spending
// ones. The ingest card's model governs the Timeline step server-side.
const MODEL_SET = new Set(MODEL_JOBS);

function RunDial(d, toggles = {}, models = {}, modelOptions = [], modelDefaults = {}) {
  // A paused dial keeps its real schedule (the switch only sets a flag the run
  // checks — the timer is untouched), so it just shows "—" and a muted arc.
  const toggleable = TOGGLE_SET.has(d.job);
  const paused = toggleable && toggles[d.job] === false;
  const filled = paused ? 0 : Math.max(0, Math.min(1, d.fraction));
  const dash = `${(filled * DIAL_CIRC).toFixed(1)} ${DIAL_CIRC.toFixed(1)}`;
  const center = paused ? '—' : d.center;
  const centerSub = paused ? 'paused' : d.centerSub;
  return h('div', { class: `dial${d.kind ? ' ' + d.kind : ''}${d.overdue && !paused ? ' overdue' : ''}${paused ? ' paused' : ''}` },
    // The switch is a submit button (name=toggle, so the run-confirm modal, which
    // only intercepts button[name=job], ignores it) that posts the whole desk
    // form to /admin/toggle via formaction — the only way to sit a "form" inside
    // the /admin/jobs form without illegally nesting one. A bare post flips state.
    toggleable ? h('button', {
      type: 'submit', name: 'toggle', value: d.job,
      formaction: '/admin/toggle', formmethod: 'post',
      class: `dialswitch ${paused ? 'off' : 'on'}`,
      title: paused ? `resume automatic ${d.label} runs` : `pause automatic ${d.label} runs`,
      'aria-label': paused ? `resume automatic ${d.label} runs` : `pause automatic ${d.label} runs`,
    }, paused ? 'paused' : 'on') : null,
    h('svg', { class: 'dialface', viewBox: '0 0 90 90', role: 'img', 'aria-label': `${d.label}: ${d.since}, ${center} ${centerSub}` },
      h('circle', { class: 'track', cx: 45, cy: 45, r: DIAL_RADIUS }),
      h('circle', { class: 'arc', cx: 45, cy: 45, r: DIAL_RADIUS, 'stroke-dasharray': dash, transform: 'rotate(-90 45 45)' }),
      dialTicks(),
      h('text', { class: 'num', x: 45, y: 46 }, center),
      h('text', { class: 'lab', x: 45, y: 57 }, centerSub)),
    h('div', { class: 'dialcap' },
      h('b', {}, d.label),
      h('span', { class: 'dcad' }, d.cadence),
      h('span', { class: 'dsince' }, d.since),
      // Run trigger and model picker share one right-aligned row at the card's
      // bottom, so the dropdown sits beside ▸ run rather than stacked under it.
      h('div', { class: 'dialactions' },
      // Each dial is also its own trigger: the confirm modal intercepts it and
      // scopes to the checked roster (or everyone). ingest spends the model → pr.
      // A hand-started run passes --force, so it works even while paused.
      d.job ? jobButton('▸ run', d.job, `sm dialbtn${d.job === 'ingest' ? ' pr' : ''}`) : null,
      // Model picker (ingest/todo only). Same nested-form dodge as the switch: a
      // submit button with name=setmodel (not "job") + formaction posts the desk
      // form to /admin/model. Changing the select auto-submits by clicking the
      // hidden submit — there is no visible "set" button. There is no "default"
      // option: the picker always shows a concrete model — the stored override if
      // any, else the job's effective default (modelDefaults) — so what's displayed
      // is what will run. Selecting the default just stores it explicitly.
      MODEL_SET.has(d.job) ? h('div', { class: 'dialmodel' },
        (() => {
          const selectedModel = models[d.job] || modelDefaults[d.job];
          return h('select', {
            name: `model:${d.job}`, class: 'dmsel', 'aria-label': `model for ${d.label}`,
            onchange: "var b=this.closest('.dial').querySelector('.dmset'); if(b) b.click();",
          },
            modelOptions.map((m) => h('option', {
              value: m.id, selected: selectedModel === m.id ? true : undefined,
            }, m.label)));
        })(),
        h('button', {
          type: 'submit', name: 'setmodel', value: d.job,
          formaction: '/admin/model', formmethod: 'post', class: 'dmset',
        }, 'set')) : null)));
}

// A run trigger: a submit button inside the roster <form> (POST /admin/jobs).
// `value` is the job kind ("sweep") or "<kind>:<slug>" for a single-person row
// trigger. The confirm modal wired on /admin intercepts the click, resolves the
// exact people the run will touch, and submits the form only on approval.
function jobButton(label, value, cls) {
  return h('button', { type: 'submit', class: `btn ${cls || ''}`, name: 'job', value }, label);
}

function RosterTable(roster) {
  return h('div', { class: 'ledger', style: 'margin-top:10px' },
    h('table', {},
      h('thead', {}, h('tr', {},
        h('th', { class: 'pickcell' }, h('input', { type: 'checkbox', 'aria-label': 'select all',
          onclick: "for(var c of this.closest('table').querySelectorAll('.pick'))c.checked=this.checked" })),
        h('th', {}, 'person'), h('th', {}, 'ingest progress'), h('th', {}, ''))),
      h('tbody', {}, roster.map(RosterRow))));
}

// The nomenclature guide. Only sweep touches Signal and it never calls the
// model; the model runs weekly, at ingest. The `model` flag colours the cost so
// the no-model/paid split is legible at a glance.
// First element is the internal kind id — it keys the job ink (--k-*), so the
// legend term wears the same colour as the run's chip, dial, and slip stamp.
const LEGEND_JOBS = [
  ['sweep', 'sweep', 'Copies new messages from Signal into the archive, so nothing is lost — including disappearing messages.', 'no model', false, 'hourly · deep daily'],
  ['ingest', 'ingest', 'Reads a person’s waiting messages into their profile, week by week, each claim citing a message.', 'calls the model', true, 'weekly · Mondays'],
  ['timeline', 'timeline', 'Ingest’s second half: builds and maintains the chronological Timeline — one dated summary line per day, aged into per-week then per-season lines. No verbatim message copies.', 'calls the model', true, 'part of ingest'],
  ['todo', 'todo', 'Scans new messages for "make sure …" or "eod" commitments and drafts a task from each; a model runs only when a line matches.', 'model only on a match', false, 'hourly · after sweep'],
];
const LEGEND_WORDS = [
  ['archive', 'The permanent copy in crm.db. Nothing is ever deleted from it, so a message that vanished from Signal still lives here.'],
  ['ingest progress', 'The bar in each row: its full length is the messages copied into crm.db for that person; the moss part is what ingest has folded into their profile, the amber part is still waiting.'],
  ['waiting', 'Archived messages ingest has not folded into the profile yet — the amber part of the bar.'],
  ['held · review', 'Ingest is paused for this person: a message tripped the model provider’s content filter and needs a manual masking rule (resolve in a terminal with crm-censor). The bar reads oxblood until it is cleared.'],
  ['deep', 'A sweep modifier: ignore cursors and re-walk all of history, to catch reused row ids left by disappearing messages.'],
  ['plan only', 'An ingest modifier: a dry run that shows what would merge — no model, no writes.'],
  ['backup', 'An off-machine copy of crm.db. Keep it fresh before a backfill.'],
];

function Legend() {
  return h('div', {},
    Head('Key', 'what each run does · and the words on this page'),
    h('div', { class: 'legend' },
      h('table', { class: 'legend-jobs' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'run'), h('th', {}, 'what it does'), h('th', {}, 'cost'), h('th', {}, 'cadence'))),
        h('tbody', {}, LEGEND_JOBS.map(([kind, term, what, cost, model, cadence]) =>
          h('tr', {},
            h('td', {}, h('span', { class: `legend-term ${kind}` }, term)),
            h('td', { class: 'legend-what' }, what),
            h('td', { class: `legend-cost${model ? ' model' : ''}` }, cost),
            h('td', { class: 'legend-cadence' }, cadence))))),
      h('dl', { class: 'legend-words' },
        LEGEND_WORDS.map(([term, def]) =>
          h('div', { class: 'legend-word' }, h('dt', {}, term), h('dd', {}, def))))));
}

function admin({ health, roster, dials, toggles, models, modelOptions, modelDefaults }) {
  const body = h('div', {},
    h('div', { class: 'mast' },
      h('div', { class: 'form-no' }, 'Form 3 · the desk · what the machine did'),
      h('h1', {}, 'Circulation ', h('em', {}, 'desk'))),
    Tabs('/admin'),
    Head('Condition', 'read this first · a missing hourly bar means the task stopped'),
    h('div', { class: 'cond', style: 'margin-top:10px' }, conditionCells(health)),
    h('form', { method: 'post', action: '/admin/jobs' },
      Head('Cadence', 'each dial is a job · the arc is time elapsed, the number is time until next · press ▸ run to trigger it · paid jobs (ingest · todo) carry a switch that pauses their automatic schedule and a dropdown for the model · the sweeps always run'),
      h('div', { class: 'dials' }, dials.map((d) => RunDial(d, toggles || {}, models || {}, modelOptions || [], modelDefaults || {}))),
      Head('Roster', `all ${roster.length} · check people to scope a run to them (else everyone) · a row’s own trigger runs just one · ✎ renames`),
      RosterTable(roster)),
    Legend(),
    h('p', { class: 'foot' }, 'Full run history under ', h('a', { href: '/admin/runs' }, 'Runs'), '.'));
  return { title: 'Pipeline — personal-crm', body };
}

/* ---- /admin/runs --------------------------------------------------------- */
// The job type IS the row's colour: sweep (no-model, cool blue), ingest and timeline
// (both spend the model — oxblood and amber). A failed run (ok:false) reddens its
// note. `kind` is the internal id ('sweep'|'ingest'|'timeline'|'todo'); 'compact'
// is the pre-rename spelling still worn by older run records, mapped alongside.
// The clean noun shown in the kind chip. `deep` (a deep sweep) is set per-row via
// r.kindWord since it shares the 'sweep' colour; everything else maps by kind.
const KIND_WORD = { sweep: 'sweep', ingest: 'ingest', timeline: 'timeline', compact: 'timeline', todo: 'todo', manual: 'edit' };
const KIND_LABEL = { sweep: 'Sweep', 'deep-sweep': 'Deep sweep', ingest: 'Ingest', timeline: 'Timeline', compact: 'Timeline', todo: 'Todo' };
const NUMERIC_COLS = new Set(['result', 'cost', 'took']);
// A cost cell that carries no metered charge (a subscription/anthropic run, or a
// no-model run). Matches the current label ('on plan') plus older/other spellings.
const isFreeMoney = (v) => v === 'on plan' || v === '$0 · sub' || v === '$0' || v === 'free';

function RunRow(r) {
  // The `when` cell links a completed row to its detail (steps + log), a live row
  // to the monitor.
  const word = r.kindWord || KIND_WORD[r.kind] || r.kind;
  const free = isFreeMoney(r.actual);
  const whenCell = r.href ? h('td', { class: 'tw' }, h('a', { href: r.href }, r.t)) : h('td', { class: 'tw' }, r.t);
  return h('tr', { class: r.live ? 'runrow live' : 'runrow', 'data-kind': word, 'data-free': free ? '1' : '0' },
    whenCell,
    h('td', {}, Mk(r.kind, word)),
    h('td', {}, r.scope),
    // `result` = what the run produced (messages archived, tasks drafted, people
    // merged, fields changed) — the old "held" cell, renamed to say what it is.
    h('td', { class: 'r result' }, r.held),
    // A single COST cell = the ACTUAL billed figure (free / $x / — when not captured).
    h('td', { class: `r cost${free ? ' free' : r.actual === '—' ? ' none' : ''}` }, r.actual),
    h('td', { class: 'r' }, r.took));
}

// Every kind that can appear as a filter chip, in a stable order. `deep` sits
// next to sweep; the order matches the pipeline's flow.
const RUN_FILTER_KINDS = ['sweep', 'deep', 'ingest', 'timeline', 'todo', 'edit'];

function RunsFilter(records) {
  // Only offer chips for kinds actually present, so the bar never shows a dead
  // filter. Client JS (RUNS_FILTER_JS) does the hiding + remembers the choice.
  const present = new Set(records.map((r) => r.kindWord || KIND_WORD[r.kind] || r.kind));
  const chips = RUN_FILTER_KINDS.filter((k) => present.has(k)).map((k) =>
    h('button', { type: 'button', class: 'rfchip on', 'data-k': k }, k));
  return h('div', { class: 'runfilter' },
    h('span', { class: 'rflab' }, 'show'),
    h('span', { class: 'rfchips' }, chips),
    h('label', { class: 'rffree' },
      h('input', { type: 'checkbox', id: 'rfHideFree' }), ' hide on-plan runs'));
}

function runs(records) {
  const cols = ['when', 'kind', 'scope', 'result', 'cost', 'took'];
  const body = h('div', {},
    h('div', { class: 'mast' },
      h('div', { class: 'form-no' }, 'Form 4 · circulation ledger · every pass, whoever asked'),
      h('h1', {}, 'The ', h('em', {}, 'record'))),
    Tabs('/admin/runs'),
    RunsFilter(records),
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

/* ---- /admin/jobs/<id> live monitor --------------------------------------- */
const JOB_STATUS = { running: ['sw', 'running'], done: ['sw', 'done'], failed: ['rd', 'returned'] };

// Live progress for a running job. Determinate bar during ingest (chunk N/total +
// ETA); an indeterminate pulse during the Timeline phase, whose
// sub-steps aren't counted. Ids let the monitor's poll update it in place.
function ProgressBlock(j) {
  const p = j.progress;
  const phase = p ? p.phase : 'start';
  const pct = p && p.phase === 'ingest' ? p.pct : 100;
  const label = !p ? 'starting…'
    : p.phase === 'timeline' ? `ingest complete (${p.total}/${p.total}) · building Timeline…`
      : `ingesting · chunk ${p.done}/${p.total}${p.eta ? ` · ~${p.eta} left` : ''}`;
  return h('div', { class: 'prog', style: 'margin:12px 0' },
    h('div', { class: 'pbar', id: 'pbar', 'data-phase': phase },
      h('i', { id: 'pbarFill', style: `width:${pct}%` })),
    h('div', { class: 'proglab', id: 'progLab' }, label));
}

function job(j) {
  const running = j.status === 'running';
  const [kind, word] = JOB_STATUS[j.status] || ['held', j.status];
  const jobLabel = KIND_LABEL[j.kind] || j.kind;
  // The kind chip wears the job ink (deep sweep is a sweep); status keeps its own.
  const jobKind = j.kind === 'deep-sweep' ? 'sweep' : j.kind;
  const body = h('div', {},
    Tabs('/admin'),
    h('div', { class: 'back' }, h('a', { href: '/admin' }, '← pipeline')),
    h('div', { class: 'mast' },
      h('div', { class: 'form-no' }, `job ${j.id} · ${j.scope}`),
      h('h1', {}, 'Charged out — ', h('em', {}, jobLabel))),
    h('div', { class: 'jobhead' },
      jobKind && Mk(jobKind, jobLabel),
      Mk(kind, word),
      h('span', { class: 'jobmeta' }, `started ${j.startedAt} · ${j.elapsed} · ${j.step} · ${j.model}`)),
    running && ProgressBlock(j),
    h('pre', { class: 'joblog' }, j.log),
    h('p', { class: 'foot' }, running
      ? 'This page updates live as the run prints. Leave it open — the run continues even if you navigate away.'
      : 'Run finished. The full record is under Runs.'));
  return { title: `${jobLabel} — job ${j.id}`, body };
}

/* ---- /c/<slug>/rename ---------------------------------------------------- */
function rename({ slug, name }) {
  const body = h('div', {},
    Tabs('/admin'),
    h('div', { class: 'back' }, h('a', { href: '/admin' }, '← pipeline')),
    h('div', { class: 'profile', style: 'max-width:540px' },
      h('h1', {}, 'Rename'),
      h('p', { class: 'rel' }, 'Change the display name for ', h('code', {}, slug),
        '. This rewrites the profile title only — the slug, archive, cursors, and history are unchanged.'),
      h('form', { method: 'post', action: `/c/${slug}/rename`, class: 'renameform' },
        h('input', { type: 'text', name: 'name', value: name, 'aria-label': 'new name', autofocus: true, maxlength: '120' }),
        h('div', { class: 'renameactions' },
          h('button', { type: 'submit', class: 'btn pr' }, 'Rename'),
          h('a', { class: 'btn', href: '/admin' }, 'Cancel')))));
  return { title: `Rename ${name} — personal-crm`, body };
}

module.exports = { Tabs, Head, Slip, Nicks, NnInbox, people, profile, me, tasks, admin, runs, message, job, rename };
