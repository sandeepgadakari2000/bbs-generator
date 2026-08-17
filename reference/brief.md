Read `./reference/plotgen.html` before writing any code. If that file is not in this repo, stop and ask me for it.

That file is a working single-file prototype of mine. Study three things about it and carry them forward exactly:

1. **Architecture** — a pure `ENGINE` object with no DOM and no third-party dependency, exported for Node, with the viewer layer built entirely below and around it.
2. **Visual language** — graphite ink `#14171a`, sheet `#f6f7f6`, hairline rules `#b6bcb9`, single orange accent `#e07b1e`, monospace utility type with letter-spaced uppercase micro-labels, a title block strip, and dimension lines drawn as real drawing dimensions with ticks. It reads as an architectural sheet, not a dashboard. Keep that.
3. **Output shape** — one HTML file, no build step, no npm packages in the browser bundle.

Now build a **Bar Bending Schedule generator** for Indian site engineers, in the same style.

---

# Ground rules

Create `CLAUDE.md` at the repo root, first commit, with exactly this content:

```
Single-file HTML output. No build step. No npm deps in the browser bundle.
Engine stays pure: no DOM, no window, requireable in Node, unit-tested.
All detailing constants live in the CODE config object. Never inline a
constant at a call site.
Every computed length must expose its term-by-term derivation string.
Visual language: graphite #14171a, sheet #f6f7f6, rules #b6bcb9,
accent #e07b1e, monospace utility type. No other colours.
Units: mm for detailing, m for schedule lengths, kg for weights.
Never silently clamp or round away a value that fails a check — surface it.
```

Work in two stages. **Do not start stage 2 until stage 1 passes.**

---

# STAGE 1 — Engine and tests only

Files: `src/bbs.js` and `test/bbs.test.js`, run with `node --test`. No UI code in this stage. No HTML file yet.

## The CODE config object

Export it. Every constant the engine uses lives here and nowhere else:

```js
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
  }
};
```

## Member types

Isolated footing, column, beam (singly and doubly reinforced), one-way slab, two-way slab, lintel, staircase flight.

Per member the engineer supplies: member ID, quantity of identical members, concrete dimensions, clear cover, main bar diameter and count per position, distribution or stirrup diameter and spacing, and end condition per bar (`hook` / `bend` / `continuous` / `crank`).

## Formulas

- **Cutting length** = member length − 2 × cover + hooks + crank allowances + lap length − bend deductions
- **Hook allowance** = `CODE.hook.u180 × d` for a 180° U-hook, `CODE.hook.stirrup135 × d` for a 135° stirrup hook, each subject to `CODE.hook.minMm`
- **Bend deduction** = `CODE.bendDeduction[angle] × d` per bend
- **Crank allowance** = `CODE.crank.deg45 × D` per crank, where D is the clear vertical distance between top and bottom bar centres
- **Two-legged rectangular stirrup** = 2(a + b) + 2 × hook − (3 × 2d + 2 × 3d), where a and b are the outer concrete dimensions less twice the cover. Also support triangular, circular and diamond stirrups.
- **Stirrup count** = ceil((clear span − 2 × cover) / spacing) + 1
- **Unit weight** = d² / 162 kg/m
- **Wastage** applies at summary level only, as its own visible line. Never fold it into an individual bar's weight.

## Checks — surface as warnings on the result object, never as thrown errors or silent corrections

- Cover below the IS 456 nominal for that member type
- Beam stirrup spacing exceeding the lesser of 0.75d and 300 mm
- Clear spacing between main bars below the greater of bar diameter and 25 mm (congestion)
- Lap falling in a zone laps are normally avoided — mid-span for bottom steel, over support for top steel. A flag, not a block.
- Cutting length exceeding `stockLengthMm`, with the extra lap length that implies stated in the warning text
- Steel per cubic metre of concrete outside 80–200 kg/m³

## Derivation strings

Every cutting length carries a human-readable derivation, e.g.
`3950 (4000 clear − 2×25 cover) + 288 (2 × 9d hook @ 16) = 4238 mm`.
Site engineers will not trust a number they cannot reconstruct. This is a hard requirement, not a nicety.

## Shape identifiers

Use an internal shape id: `STRAIGHT`, `L_BEND`, `CRANK`, `U_HOOK`, `STIRRUP_RECT`, `STIRRUP_TRI`, `STIRRUP_CIRC`, `STIRRUP_DIA`. Do not claim BS 8666 conformance anywhere in the code or UI.

## Acceptance test — write this first, then make it pass

Member: beam, 300 × 450 mm, clear span 4000 mm, cover 25 mm, 4 no. 16 mm straight bottom bars with 9d U-hooks both ends, 8 mm two-legged rectangular stirrups at 150 c/c, one member. All `CODE` defaults.

The engine must return, within ±1 mm and ±0.1 kg:

```
main bar cutting length      4238 mm     (3950 + 2 × 144)
main bar unit weight        1.580 kg/m
main steel, 4 bars           26.8 kg
stirrup cutting length       1364 mm     (1300 + 160 − 96)
stirrup count                  28        (ceil(3950/150) + 1)
stirrup steel, total         15.1 kg
total member steel           41.9 kg
```

This member is deliberately bottom-steel-only, so it computes 77.6 kg/m³ against 0.54 m³ of concrete. **The steel-ratio warning must fire.** Assert that it does. Do not adjust the threshold to silence it.

If any of your numbers differ from the above, print your term-by-term derivation and **stop**. Do not edit the expected values to match your output. Tell me and wait.

Also write tests for: stirrup count rounding at an exact multiple of spacing, a 15 m cutting length tripping the stock-length warning, a 6 mm bar and a 32 mm bar at both ends of the size range, and a member with quantity greater than one multiplying correctly.

---

# STAGE 2 — Viewer

One file, `bbs.html`, importing the engine inline. Same sheet aesthetic as `plotgen.html`.

**Input** — a member list the engineer builds up. Adding a member opens a form whose fields change by member type. Cover pre-fills from `CODE.cover` for that type and stays editable. Sensible defaults everywhere; nothing should require twelve fields to see a first result.

**Schedule** — bar mark, member, shape, diameter, bars per member, number of members, total bars, cutting length (m), total length (m), unit weight, total weight (kg). Two groupings, toggled: by member, and by diameter.

**Shape diagram** — a small dimensioned SVG per bar mark, drawn in the sheet style.

**Derivation** — tapping any cutting length reveals its derivation string inline.

**Summary** — steel by diameter in kg and tonnes, wastage as its own line, grand total, and steel per m³ of concrete with the sanity flag.

**Warnings panel** — every warning from the engine, grouped by member, in the accent colour. Never hidden behind a toggle.

**Export** — copy the schedule as TSV so it pastes straight into Excel, and a print stylesheet producing a clean A4 schedule with a title block carrying project name, member set, date, and a revision field.

**Constraints** — no localStorage, sessionStorage or any browser storage API; state lives in memory only. Touch targets sized for a phone, because this gets used on site. Responsive down to 380 px.

Put this line in the app footer, not only in your reply to me:

> Detailing constants follow common Indian practice. Verify against IS 2502, IS 456 and the project consultant's detailing note before site use.

---

# Out of scope for this build

Do not attempt to read drawings, photographs or PDFs. Structured input only. Leave one documented seam — a single function that accepts a member array from an external source and marks each field `verified: false` — so a drawing-extraction module can pre-fill the form later without the engine changing.

---

# Definition of done

- `node --test` passes, including the acceptance test above, unedited
- `src/bbs.js` requires cleanly in Node with no DOM shim
- `bbs.html` opens from the filesystem with no server and no network
- Every constant is in `CODE`; grep confirms no stray numeric literals in the calculation paths
- Commits are small and per-stage, with the engine committed and passing before any UI code exists

Ask me before inventing any detailing rule that is not specified above. I would rather answer a question than find a guessed constant in the steel order.
