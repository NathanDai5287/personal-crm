'use strict';
// Renders a contact's profile Markdown to Bindery-styled HTML. Ported from the
// original crm-web renderer, with two changes: ⟨m…⟩ citations become stamped
// call-number slips, and Timeline chat lines become Bindery quote rows. Profiles
// are the pipeline's source of truth (plain Markdown on disk), so this renders
// them directly rather than parsing into a fixed structure.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CITE = /⟨\s*m(\d+)(?:-m(\d+))?(?:\s+@m(\d+))?\s*⟩/g;

function slip(start, end, primary) {
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
  const href = single ? `/m/${start}` : `/m/${start}-${end}`;
  return `<a class="slip" href="${href}">${esc(label)}</a>`;
}

function inline(s) {
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, c) => `<strong>${c}</strong>`);
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  out = out.replace(/(^|[\s(>])_([^_]+)_(?=$|[\s.,;:!?)<])/g, (_, pre, c) => `${pre}<em>${c}</em>`);
  out = out.replace(CITE, (_, start, end, primary) => slip(start, end, primary));
  return out;
}

const CHAT = /^\[([^\]]+)\]\s+(?:⟨m(\d+)⟩\s+)?(?:\(([^)]+)\)\s+)?([^:]+):\s?(.*)$/;

function chatRow(match) {
  const [, ts, mid, group, speakerRaw, text] = match;
  const speaker = speakerRaw.trim();
  const mine = /^nathan$/i.test(speaker);
  const who = `${esc(speaker)}${group ? ` · ${esc(group)}` : ''} · ${esc(ts)}`;
  const whoHtml = mid ? `<a href="/m/${mid}" class="who">${who}</a>` : `<span class="who">${who}</span>`;
  return `<div class="q ${mine ? 'me' : 'them'}">${whoHtml}${inline(text)}</div>`;
}

function renderProfile(md) {
  const lines = md.split(/\r?\n/);
  const html = [];
  let i = 0;
  let listOpen = false;
  let chatOpen = false;
  const closeList = () => { if (listOpen) { html.push('</ul>'); listOpen = false; } };
  const closeChat = () => { if (chatOpen) { html.push('</div>'); chatOpen = false; } };

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === '') { closeList(); closeChat(); i += 1; continue; }

    const chat = trimmed.match(CHAT);
    if (chat) {
      closeList();
      if (!chatOpen) { html.push('<div class="charge">'); chatOpen = true; }
      html.push(chatRow(chat));
      i += 1;
      continue;
    }
    closeChat();

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length, 3);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { closeList(); html.push('<hr>'); i += 1; continue; }

    const meta = trimmed.match(/^-\s+\*\*([^:*]+):\*\*\s*(.+)$/);
    if (meta && !listOpen) {
      // An indented `- **Label:** …` is a sub-entry of the labelled bullet above
      // it (the two-tier What-I-know shape): same rendering, stepped in.
      const sub = /^\s/.test(lines[i]) ? ' sub' : '';
      html.push(`<div class="fields${sub}"><span><b>${esc(meta[1].trim())}:</b> ${inline(meta[2])}</span></div>`);
      i += 1;
      continue;
    }

    const item = trimmed.match(/^[-*]\s+(.*)$/);
    if (item) {
      if (!listOpen) { html.push('<ul>'); listOpen = true; }
      html.push(`<li>${inline(item[1])}</li>`);
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
    html.push(`<p>${inline(para.join(' '))}</p>`);
  }
  closeList();
  closeChat();
  return html.join('\n');
}

module.exports = { renderProfile, inline };
