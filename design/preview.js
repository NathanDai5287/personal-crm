'use strict';
// Renders the real view layer (lib/view) against fixtures, over HTTP, so the
// Bindery UI can be judged before it is wired to the pipeline. This is the app
// minus real data: same pages, same routes, same shell. The states sheet below
// is the one preview-only screen — a design reference for the pipeline states
// the admin page will eventually show inline.
//
//   node design/preview.js     # http://localhost:8799/
const http = require('http');
const { h } = require('../lib/view/h');
const { page } = require('../lib/view/shell');
const V = require('../lib/view/pages');
const F = require('./fixtures');

const PORT = 8799;

const INPROGRESS_LOG = `[4] merge nigesh-chakraborty 3/6 (week of Jul 14, 812 msgs): ok, cursor → 90420
[4] citation check: 41 cited ids, all resolve
[4] merge nigesh-chakraborty 4/6 (week of Jul 21, 903 msgs): …`;

function Notice(kind, banner, ...content) {
  return h('div', { class: `notice${kind ? ' ' + kind : ''}` },
    h('div', { class: 'banner' }, banner),
    h('p', {}, ...content));
}

function statesSheet() {
  const body = h('div', {},
    h('div', { class: 'mast' },
      h('div', { class: 'form-no' }, 'preview only · pipeline states the admin page will show'),
      h('h1', {}, 'When it is ', h('em', {}, 'not'), ' nominal')),
    V.Tabs('/admin'),
    V.Head('Overdue notice', 'stranded messages found'),
    Notice('', 'Overdue · 669 messages were behind their cursors',
      'Ritvik 338, Darren 331 — copied before the 30-day window, then stranded below the watermark. A deep sweep recovered them; the count is 0 now. ',
      h('a', { href: '#' }, 'Run a deep sweep →')),
    V.Head('Backup aging', 'soft caution, not yet wrong'),
    Notice('amber', 'Caution · backup is 7 days old',
      'Stale at 8 days. Do not start a backfill until this is fresh. ', h('a', { href: '#' }, 'Back up now →')),
    V.Head('Pass in progress', 'a run is charged out'),
    h('div', { class: 'inprogress' },
      h('div', { class: 'banner' }, 'Reading · nigesh-chakraborty · chunk 3 of 6', h('span', { class: 'barber' }, h('i', {}))),
      h('pre', {}, INPROGRESS_LOG)),
    V.Head('Returned to desk', 'a run failed'),
    Notice('', 'Returned · sweep could not take the archive',
      'A page load held ', h('code', {}, 'crm.db'), ' open. The sweep waited 15 s, then gave up rather than fail halfway. Nothing was lost. ',
      h('a', { href: '#' }, 'Try again →')),
    V.Head('Nothing charged out', 'an empty, healthy queue'),
    h('div', { class: 'quiet' },
      h('div', { class: 'big' }, 'nothing waiting'),
      h('p', {}, 'Every message is read into a profile. The next scheduled pass is Monday, 04:00 Pacific.')));
  return { title: 'States — preview', body };
}

const DIRECTORY = [
  ['/', 'People', 'the card drawer — every claim stamped with its source'],
  ['/c/pine-nguyen', 'A profile', 'what I know · bring this up · timeline · as it was said'],
  ['/tasks', 'To do', 'bring-this-up, soonest first'],
  ['/admin', 'Pipeline', 'condition report + the roster with per-row triggers'],
  ['/admin/runs', 'Runs', 'the circulation ledger'],
  ['/m/89510-89515', 'Provenance', 'a citation resolving in its conversation'],
  ['/states', 'States', 'overdue, caution, in-progress, returned, empty'],
];

function directory() {
  const body = h('div', {},
    h('div', { class: 'mast' },
      h('div', { class: 'form-no' }, 'Bindery preview · fixtures, not real data'),
      h('h1', {}, 'personal-crm, ', h('em', {}, 'as a bindery'))),
    h('div', { class: 'head' }, h('h2', {}, 'Screens'), h('span', { class: 'cap' }, 'open any one')),
    h('div', { class: 'gal' }, DIRECTORY.map(([href, name, desc]) =>
      h('a', { href }, h('h3', {}, name), h('p', {}, desc), h('div', { class: 'rt' }, href)))));
  return { title: 'Bindery preview', body };
}

function placeholder(slug) {
  const body = h('div', {},
    V.Tabs('/'),
    h('div', { class: 'back' }, h('a', { href: '/' }, '← all people')),
    h('div', { class: 'quiet' },
      h('div', { class: 'big' }, slug),
      h('p', {}, 'Only Pine has fixture data in the preview. Backfill this person, then wire the profile page to see them here.')));
  return { title: `${slug} — preview`, body };
}

const ROUTES = {
  '/': () => V.people(F.CONTACTS),
  '/preview': directory,
  '/tasks': () => V.tasks(F.TODO),
  '/admin': () => V.admin({ health: F.HEALTH, roster: F.CONTACTS }),
  '/admin/runs': () => V.runs(F.RUNS),
  '/states': statesSheet,
  '/c/pine-nguyen': () => V.profile(F.PROFILE),
};

function resolve(pathname) {
  if (ROUTES[pathname]) return ROUTES[pathname]();
  if (pathname.startsWith('/m/')) return V.message(F.MESSAGE_CONTEXT);
  if (pathname.startsWith('/c/')) return placeholder(pathname.slice(3));
  return null;
}

http.createServer((req, res) => {
  const pathname = decodeURIComponent(req.url.split('?')[0]);
  const result = resolve(pathname);
  if (!result) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page({ title: 'Not found', route: pathname, body: h('p', {}, 'No such screen. Try ', h('a', { href: '/preview' }, '/preview'), '.') }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page({ title: result.title, route: pathname, body: result.body }));
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Bindery preview → http://localhost:${PORT}/  (directory at /preview · fixtures, not real data)`);
});
