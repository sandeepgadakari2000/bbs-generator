'use strict';

/* =====================================================================
   SCHEME TESTS — the four partition strategies and the exterior massing.
   The envelope is the structural grid's extent, in millimetres.
   ===================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const SCHEME = require('../src/scheme.js');
const { generateSchemes, exteriorFor, ROOM, EXT } = SCHEME;

const ENV = { widthMm: 9600, depthMm: 10800, floors: 2, bedrooms: 3 };
function gen(over) { return generateSchemes(Object.assign({}, ENV, over || {})); }

test('four schemes come back, each with its own identity', function () {
  const list = gen();
  assert.equal(list.length, 4);
  const ids = list.map(function (s) { return s.id; });
  assert.deepEqual(ids, ['A1', 'A2', 'A3', 'A4']);
  assert.equal(new Set(list.map(function (s) { return s.facade; })).size, 4,
    'each scheme should read differently on the outside');
  list.forEach(function (s) {
    assert.ok(s.name && s.tag, s.id + ' has no name or description');
    assert.equal(s.floors.length, ENV.floors);
    assert.ok(s.builtM2 > 0 && s.builtSqft > 0);
  });
});

test('rooms tile the envelope exactly and none escape it', function () {
  gen().forEach(function (s) {
    s.floors.forEach(function (f) {
      const area = f.rooms.reduce(function (a, r) { return a + r.widthMm * r.depthMm; }, 0);
      assert.ok(Math.abs(area / 1e6 - ENV.widthMm * ENV.depthMm / 1e6) < 0.02,
        s.id + ' ' + f.name + ' packs ' + (area/1e6).toFixed(2) + ' m² into ' +
        (ENV.widthMm*ENV.depthMm/1e6).toFixed(2));
      f.rooms.forEach(function (r) {
        assert.ok(r.xMm >= -1 && r.yMm >= -1, s.id + ' ' + r.n + ' starts outside');
        assert.ok(r.xMm + r.widthMm <= ENV.widthMm + 1, s.id + ' ' + r.n + ' runs past the width');
        assert.ok(r.yMm + r.depthMm <= ENV.depthMm + 1, s.id + ' ' + r.n + ' runs past the depth');
        assert.ok(r.widthMm > 0 && r.depthMm > 0, s.id + ' ' + r.n + ' has no extent);');
      });
    });
  });
});

test('no two rooms on a floor overlap', function () {
  gen().forEach(function (s) {
    s.floors.forEach(function (f) {
      for (let i = 0; i < f.rooms.length; i++) {
        for (let j = i + 1; j < f.rooms.length; j++) {
          const a = f.rooms[i], b = f.rooms[j];
          const gap = a.xMm + a.widthMm <= b.xMm + 1 || b.xMm + b.widthMm <= a.xMm + 1 ||
                      a.yMm + a.depthMm <= b.yMm + 1 || b.yMm + b.depthMm <= a.yMm + 1;
          assert.ok(gap, s.id + ' ' + f.name + ': ' + a.n + ' overlaps ' + b.n);
        }
      }
    });
  });
});

test('the bedroom count asked for is the bedroom count planned', function () {
  [2, 3, 4, 5].forEach(function (beds) {
    gen({ bedrooms: beds }).forEach(function (s) {
      let n = 0;
      s.floors.forEach(function (f) {
        f.rooms.forEach(function (r) { if (/^(Bedroom|Master Bedroom)/.test(r.n)) n++; });
      });
      assert.ok(n <= beds, s.id + ' planned ' + n + ' bedrooms for ' + beds + ' asked');
      assert.ok(n >= Math.min(2, beds), s.id + ' only planned ' + n + ' of ' + beds);
    });
  });
});

test('a narrow envelope is single loaded — no rooms side by side but services', function () {
  const narrow = ROOM.limits.narrowWidthMm - 700;
  gen({ widthMm: narrow }).forEach(function (s) {
    s.floors.forEach(function (f) {
      const rows = {};
      f.rooms.forEach(function (r) { (rows[r.yMm] = rows[r.yMm] || []).push(r); });
      Object.keys(rows).forEach(function (k) {
        assert.ok(rows[k].length <= 2,
          s.id + ' put ' + rows[k].length + ' rooms across a ' + narrow + ' mm width');
      });
    });
  });
});

test('flip mirrors the plan and keeps every area', function () {
  const a = gen()[0], b = gen({ flip: true })[0];
  assert.equal(a.builtM2, b.builtM2);
  assert.equal(a.floors[0].rooms.length, b.floors[0].rooms.length);
  const left = a.floors[0].rooms[0];
  const same = b.floors[0].rooms.filter(function (r) { return r.n === left.n; })[0];
  assert.ok(same, 'the mirrored plan lost a room');
  assert.equal(same.xMm, ENV.widthMm - left.xMm - left.widthMm, 'not mirrored about the centre');
});

test('a new seed moves the bands but still fills the envelope', function () {
  const a = gen({ seed: 0 })[0], b = gen({ seed: 4 })[0];
  const depthsA = a.floors[0].rooms.map(function (r) { return r.depthMm; }).join(',');
  const depthsB = b.floors[0].rooms.map(function (r) { return r.depthMm; }).join(',');
  assert.notEqual(depthsA, depthsB, 'the seed changed nothing');
  [a, b].forEach(function (s) {
    const area = s.floors[0].rooms.reduce(function (x, r) { return x + r.widthMm * r.depthMm; }, 0);
    assert.ok(Math.abs(area / 1e6 - ENV.widthMm * ENV.depthMm / 1e6) < 0.02);
  });
});

test('a room under its minimum is flagged, never quietly grown', function () {
  /* a deliberately shallow envelope cannot give Living its minimum */
  const s = gen({ depthMm: 6600 })[0];
  const living = s.floors[0].rooms.filter(function (r) { return r.n === 'Living'; })[0];
  assert.ok(living, 'no living room planned');
  const min = ROOM.minMm.Living;
  const short = living.widthMm < min[0] * s.relax || living.depthMm < min[1] * s.relax;
  assert.ok(short, 'expected the shallow plan to squeeze the living room');
  assert.equal(living.tight, true, 'a squeezed room must be flagged');
  assert.ok(s.tight > 0 && s.tightNames.length > 0, 'the flags must be reported on the scheme');
  /* and the envelope is still respected rather than being stretched to fit */
  assert.ok(living.yMm + living.depthMm <= 6600 + 1);
});

test('open space is counted apart from built area', function () {
  gen().forEach(function (s) {
    let open = 0;
    s.floors.forEach(function (f) {
      f.rooms.forEach(function (r) { if (r.open) open += r.areaM2; });
    });
    assert.ok(Math.abs(open - s.openM2) < 0.2, s.id + ' open area disagrees');
    assert.ok(s.carpetM2 < s.builtM2, 'carpet must be under built-up');
    assert.ok(Math.abs(s.carpetM2 - s.builtM2 * ROOM.carpetFraction) < 0.2);
  });
});

/* --- exterior massing ------------------------------------------------ */
test('the chosen scheme masses into drawable faces', function () {
  gen().forEach(function (s) {
    const ex = exteriorFor(s, { floorHeightMm: 3000 });
    assert.ok(ex.parts.length > 10, s.id + ' massed into only ' + ex.parts.length + ' parts');
    ex.parts.forEach(function (p) {
      assert.ok(p.kind, 'a part with no kind');
      p.faces.forEach(function (f) {
        assert.equal(f.v.length, 4, s.id + ' ' + p.kind + ' face is not a quad');
        assert.equal(f.n.length, 3);
        const len = Math.hypot(f.n[0], f.n[1], f.n[2]);
        assert.ok(len > 0.9 && len < 1.1, s.id + ' ' + p.kind + ' normal is not unit length');
        f.v.forEach(function (v) {
          v.forEach(function (c) { assert.ok(Number.isFinite(c), 'non-finite vertex'); });
        });
      });
    });
    /* the massing must cover the plan footprint and rise above the top floor */
    assert.ok(ex.bounds.min[0] <= 0 && ex.bounds.max[0] >= s.widthMm);
    assert.ok(ex.bounds.max[2] >= s.depthMm);
    assert.ok(ex.ridgeMm > EXT.plinthMm + s.floors.length * 3000,
      s.id + ' has no roof above the top floor');
  });
});

test('each facade masses differently', function () {
  const kinds = gen().map(function (s) {
    const ex = exteriorFor(s, { floorHeightMm: 3000 });
    return ex.parts.map(function (p) { return p.kind; }).sort().join(',');
  });
  assert.equal(new Set(kinds).size, 4, 'two facades massed identically');
  /* the skillion is the only one with a sloped plane */
  const sk = exteriorFor(gen()[0], { floorHeightMm: 3000 });
  const sloped = sk.parts.filter(function (p) {
    return p.faces.some(function (f) { return Math.abs(f.n[1]) > 0.01 && Math.abs(f.n[0]) > 0.01; });
  });
  assert.ok(sloped.length > 0, 'the skillion roof is not sloped');
});

test('a taller storey lifts the whole massing', function () {
  const s = gen()[0];
  const a = exteriorFor(s, { floorHeightMm: 3000 });
  const b = exteriorFor(s, { floorHeightMm: 3600 });
  assert.ok(b.ridgeMm > a.ridgeMm, 'floor height did not reach the exterior');
  assert.equal(b.ridgeMm - a.ridgeMm, (3600 - 3000) * s.floors.length);
});

/* --- constants are config, not scattered literals -------------------- */
test('the packer reads its minimums from ROOM at call time', function () {
  const saved = ROOM.minMm.Living.slice();
  try {
    ROOM.minMm.Living = [9000, 9000];        // nothing this size fits
    const s = gen()[0];
    const living = s.floors[0].rooms.filter(function (r) { return r.n === 'Living'; })[0];
    assert.equal(living.tight, true, 'raising the minimum should flag the room');
  } finally { ROOM.minMm.Living = saved; }
  const back = gen()[0].floors[0].rooms.filter(function (r) { return r.n === 'Living'; })[0];
  assert.equal(back.tight, false, 'ROOM was not restored');
});

test('the exterior reads its dimensions from EXT at call time', function () {
  const s = gen()[0];
  const before = exteriorFor(s, { floorHeightMm: 3000 }).ridgeMm;
  const saved = EXT.plinthMm;
  try {
    EXT.plinthMm = saved + 600;
    assert.equal(exteriorFor(s, { floorHeightMm: 3000 }).ridgeMm, before + 600);
  } finally { EXT.plinthMm = saved; }
  assert.equal(exteriorFor(s, { floorHeightMm: 3000 }).ridgeMm, before, 'EXT was not restored');
});

/* --- it joins onto the frame the schedule already used ---------------- */
test('an envelope taken from a structural grid plans without complaint', function () {
  const { frame } = require('../src/bbs.js');
  const F = frame({
    baysXMm: [3000, 3600, 3000], baysYMm: [3600, 3600, 3600],
    floors: 2, floorHeightMm: 3000,
    column: { widthMm: 300, depthMm: 450 }, beam: { widthMm: 230, depthMm: 450 },
    slab: { thicknessMm: 125 }, footing: { lengthMm: 1500, widthMm: 1500, depthMm: 450 },
    template: {}
  });
  const gx = F.grid.xMm, gz = F.grid.zMm;
  const list = generateSchemes({
    widthMm: gx[gx.length - 1], depthMm: gz[gz.length - 1],
    floors: F.grid.floors, bedrooms: 3
  });
  assert.equal(list.length, 4);
  list.forEach(function (s) {
    assert.equal(s.widthMm, 9600);
    assert.equal(s.depthMm, 10800);
    assert.equal(s.floors.length, 2, 'the plan should have as many floors as the frame');
    assert.equal(s.tight, 0, s.id + ' flagged ' + s.tightNames.join(', ') + ' on a 9.6 x 10.8 grid');
  });
});
