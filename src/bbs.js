'use strict';

/* =====================================================================
   BBS ENGINE — bar bending schedule for Indian site practice.

   Pure logic. No DOM, no window, no third-party code, requireable in
   Node. The viewer (bbs.html) is built around this and never duplicates
   a calculation.

   Units: mm for detailing, m for schedule lengths, kg for weights.

   On numeric literals: every DETAILING value lives in CODE and is read
   from CODE at call time. Literals that survive in the calculation path
   are pure geometry with no detailing content — a rectangle has two
   pairs of sides, a diamond has four, a step is half of riser × tread,
   n bars leave n−1 gaps, π is π. Those are not constants anyone would
   want to tune, and hiding them in a config object would make the
   formulas unreadable.
   ===================================================================== */

/* ---------------------------------------------------------------------
   CODE — the single home for every detailing constant.
   ------------------------------------------------------------------- */
const CODE = {
  bendDeduction: { 45: 1, 90: 2, 135: 3 },              // × d, per bend
  hook:  { u180: 9, stirrup135: 10, minMm: 75 },        // × d, subject to minMm
  crank: { deg45: 0.42, deg30: 0.27 },                  // × D (clear distance between top and bottom bar centres)
  lap:   { tension: 50, compression: 40 },              // × d
  cover: { footing: 50, column: 40, beam: 25, slab: 20, lintel: 25, staircase: 20 },  // mm, nominal
  stockLengthMm: 12000,
  wastagePct: 3,
  barSizes: [6, 8, 10, 12, 16, 20, 25, 32],
  unitWeight: (d) => (d * d) / 162,                     // kg/m
  limits: {
    stirrupSpacingMaxMm: 300,
    stirrupSpacingDepthFactor: 0.75,                    // ≤ 0.75d for beams
    minBarClearMm: 25,
    steelRatioMin: 80,                                  // kg per m³ of concrete
    steelRatioMax: 200
  },

  /* ---- shape catalogue -------------------------------------------
     Bend sets per shape, so "3 × 2d + 2 × 3d" is never written at a
     call site. Angles index CODE.bendDeduction.
     Stirrup geometry follows the centre-line convention: the circular
     ring is measured on the bar centre-line, and the triangular apex
     is deducted as a 90° bend.
     Shape ids are internal. No BS 8666 conformance is claimed.
     ---------------------------------------------------------------- */
  shapes: {
    STRAIGHT:     { label: 'Straight',             bends: [] },
    L_BEND:       { label: 'L-bend',               bends: [] },
    CRANK:        { label: 'Cranked',              bends: [] },
    U_HOOK:       { label: 'U-hook',               bends: [] },
    STIRRUP_RECT: { label: 'Rectangular stirrup',  bends: [90, 90, 90, 135, 135], hooks: 2, hookKind: 'stirrup135' },
    STIRRUP_TRI:  { label: 'Triangular stirrup',   bends: [90, 90, 135, 135],     hooks: 2, hookKind: 'stirrup135' },
    STIRRUP_DIA:  { label: 'Diamond stirrup',      bends: [90, 90, 90, 135, 135], hooks: 2, hookKind: 'stirrup135' },
    STIRRUP_CIRC: { label: 'Circular ring',        bends: [135, 135],             hooks: 2, hookKind: 'stirrup135' }
  },

  /* ---- what each end condition contributes, per end ---------------- */
  ends: {
    continuous: { label: 'Continuous', hooks: 0, bends: [] },
    hook:       { label: 'U-hook',     hooks: 1, hookKind: 'u180', bends: [] },   // 9d is the net allowance
    bend:       { label: 'L-bend',     hooks: 0, bends: [90], leg: true },
    crank:      { label: 'Cranked',    hooks: 0, bends: [] }
  },

  /* ---- cranked bars ------------------------------------------------ */
  crankGeometry: {
    defaultCount: 2,
    angleKey: 'deg45',            // indexes CODE.crank
    bendsPerCrank: [45, 45]       // indexes CODE.bendDeduction
  },

  /* ---- structural bookkeeping -------------------------------------- */
  geometry: {
    coverFaces: 2,                // cover is deducted at both ends of a run
    barEnds: 2,
    endBarAllowance: 1            // the "+ 1" in count = ceil(run / spacing) + 1
  },

  /* ---- which members each check applies to ------------------------- */
  checks: {
    stirrupSpacingAppliesTo: ['beam', 'lintel'],
    congestionAppliesTo: ['beam', 'lintel', 'column'],
    lapZoneAppliesTo: ['beam', 'lintel', 'slabOneWay', 'slabTwoWay', 'staircase'],
    lapAvoidZone: { bottom: 'midSpan', top: 'support' }
  },

  /* ---- cage depiction ----------------------------------------------
     How the 3D cage is DRAWN. None of these touch a cutting length or a
     weight; they only decide how much of the cage is worth putting on
     screen. Kept here so nothing is buried at a call site.
     ------------------------------------------------------------------ */
  cage: {
    hookStandoffDia: 3,      // × d, how far a drawn hook stands off the bar
    circleSegments: 24,      // facets in a drawn circular tie
    maxRings: 60             // stirrups drawn per member before thinning
  },

  units: { mmPerM: 1000, mm3PerM3: 1e9, kgPerTonne: 1000, percent: 100 }
};

/* ---------------------------------------------------------------------
   Small helpers
   ------------------------------------------------------------------- */
const MINUS = '−';   // − true minus, to match the drawing convention
const TIMES = '×';   // ×

function round(v, n) { const p = Math.pow(10, n); return Math.round(v * p) / p; }
function fmt(v) {
  const x = round(v, 1);
  return Number.isInteger(x) ? String(x) : x.toFixed(1);
}
function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') {
    const o = {};
    Object.keys(v).forEach(function (k) { o[k] = clone(v[k]); });
    return o;
  }
  return v;
}

/* ---------------------------------------------------------------------
   ALLOWANCES — each returns a { mm, note } term
   ------------------------------------------------------------------- */
function hookTerm(kind, count, d) {
  const factor = CODE.hook[kind];
  const raw = factor * d;
  const each = Math.max(raw, CODE.hook.minMm);
  const governed = each > raw;
  return {
    mm: count * each,
    note: count + ' ' + TIMES + ' ' + factor + 'd hook @ ' + d +
          (governed ? ', min ' + CODE.hook.minMm : '')
  };
}

function bendTerm(bends, d) {
  if (!bends || !bends.length) return null;
  const byAngle = {};
  bends.forEach(function (a) { byAngle[a] = (byAngle[a] || 0) + 1; });
  const angles = Object.keys(byAngle).map(Number).sort(function (a, b) { return a - b; });
  let mm = 0;
  const parts = angles.map(function (a) {
    const ded = CODE.bendDeduction[a];
    if (ded === undefined) return null;             // unknown angle: never guessed
    mm += byAngle[a] * ded * d;
    return byAngle[a] + ' ' + TIMES + ' ' + ded + 'd';
  }).filter(Boolean);
  if (!parts.length) return null;
  return { mm: -mm, note: parts.join(' + ') + ' bends @ ' + d };
}

function crankTerm(count, DMm) {
  const factor = CODE.crank[CODE.crankGeometry.angleKey];
  return {
    mm: count * factor * DMm,
    note: count + ' ' + TIMES + ' ' + factor + 'D crank @ D=' + fmt(DMm)
  };
}

function lapTerm(count, type, d) {
  const factor = CODE.lap[type];
  return {
    mm: count * factor * d,
    note: count + ' ' + TIMES + ' ' + factor + 'd ' + type + ' lap @ ' + d
  };
}

/* ---------------------------------------------------------------------
   ASSEMBLE — one cutting length, with its derivation.

   Cutting length = run − cover + hooks + cranks + laps − bend deductions
   ------------------------------------------------------------------- */
function assemble(spec) {
  const d = spec.dia;
  const terms = [spec.base];
  let bends = (spec.bends || []).slice();

  // additions that belong with the run itself, e.g. the legs of an L-bend
  (spec.extra || []).forEach(function (t) { terms.push(t); });

  if (spec.hooks && spec.hooks.count > 0) {
    terms.push(hookTerm(spec.hooks.kind, spec.hooks.count, d));
  }
  if (spec.cranks && spec.cranks.count > 0) {
    terms.push(crankTerm(spec.cranks.count, spec.cranks.DMm));
    for (let i = 0; i < spec.cranks.count; i++) {
      bends = bends.concat(CODE.crankGeometry.bendsPerCrank);
    }
  }
  if (spec.laps && spec.laps.count > 0) {
    terms.push(lapTerm(spec.laps.count, spec.laps.type, d));
  }
  const bd = bendTerm(bends, d);
  if (bd) terms.push(bd);

  const raw = terms.reduce(function (s, t) { return s + t.mm; }, 0);
  const mm = Math.round(raw);

  let s = '';
  terms.forEach(function (t, i) {
    if (i === 0) s += fmt(t.mm) + ' (' + t.note + ')';
    else s += ' ' + (t.mm < 0 ? MINUS : '+') + ' ' + fmt(Math.abs(t.mm)) + ' (' + t.note + ')';
  });

  return { mm: mm, rawMm: raw, terms: terms, derivation: s + ' = ' + mm + ' mm' };
}

/* ---------------------------------------------------------------------
   MEMBER GEOMETRY

   Each type declares the concrete dimensions it needs, how a bar's run
   is measured, what a stirrup wraps, and how much concrete there is.
   ------------------------------------------------------------------- */
const F = function () { return CODE.geometry.coverFaces; };

function coverNote(cover) { return F() + TIMES + cover + ' cover'; }
function runLess(lengthMm, label, cover) {
  return {
    mm: lengthMm - F() * cover,
    note: fmt(lengthMm) + ' ' + label + ' ' + MINUS + ' ' + coverNote(cover)
  };
}
function sectionLessCover(member, wKey, dKey) {
  const c = member.coverMm, cc = member.concrete;
  return {
    aMm: cc[wKey] - F() * c,
    bMm: cc[dKey] - F() * c,
    note: fmt(cc[wKey]) + TIMES + fmt(cc[dKey]) + ' less ' + coverNote(c)
  };
}

const MEMBERS = {
  footing: {
    label: 'Isolated footing',
    coverKey: 'footing',
    dims: ['lengthMm', 'widthMm', 'depthMm'],
    bendLegFrom: 'depthMm',
    defaultAlong: 'length',
    run: function (m, bar) {
      const k = bar.along === 'width' ? 'widthMm' : 'lengthMm';
      return runLess(m.concrete[k], bar.along === 'width' ? 'width' : 'length', m.coverMm);
    },
    across: function (m, bar) {
      const k = bar.along === 'width' ? 'lengthMm' : 'widthMm';
      return runLess(m.concrete[k], bar.along === 'width' ? 'length' : 'width', m.coverMm);
    },
    stirrupRun: function (m) { return { mm: m.concrete.lengthMm, note: 'length' }; },
    section: function (m) { return sectionLessCover(m, 'widthMm', 'depthMm'); },
    volumeMm3: function (m) { return m.concrete.lengthMm * m.concrete.widthMm * m.concrete.depthMm; },
    depthMm: function (m) { return m.concrete.depthMm; }
  },

  column: {
    label: 'Column',
    coverKey: 'column',
    dims: ['widthMm', 'depthMm', 'heightMm'],
    bendLegFrom: 'depthMm',
    defaultAlong: 'height',
    run: function (m) { return runLess(m.concrete.heightMm, 'height', m.coverMm); },
    across: function (m) { return runLess(m.concrete.heightMm, 'height', m.coverMm); },
    stirrupRun: function (m) { return { mm: m.concrete.heightMm, note: 'height' }; },
    section: function (m) { return sectionLessCover(m, 'widthMm', 'depthMm'); },
    volumeMm3: function (m) { return m.concrete.widthMm * m.concrete.depthMm * m.concrete.heightMm; },
    depthMm: function (m) { return m.concrete.depthMm; }
  },

  beam: {
    label: 'Beam',
    coverKey: 'beam',
    dims: ['widthMm', 'depthMm', 'spanMm'],
    bendLegFrom: 'depthMm',
    defaultAlong: 'span',
    run: function (m) { return runLess(m.concrete.spanMm, 'clear', m.coverMm); },
    across: function (m) { return runLess(m.concrete.spanMm, 'clear', m.coverMm); },
    stirrupRun: function (m) { return { mm: m.concrete.spanMm, note: 'clear' }; },
    section: function (m) { return sectionLessCover(m, 'widthMm', 'depthMm'); },
    volumeMm3: function (m) { return m.concrete.widthMm * m.concrete.depthMm * m.concrete.spanMm; },
    depthMm: function (m) { return m.concrete.depthMm; }
  },

  lintel: {
    label: 'Lintel',
    coverKey: 'lintel',
    dims: ['widthMm', 'depthMm', 'spanMm', 'bearingMm'],
    bendLegFrom: 'depthMm',
    defaultAlong: 'span',
    overall: function (m) { return m.concrete.spanMm + F() * (m.concrete.bearingMm || 0); },
    run: function (m) {
      const cc = m.concrete, br = cc.bearingMm || 0, c = m.coverMm;
      return {
        mm: cc.spanMm + F() * br - F() * c,
        note: fmt(cc.spanMm) + ' clear + ' + F() + TIMES + fmt(br) + ' bearing ' + MINUS + ' ' + coverNote(c)
      };
    },
    across: function (m) { return runLess(MEMBERS.lintel.overall(m), 'overall', m.coverMm); },
    stirrupRun: function (m) { return { mm: MEMBERS.lintel.overall(m), note: 'overall' }; },
    section: function (m) { return sectionLessCover(m, 'widthMm', 'depthMm'); },
    volumeMm3: function (m) { return m.concrete.widthMm * m.concrete.depthMm * MEMBERS.lintel.overall(m); },
    depthMm: function (m) { return m.concrete.depthMm; }
  },

  slabOneWay: {
    label: 'One-way slab',
    coverKey: 'slab',
    dims: ['lengthMm', 'widthMm', 'thicknessMm'],
    bendLegFrom: 'thicknessMm',
    defaultAlong: 'length',
    run: function (m, bar) {
      const k = bar.along === 'width' ? 'widthMm' : 'lengthMm';
      return runLess(m.concrete[k], bar.along === 'width' ? 'long span' : 'clear', m.coverMm);
    },
    across: function (m, bar) {
      const k = bar.along === 'width' ? 'lengthMm' : 'widthMm';
      return runLess(m.concrete[k], bar.along === 'width' ? 'clear' : 'long span', m.coverMm);
    },
    stirrupRun: function (m) { return { mm: m.concrete.lengthMm, note: 'clear' }; },
    section: function (m) { return sectionLessCover(m, 'widthMm', 'thicknessMm'); },
    volumeMm3: function (m) { return m.concrete.lengthMm * m.concrete.widthMm * m.concrete.thicknessMm; },
    depthMm: function (m) { return m.concrete.thicknessMm; }
  },

  staircase: {
    label: 'Staircase flight',
    coverKey: 'staircase',
    dims: ['riserMm', 'treadMm', 'treads', 'waistMm', 'widthMm'],
    bendLegFrom: 'waistMm',
    defaultAlong: 'flight',
    slopePerStep: function (m) { return Math.hypot(m.concrete.riserMm, m.concrete.treadMm); },
    flightMm: function (m) {
      const cc = m.concrete;
      return (cc.landingAMm || 0) + cc.treads * MEMBERS.staircase.slopePerStep(m) + (cc.landingBMm || 0);
    },
    run: function (m, bar) {
      const c = m.coverMm, cc = m.concrete;
      if (bar.along === 'width') return runLess(cc.widthMm, 'width', c);
      const slope = MEMBERS.staircase.slopePerStep(m);
      const total = MEMBERS.staircase.flightMm(m);
      return {
        mm: total - F() * c,
        note: fmt(total) + ' on slope (' + cc.treads + ' ' + TIMES + ' ' + fmt(slope) +
              ' + landings) ' + MINUS + ' ' + coverNote(c)
      };
    },
    across: function (m, bar) {
      const c = m.coverMm;
      if (bar.along === 'width') return runLess(MEMBERS.staircase.flightMm(m), 'on slope', c);
      return runLess(m.concrete.widthMm, 'width', c);
    },
    stirrupRun: function (m) { return { mm: MEMBERS.staircase.flightMm(m), note: 'on slope' }; },
    section: function (m) { return sectionLessCover(m, 'widthMm', 'waistMm'); },
    volumeMm3: function (m) {
      const cc = m.concrete;
      const waist = MEMBERS.staircase.slopePerStep(m) * cc.treads * cc.waistMm * cc.widthMm;
      const steps = (cc.riserMm * cc.treadMm / 2) * cc.treads * cc.widthMm;
      const land = ((cc.landingAMm || 0) + (cc.landingBMm || 0)) * cc.widthMm * cc.waistMm;
      return waist + steps + land;
    },
    depthMm: function (m) { return m.concrete.waistMm; }
  }
};

// A two-way slab is a one-way slab that is reinforced in both directions.
MEMBERS.slabTwoWay = Object.assign({}, MEMBERS.slabOneWay, {
  label: 'Two-way slab', coverKey: 'slab'
});

/* ---------------------------------------------------------------------
   BAR ROWS
   ------------------------------------------------------------------- */
function endsOf(bar) {
  if (Array.isArray(bar.ends) && bar.ends.length) return bar.ends;
  const e = bar.end || 'continuous';
  const out = [];
  for (let i = 0; i < CODE.geometry.barEnds; i++) out.push(e);
  return out;
}

function shapeOf(bar) {
  const e = endsOf(bar);
  if (e.indexOf('crank') >= 0 || bar.cranks > 0) return 'CRANK';
  if (e.indexOf('hook') >= 0) return 'U_HOOK';
  if (e.indexOf('bend') >= 0) return 'L_BEND';
  return 'STRAIGHT';
}

function countFromSpacing(acrossMm, spacingMm) {
  return Math.ceil(acrossMm / spacingMm) + CODE.geometry.endBarAllowance;
}

function barRow(member, bar, geom, seq, warn) {
  const d = bar.dia;
  const c = member.coverMm;
  const run = geom.run(member, bar);
  const ends = endsOf(bar);
  const shape = shapeOf(bar);

  /* end conditions -> hooks, extra legs, bends */
  let hookCount = 0, hookKind = null, bends = [], legCount = 0;
  let legMm = null;
  ends.forEach(function (name) {
    const rule = CODE.ends[name];
    if (!rule) {
      warn(member, 'INPUT_UNKNOWN', 'End condition "' + name + '" is not one of ' +
        Object.keys(CODE.ends).join(' / ') + '. Treated as continuous.');
      return;
    }
    if (rule.hooks) { hookCount += rule.hooks; hookKind = rule.hookKind; }
    if (rule.leg) {
      legMm = bar.bendLegMm !== undefined
        ? bar.bendLegMm
        : member.concrete[geom.bendLegFrom] - F() * c;
      legCount++;
    }
    bends = bends.concat(rule.bends || []);
  });

  const extra = [];
  if (legCount) {
    extra.push({
      mm: legCount * legMm,
      note: legCount + ' ' + TIMES + ' ' + fmt(legMm) + ' bent leg' +
            (bar.bendLegMm !== undefined ? '' : ' (' + fmt(member.concrete[geom.bendLegFrom]) +
             ' ' + MINUS + ' ' + coverNote(c) + ')')
    });
  }

  /* cranks */
  let cranks = null;
  const crankCount = bar.cranks !== undefined
    ? bar.cranks
    : (ends.indexOf('crank') >= 0 ? CODE.crankGeometry.defaultCount : 0);
  if (crankCount > 0) {
    const DMm = bar.crankDepthMm !== undefined
      ? bar.crankDepthMm
      : geom.depthMm(member) - F() * c - d;   // centre to centre of top and bottom bars
    cranks = { count: crankCount, DMm: DMm };
  }

  const cut = assemble({
    dia: d,
    base: run,
    extra: extra,
    hooks: hookCount ? { count: hookCount, kind: hookKind } : null,
    cranks: cranks,
    laps: bar.laps > 0 ? { count: bar.laps, type: bar.lapType || 'tension' } : null,
    bends: bends
  });

  /* count per member */
  let count = bar.count, countDerivation = null;
  if (count === undefined && bar.spacingMm) {
    const across = geom.across(member, bar);
    count = countFromSpacing(across.mm, bar.spacingMm);
    countDerivation = 'ceil(' + fmt(across.mm) + ' ÷ ' + bar.spacingMm + ') + ' +
      CODE.geometry.endBarAllowance + ' = ' + count + '  [' + across.note + ']';
  } else if (count === undefined) {
    warn(member, 'INPUT_INCOMPLETE', 'Bar "' + (bar.label || d + ' mm') +
      '" has neither a count nor a spacing. Taken as 1.');
    count = 1;
  }

  const qty = member.quantity || 1;
  const uw = CODE.unitWeight(d);
  const lenM = cut.mm / CODE.units.mmPerM;
  const totalBars = count * qty;

  return {
    mark: member.id + '-' + String(seq).padStart(2, '0'),
    memberId: member.id,
    memberType: member.type,
    memberLabel: MEMBERS[member.type].label,
    label: bar.label || (CODE.shapes[shape].label + ' ' + d + ' mm'),
    position: bar.position || 'main',
    shape: shape,
    shapeLabel: CODE.shapes[shape].label,
    dia: d,
    barsPerMember: count,
    countDerivation: countDerivation,
    members: qty,
    totalBars: totalBars,
    cuttingLengthMm: cut.mm,
    cuttingLengthM: round(lenM, 3),
    totalLengthM: round(lenM * totalBars, 3),
    unitWeightKgPerM: round(uw, 4),
    totalWeightKg: round(lenM * totalBars * uw, 3),
    derivation: cut.derivation,
    terms: cut.terms,
    sketch: sketchFor(shape, {
      lengthMm: run.mm, legMm: legMm, dia: d,
      hookMm: hookCount ? Math.max(CODE.hook[hookKind] * d, CODE.hook.minMm) : 0,
      cranks: cranks
    }),
    _bar: bar
  };
}

/* ---------------------------------------------------------------------
   STIRRUP ROWS
   ------------------------------------------------------------------- */
function stirrupPerimeter(member, st, geom) {
  const c = member.coverMm, ds = st.dia;
  const shape = st.shape || 'STIRRUP_RECT';
  const sec = geom.section(member);
  const a = sec.aMm, b = sec.bMm;

  if (shape === 'STIRRUP_CIRC') {
    const dia = st.diameterMm !== undefined ? st.diameterMm : member.concrete.diameterMm;
    const centre = dia - F() * c - ds;
    return {
      mm: Math.PI * centre,
      note: 'π ' + TIMES + ' ' + fmt(centre) + ' centre-line (' + fmt(dia) + ' ' + MINUS +
            ' ' + coverNote(c) + ' ' + MINUS + ' ' + ds + ' bar)'
    };
  }
  if (shape === 'STIRRUP_TRI') {
    const slope = Math.hypot(a / 2, b);
    return {
      mm: a + 2 * slope,
      note: fmt(a) + ' base + 2 ' + TIMES + ' ' + fmt(slope) + ' slope, ' + sec.note
    };
  }
  if (shape === 'STIRRUP_DIA') {
    const side = Math.hypot(a / 2, b / 2);
    return { mm: 4 * side, note: '4 ' + TIMES + ' ' + fmt(side) + ' side, ' + sec.note };
  }
  return {
    mm: 2 * (a + b),
    note: '2 ' + TIMES + ' (' + fmt(a) + ' + ' + fmt(b) + '), ' + sec.note
  };
}

function stirrupRow(member, st, geom, seq, warn) {
  const shape = st.shape || 'STIRRUP_RECT';
  const def = CODE.shapes[shape];
  if (!def || !def.hooks) {
    warn(member, 'INPUT_UNKNOWN', 'Stirrup shape "' + shape + '" is not a stirrup shape.');
    return null;
  }
  const ds = st.dia;
  const base = stirrupPerimeter(member, st, geom);

  const cut = assemble({
    dia: ds,
    base: base,
    hooks: { count: def.hooks, kind: def.hookKind },
    bends: def.bends,
    laps: null, cranks: null
  });

  const runInfo = geom.stirrupRun(member);
  const runMm = runInfo.mm - F() * member.coverMm;
  const count = Math.ceil(runMm / st.spacingMm) + CODE.geometry.endBarAllowance;
  const countDerivation = 'ceil(' + fmt(runMm) + ' ÷ ' + st.spacingMm + ') + ' +
    CODE.geometry.endBarAllowance + ' = ' + count +
    '  [' + fmt(runInfo.mm) + ' ' + runInfo.note + ' ' + MINUS + ' ' + coverNote(member.coverMm) + ']';

  const qty = member.quantity || 1;
  const uw = CODE.unitWeight(ds);
  const lenM = cut.mm / CODE.units.mmPerM;
  const totalBars = count * qty;
  const sec = geom.section(member);

  return {
    mark: member.id + '-' + String(seq).padStart(2, '0'),
    memberId: member.id,
    memberType: member.type,
    memberLabel: MEMBERS[member.type].label,
    label: st.label || ((st.legs ? st.legs + '-legged ' : '') + def.label.toLowerCase()),
    position: 'stirrup',
    shape: shape,
    shapeLabel: def.label,
    dia: ds,
    barsPerMember: count,
    countDerivation: countDerivation,
    members: qty,
    totalBars: totalBars,
    cuttingLengthMm: cut.mm,
    cuttingLengthM: round(lenM, 3),
    totalLengthM: round(lenM * totalBars, 3),
    unitWeightKgPerM: round(uw, 4),
    totalWeightKg: round(lenM * totalBars * uw, 3),
    derivation: cut.derivation,
    terms: cut.terms,
    spacingMm: st.spacingMm,
    sketch: sketchFor(shape, {
      aMm: sec.aMm, bMm: sec.bMm, dia: ds,
      diaMm: st.diameterMm !== undefined ? st.diameterMm : member.concrete.diameterMm,
      coverMm: member.coverMm,
      hookMm: Math.max(CODE.hook[def.hookKind] * ds, CODE.hook.minMm)
    }),
    _stirrup: st
  };
}

/* ---------------------------------------------------------------------
   SKETCH DATA — enough for the viewer to draw a dimensioned shape.
   No drawing code here; the engine stays pure.
   ------------------------------------------------------------------- */
function sketchFor(shape, g) {
  switch (shape) {
    case 'STRAIGHT':     return { kind: 'straight', lengthMm: g.lengthMm };
    case 'U_HOOK':       return { kind: 'uhook', lengthMm: g.lengthMm, hookMm: g.hookMm };
    case 'L_BEND':       return { kind: 'lbend', lengthMm: g.lengthMm, legMm: g.legMm };
    case 'CRANK':        return { kind: 'crank', lengthMm: g.lengthMm, hookMm: g.hookMm,
                                  crankMm: g.cranks ? g.cranks.DMm : 0,
                                  cranks: g.cranks ? g.cranks.count : 0 };
    case 'STIRRUP_RECT': return { kind: 'rect', aMm: g.aMm, bMm: g.bMm, hookMm: g.hookMm };
    case 'STIRRUP_TRI':  return { kind: 'tri', aMm: g.aMm, bMm: g.bMm, hookMm: g.hookMm };
    case 'STIRRUP_DIA':  return { kind: 'dia', aMm: g.aMm, bMm: g.bMm, hookMm: g.hookMm };
    case 'STIRRUP_CIRC': return { kind: 'circ',
                                  dMm: (g.diaMm || 0) - CODE.geometry.coverFaces * (g.coverMm || 0),
                                  hookMm: g.hookMm };
    default:             return { kind: 'straight', lengthMm: g.lengthMm };
  }
}

/* ---------------------------------------------------------------------
   CAGE — the reinforcement laid out in three dimensions, member-local,
   in millimetres. x runs along the member, y is up, z is across.

   Pure data: point lists and face indices, no canvas and no colour. The
   viewer owns every pixel. Bar lengths here are the geometric runs — the
   schedule's cutting lengths remain the only quantities that are ordered.
   ------------------------------------------------------------------- */
function spread(n, lo, hi) {
  if (n <= 1) return [(lo + hi) / 2];
  const out = [], step = (hi - lo) / (n - 1);
  for (let i = 0; i < n; i++) out.push(lo + i * step);
  return out;
}

/* n points walked evenly round a rectangle, starting at a corner */
function perimeterPoints(n, a0, a1, b0, b1) {
  const w = a1 - a0, d = b1 - b0, per = 2 * (w + d), out = [];
  for (let i = 0; i < n; i++) {
    const s = (i / n) * per;
    if (s < w) out.push([a0 + s, b0]);
    else if (s < w + d) out.push([a1, b0 + (s - w)]);
    else if (s < 2 * w + d) out.push([a1 - (s - w - d), b1]);
    else out.push([a0, b1 - (s - 2 * w - d)]);
  }
  return out;
}

/* one longitudinal bar, run along +x from u0, at height y and offset z */
function longBar(u0, lenMm, y, z, o) {
  const r = o.dia * CODE.cage.hookStandoffDia;
  const u1 = u0 + lenMm;
  function cap(u, dir) {
    if (o.end === 'hook')
      return [[u + dir * o.hookMm, y + r, z], [u + dir * r * 0.5, y + r, z],
              [u, y + r * 0.6, z], [u, y, z]];
    if (o.end === 'bend') return [[u, y + o.legMm, z], [u, y, z]];
    return [[u, y, z]];
  }
  if (o.cranks > 0 && o.DMm > 0) {
    const D = o.DMm, c = Math.max(0, Math.min(lenMm / 6, lenMm / 2 - D));
    return [[u0, y + D, z], [u0 + c, y + D, z], [u0 + c + D, y, z],
            [u1 - c - D, y, z], [u1 - c, y + D, z], [u1, y + D, z]];
  }
  return cap(u0, 1).concat(cap(u1, -1).reverse());
}

function swapXZ(path) { return path.map(function (p) { return [p[2], p[1], p[0]]; }); }
function swapXY(path) { return path.map(function (p) { return [p[1], p[0], p[2]]; }); }

/* a closed tie or stirrup in the plane perpendicular to `axis` */
function ring(pos, shape, g, axis, tailMm) {
  const P = axis === 'y'
    ? function (a, b) { return [a, pos, b]; }
    : function (a, b) { return [pos, a, b]; };
  const a0 = g.a0, a1 = g.a1, b0 = g.b0, b1 = g.b1;
  const t = Math.min(tailMm, Math.abs(a1 - a0) * 0.3, Math.abs(b1 - b0) * 0.3);
  let loop;
  if (shape === 'STIRRUP_CIRC') {
    const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2, r = Math.min(a1 - a0, b1 - b0) / 2;
    loop = [];
    for (let i = 0; i <= CODE.cage.circleSegments; i++) {
      const th = i / CODE.cage.circleSegments * 2 * Math.PI;
      loop.push(P(ca + r * Math.cos(th), cb + r * Math.sin(th)));
    }
  } else if (shape === 'STIRRUP_TRI') {
    loop = [P(a0, b0), P(a0, b1), P(a1, (b0 + b1) / 2), P(a0, b0)];
  } else if (shape === 'STIRRUP_DIA') {
    const ma = (a0 + a1) / 2, mb = (b0 + b1) / 2;
    loop = [P(ma, b0), P(a1, mb), P(ma, b1), P(a0, mb), P(ma, b0)];
  } else {
    loop = [P(a0, b0), P(a0, b1), P(a1, b1), P(a1, b0), P(a0, b0)];
  }
  return [loop, [P(a0, b0), P(a0 + t, b0 + t)]];
}

function boxSolid(L, H, W) {
  return {
    verts: [[0,0,0],[L,0,0],[L,H,0],[0,H,0],[0,0,W],[L,0,W],[L,H,W],[0,H,W]],
    faces: [[0,1,2,3],[4,5,6,7],[0,1,5,4],[3,2,6,7],[0,3,7,4],[1,2,6,5]]
  };
}

/* a side profile in (x, y) extruded across z */
function prismSolid(profile, W) {
  const n = profile.length, verts = [], faces = [];
  profile.forEach(function (p) { verts.push([p[0], p[1], 0]); });
  profile.forEach(function (p) { verts.push([p[0], p[1], W]); });
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push([i, j, j + n, i + n]);
  }
  const capA = [], capB = [];
  for (let i = 0; i < n; i++) { capA.push(i); capB.push(n + n - 1 - i); }
  faces.push(capA, capB);
  return { verts: verts, faces: faces };
}

/* stirrup positions, thinned to a drawable number — depiction only, the
   schedule count is untouched and the thinning is reported */
function ringPositions(count, lo, hi) {
  const max = CODE.cage.maxRings;
  if (count <= max) return { at: spread(count, lo, hi), thinned: false };
  return { at: spread(max, lo, hi), thinned: true };
}

const CAGES = {
  /* box members: longitudinal bars either way, rings along the run */
  box: function (m, rows, L, H, W, ds) {
    const c = m.coverMm, bars = [];
    let thinned = false;
    rows.forEach(function (row) {
      const d = row.dia;
      if (row.position === 'stirrup') {
        const p = ringPositions(row.barsPerMember, c, L - c);
        thinned = thinned || p.thinned;
        p.at.forEach(function (x) {
          ring(x, row.shape, { a0: c, a1: H - c, b0: c, b1: W - c }, 'x',
               row.sketch.hookMm || d * 6).forEach(function (path) {
            bars.push({ mark: row.mark, dia: d, kind: 'ring', path: path });
          });
        });
        return;
      }
      const b = row._bar || {}, alongZ = (b.along === 'width');
      const inset = c + ds + d / 2;
      const y = b.position === 'top' ? H - inset : c + d / 2 + (alongZ ? d : 0);
      const runLen = (alongZ ? W : L) - 2 * c;
      // bars sit inside the stirrup across the section as well as up it
      const across = spread(row.barsPerMember, inset, (alongZ ? L : W) - inset);
      const o = { dia: d, end: b.end || 'continuous',
                  hookMm: row.sketch.hookMm || 0, legMm: row.sketch.legMm || 0,
                  cranks: row.sketch.cranks || 0, DMm: row.sketch.crankMm || 0 };
      across.forEach(function (t) {
        const p = longBar(c, runLen, y, t, o);
        bars.push({ mark: row.mark, dia: d, kind: 'long', path: alongZ ? swapXZ(p) : p });
      });
    });
    return { solid: boxSolid(L, H, W), bars: bars, thinned: thinned,
             bounds: { min: [0, 0, 0], max: [L, H, W] } };
  },

  /* column: the run is vertical, so the bars and ties are rotated up */
  column: function (m, rows, ds) {
    const c = m.coverMm, X = m.concrete.widthMm, Z = m.concrete.depthMm, Hh = m.concrete.heightMm;
    const bars = [];
    let thinned = false;
    rows.forEach(function (row) {
      const d = row.dia;
      if (row.position === 'stirrup') {
        const p = ringPositions(row.barsPerMember, c, Hh - c);
        thinned = thinned || p.thinned;
        p.at.forEach(function (y) {
          ring(y, row.shape, { a0: c, a1: X - c, b0: c, b1: Z - c }, 'y',
               row.sketch.hookMm || d * 6).forEach(function (path) {
            bars.push({ mark: row.mark, dia: d, kind: 'ring', path: path });
          });
        });
        return;
      }
      const b = row._bar || {}, inset = c + ds + d / 2;
      const o = { dia: d, end: b.end || 'continuous',
                  hookMm: row.sketch.hookMm || 0, legMm: row.sketch.legMm || 0,
                  cranks: 0, DMm: 0 };
      perimeterPoints(row.barsPerMember, inset, X - inset, inset, Z - inset)
        .forEach(function (pt) {
          bars.push({ mark: row.mark, dia: d, kind: 'long',
                      path: swapXY(longBar(c, Hh - 2 * c, pt[0], pt[1], o)) });
        });
    });
    return { solid: boxSolid(X, Hh, Z), bars: bars, thinned: thinned,
             bounds: { min: [0, 0, 0], max: [X, Hh, Z] } };
  },

  /* staircase: a stepped profile extruded across the flight width, with
     the main steel following the soffit */
  staircase: function (m, rows) {
    const cc = m.concrete, c = m.coverMm;
    const R = cc.riserMm, T = cc.treadMm, n = cc.treads, wa = cc.waistMm, W = cc.widthMm;
    const LA = cc.landingAMm || 0, LB = cc.landingBMm || 0;
    const top = [[0, 0], [LA, 0]];
    for (let i = 0; i < n; i++) {
      top.push([LA + i * T, (i + 1) * R]);
      top.push([LA + (i + 1) * T, (i + 1) * R]);
    }
    const endX = LA + n * T + LB, endY = n * R;
    top.push([endX, endY]);
    const profile = top.concat([[endX, endY - wa], [LA + n * T, endY - wa], [LA, -wa], [0, -wa]]);

    /* the soffit line, lifted by cover, is the path the main bars follow */
    const yA = -wa + c, yB = endY - wa + c;
    const soffit = [[0, yA], [LA, yA], [LA + n * T, yB], [endX, yB]];
    const bars = [];
    rows.forEach(function (row) {
      const b = row._bar || {}, d = row.dia;
      if (b.along === 'width') {
        /* distribution bars run across the flight, spaced along the soffit */
        const at = spread(row.barsPerMember, 0.02, 0.98);
        at.forEach(function (t) {
          const p = alongPolyline(soffit, t);
          bars.push({ mark: row.mark, dia: d, kind: 'long',
                      path: [[p[0], p[1] + d, c], [p[0], p[1] + d, W - c]] });
        });
        return;
      }
      const leg = row.sketch.legMm || 0;
      spread(row.barsPerMember, c, W - c).forEach(function (z) {
        const path = soffit.map(function (p) { return [p[0], p[1] + d / 2, z]; });
        if (b.end === 'bend' && leg > 0) {
          path.unshift([soffit[0][0], soffit[0][1] + leg, z]);
          path.push([endX, yB + leg, z]);
        }
        bars.push({ mark: row.mark, dia: d, kind: 'long', path: path });
      });
    });
    const ys = profile.map(function (p) { return p[1]; });
    return { solid: prismSolid(profile, W), bars: bars, thinned: false,
             bounds: { min: [0, Math.min.apply(null, ys), 0],
                       max: [endX, Math.max.apply(null, ys), W] } };
  }
};

/* point at fraction t along a polyline given as [x, y] pairs */
function alongPolyline(pts, t) {
  let total = 0;
  const segs = [];
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i][0] - pts[i-1][0], pts[i][1] - pts[i-1][1]);
    segs.push(l); total += l;
  }
  let want = t * total;
  for (let i = 0; i < segs.length; i++) {
    if (want <= segs[i] || i === segs.length - 1) {
      const f = segs[i] ? want / segs[i] : 0;
      return [pts[i][0] + (pts[i+1][0] - pts[i][0]) * f,
              pts[i][1] + (pts[i+1][1] - pts[i][1]) * f];
    }
    want -= segs[i];
  }
  return pts[0];
}

function cageFor(member, rows, geom) {
  const ds = member.stirrups
    ? (Array.isArray(member.stirrups) ? member.stirrups[0].dia : member.stirrups.dia)
    : 0;
  const cc = member.concrete;
  switch (member.type) {
    case 'column':    return CAGES.column(member, rows, ds);
    case 'staircase': return CAGES.staircase(member, rows);
    case 'beam':      return CAGES.box(member, rows, cc.spanMm, cc.depthMm, cc.widthMm, ds);
    case 'lintel':    return CAGES.box(member, rows, geom.overall(member), cc.depthMm, cc.widthMm, ds);
    case 'footing':   return CAGES.box(member, rows, cc.lengthMm, cc.depthMm, cc.widthMm, ds);
    default:          return CAGES.box(member, rows, cc.lengthMm, cc.thicknessMm, cc.widthMm, ds);
  }
}

/* ---------------------------------------------------------------------
   CHECKS — every one surfaces as a warning. Nothing throws, nothing is
   silently corrected, no threshold is bent to keep a job quiet.
   ------------------------------------------------------------------- */
function effectiveDepthMm(member, geom) {
  const st = member.stirrups;
  const mains = (member.bars || []).filter(function (b) { return b.position !== 'distribution'; });
  const maxMain = mains.length ? Math.max.apply(null, mains.map(function (b) { return b.dia; })) : 0;
  return geom.depthMm(member) - member.coverMm - (st ? st.dia : 0) - maxMain / 2;
}

function runChecks(member, rows, geom, warn) {
  const c = member.coverMm;
  const type = member.type;

  /* 1. cover */
  const nominal = CODE.cover[MEMBERS[type].coverKey];
  if (c < nominal) {
    warn(member, 'COVER_BELOW_NOMINAL',
      'Cover ' + c + ' mm is below the ' + nominal + ' mm nominal for a ' +
      MEMBERS[type].label.toLowerCase() + '. The ' + c + ' mm you gave has been used.',
      { value: c, limit: nominal });
  }

  /* 2. stirrup spacing */
  const st = member.stirrups;
  if (st && CODE.checks.stirrupSpacingAppliesTo.indexOf(type) >= 0) {
    const dEff = effectiveDepthMm(member, geom);
    const byDepth = CODE.limits.stirrupSpacingDepthFactor * dEff;
    const limit = Math.min(byDepth, CODE.limits.stirrupSpacingMaxMm);
    if (st.spacingMm > limit) {
      warn(member, 'STIRRUP_SPACING',
        'Stirrup spacing ' + st.spacingMm + ' mm exceeds ' + fmt(limit) +
        ' mm, the lesser of ' + CODE.limits.stirrupSpacingDepthFactor + 'd (' + fmt(byDepth) +
        ' mm on d = ' + fmt(dEff) + ' mm) and ' + CODE.limits.stirrupSpacingMaxMm + ' mm.',
        { value: st.spacingMm, limit: round(limit, 1) });
    }
  }

  /* 3. congestion */
  if (CODE.checks.congestionAppliesTo.indexOf(type) >= 0) {
    const width = member.concrete.widthMm;
    (member.bars || []).forEach(function (bar, i) {
      const row = rows.find(function (r) { return r._bar === bar; });
      const n = row ? row.barsPerMember : bar.count;
      if (!n || n < 2 || width === undefined) return;
      const clear = (width - F() * c - F() * (st ? st.dia : 0) - n * bar.dia) / (n - 1);
      const need = Math.max(bar.dia, CODE.limits.minBarClearMm);
      if (clear < need) {
        warn(member, 'BAR_CONGESTION',
          'Clear spacing ' + fmt(clear) + ' mm between ' + n + ' no. ' + bar.dia +
          ' mm ' + (bar.position || 'main') + ' bars is below the required ' + need +
          ' mm (greater of bar dia and ' + CODE.limits.minBarClearMm + ' mm).',
          { value: round(clear, 1), limit: need, mark: row ? row.mark : null });
      }
    });
  }

  /* 4. lap zone */
  if (CODE.checks.lapZoneAppliesTo.indexOf(type) >= 0) {
    (member.bars || []).forEach(function (bar) {
      if (!bar.laps) return;
      const avoid = CODE.checks.lapAvoidZone[bar.position];
      if (!avoid) return;
      const row = rows.find(function (r) { return r._bar === bar; });
      const where = avoid === 'midSpan' ? 'mid-span' : 'the support';
      if (bar.lapZone === avoid) {
        warn(member, 'LAP_ZONE',
          bar.laps + ' lap on ' + bar.position + ' steel falls at ' + where +
          ', where laps are normally avoided.',
          { mark: row ? row.mark : null });
      } else if (!bar.lapZone) {
        warn(member, 'LAP_ZONE',
          bar.laps + ' lap on ' + bar.position + ' steel with no zone stated. ' +
          'Confirm it is clear of ' + where + '.',
          { mark: row ? row.mark : null, severity: 'info' });
      }
    });
  }

  /* 5. stock length */
  rows.forEach(function (row) {
    if (row.cuttingLengthMm <= CODE.stockLengthMm) return;
    const joints = Math.ceil(row.cuttingLengthMm / CODE.stockLengthMm) - 1;
    const lapType = (row._bar && row._bar.lapType) || 'tension';
    const each = CODE.lap[lapType] * row.dia;
    const extra = joints * each;
    warn(member, 'STOCK_LENGTH',
      'Cutting length ' + row.cuttingLengthMm + ' mm exceeds the ' + CODE.stockLengthMm +
      ' mm stock length. ' + joints + ' joint' + (joints > 1 ? 's' : '') + ' needed, adding ' +
      fmt(extra) + ' mm of lap (' + joints + ' ' + TIMES + ' ' + CODE.lap[lapType] + 'd @ ' +
      row.dia + ') — order ' + fmt(row.cuttingLengthMm + extra) + ' mm per bar.',
      { mark: row.mark, joints: joints, extraLapMm: round(extra, 1) });
  });

  /* 6. bar sizes */
  rows.forEach(function (row) {
    if (CODE.barSizes.indexOf(row.dia) >= 0) return;
    warn(member, 'BAR_SIZE',
      row.dia + ' mm is not a rolled size. CODE.barSizes lists ' + CODE.barSizes.join(', ') + ' mm.',
      { mark: row.mark, value: row.dia });
  });
}

/* ---------------------------------------------------------------------
   GENERATE
   ------------------------------------------------------------------- */
function generate(job) {
  const src = (job && job.members) || [];
  const warnings = [];
  function warn(member, code, text, extra) {
    warnings.push(Object.assign({
      memberId: member ? member.id : null,
      code: code,
      severity: 'warn',
      text: text
    }, extra || {}));
  }

  const schedule = [];
  const members = [];

  src.forEach(function (raw) {
    const geom = MEMBERS[raw.type];
    if (!geom) {
      warn(raw, 'INPUT_UNKNOWN', 'Member type "' + raw.type + '" is not one of ' +
        Object.keys(MEMBERS).join(', ') + '. Skipped.');
      return;
    }
    // work on a copy so generate() never mutates the caller's job
    const member = clone(raw);
    if (member.coverMm === undefined) member.coverMm = CODE.cover[geom.coverKey];
    member.quantity = member.quantity || 1;

    const missing = geom.dims.filter(function (k) { return member.concrete[k] === undefined; });
    if (missing.length) {
      warn(member, 'INPUT_INCOMPLETE',
        'Missing concrete ' + (missing.length > 1 ? 'dimensions' : 'dimension') + ': ' +
        missing.join(', ') + '. This member is not scheduled.');
      members.push({
        id: member.id, type: member.type, label: geom.label, quantity: member.quantity,
        coverMm: member.coverMm, incomplete: true, rows: [], steelKg: 0,
        concreteM3PerMember: 0, concreteM3Total: 0, steelPerM3: 0, unverifiedFields: 0
      });
      return;
    }

    const rows = [];
    let seq = 1;
    (member.bars || []).forEach(function (bar) {
      if (bar.along === undefined) bar.along = geom.defaultAlong;
      rows.push(barRow(member, bar, geom, seq++, warn));
    });
    const stirrupList = member.stirrups
      ? (Array.isArray(member.stirrups) ? member.stirrups : [member.stirrups])
      : [];
    stirrupList.forEach(function (st) {
      const row = stirrupRow(member, st, geom, seq, warn);
      if (row) { rows.push(row); seq++; }
    });

    runChecks(member, rows, geom, warn);

    const volPer = geom.volumeMm3(member) / CODE.units.mm3PerM3;
    const volTot = volPer * member.quantity;
    const steel = rows.reduce(function (s, r) { return s + r.totalWeightKg; }, 0);
    const ratio = volTot > 0 ? steel / volTot : 0;

    if (volTot > 0 && (ratio < CODE.limits.steelRatioMin || ratio > CODE.limits.steelRatioMax)) {
      warn(member, 'STEEL_RATIO',
        'Steel ' + fmt(ratio) + ' kg/m³ on ' + round(volTot, 3) + ' m³ of concrete is ' +
        (ratio < CODE.limits.steelRatioMin ? 'below the ' + CODE.limits.steelRatioMin
                                           : 'above the ' + CODE.limits.steelRatioMax) +
        ' kg/m³ sanity ' + (ratio < CODE.limits.steelRatioMin ? 'floor' : 'ceiling') + '.',
        { value: round(ratio, 1),
          limit: ratio < CODE.limits.steelRatioMin ? CODE.limits.steelRatioMin : CODE.limits.steelRatioMax });
    }

    rows.forEach(function (r) { schedule.push(r); });
    members.push({
      id: member.id,
      type: member.type,
      label: geom.label,
      quantity: member.quantity,
      coverMm: member.coverMm,
      concrete: member.concrete,
      rows: rows,
      steelKg: round(steel, 3),
      concreteM3PerMember: round(volPer, 4),
      concreteM3Total: round(volTot, 4),
      steelPerM3: round(ratio, 2),
      unverifiedFields: countUnverified(raw.provenance),
      cage: cageFor(member, rows, geom)
    });
  });

  /* ---- summary ---- */
  const net = schedule.reduce(function (s, r) { return s + r.totalWeightKg; }, 0);
  const concrete = members.reduce(function (s, m) { return s + m.concreteM3Total; }, 0);
  const wastage = net * CODE.wastagePct / CODE.units.percent;
  const ratio = concrete > 0 ? net / concrete : 0;

  const byDia = CODE.barSizes.concat(
    schedule.map(function (r) { return r.dia; })
            .filter(function (d) { return CODE.barSizes.indexOf(d) < 0; })
  ).filter(function (d, i, a) { return a.indexOf(d) === i; })
   .map(function (d) {
     const rows = schedule.filter(function (r) { return r.dia === d; });
     return {
       dia: d,
       marks: rows.length,
       totalBars: rows.reduce(function (s, r) { return s + r.totalBars; }, 0),
       lengthM: round(rows.reduce(function (s, r) { return s + r.totalLengthM; }, 0), 3),
       weightKg: round(rows.reduce(function (s, r) { return s + r.totalWeightKg; }, 0), 3),
       unitWeightKgPerM: round(CODE.unitWeight(d), 4)
     };
   }).filter(function (g) { return g.marks > 0; });

  const byMember = members.map(function (m) {
    return {
      id: m.id, label: m.label, quantity: m.quantity,
      marks: m.rows.length,
      lengthM: round(m.rows.reduce(function (s, r) { return s + r.totalLengthM; }, 0), 3),
      weightKg: round(m.steelKg, 3),
      concreteM3: m.concreteM3Total,
      steelPerM3: m.steelPerM3
    };
  });

  return {
    project: Object.assign({ name: '', revision: '', date: '' }, (job && job.project) || {}),
    members: members,
    schedule: schedule,
    warnings: warnings,
    summary: {
      marks: schedule.length,
      totalBars: schedule.reduce(function (s, r) { return s + r.totalBars; }, 0),
      totalLengthM: round(schedule.reduce(function (s, r) { return s + r.totalLengthM; }, 0), 3),
      netKg: round(net, 3),
      wastagePct: CODE.wastagePct,
      wastageKg: round(wastage, 3),
      grossKg: round(net + wastage, 3),
      grossTonnes: round((net + wastage) / CODE.units.kgPerTonne, 4),
      concreteM3: round(concrete, 4),
      steelPerM3: round(ratio, 2),
      steelRatioFlag: concrete <= 0 ? 'none'
        : (ratio < CODE.limits.steelRatioMin ? 'low'
        : (ratio > CODE.limits.steelRatioMax ? 'high' : 'ok')),
      byDiameter: byDia,
      byMember: byMember
    }
  };
}

/* ---------------------------------------------------------------------
   EXTERNAL INPUT SEAM

   A drawing-extraction module (out of scope for this build) can hand the
   engine a member array. Everything it supplies is recorded as
   unverified so the viewer can ask the engineer to confirm each field
   before the steel is ordered.

   The calculation path never reads `provenance`. Adding this seam does
   not change a single number — see the seam test.
   ------------------------------------------------------------------- */
function adoptExternalMembers(members, source) {
  const src = source || 'external';
  return (members || []).map(function (m) {
    const copy = clone(m);
    copy.provenance = markUnverified(m, src);
    return copy;
  });
}

function markUnverified(value, src) {
  if (Array.isArray(value)) return value.map(function (v) { return markUnverified(v, src); });
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach(function (k) { out[k] = markUnverified(value[k], src); });
    return out;
  }
  return { verified: false, source: src, value: value };
}

function countUnverified(prov) {
  if (!prov) return 0;
  if (Array.isArray(prov)) return prov.reduce(function (s, p) { return s + countUnverified(p); }, 0);
  if (typeof prov !== 'object') return 0;
  if (prov.verified === false) return 1;
  return Object.keys(prov).reduce(function (s, k) { return s + countUnverified(prov[k]); }, 0);
}

/* ------------------------------------------------------------------- */
const BBS = {
  CODE: CODE,
  MEMBERS: MEMBERS,
  generate: generate,
  assemble: assemble,
  adoptExternalMembers: adoptExternalMembers,
  helpers: { round: round, fmt: fmt, countFromSpacing: countFromSpacing, shapeOf: shapeOf }
};

if (typeof module !== 'undefined' && module.exports) module.exports = BBS;
