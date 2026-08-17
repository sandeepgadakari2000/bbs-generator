'use strict';

/* The engine lives once, in src/bbs.js. bbs.html carries a verbatim copy
   so it opens from the filesystem with no server and no build. These
   tests fail the moment the two drift. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extract } = require('../tools/inline.js');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'bbs.html'), 'utf8');

test('the inlined engine is byte-identical to src/bbs.js', function () {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bbs.js'), 'utf8').replace(/\n$/, '');
  const inlined = extract(html);
  assert.ok(inlined !== null, 'bbs.html has no ENGINE:BEGIN / ENGINE:END block');
  assert.equal(inlined, src, 'bbs.html engine block is stale — run: node tools/inline.js');
});

test('bbs.html pulls nothing off the network', function () {
  const offenders = [];
  const rx = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = rx.exec(html))) {
    const url = m[1];
    if (/^(https?:)?\/\//i.test(url) || /^data:/i.test(url) === false && /^\w+:\/\//.test(url)) {
      offenders.push(url);
    }
  }
  assert.deepEqual(offenders, [], 'external references found');
  assert.ok(!/@import\s+url/i.test(html), 'no CSS @import');
  assert.ok(!/\bfetch\s*\(/.test(html), 'no fetch()');
  assert.ok(!/XMLHttpRequest/.test(html), 'no XHR');
});

test('bbs.html touches no browser storage API', function () {
  ['localStorage', 'sessionStorage', 'indexedDB', 'openDatabase', 'document.cookie', 'caches']
    .forEach(function (api) {
      assert.ok(html.indexOf(api) < 0, 'bbs.html references ' + api);
    });
});

test('the viewer uses only the four palette colours', function () {
  // strip the engine block first — it has no colours, but keep the check honest
  const viewer = html.replace(extract(html), '');
  const allowed = ['#14171a', '#f6f7f6', '#b6bcb9', '#e07b1e', '#fff', '#ffffff'];
  const found = (viewer.match(/#[0-9a-f]{3,8}\b/gi) || [])
    .map(function (c) { return c.toLowerCase(); })
    .filter(function (c) { return allowed.indexOf(c) < 0; })
    .filter(function (c, i, a) { return a.indexOf(c) === i; });
  assert.deepEqual(found, [], 'off-palette colours: ' + found.join(', '));
});

test('the required verification line is in the app footer', function () {
  const footer = html.slice(html.lastIndexOf('<footer'), html.lastIndexOf('</footer>'));
  assert.match(footer, /Detailing constants follow common Indian practice\./);
  assert.match(footer, /IS 2502, IS 456/);
  assert.match(footer, /consultant['’]s detailing note before site use\./);
});

test('no BS 8666 conformance is claimed anywhere', function () {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bbs.js'), 'utf8');
  assert.ok(!/BS\s*8666/i.test(src) || /No BS 8666 conformance is claimed/.test(src));
  assert.ok(!/BS\s*8666/i.test(extract(html)) || /No BS 8666 conformance is claimed/.test(extract(html)));
  const viewer = html.replace(extract(html), '');
  assert.ok(!/BS\s*8666/i.test(viewer), 'the viewer must not mention BS 8666');
});
