'use strict';
// attachments.js — render Signal attachments as short text so photos, videos and
// voice notes stop being invisible to the pipeline.
//
// THE PROBLEM THIS SOLVES: every message query filters on a non-empty body, so a
// photo sent with no caption (2,138 of them) was dropped outright — it never
// reached the archive, a merge, or a Timeline. A whole afternoon of trading
// pictures read as silence. A captioned photo fared only slightly better: the
// caption came through with no indication that an image came with it.
//
// WHAT WE DO: synthesize a body. "[3 photos]" for a bare attachment message,
// "[photo] look at this view" when there was also a caption. That restores the
// EXISTENCE of the exchange and gives the merge and the Timeline step something real to
// cite, which is most of the value for a tiny fraction of the effort of actually
// looking at the pixels.
//
// WHAT THIS MODULE DOES NOT DO: decode media. It synthesizes the Layer-1 placeholder
// ("[photo]", a voice note labelled and timed) from the message JSON alone. Actual
// OCR/transcription is a SEPARATE, later step, now implemented: crm-media-worker.js
// decrypts the Signal blob and runs tesseract/whisper into the media_text table, and
// lib/message-context.js folds that text in as Layer 2 at read time. So a voice note is
// labelled+timed HERE and transcribed THERE — the placeholder is still honest about
// being only a placeholder.
//
// ATTACHMENT TYPES: only rows with attachmentType='attachment' (and 'sticker')
// are real user-sent media. 'quote' rows are thumbnails of a quoted message,
// 'preview' rows are link-preview images, and 'long-message' rows are the
// overflow file for very long text — none of those are things the sender
// "attached", so counting them would inflate every description.

const REAL_TYPES = new Set(['attachment', 'sticker']);

// Signal attachment flag bits (AttachmentPointer.Flags in the protocol).
const FLAG_VOICE_MESSAGE = 1;
const FLAG_GIF = 8; // "should loop" — set on GIFs and looping video

// Bulk-load attachments for a set of Signal message ids. Chunked because SQLite
// caps host parameters per statement and a deep sweep passes tens of thousands
// of ids at once. Returns Map<messageId, attachment[]>.
function loadAttachments(sdb, messageIds) {
  const out = new Map();
  const ids = [...new Set(messageIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const rows = sdb.prepare(`
      SELECT messageId, attachmentType, contentType, fileName, duration, flags, isViewOnce,
             plaintextHash, path
      FROM message_attachments
      WHERE messageId IN (${slice.map(() => '?').join(',')})
      ORDER BY orderInMessage ASC`).all(slice);
    for (const r of rows) {
      if (!REAL_TYPES.has(r.attachmentType)) continue;
      if (!out.has(r.messageId)) out.set(r.messageId, []);
      out.get(r.messageId).push(r);
    }
  }
  return out;
}

function fmtDuration(sec) {
  if (sec == null || !isFinite(sec) || sec <= 0) return null;
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Strip Signal's auto-generated filenames ("signal-2025-09-09-00-21-51-662.m4a",
// "image-2025-07-29-113245.jpg") — they carry no information a human would want
// and only add noise to a ledger line. A name the sender actually chose is kept.
function meaningfulName(fileName) {
  if (!fileName) return null;
  if (/^(signal|image|video|audio)-\d{4}-\d{2}-\d{2}/i.test(fileName)) return null;
  return fileName;
}

// One attachment -> { kind, label }. `kind` groups identical items for counting.
function classify(a) {
  const ct = (a.contentType || '').toLowerCase();
  const flags = a.flags || 0;
  const name = meaningfulName(a.fileName);

  if (a.attachmentType === 'sticker') return { kind: 'sticker', label: 'sticker' };
  if (a.isViewOnce) return { kind: 'view-once', label: 'view-once media' };

  if (ct.startsWith('audio/')) {
    if (flags & FLAG_VOICE_MESSAGE) {
      const d = fmtDuration(a.duration);
      return { kind: 'voice', label: d ? `voice note, ${d}` : 'voice note' };
    }
    return { kind: 'audio', label: name ? `audio: ${name}` : 'audio file' };
  }
  if (ct === 'image/gif' || (ct.startsWith('image/') && (flags & FLAG_GIF))) {
    return { kind: 'gif', label: 'GIF' };
  }
  if (ct.startsWith('image/')) return { kind: 'photo', label: 'photo' };
  if (ct.startsWith('video/')) {
    const d = fmtDuration(a.duration);
    return { kind: 'video', label: d ? `video, ${d}` : 'video' };
  }
  if (ct === 'application/pdf') return { kind: 'pdf', label: name ? `PDF: ${name}` : 'PDF' };
  return { kind: 'file', label: name ? `file: ${name}` : 'file' };
}

const PLURALS = {
  photo: 'photos', video: 'videos', gif: 'GIFs', voice: 'voice notes',
  audio: 'audio files', pdf: 'PDFs', file: 'files', sticker: 'stickers',
  'view-once': 'view-once media',
};

// attachment[] -> "[3 photos]" / "[voice note, 0:47]" / "[2 photos, video]".
// Returns '' when there is nothing real to describe.
//
// Grouping is by KIND, not by label. Grouping on the label instead would split
// three videos into "2 videos, video, 0:16" whenever only some of them carry a
// duration. So: a lone item keeps its detailed label (duration and filename
// included); two or more of a kind collapse to a plain count, since a list of
// durations is noise once there is more than one.
function describeAttachments(list) {
  if (!list || list.length === 0) return '';
  const groups = [];
  for (const a of list) {
    const c = classify(a);
    const g = groups.find((x) => x.kind === c.kind);
    if (g) g.items.push(c);
    else groups.push({ kind: c.kind, items: [c] });
  }
  const parts = groups.map((g) => (g.items.length === 1
    ? g.items[0].label
    : `${g.items.length} ${PLURALS[g.kind] || `${g.kind}s`}`));
  return `[${parts.join(', ')}]`;
}

// ---- link previews -----------------------------------------------------------
// A bare URL is almost worthless to the merge: "https://www.rossrankings.com/"
// says nothing a model can turn into a fact. Signal already fetched the page
// title when it rendered the preview card, so the information is sitting in the
// message JSON for free -- 201 messages carry one. Surfacing it turns that line
// into "[link: Ross Prestige Rankings - rossrankings.com]".
//
// Titles live in the message JSON's `preview` array, NOT in message_attachments
// (whose 'preview' rows are only the card's thumbnail image).

// Some titles are the page's whole first paragraph. Keep them to one line.
const MAX_TITLE = 90;

function loadPreviews(sdb, messageIds) {
  const out = new Map();
  const ids = [...new Set(messageIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const rows = sdb.prepare(`
      SELECT id,
             json_extract(json, '$.preview[0].title')  AS title,
             json_extract(json, '$.preview[0].domain') AS domain
      FROM messages
      WHERE id IN (${slice.map(() => '?').join(',')})
        AND json_extract(json, '$.preview[0].title') IS NOT NULL`).all(slice);
    for (const r of rows) out.set(r.id, { title: r.title, domain: r.domain });
  }
  return out;
}

// Square brackets are stripped from the interior: these enrichments are `[…]`-wrapped
// prefixes, and a stray `]` in a title/quote would prematurely close ownWords'
// `[^\]]*` strip in lib/task-trigger.js, leaking a quoted/preview "make sure" past the
// typed-only guard. The brackets carry no meaning inside a title, so dropping them is free.
const stripBrackets = (s) => String(s).replace(/[[\]]/g, '');

function describePreview(p) {
  if (!p || !p.title) return '';
  let t = stripBrackets(p.title).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (t.length > MAX_TITLE) t = `${t.slice(0, MAX_TITLE - 1)}…`;
  const domain = p.domain ? stripBrackets(p.domain).trim() : '';
  return domain ? `[link: ${t} — ${domain}]` : `[link: ${t}]`;
}

// ---- replies -----------------------------------------------------------------
// 50.8% of the 5,899 replies in this corpus are under 15 characters ("fax",
// "fr", "same", "yes"). Chronological order does NOT recover what those answer:
// in a fast group thread the referent can be twenty lines back. Without the
// quote, half of all replies are content-free -- and worse, a bare "yes" next to
// an unrelated line invites the merge to attach it to the WRONG claim.
//
// Signal denormalizes the quoted text into the replying message's own JSON, so
// this needs no join and still works when the original is outside the window or
// was deleted.

const MAX_QUOTE = 60;

function loadQuotes(sdb, messageIds) {
  const out = new Map();
  const ids = [...new Set(messageIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const rows = sdb.prepare(`
      SELECT id,
             json_extract(json, '$.quote.text')       AS qtext,
             json_extract(json, '$.quote.authorAci')  AS qauthor
      FROM messages
      WHERE id IN (${slice.map(() => '?').join(',')})
        AND json_extract(json, '$.quote') IS NOT NULL`).all(slice);
    for (const r of rows) out.set(r.id, { text: r.qtext, author: r.qauthor });
  }
  return out;
}

// `nameFor` maps a serviceId to a display label; pass the same resolver the
// sweep uses for senders so the quote attributes to a real name.
function describeQuote(q, nameFor) {
  if (!q) return '';
  let t = stripBrackets(q.text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '[reply]'; // quoting a photo/voice note: no text to show
  if (t.length > MAX_QUOTE) t = `${t.slice(0, MAX_QUOTE - 1)}…`;
  const who = stripBrackets((nameFor && q.author && nameFor(q.author)) || '').trim() || null;
  return who ? `[re ${who}: "${t}"]` : `[re: "${t}"]`;
}

// Combine the real message text with any enrichments.
//   caption + media -> "[photo] look at this view"
//   media only      -> "[3 photos]"
//   reply           -> '[re Katia: "that kid is fake"] fax'
//   text only       -> unchanged
// Descriptions LEAD so a reader (and the model) sees immediately what kind of
// line this is rather than discovering it at the end. Order is reply, then
// media, then link: context for the utterance first, then what it carried.
function composeBody(body, ...descriptions) {
  const text = (body || '').replace(/\s+/g, ' ').trim();
  const pre = descriptions.filter(Boolean).join(' ');
  if (!pre) return text;
  return text ? `${pre} ${text}` : pre;
}

module.exports = {
  loadAttachments, describeAttachments, composeBody, classify,
  loadPreviews, describePreview, loadQuotes, describeQuote,
};
