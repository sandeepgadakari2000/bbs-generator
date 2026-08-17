# BBS

Bar bending schedule generator for Indian site engineers.

```
src/bbs.js       the engine — pure, no DOM, no dependencies
test/            node --test
bbs.html         the viewer — one file, opens from the filesystem
tools/inline.js  copies src/bbs.js into bbs.html's <script id="engine">
reference/       the prototype and brief this was built from
```

## Run

```bash
node --test
```

Open `bbs.html` by double-clicking it. No server, no network, no build.

After editing `src/bbs.js`, re-sync the viewer's copy:

```bash
node tools/inline.js
```

`test/inline.test.js` fails if the two copies ever drift, so this cannot be
forgotten silently.

## Detailing conventions

Every constant lives in the `CODE` object in `src/bbs.js` and is read from
there at call time — `test/bbs.test.js` proves it by mutating `CODE` and
asserting the answers move. Shape ids are internal; no BS 8666 conformance
is claimed.

Three rules were not in the brief and were settled by decision rather than
guessed. They are recorded here because they change the steel quantity:

| Rule | Decision |
|---|---|
| Non-rectangular stirrups | Centre-line convention. The circular ring is measured on the bar centre-line, `π × (Ø − 2c − ds)`. The triangular apex is deducted as a 90° bend. |
| `end: 'bend'` leg length | Derived per member as `member depth − 2 × cover`, not a fixed constant. Overridable per bar with `bendLegMm`. |
| Cranked bars | Each crank is two 45° bends, so it deducts `2 × CODE.bendDeduction[45] × d` on top of the `0.42D` allowance. Uses only constants already in `CODE`. |

The bend set for every shape lives in `CODE.shapes`, so a stirrup's
`3 × 2d + 2 × 3d` deduction is never written at a call site.

## The structural grid

A hand-built member list has no positions — "6 columns, 300×450×3000" does not
say where they stand — so there is nothing to assemble into a building. The grid
supplies that. `frame(spec)` takes bays, floors and member sizes and returns
**both** the member list and a placed assembly, so the schedule and the building
on screen are the same numbers rather than two separate guesses:

```js
frame({ baysXMm: [3000, 3600, 3000], baysYMm: [3600, 3600],
        floors: 2, floorHeightMm: 3000,
        column: {…}, beam: {…}, slab: {…}, footing: {…},
        template: { footing: {bars}, column: {bars, stirrups}, … } })
→ { members, grid, assembly: { parts, bounds }, notes }
```

Grid spacings are centre to centre. Clear spans are **derived** by taking out
the supporting member, never assumed — widen a column and the beam clear span
moves with it:

| Member | Clear span |
|---|---|
| Beam along X | bay spacing − column width |
| Beam along Y | bay spacing − column depth |
| Slab panel | bay spacing − beam width, each way |

Identical members are grouped, so twelve 3 m bays return one beam mark with a
quantity of twelve, not twelve marks. `notes` reports any member type the
reinforcement template did not cover; those members keep their concrete and
carry no bars rather than silently inventing some.

The engine accepts per-bay arrays, so non-uniform grids work; the viewer's form
only offers uniform bays (count × spacing).

## The cage

`generate()` also returns `member.cage` — the reinforcement laid out in three
dimensions, member-local, in millimetres, with x along the member, y up and z
across:

```js
{ solid:  { verts: [[x,y,z]…], faces: [[i,j,k,l]…] },   // the concrete
  bars:   [{ mark, dia, kind: 'long' | 'ring', path: [[x,y,z]…] }],
  bounds: { min, max },
  thinned: false }
```

It is point lists and face indices — no canvas, no projection, no colour. The
viewer draws it with its own camera (perspective for the iso view, orthographic
for elevation, section and plan), so `bbs.html` still opens with no network and
no library.

The Model section shows either view:

- **Building** — the whole placed frame as shaded concrete solids. Tapping a
  schedule row picks that member out of the building in the accent colour, so
  you can see which 24 columns a mark refers to.
- **Member cage** — one member's reinforcement, with the bar mark from the open
  schedule row highlighted.

Only the *drawing* of the cage is budgeted: past `CODE.cage.maxRings` stirrups
per member the viewer draws a sample of them and sets `thinned: true` so the
thinning is visible rather than silent. No quantity is affected, and a test
asserts it.

## The external-input seam

`adoptExternalMembers(members, source)` takes a member array from outside —
a drawing-extraction module, say — and records every field as
`{ verified: false, source }` under `member.provenance`. The calculation path
never reads `provenance`, so the seam changes no number; the viewer can use it
to ask the engineer to confirm each field. Drawing, photo and PDF reading are
out of scope for this build.

## Warnings

Checks never throw and never correct a value silently. Cover below the IS 456
nominal, stirrup spacing over the lesser of 0.75d and 300 mm, bar congestion,
laps in an avoided zone, cutting lengths over the 12 m stock length, and steel
outside 80–200 kg/m³ all come back as entries on `result.warnings`, and the
value you supplied is the value that was used.

---

Detailing constants follow common Indian practice. Verify against IS 2502,
IS 456 and the project consultant's detailing note before site use.
