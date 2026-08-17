'use strict';

/* =====================================================================
   BBS ENGINE TESTS — node --test
   The acceptance case at the top is the contract. Its expected values
   come from the brief and are not to be edited to match the engine.
   ===================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const { CODE, generate, frame, adoptExternalMembers } = require('../src/bbs.js');

/* --- helpers ------------------------------------------------------- */
function near(actual, expected, tol, what) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    what + ': got ' + actual + ', expected ' + expected + ' ±' + tol
  );
}
function mark(out, id) {
  const row = out.schedule.find(function (r) { return r.mark === id; });
  assert.ok(row, 'no schedule row marked ' + id);
  return row;
}
function codes(list) {
  return list.map(function (w) { return w.code; });
}

/* --- the acceptance member ----------------------------------------- */
function acceptanceJob() {
  return {
    project: { name: 'Acceptance', revision: 'R0' },
    members: [{
      id: 'B1',
      type: 'beam',
      quantity: 1,
      coverMm: 25,
      concrete: { widthMm: 300, depthMm: 450, spanMm: 4000 },
      bars: [
        { label: 'Bottom main', position: 'bottom', dia: 16, count: 4, end: 'hook' }
      ],
      stirrups: { shape: 'STIRRUP_RECT', dia: 8, spacingMm: 150, legs: 2 }
    }]
  };
}

test('ACCEPTANCE — 300x450 beam, 4-T16 bottom with U-hooks, T8 stirrups @150', function (t) {
  const out = generate(acceptanceJob());
  const main = mark(out, 'B1-01');
  const stir = mark(out, 'B1-02');
  const mem = out.members[0];

  // Print the derivations so a failure is diagnosable without a debugger.
  t.diagnostic('main    : ' + main.derivation);
  t.diagnostic('stirrup : ' + stir.derivation);
  t.diagnostic('count   : ' + stir.countDerivation);
  t.diagnostic('ratio   : ' + mem.steelPerM3.toFixed(1) + ' kg/m3 on ' +
                              mem.concreteM3Total.toFixed(3) + ' m3');

  near(main.cuttingLengthMm, 4238, 1, 'main bar cutting length');
  near(main.unitWeightKgPerM, 1.580, 0.001, 'main bar unit weight');
  near(main.totalWeightKg, 26.8, 0.1, 'main steel, 4 bars');

  near(stir.cuttingLengthMm, 1364, 1, 'stirrup cutting length');
  assert.equal(stir.totalBars, 28, 'stirrup count');
  near(stir.totalWeightKg, 15.1, 0.1, 'stirrup steel, total');

  near(mem.steelKg, 41.9, 0.1, 'total member steel');

  // Derivation string shape is a hard requirement, not a nicety.
  assert.equal(
    main.derivation,
    '3950 (4000 clear − 2×25 cover) + 288 (2 × 9d hook @ 16) = 4238 mm'
  );
  assert.match(stir.derivation, /^1300 \(.*\) \+ 160 \(.*\) − 96 \(.*\) = 1364 mm$/);

  // 0.54 m3 of concrete, bottom steel only -> the ratio floor must fire.
  near(mem.concreteM3Total, 0.54, 0.001, 'concrete volume');
  near(mem.steelPerM3, 41.876 / 0.54, 0.2, 'steel per m3');
  assert.ok(mem.steelPerM3 < CODE.limits.steelRatioMin, 'ratio should be under the floor');
  assert.ok(codes(out.warnings).includes('STEEL_RATIO'), 'steel-ratio warning must fire');

  // ...and nothing else should. Cover is exactly nominal, spacing is fine,
  // clear spacing is 56.7 mm, no laps, nothing over stock length.
  const others = out.warnings.filter(function (w) { return w.code !== 'STEEL_RATIO'; });
  assert.deepEqual(codes(others), [], 'unexpected extra warnings: ' +
    others.map(function (w) { return w.code + ' ' + w.text; }).join(' | '));
});

/* --- stirrup count rounding ---------------------------------------- */
test('stirrup count at an exact multiple of spacing does not gain a bar', function () {
  // clear span 3050, cover 25 -> run 3000, exactly 20 spaces of 150.
  const job = acceptanceJob();
  job.members[0].concrete.spanMm = 3050;
  const out = generate(job);
  const stir = mark(out, 'B1-02');
  assert.equal(stir.totalBars, 21, 'ceil(3000/150) + 1');
  assert.match(stir.countDerivation, /3000/);
});

test('stirrup count rounds up on a part space', function () {
  const job = acceptanceJob();
  job.members[0].concrete.spanMm = 3060;       // run 3010 -> 20.07 spaces
  assert.equal(mark(generate(job), 'B1-02').totalBars, 22);
});

/* --- stock length --------------------------------------------------- */
test('a 15 m cutting length trips the stock-length warning and states the lap', function () {
  const job = acceptanceJob();
  job.members[0].concrete.spanMm = 15050;      // 15000 mm clear of cover
  job.members[0].bars[0].end = 'continuous';
  const out = generate(job);
  const main = mark(out, 'B1-01');

  near(main.cuttingLengthMm, 15000, 1, 'cutting length');
  const w = out.warnings.find(function (x) { return x.code === 'STOCK_LENGTH'; });
  assert.ok(w, 'stock-length warning must fire');
  assert.match(w.text, /12000/, 'warning states the stock length');
  assert.match(w.text, /800/, 'warning states the 50d lap for a 16 mm bar');
  assert.equal(w.joints, 1);
  near(w.extraLapMm, CODE.lap.tension * 16, 0.5, 'extra lap length');
});

test('a bar inside stock length raises no stock warning', function () {
  const out = generate(acceptanceJob());
  assert.ok(!codes(out.warnings).includes('STOCK_LENGTH'));
});

/* --- both ends of the bar size range -------------------------------- */
test('6 mm bar — the hook minimum governs, not 9d', function () {
  const job = acceptanceJob();
  job.members[0].bars[0] = { label: 'Bottom main', position: 'bottom', dia: 6, count: 2, end: 'hook' };
  const main = mark(generate(job), 'B1-01');

  near(main.unitWeightKgPerM, 36 / 162, 0.0005, '6 mm unit weight');
  // 9d = 54 mm, below the 75 mm floor, so 75 mm is used at each end.
  near(main.cuttingLengthMm, 3950 + 2 * CODE.hook.minMm, 1, '6 mm cutting length');
  assert.match(main.derivation, /min 75/, 'derivation must say the minimum governed');
});

test('32 mm bar — top of the range', function () {
  const job = acceptanceJob();
  job.members[0].concrete.widthMm = 600;       // keep it out of the congestion check
  job.members[0].bars[0] = { label: 'Bottom main', position: 'bottom', dia: 32, count: 2, end: 'hook' };
  const main = mark(generate(job), 'B1-01');

  near(main.unitWeightKgPerM, 1024 / 162, 0.0005, '32 mm unit weight');
  near(main.cuttingLengthMm, 3950 + 2 * CODE.hook.u180 * 32, 1, '32 mm cutting length');
  near(main.totalWeightKg, (3950 + 576) / 1000 * (1024 / 162) * 2, 0.1, '32 mm total weight');
});

test('a diameter outside CODE.barSizes is flagged, not silently accepted', function () {
  const job = acceptanceJob();
  job.members[0].bars[0].dia = 14;
  const out = generate(job);
  assert.ok(codes(out.warnings).includes('BAR_SIZE'));
  assert.ok(mark(out, 'B1-01').cuttingLengthMm > 0, 'still computes — a flag, not a block');
});

/* --- quantity ------------------------------------------------------- */
test('quantity greater than one multiplies bars, length and weight', function () {
  const one = generate(acceptanceJob());
  const job = acceptanceJob();
  job.members[0].quantity = 7;
  const many = generate(job);

  const a = mark(one, 'B1-01'), b = mark(many, 'B1-01');
  assert.equal(b.barsPerMember, a.barsPerMember, 'bars per member unchanged');
  assert.equal(b.members, 7);
  assert.equal(b.totalBars, a.totalBars * 7);
  near(b.totalLengthM, a.totalLengthM * 7, 0.001, 'total length');
  near(b.totalWeightKg, a.totalWeightKg * 7, 0.01, 'total weight');
  near(b.cuttingLengthMm, a.cuttingLengthMm, 0.001, 'cutting length is per bar, unchanged');

  near(many.members[0].concreteM3Total, one.members[0].concreteM3Total * 7, 0.001, 'concrete');
  near(many.members[0].steelPerM3, one.members[0].steelPerM3, 0.01, 'ratio is scale-free');
});

/* --- wastage -------------------------------------------------------- */
test('wastage is a summary line only, never inside a bar weight', function () {
  const out = generate(acceptanceJob());
  const net = out.schedule.reduce(function (s, r) { return s + r.totalWeightKg; }, 0);
  near(out.summary.netKg, net, 0.001, 'net is the plain sum of bar weights');
  near(out.summary.wastageKg, net * CODE.wastagePct / 100, 0.01, 'wastage line');
  near(out.summary.grossKg, net + net * CODE.wastagePct / 100, 0.01, 'gross');
  // steel ratio is checked on design steel, before wastage
  near(out.summary.steelPerM3, out.summary.netKg / out.summary.concreteM3, 0.01, 'ratio uses net');
});

/* --- checks fire, and do not silently correct ----------------------- */
test('cover below the IS 456 nominal is surfaced, and the low cover is still used', function () {
  const job = acceptanceJob();
  job.members[0].coverMm = 15;
  const out = generate(job);
  assert.ok(codes(out.warnings).includes('COVER_BELOW_NOMINAL'));
  // 4000 - 2x15 = 3970, i.e. the engine used 15, it did not clamp to 25
  near(mark(out, 'B1-01').cuttingLengthMm, 3970 + 288, 1, 'low cover is honoured');
});

test('beam stirrup spacing over the lesser of 0.75d and 300 is flagged', function () {
  const job = acceptanceJob();
  job.members[0].stirrups.spacingMm = 320;
  const w = generate(job).warnings.find(function (x) { return x.code === 'STIRRUP_SPACING'; });
  assert.ok(w, 'spacing warning must fire');
  near(w.limit, CODE.limits.stirrupSpacingMaxMm, 0.001, '300 governs on a 450 deep beam');
});

test('congestion — clear spacing under the greater of dia and 25 mm', function () {
  const job = acceptanceJob();
  job.members[0].bars[0] = { label: 'Bottom main', position: 'bottom', dia: 25, count: 6, end: 'hook' };
  const w = generate(job).warnings.find(function (x) { return x.code === 'BAR_CONGESTION'; });
  assert.ok(w, 'congestion warning must fire');
  assert.ok(w.value < w.limit);
});

test('a lap at mid-span on bottom steel is flagged but not blocked', function () {
  const job = acceptanceJob();
  job.members[0].bars[0].laps = 1;
  job.members[0].bars[0].lapZone = 'midSpan';
  const out = generate(job);
  const w = out.warnings.find(function (x) { return x.code === 'LAP_ZONE'; });
  assert.ok(w, 'lap zone warning must fire');
  // the lap is still in the length: 50d x 16 = 800
  near(mark(out, 'B1-01').cuttingLengthMm, 4238 + CODE.lap.tension * 16, 1, 'lap is added');
});

test('steel ratio above the ceiling fires too', function () {
  const job = acceptanceJob();
  job.members[0].bars.push({ label: 'Top main', position: 'top', dia: 32, count: 4, end: 'hook' });
  const w = generate(job).warnings.find(function (x) { return x.code === 'STEEL_RATIO'; });
  assert.ok(w, 'ratio ceiling warning must fire');
  assert.ok(w.value > CODE.limits.steelRatioMax);
});

/* --- stirrup variants ---------------------------------------------- */
test('stirrup variants follow the agreed centre-line convention', function () {
  const base = acceptanceJob();
  function shape(s, extra) {
    const job = acceptanceJob();
    Object.assign(job.members[0].stirrups, { shape: s }, extra || {});
    return mark(generate(job), 'B1-02');
  }
  const c = 25, ds = 8;
  const a = 300 - 2 * c, b = 450 - 2 * c;              // 250, 400
  const hook = 2 * CODE.hook.stirrup135 * ds;          // 160
  const bendRect = (3 * CODE.bendDeduction[90] + 2 * CODE.bendDeduction[135]) * ds;   // 96
  const bendTri = (2 * CODE.bendDeduction[90] + 2 * CODE.bendDeduction[135]) * ds;    // 80
  const bendCirc = (2 * CODE.bendDeduction[135]) * ds;                                // 48

  near(shape('STIRRUP_RECT').cuttingLengthMm, 2 * (a + b) + hook - bendRect, 1, 'rect');
  near(shape('STIRRUP_TRI').cuttingLengthMm,
       a + 2 * Math.hypot(a / 2, b) + hook - bendTri, 1, 'triangular');
  near(shape('STIRRUP_DIA').cuttingLengthMm,
       4 * Math.hypot(a / 2, b / 2) + hook - bendRect, 1, 'diamond');
  near(shape('STIRRUP_CIRC', { diameterMm: 400 }).cuttingLengthMm,
       Math.PI * (400 - 2 * c - ds) + hook - bendCirc, 1, 'circular ring, centre-line');

  assert.equal(base.members[0].stirrups.shape, 'STIRRUP_RECT', 'fixture untouched');
});

/* --- cranks --------------------------------------------------------- */
test('a cranked bar takes 0.42D per crank and two 45 degree bends with it', function () {
  const job = {
    members: [{
      id: 'S1', type: 'slabOneWay', quantity: 1, coverMm: 20,
      concrete: { lengthMm: 3000, widthMm: 4000, thicknessMm: 125 },
      bars: [{ label: 'Main', position: 'bottom', along: 'length', dia: 12,
               spacingMm: 150, end: 'crank' }]
    }]
  };
  const row = mark(generate(job), 'S1-01');
  const D = 125 - 2 * 20 - 12;                          // 73 mm, centre to centre
  const expect = (3000 - 2 * 20)
               + 2 * CODE.crank.deg45 * D
               - 2 * 2 * CODE.bendDeduction[45] * 12;
  near(row.cuttingLengthMm, expect, 1, 'cranked slab bar');
  assert.equal(row.shape, 'CRANK');
  assert.match(row.derivation, /crank/);
});

/* --- every member type computes ------------------------------------- */
test('all eight member types produce a schedule', function () {
  const jobs = {
    footing: {
      id: 'F1', type: 'footing', quantity: 4, coverMm: 50,
      concrete: { lengthMm: 1800, widthMm: 1800, depthMm: 450 },
      bars: [
        { label: 'Bottom X', along: 'length', position: 'bottom', dia: 16, spacingMm: 150, end: 'bend' },
        { label: 'Bottom Y', along: 'width', position: 'bottom', dia: 16, spacingMm: 150, end: 'bend' }
      ]
    },
    column: {
      id: 'C1', type: 'column', quantity: 6, coverMm: 40,
      concrete: { widthMm: 300, depthMm: 450, heightMm: 3000 },
      bars: [{ label: 'Vertical', position: 'main', dia: 20, count: 6, end: 'continuous', laps: 1, lapType: 'compression' }],
      stirrups: { shape: 'STIRRUP_RECT', dia: 8, spacingMm: 150, legs: 2 }
    },
    beam: acceptanceJob().members[0],
    beamDoubly: {
      id: 'B2', type: 'beam', quantity: 2, coverMm: 25,
      concrete: { widthMm: 300, depthMm: 600, spanMm: 5000 },
      bars: [
        { label: 'Bottom main', position: 'bottom', dia: 20, count: 4, end: 'hook' },
        { label: 'Top main', position: 'top', dia: 16, count: 3, end: 'hook' }
      ],
      stirrups: { shape: 'STIRRUP_RECT', dia: 8, spacingMm: 150, legs: 2 }
    },
    slabOneWay: {
      id: 'S1', type: 'slabOneWay', quantity: 1, coverMm: 20,
      concrete: { lengthMm: 3000, widthMm: 4500, thicknessMm: 125 },
      bars: [
        { label: 'Main', along: 'length', position: 'bottom', dia: 10, spacingMm: 150, end: 'hook' },
        { label: 'Distribution', along: 'width', position: 'distribution', dia: 8, spacingMm: 200, end: 'continuous' }
      ]
    },
    slabTwoWay: {
      id: 'S2', type: 'slabTwoWay', quantity: 1, coverMm: 20,
      concrete: { lengthMm: 3600, widthMm: 4200, thicknessMm: 150 },
      bars: [
        { label: 'Short span', along: 'length', position: 'bottom', dia: 10, spacingMm: 125, end: 'hook' },
        { label: 'Long span', along: 'width', position: 'bottom', dia: 10, spacingMm: 150, end: 'hook' }
      ]
    },
    lintel: {
      id: 'L1', type: 'lintel', quantity: 8, coverMm: 25,
      concrete: { widthMm: 230, depthMm: 150, spanMm: 1200, bearingMm: 200 },
      bars: [{ label: 'Bottom', position: 'bottom', dia: 10, count: 2, end: 'hook' }],
      stirrups: { shape: 'STIRRUP_RECT', dia: 6, spacingMm: 150, legs: 2 }
    },
    staircase: {
      id: 'ST1', type: 'staircase', quantity: 2, coverMm: 20,
      concrete: { riserMm: 165, treadMm: 280, treads: 10, waistMm: 150,
                  widthMm: 1200, landingAMm: 1200, landingBMm: 1200 },
      bars: [
        { label: 'Main', along: 'flight', position: 'bottom', dia: 12, spacingMm: 150, end: 'bend' },
        { label: 'Distribution', along: 'width', position: 'distribution', dia: 8, spacingMm: 200, end: 'continuous' }
      ]
    }
  };

  Object.keys(jobs).forEach(function (k) {
    const out = generate({ members: [jobs[k]] });
    assert.ok(out.schedule.length > 0, k + ' produced no rows');
    out.schedule.forEach(function (r) {
      assert.ok(r.cuttingLengthMm > 0, k + '/' + r.mark + ' has no length');
      assert.ok(r.totalWeightKg > 0, k + '/' + r.mark + ' has no weight');
      assert.ok(/= \d+ mm$/.test(r.derivation), k + '/' + r.mark + ' derivation malformed: ' + r.derivation);
      assert.ok(CODE.shapes[r.shape], k + '/' + r.mark + ' unknown shape ' + r.shape);
    });
    assert.ok(out.members[0].concreteM3Total > 0, k + ' has no concrete volume');
  });

  // and all of them together
  const all = generate({ members: Object.keys(jobs).map(function (k) { return jobs[k]; }) });
  assert.equal(all.members.length, 8);
  assert.ok(all.summary.grossKg > all.summary.netKg);
  assert.equal(
    all.summary.byDiameter.reduce(function (s, d) { return s + d.weightKg; }, 0).toFixed(3),
    all.summary.netKg.toFixed(3)
  );
  assert.equal(
    all.summary.byMember.reduce(function (s, d) { return s + d.weightKg; }, 0).toFixed(3),
    all.summary.netKg.toFixed(3)
  );
});

/* --- the 3D cage ---------------------------------------------------- */
test('the cage lays every bar out in three dimensions', function () {
  const out = generate(acceptanceJob());
  const cage = out.members[0].cage;

  assert.equal(cage.solid.verts.length, 8, 'a beam is a box');
  assert.equal(cage.solid.faces.length, 6);
  assert.deepEqual(cage.bounds.max, [4000, 450, 300], 'span × depth × width');

  const long = cage.bars.filter(function (b) { return b.kind === 'long'; });
  const rings = cage.bars.filter(function (b) { return b.kind === 'ring'; });
  assert.equal(long.length, 4, 'one drawn bar per bar in the member');
  assert.equal(rings.filter(function (b) { return b.path.length > 2; }).length, 28,
    'one drawn stirrup per stirrup counted');
  assert.equal(cage.thinned, false);

  cage.bars.forEach(function (b) {
    assert.ok(b.path.length >= 2, b.mark + ' has a degenerate path');
    b.path.forEach(function (p) {
      assert.equal(p.length, 3);
      p.forEach(function (v) { assert.ok(Number.isFinite(v), b.mark + ' has a non-finite point'); });
    });
  });

  // the four bottom bars sit one bar-radius above cover + stirrup, spread across the width
  const zs = long.map(function (b) { return b.path[1][2]; }).sort(function (a, b) { return a - b; });
  assert.equal(zs[0], 25 + 8 + 8, 'first bar at cover + stirrup + radius');
  assert.equal(zs[3], 300 - (25 + 8 + 8), 'last bar symmetric');
});

test('cage bars stay inside the concrete, apart from hooks and legs standing proud', function () {
  const types = generate({ members: [
    { id:'F1', type:'footing', quantity:1, coverMm:50,
      concrete:{ lengthMm:1800, widthMm:1800, depthMm:450 },
      bars:[{ label:'X', along:'length', position:'bottom', dia:16, spacingMm:150, end:'bend' },
            { label:'Y', along:'width', position:'bottom', dia:16, spacingMm:150, end:'bend' }] },
    { id:'S1', type:'slabOneWay', quantity:1, coverMm:20,
      concrete:{ lengthMm:3000, widthMm:4500, thicknessMm:125 },
      bars:[{ label:'Main', along:'length', position:'bottom', dia:10, spacingMm:150, end:'crank' }] }
  ] });

  types.members.forEach(function (m) {
    const c = m.cage, lo = c.bounds.min, hi = c.bounds.max;
    c.bars.forEach(function (b) {
      b.path.forEach(function (p) {
        // x and z must stay within the plan outline; y may rise for a bent leg
        assert.ok(p[0] >= lo[0] - 1 && p[0] <= hi[0] + 1, m.id + ' bar leaves the plan in x');
        assert.ok(p[2] >= lo[2] - 1 && p[2] <= hi[2] + 1, m.id + ' bar leaves the plan in z');
        assert.ok(p[1] >= lo[1] - 1, m.id + ' bar drops below the soffit');
      });
    });
  });

  // the cranked slab bar really does change level
  const crank = types.members[1].cage.bars[0].path.map(function (p) { return p[1]; });
  assert.ok(Math.max.apply(null, crank) > Math.min.apply(null, crank), 'crank has no rise');
});

test('cage drawing limits never touch a quantity', function () {
  const job = acceptanceJob();
  job.members[0].concrete.spanMm = 12000;      // ~80 stirrups, over CODE.cage.maxRings
  const before = generate(job);
  assert.equal(before.members[0].cage.thinned, true, 'thinning must be reported, not silent');

  const saved = CODE.cage.maxRings;
  try {
    CODE.cage.maxRings = 500;
    const after = generate(job);
    assert.equal(after.members[0].cage.thinned, false);
    assert.equal(after.summary.grossKg, before.summary.grossKg, 'drawing budget changed a weight');
    assert.equal(mark(after, 'B1-02').totalBars, mark(before, 'B1-02').totalBars,
      'drawing budget changed a bar count');
  } finally { CODE.cage.maxRings = saved; }
});

test('every member type produces a drawable cage', function () {
  const beam = acceptanceJob().members[0];
  const jobs = [
    beam,
    { id:'C1', type:'column', quantity:1, coverMm:40,
      concrete:{ widthMm:300, depthMm:450, heightMm:3000 },
      bars:[{ label:'Vertical', position:'main', dia:20, count:6, end:'continuous' }],
      stirrups:{ shape:'STIRRUP_RECT', dia:8, spacingMm:150, legs:2 } },
    { id:'C2', type:'column', quantity:1, coverMm:40,
      concrete:{ widthMm:450, depthMm:450, heightMm:3000 },
      bars:[{ label:'Vertical', position:'main', dia:20, count:8, end:'continuous' }],
      stirrups:{ shape:'STIRRUP_CIRC', dia:8, spacingMm:150, diameterMm:450 } },
    { id:'L1', type:'lintel', quantity:1, coverMm:25,
      concrete:{ widthMm:230, depthMm:150, spanMm:1200, bearingMm:200 },
      bars:[{ label:'Bottom', position:'bottom', dia:10, count:2, end:'hook' }],
      stirrups:{ shape:'STIRRUP_RECT', dia:6, spacingMm:150, legs:2 } },
    { id:'S2', type:'slabTwoWay', quantity:1, coverMm:20,
      concrete:{ lengthMm:3600, widthMm:4200, thicknessMm:150 },
      bars:[{ label:'Short', along:'length', position:'bottom', dia:10, spacingMm:125, end:'hook' },
            { label:'Long', along:'width', position:'bottom', dia:10, spacingMm:150, end:'hook' }] },
    { id:'ST1', type:'staircase', quantity:1, coverMm:20,
      concrete:{ riserMm:165, treadMm:280, treads:10, waistMm:150, widthMm:1200,
                 landingAMm:1200, landingBMm:1200 },
      bars:[{ label:'Main', along:'flight', position:'bottom', dia:12, spacingMm:150, end:'bend' },
            { label:'Dist', along:'width', position:'distribution', dia:8, spacingMm:200, end:'continuous' }] }
  ];

  jobs.forEach(function (j) {
    const m = generate({ members: [j] }).members[0], c = m.cage;
    assert.ok(c, j.id + ' has no cage');
    assert.ok(c.solid.verts.length >= 8, j.id + ' has no solid');
    assert.ok(c.solid.faces.length >= 6, j.id + ' has no faces');
    assert.ok(c.bars.length > 0, j.id + ' has no bars in the cage');
    c.solid.faces.forEach(function (f) {
      f.forEach(function (i) {
        assert.ok(c.solid.verts[i], j.id + ' face indexes a missing vertex');
      });
    });
    c.bars.forEach(function (b) {
      assert.ok(b.mark && b.dia > 0, j.id + ' cage bar is missing its mark or diameter');
      b.path.forEach(function (p) {
        p.forEach(function (v) { assert.ok(Number.isFinite(v), j.id + ' non-finite point'); });
      });
    });
    // every mark in the schedule appears in the cage
    const marks = {};
    c.bars.forEach(function (b) { marks[b.mark] = true; });
    m.rows.forEach(function (r) { assert.ok(marks[r.mark], j.id + ' cage is missing ' + r.mark); });
  });
});

/* --- the structural frame ------------------------------------------- */
const TEMPLATE = {
  footing: { bars: [
    { label:'Bottom X', along:'length', position:'bottom', dia:16, spacingMm:150, end:'bend' },
    { label:'Bottom Y', along:'width', position:'bottom', dia:16, spacingMm:150, end:'bend' }] },
  column: { bars: [{ label:'Vertical', position:'main', dia:20, count:6, end:'continuous',
                     laps:1, lapType:'compression' }],
            stirrups: { shape:'STIRRUP_RECT', dia:8, spacingMm:150, legs:2 } },
  beam: { bars: [{ label:'Bottom main', position:'bottom', dia:16, count:4, end:'hook' },
                 { label:'Top main', position:'top', dia:12, count:2, end:'hook' }],
          stirrups: { shape:'STIRRUP_RECT', dia:8, spacingMm:150, legs:2 } },
  slab: { bars: [{ label:'Short span', along:'length', position:'bottom', dia:10, spacingMm:125, end:'hook' },
                 { label:'Long span', along:'width', position:'bottom', dia:10, spacingMm:150, end:'hook' }] }
};
function frameSpec(over) {
  return Object.assign({
    baysXMm: [3000, 3600, 3000], baysYMm: [3600, 3600],
    floors: 2, floorHeightMm: 3000,
    column: { widthMm: 300, depthMm: 450 },
    beam: { widthMm: 230, depthMm: 450 },
    slab: { thicknessMm: 125 },
    footing: { lengthMm: 1500, widthMm: 1500, depthMm: 450 },
    template: TEMPLATE
  }, over || {});
}

test('a grid expands to the right number of members', function () {
  const F = frame(frameSpec());
  const by = {};
  F.members.forEach(function (m) { by[m.id] = m; });

  assert.equal(F.grid.intersections, 12, '4 x 3 grid lines');
  assert.equal(F.grid.panels, 6, '3 x 2 bays');
  assert.equal(by.F1.quantity, 12, 'one footing per intersection');
  assert.equal(by.C1.quantity, 24, 'one column per intersection per floor');

  // 3 bays across x 3 grid lines x 2 floors = 18 beams along X, split by span
  assert.equal(by.BX1.quantity + by.BX2.quantity, 18);
  // 4 grid lines x 2 bays x 2 floors = 16 beams along Y
  assert.equal(by.BY1.quantity, 16);
  // 6 panels x 2 floors = 12 slabs
  assert.equal(by.S1.quantity + by.S2.quantity, 12);
  assert.deepEqual(F.notes, [], 'the template covered every member type');
});

test('clear spans are derived from the grid, not assumed', function () {
  const by = {};
  frame(frameSpec()).members.forEach(function (m) { by[m.id] = m; });

  // beam along X: bay spacing less the column width it frames into
  assert.equal(by.BX1.concrete.spanMm, 3000 - 300);
  assert.equal(by.BX2.concrete.spanMm, 3600 - 300);
  // beam along Y: bay spacing less the column depth
  assert.equal(by.BY1.concrete.spanMm, 3600 - 450);
  // slab panel: bay spacing less the beam width, each way, short span first
  assert.equal(by.S1.concrete.lengthMm, 3000 - 230);
  assert.equal(by.S1.concrete.widthMm, 3600 - 230);
  assert.equal(by.S2.concrete.lengthMm, 3600 - 230);
});

test('changing a column size moves the beam clear span with it', function () {
  const wide = frame(frameSpec({ column: { widthMm: 600, depthMm: 450 } }));
  const by = {};
  wide.members.forEach(function (m) { by[m.id] = m; });
  assert.equal(by.BX1.concrete.spanMm, 3000 - 600, 'clear span follows the column');
  assert.equal(by.BY1.concrete.spanMm, 3600 - 450, 'the other direction is unaffected');
});

test('every placed part belongs to a scheduled member', function () {
  const F = frame(frameSpec());
  const out = generate({ members: F.members });
  const ids = {};
  out.members.forEach(function (m) { ids[m.id] = true; });

  assert.equal(F.assembly.parts.length, 82, 'footings + columns + beams + slabs');
  F.assembly.parts.forEach(function (p) {
    assert.ok(ids[p.memberId], 'part references unknown member ' + p.memberId);
    assert.ok(['footing', 'column', 'beam', 'slab'].includes(p.kind));
    for (let k = 0; k < 3; k++) {
      assert.ok(p.max[k] > p.min[k], p.kind + ' part has no extent on axis ' + k);
      assert.ok(Number.isFinite(p.min[k]) && Number.isFinite(p.max[k]));
    }
  });

  // one part per member instance, summed over the marks
  const perMember = {};
  F.assembly.parts.forEach(function (p) { perMember[p.memberId] = (perMember[p.memberId] || 0) + 1; });
  F.members.forEach(function (m) {
    assert.equal(perMember[m.id], m.quantity, m.id + ' quantity and placed parts disagree');
  });
});

test('the frame schedules as a whole building with a sane steel ratio', function () {
  const F = frame(frameSpec());
  const out = generate({ members: F.members });
  assert.ok(out.schedule.length > 0);
  assert.ok(out.summary.concreteM3 > 40, 'concrete: ' + out.summary.concreteM3);
  assert.equal(out.summary.steelRatioFlag, 'ok',
    'whole-frame ratio should land in range, got ' + out.summary.steelPerM3);
  // and every member still carries its own cage
  out.members.forEach(function (m) {
    assert.ok(m.cage && m.cage.bars.length > 0, m.id + ' has no cage');
  });
});

test('the assembly stands on its footings and rises by the floor height', function () {
  const F = frame(frameSpec());
  const b = F.assembly.bounds;
  assert.equal(b.min[1], -450, 'the footings sit below datum by their depth');
  assert.equal(b.max[1], 2 * 3000, '2 floors at 3000');
  assert.equal(b.min[0], -750, 'the corner footing oversails the grid line by half its length');
  assert.equal(b.max[0], 9600 + 750);
});

test('a single-bay single-storey frame still works', function () {
  const F = frame(frameSpec({ baysXMm: [3000], baysYMm: [3000], floors: 1 }));
  const by = {};
  F.members.forEach(function (m) { by[m.id] = m; });
  assert.equal(by.F1.quantity, 4);
  assert.equal(by.C1.quantity, 4);
  assert.equal(by.BX1.quantity, 2);
  assert.equal(by.BY1.quantity, 2);
  assert.equal(by.S1.quantity, 1);
  assert.ok(generate({ members: F.members }).schedule.length > 0);
});

test('a missing reinforcement template is reported, not thrown', function () {
  const F = frame(frameSpec({ template: { column: TEMPLATE.column } }));
  assert.ok(F.notes.length > 0, 'the gap must be surfaced');
  assert.ok(F.notes.some(function (n) { return /footing/.test(n); }));
  // the members still exist with their concrete, they just carry no bars
  const by = {};
  F.members.forEach(function (m) { by[m.id] = m; });
  assert.equal(by.F1.bars, undefined);
  assert.ok(by.C1.bars.length > 0);
});

/* --- constants really do come from CODE ----------------------------- */
test('constants are read from CODE at call time, not inlined', function () {
  function len() { return mark(generate(acceptanceJob()), 'B1-01').cuttingLengthMm; }
  function stir() { return mark(generate(acceptanceJob()), 'B1-02').cuttingLengthMm; }
  function kg() { return generate(acceptanceJob()).summary.grossKg; }

  const l0 = len(), s0 = stir(), k0 = kg();
  const saved = { u180: CODE.hook.u180, b90: CODE.bendDeduction[90],
                  w: CODE.wastagePct, uw: CODE.unitWeight };
  try {
    CODE.hook.u180 = 12;
    assert.notEqual(len(), l0, 'hook factor is inlined somewhere');
    CODE.hook.u180 = saved.u180;

    CODE.bendDeduction[90] = 5;
    assert.notEqual(stir(), s0, 'bend deduction is inlined somewhere');
    CODE.bendDeduction[90] = saved.b90;

    CODE.wastagePct = 10;
    assert.notEqual(kg(), k0, 'wastage is inlined somewhere');
    CODE.wastagePct = saved.w;

    CODE.unitWeight = function (d) { return d * d / 100; };
    assert.notEqual(kg(), k0, 'unit weight is inlined somewhere');
  } finally {
    CODE.hook.u180 = saved.u180;
    CODE.bendDeduction[90] = saved.b90;
    CODE.wastagePct = saved.w;
    CODE.unitWeight = saved.uw;
  }
  assert.equal(len(), l0, 'CODE was not restored');
});

/* --- the external-input seam ---------------------------------------- */
test('adoptExternalMembers marks every field unverified and changes no number', function () {
  const raw = acceptanceJob().members;
  const adopted = adoptExternalMembers(raw, 'drawing-ocr');

  assert.equal(adopted[0].provenance.id.verified, false);
  assert.equal(adopted[0].provenance.concrete.widthMm.verified, false);
  assert.equal(adopted[0].provenance.bars[0].dia.verified, false);
  assert.equal(adopted[0].provenance.concrete.spanMm.source, 'drawing-ocr');
  assert.equal(raw[0].provenance, undefined, 'the input array is not mutated');

  const plain = generate({ members: raw });
  const seamed = generate({ members: adopted });
  assert.equal(mark(seamed, 'B1-01').cuttingLengthMm, mark(plain, 'B1-01').cuttingLengthMm);
  assert.equal(seamed.summary.grossKg.toFixed(4), plain.summary.grossKg.toFixed(4));
  assert.equal(seamed.members[0].unverifiedFields > 0, true, 'viewer can see there is something to confirm');
});

/* --- purity --------------------------------------------------------- */
test('the engine is pure — no DOM, no window, no mutation of the job', function () {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  const job = acceptanceJob();
  const snapshot = JSON.stringify(job);
  generate(job);
  assert.equal(JSON.stringify(job), snapshot, 'generate() mutated its input');
});
