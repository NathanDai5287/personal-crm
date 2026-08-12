'use strict';
// Renders a contact's profile Markdown to Bindery-styled HTML. Ported from the
// original crm-web renderer, with two changes: ⟨m…⟩ citations become stamped
// call-number slips, and Timeline chat lines become Bindery quote rows. Profiles
// are the pipeline's source of truth (plain Markdown on disk), so this renders
// them directly rather than parsing into a fixed structure.

const { dateKey } = require('../weeks');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Citation grammar (docs/PROVENANCE-SPEC.md §1) plus the ` ts` time-sensitive
// flag, which rides last inside the newest citation: ⟨m9651 ts⟩,
// ⟨m71759-m71770 @m71770 ts⟩. The flag itself never displays.
const CITE = /⟨\s*m(\d+)(?:-m(\d+))?(?:\s+@m(\d+))?(\s+ts)?\s*⟩/g;

const DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The slip's visible face: when the cited message was sent, relative while
// young — "how long ago" is what a citation owes a glance — and month + year
// once it is over a year old, the granularity that matters then (Nathan,
// 2026-08-11). Computed at render time from sent_at, never stored, so display
// rules can change without touching data. Pacific calendar days, not raw 24h
// buckets: a message sent last night is "yesterday" all of today.
function sentLabel(ms, now) {
  const days = Math.round((Date.parse(dateKey(now)) - Date.parse(dateKey(ms))) / DAY);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days`;
  if (days < 14) return 'last week';
  if (days < 28) return `${Math.floor(days / 7)} weeks`;
  const months = Math.floor(days / 30.44);
  if (months <= 1) return 'last month';
  if (days < 365) return `${months} months`;
  const key = dateKey(ms);
  return `${MONTHS[Number(key.slice(5, 7)) - 1].toLowerCase()} ${key.slice(0, 4)}`;
}

// How many ts-flagged claims in this Markdown have crossed the 6-month line —
// the profile header's "n facts may be stale" count.
function staleCount(md, opts) {
  if (!opts || !opts.dateFor) return 0;
  let n = 0;
  for (const m of String(md).matchAll(CITE)) {
    if (!m[4]) continue;
    const ms = opts.dateFor(Number(m[2] || m[1]));
    if (ms && (opts.now || Date.now()) - ms >= 183 * DAY) n += 1;
  }
  return n;
}

function slip(start, end, primary, ts, opts) {
  const single = !end || end === start;
  let label;
  if (single) {
    label = `m${start}`;
  } else if (start.length !== end.length) {
    label = `m${start}–m${end}`;
  } else {
    let shared = 0;
    while (shared < start.length && start[shared] === end[shared]) shared += 1;
    label = `m${start}–${end.slice(Math.min(shared, end.length - 2))}`;
  }
  if (primary) label += ` @${primary}`;
  // The primary rides as a #m<id> fragment: the range page marks that bubble as
  // the key line and scrolls to it (SCROLL_TO_HIT in crm-web).
  const href = single ? `/m/${start}` : `/m/${start}-${end}${primary ? `#m${primary}` : ''}`;
  // The face is the newest cited message's send date — ids and ranges are
  // clutter in prose (Nathan, 2026-08-10), so the call number and the exact
  // date live in the hover title. Ink answers time-sensitivity: stamp blue
  // when the claim isn't ⟨… ts⟩; on ts claims a ladder — moss while fresh,
  // amber past 6 months, oxblood past a year. Provenance opens in a new tab
  // so reading is never interrupted. No archive date resolves to a dagger.
  const ms = opts && opts.dateFor ? opts.dateFor(Number(end || start)) : null;
  if (!ms) return `<a class="slip" href="${href}" target="_blank" rel="noopener" title="${esc(label)}">&dagger;</a>`;
  const now = (opts && opts.now) || Date.now();
  const age = now - ms;
  const tone = !ts ? '' : age >= 365 * DAY ? ' old' : age >= 183 * DAY ? ' aging' : ' fresh';
  return `<a class="slip${tone}" href="${href}" target="_blank" rel="noopener" title="${esc(label)} &middot; sent ${dateKey(ms)}">${sentLabel(ms, now)}</a>`;
}

function inline(s, opts) {
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, c) => `<strong>${c}</strong>`);
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  out = out.replace(/(^|[\s(>])_([^_]+)_(?=$|[\s.,;:!?)<])/g, (_, pre, c) => `${pre}<em>${c}</em>`);
  out = out.replace(CITE, (_, start, end, primary, ts) => slip(start, end, primary, ts, opts));
  return out;
}

const CHAT = /^\[([^\]]+)\]\s+(?:⟨m(\d+)⟩\s+)?(?:\(([^)]+)\)\s+)?([^:]+):\s?(.*)$/;

function chatRow(match, opts) {
  const [, ts, mid, group, speakerRaw, text] = match;
  const speaker = speakerRaw.trim();
  const mine = /^nathan$/i.test(speaker);
  const who = `${esc(speaker)}${group ? ` · ${esc(group)}` : ''} · ${esc(ts)}`;
  // Provenance opens in a new tab, like the slips — reading is never interrupted.
  const whoHtml = mid ? `<a href="/m/${mid}" class="who" target="_blank" rel="noopener">${who}</a>` : `<span class="who">${who}</span>`;
  return `<div class="q ${mine ? 'me' : 'them'}">${whoHtml}${inline(text, opts)}</div>`;
}

// The Weekly log keeps every week forever (Nathan's call: nothing rolls away).
// The most recent WEEKLY_SHOWN render; if anything would be hidden, the rest
// always folds behind a "show all" <details>. Only that tier collapses.
const WEEKLY_SHOWN = 6;

function renderProfile(md, opts) {
  const lines = md.split(/\r?\n/);
  const html = [];
  let i = 0;
  let listItems = null; // buffered <li> html while a list is open
  let curH3 = '';       // nearest ### heading — tells the list flush which tier it is
  let chatOpen = false;
  const closeList = () => {
    if (!listItems) return;
    if (/^weekly log/i.test(curH3) && listItems.length > WEEKLY_SHOWN) {
      html.push('<ul>', ...listItems.slice(0, WEEKLY_SHOWN), '</ul>');
      html.push(`<details class="tl-more"><summary>show all ${listItems.length} weeks</summary><ul>`);
      html.push(...listItems.slice(WEEKLY_SHOWN), '</ul></details>');
    } else {
      html.push('<ul>', ...listItems, '</ul>');
    }
    listItems = null;
  };
  const closeChat = () => { if (chatOpen) { html.push('</div>'); chatOpen = false; } };

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === '') { closeList(); closeChat(); i += 1; continue; }

    const chat = trimmed.match(CHAT);
    if (chat) {
      closeList();
      if (!chatOpen) { html.push('<div class="charge">'); chatOpen = true; }
      html.push(chatRow(chat, opts));
      i += 1;
      continue;
    }
    closeChat();

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length, 3);
      curH3 = heading[1].length === 3 ? heading[2] : '';
      html.push(`<h${level}>${inline(heading[2], opts)}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { closeList(); html.push('<hr>'); i += 1; continue; }

    const meta = trimmed.match(/^-\s+\*\*([^:*]+):\*\*\s*(.+)$/);
    if (meta && !listItems) {
      html.push(`<div class="fields"><span><b>${esc(meta[1].trim())}:</b> ${inline(meta[2], opts)}</span></div>`);
      i += 1;
      continue;
    }

    const item = trimmed.match(/^[-*]\s+(.*)$/);
    if (item) {
      if (!listItems) listItems = [];
      listItems.push(`<li>${inline(item[1], opts)}</li>`);
      i += 1;
      continue;
    }

    closeList();
    const para = [trimmed];
    i += 1;
    while (i < lines.length) {
      const t = lines[i].trim();
      if (t === '' || /^#{1,6}\s/.test(t) || /^[-*]\s/.test(t) || CHAT.test(t) || /^(-{3,}|\*{3,}|_{3,})$/.test(t)) break;
      para.push(t);
      i += 1;
    }
    html.push(`<p>${inline(para.join(' '), opts)}</p>`);
  }
  closeList();
  closeChat();
  return html.join('\n');
}

module.exports = { renderProfile, inline, staleCount, sentLabel };
