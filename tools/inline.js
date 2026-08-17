#!/usr/bin/env node
'use strict';

/* Copies src/bbs.js verbatim into the <script id="engine"> block of
   bbs.html. Not a build step for the browser — bbs.html is committed
   whole and opens from the filesystem on its own. This just keeps the
   two copies identical, and test/inline.test.js fails if they drift.

   Run: node tools/inline.js  */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* each source module gets its own marked block in bbs.html */
const MODULES = [
  { src: 'src/bbs.js',
    begin: '/* ENGINE:BEGIN — generated from src/bbs.js by tools/inline.js. Do not edit here. */',
    end: '/* ENGINE:END */' },
  { src: 'src/plan.js',
    begin: '/* PLAN:BEGIN — generated from src/plan.js by tools/inline.js. Do not edit here. */',
    end: '/* PLAN:END */' }
];

const BEGIN = MODULES[0].begin;
const END = MODULES[0].end;

function between(html, begin, end) {
  const a = html.indexOf(begin);
  const b = html.indexOf(end);
  if (a < 0 || b < 0 || b < a) return null;
  return html.slice(a + begin.length, b).replace(/^\n/, '').replace(/\n$/, '');
}

/* the engine block, kept for callers that only care about src/bbs.js */
function extract(html) { return between(html, BEGIN, END); }

function main() {
  const htmlPath = path.join(ROOT, 'bbs.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  const changed = [];

  for (const mod of MODULES) {
    const source = fs.readFileSync(path.join(ROOT, mod.src), 'utf8').replace(/\n$/, '');
    const a = html.indexOf(mod.begin);
    const b = html.indexOf(mod.end);
    if (a < 0 || b < 0) {
      console.error('bbs.html is missing the markers for ' + mod.src + '.');
      process.exit(1);
    }
    if (source.indexOf('</script') >= 0) {
      console.error(mod.src + ' contains a </script sequence and cannot be inlined.');
      process.exit(1);
    }
    const next = html.slice(0, a + mod.begin.length) + '\n' + source + '\n' + html.slice(b);
    if (next !== html) changed.push(mod.src + ' (' + source.length + ' chars)');
    html = next;
  }

  if (!changed.length) {
    console.log('bbs.html already in sync with ' + MODULES.map(function (m) { return m.src; }).join(' + '));
    return;
  }
  fs.writeFileSync(htmlPath, html);
  console.log('bbs.html updated from ' + changed.join(', '));
}

module.exports = { BEGIN, END, MODULES, extract, between };
if (require.main === module) main();
