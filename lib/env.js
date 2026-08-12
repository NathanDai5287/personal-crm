'use strict';
// Loads `<repo>/.env` into process.env exactly once, so a relocated checkout is
// configured by editing one file instead of hunting hardcoded paths through the
// source. No npm dependency — the format is plain `KEY=VALUE` lines (`#`
// comments, optional surrounding quotes). A real environment variable always
// wins over the file, so `CRM_SIGNAL_DB=… node scripts/foo.js` still overrides.
//
// Required first by anything that reads a machine-specific path (config.js,
// signal-key.js). ROOT is derived from this file's own location — the repo root
// is wherever the code physically lives — and can be overridden with CRM_ROOT.
const fs = require('fs');
const path = require('path');

const ROOT = (process.env.CRM_ROOT || path.resolve(__dirname, '..')).replace(/\\/g, '/');

let loaded = false;
function load() {
  if (loaded) return;
  loaded = true;
  let text;
  try { text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8'); } catch { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    const q = val[0];
    if ((q === '"' || q === "'") && val[val.length - 1] === q) val = val.slice(1, -1);
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
load();

module.exports = { ROOT };
