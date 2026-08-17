'use strict';

/* =====================================================================
   LOAD ENGINE — what the frame carries, where the load goes, and which
   combination governs.

   Pure logic. No DOM, no window, no third-party code, requireable in
   Node, inlined verbatim into bbs.html by tools/inline.js.

   Scope: statics only. Unit weights, occupancy loads, tributary areas
   by yield line, the load path down to the footing, and every IS 456
   Table 18 combination. There are no moments and no shears here —
   those are src/design.js. Nothing here redistributes for continuity:
   every reaction is the statically determinate one, and the output
   says so rather than implying a frame analysis has happened.

   Units: kN, kN/m, kN/m², kN/m³. Member sizes arrive in mm; spans are
   reported in m. Every reported number states its unit.

   On numeric literals: every LOAD value lives in LOAD and is read from
   LOAD at call time. Literals surviving in the calculation path are
   geometry — a triangle is half base × height, a rectangle has four
   edges, a symmetric span delivers half its load to each end — not
   values anyone would want to tune.
   ===================================================================== */

/* ---------------------------------------------------------------------
   LOAD — the single home for every load constant.
   ------------------------------------------------------------------- */
const LOAD = {
  /* ---- unit weights, IS 875 (Part 1) ------------------------------ */
  unitWeightKNPerM3: {
    reinforcedConcrete: 25,
    plainConcrete: 24,
    brickMasonry: 19,
    screed: 20
  },

  /* ---- imposed load by occupancy, IS 875 (Part 2) -----------------
     Only the occupancies written into the brief. An occupancy that is
     not here is refused, not approximated from a neighbour — roof
     access, storage, plant rooms and assembly all differ and all are
     someone's decision to make.
     ---------------------------------------------------------------- */
  liveKNPerM2: {
    residentialRooms: 2.0,
    balconies: 3.0,
    corridorsAndStairs: 3.0,
    office: 2.5,
    shops: 4.0
  },

  /* ---- superimposed dead load -------------------------------------
     ASSUMPTIONS, not code values. IS 875 Part 1 gives materials, not a
     finishes allowance, so these are editable defaults and every
     result that leans on one names it on `assumptions`.
     ---------------------------------------------------------------- */
  sdlKNPerM2:      { floorFinish: 1.0, falseCeiling: 0.3, services: 0.3 },
  sdlRangeKNPerM2: { floorFinish: [1.0, 1.5], falseCeiling: [0.3, 0.3], services: [0.3, 0.3] },
  sdlDefault: ['floorFinish'],   // false ceiling and services are opt-in, never assumed

  /* ---- load combinations, IS 456 Table 18 -------------------------
     Partial safety factors for loads. DL dead, LL imposed, EL seismic,
     WL wind. A ± case is listed once per sign, because which sign
     governs is not knowable before the case is evaluated. EL and WL
     carry the same factors in Table 18; they are kept as separate
     columns so a model with both never adds them into one term.
     ---------------------------------------------------------------- */
  combinations: [
    /* limit state of collapse */
    { id: 'ULS-1',  limitState: 'collapse', label: '1.5(DL + LL)',      DL: 1.5, LL: 1.5, EL:  0,   WL:  0   },
    { id: 'ULS-2',  limitState: 'collapse', label: '1.2(DL + LL + EL)', DL: 1.2, LL: 1.2, EL:  1.2, WL:  0   },
    { id: 'ULS-3',  limitState: 'collapse', label: '1.2(DL + LL − EL)', DL: 1.2, LL: 1.2, EL: -1.2, WL:  0   },
    { id: 'ULS-4',  limitState: 'collapse', label: '1.5(DL + EL)',      DL: 1.5, LL: 0,   EL:  1.5, WL:  0   },
    { id: 'ULS-5',  limitState: 'collapse', label: '1.5(DL − EL)',      DL: 1.5, LL: 0,   EL: -1.5, WL:  0   },
    { id: 'ULS-6',  limitState: 'collapse', label: '0.9DL + 1.5EL',     DL: 0.9, LL: 0,   EL:  1.5, WL:  0   },
    { id: 'ULS-7',  limitState: 'collapse', label: '0.9DL − 1.5EL',     DL: 0.9, LL: 0,   EL: -1.5, WL:  0   },
    { id: 'ULS-8',  limitState: 'collapse', label: '1.2(DL + LL + WL)', DL: 1.2, LL: 1.2, EL:  0,   WL:  1.2 },
    { id: 'ULS-9',  limitState: 'collapse', label: '1.2(DL + LL − WL)', DL: 1.2, LL: 1.2, EL:  0,   WL: -1.2 },
    { id: 'ULS-10', limitState: 'collapse', label: '1.5(DL + WL)',      DL: 1.5, LL: 0,   EL:  0,   WL:  1.5 },
    { id: 'ULS-11', limitState: 'collapse', label: '1.5(DL − WL)',      DL: 1.5, LL: 0,   EL:  0,   WL: -1.5 },
    { id: 'ULS-12', limitState: 'collapse', label: '0.9DL + 1.5WL',     DL: 0.9, LL: 0,   EL:  0,   WL:  1.5 },
    { id: 'ULS-13', limitState: 'collapse', label: '0.9DL − 1.5WL',     DL: 0.9, LL: 0,   EL:  0,   WL: -1.5 },
    /* limit state of serviceability — the same table's lower block.
       Needed because a footing is proportioned on service load, not
       on a factored one. */
    { id: 'SLS-1',  limitState: 'serviceability', label: '1.0(DL + LL)',          DL: 1, LL: 1,   EL:  0,   WL:  0   },
    { id: 'SLS-2',  limitState: 'serviceability', label: '1.0DL + 1.0EL',         DL: 1, LL: 0,   EL:  1,   WL:  0   },
    { id: 'SLS-3',  limitState: 'serviceability', label: '1.0DL − 1.0EL',         DL: 1, LL: 0,   EL: -1,   WL:  0   },
    { id: 'SLS-4',  limitState: 'serviceability', label: '1.0DL + 0.8LL + 0.8EL', DL: 1, LL: 0.8, EL:  0.8, WL:  0   },
    { id: 'SLS-5',  limitState: 'serviceability', label: '1.0DL + 0.8LL − 0.8EL', DL: 1, LL: 0.8, EL: -0.8, WL:  0   },
    { id: 'SLS-6',  limitState: 'serviceability', label: '1.0DL + 1.0WL',         DL: 1, LL: 0,   EL:  0,   WL:  1   },
    { id: 'SLS-7',  limitState: 'serviceability', label: '1.0DL − 1.0WL',         DL: 1, LL: 0,   EL:  0,   WL: -1   },
    { id: 'SLS-8',  limitState: 'serviceability', label: '1.0DL + 0.8LL + 0.8WL', DL: 1, LL: 0.8, EL:  0,   WL:  0.8 },
    { id: 'SLS-9',  limitState: 'serviceability', label: '1.0DL + 0.8LL − 0.8WL', DL: 1, LL: 0.8, EL:  0,   WL: -0.8 }
  ],
  primaryGravity: 'ULS-1',   // what a bare "factored" means when no case is named
  primaryService: 'SLS-1',   // what a bare "service" means

  /* ---- slab to beam ----------------------------------------------- */
  distribution: {
    /* long/short at or above which a panel is taken to span one way —
       IS 456 cl 24.4.1 draws the line between one-way and two-way at 2 */
    oneWayRatio: 2.0,
    /* yield lines bisect each corner, so the load boundary rises at
       45° and the triangle's height is half the short span */
    yieldLineDeg: 45
  },

  /* ---- the load path ----------------------------------------------
     beamEndShare 0.5 is exact statics for a symmetric load on a single
     span, which every tributary shape here is. It is NOT a continuity
     factor: no redistribution for continuity happens in this module,
     and `notes` says so on every result that walks the path.
     ---------------------------------------------------------------- */
  path: {
    beamEndShare: 0.5,
    /* Self weight bookkeeping. With beamWebOnly the beam carries only
       its web, depth − slab thickness, because the slab panel is taken
       centre to centre of beams and so already carries the flange
       strip over the beam. Together the two count the frame's concrete
       exactly once. Turn it off and the strip is counted twice. */
    beamWebOnly: true,
    /* IS 875 Part 2 cl 3.2 permits a reduction in imposed load on
       columns carrying several floors. Not applied: the brief did not
       ask for it and it is unconservative to assume. */
    liveLoadReductionApplied: false
  },

  units: { mmPerM: 1000, mm2PerM2: 1e6, mm3PerM3: 1e9, percent: 100 },

  /* how far the distributed shares may miss the panel before the
     result carries a closure warning */
  tolerance: { closurePct: 1.0 }
};

/* ---------------------------------------------------------------------
   Small helpers. Names are local to this module and deliberately do not
   collide with src/bbs.js — once inlined, every module shares one
   global scope.
   ------------------------------------------------------------------- */
const GLYPH = { minus: '−', times: '×', div: '÷' };

function rnd(v, dp) {
  const p = Math.pow(10, dp === undefined ? 3 : dp);
  return Math.round(v * p) / p;
}
function num(v, dp) {
  const p = dp === undefined ? 3 : dp;
  return rnd(v, p).toFixed(p);
}
/* trims a trailing run of zeros, for factors printed inside a note */
function fac(v) { return String(rnd(v, 4)); }

/* one derived quantity with its term-by-term arithmetic, in the same
   shape src/bbs.js uses for a cutting length */
function tally(terms, unit, dp) {
  const total = terms.reduce(function (s, t) { return s + t.v; }, 0);
  let s;
  if (terms.length === 1) {
    s = terms[0].note;
  } else {
    s = '';
    terms.forEach(function (t, i) {
      if (i === 0) s += num(t.v, dp) + ' (' + t.note + ')';
      else s += ' ' + (t.v < 0 ? GLYPH.minus : '+') + ' ' +
                num(Math.abs(t.v), dp) + ' (' + t.note + ')';
    });
  }
  return {
    value: rnd(total, dp === undefined ? 3 : dp),
    exact: total,
    terms: terms,
    unit: unit,
    derivation: s + ' = ' + num(total, dp) + ' ' + unit
  };
}

/* a refusal is a result, not an exception: it carries why, and the
   caller can print it beside the numbers it does have */
function refuse(what, reason, extra) {
  return Object.assign({ refused: true, what: what, reason: reason }, extra || {});
}

function combinationById(id) {
  return LOAD.combinations.filter(function (c) { return c.id === id; })[0] || null;
}

/* ---------------------------------------------------------------------
   SELF WEIGHT — from the concrete dimensions frame() already returns.
   ------------------------------------------------------------------- */
const SELF_WEIGHT = {
  footing:    function (c) { return { mm3: c.lengthMm * c.widthMm * c.depthMm,
                                      note: fac(c.lengthMm) + GLYPH.times + fac(c.widthMm) +
                                            GLYPH.times + fac(c.depthMm) + ' mm' }; },
  column:     function (c) { return { mm3: c.widthMm * c.depthMm * c.heightMm,
                                      note: fac(c.widthMm) + GLYPH.times + fac(c.depthMm) +
                                            GLYPH.times + fac(c.heightMm) + ' mm' }; },
  beam:       function (c) { return { mm3: c.widthMm * c.depthMm * c.spanMm,
                                      note: fac(c.widthMm) + GLYPH.times + fac(c.depthMm) +
                                            GLYPH.times + fac(c.spanMm) + ' mm clear' }; },
  slabOneWay: function (c) { return { mm3: c.lengthMm * c.widthMm * c.thicknessMm,
                                      note: fac(c.lengthMm) + GLYPH.times + fac(c.widthMm) +
                                            GLYPH.times + fac(c.thicknessMm) + ' mm' }; }
};
SELF_WEIGHT.slabTwoWay = SELF_WEIGHT.slabOneWay;

/* kN for one member of `type`, from its concrete block */
function memberSelfWeight(type, concrete) {
  const shape = SELF_WEIGHT[type];
  if (!shape) {
    return refuse('self weight of a ' + type,
      'src/loads.js knows the concrete volume of ' + Object.keys(SELF_WEIGHT).join(', ') +
      ' only. A ' + type + ' has a shape this module does not model, so its self weight ' +
      'is not guessed.');
  }
  const g = LOAD.unitWeightKNPerM3.reinforcedConcrete;
  const s = shape(concrete);
  const m3 = s.mm3 / LOAD.units.mm3PerM3;
  const t = tally([{ v: m3 * g, note: num(m3, 4) + ' m³ (' + s.note + ') ' +
                                      GLYPH.times + ' ' + g + ' kN/m³ reinforced concrete' }], 'kN', 3);
  return { refused: false, kN: t.value, m3: rnd(m3, 4), derivation: t.derivation, terms: t.terms };
}

/* self weight of every member in a frame() result, per member and total */
function memberSelfWeights(frameOut) {
  const out = [], notes = [];
  (frameOut && frameOut.members || []).forEach(function (m) {
    const one = memberSelfWeight(m.type, m.concrete);
    if (one.refused) { notes.push(m.id + ': ' + one.reason); return; }
    out.push({
      id: m.id, type: m.type, quantity: m.quantity || 1,
      kNPerMember: one.kN,
      kNTotal: rnd(one.kN * (m.quantity || 1), 3),
      derivation: one.derivation
    });
  });
  return {
    members: out,
    totalKN: rnd(out.reduce(function (s, m) { return s + m.kNTotal; }, 0), 3),
    notes: notes
  };
}

/* ---------------------------------------------------------------------
   SLAB LOAD PER m²

   self weight + superimposed dead + imposed, kept as separate dead and
   live totals all the way through, because Table 18 factors them
   differently.
   ------------------------------------------------------------------- */
function sdlTerms(sdl) {
  /* sdl may be omitted (LOAD.sdlDefault), a list of component names, or
     an object of explicit values keyed by component name */
  const assumptions = [], terms = [];
  let keys, values = {};
  if (sdl === undefined || sdl === null) {
    keys = LOAD.sdlDefault.slice();
  } else if (Array.isArray(sdl)) {
    keys = sdl.slice();
  } else {
    keys = Object.keys(sdl);
    values = sdl;
  }
  const unknown = keys.filter(function (k) {
    return LOAD.sdlKNPerM2[k] === undefined && values[k] === undefined;
  });
  if (unknown.length) {
    return { refused: true, unknown: unknown };
  }
  keys.forEach(function (k) {
    const given = values[k] !== undefined;
    const v = given ? values[k] : LOAD.sdlKNPerM2[k];
    const label = k.replace(/([A-Z])/g, function (m) { return ' ' + m.toLowerCase(); });
    terms.push({ v: v, note: label + (given ? '' : ', assumed') });
    if (!given) {
      const r = LOAD.sdlRangeKNPerM2[k];
      assumptions.push(label.trim() + ' taken as ' + num(v, 3) + ' kN/m²' +
        (r && r[0] !== r[1] ? ' (usual range ' + num(r[0], 1) + GLYPH.minus + num(r[1], 1) + ')' : '') +
        ' — an assumption, not a code value.');
    }
  });
  return { refused: false, terms: terms, assumptions: assumptions };
}

function slabLoad(spec) {
  const s = spec || {};
  if (!(s.thicknessMm > 0)) {
    return refuse('slab load', 'No slab thickness was given, so there is no self weight to compute.');
  }

  /* dead: self weight, then the superimposed components */
  const g = LOAD.unitWeightKNPerM3.reinforcedConcrete;
  const tM = s.thicknessMm / LOAD.units.mmPerM;
  const deadTerms = [{ v: tM * g, note: num(tM, 3) + ' m ' + GLYPH.times + ' ' + g +
                                        ' kN/m³ reinforced concrete' }];
  const sdl = sdlTerms(s.sdl);
  if (sdl.refused) {
    return refuse('slab load', 'Superimposed dead component' + (sdl.unknown.length > 1 ? 's ' : ' ') +
      sdl.unknown.join(', ') + ' is not in LOAD.sdlKNPerM2 (' +
      Object.keys(LOAD.sdlKNPerM2).join(', ') + '). Give it a value rather than have one guessed.');
  }
  sdl.terms.forEach(function (t) { deadTerms.push(t); });
  if (s.extraDeadKNPerM2) {
    deadTerms.push({ v: s.extraDeadKNPerM2, note: s.extraDeadNote || 'extra dead, given' });
  }
  const dead = tally(deadTerms, 'kN/m²', 3);

  /* live: an occupancy from IS 875 Part 2, or an explicit value */
  let liveTerm;
  if (s.liveKNPerM2 !== undefined) {
    liveTerm = { v: s.liveKNPerM2, note: 'imposed load, given' };
  } else if (s.occupancy === undefined) {
    return refuse('slab load', 'No occupancy and no imposed load were given. LOAD.liveKNPerM2 covers ' +
      Object.keys(LOAD.liveKNPerM2).join(', ') + '.');
  } else if (LOAD.liveKNPerM2[s.occupancy] === undefined) {
    return refuse('slab load', 'Occupancy "' + s.occupancy + '" is not in LOAD.liveKNPerM2 (' +
      Object.keys(LOAD.liveKNPerM2).join(', ') + '). IS 875 Part 2 lists many more; add the one ' +
      'you need rather than borrow a neighbour\'s value.');
  } else {
    liveTerm = { v: LOAD.liveKNPerM2[s.occupancy],
                 note: 'live load, ' + s.occupancy.replace(/([A-Z])/g, function (m) {
                   return ' ' + m.toLowerCase(); }) };
  }
  const live = tally([liveTerm], 'kN/m²', 3);

  const service = tally([
    { v: dead.exact, note: 'dead' },
    { v: live.exact, note: 'imposed' }
  ], 'kN/m²', 3);

  const combo = combinationById(s.combination || LOAD.primaryGravity);
  if (!combo) {
    return refuse('slab load', 'Combination "' + (s.combination || LOAD.primaryGravity) +
      '" is not in LOAD.combinations.');
  }
  const factored = factorPair(dead.exact, live.exact, combo, 'kN/m²');

  return {
    refused: false,
    thicknessMm: s.thicknessMm,
    deadKNPerM2: dead.value,
    liveKNPerM2: live.value,
    serviceKNPerM2: service.value,
    factoredKNPerM2: factored.value,
    /* the unrounded values, for arithmetic downstream. Reported numbers
       round to 3 dp; the sums they feed must not, or a panel of
       9.1875 kN/m² comes back as 110.256 kN instead of 110.25. */
    exact: { dead: dead.exact, live: live.exact,
             service: service.exact, factored: factored.exact },
    combination: { id: combo.id, label: combo.label },
    derivation: {
      dead: dead.derivation,
      live: live.derivation,
      service: service.derivation,
      factored: factored.derivation
    },
    terms: { dead: dead.terms, live: live.terms },
    assumptions: sdl.assumptions,
    notes: []
  };
}

/* γd·DL + γl·LL, printed as one factor when both are equal — which is
   how 1.5(DL + LL) is written on a drawing */
function factorPair(dead, live, combo, unit) {
  if (combo.DL === combo.LL) {
    const sum = dead + live;
    return tally([{ v: combo.DL * sum,
                    note: fac(combo.DL) + ' ' + GLYPH.times + ' ' + num(sum, 3) +
                          ', ' + combo.label }], unit, 3);
  }
  return tally([
    { v: combo.DL * dead, note: fac(combo.DL) + ' ' + GLYPH.times + ' ' + num(dead, 3) + ' dead' },
    { v: combo.LL * live, note: fac(combo.LL) + ' ' + GLYPH.times + ' ' + num(live, 3) + ' imposed' }
  ], unit, 3);
}

/* ---------------------------------------------------------------------
   SLAB TO BEAM — tributary areas by yield line.

   Corner yield lines bisect each corner, so the boundary rises at 45°
   and meets at half the short span. The two short edges carry
   triangles, the two long edges trapezoids, and the four areas add up
   to the panel exactly — which is the property the closure check
   exists to defend.

   This step is geometry only. Loads are applied afterwards, so dead
   and live pass through the same areas without being mixed.
   ------------------------------------------------------------------- */
function panelShares(spec) {
  const s = spec || {};
  let shortMm = s.shortMm, longMm = s.longMm;
  const notes = [];
  if (!(shortMm > 0) || !(longMm > 0)) {
    return refuse('panel distribution', 'A panel needs both a short and a long side in mm.');
  }
  if (shortMm > longMm) {
    const t = shortMm; shortMm = longMm; longMm = t;
    notes.push('Sides were given long-first and have been swapped; the short span is ' +
               num(shortMm / LOAD.units.mmPerM, 3) + ' m.');
  }
  const shortM = shortMm / LOAD.units.mmPerM, longM = longMm / LOAD.units.mmPerM;
  const ratio = longM / shortM;
  const areaM2 = shortM * longM;

  let mode = s.mode;
  if (mode === undefined) {
    mode = ratio >= LOAD.distribution.oneWayRatio ? 'oneWay' : 'twoWay';
  }
  if (['twoWay', 'oneWay', 'cantilever'].indexOf(mode) < 0) {
    return refuse('panel distribution', 'Mode "' + mode +
      '" is not one of twoWay / oneWay / cantilever.');
  }

  /* the four edges, named by the span of the beam that sits on them */
  const ids = ['short-1', 'short-2', 'long-1', 'long-2'];
  const spanOf = { 'short-1': shortM, 'short-2': shortM, 'long-1': longM, 'long-2': longM };
  const edges = ids.map(function (id) {
    return { id: id, edge: id.slice(0, id.indexOf('-')), spanM: rnd(spanOf[id], 4),
             areaM2: 0, shape: 'none', note: 'carries no slab load' };
  });
  function edge(id) { return edges.filter(function (e) { return e.id === id; })[0]; }

  const h = shortM / 2;   // yield lines meet at half the short span
  if (mode === 'twoWay') {
    ['short-1', 'short-2'].forEach(function (id) {
      const e = edge(id);
      e.areaM2 = rnd(shortM * h / 2, 6);
      e.shape = 'triangle';
      e.note = '½ ' + GLYPH.times + ' ' + num(shortM, 3) + ' base ' + GLYPH.times + ' ' +
               num(h, 3) + ' rise at ' + LOAD.distribution.yieldLineDeg + '°';
    });
    ['long-1', 'long-2'].forEach(function (id) {
      const e = edge(id);
      const inner = longM - shortM;
      e.areaM2 = rnd((longM + inner) / 2 * h, 6);
      e.shape = 'trapezoid';
      e.note = '½ ' + GLYPH.times + ' (' + num(longM, 3) + ' + ' + num(inner, 3) + ') ' +
               GLYPH.times + ' ' + num(h, 3) + ' rise at ' + LOAD.distribution.yieldLineDeg + '°';
    });
  } else if (mode === 'oneWay') {
    /* the panel spans the short way, so only the two long edges support
       it — each over half the short span */
    ['long-1', 'long-2'].forEach(function (id) {
      const e = edge(id);
      e.areaM2 = rnd(longM * h, 6);
      e.shape = 'rectangle';
      e.note = num(longM, 3) + ' ' + GLYPH.times + ' ' + num(h, 3) + ' (half the ' +
               num(shortM, 3) + ' m span)';
    });
    notes.push('long/short = ' + num(ratio, 2) + ' ' +
      (s.mode ? 'and one-way was asked for' : GLYPH.minus + ' at or over LOAD.distribution.oneWayRatio of ' +
       num(LOAD.distribution.oneWayRatio, 2)) +
      ', so the panel sheds to the two long edges only.');
  } else {
    if (!s.cantileverEdge) {
      return refuse('panel distribution',
        'A cantilever sheds its whole panel to one support, and which edge that is cannot be ' +
        'derived from the panel size. Name it: cantileverEdge, one of ' + ids.join(' / ') + '.');
    }
    const e = edge(s.cantileverEdge);
    if (!e) {
      return refuse('panel distribution', 'cantileverEdge "' + s.cantileverEdge +
        '" is not one of ' + ids.join(' / ') + '.');
    }
    e.areaM2 = rnd(areaM2, 6);
    e.shape = 'whole panel';
    e.note = 'the whole ' + num(shortM, 3) + ' ' + GLYPH.times + ' ' + num(longM, 3) +
             ' m panel — a cantilever has one support';
    notes.push('Cantilever: the entire panel is carried by ' + e.id + '.');
  }

  const sum = edges.reduce(function (a, e) { return a + e.areaM2; }, 0);
  const errorPct = areaM2 > 0 ? Math.abs(sum - areaM2) / areaM2 * LOAD.units.percent : 0;
  if (errorPct > LOAD.tolerance.closurePct) {
    notes.push('CLOSURE: the shares add to ' + num(sum, 4) + ' m² against a panel of ' +
      num(areaM2, 4) + ' m², out by ' + num(errorPct, 2) + '%.');
  }

  return {
    refused: false,
    mode: mode,
    ratio: rnd(ratio, 4),
    shortSpanM: rnd(shortM, 4),
    longSpanM: rnd(longM, 4),
    areaM2: rnd(areaM2, 4),
    edges: edges,
    closure: { sumAreaM2: rnd(sum, 4), panelAreaM2: rnd(areaM2, 4), errorPct: rnd(errorPct, 4) },
    notes: notes
  };
}

/* the same shares with load on them — the equivalent UDL each beam sees */
function panelToBeams(spec) {
  const s = spec || {};
  const load = s.load || slabLoad(s);
  if (load.refused) return load;
  const shares = panelShares(s);
  if (shares.refused) return shares;

  const w = load.exact || { dead: load.deadKNPerM2, live: load.liveKNPerM2,
                            service: load.serviceKNPerM2, factored: load.factoredKNPerM2 };

  const beams = shares.edges.map(function (e) {
    const dead = e.areaM2 * w.dead, live = e.areaM2 * w.live;
    const service = e.areaM2 * w.service, factored = e.areaM2 * w.factored;
    const udl = e.spanM > 0 ? factored / e.spanM : 0;
    return {
      id: e.id, edge: e.edge, spanM: e.spanM, areaM2: rnd(e.areaM2, 4), shape: e.shape,
      deadKN: rnd(dead, 3), liveKN: rnd(live, 3),
      serviceKN: rnd(service, 3), factoredKN: rnd(factored, 3),
      deadKNPerM: rnd(e.spanM > 0 ? dead / e.spanM : 0, 3),
      liveKNPerM: rnd(e.spanM > 0 ? live / e.spanM : 0, 3),
      serviceKNPerM: rnd(e.spanM > 0 ? service / e.spanM : 0, 3),
      factoredKNPerM: rnd(udl, 3),
      areaDerivation: num(e.areaM2, 4) + ' m² = ' + e.note,
      derivation: num(e.areaM2, 4) + ' m² (' + e.shape + ': ' + e.note + ') ' +
                  GLYPH.times + ' ' + num(w.factored, 3) + ' kN/m² = ' + num(factored, 3) +
                  ' kN, over ' + num(e.spanM, 3) + ' m = ' + num(udl, 3) + ' kN/m'
    };
  });

  const panelService = shares.areaM2 * w.service;
  const panelFactored = shares.areaM2 * w.factored;
  const sumFactored = beams.reduce(function (a, b) { return a + b.factoredKN; }, 0);
  const errorPct = panelFactored > 0
    ? Math.abs(sumFactored - panelFactored) / panelFactored * LOAD.units.percent : 0;

  const notes = shares.notes.slice();
  if (errorPct > LOAD.tolerance.closurePct) {
    notes.push('CLOSURE: the four beam reactions add to ' + num(sumFactored, 3) +
      ' kN against a panel of ' + num(panelFactored, 3) + ' kN, out by ' + num(errorPct, 2) + '%.');
  }
  notes.push('The equivalent UDL is load-equivalent: the beam gets its tributary load spread ' +
    'evenly over its span. It is not the moment-equivalent UDL of a triangular or trapezoidal ' +
    'load, which is a different and slightly smaller number.');

  return {
    refused: false,
    load: load,
    shares: shares,
    beams: beams,
    panel: {
      areaM2: shares.areaM2,
      serviceKN: rnd(panelService, 3),
      factoredKN: rnd(panelFactored, 3),
      derivation: num(w.factored, 3) + ' kN/m² ' + GLYPH.times + ' ' +
                  num(shares.shortSpanM, 3) + ' ' + GLYPH.times + ' ' +
                  num(shares.longSpanM, 3) + ' m = ' + num(panelFactored, 3) + ' kN'
    },
    closure: {
      sumFactoredKN: rnd(sumFactored, 3),
      panelFactoredKN: rnd(panelFactored, 3),
      errorPct: rnd(errorPct, 4),
      tolerancePct: LOAD.tolerance.closurePct,
      ok: errorPct <= LOAD.tolerance.closurePct
    },
    assumptions: load.assumptions,
    notes: notes
  };
}

/* ---------------------------------------------------------------------
   BEAM LINE LOAD — self weight, wall if there is one, and every panel
   share that lands on this beam.
   ------------------------------------------------------------------- */
function beamLine(spec) {
  const s = spec || {};
  const sec = s.section || {};
  if (!(sec.widthMm > 0) || !(sec.depthMm > 0)) {
    return refuse('beam line load', 'A beam needs a width and an overall depth in mm.');
  }
  const g = LOAD.unitWeightKNPerM3.reinforcedConcrete;
  const web = LOAD.path.beamWebOnly ? (s.slabThicknessMm || 0) : 0;
  const dMm = sec.depthMm - web;
  const notes = [], assumptions = [];
  if (dMm <= 0) {
    return refuse('beam line load', 'The slab is as deep as the beam (' + sec.depthMm +
      ' mm overall, ' + web + ' mm slab), so there is no web left to weigh.');
  }
  const areaM2 = (sec.widthMm * dMm) / LOAD.units.mm2PerM2;
  const deadTerms = [{
    v: areaM2 * g,
    note: fac(sec.widthMm) + GLYPH.times + fac(dMm) + ' mm' +
          (LOAD.path.beamWebOnly && web
            ? ' web (' + fac(sec.depthMm) + ' ' + GLYPH.minus + ' ' + fac(web) + ' slab)' : '') +
          ' ' + GLYPH.times + ' ' + g + ' kN/m³'
  }];
  if (LOAD.path.beamWebOnly && web) {
    notes.push('Self weight is the web only, ' + fac(sec.depthMm) + ' ' + GLYPH.minus + ' ' +
      fac(web) + ' mm: the slab panel is taken centre to centre of beams, so the flange strip ' +
      'over this beam is already in the slab load. LOAD.path.beamWebOnly = false counts it twice.');
  }

  if (s.wall) {
    const wt = s.wall.thicknessMm, wh = s.wall.heightMm;
    const key = s.wall.material || 'brickMasonry';
    const gw = LOAD.unitWeightKNPerM3[key];
    if (gw === undefined) {
      return refuse('beam line load', 'Wall material "' + key + '" is not in ' +
        'LOAD.unitWeightKNPerM3 (' + Object.keys(LOAD.unitWeightKNPerM3).join(', ') + ').');
    }
    if (!(wt > 0) || !(wh > 0)) {
      return refuse('beam line load', 'A wall on a beam needs both a thickness and a height in ' +
        'mm. Neither can be derived from the frame, so neither is assumed.');
    }
    deadTerms.push({
      v: (wt / LOAD.units.mmPerM) * (wh / LOAD.units.mmPerM) * gw,
      note: num(wt / LOAD.units.mmPerM, 3) + ' ' + GLYPH.times + ' ' +
            num(wh / LOAD.units.mmPerM, 3) + ' m ' + GLYPH.times + ' ' + gw + ' kN/m³ ' + key
    });
    assumptions.push('Wall ' + wt + ' mm thick and ' + wh + ' mm high on this beam, as given. ' +
      'No opening is deducted.');
  }

  let liveSum = 0;
  const liveTerms = [];
  (s.panels || []).forEach(function (p) {
    /* each entry is one panel share landing on this beam:
       { deadKNPerM, liveKNPerM, note } — normally from panelToBeams */
    if (p.deadKNPerM) deadTerms.push({ v: p.deadKNPerM, note: p.note || 'slab share, dead' });
    if (p.liveKNPerM) {
      liveTerms.push({ v: p.liveKNPerM, note: p.note || 'slab share, imposed' });
      liveSum += p.liveKNPerM;
    }
  });

  const dead = tally(deadTerms, 'kN/m', 3);
  const live = liveTerms.length ? tally(liveTerms, 'kN/m', 3)
                                : tally([{ v: 0, note: 'no slab share given' }], 'kN/m', 3);
  const combo = combinationById(s.combination || LOAD.primaryGravity);
  const service = tally([{ v: dead.exact, note: 'dead' }, { v: live.exact, note: 'imposed' }],
                        'kN/m', 3);
  const factored = factorPair(dead.exact, live.exact, combo, 'kN/m');

  const spanM = s.spanMm ? s.spanMm / LOAD.units.mmPerM : null;
  return {
    refused: false,
    spanM: spanM === null ? null : rnd(spanM, 4),
    deadKNPerM: dead.value,
    liveKNPerM: live.value,
    serviceKNPerM: service.value,
    factoredKNPerM: factored.value,
    exact: { dead: dead.exact, live: live.exact,
             service: service.exact, factored: factored.exact },
    combination: { id: combo.id, label: combo.label },
    totalFactoredKN: spanM === null ? null : rnd(factored.exact * spanM, 3),
    derivation: { dead: dead.derivation, live: live.derivation,
                  service: service.derivation, factored: factored.derivation },
    assumptions: assumptions,
    notes: notes
  };
}

/* ---------------------------------------------------------------------
   BEAM TO COLUMN — a symmetric load on a single span puts half at each
   end. Exact statics, no continuity redistribution; the note says so.
   ------------------------------------------------------------------- */
function beamEndReaction(line, spanMm) {
  const spanM = spanMm / LOAD.units.mmPerM;
  const share = LOAD.path.beamEndShare;
  const w = line.exact || { dead: line.deadKNPerM, live: line.liveKNPerM };
  const dead = share * w.dead * spanM;
  const live = share * w.live * spanM;
  return {
    deadKN: rnd(dead, 3),
    liveKN: rnd(live, 3),
    exact: { dead: dead, live: live },
    derivation: fac(share) + ' ' + GLYPH.times + ' (' + num(w.dead, 3) + ' + ' +
                num(w.live, 3) + ') kN/m ' + GLYPH.times + ' ' + num(spanM, 3) +
                ' m = ' + num(dead, 3) + ' kN dead + ' + num(live, 3) + ' kN imposed'
  };
}

/* ---------------------------------------------------------------------
   COLUMN AXIAL — accumulating down the stack, plus its own weight.
   ------------------------------------------------------------------- */
function columnStack(spec) {
  const s = spec || {};
  const storeys = s.storeys;   // top-down or bottom-up? given bottom-up, index 0 lowest
  if (!Array.isArray(storeys) || !storeys.length) {
    return refuse('column axial', 'columnStack needs a storeys array, one entry per storey, ' +
      'lowest first.');
  }
  const selfKN = s.selfWeightKNPerStorey;
  if (selfKN === undefined) {
    return refuse('column axial', 'The column\'s own weight per storey was not given. ' +
      'memberSelfWeight(\'column\', concrete) computes it from the frame geometry.');
  }
  const out = [];
  let dead = 0, live = 0;
  for (let f = storeys.length - 1; f >= 0; f--) {
    const st = storeys[f];
    dead += (st.deadKN || 0) + selfKN;
    live += (st.liveKN || 0);
    out.unshift({
      storey: f,
      floorDeadKN: rnd(st.deadKN || 0, 3),
      floorLiveKN: rnd(st.liveKN || 0, 3),
      selfWeightKN: rnd(selfKN, 3),
      deadKN: rnd(dead, 3),
      liveKN: rnd(live, 3),
      derivation: 'storey ' + f + ': ' + num(st.deadKN || 0, 3) + ' kN beam reactions + ' +
                  num(selfKN, 3) + ' kN column, running total ' + num(dead, 3) + ' kN dead + ' +
                  num(live, 3) + ' kN imposed'
    });
  }
  const notes = [];
  if (!LOAD.path.liveLoadReductionApplied) {
    notes.push('No imposed-load reduction has been taken. IS 875 Part 2 cl 3.2 permits one on a ' +
      'column carrying several floors; LOAD.path.liveLoadReductionApplied is false, so the full ' +
      'imposed load is carried down.');
  }
  return { refused: false, storeys: out, baseDeadKN: rnd(dead, 3), baseLiveKN: rnd(live, 3),
           notes: notes };
}

/* ---------------------------------------------------------------------
   FOOTING LOAD — column axial at the base, the footing's own weight,
   and the soil sitting on it.

   Soil unit weight and founding depth are site values with no default
   anywhere in this module. Without them the overburden term is refused
   and named, never taken as zero quietly.
   ------------------------------------------------------------------- */
function footingLoad(spec) {
  const s = spec || {};
  const f = s.footing || {};
  if (!(f.lengthMm > 0) || !(f.widthMm > 0) || !(f.depthMm > 0)) {
    return refuse('footing load', 'A footing needs a length, a width and a depth in mm.');
  }
  if (s.columnDeadKN === undefined || s.columnLiveKN === undefined) {
    return refuse('footing load', 'The column axial at the base was not given. It comes from ' +
      'columnStack().baseDeadKN / baseLiveKN.');
  }
  const own = memberSelfWeight('footing', f);
  const deadTerms = [
    { v: s.columnDeadKN, note: 'column axial at base, dead' },
    { v: own.kN, note: 'footing self weight' }
  ];
  const notes = [], assumptions = [];
  let overburden = null;

  if (s.soil && s.soil.unitWeightKNPerM3 > 0 && s.soil.foundingDepthMm > 0) {
    const soilDepthMm = s.soil.foundingDepthMm - f.depthMm;
    if (soilDepthMm < 0) {
      return refuse('footing load', 'The footing is ' + f.depthMm + ' mm deep but founded at ' +
        s.soil.foundingDepthMm + ' mm, so it stands above ground. Check the founding depth.');
    }
    const colArea = (s.column && s.column.widthMm > 0 && s.column.depthMm > 0)
      ? s.column.widthMm * s.column.depthMm : 0;
    const planM2 = (f.lengthMm * f.widthMm - colArea) / LOAD.units.mm2PerM2;
    const hM = soilDepthMm / LOAD.units.mmPerM;
    const v = planM2 * hM * s.soil.unitWeightKNPerM3;
    overburden = {
      kN: rnd(v, 3),
      derivation: num(planM2, 4) + ' m² ' + GLYPH.times + ' ' + num(hM, 3) + ' m ' +
                  GLYPH.times + ' ' + s.soil.unitWeightKNPerM3 + ' kN/m³ soil = ' + num(v, 3) + ' kN'
    };
    deadTerms.push({ v: v, note: 'soil overburden, ' + num(hM, 3) + ' m of fill at ' +
                                 s.soil.unitWeightKNPerM3 + ' kN/m³' });
    assumptions.push('Soil unit weight ' + s.soil.unitWeightKNPerM3 + ' kN/m³ and founding depth ' +
      s.soil.foundingDepthMm + ' mm, both as given. Neither has a default in LOAD.');
  } else {
    overburden = refuse('soil overburden',
      'No soil unit weight and founding depth were given, so the fill sitting on the footing is ' +
      'NOT in this total. LOAD has no default for either — they are site values. Supply ' +
      'soil: { unitWeightKNPerM3, foundingDepthMm }.');
    notes.push(overburden.reason);
  }

  const dead = tally(deadTerms, 'kN', 3);
  const live = tally([{ v: s.columnLiveKN, note: 'column axial at base, imposed' }], 'kN', 3);
  const service = tally([{ v: dead.exact, note: 'dead' }, { v: live.exact, note: 'imposed' }],
                        'kN', 3);
  const combo = combinationById(s.combination || LOAD.primaryGravity);
  const factored = factorPair(dead.exact, live.exact, combo, 'kN');

  return {
    refused: false,
    deadKN: dead.value,
    liveKN: live.value,
    serviceKN: service.value,
    factoredKN: factored.value,
    selfWeightKN: own.kN,
    overburden: overburden,
    combination: { id: combo.id, label: combo.label },
    derivation: { dead: dead.derivation, live: live.derivation,
                  service: service.derivation, factored: factored.derivation,
                  selfWeight: own.derivation },
    assumptions: assumptions,
    notes: notes
  };
}

/* ---------------------------------------------------------------------
   COMBINATIONS — every case in Table 18, and the envelope.
   ------------------------------------------------------------------- */
function combine(spec) {
  const s = spec || {};
  const d = { DL: s.DL || 0, LL: s.LL || 0, EL: s.EL || 0, WL: s.WL || 0 };
  const unit = s.unit || 'kN';
  const only = s.limitState;
  const list = LOAD.combinations.filter(function (c) {
    return only === undefined || c.limitState === only;
  });
  if (!list.length) {
    return refuse('load combination', 'No combination in LOAD.combinations has limit state "' +
      only + '".');
  }
  const cases = list.map(function (c) {
    const terms = ['DL', 'LL', 'EL', 'WL']
      .filter(function (k) { return c[k] !== 0 && d[k] !== 0; })
      .map(function (k) {
        return { v: c[k] * d[k], note: fac(c[k]) + ' ' + GLYPH.times + ' ' + num(d[k], 3) + ' ' + k };
      });
    const t = terms.length ? tally(terms, unit, 3)
                           : tally([{ v: 0, note: 'no load in this case' }], unit, 3);
    return {
      id: c.id, label: c.label, limitState: c.limitState, clause: 'IS 456 Table 18',
      factors: { DL: c.DL, LL: c.LL, EL: c.EL, WL: c.WL },
      value: t.value, exact: t.exact, derivation: t.derivation
    };
  });

  let hi = cases[0], lo = cases[0];
  cases.forEach(function (c) {
    if (c.exact > hi.exact) hi = c;
    if (c.exact < lo.exact) lo = c;
  });

  return {
    refused: false,
    demand: { DL: rnd(d.DL, 3), LL: rnd(d.LL, 3), EL: rnd(d.EL, 3), WL: rnd(d.WL, 3) },
    unit: unit,
    cases: cases,
    envelope: {
      maxValue: hi.value, maxCase: hi.id, maxLabel: hi.label,
      minValue: lo.value, minCase: lo.id, minLabel: lo.label,
      derivation: 'governing ' + hi.id + ', ' + hi.label + ': ' + hi.derivation +
                  (lo.exact < 0 ? '  |  reversal ' + lo.id + ', ' + lo.label + ': ' +
                                  lo.derivation : '')
    }
  };
}

/* the largest value per member across a set of combined results —
   `byMember` maps a member id to a combine() result */
function envelopeAcross(byMember) {
  const out = {};
  Object.keys(byMember || {}).forEach(function (id) {
    const r = byMember[id];
    if (!r || r.refused) { out[id] = r; return; }
    out[id] = {
      maxValue: r.envelope.maxValue, maxCase: r.envelope.maxCase,
      minValue: r.envelope.minValue, minCase: r.envelope.minCase,
      unit: r.unit, derivation: r.envelope.derivation
    };
  });
  return out;
}

/* ---------------------------------------------------------------------
   BUILDING LOADS — the whole path, walked on the frame the schedule
   already used.

   THE DOCUMENTED SEAM. This is the one function that turns a frame()
   result plus an occupancy into member demands. A stiffness solution
   (src/solve.js, Stage 7) is meant to replace the statics inside it
   while keeping this signature and this return shape, so src/design.js
   never learns where its demands came from.
   ------------------------------------------------------------------- */
function roleConcrete(frameOut, role) {
  const m = (frameOut.members || []).filter(function (x) { return x.frameRole === role; })[0];
  return m ? m.concrete : null;
}

function buildingLoads(frameOut, spec) {
  const s = spec || {};
  if (!frameOut || !frameOut.grid) {
    return refuse('building loads', 'buildingLoads needs a frame() result — it reads the grid, ' +
      'the storey height and the member sizes from it rather than being told them twice.');
  }
  const grid = frameOut.grid;
  const gx = grid.xMm || [], gz = grid.zMm || [];
  const floors = grid.floors, H = grid.floorHeightMm;
  const slab = roleConcrete(frameOut, 'slab');
  const beam = roleConcrete(frameOut, 'beam');
  const col = roleConcrete(frameOut, 'column');
  const foot = roleConcrete(frameOut, 'footing');
  /* the grid comes first: a single line of columns has no panel to
     shed load from, which is the more useful thing to be told */
  if (gx.length < 2 || gz.length < 2) {
    return refuse('building loads', 'The grid has no panel: it needs at least one bay each way.');
  }
  if (!slab || !beam || !col) {
    return refuse('building loads', 'The frame has no ' +
      [!slab && 'slab', !beam && 'beam', !col && 'column'].filter(Boolean).join('/') +
      ' to load. A load path needs all three.');
  }

  const notes = [], assumptions = [];
  const occFor = function (f) {
    return Array.isArray(s.occupancy) ? s.occupancy[f] : s.occupancy;
  };
  if (Array.isArray(s.occupancy) && s.occupancy.length !== floors) {
    return refuse('building loads', 'occupancy was given as ' + s.occupancy.length +
      ' entries for ' + floors + ' floors.');
  }
  notes.push('The top floor carries the same occupancy as the rest. IS 875 Part 2 gives a roof ' +
    'its own imposed load, which is not in LOAD.liveKNPerM2; pass occupancy as an array per ' +
    'floor to set it explicitly.');
  notes.push('Reactions are statically determinate — half of each beam line to each end node. ' +
    'No continuity redistribution and no frame stiffness are involved.');

  const nodeKey = function (i, j) { return i + ',' + j; };
  /* nodes[key].storeys[f] = { deadKN, liveKN } */
  const nodes = {};
  for (let i = 0; i < gx.length; i++) {
    for (let j = 0; j < gz.length; j++) {
      const st = [];
      for (let f = 0; f < floors; f++) st.push({ deadKN: 0, liveKN: 0 });
      nodes[nodeKey(i, j)] = { i: i, j: j, xMm: gx[i], zMm: gz[j], storeys: st };
    }
  }

  const floorsOut = [];
  for (let f = 0; f < floors; f++) {
    const occ = occFor(f);
    const load = slabLoad({ thicknessMm: slab.thicknessMm, occupancy: occ,
                            liveKNPerM2: s.liveKNPerM2, sdl: s.sdl,
                            extraDeadKNPerM2: s.extraDeadKNPerM2 });
    if (load.refused) return load;
    load.assumptions.forEach(function (a) {
      if (assumptions.indexOf(a) < 0) assumptions.push(a);
    });

    /* beam lines, keyed by direction and grid position. The tributary
       widths are centre to centre, so the beam self weight is the web
       only and the frame's concrete is counted exactly once. */
    const lines = {};
    const lineKey = function (dir, a, b) { return dir + ':' + a + ':' + b; };
    for (let i = 0; i < gx.length - 1; i++)
      for (let j = 0; j < gz.length; j++)
        lines[lineKey('X', i, j)] = { dir: 'X', i: i, j: j,
          ccMm: gx[i + 1] - gx[i], clearMm: gx[i + 1] - gx[i] - col.widthMm,
          shares: [], ends: [[i, j], [i + 1, j]] };
    for (let i = 0; i < gx.length; i++)
      for (let j = 0; j < gz.length - 1; j++)
        lines[lineKey('Y', i, j)] = { dir: 'Y', i: i, j: j,
          ccMm: gz[j + 1] - gz[j], clearMm: gz[j + 1] - gz[j] - col.depthMm,
          shares: [], ends: [[i, j], [i, j + 1]] };

    /* every panel, distributed by yield line onto its four beams */
    const panels = [];
    for (let i = 0; i < gx.length - 1; i++) {
      for (let j = 0; j < gz.length - 1; j++) {
        const xMm = gx[i + 1] - gx[i], zMm = gz[j + 1] - gz[j];
        const dist = panelToBeams({ shortMm: Math.min(xMm, zMm), longMm: Math.max(xMm, zMm),
                                    load: load });
        if (dist.refused) return dist;
        /* which physical beam each named edge belongs to: a "short-n"
           edge runs along whichever direction is short */
        const xIsShort = xMm <= zMm;
        const map = xIsShort
          ? { 'short-1': lineKey('X', i, j),     'short-2': lineKey('X', i, j + 1),
              'long-1':  lineKey('Y', i, j),     'long-2':  lineKey('Y', i + 1, j) }
          : { 'long-1':  lineKey('X', i, j),     'long-2':  lineKey('X', i, j + 1),
              'short-1': lineKey('Y', i, j),     'short-2': lineKey('Y', i + 1, j) };
        dist.beams.forEach(function (b) {
          const key = map[b.id];
          if (!lines[key]) return;
          lines[key].shares.push({
            deadKNPerM: b.deadKNPerM, liveKNPerM: b.liveKNPerM,
            note: 'panel P' + (i + 1) + '-' + (j + 1) + ' ' + b.shape + ', ' + b.areaM2 + ' m²'
          });
        });
        panels.push({ id: 'P' + (i + 1) + '-' + (j + 1), i: i, j: j,
                      shortSpanM: dist.shares.shortSpanM, longSpanM: dist.shares.longSpanM,
                      mode: dist.shares.mode, factoredKN: dist.panel.factoredKN,
                      closure: dist.closure, derivation: dist.panel.derivation,
                      beams: dist.beams });
      }
    }

    /* the beam lines, then their end reactions into the nodes */
    const perimeterX = function (l) { return l.j === 0 || l.j === gz.length - 1; };
    const perimeterY = function (l) { return l.i === 0 || l.i === gx.length - 1; };
    const wallOn = (s.wall && s.wall.on) || 'none';
    if (!s.wall) {
      notes.push('No wall load is on any beam. Give wall: { thicknessMm, heightMm, on: ' +
        '"perimeter" | "all" } to add one — the frame does not say where the walls are.');
    }

    const beamsOut = [];
    Object.keys(lines).forEach(function (key) {
      const l = lines[key];
      const onPerimeter = l.dir === 'X' ? perimeterX(l) : perimeterY(l);
      const wall = (wallOn === 'all' || (wallOn === 'perimeter' && onPerimeter)) ? s.wall : null;
      const line = beamLine({
        section: { widthMm: beam.widthMm, depthMm: beam.depthMm },
        slabThicknessMm: slab.thicknessMm,
        spanMm: l.ccMm,
        panels: l.shares,
        wall: wall
      });
      if (line.refused) { notes.push(line.reason); return; }
      line.assumptions.forEach(function (a) {
        if (assumptions.indexOf(a) < 0) assumptions.push(a);
      });
      const r = beamEndReaction(line, l.ccMm);
      l.ends.forEach(function (e) {
        const n = nodes[nodeKey(e[0], e[1])];
        n.storeys[f].deadKN += r.exact.dead;
        n.storeys[f].liveKN += r.exact.live;
      });
      beamsOut.push({
        id: l.dir + (l.i + 1) + '-' + (l.j + 1), dir: l.dir,
        ccSpanM: rnd(l.ccMm / LOAD.units.mmPerM, 4),
        clearSpanM: rnd(l.clearMm / LOAD.units.mmPerM, 4),
        onPerimeter: onPerimeter,
        deadKNPerM: line.deadKNPerM, liveKNPerM: line.liveKNPerM,
        serviceKNPerM: line.serviceKNPerM, factoredKNPerM: line.factoredKNPerM,
        endReaction: r,
        derivation: line.derivation
      });
    });

    floorsOut.push({
      index: f, levelMm: (f + 1) * H, occupancy: occ,
      slab: load, panels: panels, beams: beamsOut
    });
  }

  /* columns down the stack, then the footings */
  const colSelf = memberSelfWeight('column', col);
  const columnsOut = [], footingsOut = [];
  Object.keys(nodes).forEach(function (key) {
    const n = nodes[key];
    const stack = columnStack({ storeys: n.storeys, selfWeightKNPerStorey: colSelf.kN });
    if (stack.refused) { notes.push(stack.reason); return; }
    stack.notes.forEach(function (x) { if (notes.indexOf(x) < 0) notes.push(x); });
    columnsOut.push({
      node: { i: n.i, j: n.j, xMm: n.xMm, zMm: n.zMm },
      selfWeightKNPerStorey: colSelf.kN,
      selfWeightDerivation: colSelf.derivation,
      storeys: stack.storeys,
      baseDeadKN: stack.baseDeadKN, baseLiveKN: stack.baseLiveKN,
      combinations: combine({ DL: stack.baseDeadKN, LL: stack.baseLiveKN, unit: 'kN' })
    });
    if (!foot) return;
    const fl = footingLoad({
      footing: foot, column: col,
      columnDeadKN: stack.baseDeadKN, columnLiveKN: stack.baseLiveKN,
      soil: s.soil
    });
    if (fl.refused) { notes.push(fl.reason); return; }
    fl.notes.forEach(function (x) { if (notes.indexOf(x) < 0) notes.push(x); });
    fl.assumptions.forEach(function (a) { if (assumptions.indexOf(a) < 0) assumptions.push(a); });
    footingsOut.push({
      node: { i: n.i, j: n.j, xMm: n.xMm, zMm: n.zMm },
      serviceKN: fl.serviceKN, factoredKN: fl.factoredKN,
      deadKN: fl.deadKN, liveKN: fl.liveKN,
      selfWeightKN: fl.selfWeightKN, overburden: fl.overburden,
      derivation: fl.derivation
    });
  });
  if (!foot) {
    notes.push('The frame has no footing, so nothing was carried below the columns.');
  }

  return {
    refused: false,
    grid: { xMm: gx, zMm: gz, floors: floors, floorHeightMm: H },
    selfWeight: memberSelfWeights(frameOut),
    floors: floorsOut,
    columns: columnsOut,
    footings: footingsOut,
    assumptions: assumptions,
    notes: notes
  };
}

/* ------------------------------------------------------------------- */
const LOADS = {
  LOAD: LOAD,
  slabLoad: slabLoad,
  panelShares: panelShares,
  panelToBeams: panelToBeams,
  beamLine: beamLine,
  beamEndReaction: beamEndReaction,
  columnStack: columnStack,
  footingLoad: footingLoad,
  memberSelfWeight: memberSelfWeight,
  memberSelfWeights: memberSelfWeights,
  combine: combine,
  envelopeAcross: envelopeAcross,
  buildingLoads: buildingLoads,
  helpers: { rnd: rnd, num: num, tally: tally, combinationById: combinationById }
};

if (typeof module !== 'undefined' && module.exports) module.exports = LOADS;
