'use strict';
// Parse and persist the structured side-channel emitted by the merge model.
// The profile edit remains the human-readable result; these rows are the durable,
// queryable record with source-message provenance.
const {
  FACT_KINDS, DERIVED_FIELDS, recordFact, currentFacts, normalizeBirthday, normalizeEmail,
} = require('./schema');
const { dateKey, dateKeyToMs } = require('./weeks');

const FIELD_RE = /^[a-z][a-z0-9_]{0,63}$/;
// NOTE: person-to-person edges are NOT emitted by the model any more. The graph is
// built by a deterministic name scan (crm-mention-scan.js) that writes the same
// `mentions` table directly. This file only handles the [[FACTS]] block; a stray
// [[MENTIONS]] block in a reply (until the prompt drops it) is simply ignored.
const IDENTITY_FIELDS = new Map([
  ['relationship', 'Relationship'], ['birthday', 'Birthday'], ['phone', 'Phone'],
  ['email', 'Email'], ['signal_id', 'Signal ID'],
]);

function blockMatches(text, name) {
  const s = String(text || '');
  const re = new RegExp(`\\[\\[${name}\\]\\]([\\s\\S]*?)\\[\\[\\/${name}\\]\\]`, 'g');
  const matches = [...s.matchAll(re)];
  const opens = [...s.matchAll(new RegExp(`\\[\\[${name}\\]\\]`, 'g'))].length;
  const closes = [...s.matchAll(new RegExp(`\\[\\[\\/${name}\\]\\]`, 'g'))].length;
  if (opens !== matches.length || closes !== matches.length) {
    throw new Error(`${name} block is unclosed or malformed`);
  }
  return matches;
}

function blocks(text, name, matches = blockMatches(text, name)) {
  const out = [];
  for (const m of matches) {
    const body = m[1].trim();
    if (!body) continue;
    let value;
    try { value = JSON.parse(body); } catch (e) { throw new Error(`${name} block is not valid JSON: ${e.message}`); }
    if (!Array.isArray(value)) throw new Error(`${name} block must be a JSON array`);
    out.push(...value);
  }
  return out;
}

function parseStructuredReply(text, opts = {}) {
  const s = String(text || '');
  const factMatches = blockMatches(s, 'FACTS');
  const factsPresent = factMatches.length > 0;
  if (opts.required && !factsPresent) {
    throw new Error('merge reply missing required [[FACTS]] block');
  }
  return {
    facts: blocks(s, 'FACTS', factMatches),
    factsPresent,
  };
}

function cleanText(v, label, max = 1000) {
  const s = String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
  if (!s) throw new Error(`${label} is required`);
  if (s.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return s;
}

function optionalDate(v, label) {
  if (v == null || v === '') return null;
  const s = String(v);
  const ms = dateKeyToMs(s);
  if (ms == null) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
  return ms;
}

function messageRows(db, ids) {
  const q = db.prepare('SELECT id, sent_at FROM messages WHERE id = ?');
  const out = new Map();
  for (const id of new Set(ids)) {
    const r = q.get(id);
    if (!r) throw new Error(`structured output cites missing archive message m${id}`);
    out.set(id, r);
  }
  return out;
}

function profileCitationIds(md) {
  const ids = new Set();
  for (const cite of String(md || '').matchAll(/⟨([^⟩]*)⟩/g)) {
    for (const m of cite[1].matchAll(/m(\d+)/g)) ids.add(Number(m[1]));
  }
  return ids;
}

function validateFact(raw, slug, messages, runId, validMessageIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('each fact must be an object');
  const field = String(raw.field || '').trim().toLowerCase();
  if (!FIELD_RE.test(field)) throw new Error(`bad fact field: ${raw.field}`);
  const kind = String(raw.kind || '').trim().toLowerCase();
  if (!FACT_KINDS.has(kind)) throw new Error(`bad fact kind for ${field}: ${raw.kind}`);
  if (DERIVED_FIELDS.has(field) && kind !== 'snapshot') throw new Error(`${field} is derived; store its invariant or a snapshot`);
  const srcMsg = Number(raw.source_message_id);
  if (!Number.isSafeInteger(srcMsg) || !messages.has(srcMsg)) throw new Error(`bad source_message_id for ${field}`);
  if (validMessageIds && !validMessageIds.has(srcMsg)) throw new Error(`fact source m${srcMsg} is outside this chunk`);
  const periodStart = optionalDate(raw.period_start, `${field}.period_start`);
  const periodEnd = optionalDate(raw.period_end, `${field}.period_end`);
  let asOf = optionalDate(raw.as_of, `${field}.as_of`);
  if (kind === 'periodic' && (periodStart == null || periodEnd == null)) throw new Error(`${field}: periodic facts require period_start and period_end`);
  if (kind === 'snapshot' && asOf == null) asOf = dateKeyToMs(dateKey(messages.get(srcMsg).sent_at));
  if (kind === 'standing' && (periodStart != null || periodEnd != null || asOf != null)) throw new Error(`${field}: standing facts cannot carry period/as_of`);
  const valueNum = raw.value_num == null ? null : Number(raw.value_num);
  if (valueNum != null && !Number.isFinite(valueNum)) throw new Error(`${field}.value_num must be numeric`);
  // Identity fields are normalised here so the store never holds a rotting string
  // like "March 14" or a broken address. Unlike the structural guards above (bad
  // kind / bad source id), a malformed OR empty identity VALUE is dropped, NOT
  // thrown: one bad value must never fail a whole merge chunk and burn model
  // retries. The manual web edit validates the same shapes but fails loud, since a
  // human is right there to correct it. (A model value can never override a human
  // one — recordFact enforces that separately.)
  let value;
  if (IDENTITY_FIELDS.has(field)) {
    // Identity fields are STANDING by definition. A model snapshot/periodic of one
    // would carry a DIFFERENT identity_key and so slip past the human-override guard
    // in recordFact, then win the rendered header — so drop any non-standing
    // identity fact outright. (Manual human edits only ever write standing.)
    if (kind !== 'standing') return null;
    let v = raw.value == null ? '' : String(raw.value).replace(/[\r\n]+/g, ' ').trim();
    if (field === 'birthday') v = normalizeBirthday(v) || '';
    else if (field === 'email') v = normalizeEmail(v) || '';
    if (!v) return null; // empty or malformed — drop, never throw
    value = v.length > 200 ? v.slice(0, 200) : v; // cap freeform identity (relationship)
  } else {
    value = cleanText(raw.value, `${field}.value`);
  }
  return {
    slug, field, kind, value, value_num: valueNum,
    unit: raw.unit == null ? null : cleanText(raw.unit, `${field}.unit`, 40),
    period_start: periodStart, period_end: periodEnd,
    period_label: raw.period_label == null ? null : cleanText(raw.period_label, `${field}.period_label`, 80),
    as_of: asOf, as_of_stated: raw.as_of != null,
    src_msg: srcMsg, observed_at: messages.get(srcMsg).sent_at, run_id: runId || null,
  };
}

function applyStructuredReply(db, slug, reply, opts = {}) {
  const parsed = parseStructuredReply(reply, { required: opts.required !== false });
  const ids = parsed.facts.map((x) => Number(x && x.source_message_id)).filter(Number.isSafeInteger);
  const messages = messageRows(db, ids);
  const validMessageIds = opts.validMessageIds == null ? null : new Set([...opts.validMessageIds].map(Number));
  const validFactMessageIds = opts.validFactMessageIds == null
    ? validMessageIds
    : new Set([...opts.validFactMessageIds].map(Number));
  // validateFact returns null for a malformed identity value (birthday/email) — a
  // drop, not a failure — so filter those out before writing. Structural problems
  // still throw from inside validateFact and abort the whole apply.
  const facts = parsed.facts
    .map((f) => validateFact(f, slug, messages, opts.runId, validFactMessageIds))
    .filter(Boolean);
  let factCount = 0;
  const ownTransaction = opts.transaction !== false;
  if (ownTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    for (const f of facts) { const r = recordFact(db, f); if (!r.duplicate) factCount += 1; }
    if (ownTransaction) db.exec('COMMIT');
  } catch (e) {
    if (ownTransaction) try { db.exec('ROLLBACK'); } catch { /* original error wins */ }
    throw e;
  }
  // mentionsStored kept at 0 for caller compatibility (the graph now comes from the
  // deterministic scan, not the merge).
  return { factsStored: factCount, mentionsStored: 0, facts: currentFacts(db, slug) };
}

function factLabel(field) {
  return field.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Newer-wins comparator for two facts of the same field: latest observation, id as tiebreak.
function factIsNewer(a, b) {
  const ao = Number(a.observed_at || 0);
  const bo = Number(b.observed_at || 0);
  if (ao !== bo) return ao > bo;
  return Number(a.id || 0) > Number(b.id || 0);
}

// The current facts collapsed to distinct display rows, identity fields removed (those
// live in the metadata header, not the Facts list). The dedup rule mirrors what "the
// current facts" means: a field's standing/snapshot value is a single current reading,
// so we keep exactly one per field (newest wins) — this is what kills the visible
// duplicates where the model emitted the same field as both a `snapshot` and a
// `standing` row. Periodic facts are genuinely plural (one per closed period), so those
// are kept one-per-(field, period). Sorted by label for a stable, scannable list.
function distinctBodyFacts(facts) {
  const byKey = new Map();
  for (const f of facts || []) {
    if (IDENTITY_FIELDS.has(f.field)) continue;
    const key = f.kind === 'periodic'
      ? `${f.field} p ${f.period_label || `${f.period_start}-${f.period_end}`}`
      : f.field;
    const prior = byKey.get(key);
    if (!prior || factIsNewer(f, prior)) byKey.set(key, f);
  }
  return [...byKey.values()].sort((a, b) => factLabel(a.field).localeCompare(factLabel(b.field)));
}

// Remove a `## <heading>` section (heading line through the line before the next `## `),
// so a machine-owned section can be regenerated idempotently. No-op if absent.
function stripSection(md, heading) {
  const start = md.search(new RegExp(`^## ${heading}\\s*$`, 'm'));
  if (start < 0) return md;
  const rest = md.slice(start);
  const next = rest.slice(rest.indexOf('\n') + 1).search(/^## /m);
  const end = next < 0 ? md.length : start + rest.indexOf('\n') + 1 + next;
  return md.slice(0, start) + md.slice(end);
}

// Remove the machine-owned `## Facts` section from a profile. Callers strip it from the
// on-disk copy the MERGE MODEL reads, because the model neither authors nor should edit
// that section — renderStructuredProfile regenerates it from crm.db after every merge.
// No-op if absent (e.g. a freshly wiped stub, or a first-ever merge). Returns the text.
function stripFactsSection(md) {
  return stripSection(String(md), 'Facts');
}

// The machine-owned `## Facts` section: one deduped bullet per current fact.
function factsSectionText(facts) {
  const lines = distinctBodyFacts(facts).map((f) => {
    const period = f.kind === 'periodic' && f.period_label ? ` (${f.period_label})` : '';
    return `- **${factLabel(f.field)}${period}:** ${f.value}${f.src_msg ? ` ⟨m${f.src_msg}⟩` : ''}`;
  });
  return `## Facts\n\n${lines.length ? lines.join('\n') : '_No structured facts yet._'}\n\n`;
}

// Reconcile the profile with the structured store. Two jobs, and only these two:
//   1. Sync the identity header fields (relationship/birthday/phone/email/signal_id).
//   2. Regenerate the machine-owned `## Facts` section, deduped, placed between
//      `## What I know` and `## Talking points`.
// It DELIBERATELY no longer touches `## What I know` — that section is the merge model's
// prose profile and is the human-readable record; overwriting it with a flat fact list
// was what flattened profiles into bullet dumps. `## Timeline` is never touched (callers
// additionally assert its bytes are unchanged and fail the write if not).
function renderStructuredProfile(md, facts) {
  let out = String(md);
  const identityFacts = new Map();
  for (const f of facts) {
    if (!IDENTITY_FIELDS.has(f.field)) continue;
    const prior = identityFacts.get(f.field);
    if (!prior || factIsNewer(f, prior)) identityFacts.set(f.field, f);
  }
  for (const f of identityFacts.values()) {
    const label = IDENTITY_FIELDS.get(f.field);
    const re = new RegExp(`^(- \\*\\*${label}:\\*\\*\\s*).*$`, 'm');
    if (re.test(out)) out = out.replace(re, (_match, prefix) => `${prefix}${f.value}`);
    else out = out.replace(/^(# .*\r?\n)/, (_match, title) => `${title}- **${label}:** ${f.value}\n`);
  }
  // Regenerate `## Facts` fresh: strip any prior copy, then insert before Talking points
  // (or Timeline if there is none). Inserting here keeps it after What I know and always
  // before Timeline, so Timeline's bytes are preserved.
  out = stripSection(out, 'Facts');
  const section = factsSectionText(facts);
  const tp = out.search(/^## Talking points\s*$/m);
  const at = tp >= 0 ? tp : out.search(/^## Timeline\s*$/m);
  out = at >= 0 ? `${out.slice(0, at)}${section}${out.slice(at)}` : `${out.replace(/\s*$/, '\n\n')}${section}`;
  return out;
}

module.exports = {
  parseStructuredReply, applyStructuredReply, renderStructuredProfile, profileCitationIds,
  factLabel, distinctBodyFacts, stripFactsSection, IDENTITY_FIELDS,
};
