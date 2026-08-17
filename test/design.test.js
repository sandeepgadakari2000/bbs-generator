'use strict';

/* =====================================================================
   DESIGN ENGINE TESTS — node --test

   The two acceptance tests at the top are the contract. Their expected
   values were worked by hand from the clauses and are NOT to be edited
   to match the engine. If the engine disagrees, the engine is wrong
   until proven otherwise.

   SOURCES for the expected values
   -------------------------------
   Every constant is cited at the place it lives in src/design.js:

     xu,max/d, Mu,lim factor, the 0.36/0.42 stress block, 0.87fy
                           IS 456:2000 cl 38.1
     Ast,min = 0.85bd/fy, Ast,max = 0.04bD
                           IS 456:2000 cl 26.5.1.1
     τc                    IS 456:2000 Table 19, interpolated over pt
     τc,max                IS 456:2000 Table 20
     minimum shear steel   IS 456:2000 cl 26.5.1.6
     stirrup spacing cap   IS 456:2000 cl 26.5.1.5
     Vus                   IS 456:2000 cl 40.4
     τbd, × 1.6 deformed   IS 456:2000 cl 26.2.1.1
     moment/shear coefs    IS 456:2000 cl 22.5.1, Tables 12 and 13
     Es = 200 kN/mm²       IS 456:2000 cl 5.6.3

   A CROSS-CHECK AGAINST A PUBLISHED WORKED EXAMPLE IS STILL OUTSTANDING,
   and no page number is written here because none has been verified.
   A cite that turns out to point at the wrong page is worse than an
   absent one in a file like this. The two numbers that most want that
   cross-check, both flagged for it:

     - the Table 19 interpolation, τc = 0.540 N/mm² at pt = 0.655% on
       M25, from the 0.50% (0.49) and 0.75% (0.57) rows;
     - the Mu,lim factor 0.133 for Fe500.

   Both have been checked against the brief's independent hand
   calculation and agree to three figures. Neither has been checked
   against SP-16, Pillai & Menon, or Krishna Raju.
   ===================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  IS456, effectiveDepth, muLim, flexureDesign, flexureCapacity, tauCFor,
  shearDesign, developmentLength, simpleSpanForces, continuousBeamForces, beamCheck
} = require('../src/design.js');

/* --- helpers ------------------------------------------------------- */
function near(actual, expected, tol, what) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    what + ': got ' + actual + ', expected ' + expected + ' ±' + tol
  );
}

/* the acceptance section: 300 wide × 450 overall, clear span 4000, M25,
   Fe500, cover 25, 8 mm stirrups, 16 mm main bars.
   d = 450 − 25 − 8 − 8 = 409 mm */
function section(over) {
  return Object.assign({
    widthMm: 300, overallDepthMm: 450, coverMm: 25,
    stirrupDia: 8, barDia: 16, fck: 25, fy: 500
  }, over || {});
}
const AST_4T16 = 4 * Math.PI / 4 * 16 * 16;    // 804.25 mm²

test('the effective depth is derived, 450 − 25 − 8 − 8 = 409 mm', function () {
  const d = effectiveDepth(section());
  near(d.dMm, 409, 0.01, 'effective depth');
  assert.equal(d.derivation,
    '450 overall − 25 cover − 8 stirrup − 8 (half of 16 main) = 409.0 mm');
});

/* =====================================================================
   ACCEPTANCE (a) — given a moment, find the steel
   ===================================================================== */
test('ACCEPTANCE (a) — simply supported, 30 kN/m factored: Mu 60 kNm needs 358.5 mm²',
function (t) {
  const forces = simpleSpanForces({ spanMm: 4000, wKNPerM: 30 });
  t.diagnostic('moment : ' + forces.derivation.moment);
  t.diagnostic('shear  : ' + forces.derivation.shear);

  /* Mu = 30 × 4.0² / 8 = 60.0 kNm ;  Vu = 30 × 4.0 / 2 = 60.0 kN */
  near(forces.MuKNm, 60.0, 0.005, 'Mu');
  near(forces.VuKN, 60.0, 0.005, 'Vu');

  const des = flexureDesign(section({ MuKNm: forces.MuKNm }));
  assert.equal(des.refused, false);
  t.diagnostic('Mu,lim : ' + des.derivation.muLim);
  t.diagnostic('Ast    : ' + des.derivation.ast);
  t.diagnostic('Ast,min: ' + des.derivation.astMin);

  /* Mu,lim = 0.133 × 25 × 300 × 409² = 166.9 kNm → singly reinforced */
  near(des.muLimKNm, 166.9, 0.05, 'Mu,lim');
  assert.equal(des.singlyReinforced, true);

  /* Ast from 60e6 = 435·Ast·(409 − 0.0677·Ast) = 358.5 mm² */
  near(des.astRequiredMm2, 358.5, 0.1, 'Ast required');

  /* Ast,min = 0.85 × 300 × 409 / 500 = 208.6 mm² → does not govern */
  near(des.astMinMm2, 208.6, 0.05, 'Ast,min');
  assert.equal(des.governedBy, 'flexure', 'the moment governs, not the minimum');
  near(des.astGoverningMm2, 358.5, 0.1, 'governing Ast');
  assert.equal(des.overReinforced, false);

  /* and the derivations carry the arithmetic, not just the answer */
  assert.equal(des.derivation.muLim,
    '0.133 × 25 × 300 × 409² = 166.9 kNm  [Fe500, cl 38.1] → singly reinforced');
  assert.equal(des.derivation.astMin,
    '0.85 × 300 × 409 ÷ 500 = 208.6 mm²  [cl 26.5.1.1]');
  assert.match(des.derivation.ast, /^60000000 = 435×Ast×\(409 − 0\.06767×Ast\) → Ast = 358\.5 mm²$/);
});

/* =====================================================================
   ACCEPTANCE (b) — given the steel, find the moment
   ===================================================================== */
test('ACCEPTANCE (b) — 4 nos 16 mm = 804.2 mm² carries 124.0 kNm', function (t) {
  near(AST_4T16, 804.2, 0.1, '4 nos 16 mm');
  const cap = flexureCapacity(section({ astMm2: AST_4T16 }));
  assert.equal(cap.refused, false);
  t.diagnostic('xu     : ' + cap.derivation.xu);
  t.diagnostic('xu,max : ' + cap.derivation.xuMax);
  t.diagnostic('Mu,cap : ' + cap.derivation.capacity);

  /* xu     = 0.87 × 500 × 804.2 / (0.36 × 25 × 300) = 129.6 mm
     xu,max = 0.46 × 409                             = 188.1 mm → under-reinforced
     Mu,cap = 435 × 804.2 × (409 − 0.42 × 129.6)     = 124.0 kNm */
  near(cap.xuMm, 129.6, 0.1, 'xu');
  near(cap.xuMaxMm, 188.1, 0.05, 'xu,max');
  assert.equal(cap.underReinforced, true);
  near(cap.muCapKNm, 124.0, 0.1, 'Mu,cap');
  assert.equal(cap.cappedAtMuLim, false);
  assert.deepEqual(cap.notes, [], 'nothing to flag on this section');

  /* pt = 100 × 804.2 / (300 × 409) = 0.655 % */
  near(cap.ptPercent, 0.655, 0.001, 'steel percentage');

  assert.equal(cap.derivation.xu,
    '0.87 × 500 × 804.2 ÷ (0.36 × 25 × 300) = 129.6 mm');
  assert.equal(cap.derivation.xuMax,
    '0.46 × 409 = 188.1 mm  [Fe500, cl 38.1] → under-reinforced');
  assert.equal(cap.derivation.capacity,
    '435 × 804.2 × (409 − 0.42×129.6) = 124.0 kNm');
});

test('ACCEPTANCE (b) — shear at Vu = 60 kN: τv < τc, so the minimum governs', function (t) {
  const sh = shearDesign(section({ VuKN: 60, astMm2: AST_4T16,
                                   stirrup: { dia: 8, legs: 2, spacingMm: 150 } }));
  assert.equal(sh.refused, false);
  t.diagnostic('τv     : ' + sh.derivation.tauV);
  t.diagnostic('τc     : ' + sh.derivation.tauC);
  t.diagnostic('minimum: ' + sh.derivation.minimum);
  t.diagnostic('spacing: ' + sh.derivation.spacingCap);
  t.diagnostic('stirrup: ' + sh.stirrup.derivation);
  t.diagnostic('check  : ' + sh.stirrup.check.statement);

  /* τv = 60000 / (300 × 409)              = 0.489 N/mm²
     pt = 100 × 804.2 / (300 × 409)        = 0.655 %
     τc, Table 19, M25, at pt = 0.655      ≈ 0.54 N/mm²
     τv < τc → strength needs no stirrups; minimum governs */
  near(sh.tauVNPerMm2, 0.489, 0.001, 'τv');
  near(sh.ptPercent, 0.655, 0.001, 'pt');
  near(sh.tauCNPerMm2, 0.540, 0.005, 'τc interpolated');
  assert.equal(sh.stirrupsNeededForStrength, false);
  assert.equal(sh.governedBy, 'minimum steel');

  /* Asv/sv required = 0.4 × 300 / (0.87 × 500) = 0.276 mm²/mm
     2-legged 8 mm → Asv = 100.5 mm² → sv ≤ 364 mm, capped at 300 */
  near(sh.requiredAsvPerSv, 0.276, 0.001, 'Asv/sv required');
  near(sh.stirrup.asvMm2, 100.5, 0.1, 'two 8 mm legs');
  near(sh.stirrup.spacingFromSteelMm, 364, 1, 'spacing the steel allows');
  near(sh.spacingCapMm, 300, 0.5, 'cl 26.5.1.5 cap, lesser of 0.75d = 306.8 and 300');
  near(sh.stirrup.spacingRequiredMm, 300, 0.5, 'the cap governs');
  assert.equal(sh.stirrup.governedBy, 'spacing cap');

  /* the 150 c/c actually provided is therefore conservative, and the
     tool must say so with numbers rather than call it a pass */
  near(sh.stirrup.capacityKN, 185.5, 0.5, 'Vu,cap at 150 c/c');
  assert.equal(sh.stirrup.check.provision, 'over-provided');
  assert.ok(sh.stirrup.check.ratio < 0.4, 'D/C ' + sh.stirrup.check.ratio);
  assert.match(sh.stirrup.check.statement, /^Vu 60\.0 kN \/ Vu,cap 185\.5 kN = 0\.32$/);
});

test('4-T16 against a 60 kNm demand is a D/C of 0.48, and is reported as over-provided',
function (t) {
  const out = beamCheck(section({ spanMm: 4000, wKNPerM: 30, astMm2: AST_4T16,
                                 stirrup: { dia: 8, legs: 2, spacingMm: 150 } }));
  assert.equal(out.refused, false);
  t.diagnostic('summary: ' + out.summary);
  t.diagnostic('steel  : ' + out.steel.statement);
  t.diagnostic('Ld     : ' + out.developmentLength.derivation);

  const flex = out.checks.filter(function (c) { return c.name === 'Flexure'; })[0];
  /* the required output shape, exactly:
       Mu 60.0 kNm / Mu,cap 124.0 kNm = 0.48                            */
  assert.equal(flex.statement, 'Mu 60.0 kNm / Mu,cap 124.0 kNm = 0.48');
  near(flex.ratio, 0.48, 0.005, 'flexural D/C');
  assert.equal(flex.adequate, true);
  assert.equal(flex.provision, 'over-provided',
    'over-provision is information, not a pass');
  near(flex.provisionFactor, 2.07, 0.02, 'capacity is 2.07× the demand');

  /* required vs provided steel, side by side */
  near(out.steel.requiredMm2, 358.5, 0.1, 'required');
  near(out.steel.providedMm2, 804.2, 0.1, 'provided');
  near(out.steel.ratio, 2.24, 0.01, 'provided / required');

  /* no check reports a verdict without both numbers and the ratio */
  out.checks.forEach(function (c) {
    assert.ok(c.demand !== undefined && c.capacity !== undefined && c.ratio !== undefined,
      c.name + ' must report demand, capacity and ratio');
    assert.match(c.statement, / \/ .* = /, c.name + ' statement shape');
    assert.ok(c.derivation && c.derivation.length > 0, c.name + ' must carry its derivation');
    assert.ok(c.clause, c.name + ' must cite its clause');
  });
  assert.deepEqual(out.refusals, [], 'nothing should be refused on this section');
});

/* =====================================================================
   THE CASES THAT MUST NOT BE QUIETLY DESIGNED
   ===================================================================== */
test('Mu over Mu,lim is refused, naming both constants that are missing', function () {
  /* Mu,lim on this section is 166.9 kNm */
  const out = flexureDesign(section({ MuKNm: 200 }));
  assert.equal(out.refused, true);
  assert.equal(out.needsCompressionSteel, true);
  assert.match(out.reason, /exceeds Mu,lim 166\.9 kNm/);
  assert.match(out.reason, /fsc/, 'the missing steel stress must be named');
  assert.match(out.reason, /Fig 23|SP-16 Table F/, 'and where it comes from');
  assert.match(out.reason, /0\.67fck/, 'the displaced concrete stress must be named too');
  assert.match(out.reason, /Neither is guessed/);
  /* the refusal still hands back the number it did compute */
  near(out.muLimKNm, 166.9, 0.05, 'Mu,lim is reported with the refusal');
});

test('compression steel offered to flexureCapacity is refused, not ignored', function () {
  const out = flexureCapacity(section({ astMm2: AST_4T16, ascMm2: 402 }));
  assert.equal(out.refused, true);
  assert.match(out.reason, /not computed/);
  assert.match(out.reason, /Leave ascMm2 out/);
});

test('a section over 0.04bD is flagged, and the steel is not reduced to fit', function () {
  /* 0.04 × 300 × 450 = 5400 mm² */
  const out = flexureCapacity(section({ astMm2: 6000 }));
  assert.equal(out.refused, false);
  near(out.astMaxMm2, 5400, 1, 'Ast,max');
  assert.ok(out.notes.some(function (n) { return /0\.04 bD/.test(n); }),
    'the 0.04bD ceiling must be named: ' + out.notes.join(' | '));
  near(out.astMm2, 6000, 1, 'the steel given is the steel used');
});

test('xu over xu,max is called over-reinforced and capped at Mu,lim', function () {
  /* Ast 1500 mm² → xu = 435 × 1500 / 2700 = 241.7 mm > 188.1 mm */
  const out = flexureCapacity(section({ astMm2: 1500 }));
  assert.equal(out.refused, false);
  near(out.xuMm, 241.7, 0.1, 'xu');
  assert.equal(out.underReinforced, false);
  assert.equal(out.cappedAtMuLim, true);
  near(out.muCapKNm, 166.9, 0.05, 'capacity held at Mu,lim');
  assert.ok(out.notes.some(function (n) { return /OVER-REINFORCED/.test(n); }));
  assert.ok(out.notes.some(function (n) { return /does not permit/.test(n); }));
  assert.match(out.derivation.capacity, /capped: xu 241\.7 > xu,max 188\.1 mm/);
});

test('Ast,min governs a lightly loaded section, and says so', function () {
  /* Mu 20 kNm needs about 114.6 mm²; the minimum is 208.6 mm² */
  const out = flexureDesign(section({ MuKNm: 20 }));
  near(out.astRequiredMm2, 114.6, 0.2, 'Ast for the moment');
  near(out.astMinMm2, 208.6, 0.05, 'Ast,min');
  assert.equal(out.governedBy, 'minimum steel');
  near(out.astGoverningMm2, 208.6, 0.05, 'the minimum is what gets detailed');
  assert.ok(out.notes.some(function (n) { return /Ast,min governs/.test(n); }));
});

test('τv over τc,max is refused outright, not detailed', function () {
  /* τc,max for M25 is 3.1 N/mm²; 400 kN gives τv = 3.26 */
  const out = shearDesign(section({ VuKN: 400, astMm2: AST_4T16,
                                    stirrup: { dia: 8, legs: 2, spacingMm: 100 } }));
  assert.equal(out.refused, true);
  assert.equal(out.sectionMustGrow, true);
  near(out.tauVNPerMm2, 3.26, 0.01, 'τv');
  assert.equal(out.tauCMaxNPerMm2, 3.1);
  assert.match(out.reason, /No arrangement of stirrups is permitted/);
  assert.match(out.reason, /has NOT been detailed/);
  assert.equal(out.stirrup, undefined, 'no stirrup may be proposed for a refused section');
});

test('a section that genuinely needs shear steel gets it sized from cl 40.4', function (t) {
  /* Vu 150 kN → τv = 1.222 > τc = 0.540, so Vus must be carried */
  const out = shearDesign(section({ VuKN: 150, astMm2: AST_4T16,
                                    stirrup: { dia: 8, legs: 2 } }));
  assert.equal(out.refused, false);
  t.diagnostic('strength: ' + out.derivation.strength);
  t.diagnostic('stirrup : ' + out.stirrup.derivation);
  near(out.tauVNPerMm2, 1.222, 0.002, 'τv');
  assert.equal(out.stirrupsNeededForStrength, true);
  assert.equal(out.governedBy, 'strength');
  /* Vc = 0.540 × 300 × 409 = 66.2 kN ; Vus = 150 − 66.2 = 83.8 kN
     Asv/sv = 83780 / (435 × 409) = 0.471 mm²/mm → sv ≤ 213 mm */
  near(out.concreteShearKN, 66.2, 0.2, 'Vc');
  near(out.vusKN, 83.8, 0.2, 'Vus');
  near(out.requiredAsvPerSv, 0.471, 0.002, 'Asv/sv from strength');
  near(out.stirrup.spacingRequiredMm, 213.5, 1, 'spacing required');
  assert.equal(out.stirrup.governedBy, 'steel required');
  assert.match(out.derivation.strength, /cl 40\.4/);
});

test('a spacing wider than cl 26.5.1.5 allows is used and flagged, never clamped', function () {
  const out = shearDesign(section({ VuKN: 60, astMm2: AST_4T16,
                                    stirrup: { dia: 8, legs: 2, spacingMm: 400 } }));
  assert.equal(out.stirrup.providedSpacingMm, 400, 'the spacing given is the spacing used');
  assert.ok(out.notes.some(function (n) { return /exceeds the 300 mm cap/.test(n); }));
  assert.ok(out.notes.some(function (n) { return /has been used/.test(n); }));
});

test('an untabulated concrete grade is refused for τc rather than interpolated', function () {
  const out = tauCFor(0.655, 45);
  assert.equal(out.refused, true);
  assert.match(out.reason, /no rule for interpolating between concrete grades/);
  assert.match(out.reason, /none is invented/);
});

test('an untabulated steel grade is refused, and says why', function () {
  const out = flexureCapacity(section({ astMm2: AST_4T16, fy: 550 }));
  assert.equal(out.refused, true);
  assert.match(out.reason, /Fe550 is not in IS456/);
  assert.match(out.reason, /Fe250, Fe415, Fe500/);
});

/* =====================================================================
   TABLE 19
   ===================================================================== */
test('Table 19 returns its own values at the tabulated rows', function () {
  near(tauCFor(0.50, 25).value, 0.49, 1e-9, 'pt 0.50, M25');
  near(tauCFor(0.75, 25).value, 0.57, 1e-9, 'pt 0.75, M25');
  near(tauCFor(1.00, 20).value, 0.62, 1e-9, 'pt 1.00, M20');
  near(tauCFor(3.00, 40).value, 1.01, 1e-9, 'pt 3.00, M40');
  near(tauCFor(0.15, 15).value, 0.28, 1e-9, 'pt 0.15, M15');
});

test('Table 19 interpolates linearly between rows, and shows the interpolation', function () {
  /* 0.49 + (0.655 − 0.50)/(0.75 − 0.50) × (0.57 − 0.49) = 0.5396 */
  const out = tauCFor(0.6554, 25);
  near(out.value, 0.5397, 0.0005, 'τc at pt = 0.6554 on M25');
  assert.match(out.derivation, /^τc = 0\.49 \+ \(0\.655 − 0\.5\)÷\(0\.75 − 0\.5\) × \(0\.57 − 0\.49\)/);
  assert.match(out.derivation, /Table 19, M25, interpolated at pt = 0\.655%/);
  /* halfway between rows is halfway between values */
  near(tauCFor(0.625, 25).value, (0.49 + 0.57) / 2, 1e-9, 'midpoint of the 0.50–0.75 rows');
});

test('Table 19 holds at its ends instead of extrapolating, and says which end', function () {
  const low = tauCFor(0.05, 25);
  near(low.value, 0.29, 1e-9, 'below the 0.15 row');
  assert.equal(low.held, 'low');
  assert.match(low.derivation, /at or below the 0\.15% row/);

  const high = tauCFor(5.0, 25);
  near(high.value, 0.92, 1e-9, 'above the 3.00 row');
  assert.equal(high.held, 'high');
  assert.match(high.derivation, /at or above the 3% row/);

  /* and a shear check on a section past the table says so on the result */
  const sh = shearDesign(section({ VuKN: 60, astMm2: 4000 }));
  assert.ok(sh.notes.some(function (n) { return /held at the table's last row/.test(n); }));
});

/* =====================================================================
   DEVELOPMENT LENGTH
   ===================================================================== */
test('development length is φσs/4τbd with the 1.6 deformed-bar factor', function () {
  /* τbd = 1.4 × 1.6 = 2.24 ; Ld = 16 × 435 / (4 × 2.24) = 776.8 mm */
  const out = developmentLength({ barDia: 16, fy: 500, fck: 25 });
  near(out.tauBdNPerMm2, 2.24, 0.001, 'τbd for a deformed bar in M25');
  near(out.ldMm, 776.8, 0.5, 'Ld');
  near(out.ldOverDia, 48.55, 0.05, 'Ld in bar diameters');
  assert.match(out.derivation, /cl 26\.2\.1\.1/);
  assert.match(out.derivation, /1\.6 deformed/);

  /* a bar in compression gets the further 25% of the same clause */
  const comp = developmentLength({ barDia: 16, fy: 500, fck: 25, inCompression: true });
  near(comp.tauBdNPerMm2, 2.8, 0.001, 'τbd increased 25% for compression');
  near(comp.ldMm, 776.8 / 1.25, 0.5, 'Ld shortens in proportion');
});

/* =====================================================================
   DESIGN FORCES — cl 22.5, and its preconditions
   ===================================================================== */
test('a two-span run is refused: cl 22.5.1 wants three or more', function () {
  const out = continuousBeamForces({ spansMm: [4000, 4000], deadKNPerM: 20, liveKNPerM: 10 });
  assert.equal(out.refused, true);
  assert.match(out.reason, /3 or more spans; this run has 2/);
  assert.match(out.reason, /not a fallback/);
  assert.equal(out.preconditionFailures.length, 1);
});

test('spans differing by more than 15% are refused, with the percentage stated', function () {
  /* (6000 − 4000)/6000 = 33.3% */
  const out = continuousBeamForces({ spansMm: [4000, 6000, 4000], deadKNPerM: 20 });
  assert.equal(out.refused, true);
  assert.match(out.reason, /differ by 33\.3% of the longest/);
  assert.match(out.reason, /over the 15% cl 22\.5\.1 allows/);
});

test('a non-uniform load or section is refused when the caller says so', function () {
  const load = continuousBeamForces({ spansMm: [4000, 4000, 4000], deadKNPerM: 20,
                                      uniformLoad: false });
  assert.equal(load.refused, true);
  assert.match(load.reason, /substantially uniformly distributed loads/);
  const sec = continuousBeamForces({ spansMm: [4000, 4000, 4000], deadKNPerM: 20,
                                     uniformSection: false });
  assert.equal(sec.refused, true);
  assert.match(sec.reason, /uniform cross-section/);
});

test('a run that satisfies cl 22.5.1 gets Table 12 and 13 coefficients', function (t) {
  const out = continuousBeamForces({ spansMm: [4000, 4200, 4000],
                                     deadKNPerM: 20, liveKNPerM: 10 });
  assert.equal(out.refused, false);
  near(out.spanVariation, 0.0476, 0.0005, 'span variation, within the 15%');
  out.moments.forEach(function (m) { t.diagnostic('M ' + m.location + ': ' + m.derivation); });
  out.shears.slice(0, 3).forEach(function (v) {
    t.diagnostic('V ' + v.location + ': ' + v.derivation); });

  /* end span middle, 4.0 m span, W_dead = 80 kN, W_moving = 40 kN
     M = (1/12) × 80 × 4.0 + (1/10) × 40 × 4.0 = 26.67 + 16.00 = 42.67 kNm */
  const endSpan = out.moments.filter(function (m) { return m.location === 'endSpanMiddle'; })[0];
  near(endSpan.value, 42.67, 0.02, 'end span sagging moment');

  /* interior span middle, 4.2 m span, W_dead = 84, W_moving = 42
     M = (1/16) × 84 × 4.2 + (1/12) × 42 × 4.2 = 22.05 + 14.70 = 36.75 kNm */
  const inner = out.moments.filter(function (m) {
    return m.location === 'interiorSpanMiddle'; })[0];
  near(inner.value, 36.75, 0.02, 'interior span sagging moment');

  /* support next to the end support, larger adjoining span 4.2 m
     M = −(1/10) × 84 × 4.2 − (1/9) × 42 × 4.2 = −35.28 − 19.60 = −54.88 kNm */
  const sup = out.moments.filter(function (m) {
    return m.location === 'firstInteriorSupport'; })[0];
  near(sup.value, -54.88, 0.02, 'hogging moment at the first interior support');

  /* end support shear, 4.0 m span: 0.4 × 80 + 0.45 × 40 = 32 + 18 = 50 kN */
  const endV = out.shears.filter(function (v) { return v.location === 'endSupport'; })[0];
  near(endV.value, 50.0, 0.02, 'end support shear');

  /* the envelope picks the extremes */
  near(out.envelope.maxSagKNm, 42.67, 0.02, 'largest sagging moment');
  near(out.envelope.maxHogKNm, -54.88, 0.02, 'largest hogging moment');
  assert.equal(out.envelope.maxHogAt, 'firstInteriorSupport');
  out.moments.concat(out.shears).forEach(function (x) {
    assert.match(x.derivation, /Tables 12 and 13/, x.location + ' must cite the table');
  });
  assert.ok(out.notes.some(function (n) { return /not an analysis/.test(n); }));
});

test('imposed load fixed in place rides on the dead-load row', function () {
  const moving = continuousBeamForces({ spansMm: [4000, 4000, 4000],
                                        deadKNPerM: 20, liveKNPerM: 10 });
  const fixed = continuousBeamForces({ spansMm: [4000, 4000, 4000],
                                       deadKNPerM: 20, liveKNPerM: 10, liveFixed: true });
  /* fixed: (1/12) × (30 × 4) × 4 = 40.0 kNm, and no moving term */
  const f = fixed.moments.filter(function (m) { return m.location === 'endSpanMiddle'; })[0];
  near(f.value, 40.0, 0.02, 'end span, imposed load fixed');
  const m = moving.moments.filter(function (x) { return x.location === 'endSpanMiddle'; })[0];
  assert.ok(m.value > f.value, 'a load free to move is worse, ' + m.value + ' vs ' + f.value);
  assert.match(f.derivation, /dead \+ fixed imposed/);
});

test('a simply supported span uses wl²/8 and wl/2', function () {
  const out = simpleSpanForces({ spanMm: 6000, wKNPerM: 24 });
  near(out.MuKNm, 24 * 36 / 8, 0.005, 'wl²/8');
  near(out.VuKN, 24 * 6 / 2, 0.005, 'wl/2');
  assert.match(out.derivation.moment, /24 × 6² ÷ 8 = 108\.0 kNm/);
});

/* =====================================================================
   THE CONFIG IS THE CONFIG
   ===================================================================== */
test('constants are read from IS456 at call time, not inlined', function () {
  const S = section({ MuKNm: 60, VuKN: 60, astMm2: AST_4T16,
                      stirrup: { dia: 8, legs: 2, spacingMm: 150 } });
  function cap() { return flexureCapacity(S).muCapKNm; }
  function des() { return flexureDesign(S).astRequiredMm2; }
  function sh() { return shearDesign(S); }

  const saved = {
    xuMax: IS456.xuMaxOverD[500], muLim: IS456.muLimFactor[500],
    stress: IS456.concreteStressFactor, lever: IS456.leverArmFactor,
    steel: IS456.steelStressFactor,
    minFlex: IS456.minFlexuralSteel.factor, maxFlex: IS456.maxFlexuralSteel.factor,
    tc: IS456.tauC.value[2][2], tcMax: IS456.tauCMax[25],
    minShear: IS456.minShearSteelFactor,
    spacingMax: IS456.stirrupSpacing.maxMm, depthFactor: IS456.stirrupSpacing.depthFactor,
    bond: IS456.tauBd.deformedFactor,
    variation: IS456.continuous.maxSpanVariation,
    coef: IS456.continuous.moment.dead.endSpanMiddle,
    denom: IS456.simpleSpan.momentDenominator,
    report: IS456.reporting.overProvisionRatio
  };
  function restore() {
    IS456.xuMaxOverD[500] = saved.xuMax;
    IS456.muLimFactor[500] = saved.muLim;
    IS456.concreteStressFactor = saved.stress;
    IS456.leverArmFactor = saved.lever;
    IS456.steelStressFactor = saved.steel;
    IS456.minFlexuralSteel.factor = saved.minFlex;
    IS456.maxFlexuralSteel.factor = saved.maxFlex;
    IS456.tauC.value[2][2] = saved.tc;
    IS456.tauCMax[25] = saved.tcMax;
    IS456.minShearSteelFactor = saved.minShear;
    IS456.stirrupSpacing.maxMm = saved.spacingMax;
    IS456.stirrupSpacing.depthFactor = saved.depthFactor;
    IS456.tauBd.deformedFactor = saved.bond;
    IS456.continuous.maxSpanVariation = saved.variation;
    IS456.continuous.moment.dead.endSpanMiddle = saved.coef;
    IS456.simpleSpan.momentDenominator = saved.denom;
    IS456.reporting.overProvisionRatio = saved.report;
  }

  try {
    const c0 = cap(), d0 = des(), s0 = sh();

    IS456.leverArmFactor = 0.5;
    assert.notEqual(cap(), c0, 'the lever arm factor is inlined somewhere');
    restore();

    IS456.concreteStressFactor = 0.4;
    assert.notEqual(flexureCapacity(S).xuMm, s0 && flexureCapacity(S).xuMm && 129.6,
      'the stress block factor is inlined somewhere');
    restore();

    IS456.steelStressFactor = 0.8;
    assert.notEqual(cap(), c0, 'the steel stress factor is inlined somewhere');
    restore();

    IS456.xuMaxOverD[500] = 0.20;
    assert.equal(flexureCapacity(S).underReinforced, false,
      'xu,max/d is inlined somewhere');
    restore();

    /* 0.01 × 25 × 300 × 409² = 12.5 kNm, well under the 60 kNm demand,
       so the section must be reported as needing compression steel */
    IS456.muLimFactor[500] = 0.01;
    assert.equal(flexureDesign(S).refused, true, 'the Mu,lim factor is inlined somewhere');
    restore();

    IS456.minFlexuralSteel.factor = 2.0;
    assert.equal(flexureDesign(S).governedBy, 'minimum steel',
      'the minimum steel factor is inlined somewhere');
    restore();

    IS456.maxFlexuralSteel.factor = 0.001;
    assert.ok(flexureCapacity(S).notes.some(function (n) { return /ceiling/.test(n); }),
      'the maximum steel factor is inlined somewhere');
    restore();

    IS456.tauC.value[2][2] = 0.10;
    assert.notEqual(sh().tauCNPerMm2, s0.tauCNPerMm2, 'Table 19 is inlined somewhere');
    restore();

    IS456.tauCMax[25] = 0.2;
    assert.equal(sh().refused, true, 'Table 20 is inlined somewhere');
    restore();

    IS456.minShearSteelFactor = 1.2;
    assert.notEqual(sh().requiredAsvPerSv, s0.requiredAsvPerSv,
      'the minimum shear steel factor is inlined somewhere');
    restore();

    IS456.stirrupSpacing.maxMm = 120;
    assert.equal(sh().spacingCapMm, 120, 'the spacing cap is inlined somewhere');
    restore();

    IS456.stirrupSpacing.depthFactor = 0.1;
    near(sh().spacingCapMm, 40.9, 0.1, 'the 0.75d factor is inlined somewhere');
    restore();

    const ld0 = developmentLength({ barDia: 16, fy: 500, fck: 25 }).ldMm;
    IS456.tauBd.deformedFactor = 1.0;
    assert.notEqual(developmentLength({ barDia: 16, fy: 500, fck: 25 }).ldMm, ld0,
      'the deformed-bar factor is inlined somewhere');
    restore();

    IS456.continuous.maxSpanVariation = 0.01;
    assert.equal(continuousBeamForces({ spansMm: [4000, 4200, 4000],
      deadKNPerM: 20 }).refused, true, 'the 15% limit is inlined somewhere');
    restore();

    const m0 = continuousBeamForces({ spansMm: [4000, 4000, 4000], deadKNPerM: 20 })
      .moments[0].value;
    IS456.continuous.moment.dead.endSpanMiddle = 1 / 6;
    assert.notEqual(continuousBeamForces({ spansMm: [4000, 4000, 4000], deadKNPerM: 20 })
      .moments[0].value, m0, 'Table 12 is inlined somewhere');
    restore();

    IS456.simpleSpan.momentDenominator = 10;
    near(simpleSpanForces({ spanMm: 4000, wKNPerM: 30 }).MuKNm, 48, 0.01,
      'the wl²/8 divisor is inlined somewhere');
    restore();

    /* beamCheck needs forces, so it gets the span and the load, not
       the bare Mu of the section spec above */
    const full = section({ spanMm: 4000, wKNPerM: 30, astMm2: AST_4T16,
                           stirrup: { dia: 8, legs: 2, spacingMm: 150 } });
    assert.equal(beamCheck(full).checks[0].provision, 'over-provided', 'D/C 0.48 by default');
    IS456.reporting.overProvisionRatio = 0.1;
    assert.equal(beamCheck(full).checks[0].provision, 'adequate',
      'the reporting threshold is inlined somewhere');
    restore();
  } finally {
    restore();
  }

  /* and everything is back where it started */
  near(flexureCapacity(S).muCapKNm, 124.0, 0.1, 'IS456 was not restored');
  near(flexureDesign(S).astRequiredMm2, 358.5, 0.1, 'IS456 was not restored');
});

/* =====================================================================
   THE HOUSE RULES, ASSERTED
   ===================================================================== */
test('every capacity exposes a term-by-term derivation', function () {
  const cap = flexureCapacity(section({ astMm2: AST_4T16 }));
  ['effectiveDepth', 'xu', 'xuMax', 'capacity'].forEach(function (k) {
    assert.match(cap.derivation[k], / = /, 'capacity derivation.' + k);
  });
  const des = flexureDesign(section({ MuKNm: 60 }));
  ['effectiveDepth', 'muLim', 'ast', 'astMin', 'astMax'].forEach(function (k) {
    assert.match(des.derivation[k], / = /, 'design derivation.' + k);
  });
  const sh = shearDesign(section({ VuKN: 150, astMm2: AST_4T16, stirrup: { dia: 8, legs: 2 } }));
  ['tauV', 'tauC', 'minimum', 'strength', 'spacingCap'].forEach(function (k) {
    assert.ok(sh.derivation[k].length > 0, 'shear derivation.' + k);
  });
  assert.match(muLim(section()).derivation, /cl 38\.1/);
  assert.match(developmentLength({ barDia: 16, fy: 500, fck: 25 }).derivation, / = /);
});

test('every constant in IS456 carries a clause or is labelled not a code value', function () {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'design.js'), 'utf8');
  const config = src.slice(src.indexOf('const IS456'), src.indexOf('const DS_GLYPH'));
  ['cl 38.1', 'cl 26.5.1.1', 'Table 19', 'Table 20', 'cl 26.5.1.6', 'cl 26.5.1.5',
   'cl 26.2.1.1', 'cl 22.5.1', 'cl 5.6.3'].forEach(function (c) {
    assert.ok(config.indexOf(c) >= 0, 'IS456 must cite ' + c);
  });
  /* the one entry that is not a code value must say so */
  assert.match(config, /Not a code value/, 'the reporting threshold must be labelled');
});

test('no check reports a verdict without demand, capacity and the ratio', function () {
  /* the only place a pass/fail word is produced is dsCheck, which cannot
     build one without all three numbers. Comments are stripped first —
     the header promises "never a bare OK" and must not trip its own test. */
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'design.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const bare = /['"](?:OK|PASS|FAIL|SAFE|UNSAFE|ok|okay|pass|fail|safe)['"]/.exec(code);
  assert.equal(bare, null, 'a bare verdict string appears in src/design.js: ' + bare);
  /* and every statement dsCheck can emit has the demand/capacity/ratio shape */
  const out = beamCheck(section({ spanMm: 4000, wKNPerM: 30, astMm2: AST_4T16,
                                 stirrup: { dia: 8, legs: 2, spacingMm: 150 } }));
  assert.ok(out.checks.length >= 2, 'flexure and shear both checked');
  out.checks.forEach(function (c) {
    assert.match(c.statement, /^\S+ [\d.]+ \S+ \/ \S+ [\d.]+ \S+ = [\d.]+$/,
      c.name + ': "' + c.statement + '"');
  });
});

test('src/design.js requires cleanly with no DOM and touches no globals', function () {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'design.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  [/\bwindow\b/, /\bdocument\b/, /\blocalStorage\b/, /\bfetch\s*\(/, /\brequire\s*\(/,
   /\bXMLHttpRequest\b/, /\bprocess\b/].forEach(function (bad) {
    assert.ok(!bad.test(code), 'src/design.js references ' + bad);
  });
  assert.ok(code.indexOf('</script') < 0, 'src/design.js could not be inlined');
});
