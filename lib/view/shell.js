'use strict';
// The document shell every page renders into: fonts, the stylesheet, the dark-mode
// lamp, and the theme-before-paint script. `page()` takes an h() body node and
// returns the full HTML string. `route`, when given, prints a corner tag — the
// preview uses it to label the URL; the real server omits it.
const fs = require('fs');
const path = require('path');
const { render } = require('./h');

const STYLE = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');

// Fonts are self-hosted. The Google Fonts <link> was a render-blocking network
// round-trip on every navigation — pages waited on fonts.googleapis.com before
// first paint, and offline they hung. fonts/fonts.css declares @font-face over
// /fonts/*.woff2, which whoever hosts the shell (crm-web.js, design/preview.js)
// serves from FONTS_DIR with immutable caching. Inlined, so nothing blocks; if
// the files are ever missing, the stacks fall back to system serif/monospace.
const FONTS_DIR = path.join(__dirname, 'fonts');
let fontsCss = '';
try { fontsCss = fs.readFileSync(path.join(FONTS_DIR, 'fonts.css'), 'utf8'); } catch { /* fall back to system fonts */ }
const FONTS = fontsCss ? `<style>${fontsCss}</style>` : '';

const THEME_INIT = "<script>try{var t=localStorage.getItem('crm-theme');"
  + "if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}</script>";

const THEME_JS = "<script>(function(){"
  + "function cur(){return document.documentElement.getAttribute('data-theme')"
  + "||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');}"
  + "function lbl(){var b=document.querySelector('.lamp');if(b)b.textContent=cur()==='dark'?'☀ light':'☾ dark';}"
  + "window.__lamp=function(){var n=cur()==='dark'?'light':'dark';"
  + "document.documentElement.setAttribute('data-theme',n);"
  + "try{localStorage.setItem('crm-theme',n);}catch(e){}lbl();};"
  + "lbl();matchMedia('(prefers-color-scheme:dark)').addEventListener('change',lbl);})();</script>";

function page({ title, route, body }) {
  const tag = route ? `<div class="route-tag tw">${route}</div>` : '';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${title}</title>${THEME_INIT}${FONTS}<style>${STYLE}</style></head>`
    + `<body><button class="lamp" onclick="__lamp()">☾ dark</button>${tag}`
    + `<div class="sheet">${render(body)}</div>${THEME_JS}</body></html>`;
}

module.exports = { page, STYLE, FONTS, FONTS_DIR, THEME_INIT, THEME_JS };
