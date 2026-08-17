'use strict';

/* =====================================================================
   DESIGN ENGINE — what a section can carry, and what it needs.

   Pure logic. No DOM, no window, no third-party code, requireable in
   Node, inlined verbatim into bbs.html by tools/inline.js.

   This is the module that turns the tool from a quantity tool into a
   checking tool, so three rules bind harder here than anywhere else:

     1. No verdict without the numbers. Every check reports demand,
        capacity and the ratio between them. Never a bare "OK".
     2. Every capacity carries its term-by-term derivation string.
     3. A code precondition that does not hold is REFUSED and named.
        Nothing is quietly used outside the range it was written for.

   Units: mm and mm² for the section, kN and kNm for forces, N/mm² for
   stresses. Every reported number states its unit.

   On numeric literals: every design value lives in IS456 and is read
   from IS456 at call time. Literals surviving in the calculation path
   are arithmetic — a half, a square, 100 for a percentage, 1e6 to turn
   N·mm into kNm — not values anyone would want to tune.

   On the ds* helper names: once inlined, every module in bbs.html
   shares one global scope. src/loads.js already owns `num`, `rnd` and
   `tally`, and a second declaration of a `const` there is a
   SyntaxError at load. These are the same helpers under names that do
   not clash, and test/loads.test.js fails if any module reuses a name.
   ===================================================================== */

/* ---------------------------------------------------------------------
   IS456 — the single home for every design constant. Clause numbers
   are on every entry, because a constant without its clause cannot be
   checked by the engineer who has to sign the drawing.
   ------------------------------------------------------------------- */
const IS456 = {
  /* ---- limiting neutral axis depth, xu,max / d — cl 38.1 ---------- */
  xuMaxOverD: { 250: 0.53, 415: 0.48, 500: 0.46 },

  /* ---- limiting moment of resistance, × fck·b·d² — cl 38.1 --------
     The singly-reinforced ceiling. Above it a section needs
     compression steel. */
  muLimFactor: { 250: 0.148, 415: 0.138, 500: 0.133 },

  /* ---- the stress block — cl 38.1 ---------------------------------
     Compression C = concreteStressFactor · fck · b · xu, acting at a
     lever arm of d − leverArmFactor · xu. */
  concreteStressFactor: 0.36,
  leverArmFactor: 0.42,

  /* ---- design stress in steel — cl 38.1 ---------------------------
     fy / γm with γm = 1.15 for steel, i.e. 0.87 fy. Applies to a bar
     in TENSION, and to a bar in compression only where the strain at
     that bar is enough to reach it — see doublyReinforced below. */
  steelStressFactor: 0.87,

  /* ---- modulus of elasticity of steel — cl 5.6.3 ------------------ */
  esNPerMm2: 200000,

  /* ---- flexural steel limits — cl 26.5.1.1 ------------------------ */
  minFlexuralSteel: { factor: 0.85, note: 'As/bd = 0.85/fy — cl 26.5.1.1' },
  maxFlexuralSteel: { factor: 0.04, note: '0.04 bD — cl 26.5.1.1' },

  /* ---- design shear strength of concrete — Table 19 ----------------
     The real table, over steel percentage and concrete grade. It is
     interpolated linearly over pt at call time; no interpolated result
     is written down here.

     The first row is the "≤ 0.15" row and the last the "3.00 and
     above" row, so pt outside the table is held at the end value
     rather than extrapolated — and the result says which happened.
     ---------------------------------------------------------------- */
  tauC: {
    clause: 'IS 456 Table 19',
    pt:  [0.15, 0.25, 0.50, 0.75, 1.00, 1.25, 1.50, 1.75, 2.00, 2.25, 2.50, 2.75, 3.00],
    fck: [15, 20, 25, 30, 35, 40],
    value: [
      /* pt ≤ 0.15 */ [0.28, 0.28, 0.29, 0.29, 0.29, 0.30],
      /*      0.25 */ [0.35, 0.36, 0.36, 0.37, 0.37, 0.38],
      /*      0.50 */ [0.46, 0.48, 0.49, 0.50, 0.50, 0.51],
      /*      0.75 */ [0.54, 0.56, 0.57, 0.59, 0.59, 0.60],
      /*      1.00 */ [0.60, 0.62, 0.64, 0.66, 0.67, 0.68],
      /*      1.25 */ [0.64, 0.67, 0.70, 0.71, 0.73, 0.74],
      /*      1.50 */ [0.68, 0.72, 0.74, 0.76, 0.78, 0.79],
      /*      1.75 */ [0.71, 0.75, 0.78, 0.80, 0.82, 0.84],
      /*      2.00 */ [0.71, 0.79, 0.82, 0.84, 0.86, 0.88],
      /*      2.25 */ [0.71, 0.81, 0.85, 0.88, 0.90, 0.92],
      /*      2.50 */ [0.71, 0.82, 0.88, 0.91, 0.93, 0.95],
      /*      2.75 */ [0.71, 0.82, 0.90, 0.94, 0.96, 0.98],
      /* ≥    3.00 */ [0.71, 0.82, 0.92, 0.96, 0.99, 1.01]
    ]
  },

  /* ---- maximum shear stress in concrete, τc,max — Table 20 --------
     Above this no stirrup arrangement is permitted: the section itself
     has to grow. Detailing is refused, not attempted. */
  tauCMax: { 15: 2.5, 20: 2.8, 25: 3.1, 30: 3.5, 35: 3.7, 40: 4.0 },

  /* ---- shear reinforcement ---------------------------------------- */
  /* minimum, Asv/(b·sv) ≥ 0.4/(0.87 fy) — cl 26.5.1.6 */
  minShearSteelFactor: 0.4,
  /* maximum spacing, the lesser of these — cl 26.5.1.5 */
  stirrupSpacing: { depthFactor: 0.75, maxMm: 300 },

  /* ---- bond, τbd for plain bars in tension — cl 26.2.1.1 ---------- */
  tauBd: {
    clause: 'IS 456 cl 26.2.1.1',
    plainInTension: { 15: 1.0, 20: 1.2, 25: 1.4, 30: 1.5, 35: 1.7, 40: 1.9 },
    deformedFactor: 1.6,      // × the above, for deformed bars
    compressionFactor: 1.25   // × the above again, for a bar in compression
  },

  /* ---- design forces without a solver — cl 22.5, Tables 12 and 13 -
     Coefficients for continuous beams and one-way slabs. They apply
     ONLY where the preconditions below hold, and continuousBeamForces
     refuses rather than using them anyway.

     Moment = coefficient × total design load on the span × effective
     span. Shear = coefficient × total design load on the span. The
     dead-load row also covers imposed load that is fixed in place; the
     moving row is for imposed load free to be anywhere.
     ---------------------------------------------------------------- */
  continuous: {
    clause: 'IS 456 cl 22.5.1, Tables 12 and 13',
    minSpans: 3,
    maxSpanVariation: 0.15,   // of the longest span — cl 22.5.1
    moment: {
      /* Table 12 */
      dead:       { endSpanMiddle:  1 / 12, interiorSpanMiddle:  1 / 16,
                    firstInteriorSupport: -1 / 10, otherInteriorSupport: -1 / 12 },
      liveMoving: { endSpanMiddle:  1 / 10, interiorSpanMiddle:  1 / 12,
                    firstInteriorSupport: -1 / 9,  otherInteriorSupport: -1 / 9 }
    },
    shear: {
      /* Table 13 */
      dead:       { endSupport: 0.4,  firstInteriorOuter: 0.6, firstInteriorInner: 0.55,
                    otherInterior: 0.5 },
      liveMoving: { endSupport: 0.45, firstInteriorOuter: 0.6, firstInteriorInner: 0.6,
                    otherInterior: 0.6 }
    }
  },

  /* ---- a single simply supported span -----------------------------
     Statics, not code: wl²/8 and wl/2. Kept here so no divisor is
     written at a call site. */
  simpleSpan: { momentDenominator: 8, shearDenominator: 2 },

  /* ---- doubly reinforced sections — NOT IMPLEMENTED ---------------
     A section with Mu > Mu,lim needs compression steel, and sizing it
     needs two numbers this config does not have:

       fsc, the design stress in the compression steel. For cold-worked
         bars the strain at the compression steel, 0.0035(1 − d'/xu),
         does not reach the 0.87fy plateau, so fsc has to be read off
         the design stress-strain curve of IS 456 Fig 23, or off SP-16
         Table F which tabulates it against d'/d.
       the concrete design stress displaced by that steel, 0.67fck/γm.

     Neither is guessed. flexureDesign refuses the case and says this.
     Fe250 is not special-cased either: it would need the same second
     number.
     ---------------------------------------------------------------- */
  doublyReinforced: { implemented: false },

  /* ---- reporting --------------------------------------------------
     Not a code value. Where a demand/capacity ratio falls below this,
     the result is called over-provided rather than adequate, because
     over-provision is information the engineer wants and a bare pass
     hides it. */
  reporting: { overProvisionRatio: 0.85 },

  units: { nmmPerKNm: 1e6, nPerKN: 1000, percent: 100 }
};

/* ---------------------------------------------------------------------
   Derivation helpers — see the note in the header on the ds* names.
   ------------------------------------------------------------------- */
const DS_GLYPH = { minus: '−', times: '×', div: '÷', sq: '²', to: '→' };

function dsRnd(v, dp) {
  const p = Math.pow(10, dp === undefined ? 2 : dp);
  return Math.round(v * p) / p;
}
function dsNum(v, dp) {
  const p = dp === undefined ? 2 : dp;
  return dsRnd(v, p).toFixed(p);
}
/* a factor printed inside a note, trailing zeros trimmed */
function dsFac(v) { return String(dsRnd(v, 5)); }

function dsTally(terms, unit, dp) {
  const total = terms.reduce(function (s, t) { return s + t.v; }, 0);
  let s;
  if (terms.length === 1) {
    s = terms[0].note;
  } else {
    s = '';
    terms.forEach(function (t, i) {
      if (i === 0) s += dsNum(t.v, dp) + ' (' + t.note + ')';
      else s += ' ' + (t.v < 0 ? DS_GLYPH.minus : '+') + ' ' +
                dsNum(Math.abs(t.v), dp) + ' (' + t.note + ')';
    });
  }
  return { value: dsRnd(total, dp === undefined ? 2 : dp), exact: total, terms: terms,
           unit: unit, derivation: s + ' = ' + dsNum(total, dp) + ' ' + unit };
}

function dsRefuse(what, reason, extra) {
  return Object.assign({ refused: true, what: what, reason: reason }, extra || {});
}

/* a check the viewer can print without deciding anything itself:
   demand, capacity, the ratio, and never a bare verdict */
function dsCheck(o) {
  const ratio = o.capacity > 0 ? o.demand / o.capacity : Infinity;
  const over = ratio < IS456.reporting.overProvisionRatio;
  return {
    name: o.name,
    clause: o.clause,
    demand: dsRnd(o.demand, o.dp === undefined ? 1 : o.dp),
    capacity: dsRnd(o.capacity, o.dp === undefined ? 1 : o.dp),
    unit: o.unit,
    ratio: dsRnd(ratio, 2),
    adequate: ratio <= 1,
    provision: ratio > 1 ? 'inadequate' : (over ? 'over-provided' : 'adequate'),
    provisionFactor: o.demand > 0 ? dsRnd(o.capacity / o.demand, 2) : null,
    /* the required shape: demand, capacity, ratio — e.g.
       "Mu 60.0 kNm / Mu,cap 124.0 kNm = 0.48" */
    statement: o.demandLabel + ' ' + dsNum(o.demand, o.dp === undefined ? 1 : o.dp) + ' ' + o.unit +
               ' / ' + o.capacityLabel + ' ' + dsNum(o.capacity, o.dp === undefined ? 1 : o.dp) +
               ' ' + o.unit + ' = ' + dsNum(ratio, 2),
    derivation: o.derivation
  };
}

function dsGrade(fy) {
  return IS456.xuMaxOverD[fy] !== undefined && IS456.muLimFactor[fy] !== undefined;
}
function dsGradeRefusal(what, fy) {
  return dsRefuse(what, 'Steel grade Fe' + fy + ' is not in IS456 (' +
    Object.keys(IS456.xuMaxOverD).map(function (k) { return 'Fe' + k; }).join(', ') +
    '). xu,max/d and the Mu,lim factor are both grade-specific — cl 38.1 — so neither is ' +
    'interpolated for a grade the code does not tabulate.');
}

/* ---------------------------------------------------------------------
   SECTION — the effective depth, derived rather than assumed.
   ------------------------------------------------------------------- */
function effectiveDepth(spec) {
  const s = spec || {};
  const need = ['widthMm', 'overallDepthMm', 'coverMm', 'barDia'];
  const missing = need.filter(function (k) { return !(s[k] > 0); });
  if (missing.length) {
    return dsRefuse('effective depth', 'A section needs ' + missing.join(', ') +
      '. The effective depth is derived from the cover and the bars, never assumed.');
  }
  const st = s.stirrupDia || 0;
  const d = s.overallDepthMm - s.coverMm - st - s.barDia / 2;
  if (d <= 0) {
    return dsRefuse('effective depth', 'Cover and bars use up the whole ' + s.overallDepthMm +
      ' mm depth; there is no effective depth left.');
  }
  return {
    refused: false,
    dMm: dsRnd(d, 2),
    bMm: s.widthMm,
    overallDepthMm: s.overallDepthMm,
    derivation: dsFac(s.overallDepthMm) + ' overall ' + DS_GLYPH.minus + ' ' + dsFac(s.coverMm) +
                ' cover ' + DS_GLYPH.minus + ' ' + dsFac(st) + ' stirrup ' + DS_GLYPH.minus + ' ' +
                dsFac(s.barDia / 2) + ' (half of ' + dsFac(s.barDia) + ' main) = ' +
                dsNum(d, 1) + ' mm'
  };
}

/* ---------------------------------------------------------------------
   FLEXURE — Mu,lim, then either the steel a moment needs or the moment
   a given steel can carry.
   ------------------------------------------------------------------- */
function muLim(spec) {
  const s = spec || {};
  if (!dsGrade(s.fy)) return dsGradeRefusal('Mu,lim', s.fy);
  const sec = s.dMm ? { refused: false, dMm: s.dMm, bMm: s.widthMm } : effectiveDepth(s);
  if (sec.refused) return sec;
  const k = IS456.muLimFactor[s.fy];
  const nmm = k * s.fck * sec.bMm * sec.dMm * sec.dMm;
  const kNm = nmm / IS456.units.nmmPerKNm;
  return {
    refused: false,
    kNm: dsRnd(kNm, 2),
    exact: kNm,
    dMm: sec.dMm,
    derivation: dsFac(k) + ' ' + DS_GLYPH.times + ' ' + dsFac(s.fck) + ' ' + DS_GLYPH.times + ' ' +
                dsFac(sec.bMm) + ' ' + DS_GLYPH.times + ' ' + dsNum(sec.dMm, 0) + DS_GLYPH.sq +
                ' = ' + dsNum(kNm, 1) + ' kNm  [Fe' + s.fy + ', cl 38.1]'
  };
}

/* given a moment, find the steel */
function flexureDesign(spec) {
  const s = spec || {};
  if (!(s.MuKNm >= 0)) {
    return dsRefuse('flexural steel', 'No design moment was given. flexureDesign needs MuKNm.');
  }
  if (!dsGrade(s.fy)) return dsGradeRefusal('flexural steel', s.fy);
  const sec = effectiveDepth(s);
  if (sec.refused) return sec;
  const b = sec.bMm, d = sec.dMm, D = sec.overallDepthMm;
  const lim = muLim({ fy: s.fy, fck: s.fck, widthMm: b, dMm: d });
  if (lim.refused) return lim;

  const fs = IS456.steelStressFactor * s.fy;
  const notes = [];

  if (s.MuKNm > lim.exact) {
    return dsRefuse('flexural steel',
      'Mu ' + dsNum(s.MuKNm, 1) + ' kNm exceeds Mu,lim ' + dsNum(lim.exact, 1) + ' kNm (' +
      lim.derivation + '), so the section needs compression steel. Sizing it needs two numbers ' +
      'IS456 does not hold: fsc, the design stress in the compression steel, which for a ' +
      'cold-worked bar has to come off the IS 456 Fig 23 stress-strain curve or SP-16 Table F ' +
      'against d\'/d; and 0.67fck/γm, the concrete stress that steel displaces. Neither is ' +
      'guessed. Enlarge the section, or add both to IS456.doublyReinforced.',
      { muLimKNm: lim.kNm, muLimDerivation: lim.derivation, needsCompressionSteel: true });
  }

  /* Mu = 0.87 fy · Ast · (d − 0.42 · xu),  xu = 0.87 fy · Ast / (0.36 fck b)
     so Mu = fs·Ast·d − k·fs·Ast² with k = 0.42 · fs / (0.36 fck b) */
  const k = IS456.leverArmFactor * fs / (IS456.concreteStressFactor * s.fck * b);
  const A = k * fs, B = -fs * d, C = s.MuKNm * IS456.units.nmmPerKNm;
  const disc = B * B - 4 * A * C;
  if (disc < 0) {
    return dsRefuse('flexural steel', 'No real steel area satisfies Mu = ' + dsNum(s.MuKNm, 1) +
      ' kNm on this section, although it is under Mu,lim — check b, d, fck and fy.');
  }
  const ast = (-B - Math.sqrt(disc)) / (2 * A);
  const xu = fs * ast / (IS456.concreteStressFactor * s.fck * b);
  const xuMax = IS456.xuMaxOverD[s.fy] * d;

  const astMin = IS456.minFlexuralSteel.factor * b * d / s.fy;
  const astMax = IS456.maxFlexuralSteel.factor * b * D;
  const governing = Math.max(ast, astMin);
  const governedBy = astMin > ast ? 'minimum steel' : 'flexure';
  if (governedBy === 'minimum steel') {
    notes.push('Ast,min governs: ' + dsNum(astMin, 1) + ' mm² against ' + dsNum(ast, 1) +
      ' mm² needed for the moment.');
  }
  const overMax = governing > astMax;
  if (overMax) {
    notes.push('OVER-REINFORCED: ' + dsNum(governing, 1) + ' mm² exceeds the ' +
      dsNum(astMax, 1) + ' mm² ceiling of ' + IS456.maxFlexuralSteel.note +
      '. The section is too small; the steel has NOT been reduced to fit.');
  }

  return {
    refused: false,
    MuKNm: dsRnd(s.MuKNm, 2),
    dMm: d,
    muLimKNm: lim.kNm,
    singlyReinforced: true,
    astRequiredMm2: dsRnd(ast, 1),
    astMinMm2: dsRnd(astMin, 1),
    astMaxMm2: dsRnd(astMax, 1),
    astGoverningMm2: dsRnd(governing, 1),
    governedBy: governedBy,
    overReinforced: overMax,
    xuMm: dsRnd(xu, 1),
    xuMaxMm: dsRnd(xuMax, 1),
    derivation: {
      effectiveDepth: sec.derivation,
      muLim: lim.derivation + ' ' + DS_GLYPH.to + ' singly reinforced',
      ast: dsNum(C, 0) + ' = ' + dsFac(fs) + DS_GLYPH.times + 'Ast' + DS_GLYPH.times + '(' +
           dsNum(d, 0) + ' ' + DS_GLYPH.minus + ' ' + dsFac(k) + DS_GLYPH.times + 'Ast) ' +
           DS_GLYPH.to + ' Ast = ' + dsNum(ast, 1) + ' mm²',
      astMin: dsFac(IS456.minFlexuralSteel.factor) + ' ' + DS_GLYPH.times + ' ' + dsFac(b) + ' ' +
              DS_GLYPH.times + ' ' + dsNum(d, 0) + ' ' + DS_GLYPH.div + ' ' + dsFac(s.fy) + ' = ' +
              dsNum(astMin, 1) + ' mm²  [cl 26.5.1.1]',
      astMax: dsFac(IS456.maxFlexuralSteel.factor) + ' ' + DS_GLYPH.times + ' ' + dsFac(b) + ' ' +
              DS_GLYPH.times + ' ' + dsFac(D) + ' = ' + dsNum(astMax, 1) + ' mm²  [cl 26.5.1.1]'
    },
    notes: notes
  };
}

/* given the steel, find the moment */
function flexureCapacity(spec) {
  const s = spec || {};
  if (!(s.astMm2 > 0)) {
    return dsRefuse('moment capacity', 'No tension steel was given. flexureCapacity needs astMm2.');
  }
  if (!dsGrade(s.fy)) return dsGradeRefusal('moment capacity', s.fy);
  if (s.ascMm2 > 0 && !IS456.doublyReinforced.implemented) {
    return dsRefuse('moment capacity',
      'Compression steel was given (' + dsNum(s.ascMm2, 1) + ' mm²) and its contribution is not ' +
      'computed. fsc, the design stress in a compression bar, comes off the IS 456 Fig 23 ' +
      'stress-strain curve or SP-16 Table F against d\'/d, and IS456 does not hold either. ' +
      'Leave ascMm2 out to get the singly-reinforced capacity, which is the safe side of the ' +
      'answer, or add the curve to IS456.doublyReinforced.');
  }
  const sec = effectiveDepth(s);
  if (sec.refused) return sec;
  const b = sec.bMm, d = sec.dMm, D = sec.overallDepthMm;
  const fs = IS456.steelStressFactor * s.fy;
  const notes = [];

  const xu = fs * s.astMm2 / (IS456.concreteStressFactor * s.fck * b);
  const xuMax = IS456.xuMaxOverD[s.fy] * d;
  const under = xu <= xuMax;

  const xuDerivation = dsFac(IS456.steelStressFactor) + ' ' + DS_GLYPH.times + ' ' + dsFac(s.fy) +
    ' ' + DS_GLYPH.times + ' ' + dsNum(s.astMm2, 1) + ' ' + DS_GLYPH.div + ' (' +
    dsFac(IS456.concreteStressFactor) + ' ' + DS_GLYPH.times + ' ' + dsFac(s.fck) + ' ' +
    DS_GLYPH.times + ' ' + dsFac(b) + ') = ' + dsNum(xu, 1) + ' mm';
  const xuMaxDerivation = dsFac(IS456.xuMaxOverD[s.fy]) + ' ' + DS_GLYPH.times + ' ' +
    dsNum(d, 0) + ' = ' + dsNum(xuMax, 1) + ' mm  [Fe' + s.fy + ', cl 38.1]';

  let kNm, capDerivation, limited = false;
  if (under) {
    const lever = d - IS456.leverArmFactor * xu;
    const nmm = fs * s.astMm2 * lever;
    kNm = nmm / IS456.units.nmmPerKNm;
    capDerivation = dsFac(fs) + ' ' + DS_GLYPH.times + ' ' + dsNum(s.astMm2, 1) + ' ' +
      DS_GLYPH.times + ' (' + dsNum(d, 0) + ' ' + DS_GLYPH.minus + ' ' +
      dsFac(IS456.leverArmFactor) + DS_GLYPH.times + dsNum(xu, 1) + ') = ' + dsNum(kNm, 1) + ' kNm';
  } else {
    /* xu > xu,max: the concrete crushes before the steel yields, which
       cl 38.1 does not permit. The usable moment is capped at Mu,lim
       and the excess tension steel does nothing — both are reported. */
    const lim = muLim({ fy: s.fy, fck: s.fck, widthMm: b, dMm: d });
    if (lim.refused) return lim;
    kNm = lim.exact;
    limited = true;
    capDerivation = lim.derivation + '  [capped: xu ' + dsNum(xu, 1) + ' > xu,max ' +
      dsNum(xuMax, 1) + ' mm]';
    notes.push('OVER-REINFORCED: xu ' + dsNum(xu, 1) + ' mm exceeds xu,max ' + dsNum(xuMax, 1) +
      ' mm, which cl 38.1 does not permit — the section would fail in compression without the ' +
      'steel yielding. The capacity shown is Mu,lim; the steel beyond the balanced area adds ' +
      'nothing and the section needs to be deepened, not reinforced further.');
  }

  const astMax = IS456.maxFlexuralSteel.factor * b * D;
  if (s.astMm2 > astMax) {
    notes.push('Ast ' + dsNum(s.astMm2, 1) + ' mm² exceeds the ' + dsNum(astMax, 1) +
      ' mm² ceiling of ' + IS456.maxFlexuralSteel.note + '.');
  }
  const astMin = IS456.minFlexuralSteel.factor * b * d / s.fy;
  if (s.astMm2 < astMin) {
    notes.push('Ast ' + dsNum(s.astMm2, 1) + ' mm² is below the ' + dsNum(astMin, 1) +
      ' mm² minimum of ' + IS456.minFlexuralSteel.note + '.');
  }

  return {
    refused: false,
    muCapKNm: dsRnd(kNm, 2),
    exact: kNm,
    dMm: d,
    astMm2: dsRnd(s.astMm2, 1),
    ptPercent: dsRnd(IS456.units.percent * s.astMm2 / (b * d), 4),
    xuMm: dsRnd(xu, 1),
    xuMaxMm: dsRnd(xuMax, 1),
    underReinforced: under,
    cappedAtMuLim: limited,
    astMinMm2: dsRnd(astMin, 1),
    astMaxMm2: dsRnd(astMax, 1),
    derivation: {
      effectiveDepth: sec.derivation,
      xu: xuDerivation,
      xuMax: xuMaxDerivation + (under ? ' ' + DS_GLYPH.to + ' under-reinforced' : ''),
      capacity: capDerivation
    },
    notes: notes
  };
}

/* ---------------------------------------------------------------------
   SHEAR
   ------------------------------------------------------------------- */
/* Table 19, interpolated linearly over pt at the given grade */
function tauCFor(ptPercent, fck) {
  const T = IS456.tauC;
  const col = T.fck.indexOf(fck);
  if (col < 0) {
    return dsRefuse('τc', 'Table 19 tabulates M' + T.fck.join(', M') + '. M' + fck +
      ' is not one of them, and the table gives no rule for interpolating between concrete ' +
      'grades, so none is invented. Use a tabulated grade for the shear check.');
  }
  if (!(ptPercent >= 0)) {
    return dsRefuse('τc', 'A steel percentage is needed to read Table 19.');
  }
  const rows = T.pt, vals = T.value;
  const last = rows.length - 1;
  let value, derivation, held = null;

  if (ptPercent <= rows[0]) {
    value = vals[0][col];
    held = 'low';
    derivation = 'τc = ' + dsNum(value, 2) + ' N/mm²  [Table 19, M' + fck + ', pt ' +
      dsNum(ptPercent, 3) + '% at or below the ' + dsFac(rows[0]) + '% row]';
  } else if (ptPercent >= rows[last]) {
    value = vals[last][col];
    held = 'high';
    derivation = 'τc = ' + dsNum(value, 2) + ' N/mm²  [Table 19, M' + fck + ', pt ' +
      dsNum(ptPercent, 3) + '% at or above the ' + dsFac(rows[last]) + '% row]';
  } else {
    let i = 0;
    while (i < last && rows[i + 1] < ptPercent) i++;
    const p0 = rows[i], p1 = rows[i + 1], v0 = vals[i][col], v1 = vals[i + 1][col];
    const f = (ptPercent - p0) / (p1 - p0);
    value = v0 + f * (v1 - v0);
    derivation = 'τc = ' + dsNum(v0, 2) + ' + (' + dsNum(ptPercent, 3) + ' ' + DS_GLYPH.minus +
      ' ' + dsFac(p0) + ')' + DS_GLYPH.div + '(' + dsFac(p1) + ' ' + DS_GLYPH.minus + ' ' +
      dsFac(p0) + ') ' + DS_GLYPH.times + ' (' + dsNum(v1, 2) + ' ' + DS_GLYPH.minus + ' ' +
      dsNum(v0, 2) + ') = ' + dsNum(value, 3) + ' N/mm²  [Table 19, M' + fck +
      ', interpolated at pt = ' + dsNum(ptPercent, 3) + '%]';
  }
  return { refused: false, value: dsRnd(value, 4), exact: value, held: held,
           clause: T.clause, derivation: derivation };
}

function shearDesign(spec) {
  const s = spec || {};
  if (!(s.VuKN >= 0)) {
    return dsRefuse('shear', 'No design shear was given. shearDesign needs VuKN.');
  }
  if (!(s.astMm2 > 0)) {
    return dsRefuse('shear', 'Table 19 reads against the tension steel at the section, so ' +
      'astMm2 is needed. Without it τc cannot be looked up.');
  }
  if (!dsGrade(s.fy)) return dsGradeRefusal('shear', s.fy);
  const sec = s.dMm ? { refused: false, dMm: s.dMm, bMm: s.widthMm } : effectiveDepth(s);
  if (sec.refused) return sec;
  const b = sec.bMm, d = sec.dMm;
  const fyv = s.fyStirrup !== undefined ? s.fyStirrup : s.fy;
  const notes = [];

  /* nominal shear stress — cl 40.1 */
  const tauV = s.VuKN * IS456.units.nPerKN / (b * d);
  const tauVDerivation = dsFac(s.VuKN * IS456.units.nPerKN) + ' ' + DS_GLYPH.div + ' (' +
    dsFac(b) + ' ' + DS_GLYPH.times + ' ' + dsNum(d, 0) + ') = ' + dsNum(tauV, 3) + ' N/mm²';

  /* the ceiling first: above τc,max no stirrup arrangement is allowed */
  const tauMax = IS456.tauCMax[s.fck];
  if (tauMax === undefined) {
    return dsRefuse('shear', 'Table 20 gives τc,max for M' +
      Object.keys(IS456.tauCMax).join(', M') + '. M' + s.fck + ' is not one of them.');
  }
  if (tauV > tauMax) {
    return dsRefuse('shear',
      'τv ' + dsNum(tauV, 3) + ' N/mm² exceeds τc,max ' + dsNum(tauMax, 2) + ' N/mm² for M' +
      s.fck + ' (Table 20). No arrangement of stirrups is permitted at this stress — the ' +
      'section has to be enlarged or the grade raised. Shear reinforcement has NOT been ' +
      'detailed for it.',
      { tauVNPerMm2: dsRnd(tauV, 3), tauCMaxNPerMm2: tauMax, tauVDerivation: tauVDerivation,
        sectionMustGrow: true });
  }

  /* concrete's share — Table 19 against the steel percentage */
  const pt = IS456.units.percent * s.astMm2 / (b * d);
  const tc = tauCFor(pt, s.fck);
  if (tc.refused) return tc;
  const vcKN = tc.exact * b * d / IS456.units.nPerKN;

  /* what the stirrups must carry, and the minimum that must be there
     whether they carry anything or not — cl 40.4 and cl 26.5.1.6 */
  const fsv = IS456.steelStressFactor * fyv;
  const minRatio = IS456.minShearSteelFactor * b / fsv;      // Asv/sv, mm²/mm
  const minDerivation = dsFac(IS456.minShearSteelFactor) + ' ' + DS_GLYPH.times + ' ' + dsFac(b) +
    ' ' + DS_GLYPH.div + ' (' + dsFac(IS456.steelStressFactor) + ' ' + DS_GLYPH.times + ' ' +
    dsFac(fyv) + ') = ' + dsNum(minRatio, 3) + ' mm²/mm  [cl 26.5.1.6]';

  let strengthRatio = 0, strengthDerivation, vusKN = 0;
  if (tauV <= tc.exact) {
    strengthDerivation = 'τv ' + dsNum(tauV, 3) + ' < τc ' + dsNum(tc.exact, 3) +
      ' N/mm² — strength needs no stirrups; the minimum governs.';
  } else {
    vusKN = s.VuKN - vcKN;
    strengthRatio = vusKN * IS456.units.nPerKN / (fsv * d);
    strengthDerivation = 'Vus = ' + dsNum(s.VuKN, 1) + ' ' + DS_GLYPH.minus + ' ' +
      dsNum(vcKN, 1) + ' = ' + dsNum(vusKN, 1) + ' kN, Asv/sv = ' +
      dsFac(vusKN * IS456.units.nPerKN) + ' ' + DS_GLYPH.div + ' (' + dsFac(fsv) + ' ' +
      DS_GLYPH.times + ' ' + dsNum(d, 0) + ') = ' + dsNum(strengthRatio, 3) +
      ' mm²/mm  [cl 40.4]';
  }
  const requiredRatio = Math.max(minRatio, strengthRatio);
  const governedBy = strengthRatio > minRatio ? 'strength' : 'minimum steel';

  /* the spacing cap — cl 26.5.1.5 */
  const byDepth = IS456.stirrupSpacing.depthFactor * d;
  const spacingCap = Math.min(byDepth, IS456.stirrupSpacing.maxMm);
  const capDerivation = 'lesser of ' + dsFac(IS456.stirrupSpacing.depthFactor) + 'd = ' +
    dsNum(byDepth, 1) + ' mm and ' + dsFac(IS456.stirrupSpacing.maxMm) + ' mm = ' +
    dsNum(spacingCap, 0) + ' mm  [cl 26.5.1.5]';

  const out = {
    refused: false,
    dMm: d,
    tauVNPerMm2: dsRnd(tauV, 3),
    tauCNPerMm2: dsRnd(tc.exact, 3),
    tauCMaxNPerMm2: tauMax,
    ptPercent: dsRnd(pt, 3),
    concreteShearKN: dsRnd(vcKN, 2),
    vusKN: dsRnd(vusKN, 2),
    requiredAsvPerSv: dsRnd(requiredRatio, 4),
    minimumAsvPerSv: dsRnd(minRatio, 4),
    strengthAsvPerSv: dsRnd(strengthRatio, 4),
    governedBy: governedBy,
    stirrupsNeededForStrength: tauV > tc.exact,
    spacingCapMm: dsRnd(spacingCap, 1),
    derivation: {
      tauV: tauVDerivation,
      tauC: tc.derivation,
      minimum: minDerivation,
      strength: strengthDerivation,
      spacingCap: capDerivation
    },
    notes: notes
  };
  if (tc.held === 'high') {
    notes.push('pt ' + dsNum(pt, 3) + '% is at or past the end of Table 19; τc is held at the ' +
      'table\'s last row rather than extrapolated.');
  }

  /* a proposed stirrup: what spacing does the required ratio allow? */
  if (s.stirrup && s.stirrup.dia > 0) {
    const legs = s.stirrup.legs || 2;
    const asv = legs * Math.PI / 4 * s.stirrup.dia * s.stirrup.dia;
    const bySteel = asv / requiredRatio;
    const sv = Math.min(bySteel, spacingCap);
    out.stirrup = {
      dia: s.stirrup.dia, legs: legs,
      asvMm2: dsRnd(asv, 1),
      spacingFromSteelMm: dsRnd(bySteel, 1),
      spacingRequiredMm: dsRnd(sv, 1),
      governedBy: bySteel > spacingCap ? 'spacing cap' : 'steel required',
      derivation: legs + ' legs ' + DS_GLYPH.times + ' ' + s.stirrup.dia + ' mm = ' +
        dsNum(asv, 1) + ' mm², Asv/sv required ' + dsNum(requiredRatio, 3) + ' mm²/mm ' +
        DS_GLYPH.to + ' sv ≤ ' + dsNum(bySteel, 0) + ' mm, capped at ' +
        dsNum(spacingCap, 0) + ' mm ' + DS_GLYPH.to + ' ' + dsNum(sv, 0) + ' mm'
    };

    /* and if a spacing was actually provided, what does it carry? */
    if (s.stirrup.spacingMm > 0) {
      const svProv = s.stirrup.spacingMm;
      const vusProv = fsv * asv * d / svProv / IS456.units.nPerKN;
      const capKN = vcKN + vusProv;
      out.stirrup.providedSpacingMm = svProv;
      out.stirrup.providedAsvPerSv = dsRnd(asv / svProv, 4);
      out.stirrup.capacityKN = dsRnd(capKN, 2);
      out.stirrup.check = dsCheck({
        name: 'Shear', clause: 'IS 456 cl 40',
        demandLabel: 'Vu', capacityLabel: 'Vu,cap',
        demand: s.VuKN, capacity: capKN, unit: 'kN', dp: 1,
        derivation: 'Vc = ' + dsNum(tc.exact, 3) + ' ' + DS_GLYPH.times + ' ' + dsFac(b) + ' ' +
          DS_GLYPH.times + ' ' + dsNum(d, 0) + ' = ' + dsNum(vcKN, 1) + ' kN, Vus = ' +
          dsFac(fsv) + ' ' + DS_GLYPH.times + ' ' + dsNum(asv, 1) + ' ' + DS_GLYPH.times + ' ' +
          dsNum(d, 0) + ' ' + DS_GLYPH.div + ' ' + dsFac(svProv) + ' = ' + dsNum(vusProv, 1) +
          ' kN, total ' + dsNum(capKN, 1) + ' kN'
      });
      if (svProv > spacingCap) {
        notes.push('The ' + svProv + ' mm spacing provided exceeds the ' + dsNum(spacingCap, 0) +
          ' mm cap of cl 26.5.1.5. The spacing you gave has been used.');
      }
      if (asv / svProv < minRatio) {
        notes.push('The ' + svProv + ' mm spacing provided gives Asv/sv ' +
          dsNum(asv / svProv, 3) + ' mm²/mm, below the ' + dsNum(minRatio, 3) +
          ' mm²/mm minimum of cl 26.5.1.6.');
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------------------
   BOND — development length, cl 26.2.1
   ------------------------------------------------------------------- */
function developmentLength(spec) {
  const s = spec || {};
  const T = IS456.tauBd;
  const base = T.plainInTension[s.fck];
  if (base === undefined) {
    return dsRefuse('development length', 'cl 26.2.1.1 tabulates τbd for M' +
      Object.keys(T.plainInTension).join(', M') + '. M' + s.fck + ' is not one of them.');
  }
  if (!(s.barDia > 0) || !(s.fy > 0)) {
    return dsRefuse('development length', 'A bar diameter and a steel grade are needed.');
  }
  const deformed = s.deformed === undefined ? true : s.deformed;
  const compression = s.inCompression === true;
  let tbd = base, note = 'τbd ' + dsFac(base);
  if (deformed) { tbd *= T.deformedFactor; note += ' ' + DS_GLYPH.times + ' ' +
                                                   dsFac(T.deformedFactor) + ' deformed'; }
  if (compression) { tbd *= T.compressionFactor; note += ' ' + DS_GLYPH.times + ' ' +
                                                         dsFac(T.compressionFactor) +
                                                         ' compression'; }
  const sigma = IS456.steelStressFactor * s.fy;
  const ld = s.barDia * sigma / (4 * tbd);
  return {
    refused: false,
    ldMm: dsRnd(ld, 1),
    ldOverDia: dsRnd(ld / s.barDia, 2),
    tauBdNPerMm2: dsRnd(tbd, 3),
    derivation: dsFac(s.barDia) + ' ' + DS_GLYPH.times + ' ' + dsFac(sigma) + ' ' +
      DS_GLYPH.div + ' (4 ' + DS_GLYPH.times + ' ' + dsNum(tbd, 2) + ') = ' + dsNum(ld, 0) +
      ' mm = ' + dsNum(ld / s.barDia, 1) + 'φ  [' + note + ', ' + T.clause + ']'
  };
}

/* ---------------------------------------------------------------------
   DESIGN FORCES WITHOUT A SOLVER

   A simply supported span is statics. A continuous run uses the cl 22.5
   coefficients, and only where cl 22.5.1's preconditions hold — which
   is checked, and refused when it does not.
   ------------------------------------------------------------------- */
function simpleSpanForces(spec) {
  const s = spec || {};
  if (!(s.spanMm > 0) || !(s.wKNPerM >= 0)) {
    return dsRefuse('design forces', 'A simply supported span needs spanMm and wKNPerM.');
  }
  const L = s.spanMm / 1000;
  const md = IS456.simpleSpan.momentDenominator, sd = IS456.simpleSpan.shearDenominator;
  const M = s.wKNPerM * L * L / md;
  const V = s.wKNPerM * L / sd;
  return {
    refused: false,
    support: 'simply supported',
    spanM: dsRnd(L, 3),
    MuKNm: dsRnd(M, 2),
    VuKN: dsRnd(V, 2),
    derivation: {
      moment: dsFac(s.wKNPerM) + ' ' + DS_GLYPH.times + ' ' + dsFac(L) + DS_GLYPH.sq + ' ' +
              DS_GLYPH.div + ' ' + md + ' = ' + dsNum(M, 1) + ' kNm',
      shear: dsFac(s.wKNPerM) + ' ' + DS_GLYPH.times + ' ' + dsFac(L) + ' ' + DS_GLYPH.div + ' ' +
             sd + ' = ' + dsNum(V, 1) + ' kN'
    }
  };
}

function continuousBeamForces(spec) {
  const s = spec || {};
  const C = IS456.continuous;
  const spans = (s.spansMm || []).slice();
  if (!spans.length || spans.some(function (x) { return !(x > 0); })) {
    return dsRefuse('design forces', 'continuousBeamForces needs spansMm, one entry per span.');
  }
  if (!(s.deadKNPerM >= 0)) {
    return dsRefuse('design forces', 'The factored dead load per metre is needed. Keep dead and ' +
      'imposed apart: Table 12 gives them different coefficients.');
  }
  const live = s.liveKNPerM || 0;
  const fixed = s.liveFixed === true;

  /* --- cl 22.5.1's preconditions, checked before the table is opened --- */
  const failures = [];
  if (spans.length < C.minSpans) {
    failures.push('cl 22.5.1 applies to ' + C.minSpans + ' or more spans; this run has ' +
      spans.length + '.');
  }
  const longest = Math.max.apply(null, spans), shortest = Math.min.apply(null, spans);
  const variation = (longest - shortest) / longest;
  if (variation > C.maxSpanVariation) {
    failures.push('The spans differ by ' +
      dsNum(variation * IS456.units.percent, 1) + '% of the longest (' + dsFac(shortest) +
      ' to ' + dsFac(longest) + ' mm), over the ' +
      dsNum(C.maxSpanVariation * IS456.units.percent, 0) + '% cl 22.5.1 allows.');
  }
  if (s.uniformLoad === false) {
    failures.push('cl 22.5.1 applies to substantially uniformly distributed loads, and the ' +
      'caller has said this load is not one.');
  }
  if (s.uniformSection === false) {
    failures.push('cl 22.5.1 applies to beams of uniform cross-section, and the caller has said ' +
      'this run is not.');
  }
  if (failures.length) {
    return dsRefuse('design forces',
      'The IS 456 cl 22.5 coefficients do not apply here, so they have not been used. ' +
      failures.join(' ') + ' Analyse the run instead — the coefficients are not a fallback.',
      { preconditionFailures: failures, clause: C.clause });
  }

  /* --- Tables 12 and 13 --- */
  const wDead = s.deadKNPerM, wLive = live;
  /* fixed imposed load rides on the dead-load row of both tables */
  const deadPart = fixed ? wDead + wLive : wDead;
  const movingPart = fixed ? 0 : wLive;

  function at(kind, key, spanMm) {
    const L = spanMm / 1000;
    const cd = C[kind].dead[key], cm = C[kind].liveMoving[key];
    if (cd === undefined || cm === undefined) return null;
    /* W is the total design load on the span; moment also × L */
    const wD = deadPart * L, wM = movingPart * L;
    const scale = kind === 'moment' ? L : 1;
    const terms = [];
    if (wD) terms.push({ v: cd * wD * scale,
                         note: dsFac(cd) + ' ' + DS_GLYPH.times + ' ' + dsNum(wD, 1) + ' kN' +
                               (kind === 'moment' ? ' ' + DS_GLYPH.times + ' ' + dsFac(L) + ' m' : '') +
                               (fixed ? ' dead + fixed imposed' : ' dead') });
    if (wM) terms.push({ v: cm * wM * scale,
                         note: dsFac(cm) + ' ' + DS_GLYPH.times + ' ' + dsNum(wM, 1) +
                               ' kN' + (kind === 'moment' ? ' ' + DS_GLYPH.times + ' ' +
                               dsFac(L) + ' m' : '') + ' imposed, free to move' });
    if (!terms.length) terms.push({ v: 0, note: 'no load' });
    const t = dsTally(terms, kind === 'moment' ? 'kNm' : 'kN', 2);
    return { location: key, spanM: dsRnd(L, 3), value: t.value, exact: t.exact,
             coefficients: { dead: cd, liveMoving: cm },
             derivation: t.derivation + '  [' + C.clause + ']' };
  }

  const moments = [], shears = [];
  spans.forEach(function (spanMm, i) {
    const isEnd = i === 0 || i === spans.length - 1;
    const mKey = isEnd ? 'endSpanMiddle' : 'interiorSpanMiddle';
    const m = at('moment', mKey, spanMm);
    m.span = i;
    moments.push(m);
  });
  /* support moments: the support next to an end support, then the rest */
  for (let i = 1; i < spans.length; i++) {
    const adjacentToEnd = i === 1 || i === spans.length - 1;
    const key = adjacentToEnd ? 'firstInteriorSupport' : 'otherInteriorSupport';
    /* the coefficient applies to the larger of the two adjoining spans */
    const spanMm = Math.max(spans[i - 1], spans[i]);
    const m = at('moment', key, spanMm);
    m.support = i;
    moments.push(m);
  }
  spans.forEach(function (spanMm, i) {
    if (i === 0) { const v = at('shear', 'endSupport', spanMm); v.support = 0; shears.push(v); }
    const rightIsEnd = i === spans.length - 1;
    if (rightIsEnd) {
      const v = at('shear', 'endSupport', spanMm); v.support = spans.length; shears.push(v);
    }
  });
  for (let i = 1; i < spans.length; i++) {
    const adjacentToEnd = i === 1 || i === spans.length - 1;
    const outer = at('shear', adjacentToEnd ? 'firstInteriorOuter' : 'otherInterior',
                     spans[i - 1]);
    const inner = at('shear', adjacentToEnd ? 'firstInteriorInner' : 'otherInterior', spans[i]);
    outer.support = i; outer.side = 'outer';
    inner.support = i; inner.side = 'inner';
    shears.push(outer, inner);
  }

  const maxSag = moments.filter(function (m) { return m.exact > 0; })
                        .reduce(function (a, m) { return m.exact > a.exact ? m : a; },
                                { exact: 0, value: 0 });
  const maxHog = moments.filter(function (m) { return m.exact < 0; })
                        .reduce(function (a, m) { return m.exact < a.exact ? m : a; },
                                { exact: 0, value: 0 });
  const maxShear = shears.reduce(function (a, v) {
    return Math.abs(v.exact) > Math.abs(a.exact) ? v : a; }, { exact: 0, value: 0 });

  return {
    refused: false,
    support: 'continuous',
    clause: C.clause,
    spans: spans.map(function (x) { return dsRnd(x / 1000, 3); }),
    spanVariation: dsRnd(variation, 4),
    liveFixed: fixed,
    moments: moments,
    shears: shears,
    envelope: {
      maxSagKNm: maxSag.value, maxSagAt: maxSag.location || null,
      maxHogKNm: maxHog.value, maxHogAt: maxHog.location || null,
      maxShearKN: maxShear.value, maxShearAt: maxShear.location || null
    },
    notes: ['Table 12 and 13 coefficients, not an analysis. cl 22.5.1\'s preconditions were ' +
            'checked and hold: ' + spans.length + ' spans, varying ' +
            dsNum(variation * IS456.units.percent, 1) + '% of the longest.']
  };
}

/* ---------------------------------------------------------------------
   THE WHOLE BEAM — demand, capacity and the ratio, per check.

   This is the function a viewer calls. It reports what the section can
   do against what it is asked to do, and reports over-provision as
   loudly as under-provision, because a designer wants to know both.
   ------------------------------------------------------------------- */
function beamCheck(spec) {
  const s = spec || {};
  const forces = s.forces || (s.wKNPerM !== undefined
    ? simpleSpanForces({ spanMm: s.spanMm, wKNPerM: s.wKNPerM })
    : null);
  if (!forces) {
    return dsRefuse('beam check', 'No design forces. Give either forces: { MuKNm, VuKN } or a ' +
      'factored wKNPerM with a spanMm.');
  }
  if (forces.refused) return forces;

  const MuKNm = forces.MuKNm, VuKN = forces.VuKN;
  const astProvided = s.astMm2 !== undefined ? s.astMm2
    : (s.bars ? s.bars.reduce(function (a, x) {
        return a + x.count * Math.PI / 4 * x.dia * x.dia; }, 0) : 0);

  const out = { refused: false, forces: forces, checks: [], notes: [], refusals: [] };

  /* required steel */
  const req = flexureDesign({ MuKNm: MuKNm, widthMm: s.widthMm,
    overallDepthMm: s.overallDepthMm, coverMm: s.coverMm, stirrupDia: s.stirrupDia,
    barDia: s.barDia, fck: s.fck, fy: s.fy });
  if (req.refused) out.refusals.push(req); else out.required = req;

  /* provided capacity, and the ratio between them */
  if (astProvided > 0) {
    const cap = flexureCapacity({ astMm2: astProvided, widthMm: s.widthMm,
      overallDepthMm: s.overallDepthMm, coverMm: s.coverMm, stirrupDia: s.stirrupDia,
      barDia: s.barDia, fck: s.fck, fy: s.fy });
    if (cap.refused) { out.refusals.push(cap); }
    else {
      out.provided = cap;
      out.checks.push(dsCheck({
        name: 'Flexure', clause: 'IS 456 cl 38.1',
        demandLabel: 'Mu', capacityLabel: 'Mu,cap',
        demand: MuKNm, capacity: cap.exact, unit: 'kNm', dp: 1,
        derivation: cap.derivation.capacity
      }));
      cap.notes.forEach(function (n) { out.notes.push(n); });
      if (req.refused === false) {
        out.steel = {
          requiredMm2: req.astGoverningMm2,
          providedMm2: dsRnd(astProvided, 1),
          ratio: dsRnd(req.astGoverningMm2 > 0 ? astProvided / req.astGoverningMm2 : 0, 2),
          governedBy: req.governedBy,
          statement: 'Ast required ' + dsNum(req.astGoverningMm2, 1) + ' mm² / provided ' +
                     dsNum(astProvided, 1) + ' mm² = ' +
                     dsNum(astProvided / req.astGoverningMm2, 2) + DS_GLYPH.times
        };
      }
    }

    const shear = shearDesign({ VuKN: VuKN, astMm2: astProvided, widthMm: s.widthMm,
      overallDepthMm: s.overallDepthMm, coverMm: s.coverMm, stirrupDia: s.stirrupDia,
      barDia: s.barDia, fck: s.fck, fy: s.fy, fyStirrup: s.fyStirrup, stirrup: s.stirrup });
    if (shear.refused) out.refusals.push(shear);
    else {
      out.shear = shear;
      if (shear.stirrup && shear.stirrup.check) out.checks.push(shear.stirrup.check);
      shear.notes.forEach(function (n) { out.notes.push(n); });
    }
  } else {
    out.notes.push('No steel was given, so only the requirement is reported, not a capacity or ' +
      'a ratio.');
  }

  if (s.barDia > 0 && s.fck) {
    const ld = developmentLength({ barDia: s.barDia, fy: s.fy, fck: s.fck });
    if (!ld.refused) out.developmentLength = ld; else out.refusals.push(ld);
  }

  out.summary = out.checks.map(function (c) { return c.statement; }).join('   |   ');
  return out;
}

/* ------------------------------------------------------------------- */
const DESIGN = {
  IS456: IS456,
  effectiveDepth: effectiveDepth,
  muLim: muLim,
  flexureDesign: flexureDesign,
  flexureCapacity: flexureCapacity,
  tauCFor: tauCFor,
  shearDesign: shearDesign,
  developmentLength: developmentLength,
  simpleSpanForces: simpleSpanForces,
  continuousBeamForces: continuousBeamForces,
  beamCheck: beamCheck,
  helpers: { rnd: dsRnd, num: dsNum, tally: dsTally, check: dsCheck }
};

if (typeof module !== 'undefined' && module.exports) module.exports = DESIGN;
