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
