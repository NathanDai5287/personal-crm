'use strict';
// Parse and persist the structured side-channel emitted by the merge model.
// The profile edit remains the human-readable result; these rows are the durable,
// queryable record with source-message provenance.
const { FACT_KINDS, DERIVED_FIELDS, recordFact, currentFacts } = require('./schema');
const { dateKey, dateKeyToMs } = require('./weeks');

const FIELD_RE = /^[a-z][a-z0-9_]{0,63}$/;
// NOTE: person-to-person edges are NOT emitted by the model any more. The graph is
// built by a deterministic name scan (crm-mention-scan.js) that writes the same
// `mentions` table directly. This file only handles the [[FACTS]] block; a stray
// [[MENTIONS]] block in a reply (until the prompt drops it) is simply ignored.
const IDENTITY_FIELDS = new Map([
  ['relationship', 'Relationship'], ['birthday', 'Birthday'], ['phone', 'Phone'],
  ['signal_id', 'Signal ID'],
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
  return {
    slug, field, kind, value: cleanText(raw.value, `${field}.value`), value_num: valueNum,
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
  const facts = parsed.facts.map((f) => validateFact(f, slug, messages, opts.runId, validFactMessageIds));
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

function renderStructuredProfile(md, facts) {
  let out = String(md);
  const identityFacts = new Map();
  for (const f of facts) {
    if (!IDENTITY_FIELDS.has(f.field)) continue;
    const prior = identityFacts.get(f.field);
    if (!prior || Number(f.observed_at || 0) > Number(prior.observed_at || 0)
      || (Number(f.observed_at || 0) === Number(prior.observed_at || 0) && Number(f.id || 0) > Number(prior.id || 0))) {
      identityFacts.set(f.field, f);
    }
  }
  for (const f of identityFacts.values()) {
    const label = IDENTITY_FIELDS.get(f.field);
    const re = new RegExp(`^(- \\*\\*${label}:\\*\\*\\s*).*$`, 'm');
    if (re.test(out)) out = out.replace(re, (_match, prefix) => `${prefix}${f.value}`);
    else out = out.replace(/^(# .*\r?\n)/, (_match, title) => `${title}- **${label}:** ${f.value}\n`);
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

module.exports = {
  parseStructuredReply, applyStructuredReply, renderStructuredProfile, profileCitationIds,
  factLabel, IDENTITY_FIELDS,
};
