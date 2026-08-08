'use strict';
// lib/redact.js — mask model-provider content-filter triggers in text sent to the
// MODEL. The archive (crm.db) always keeps the original; only the model's copy is
// masked, so citations, the permanent record, and every UI view are untouched.
//
// WHY: Moonshot rejects a ledger with HTTP 400 content_filter ("... considered
// high risk") when it contains a flagged token. One flagged token fails the WHOLE
// chunk, so the model's copy must have it neutralized. Vowel-masking one letter
// ("n*ggerson") proved too weak for Moonshot's filter, so the default fix is now
// full descriptive redaction ("[redacted black slur]").
//
// LOOKUP TABLE — data/censor-rules.json, a hand-editable list of rules:
//   { "mode": "regex", "pattern": "<regex source>", "replacement": "[redacted black slur]" }
//   { "mode": "word",  "pattern": "beaner",         "replacement": "[redacted mexican slur]" }
// mode: 'regex' (pattern is a regex, catches variants/embeddings), 'word' (whole
// word, exact), or 'substring' (anywhere). `replacement` is substituted verbatim;
// omit it to fall back to vowel-masking the matched token. Rules apply in order.
// The file seeds from DEFAULT_RULES below the first time it's touched, then it is
// the source of truth — edit it freely, or use the CLI:
//   node lib/redact.js list
//   node lib/redact.js test "josh niggerson vs my beaner friend"
//   node lib/redact.js add-word <word> <replacement...>
//   node lib/redact.js add-regex <pattern> <replacement...>
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const RULES_FILE = path.join(DATA_DIR, 'censor-rules.json');

const DEFAULT_RULES = [
  {
    mode: 'regex',
    // Any n-word slur + variants/embeddings (nigger, nigga, niggah, niggerson,
    // n1gga…) — but NOT the innocent English words that happen to contain "nigg"
    // (snigger, niggle, niggard…), excluded up front.
    pattern: '\\b(?!(?:snigger|sniggers|sniggered|sniggering|niggle|niggles|niggled|niggling|niggard|niggardly)\\b)[a-z0-9!*]*n[i1!*]gg[a-z0-9!*]*\\b',
    replacement: '[redacted black slur]',
    note: 'n-word family (regex — catches variants and embeddings like "niggerson")',
  },
  {
    mode: 'word',
    pattern: 'beaner',
    replacement: '[redacted mexican slur]',
    note: 'exact word',
  },
];

// DETECTOR candidates — the broader known-slur set, used ONLY to auto-identify a
// culprit after a rejection (crm-merge learn()s the match). `sub:true` matches as
// a substring; `sub:false` matches only as a whole word (so "spic" flags the slur
// but never "spice").
const CANDIDATES = [
  { t: 'nigger', sub: true }, { t: 'faggot', sub: true }, { t: 'niglet', sub: true },
  { t: 'wetback', sub: true }, { t: 'tranny', sub: true }, { t: 'beaner', sub: true },
  { t: 'chink', sub: false }, { t: 'kike', sub: false }, { t: 'spic', sub: false },
  { t: 'coon', sub: false }, { t: 'gook', sub: false }, { t: 'retard', sub: false },
];

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function loadRules() {
  try {
    const raw = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
    if (Array.isArray(raw)) return raw.filter((r) => r && typeof r.pattern === 'string');
  } catch { /* no file or bad json → fall back to the built-in defaults */ }
  return DEFAULT_RULES;
}
function saveRules(rules) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2)); } catch { /* best-effort */ }
}

// Compile each rule to { re, replacement }, cached until a rule is added.
let _compiled = null;
function compiled() {
  if (_compiled) return _compiled;
  _compiled = loadRules().map((r) => {
    let src;
    if (r.mode === 'regex') src = r.pattern;
    else if (r.mode === 'substring') src = escapeRe(r.pattern);
    else src = `\\b${escapeRe(r.pattern)}\\b`; // 'word' (default): whole-word, exact
    let re = null;
    try { re = new RegExp(src, 'gi'); } catch { re = null; }
    return { re, replacement: r.replacement };
  }).filter((r) => r.re);
  return _compiled;
}

// Fallback masking when a rule has no explicit replacement: interior vowel nearest
// the word's centre -> "*" (e.g. "beaner" -> "be*ner").
function mask(word) {
  const V = 'aeiou';
  const cands = [];
  for (let i = 1; i < word.length - 1; i += 1) if (V.includes(word[i].toLowerCase())) cands.push(i);
  let idx;
  if (cands.length) {
    const c = (word.length - 1) / 2;
    idx = cands.reduce((b, i) => (Math.abs(i - c) < Math.abs(b - c) ? i : b), cands[0]);
  } else {
    idx = Math.floor(word.length / 2);
  }
  return word.slice(0, idx) + '*' + word.slice(idx + 1);
}

// Apply every rule in order. An explicit replacement wins; otherwise vowel-mask.
function redact(text) {
  if (!text) return text;
  let out = String(text);
  for (const { re, replacement } of compiled()) {
    out = out.replace(re, (m) => ((typeof replacement === 'string' && replacement.length) ? replacement : mask(m)));
  }
  return out;
}

// Which known slurs appear in `text` — used to name a culprit after a rejection.
function detect(text) {
  const t = String(text || '');
  const found = new Set();
  for (const c of CANDIDATES) {
    const re = new RegExp(c.sub ? escapeRe(c.t) : `\\b${escapeRe(c.t)}\\b`, 'i');
    if (re.test(t)) found.add(c.t);
  }
  return [...found];
}

// Auto-add detected slurs as whole-word rules with full descriptive redaction
// (vowel-masking proved too weak, so default to removal). Returns words added.
function learn(words) {
  const add = (Array.isArray(words) ? words : [words]).map((w) => String(w).toLowerCase()).filter(Boolean);
  const rules = loadRules();
  const have = new Set(rules.filter((r) => r.mode === 'word' || !r.mode).map((r) => String(r.pattern).toLowerCase()));
  const added = [];
  for (const w of add) {
    if (!have.has(w)) { rules.push({ mode: 'word', pattern: w, replacement: '[redacted slur]', note: 'auto-learned' }); added.push(w); have.add(w); }
  }
  if (added.length) { saveRules(rules); _compiled = null; }
  return added;
}

// Manually append a rule (used by the CLI).
function addRule(rule) {
  const rules = loadRules();
  rules.push(rule);
  saveRules(rules);
  _compiled = null;
  return rule;
}

function rules() { return loadRules(); }

module.exports = { redact, detect, learn, addRule, rules, mask, DEFAULT_RULES, CANDIDATES, RULES_FILE };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const ensure = () => { if (!fs.existsSync(RULES_FILE)) saveRules(DEFAULT_RULES); };
  if (cmd === 'list') { ensure(); console.log(JSON.stringify(loadRules(), null, 2)); }
  else if (cmd === 'test') { console.log(redact(rest.join(' '))); }
  else if (cmd === 'add-word' && rest.length >= 2) { ensure(); addRule({ mode: 'word', pattern: rest[0].toLowerCase(), replacement: rest.slice(1).join(' ') }); console.log(`added word rule: ${rest[0].toLowerCase()} -> ${rest.slice(1).join(' ')}`); }
  else if (cmd === 'add-regex' && rest.length >= 2) { ensure(); addRule({ mode: 'regex', pattern: rest[0], replacement: rest.slice(1).join(' ') }); console.log('added regex rule'); }
  else console.log('usage: node lib/redact.js list | test <text> | add-word <word> <replacement> | add-regex <pattern> <replacement>');
}
