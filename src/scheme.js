'use strict';

/* =====================================================================
   SCHEME — four ways of partitioning a frame into rooms, and the
   exterior massing of the one that gets picked.

   Pure logic. No DOM, no window, no third-party code, requireable in
   Node. Everything is millimetres, matching the rest of this repo, and
   the axes match the cage and the frame: x across the building, y up,
   z along it.

   The buildable envelope is NOT re-derived from a plot and setbacks —
   it is the extent of the structural grid that has already been
   scheduled, so the plan and the steel describe one building.
   ===================================================================== */

/* ---------------------------------------------------------------------
   ROOM — every dimension the packer honours. Minimums are the sizes a
   room stops being usable below, not code minima; they live here so none
   of them is written at a call site.
   ------------------------------------------------------------------- */
const ROOM = {
  /* [short, long] usable side, mm */
  minMm: {
    'Living':        [3350, 3350], 'Dining':  [2600, 2450], 'Kitchen': [2300, 2600],
    'Bedroom':       [3050, 3050], 'Master Bedroom': [3350, 3500],
    'Toilet':        [1160, 1830], 'Stair':   [1980, 2590], 'Utility': [1070, 1220],
    'Foyer':         [1070, 1220], 'Puja':    [1070, 1070], 'Balcony': [1220, 1370],
    'Store':         [910, 1070],  'Court':   [1520, 1520], 'Passage': [910, 1520],
    'Study':         [2440, 2440], 'Wash':    [1070, 1220], 'Terrace': [1830, 1830],
    'Landing':       [1070, 1220], 'Family':  [2590, 2590]
  },
  fallbackMinMm: [910, 910],
  open: ['Balcony', 'Court', 'Terrace', 'Porch', 'Deck', 'Parking'],
  wet:  ['Toilet', 'Kitchen', 'Utility', 'Wash'],

  /* service elements get real fixed sizes and shrink only on tight
     plots; living space absorbs the remainder, which is what keeps the
     proportions sane */
  service: {
    stairWidth: 2590, toiletWidth: 1675, toiletDepth: 2130, utilityDepth: 1370,
    pujaWidth: 1370, balconyDepth: 1520, passageWidth: 1065, kitchenWidth: 3350,
    bedroomWidth: 3810, rearServiceDepth: 1830,
    referenceWidth: 7620,      // the width at which services are full size
    minScale: 0.70
  },

  limits: {
    narrowWidthMm: 6100,       // below this a floor is single-loaded
    relaxTightMm: 6100, relaxSnugMm: 7315,
    relaxTight: 0.82, relaxSnug: 0.92,
    reliefFloor: 0.72,         // a fixed service may shrink to this fraction
    bedBandMinMm: 3200, bedBandMaxMm: 4270, bedBandFraction: 0.33,
    serviceBandMm: 2740
  },

  carpetFraction: 0.82,
  sqftPerSqm: 10.7639
};

/* ---------------------------------------------------------------------
   EXT — how the exterior is massed. Depiction only: none of it changes a
   room area or a bar length.
   ------------------------------------------------------------------- */
const EXT = {
  plinthMm: 450, wallMm: 230, bandMm: 300,
  sillMm: 750, headMm: 2100,          // glazing band on the street face
  parapetMm: 900, skillionRiseMm: 1400,
  porchWidthMm: 3600, porchProjectionMm: 2400,
  finCount: 14, finDepthMm: 180,
  slatCount: 7
};

function base(n) { return String(n).replace(/\s*\d+$/, '').trim(); }
function isOpen(n) { return ROOM.open.indexOf(base(n)) >= 0; }
function isWet(n) { return ROOM.wet.indexOf(base(n)) >= 0; }
function minFor(n) { return ROOM.minMm[base(n)] || ROOM.fallbackMinMm; }

/* --- layout DSL, the same shape as the prototype's ------------------
   BD/BDF  band, proportional or fixed depth
   C/CF    column, proportional or fixed width
   ST/STF  column split into rows
   rw/rf   row, proportional or fixed depth
  ------------------------------------------------------------------- */
function BD(d, cols) { return { d: d, cols: cols }; }
function BDF(fd, cols) { return { fd: fd, cols: cols }; }
function C(n, w) { return { n: n, w: w }; }
function CF(n, fw) { return { n: n, fw: fw }; }
function ST(w, rows) { return { w: w, rows: rows }; }
function STF(fw, rows) { return { fw: fw, rows: rows }; }
function rw(n, d) { return { n: n, d: d }; }
function rf(n, fd) { return { n: n, fd: fd }; }

function kit(widthMm) {
  const s = ROOM.service;
  const k = Math.max(s.minScale, Math.min(1, widthMm / s.referenceWidth));
  const r = function (v) { return Math.round(v * k); };
  return {
    k: k,
    SW: r(s.stairWidth), TW: r(s.toiletWidth), TD: r(s.toiletDepth),
    UD: r(s.utilityDepth), PW: r(s.pujaWidth), BLD: r(s.balconyDepth),
    PASS: r(s.passageWidth), KW: r(s.kitchenWidth),
    BEDW: Math.round(Math.min(s.bedroomWidth * k,
            Math.max(2900 * k, widthMm - s.bedroomWidth)))
  };
}

/* bedrooms per floor */
function program(beds, floors) {
  if (floors <= 1) return [beds];
  if (floors === 2) { const g = beds >= 3 ? 1 : 0; return [g, beds - g]; }
  const g = beds >= 4 ? 1 : 0, rest = beds - g, a = Math.ceil(rest / 2);
  const out = [g, a, rest - a];
  while (out.length < floors) out.push(0);
  return out;
}

function dispenser(ctx, i) {
  let left = ctx.perFloor[i] || 0;
  return function (master, fallback) {
    if (left > 0) {
      left--;
      if (master) return 'Master Bedroom';
      ctx.count++; return 'Bedroom ' + ctx.count;
    }
    return fallback || 'Study';
  };
}

/* a narrow floor cannot take rooms side by side */
function narrowPlan(ctx, i, variant) {
  const d = ctx.kit, b = dispenser(ctx, i), stairFirst = (variant % 2) === 1;
  if (i === 0) {
    const mid = stairFirst
      ? BD(1.5, [CF('Stair', d.SW), C('Dining', 1)])
      : BD(1.5, [C('Dining', 1), CF('Stair', d.SW)]);
    return [
      BD(2.9, [C('Living', 1)]),
      mid,
      BD(2.4, [C(b(false, 'Study'), 1), CF('Toilet 1', d.TW)]),
      BD(2.2, [C('Kitchen', 1), CF('Utility', d.UD)])
    ];
  }
  return [
    BDF(d.BLD, [C('Balcony', 1)]),
    BD(2.6, [C(b(true, 'Family'), 1)]),
    BD(1.6, [CF('Stair', d.SW), C('Family', 1)]),
    BD(2.5, [C(b(false, 'Terrace'), 1), CF('Toilet', d.TW)])
  ];
}

/* upper floors, driven by how many bedroom bands the depth can hold */
function upper(ctx, i, style) {
  const d = ctx.kit, b = dispenser(ctx, i), L = ROOM.limits;
  const BEDD = Math.max(L.bedBandMinMm, Math.min(L.bedBandMaxMm, ctx.depthMm * L.bedBandFraction));
  const strip = Math.max(d.BLD, d.TD);
  const svc = ctx.rental ? 'Kitchen' : 'Store';
  const avail = ctx.depthMm - strip;
  const nBed = Math.max(1, Math.min(2, Math.floor((avail - L.serviceBandMm) / BEDD)));

  const out = [BDF(strip, [C('Balcony', 1), CF('Toilet', d.TW)])];
  out.push(BDF(BEDD, [C(b(true, 'Family'), 1), CF(b(false, 'Study'), d.BEDW)]));
  if (nBed > 1) out.push(BDF(BEDD, [C(b(false, 'Family'), 1), CF('Toilet', d.TW)]));
  if (style === 'court' && avail - nBed * BEDD > 5180)
    out.push(BDF(Math.max(2440, ctx.depthMm * 0.15),
      [C('Court', 1), C('Family', 1.7), CF('Toilet', d.TW)]));

  const rear = [ST(1, [rw(b(false, 'Family'), 1), rf(svc, ROOM.service.rearServiceDepth)])];
  if (style === 'spine') rear.push(CF('Passage', d.PASS));
  rear.push(STF(d.TW, [rf('Toilet', d.TD), rw('Store', 1)]));
  const stairCol = STF(d.SW, [rw('Stair', 1), rf('Wash', d.UD)]);
  if (style === 'rear') rear.unshift(stairCol); else rear.push(stairCol);
  out.push(BD(1, rear));
  return out;
}

/* =========== the four strategies ============
   Services pack toward one edge; flip mirrors the whole plan.
   ============================================ */
const SCHEMES = [
  {
    id: 'A1', name: 'Linear Core', facade: 'skillion',
    tag: 'Stair mid-right, kitchen rear. The default plan.',
    floor: function (ctx, i) {
      if (ctx.narrow) return narrowPlan(ctx, i, 0);
      const d = ctx.kit, b = dispenser(ctx, i);
      if (i === 0) return [
        BD(2.7, [C('Living', 1), CF(b(false, 'Study'), d.BEDW)]),
        BD(1.7, [C('Dining', 1), CF('Toilet 1', d.TW), CF('Stair', d.SW)]),
        BD(2.7, [STF(d.KW, [rw('Kitchen', 1), rf('Utility', d.UD)]),
                 C('Family', 1), STF(d.PW, [rf('Puja', 1520), rw('Store', 1)])])
      ];
      return upper(ctx, i, 'core');
    }
  },
  {
    id: 'A2', name: 'Side Spine', facade: 'screen',
    tag: 'Circulation spine on the blind edge. No dead passages.',
    floor: function (ctx, i) {
      if (ctx.narrow) return narrowPlan(ctx, i, 1);
      const d = ctx.kit, b = dispenser(ctx, i);
      if (i === 0) return [
        BD(2.6, [C('Living', 1), STF(d.SW, [rf('Foyer', 1370), rw('Stair', 1)])]),
        BD(1.7, [C('Dining', 1), CF('Passage', d.PASS), CF('Toilet 1', d.TW)]),
        BD(2.4, [C(b(false, 'Family'), 1), STF(d.KW, [rw('Kitchen', 1), rf('Utility', d.UD)])])
      ];
      return upper(ctx, i, 'spine');
    }
  },
  {
    id: 'A3', name: 'Light Court', facade: 'terrace',
    tag: 'Court cut into the middle band — light and cross-vent on deep plans.',
    floor: function (ctx, i) {
      if (ctx.narrow) return narrowPlan(ctx, i, 2);
      const d = ctx.kit, b = dispenser(ctx, i);
      if (i === 0) return [
        BD(2.6, [C('Living', 1), CF('Stair', d.SW)]),
        BDF(Math.max(2440, ctx.depthMm * 0.18),
            [C('Court', 1), C('Dining', 1.7), CF('Toilet 1', d.TW)]),
        BD(2.4, [C(b(false, 'Family'), 1), STF(d.KW, [rw('Kitchen', 1), rf('Utility', d.UD)])])
      ];
      return upper(ctx, i, 'court');
    }
  },
  {
    id: 'A4', name: 'Rear Stair', facade: 'box',
    tag: 'Full-width living at the road. Stair and services pushed to the rear.',
    floor: function (ctx, i) {
      if (ctx.narrow) return narrowPlan(ctx, i, 3);
      const d = ctx.kit, b = dispenser(ctx, i);
      if (i === 0) return [
        BD(2.5, [C('Living', 1)]),
        BD(2.1, [C('Dining', 1), CF(b(false, 'Study'), d.BEDW), CF('Toilet 1', d.TW)]),
        BD(2.2, [STF(d.KW, [rw('Kitchen', 1), rf('Utility', d.UD)]),
                 C('Family', 1), CF('Stair', d.SW)])
      ];
      return upper(ctx, i, 'rear');
    }
  }
];

/* --- packing ------------------------------------------------------
   A fixed service may shrink when the proportional neighbour would
   otherwise fall under its minimum. That single relief pass is what
   keeps tight plans buildable.
  ------------------------------------------------------------------ */
function relief(items, total, fixedKey, minOf) {
  let fx = 0, need = 0;
  items.forEach(function (it) {
    if (it[fixedKey]) fx += it[fixedKey]; else need += minOf(it);
  });
  if (fx > 0 && total - fx < need) {
    const want = Math.max(fx * ROOM.limits.reliefFloor, total - need);
    const f = want / fx;
    items.forEach(function (it) { if (it[fixedKey]) it['_' + fixedKey] = it[fixedKey] * f; });
    return want;
  }
  items.forEach(function (it) { if (it[fixedKey]) it['_' + fixedKey] = it[fixedKey]; });
  return fx;
}
function minSide(n) { const m = minFor(n); return Math.min(m[0], m[1]); }
function colMin(c) {
  return c.rows
    ? Math.max.apply(null, c.rows.map(function (r) { return minFor(r.n)[0]; }))
    : minFor(c.n)[0];
}

function packFloor(bands, widthMm, depthMm, relax) {
  const rooms = [];
  let y = 0, fixedD = 0, wsum = 0;
  bands.forEach(function (b) { if (b.fd) fixedD += b.fd; else wsum += b.d; });
  bands.forEach(function (b) {
    const dep = b.fd ? b.fd : Math.max(0, depthMm - fixedD) * b.d / wsum;
    const fixedW = relief(b.cols, widthMm, 'fw', colMin);
    let csum = 0;
    b.cols.forEach(function (c) { if (!c.fw) csum += c.w; });
    let x = 0;
    b.cols.forEach(function (c) {
      const wid = c.fw ? c._fw : Math.max(0, widthMm - fixedW) * c.w / csum;
      if (c.rows) {
        const fr = relief(c.rows, dep, 'fd', function (r) { return minSide(r.n); });
        let rs = 0;
        c.rows.forEach(function (r) { if (!r.fd) rs += r.d; });
        let yy = y;
        c.rows.forEach(function (r) {
          const dd = r.fd ? r._fd : Math.max(0, dep - fr) * r.d / rs;
          rooms.push(mkRoom(r.n, x, yy, wid, dd, relax)); yy += dd;
        });
      } else rooms.push(mkRoom(c.n, x, y, wid, dep, relax));
      x += wid;
    });
    y += dep;
  });
  return rooms;
}

function mkRoom(n, x, y, w, d, relax) {
  const rx = relax || 1, m0 = minFor(n);
  const m = [m0[0] * rx, m0[1] * rx];
  const fits = (w >= m[0] - 25 && d >= m[1] - 25) || (w >= m[1] - 25 && d >= m[0] - 25);
  return {
    n: n, xMm: Math.round(x), yMm: Math.round(y),
    widthMm: Math.round(w), depthMm: Math.round(d),
    areaM2: +(w * d / 1e6).toFixed(2),
    open: isOpen(n), wet: isWet(n), tight: !fits,
    minMm: [Math.round(m[0]), Math.round(m[1])]
  };
}

function mirror(rooms, widthMm) {
  return rooms.map(function (r) {
    const c = {};
    for (const k in r) c[k] = r[k];
    c.xMm = Math.round(widthMm - r.xMm - r.widthMm);
    return c;
  });
}

/* --- generate every scheme for an envelope --- */
function generateSchemes(opts) {
  const widthMm = +opts.widthMm, depthMm = +opts.depthMm;
  const floors = Math.max(1, +opts.floors || 1);
  const beds = Math.max(1, +opts.bedrooms || 2);
  const seed = opts.seed || 0, flip = !!opts.flip;
  const perFloor = program(beds, floors);
  const L = ROOM.limits;
  const relax = widthMm < L.relaxTightMm ? L.relaxTight
              : widthMm < L.relaxSnugMm ? L.relaxSnug : 1;

  return SCHEMES.map(function (S, si) {
    const jitter = seed
      ? function (v, k) { return v * (1 + 0.06 * Math.sin(seed * 7.3 + si * 2.1 + k * 1.7)); }
      : function (v) { return v; };
    const ctx = {
      perFloor: perFloor, beds: beds, floors: floors, count: 0,
      rental: !!opts.rental, widthMm: widthMm, depthMm: depthMm,
      kit: kit(widthMm), narrow: widthMm < L.narrowWidthMm
    };
    const fl = [];
    let builtM2 = 0, openM2 = 0, tight = 0;
    const tightNames = [];
    for (let i = 0; i < floors; i++) {
      const bands = S.floor(ctx, i);
      bands.forEach(function (b, bi) { if (!b.fd) b.d = jitter(b.d, bi); });
      let rooms = packFloor(bands, widthMm, depthMm, relax);
      if (flip) rooms = mirror(rooms, widthMm);
      rooms.forEach(function (r) {
        if (r.open) openM2 += r.areaM2; else builtM2 += r.areaM2;
        if (r.tight && !r.open) { tight++; tightNames.push(r.n); }
      });
      fl.push({
        name: ['Ground floor', 'First floor', 'Second floor', 'Third floor'][i] || ('Floor ' + i),
        rooms: rooms
      });
    }
    return {
      id: S.id, name: S.name, tag: S.tag, facade: S.facade,
      widthMm: widthMm, depthMm: depthMm, floors: fl,
      builtM2: +builtM2.toFixed(1), openM2: +openM2.toFixed(1),
      builtSqft: Math.round(builtM2 * ROOM.sqftPerSqm),
      carpetM2: +(builtM2 * ROOM.carpetFraction).toFixed(1),
      tight: tight, tightNames: tightNames, relax: relax,
      rooms: fl.reduce(function (s, f) { return s + f.rooms.length; }, 0)
    };
  });
}

/* ---------------------------------------------------------------------
   EXTERIOR — the chosen scheme massed as faces for the viewer to shade.
   Axis-aligned boxes plus a few sloped planes, all explicit quads with
   outward normals so a sloped roof is as easy as a wall.
   ------------------------------------------------------------------- */
function quad(a, b, c, d, n) { return { n: n, v: [a, b, c, d] }; }

function boxOf(x0, y0, z0, x1, y1, z1) {
  const X0 = Math.min(x0, x1), X1 = Math.max(x0, x1);
  const Y0 = Math.min(y0, y1), Y1 = Math.max(y0, y1);
  const Z0 = Math.min(z0, z1), Z1 = Math.max(z0, z1);
  return [
    quad([X0,Y0,Z0],[X0,Y1,Z0],[X1,Y1,Z0],[X1,Y0,Z0], [0,0,-1]),
    quad([X1,Y0,Z1],[X1,Y1,Z1],[X0,Y1,Z1],[X0,Y0,Z1], [0,0,1]),
    quad([X0,Y0,Z1],[X0,Y1,Z1],[X0,Y1,Z0],[X0,Y0,Z0], [-1,0,0]),
    quad([X1,Y0,Z0],[X1,Y1,Z0],[X1,Y1,Z1],[X1,Y0,Z1], [1,0,0]),
    quad([X0,Y0,Z0],[X1,Y0,Z0],[X1,Y0,Z1],[X0,Y0,Z1], [0,-1,0]),
    quad([X0,Y1,Z1],[X1,Y1,Z1],[X1,Y1,Z0],[X0,Y1,Z0], [0,1,0])
  ];
}

function norm3(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0]/l, a[1]/l, a[2]/l];
}

function exteriorFor(scheme, opts) {
  const W = scheme.widthMm, D = scheme.depthMm;
  const n = scheme.floors.length;
  const H = (opts && opts.floorHeightMm) || 3000;
  const P = EXT.plinthMm, w = EXT.wallMm;
  const parts = [];
  function add(kind, faces) { parts.push({ kind: kind, faces: faces }); }

  /* z = 0 is the street face */
  add('plinth', boxOf(-250, 0, -250, W + 250, P, D + 250));

  for (let i = 0; i < n; i++) {
    const y0 = P + i * H, y1 = y0 + H - EXT.bandMm;
    add('wall', boxOf(0, y0, D - w, W, y1, D));            // rear
    add('wall', boxOf(0, y0, 0, w, y1, D));                 // left
    add('blind', boxOf(W - w, y0, 0, W, y1, D));            // blind side
    /* street face: piers each side of a glazing band */
    add('wall', boxOf(0, y0, 0, w + 900, y1, w));
    add('blind', boxOf(W - w - 900, y0, 0, W, y1, w));
    add('wall', boxOf(w + 900, y0, 0, W - w - 900, y0 + EXT.sillMm, w));
    add('glass', boxOf(w + 900, y0 + EXT.sillMm, 30, W - w - 900, y0 + EXT.headMm, w - 30));
    add('wall', boxOf(w + 900, y0 + EXT.headMm, 0, W - w - 900, y1, w));
    add('band', boxOf(-120, y1, -120, W + 120, y0 + H, D + 120));   // floor band
  }

  const top = P + n * H;

  /* car porch off the street face, under the first-floor band */
  const px0 = W - EXT.porchWidthMm, pz = -EXT.porchProjectionMm;
  add('paving', boxOf(px0, 0, pz, W, 60, 0));
  add('band', boxOf(px0 - 120, P + H - EXT.bandMm, pz - 120, W + 120, P + H, 0));
  add('post', boxOf(W - 300, 60, pz, W - 120, P + H - EXT.bandMm, pz + 180));

  /* facade character */
  if (scheme.facade === 'skillion') {
    const lo = top, hi = top + EXT.skillionRiseMm;
    /* the plane rises along +x, so its normal tilts in x, not z */
    const up = norm3([-(hi - lo), W, 0]);
    const down = [-up[0], -up[1], -up[2]];
    add('roof', [quad([0, lo, -200], [0, lo, D + 200], [W, hi, D + 200], [W, hi, -200], up)]);
    add('roof', [quad([0, lo - 120, -200], [W, hi - 120, -200],
                      [W, hi - 120, D + 200], [0, lo - 120, D + 200], down)]);
    for (let k = 0; k < EXT.finCount; k++) {
      const fx = w + 900 + (W - 2 * w - 1800) * k / EXT.finCount;
      const fh = lo + (hi - lo) * (fx / W);
      add('fin', boxOf(fx, P + (n - 1) * H, -EXT.finDepthMm, fx + 110, fh - 200, 0));
    }
  } else if (scheme.facade === 'screen') {
    add('parapet', boxOf(-120, top, -120, W + 120, top + EXT.parapetMm, D + 120));
    for (let k = 0; k < EXT.finCount; k++) {
      const fx = w + (W - 2 * w) * k / EXT.finCount;
      add('fin', boxOf(fx, P, -EXT.finDepthMm - 120, fx + 130, top + EXT.parapetMm - 200, -120));
    }
  } else if (scheme.facade === 'terrace') {
    add('parapet', boxOf(-120, top, -120, W + 120, top + EXT.parapetMm, D + 120));
    for (let k = 0; k <= EXT.slatCount; k++) {
      const sz = -EXT.porchProjectionMm * k / EXT.slatCount;
      add('slat', boxOf(px0 - 200, top + EXT.parapetMm - 180, sz - 90, W + 120,
                        top + EXT.parapetMm, sz + 90));
    }
    add('fin', boxOf(w, top, -160, W - EXT.porchWidthMm, top + 420, 0));
  } else {
    const by0 = P + H, by1 = P + 2 * H - EXT.bandMm;
    add('blind', boxOf(w + 600, by0 - 120, -1000, W - w, by1, 0));
    add('glass', boxOf(w + 900, by0 + 420, -1030, W - w - 300, by1 - 480, -1000));
    add('parapet', boxOf(-120, top, -120, W + 120, top + 500, D + 120));
    add('fin', boxOf(w, P, -60, w + 420, top, w));
  }

  let lo = [0, 0, 0], hi = [0, 0, 0], first = true;
  parts.forEach(function (p) {
    p.faces.forEach(function (f) {
      f.v.forEach(function (v) {
        for (let k = 0; k < 3; k++) {
          if (first) { lo[k] = v[k]; hi[k] = v[k]; }
          lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]);
        }
        first = false;
      });
    });
  });

  return {
    parts: parts, bounds: { min: lo, max: hi },
    floors: n, floorHeightMm: H, ridgeMm: Math.round(hi[1]),
    facade: scheme.facade
  };
}

/* ------------------------------------------------------------------- */
const SCHEME = {
  ROOM: ROOM, EXT: EXT, SCHEMES: SCHEMES,
  generateSchemes: generateSchemes,
  exteriorFor: exteriorFor,
  helpers: { program: program, packFloor: packFloor, kit: kit,
             minFor: minFor, isOpen: isOpen, isWet: isWet, boxOf: boxOf }
};

if (typeof module !== 'undefined' && module.exports) module.exports = SCHEME;
