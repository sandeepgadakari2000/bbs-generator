'use strict';

/* The engine lives once, in src/bbs.js. bbs.html carries a verbatim copy
   so it opens from the filesystem with no server and no build. These
   tests fail the moment the two drift. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extract, between, MODULES } = require('../tools/inline.js');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'bbs.html'), 'utf8');

/* the viewer alone — every inlined engine module removed */
const viewerOnly = MODULES.reduce(function (acc, mod) {
  const block = between(html, mod.begin, mod.end);
  return block ? acc.replace(block, '') : acc;
}, html);

MODULES.forEach(function (mod) {
  test('the inlined copy of ' + mod.src + ' is byte-identical to the source', function () {
    // git may hand either side CRLF on checkout, so compare the content
    // rather than the platform's choice of line ending
    const eol = function (t) { return t.replace(/\r\n/g, '\n').replace(/\s+$/, ''); };
    const src = fs.readFileSync(path.join(ROOT, mod.src), 'utf8');
    const inlined = between(html, mod.begin, mod.end);
    assert.ok(inlined !== null, 'bbs.html has no marked block for ' + mod.src);
    assert.equal(eol(inlined), eol(src),
      'bbs.html block for ' + mod.src + ' is stale — run: node tools/inline.js');
  });
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
  const viewer = viewerOnly
    .replace(/\$\('#[\w-]+'\)/g, '')          // querySelector ids are not colours
    .replace(/(?:id|for)="[\w-]+"/g, '');     // nor are the ids they point at
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

test('every inlined module loads in one shared global scope', function () {
  /* bbs.html gives each module its own <script>, and classic scripts
     share one global lexical environment. Two `const` declarations of a
     name are a SyntaxError at load; two `function` declarations silently
     replace one another. Running each block as its own script in one vm
     context reproduces exactly that, without a DOM. */
  const vm = require('node:vm');
  const ctx = vm.createContext({});
  MODULES.forEach(function (mod) {
    const src = between(html, mod.begin, mod.end);
    assert.ok(src !== null, 'no inlined block for ' + mod.src);
    vm.runInContext(src, ctx, { filename: mod.src });
  });
  const q = function (expr) { return vm.runInContext(expr, ctx); };

  ['BBS', 'PLAN', 'SCHEME', 'LOADS', 'DESIGN'].forEach(function (name) {
    assert.equal(q('typeof ' + name), 'object', name + ' is missing from the bundle');
  });
  /* the engines still compute, and none has clobbered another's helpers:
     src/bbs.js formats to 1 dp, src/loads.js to 3 */
  assert.equal(q('BBS.helpers.fmt(3.14159)'), '3.1', 'BBS.fmt was replaced by another module');
  assert.equal(q('LOADS.helpers.num(3.14159)'), '3.142', 'LOADS.num was replaced');
  assert.match(q('LOADS.slabLoad({thicknessMm:125,occupancy:"residentialRooms"}).derivation.factored'),
    /9\.188 kN\/m²$/);
  assert.match(q('DESIGN.flexureCapacity({astMm2:804.25,widthMm:300,overallDepthMm:450,' +
    'coverMm:25,stirrupDia:8,barDia:16,fck:25,fy:500}).derivation.capacity'), /124\.0 kNm$/);
});

test('the site root leads to the viewer, and is static too', function () {
  /* GitHub Pages serves index.html at the root; bbs.html is the tool. This
     page is the only thing standing between a visitor and a 404, so it has
     to keep every rule bbs.html keeps: relative, offline, on palette. */
  const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(idx, /http-equiv=["']refresh["'][^>]*url=bbs\.html/i,
    'index.html must send a visitor to bbs.html');
  assert.match(idx, /<a href="bbs\.html">/,
    'and carry a plain link for anyone the refresh does not move');

  const external = [];
  const rx = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = rx.exec(idx))) {
    if (/^(?:https?:)?\/\//i.test(m[1]) || /^\w+:\/\//.test(m[1])) external.push(m[1]);
  }
  assert.deepEqual(external, [], 'index.html must reference nothing off the machine');
  assert.ok(!/\bfetch\s*\(/.test(idx) && !/<script/i.test(idx),
    'index.html needs no script at all');

  const allowed = ['#14171a', '#f6f7f6', '#b6bcb9', '#e07b1e', '#fff', '#ffffff'];
  const off = (idx.match(/#[0-9a-f]{3,8}\b/gi) || [])
    .map(function (c) { return c.toLowerCase(); })
    .filter(function (c) { return allowed.indexOf(c) < 0; });
  assert.deepEqual(off, [], 'off-palette colours in index.html: ' + off.join(', '));

  /* Jekyll is off, so Pages serves exactly the files that are committed */
  assert.ok(fs.existsSync(path.join(ROOT, '.nojekyll')), '.nojekyll is missing');
});

test('no BS 8666 conformance is claimed anywhere', function () {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bbs.js'), 'utf8');
  assert.ok(!/BS\s*8666/i.test(src) || /No BS 8666 conformance is claimed/.test(src));
  const viewer = viewerOnly;
  assert.ok(!/BS\s*8666/i.test(viewer), 'the viewer must not mention BS 8666');
});
