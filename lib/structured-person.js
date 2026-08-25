'use strict';
// Parse and persist the structured side-channel emitted by the merge model.
// The profile edit remains the human-readable result; these rows are the durable,
// queryable record with source-message provenance.
const { FACT_KINDS, DERIVED_FIELDS, recordFact, recordMention, currentFacts } = require('./schema');
const { dateKeyToMs } = require('./weeks');

const FIELD_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MENTION_KINDS = new Set(['mentioned', 'coattended', 'related']);
const IDENTITY_FIELDS = new Map([
  ['relationship', 'Relationship'], ['birthday', 'Birthday'], ['phone', 'Phone'],
  ['signal_id', 'Signal ID'],
]);

function blocks(text, name) {
  const out = [];
  const re = new RegExp(`\\[\\[${name}\\]\\]([\\s\\S]*?)\\[\\[\\/${name}\\]\\]`, 'g');
  for (const m of String(text || '').matchAll(re)) {
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
  const factsPresent = /\[\[FACTS\]\]/.test(s);
  const mentionsPresent = /\[\[MENTIONS\]\]/.test(s);
  if (opts.required && (!factsPresent || !mentionsPresent)) {
    throw new Error(`merge reply missing required ${!factsPresent ? '[[FACTS]]' : '[[MENTIONS]]'} block`);
  }
  return { facts: blocks(s, 'FACTS'), mentions: blocks(s, 'MENTIONS'), factsPresent, mentionsPresent };
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

function validateFact(raw, slug, messages, runId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('each fact must be an object');
  const field = String(raw.field || '').trim().toLowerCase();
  if (!FIELD_RE.test(field)) throw new Error(`bad fact field: ${raw.field}`);
  const kind = String(raw.kind || '').trim().toLowerCase();
  if (!FACT_KINDS.has(kind)) throw new Error(`bad fact kind for ${field}: ${raw.kind}`);
  if (DERIVED_FIELDS.has(field) && kind !== 'snapshot') throw new Error(`${field} is derived; store its invariant or a snapshot`);
  const srcMsg = Number(raw.source_message_id);
  if (!Number.isSafeInteger(srcMsg) || !messages.has(srcMsg)) throw new Error(`bad source_message_id for ${field}`);
  const periodStart = optionalDate(raw.period_start, `${field}.period_start`);
  const periodEnd = optionalDate(raw.period_end, `${field}.period_end`);
  let asOf = optionalDate(raw.as_of, `${field}.as_of`);
  if (kind === 'periodic' && (periodStart == null || periodEnd == null)) throw new Error(`${field}: periodic facts require period_start and period_end`);
  if (kind === 'snapshot' && asOf == null) asOf = messages.get(srcMsg).sent_at;
  if (kind === 'standing' && (periodStart != null || periodEnd != null || asOf != null)) throw new Error(`${field}: standing facts cannot carry period/as_of`);
  const valueNum = raw.value_num == null ? null : Number(raw.value_num);
  if (valueNum != null && !Number.isFinite(valueNum)) throw new Error(`${field}.value_num must be numeric`);
  return {
    slug, field, kind, value: cleanText(raw.value, `${field}.value`), value_num: valueNum,
    unit: raw.unit == null ? null : cleanText(raw.unit, `${field}.unit`, 40),
    period_start: periodStart, period_end: periodEnd,
    period_label: raw.period_label == null ? null : cleanText(raw.period_label, `${field}.period_label`, 80),
    as_of: asOf, as_of_stated: raw.as_of != null,
    src_msg: srcMsg, observed_at: messages.get(srcMsg).sent_at, run_id: runId || null,
  };
}

function validateMention(raw, slug, messages, resolver, runId, validMessageIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('each mention must be an object');
  const target = cleanText(raw.target, 'mention.target', 120);
  const toSlug = resolver ? resolver(target) : null;
  if (!toSlug) throw new Error(`mention target is unknown or ambiguous: ${target}`);
  if (toSlug === slug) throw new Error(`mention target resolves to the profile subject: ${target}`);
  const kind = String(raw.kind || 'mentioned').toLowerCase();
  if (!MENTION_KINDS.has(kind)) throw new Error(`bad mention kind: ${raw.kind}`);
  const srcMsg = Number(raw.source_message_id);
  if (!Number.isSafeInteger(srcMsg) || !messages.has(srcMsg)) throw new Error(`bad source_message_id for mention ${target}`);
  if (validMessageIds && !validMessageIds.has(srcMsg)) throw new Error(`mention source m${srcMsg} is outside this chunk`);
  return { from_slug: slug, to_slug: toSlug, kind,
    note: raw.note == null ? null : cleanText(raw.note, 'mention.note', 300),
    src_msg: srcMsg, observed_at: messages.get(srcMsg).sent_at, run_id: runId || null };
}

function applyStructuredReply(db, slug, reply, opts = {}) {
  const parsed = parseStructuredReply(reply, { required: opts.required !== false });
  const ids = [...parsed.facts, ...parsed.mentions].map((x) => Number(x && x.source_message_id)).filter(Number.isSafeInteger);
  const messages = messageRows(db, ids);
  const validMessageIds = opts.validMessageIds == null ? null : new Set([...opts.validMessageIds].map(Number));
  const facts = parsed.facts.map((f) => validateFact(f, slug, messages, opts.runId));
  const mentions = parsed.mentions.map((m) => validateMention(m, slug, messages, opts.resolve, opts.runId, validMessageIds));
  let factCount = 0;
  const ownTransaction = opts.transaction !== false;
  let mentionCount = 0;
  if (ownTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    for (const f of facts) { const r = recordFact(db, f); if (!r.duplicate) factCount += 1; }
    for (const m of mentions) mentionCount += recordMention(db, m);
    if (ownTransaction) db.exec('COMMIT');
  } catch (e) {
    if (ownTransaction) try { db.exec('ROLLBACK'); } catch { /* original error wins */ }
    throw e;
  }
  return { factsStored: factCount, mentionsStored: mentionCount, facts: currentFacts(db, slug) };
}

function factLabel(field) {
  return field.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function renderStructuredProfile(md, facts) {
  let out = String(md);
  for (const f of facts) {
    const label = IDENTITY_FIELDS.get(f.field);
    if (!label) continue;
    const re = new RegExp(`^(- \\*\\*${label}:\\*\\*\\s*).*$`, 'm');
    if (re.test(out)) out = out.replace(re, `$1${f.value}`);
    else out = out.replace(/^(# .*\r?\n)/, `$1- **${label}:** ${f.value}\n`);
  }
  const bodyFacts = facts.filter((f) => !IDENTITY_FIELDS.has(f.field));
  const lines = bodyFacts.map((f) => {
    const period = f.kind === 'periodic' && f.period_label ? ` (${f.period_label})` : '';
    return `- **${factLabel(f.field)}${period}:** ${f.value}${f.src_msg ? ` ⟨m${f.src_msg}⟩` : ''}`;
  });
  const section = `## What I know\n\n${lines.length ? lines.join('\n') : '_No structured facts yet._'}\n\n`;
  const start = out.search(/^## What I know\s*$/m);
  if (start >= 0) {
    const rest = out.slice(start);
    const next = rest.slice(rest.indexOf('\n') + 1).search(/^## /m);
    const end = next < 0 ? out.length : start + rest.indexOf('\n') + 1 + next;
    out = `${out.slice(0, start)}${section}${out.slice(end)}`;
  } else {
    const at = out.search(/^## Timeline\s*$/m);
    out = at >= 0 ? `${out.slice(0, at)}${section}${out.slice(at)}` : `${out.replace(/\s*$/, '\n\n')}${section}`;
  }
  return out;
}

module.exports = { parseStructuredReply, applyStructuredReply, renderStructuredProfile, factLabel, IDENTITY_FIELDS };
