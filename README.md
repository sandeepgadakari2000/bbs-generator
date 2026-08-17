# BBS

Bar bending schedule generator for Indian site engineers. Two ways in: type the
structural grid, or drop the plan PDF.

```
src/bbs.js       the detailing engine — bar lengths, schedules, cage, frame
src/scheme.js    the planner — four partitions of a frame, plus its exterior
src/plan.js      the plan reader — PDF in, reviewable parameters out
test/            node --test
test/fixtures/   PDFs built by test/make-fixtures.py, expected values known
bbs.html         the viewer, both pages — one file, opens from the filesystem
tools/inline.js  copies all three modules into their marked blocks in bbs.html
reference/       the prototype and brief this was built from
```

## Run

```bash
node --test
```

Regenerate the PDF fixtures if you change them:

```bash
py -3.13 test/make-fixtures.py
```

Open `bbs.html` by double-clicking it. No server, no network, no build.

After editing anything under `src/`, re-sync the viewer's copies:

```bash
node tools/inline.js
```

`test/inline.test.js` fails if any copy drifts, so this cannot be forgotten
silently.

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

## Architectural schemes (page 1)

Once the frame is scheduled, `src/scheme.js` partitions its envelope four ways —
Linear Core, Side Spine, Light Court, Rear Stair — and masses the chosen one as
an exterior.

The envelope is **the grid that was already scheduled**, not a fresh plot with
setbacks, so the plan and the steel describe one building. Nothing statutory is
invented: there is no FAR limit and no setback rule in here, because those are
local and belong to whoever files the drawing.

```js
generateSchemes({ widthMm, depthMm, floors, bedrooms, rental, seed, flip })
→ [{ id, name, facade, floors:[{ name, rooms:[…] }], builtM2, carpetM2, openM2, tight, … }]

exteriorFor(scheme, { floorHeightMm })
→ { parts:[{ kind, faces:[{ n, v }] }], bounds, ridgeMm, facade }
```

Rooms tile the envelope exactly and never overlap — both are asserted. A room
that cannot reach a comfortable size is **flagged, never quietly grown**: the
scheme reports `tight` and names the spaces, and the packer leaves the room at
the size the envelope actually allows.

The exterior is explicit quads with outward normals rather than boxes, so a
skillion roof is as easy as a wall. It is drawn in this repo's ink and accent —
not the prototype's greens and blues, since CLAUDE.md pins the palette.

It sits on **its own canvas directly under the plans**, with its own camera, so
spinning the building never disturbs the frame or cage view further up the page.
Controls are Front / Right / Rear / Left / Iso / Aerial / Eye level plus a
**Spin 360°** turntable, and dragging cancels the spin. The bearing readout is
measured from the street elevation, so a lap reads 0° → 90° → 180° → 270°.

Which way is the street matters here: the massing puts it at the LOW z end, so
the camera has to sit at negative z to look at it. Deriving those angles from
the geometry rather than guessing was the difference between "Front" showing the
facade and showing the back wall.

## Page 2 — reading a plan PDF

`src/plan.js` parses a PDF with no library and no network: objects (including
PDF 1.5 object streams), the filter chain (`FlateDecode` via the platform's
`DecompressionStream`, `ASCII85Decode`, `ASCIIHexDecode`), content-stream text
with positions and its line geometry, and `ToUnicode` CMaps so subset fonts
decode to real characters instead of control codes.

It then reads the sheet **the way a person does — off the numbers lettered on
it**, not by measuring pixels. The longest run of believable span numbers
sharing a row is the X bay chain; sharing a column, the Y chain. Sections come
from a `300 x 450` on a line that also names the member, steel from
`8 DIA @ 150 C/C` on or just under a schedule header.

Every value comes back with the text it was read from, the page it was on, and
`verified: false`. The Extracted parameters table shows all of it and lets you
override any row before anything is calculated. Confirmed values then go through
`frame()` and `generate()` — the **same** engine page 1 uses, so there is one
set of detailing rules, not two.

### What it will not do

- **Scanned drawings.** A page with an image and no text carries no numbers.
  That is detected and reported; nothing is guessed. OCR needs a model that
  cannot ship in a single file with no network.
- **Filters it cannot decode** (`LZWDecode`, `DCTDecode`, …) are named in the
  status line rather than silently yielding an empty sheet.
- **It does not understand a drawing.** It finds candidates. The table exists
  because a human has to confirm them before steel is ordered.

The design review is **code-based checks, not a model**: span/depth against
IS 456 cl 23.2.1, column slenderness against cl 25.1.2, column steel percentage
against cl 26.5.3.1, slab depth against span/32, plus whatever the schedule's
own checks flagged. Every limit is cited and lives in the `REVIEW` object. The
cost figures use placeholder rates in `REVIEW.rates` — they are assumptions, not
quotations.

State for the two pages is kept apart, so switching between them preserves both.

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
