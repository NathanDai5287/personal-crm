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
// EXISTENCE of the exchange and gives the merge and compaction something real to
// cite, which is most of the value for a tiny fraction of the effort of actually
// looking at the pixels.
//
// WHAT WE DELIBERATELY DO NOT DO: decode any media. Voice notes are labelled and
// timed, not transcribed — real transcription means decrypting Signal's local
// attachment blobs and running Whisper, which is a separate project. The
// placeholder is honest about being a placeholder.
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
      SELECT messageId, attachmentType, contentType, fileName, duration, flags, isViewOnce
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

// Combine the real message text with an attachment description.
//   caption + media -> "[photo] look at this view"
//   media only      -> "[3 photos]"
//   text only       -> unchanged
// The description leads so a reader (and the model) sees immediately that the
// line is about media rather than discovering it at the end.
function composeBody(body, description) {
  const text = (body || '').replace(/\s+/g, ' ').trim();
  if (!description) return text;
  return text ? `${description} ${text}` : description;
}

module.exports = { loadAttachments, describeAttachments, composeBody, classify };
