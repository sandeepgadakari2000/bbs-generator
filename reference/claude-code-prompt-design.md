# FEATURE SPECIFICATION: DESIGN ENGINE

Read these before writing any code. If the repo is not at
`C:\Users\sande\OneDrive\Desktop\bbs-generator`, stop and ask me where it is.

```
CLAUDE.md          the ground rules. They still apply. Read them first.
README.md          what exists and why
src/bbs.js         detailing engine — cutting lengths, schedules, cage, frame
src/scheme.js      four room partitions of a frame, plus its exterior massing
src/plan.js        PDF plan reader
bbs.html           the viewer, two pages, one file
tools/inline.js    copies each src module into its marked block in bbs.html
test/              node --test, 73 passing before you start
```

Run `node --test` first and confirm 73 pass. If they do not, stop and tell me.

---

## What exists, and what it cannot do

The tool today is a **quantity and detailing** tool. You give it a structural
grid and the reinforcement you intend to use; it returns cutting lengths, bar
bending schedules, a 3D frame, a rebar cage, four architectural layouts and an
exterior view. Every cutting length carries its term-by-term arithmetic.

It computes **no forces**. No loads, no moments, no shears, no deflections. Its
"design review" checks proportioning rules — span/depth, slenderness, steel
percentage — never strength. It reads `M25` and `Fe500` off a PDF and then never
uses them, because there is nothing to use a material strength for when there
are no loads.

**Your job is to close that gap.** The tool must stop counting the steel I
assumed and start computing the steel the section actually needs.

---

## The rule that matters most

Right now, being wrong costs a wrong steel order. The moment this tool prints
*"adequate"*, being wrong can drop a building.

So:

1. **Never print a verdict without the numbers behind it.** Not "OK" — always
   demand, capacity and the ratio. `Mu 60.0 kNm / Mu,cap 124.0 kNm = 0.48`.
2. **Every computed capacity carries a derivation string**, exactly as cutting
   lengths already do. This is the existing house rule and it is not optional.
3. **Check preconditions and refuse.** The IS 456 cl 22.5 coefficients apply
   only to substantially uniform loads with spans differing by no more than 15%.
   If that does not hold, say so and decline — do not quietly use them anyway.
4. **Never hide a failed check.** Already in CLAUDE.md. It now matters more.
5. **Every design constant lives in a config object** like `CODE` does, read at
   call time, with a test that proves mutating it moves the answer.
6. **Ask me before inventing any rule, factor or table value that is not
   specified here.** I would rather answer a question than find a guessed
   partial safety factor in a design someone builds.

Add this to `CLAUDE.md` in your first commit:

```
Design output states demand, capacity and the ratio — never a bare verdict.
Every computed capacity exposes its term-by-term derivation string.
Code preconditions are checked and refused, never assumed.
Design constants live in a config object, never inlined at a call site.
Tests cite the worked example they check against, by book and page.
```

---

## Non-negotiable constraints, carried over

- **Single-file HTML output. No build step. No npm packages in the browser
  bundle. No network.** A design engine is closed-form arithmetic; it needs
  nothing external. If you later add a solver and want a Web Worker, build it
  from a Blob URL so the single-file rule holds.
- **Engines stay pure**: no DOM, no `window`, requireable in Node, unit-tested.
- **Register every new module in `tools/inline.js` `MODULES`** with its own
  `BEGIN`/`END` markers, and add the matching block to `bbs.html`. The sync test
  will fail until you do.
- **Palette**: graphite `#14171a`, sheet `#f6f7f6`, rules `#b6bcb9`, accent
  `#e07b1e`. No other colours. `test/inline.test.js` enforces this.
- **Units**: mm for detailing, m for schedule lengths, kg for weights, kN and
  kNm for forces, N/mm² for stresses. State units on every reported number.
- **Do not break anything.** All 73 existing tests must still pass, unedited.
  Page 1 and Page 2 must behave exactly as they do now, plus the new output.

---

## Work in stages. Do not start a stage until the previous one passes.

Commit per stage, small and self-contained.

---

## STAGE 1 — Loads and distribution

New file `src/loads.js`, tests in `test/loads.test.js`. No UI yet.

**Config object `LOAD`** — every value here, nothing at a call site:

- Unit weights, IS 875 Part 1: reinforced concrete 25 kN/m³, brick masonry
  19 kN/m³, plain concrete 24 kN/m³, screed 20 kN/m³
- Live load by occupancy, IS 875 Part 2: residential rooms 2.0, balconies 3.0,
  corridors and stairs 3.0, office 2.5, shops 4.0 kN/m²
- Typical superimposed dead: floor finish 1.0–1.5, false ceiling 0.3,
  services 0.3 kN/m² — as editable defaults, clearly labelled as assumptions
- Load combinations, IS 456 Table 18: `1.5(DL + LL)`, `1.2(DL + LL ± EL)`,
  `1.5(DL ± EL)`, `0.9DL ± 1.5EL`, and the wind equivalents

**What it computes**

1. Self-weight of every member from the geometry `frame()` already returns.
2. Slab load per m² = self-weight + SDL + LL.
3. Slab-to-beam distribution by yield lines: two-way panels shed load to the
   supporting beams as triangles on the short edges and trapezoids on the long
   ones. Return the equivalent UDL on each beam, and show how it was obtained.
4. Beam-to-column: sum the beam reactions at each node, floor by floor.
5. Column axial accumulating down the building, plus its own self-weight.
6. Footing load = column axial at base + footing self-weight + soil overburden.
7. Every combination from Table 18, and the governing envelope.

**Acceptance test — write it first**

A single 3.0 m × 4.0 m two-way panel, 125 mm slab, M25, residential.

```
slab self weight     0.125 × 25            = 3.125 kN/m²
floor finish                                 1.000 kN/m²
live load, residential rooms                 2.000 kN/m²
service load                                 6.125 kN/m²
factored, 1.5 × 6.125                        9.188 kN/m²
```

Total factored load on the panel = `9.188 × 3.0 × 4.0` = **110.25 kN**.

Assert the panel load, and assert that the four beam reactions sum to the panel
load within 1%. That closure check is the whole point: if load vanishes in the
distribution, the test must catch it.

Also test: a one-way panel (long/short ≥ 2) sheds to two beams only; a cantilever
sheds entirely to one; combinations produce the right number of cases; the
governing envelope picks the maximum per member.

---

## STAGE 2 — Beam design, flexure and shear

New file `src/design.js`, tests in `test/design.test.js`.

**Config object `IS456`**, with clause numbers in comments:

- `xuMaxOverD`: Fe250 0.53, Fe415 0.48, Fe500 0.46 — cl 38.1
- `muLimFactor`: Fe250 0.148, Fe415 0.138, Fe500 0.133 — × `fck b d²`
- Stress block: `0.36 fck b xu`, lever arm `d − 0.42 xu` — cl 38.1
- Steel design stress `0.87 fy`
- `minFlexuralSteel`: `0.85 bd / fy` — cl 26.5.1.1
- `maxFlexuralSteel`: `0.04 bD` — cl 26.5.1.1
- **Table 19 τc** as a real table over `pt` and `fck`, linearly interpolated.
  Put the table in the config. Do not hard-code an interpolated result.
- `minShearSteel`: `Asv/(b·sv) ≥ 0.4/(0.87 fy)` — cl 26.5.1.6
- Max stirrup spacing: lesser of `0.75d` and 300 mm — cl 26.5.1.5
- `tauBd` for deformed bars in tension, × 1.6 — cl 26.2.1.1
- `tauCMax` by grade — Table 20

**Design moments without a solver.** Implement **IS 456 cl 22.5, Tables 12 and
13** for continuous beams and one-way slabs. Check the preconditions and refuse
if they do not hold. For a simply supported span use `wl²/8` and `wl/2`.

**Two acceptance tests. Write both first.**

Beam 300 wide × 450 overall, clear span 4000, M25, Fe500, cover 25, 8 mm
stirrups, 16 mm main bars. So `d = 450 − 25 − 8 − 8 = 409 mm`.

**(a) Design — given a moment, find the steel.** Simply supported, factored
UDL 30 kN/m.

```
Mu  = 30 × 4.0² / 8                       = 60.0 kNm
Vu  = 30 × 4.0 / 2                        = 60.0 kN
Mu,lim = 0.133 × 25 × 300 × 409²          = 166.9 kNm    → singly reinforced
Ast from 60e6 = 435·Ast·(409 − 0.0677·Ast) = 358.5 mm²
Ast,min = 0.85 × 300 × 409 / 500          = 208.6 mm²    → does not govern
```

**(b) Capacity — given the steel, find the moment.** The beam already in
`test/bbs.test.js`: 4 nos 16 mm = 804.2 mm².

```
xu     = 0.87 × 500 × 804.2 / (0.36 × 25 × 300)   = 129.6 mm
xu,max = 0.46 × 409                               = 188.1 mm   → under-reinforced
Mu,cap = 435 × 804.2 × (409 − 0.42 × 129.6)       = 124.0 kNm
```

Shear on the same section at `Vu = 60 kN`:

```
τv = 60000 / (300 × 409)                  = 0.489 N/mm²
pt = 100 × 804.2 / (300 × 409)            = 0.655 %
τc from Table 19, M25, interpolated at pt = 0.655   ≈ 0.54 N/mm²
τv < τc  → strength does not need stirrups; minimum governs
Asv/sv required = 0.4 × 300 / (0.87 × 500)         = 0.276 mm²/mm
2-legged 8 mm → Asv = 100.5 mm² → sv ≤ 364 mm, capped at 300 mm by cl 26.5.1.5
```

The existing 150 c/c is therefore conservative, and 4-T16 against a 60 kNm
demand is a D/C of 0.48. **The tool should say so** — over-provision is
information, not a pass.

I worked these by hand from the clauses above. **If your numbers differ, print
your term-by-term derivation and stop.** Do not edit the expected values to
match your output. Tell me, and if you think I have erred, say where — the
Table 19 interpolation is the value I am least sure of.

Cross-check every acceptance value against a published worked example and cite
it in the test — SP-16, Pillai & Menon *Reinforced Concrete Design*, or
Krishna Raju. State the book and page in a comment.

Also test: a doubly reinforced case where `Mu > Mu,lim`; a section where
`Ast,min` governs; a section over `0.04bD` which must be flagged as
over-reinforced; `τv > τc,max` which must be refused outright, not detailed;
a beam where shear steel genuinely is required.

---

## STAGE 3 — Column design

Extend `src/design.js`.

- Short column check `lex/D < 12` — cl 25.1.2. Slender columns: additional
  moments per cl 39.7, or refuse and tell me. Ask first.
- Minimum eccentricity — cl 25.4
- Axial capacity, short column with `e ≤ 0.05D`:
  `Pu = 0.4 fck Ac + 0.67 fy Asc` — cl 39.3
- Steel percentage 0.8 % to 6 % — cl 26.5.3.1
- **P-M interaction diagram by strain compatibility.** Divide the section into
  strips, sweep the neutral axis depth, integrate the concrete stress block and
  each bar's force, and emit the `(Pu, Mu)` curve. Report where the demand point
  sits relative to the curve.
- Biaxial bending by the cl 39.6 interaction expression.

Acceptance: a 300 × 450 column, M25, Fe500, 6 nos 20 mm. Compute the pure axial
capacity by hand from cl 39.3 first, then assert the interaction curve passes
through it at `Mu = 0`. Cross-check two points against an SP-16 chart and cite
the chart number.

---

## STAGE 4 — Isolated footing design

- Plan area from service axial and safe bearing capacity, which becomes a new
  input. Do not assume an SBC — ask for it, and refuse without it.
- One-way shear at `d` from the face
- Two-way punching shear on the perimeter at `d/2`, `τc = ks · 0.25√fck` — cl 31.6
- Bending at the column face, both directions
- Minimum depth and cover for footings — cl 26.4.2

Acceptance: work one footing by hand and cite the source.

---

## STAGE 5 — Two-way slab design

**IS 456 Annex D, Tables 26 and 27** — restrained and simply supported panels.
Put both tables in the config. Compute `αx`, `αy`, then the moments, then the
steel each way. Minimum steel 0.12 % — cl 26.5.2.1. Maximum bar spacing —
cl 26.3.3. Check the panel's edge conditions are one of the cases Table 26
actually covers, and refuse if not.

---

## STAGE 6 — IS 13920 ductile detailing

This is rules, not analysis, and it is the most serious gap in the tool today.

- Minimum member dimensions and span/depth limits
- Beam hinge-zone length and confining-stirrup spacing near supports
- Column confining reinforcement over the hinge length
- Special confining reinforcement spacing limits
- Lap positions and lengths in seismic zones
- Beam-column capacity ratio where moments are available

Apply it only when a seismic zone is set, and say plainly when it has not been
applied. Every limit cites its clause.

---

## STAGE 7 — Frame solver

New file `src/solve.js`. Only start this once Stages 1–6 pass.

- 3D bar element, 12 × 12 stiffness — axial, two shear, torsion, two bending
- Assemble global K, apply supports, solve `Ku = F`
- Banded or skyline Cholesky. A building frame has a narrow bandwidth; exploit
  it. Use typed arrays.
- Recover member end forces, and deflections
- P-Delta by iterative reanalysis

**Validation strategy, and it is the good one:** on a regular frame with uniform
spans, the solver and the Stage 2 coefficient method must agree within a stated
tolerance. Each becomes a check on the other. Write that test.

Also validate against a closed-form case: a propped cantilever, a fixed-fixed
beam under UDL, a portal frame — all have textbook answers.

If a model is large enough to block the UI, move the solve into a Worker built
from a Blob URL. Do not add a dependency.

---

## STAGE 8 — Lateral loads

- **Wind, IS 875 Part 3**: basic wind speed, terrain category, topography,
  `k1 k2 k3 k4`, design pressure, force coefficients
- **Seismic, IS 1893:2016**: zone factor Z, importance I, response reduction R,
  soil type, `T` from cl 7.6, `Ah = Z·I·Sa/g / 2R`, base shear `Vb = Ah·W`,
  storey distribution by `Wihi² / ΣWjhj²`
- Storey drift limit 0.004 h — IS 1893 cl 7.11.1
- Modal analysis and response spectrum only after the solver is trusted

Ask me before choosing any zone, soil type or R value as a default. Those are
site and structure specific and must be inputs, not assumptions.

---

## STAGE 9 — Viewer

Only after the engines pass.

- Load inputs per floor on page 1, beside the structural grid
- A **Design** section: demand, capacity and D/C ratio per member, with the
  derivation revealed on tap, exactly like cutting lengths
- Required vs provided steel side by side, so over- and under-provision are both
  visible
- The BBS becomes a schedule of **required** steel, with the assumed-steel mode
  kept as an option
- Force diagrams — moment, shear, axial — as SVG in the sheet style, once the
  solver exists
- The design review panel replaces its proportioning rules with real ratios
- Everything prints on the A4 sheet

---

## Out of scope. Do not attempt these.

- Shell and plate elements, and therefore shear walls, rafts and irregular
  slabs. This needs proper elements and mesh generation and is a different
  project. Say so in the UI rather than approximating it.
- Nonlinear analysis: pushover, plastic hinges, large displacement, time history
- Staged construction, creep and shrinkage time-stepping
- Soil-structure interaction
- Steel design, IS 800, connection design
- Any claim of conformance, certification or fitness for statutory submission

Leave the seam: an analysis result should enter the design engine through one
documented function, so a different solver could be substituted later.

---

## Definition of done, per stage

- `node --test` passes, including all 73 existing tests, unedited
- The stage's acceptance test passes with the expected values unedited
- Every new module requires cleanly in Node with no DOM shim
- `bbs.html` still opens from the filesystem with no server and no network
- Every design constant is in a config object, proven by a mutation test
- Every capacity has a derivation string, and a test asserts its shape
- Tests cite the worked example they check, by book and page
- Commits are small and per-stage

---

## Finally

The footer line stays, and gains a companion. Put both in the app footer:

> Detailing constants follow common Indian practice. Verify against IS 2502,
> IS 456 and the project consultant's detailing note before site use.

> Design output is a preliminary check, not a structural design. It has not been
> verified against benchmark problems and is not fit for statutory submission.
> A qualified engineer must confirm every result.

Ask me before inventing any rule, factor or table value not written above. If a
clause is ambiguous, quote it and ask. I would rather answer ten questions than
find one guessed factor in a design someone builds.
