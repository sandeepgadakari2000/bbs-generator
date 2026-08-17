'use strict';

/* =====================================================================
   LOAD ENGINE TESTS — node --test

   The acceptance case at the top is the contract. Its expected values
   come from the brief and are not to be edited to match the engine.

   SOURCES for the expected values
   -------------------------------
   Every constant these tests exercise is a code value, cited at the
   place it lives in src/loads.js:

     unit weights          IS 875 (Part 1):1987, Table 1
                           — reinforced concrete 25 kN/m³
     imposed loads         IS 875 (Part 2):1987, Table 1
                           — residential rooms 2.0 kN/m²
     load factors          IS 456:2000, Table 18
                           — 1.5(DL + LL) and the rest
     one-way / two-way     IS 456:2000, cl 24.4.1
     yield-line shares     the 45° corner construction; the four areas
                           sum to the panel identically, which is what
                           the closure assertions defend

   The floor-finish figure is NOT a code value. It is an assumption and
   every result that uses it says so on `assumptions` — asserted below.

   Still OWED, and deliberately not faked: a page cite to a published
   worked example. The arithmetic here (thickness × 25, + finish, + LL,
   × 1.5, then areas that close exactly) is elementary enough to check
   by hand, and it has been. The values that genuinely need a textbook
   cross-check are the Table 19 τc interpolation and the Mu,lim factors
   in Stage 2, where a cite will be attached to the number itself.
   ===================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  LOAD, slabLoad, panelShares, panelToBeams, beamLine, beamEndReaction,
  columnStack, footingLoad, memberSelfWeight, memberSelfWeights,
  combine, buildingLoads
} = require('../src/loads.js');
const { frame } = require('../src/bbs.js');

/* --- helpers ------------------------------------------------------- */
function near(actual, expected, tol, what) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    what + ': got ' + actual + ', expected ' + expected + ' ±' + tol
  );
}
function panel() {
  /* a single 3.0 m × 4.0 m two-way panel, 125 mm slab, residential */
  return { shortMm: 3000, longMm: 4000, thicknessMm: 125, occupancy: 'residentialRooms' };
}

/* =====================================================================
   ACCEPTANCE — the brief's worked panel
   ===================================================================== */
test('ACCEPTANCE — 3.0 x 4.0 m panel, 125 mm slab, M25, residential', function (t) {
  const out = panelToBeams(panel());
  assert.equal(out.refused, false, 'the panel must not be refused');
  const load = out.load;

  t.diagnostic('dead     : ' + load.derivation.dead);
  t.diagnostic('live     : ' + load.derivation.live);
  t.diagnostic('service  : ' + load.derivation.service);
  t.diagnostic('factored : ' + load.derivation.factored);
  t.diagnostic('panel    : ' + out.panel.derivation);
  out.beams.forEach(function (b) { t.diagnostic(b.id + '   : ' + b.derivation); });

  /* the load table, line by line, exactly as the brief writes it
       slab self weight  0.125 × 25  = 3.125 kN/m²
       floor finish                    1.000 kN/m²
       live, residential               2.000 kN/m²
       service load                    6.125 kN/m²
       factored, 1.5 × 6.125           9.188 kN/m²                     */
  near(load.terms.dead[0].v, 3.125, 0.0005, 'slab self weight');
  near(load.terms.dead[1].v, 1.000, 0.0005, 'floor finish');
  near(load.liveKNPerM2, 2.000, 0.0005, 'imposed load, residential rooms');
  near(load.serviceKNPerM2, 6.125, 0.0005, 'service load');
  near(load.factoredKNPerM2, 9.188, 0.0005, 'factored load');
  near(load.exact.factored, 9.1875, 1e-9, 'factored load, unrounded');

  /* total factored load on the panel = 9.188 × 3.0 × 4.0 = 110.25 kN */
  near(out.panel.factoredKN, 110.25, 0.01, 'total factored load on the panel');

  /* THE CLOSURE CHECK — the whole point. If load vanishes in the
     distribution, this is what catches it. */
  assert.equal(out.beams.length, 4, 'a rectangular panel has four supporting beams');
  const sum = out.beams.reduce(function (s, b) { return s + b.factoredKN; }, 0);
  near(sum, out.panel.factoredKN, out.panel.factoredKN * 0.01,
       'the four beam reactions must sum to the panel load within 1%');
  assert.equal(out.closure.ok, true, 'closure flag');
  assert.ok(out.closure.errorPct < 0.01, 'closure error ' + out.closure.errorPct + '%');

  /* the shares themselves: triangles on the 3 m edges, trapezoids on
     the 4 m edges, at 45° from each corner */
  const short1 = out.beams.filter(function (b) { return b.id === 'short-1'; })[0];
  const long1 = out.beams.filter(function (b) { return b.id === 'long-1'; })[0];
  assert.equal(short1.shape, 'triangle');
  assert.equal(long1.shape, 'trapezoid');
  near(short1.areaM2, 2.25, 0.001, 'triangle on the short edge, ½ × 3.0 × 1.5');
  near(long1.areaM2, 3.75, 0.001, 'trapezoid on the long edge, ½ × (4.0 + 1.0) × 1.5');
  near(short1.factoredKNPerM, 6.891, 0.002, 'equivalent UDL on a 3 m beam');
  near(long1.factoredKNPerM, 8.613, 0.002, 'equivalent UDL on a 4 m beam');

  /* derivation shape is a hard requirement, not a nicety */
  assert.equal(load.derivation.dead,
    '3.125 (0.125 m × 25 kN/m³ reinforced concrete) + 1.000 (floor finish, assumed) = 4.125 kN/m²');
  assert.equal(load.derivation.live, 'live load, residential rooms = 2.000 kN/m²');
  assert.equal(load.derivation.service, '4.125 (dead) + 2.000 (imposed) = 6.125 kN/m²');
  assert.equal(load.derivation.factored, '1.5 × 6.125, 1.5(DL + LL) = 9.188 kN/m²');
  assert.match(out.panel.derivation, /9\.188 kN\/m² × 3\.000 × 4\.000 m = 110\.250 kN/);
  assert.match(short1.derivation, /triangle/);
  assert.match(short1.derivation, /= 6\.891 kN\/m$/);

  /* the floor finish is an assumption and must announce itself */
  assert.equal(out.assumptions.length, 1, 'one assumption, the floor finish');
  assert.match(out.assumptions[0], /floor finish taken as 1\.000 kN\/m²/);
  assert.match(out.assumptions[0], /an assumption, not a code value/);

  /* and the equivalent UDL must not be passed off as moment-equivalent */
  assert.ok(out.notes.some(function (n) { return /load-equivalent/.test(n); }),
    'the UDL convention must be stated');
});

/* =====================================================================
   DISTRIBUTION
   ===================================================================== */
test('a one-way panel sheds to two beams only', function () {
  /* long/short = 6.0/3.0 = 2.0, at LOAD.distribution.oneWayRatio — IS 456 cl 24.4.1 */
  const out = panelToBeams({ shortMm: 3000, longMm: 6000, thicknessMm: 125,
                             occupancy: 'residentialRooms' });
  assert.equal(out.shares.mode, 'oneWay', 'ratio 2.0 spans one way');
  const carrying = out.beams.filter(function (b) { return b.factoredKN > 0; });
  assert.equal(carrying.length, 2, 'two beams carry the panel');
  assert.deepEqual(carrying.map(function (b) { return b.id; }).sort(), ['long-1', 'long-2'],
    'a panel spanning the short way is supported on its long edges');
  /* each long edge takes half the short span over the full long span */
  near(carrying[0].areaM2, 9.0, 0.001, 'half of 3.0 m × 6.0 m');
  near(out.closure.sumFactoredKN, out.closure.panelFactoredKN, 0.01, 'one-way closure');
  out.beams.filter(function (b) { return b.edge === 'short'; }).forEach(function (b) {
    assert.equal(b.factoredKN, 0, 'the short edges carry no slab load');
  });
});

test('just under the ratio the same panel is still two-way', function () {
  const out = panelShares({ shortMm: 3000, longMm: 5999 });
  assert.equal(out.mode, 'twoWay');
  assert.equal(out.edges.filter(function (e) { return e.areaM2 > 0; }).length, 4);
});

test('a cantilever sheds entirely to one beam', function () {
  const out = panelToBeams({ shortMm: 1200, longMm: 4000, thicknessMm: 125,
                             occupancy: 'balconies', mode: 'cantilever',
                             cantileverEdge: 'long-1' });
  const carrying = out.beams.filter(function (b) { return b.factoredKN > 0; });
  assert.equal(carrying.length, 1, 'one support');
  assert.equal(carrying[0].id, 'long-1');
  near(carrying[0].factoredKN, out.panel.factoredKN, 0.001, 'it takes the whole panel');
  near(out.load.liveKNPerM2, 3.0, 0.0005, 'balcony imposed load, IS 875 Part 2');
});

test('a cantilever with no named support is refused, not guessed', function () {
  const out = panelToBeams({ shortMm: 1200, longMm: 4000, thicknessMm: 125,
                            occupancy: 'balconies', mode: 'cantilever' });
  assert.equal(out.refused, true);
  assert.match(out.reason, /cannot be derived/);
  assert.match(out.reason, /cantileverEdge/);
});

test('sides given long-first are swapped and the swap is reported', function () {
  const out = panelShares({ shortMm: 4000, longMm: 3000 });
  near(out.shortSpanM, 3.0, 1e-9, 'short span');
  assert.ok(out.notes.some(function (n) { return /swapped/.test(n); }));
});

test('the four yield-line shares close on any aspect ratio', function () {
  [[3000, 3000], [3000, 3500], [2400, 4600], [3000, 5999], [1000, 1999]]
    .forEach(function (p) {
      const s = panelShares({ shortMm: p[0], longMm: p[1] });
      near(s.closure.sumAreaM2, s.closure.panelAreaM2, s.closure.panelAreaM2 * 1e-4,
           p.join('x') + ' closure');
    });
});

/* =====================================================================
   REFUSALS — a precondition that does not hold is stated, not assumed
   ===================================================================== */
test('an occupancy that is not in the table is refused', function () {
  const out = slabLoad({ thicknessMm: 125, occupancy: 'warehouse' });
  assert.equal(out.refused, true);
  assert.match(out.reason, /warehouse/);
  assert.match(out.reason, /residentialRooms/, 'the refusal lists what is available');
  assert.match(out.reason, /rather than borrow/);
});

test('no occupancy at all is refused', function () {
  assert.equal(slabLoad({ thicknessMm: 125 }).refused, true);
});

test('an explicit imposed load is accepted in place of an occupancy', function () {
  const out = slabLoad({ thicknessMm: 125, liveKNPerM2: 5.0 });
  assert.equal(out.refused, false);
  near(out.serviceKNPerM2, 3.125 + 1.0 + 5.0, 0.0005, 'service load');
  assert.match(out.derivation.live, /given/);
});

test('an unknown superimposed dead component is refused', function () {
  const out = slabLoad({ thicknessMm: 125, occupancy: 'office', sdl: ['solarPanels'] });
  assert.equal(out.refused, true);
  assert.match(out.reason, /solarPanels/);
});

test('false ceiling and services are opt-in, never assumed', function () {
  const bare = slabLoad({ thicknessMm: 125, occupancy: 'office' });
  const all = slabLoad({ thicknessMm: 125, occupancy: 'office',
                         sdl: ['floorFinish', 'falseCeiling', 'services'] });
  near(bare.deadKNPerM2, 4.125, 0.0005, 'floor finish only by default');
  near(all.deadKNPerM2, 4.725, 0.0005, 'all three when asked for');
  assert.equal(all.assumptions.length, 3, 'each one announces itself');
});

test('a given superimposed value is not reported as an assumption', function () {
  const out = slabLoad({ thicknessMm: 125, occupancy: 'office', sdl: { floorFinish: 1.5 } });
  near(out.deadKNPerM2, 4.625, 0.0005);
  assert.equal(out.assumptions.length, 0, 'a value the engineer gave is not an assumption');
});

test('a wall with no height is refused rather than sized', function () {
  const out = beamLine({ section: { widthMm: 230, depthMm: 450 }, slabThicknessMm: 125,
                         wall: { thicknessMm: 230 } });
  assert.equal(out.refused, true);
  assert.match(out.reason, /neither is assumed/);
});

test('a member shape this module cannot weigh is refused, not approximated', function () {
  const out = memberSelfWeight('staircase', { widthMm: 1000, waistMm: 150 });
  assert.equal(out.refused, true);
  assert.match(out.reason, /not guessed/);
});

test('soil overburden with no soil data is named as excluded, never taken as zero', function () {
  const out = footingLoad({
    footing: { lengthMm: 1500, widthMm: 1500, depthMm: 450 },
    columnDeadKN: 300, columnLiveKN: 60
  });
  assert.equal(out.refused, false, 'the rest of the footing load is still computed');
  assert.equal(out.overburden.refused, true);
  assert.match(out.overburden.reason, /NOT in this total/);
  assert.match(out.overburden.reason, /site values/);
  assert.ok(out.notes.some(function (n) { return /NOT in this total/.test(n); }),
    'the exclusion is on the result, not only inside the term');
  /* 1.5 × 1.5 × 0.45 × 25 = 25.3125 kN of footing */
  near(out.selfWeightKN, 25.313, 0.001, 'footing self weight');
  near(out.deadKN, 325.313, 0.001, 'dead = column + footing, no fill');
});

test('soil overburden is computed when the site values are given', function () {
  const out = footingLoad({
    footing: { lengthMm: 1500, widthMm: 1500, depthMm: 450 },
    column: { widthMm: 300, depthMm: 450 },
    columnDeadKN: 300, columnLiveKN: 60,
    soil: { unitWeightKNPerM3: 18, foundingDepthMm: 1500 }
  });
  /* (1.5×1.5 − 0.3×0.45) = 2.115 m² of fill, (1.5 − 0.45) = 1.05 m deep,
     × 18 kN/m³ = 39.9735 kN */
  near(out.overburden.kN, 39.974, 0.002, 'soil on the footing');
  near(out.deadKN, 300 + 25.3125 + 39.9735, 0.002, 'dead including fill');
  assert.ok(out.assumptions.some(function (a) {
    return /Neither has a default in LOAD/.test(a);
  }), 'the site values must be recorded as given, not as code values');
});

test('a footing standing above its founding level is refused', function () {
  const out = footingLoad({
    footing: { lengthMm: 1500, widthMm: 1500, depthMm: 450 },
    columnDeadKN: 300, columnLiveKN: 60,
    soil: { unitWeightKNPerM3: 18, foundingDepthMm: 300 }
  });
  assert.equal(out.refused, true);
  assert.match(out.reason, /above ground/);
});

/* =====================================================================
   COMBINATIONS
   ===================================================================== */
test('every combination in Table 18 produces a case', function () {
  const out = combine({ DL: 100, LL: 40, EL: 25, WL: 15 });
  assert.equal(out.cases.length, LOAD.combinations.length,
    'one case per row of LOAD.combinations');
  const uls = out.cases.filter(function (c) { return c.limitState === 'collapse'; });
  const sls = out.cases.filter(function (c) { return c.limitState === 'serviceability'; });
  assert.ok(uls.length >= 7, 'the collapse block');
  assert.ok(sls.length >= 1, 'the serviceability block');
  out.cases.forEach(function (c) {
    assert.equal(c.clause, 'IS 456 Table 18', c.id + ' must cite its table');
    assert.match(c.derivation, /=/, c.id + ' must carry its arithmetic');
  });
  /* 1.5(DL + LL) = 1.5 × 100 + 1.5 × 40 = 210 */
  const g = out.cases.filter(function (c) { return c.id === 'ULS-1'; })[0];
  near(g.value, 210, 0.001, '1.5(DL + LL)');
});

test('filtering by limit state keeps only that block', function () {
  const out = combine({ DL: 100, LL: 40, limitState: 'serviceability' });
  assert.ok(out.cases.length > 0);
  assert.ok(out.cases.every(function (c) { return c.limitState === 'serviceability'; }));
  near(out.cases.filter(function (c) { return c.id === 'SLS-1'; })[0].value, 140, 0.001);
});

test('the envelope picks the governing case and reports the reversal', function () {
  /* light dead, heavy lateral. 1.5(DL + EL) = 195 beats
     1.2(DL + LL + EL) = 180 — dropping the imposed load costs less than
     the drop in factor gains, which is exactly why Table 18 lists both
     and why the envelope is computed rather than assumed. */
  const out = combine({ DL: 50, LL: 20, EL: 80 });
  near(out.envelope.maxValue, 1.5 * (50 + 80), 0.001, 'largest case');
  assert.equal(out.envelope.maxCase, 'ULS-4');
  near(out.cases.filter(function (c) { return c.id === 'ULS-2'; })[0].value,
       1.2 * (50 + 20 + 80), 0.001, '1.2(DL + LL + EL) is computed too, it just loses');
  /* 0.9DL − 1.5EL goes into uplift: 45 − 120 = −75 kN */
  near(out.envelope.minValue, 0.9 * 50 - 1.5 * 80, 0.001, 'the reversal');
  assert.equal(out.envelope.minCase, 'ULS-7');
  assert.match(out.envelope.derivation, /governing ULS-4/);
  assert.match(out.envelope.derivation, /reversal ULS-7/);
  /* the envelope is the max over the cases, whatever they happen to be */
  const best = out.cases.reduce(function (a, b) { return b.exact > a.exact ? b : a; });
  assert.equal(out.envelope.maxCase, best.id);
});

test('the envelope picks the maximum per member, member by member', function () {
  const spec = frameSpec();
  const out = buildingLoads(frame(spec), { occupancy: 'residentialRooms' });
  assert.equal(out.refused, false);
  out.columns.forEach(function (c) {
    const cases = c.combinations.cases;
    const best = cases.reduce(function (a, b) { return b.exact > a.exact ? b : a; });
    near(c.combinations.envelope.maxValue, best.value, 0.001,
      'node ' + c.node.i + ',' + c.node.j + ' envelope');
    assert.equal(c.combinations.envelope.maxCase, best.id);
  });
  /* gravity only, so 1.5(DL + LL) must govern every column */
  const governing = out.columns.map(function (c) { return c.combinations.envelope.maxCase; })
                              .filter(function (v, i, a) { return a.indexOf(v) === i; });
  assert.deepEqual(governing, ['ULS-1'], 'with no lateral load, ULS-1 governs everywhere');
});

/* =====================================================================
   THE LOAD PATH, ON THE FRAME THE SCHEDULE ALREADY USES
   ===================================================================== */
function frameSpec(over) {
  return Object.assign({
    baysXMm: [3000, 3600, 3000], baysYMm: [3600, 3600],
    floors: 2, floorHeightMm: 3000,
    column: { widthMm: 300, depthMm: 450 },
    beam: { widthMm: 230, depthMm: 450 },
    slab: { thicknessMm: 125 },
    footing: { lengthMm: 1500, widthMm: 1500, depthMm: 450 }
  }, over || {});
}

test('self weight is taken from the geometry frame() already returns', function () {
  const f = frame(frameSpec());
  const sw = memberSelfWeights(f);
  assert.ok(sw.members.length > 0, 'every frame member is weighed');
  assert.equal(sw.notes.length, 0, 'the frame holds no shape this module cannot weigh');
  /* one column, 0.3 × 0.45 × 3.0 m × 25 = 10.125 kN */
  const col = sw.members.filter(function (m) { return m.id === 'C1'; })[0];
  near(col.kNPerMember, 10.125, 0.001, 'column self weight');
  assert.match(col.derivation, /25 kN\/m³ reinforced concrete/);
  /* and the total is the sum of the parts */
  near(sw.totalKN, sw.members.reduce(function (s, m) { return s + m.kNTotal; }, 0), 0.01);
});

test('the whole building closes: every panel arrives at a footing', function (t) {
  const f = frame(frameSpec());
  const out = buildingLoads(f, { occupancy: 'residentialRooms' });
  assert.equal(out.refused, false, out.reason);

  /* the slab load reaching the beams, floor by floor */
  let panelKN = 0;
  out.floors.forEach(function (fl) {
    fl.panels.forEach(function (p) {
      panelKN += p.factoredKN;
      assert.equal(p.closure.ok, true, p.id + ' closure');
    });
  });

  /* the same load arriving at the footings, less the frame's own
     weight, which the panels never carried */
  const footingKN = out.footings.reduce(function (s, ft) { return s + ft.factoredKN; }, 0);
  const frameSelfKN = out.selfWeight.totalKN;
  t.diagnostic('panels  : ' + panelKN.toFixed(1) + ' kN factored');
  t.diagnostic('footings: ' + footingKN.toFixed(1) + ' kN factored');
  t.diagnostic('frame self weight: ' + frameSelfKN.toFixed(1) + ' kN service');

  assert.ok(footingKN > panelKN,
    'the footings must carry the panels plus the frame, ' + footingKN + ' vs ' + panelKN);
  assert.equal(out.footings.length, f.grid.intersections, 'one footing per grid intersection');
  assert.equal(out.columns.length, f.grid.intersections, 'one stack per grid intersection');

  /* the load path is stated for what it is */
  assert.ok(out.notes.some(function (n) { return /statically determinate/.test(n); }));
  assert.ok(out.notes.some(function (n) { return /imposed-load reduction/.test(n); }));
  assert.ok(out.notes.some(function (n) { return /No wall load/.test(n); }));
  assert.ok(out.notes.some(function (n) { return /top floor carries the same occupancy/.test(n); }));
});

test('column axial accumulates downward and carries its own weight', function () {
  const out = buildingLoads(frame(frameSpec()), { occupancy: 'residentialRooms' });
  const c = out.columns[0];
  assert.equal(c.storeys.length, 2, 'two storeys');
  assert.ok(c.storeys[0].deadKN > c.storeys[1].deadKN,
    'the lower storey carries more than the upper');
  /* the difference between storeys is the upper storey's floor load
     plus one column's self weight */
  near(c.storeys[0].deadKN - c.storeys[1].deadKN,
       c.storeys[0].floorDeadKN + c.selfWeightKNPerStorey, 0.01,
       'one storey of accumulation');
  near(c.baseDeadKN, c.storeys[0].deadKN, 1e-9, 'base is the lowest storey');
  assert.match(c.storeys[0].derivation, /running total/);
});

test('a corner column carries less than an interior one', function () {
  const out = buildingLoads(frame(frameSpec()), { occupancy: 'residentialRooms' });
  const at = function (i, j) {
    return out.columns.filter(function (c) { return c.node.i === i && c.node.j === j; })[0];
  };
  assert.ok(at(1, 1).baseDeadKN > at(0, 0).baseDeadKN,
    'interior ' + at(1, 1).baseDeadKN + ' kN should exceed corner ' + at(0, 0).baseDeadKN + ' kN');
});

test('a wall is loaded only where it is said to be', function () {
  const spec = frameSpec();
  const bare = buildingLoads(frame(spec), { occupancy: 'residentialRooms' });
  const walled = buildingLoads(frame(spec), {
    occupancy: 'residentialRooms',
    wall: { thicknessMm: 230, heightMm: 2550, on: 'perimeter' }
  });
  const per = walled.floors[0].beams.filter(function (b) { return b.onPerimeter; })[0];
  const inner = walled.floors[0].beams.filter(function (b) { return !b.onPerimeter; })[0];
  const bareInner = bare.floors[0].beams.filter(function (b) { return !b.onPerimeter; })[0];
  assert.equal(inner.deadKNPerM, bareInner.deadKNPerM, 'an interior beam gains nothing');
  assert.ok(per.deadKNPerM > bare.floors[0].beams.filter(function (b) {
    return b.onPerimeter; })[0].deadKNPerM, 'a perimeter beam gains the wall');
  /* 0.23 × 2.55 × 19 = 11.1435 kN/m of brickwork */
  near(per.deadKNPerM - bare.floors[0].beams.filter(function (b) {
    return b.onPerimeter && b.id === per.id; })[0].deadKNPerM, 11.1435, 0.002, 'wall line load');
  assert.ok(walled.assumptions.some(function (a) { return /No opening is deducted/.test(a); }));
});

test('beam self weight is the web only, so the frame concrete is counted once', function () {
  const line = beamLine({ section: { widthMm: 230, depthMm: 450 }, slabThicknessMm: 125 });
  /* 0.23 × (0.450 − 0.125) × 25 = 1.869 kN/m */
  near(line.deadKNPerM, 1.869, 0.001, 'web self weight');
  assert.match(line.derivation.dead, /web \(450 − 125 slab\)/);
  assert.ok(line.notes.some(function (n) { return /counts it twice/.test(n); }));
});

test('half of each beam line goes to each end node', function () {
  const line = beamLine({ section: { widthMm: 230, depthMm: 450 }, slabThicknessMm: 125,
                          panels: [{ deadKNPerM: 4.0, liveKNPerM: 3.0 }] });
  const r = beamEndReaction(line, 4000);
  near(r.deadKN, 0.5 * (1.869 + 4.0) * 4.0, 0.01, 'dead end reaction');
  near(r.liveKN, 0.5 * 3.0 * 4.0, 0.001, 'live end reaction');
});

test('buildingLoads refuses a frame it cannot walk', function () {
  assert.match(buildingLoads(null, {}).reason, /needs a frame\(\) result/);
  const oneLine = frame(Object.assign(frameSpec(), { baysYMm: [] }));
  assert.match(buildingLoads(oneLine, { occupancy: 'office' }).reason, /at least one bay each way/);
  const f = frame(frameSpec());
  assert.match(buildingLoads(f, { occupancy: ['office'] }).reason, /1 entries for 2 floors/);
});

test('occupancy can differ floor by floor', function () {
  const out = buildingLoads(frame(frameSpec()),
    { occupancy: ['residentialRooms', 'corridorsAndStairs'] });
  near(out.floors[0].slab.liveKNPerM2, 2.0, 0.0005);
  near(out.floors[1].slab.liveKNPerM2, 3.0, 0.0005);
});

/* =====================================================================
   THE CONFIG IS THE CONFIG
   ===================================================================== */
test('constants are read from LOAD at call time, not inlined', function () {
  function slab() { return slabLoad({ thicknessMm: 125, occupancy: 'residentialRooms' }); }
  function udl() {
    return panelToBeams(panel()).beams
      .filter(function (b) { return b.id === 'short-1'; })[0].factoredKNPerM;
  }

  const saved = {
    rc: LOAD.unitWeightKNPerM3.reinforcedConcrete,
    res: LOAD.liveKNPerM2.residentialRooms,
    ff: LOAD.sdlKNPerM2.floorFinish,
    gamma: LOAD.combinations[0].LL,
    ratio: LOAD.distribution.oneWayRatio,
    share: LOAD.path.beamEndShare,
    web: LOAD.path.beamWebOnly,
    prim: LOAD.primaryGravity
  };
  try {
    const d0 = slab().deadKNPerM2;
    LOAD.unitWeightKNPerM3.reinforcedConcrete = 30;
    assert.notEqual(slab().deadKNPerM2, d0, 'concrete unit weight is inlined somewhere');
    LOAD.unitWeightKNPerM3.reinforcedConcrete = saved.rc;

    const l0 = slab().liveKNPerM2;
    LOAD.liveKNPerM2.residentialRooms = 3.5;
    assert.notEqual(slab().liveKNPerM2, l0, 'imposed load is inlined somewhere');
    LOAD.liveKNPerM2.residentialRooms = saved.res;

    const f0 = slab().deadKNPerM2;
    LOAD.sdlKNPerM2.floorFinish = 1.5;
    assert.notEqual(slab().deadKNPerM2, f0, 'floor finish is inlined somewhere');
    LOAD.sdlKNPerM2.floorFinish = saved.ff;

    const g0 = slab().factoredKNPerM2;
    LOAD.combinations[0].LL = 1.75;
    assert.notEqual(slab().factoredKNPerM2, g0, 'the Table 18 factor is inlined somewhere');
    LOAD.combinations[0].LL = saved.gamma;

    /* 3.0 × 5.0 is two-way at a ratio limit of 2.0 and one-way at 1.5 */
    assert.equal(panelShares({ shortMm: 3000, longMm: 5000 }).mode, 'twoWay');
    LOAD.distribution.oneWayRatio = 1.5;
    assert.equal(panelShares({ shortMm: 3000, longMm: 5000 }).mode, 'oneWay',
      'the one-way ratio is inlined somewhere');
    LOAD.distribution.oneWayRatio = saved.ratio;

    const u0 = udl();
    LOAD.path.beamWebOnly = false;
    assert.equal(udl(), u0, 'the web rule must not touch the slab distribution');
    LOAD.path.beamWebOnly = saved.web;

    const line = beamLine({ section: { widthMm: 230, depthMm: 450 }, slabThicknessMm: 125 });
    LOAD.path.beamWebOnly = false;
    const full = beamLine({ section: { widthMm: 230, depthMm: 450 }, slabThicknessMm: 125 });
    assert.ok(full.deadKNPerM > line.deadKNPerM, 'the web rule is inlined somewhere');
    LOAD.path.beamWebOnly = saved.web;

    const r0 = beamEndReaction(line, 4000).deadKN;
    LOAD.path.beamEndShare = 0.6;
    assert.notEqual(beamEndReaction(line, 4000).deadKN, r0, 'the end share is inlined somewhere');
    LOAD.path.beamEndShare = saved.share;

    const p0 = slab().factoredKNPerM2;
    LOAD.primaryGravity = 'SLS-1';
    assert.notEqual(slab().factoredKNPerM2, p0, 'the primary combination is inlined somewhere');
    LOAD.primaryGravity = saved.prim;
  } finally {
    LOAD.unitWeightKNPerM3.reinforcedConcrete = saved.rc;
    LOAD.liveKNPerM2.residentialRooms = saved.res;
    LOAD.sdlKNPerM2.floorFinish = saved.ff;
    LOAD.combinations[0].LL = saved.gamma;
    LOAD.distribution.oneWayRatio = saved.ratio;
    LOAD.path.beamEndShare = saved.share;
    LOAD.path.beamWebOnly = saved.web;
    LOAD.primaryGravity = saved.prim;
  }
  /* and everything is back where it started */
  near(slabLoad({ thicknessMm: 125, occupancy: 'residentialRooms' }).factoredKNPerM2,
       9.188, 0.0005, 'LOAD was not restored');
});

test('every capacity-style result carries a derivation string', function () {
  const out = panelToBeams(panel());
  ['dead', 'live', 'service', 'factored'].forEach(function (k) {
    assert.match(out.load.derivation[k], / = .+ kN\/m²$/, k + ' derivation shape');
  });
  out.beams.forEach(function (b) {
    assert.match(b.derivation, /kN\/m²/, b.id + ' states the intensity');
    assert.match(b.derivation, /kN\/m$/, b.id + ' ends in the UDL');
  });
  assert.match(memberSelfWeight('column', { widthMm: 300, depthMm: 450, heightMm: 3000 }).derivation,
    / = .+ kN$/);
});

/* =====================================================================
   THE SINGLE-FILE RULE
   ===================================================================== */
test('src modules declare no clashing top-level name', function () {
  /* bbs.html inlines every module into one global scope, so two `const`
     declarations of the same name are a SyntaxError at load and two
     functions of the same name silently shadow one another. */
  const dir = path.join(__dirname, '..', 'src');
  const seen = {}, clashes = [];
  fs.readdirSync(dir).filter(function (f) { return /\.js$/.test(f); }).forEach(function (file) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const rx = /^(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm;
    let m;
    while ((m = rx.exec(src))) {
      if (seen[m[1]] && seen[m[1]] !== file) clashes.push(m[1] + ': ' + seen[m[1]] + ' and ' + file);
      seen[m[1]] = file;
    }
  });
  assert.deepEqual(clashes.filter(function (c, i, a) { return a.indexOf(c) === i; }), []);
});

test('src/loads.js requires cleanly with no DOM and touches no globals', function () {
  /* comments are stripped first: the banner says "no window", and a
     test that cannot tell the promise from the breach is no test */
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'loads.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  [/\bwindow\b/, /\bdocument\b/, /\blocalStorage\b/, /\bfetch\s*\(/, /\brequire\s*\(/,
   /\bXMLHttpRequest\b/, /\bprocess\b/].forEach(function (bad) {
    assert.ok(!bad.test(code), 'src/loads.js references ' + bad);
  });
  assert.ok(code.indexOf('</script') < 0, 'src/loads.js could not be inlined');
});
