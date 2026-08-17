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
const BEGIN = '/* ENGINE:BEGIN — generated from src/bbs.js by tools/inline.js. Do not edit here. */';
const END = '/* ENGINE:END */';

function extract(html) {
  const a = html.indexOf(BEGIN);
  const b = html.indexOf(END);
  if (a < 0 || b < 0 || b < a) return null;
  return html.slice(a + BEGIN.length, b).replace(/^\n/, '').replace(/\n$/, '');
}

function main() {
  const engine = fs.readFileSync(path.join(ROOT, 'src', 'bbs.js'), 'utf8').replace(/\n$/, '');
  const htmlPath = path.join(ROOT, 'bbs.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  const a = html.indexOf(BEGIN);
  const b = html.indexOf(END);
  if (a < 0 || b < 0) {
    console.error('bbs.html is missing the ENGINE:BEGIN / ENGINE:END markers.');
    process.exit(1);
  }
  if (engine.indexOf('</script') >= 0) {
    console.error('src/bbs.js contains a </script sequence and cannot be inlined.');
    process.exit(1);
  }

  const out = html.slice(0, a + BEGIN.length) + '\n' + engine + '\n' + html.slice(b);
  if (out === html) {
    console.log('bbs.html already in sync with src/bbs.js');
    return;
  }
  fs.writeFileSync(htmlPath, out);
  console.log('bbs.html engine block updated from src/bbs.js (' + engine.length + ' chars)');
}

module.exports = { BEGIN, END, extract };
if (require.main === module) main();
