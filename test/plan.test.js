'use strict';

/* =====================================================================
   PLAN READER TESTS

   Fixtures are built by test/make-fixtures.py, by hand rather than with a
   library, so the expected values are known exactly. The drawing they
   letter is a 3 x 2 bay grid at 3000/3600/3000 across and 3600/3600 down,
   G+1, with column, beam, slab and footing schedules.
   ===================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PLAN = require('../src/plan.js');
const { CODE, frame, generate, adoptExternalMembers } = require('../src/bbs.js');

const FIX = path.join(__dirname, 'fixtures');
const have = fs.existsSync(path.join(FIX, 'plain.pdf'));
function load(name) { return fs.readFileSync(path.join(FIX, name)); }

test('the fixtures exist — run: py -3.13 test/make-fixtures.py', function () {
  assert.ok(have, 'test/fixtures/*.pdf missing');
});

/* --- the same drawing, three ways of storing it ---------------------- */
for (const variant of ['plain.pdf', 'flate.pdf', 'objstm.pdf']) {
  test('reads the sheet from ' + variant, async function () {
    const r = await PLAN.readPdf(load(variant));
    assert.equal(r.ok, true, r.reason || '');
    assert.equal(r.pageCount, 1);
    assert.ok(r.texts.length >= 20, 'text runs: ' + r.texts.length);
    assert.ok(r.lines.length > 0, 'no geometry read');

    const f = PLAN.inferPlan(r).fields;
    assert.deepEqual(f.baysX.value, [3000, 3600, 3000], 'bay chain across');
    assert.deepEqual(f.baysY.value, [3600, 3600], 'bay chain down');
    assert.equal(f.floors.value, 2, 'G+1 is two floors');
    assert.equal(f.floorHeightMm.value, 3000);
    assert.deepEqual(f.column.value, { widthMm: 300, depthMm: 450 });
    assert.deepEqual(f.beam.value, { widthMm: 230, depthMm: 450 });
    assert.equal(f.slabThicknessMm.value, 125);
    assert.deepEqual(f.footing.value, { lengthMm: 1500, widthMm: 1500, depthMm: 450 });
    assert.equal(f.coverMm.value, 40);
    assert.equal(f.concreteGrade.value, 'M25');
    assert.equal(f.steelGrade.value, 'Fe500');
    assert.deepEqual(f.columnBars.value, { dia: 20, count: 8 });
    assert.deepEqual(f.columnTies.value, { dia: 8, spacingMm: 150 });
    assert.deepEqual(f.beamStirrups.value, { dia: 8, spacingMm: 150 });
    assert.deepEqual(f.slabBars.value, { dia: 10, spacingMm: 125 });
    // the footing's steel is lettered on the line under its header
    assert.deepEqual(f.footingBars.value, { dia: 16, spacingMm: 150 });
  });
}

test('every read value is unverified and carries the text it came from', async function () {
  const r = await PLAN.readPdf(load('flate.pdf'));
  const f = PLAN.inferPlan(r).fields;
  const keys = Object.keys(f);
  assert.ok(keys.length >= 15, 'only found ' + keys.length + ' fields');
  keys.forEach(function (k) {
    assert.equal(f[k].verified, false, k + ' must not arrive pre-verified');
    assert.equal(typeof f[k].from, 'string');
    assert.ok(f[k].from.length > 0, k + ' has no source text');
    assert.match(f[k].from, /page \d/, k + ' does not say which page it came from');
  });
});

/* --- a scanned drawing must be refused, not guessed at --------------- */
test('a scanned drawing is reported, never guessed', async function () {
  const r = await PLAN.readPdf(load('scanned.pdf'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /scanned/i);
  assert.match(r.reason, /OCR/);
  assert.equal(r.texts.length, 0, 'nothing may be invented from an image');
});

test('a file that is not a PDF is refused on its first bytes', async function () {
  const r = await PLAN.readPdf(Buffer.from('%!PS-Adobe not a pdf at all'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a PDF/i);
});

test('an empty or truncated file does not throw', async function () {
  for (const bad of [new Uint8Array(0), Buffer.from('%PDF-1.4\n'), Buffer.from('%PDF-1.4\n1 0 obj\n<<')]) {
    const r = await PLAN.readPdf(bad);
    assert.equal(r.ok, false);
    assert.equal(typeof r.reason, 'string');
  }
});

/* --- decoders ------------------------------------------------------- */
test('ASCII85 decodes the canonical example, partial group included', function () {
  const dec = PLAN.helpers.ascii85Decode;
  const str = function (b) { return Buffer.from(b).toString('latin1'); };
  assert.equal(str(dec(Buffer.from('87cURD]j7BEbo80', 'latin1'))), 'Hello world!');
  assert.equal(str(dec(Buffer.from('9jqo^BlbD-BleB1DJ+*+F(f,q', 'latin1'))), 'Man is distinguished');
  // a final group of n characters carries n-1 bytes
  assert.equal(str(dec(Buffer.from('9jqo', 'latin1'))), 'Man');
  assert.equal(str(dec(Buffer.from('F*2=', 'latin1'))), 'sum');
  // z is shorthand for four zero bytes
  assert.deepEqual(Array.from(dec(Buffer.from('z', 'latin1'))), [0, 0, 0, 0]);
  // a <~ … ~> wrapper is tolerated and the terminator stops the read
  assert.equal(str(dec(Buffer.from('<~87cURD]j7BEbo80~>junk', 'latin1'))), 'Hello world!');
});

test('a ToUnicode CMap turns subset glyph codes back into text', function () {
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '1 begincodespacerange <0000> <FFFF> endcodespacerange',
    '2 beginbfchar <0001> <0042> <0002> <0043> endbfchar',
    '1 beginbfrange <0003> <0005> <0058> endbfrange'
  ].join('\n');
  const m = PLAN.helpers.parseToUnicode(cmap);
  assert.equal(m.width, 2, 'a 4-hex codespace means two-byte codes');
  assert.equal(m.map[1], 'B');
  assert.equal(m.map[2], 'C');
  assert.equal(m.map[3], 'X');
  assert.equal(m.map[5], 'Z', 'bfrange must expand across the range');
  assert.equal(m.size, 5);
});

test('a filter this reader cannot decode is named, not silently empty', async function () {
  // hand-build a page whose content claims an LZW filter
  const pdf = Buffer.from(
    '%PDF-1.4\n' +
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >> endobj\n' +
    '4 0 obj << /Length 4 /Filter /LZWDecode >>\nstream\n\x80\x0b\x60\x50\nendstream endobj\n' +
    'trailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
  const r = await PLAN.readPdf(pdf);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unsupportedFilters, ['LZWDecode']);
  assert.match(r.reason, /LZWDecode/);
});

/* --- inference discipline ------------------------------------------- */
test('numbers outside a believable bay range are not taken as a grid', async function () {
  const r = await PLAN.readPdf(load('plain.pdf'));
  const chain = PLAN.helpers.dimensionChain(r.texts, 'x');
  chain.bays.forEach(function (b) {
    assert.ok(b >= PLAN.READ.span.minMm && b <= PLAN.READ.span.maxMm, b + ' is not a bay');
  });
  // the sheet also letters "1:100" and "125" — neither may enter the chain
  assert.ok(!chain.bays.includes(100));
  assert.ok(!chain.bays.includes(125));
});

test('a document that is not a drawing yields no confident grid', async function () {
  // prose with numbers in it, laid out as a paragraph rather than a dimension chain
  const body = ['BT /F1 10 Tf 50 700 Td (Revenue grew to 4500 units in 2024 and 3200 in 2023.) Tj ET']
    .join('\n');
  const pdf = Buffer.from(
    '%PDF-1.4\n' +
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
    '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj\n' +
    '4 0 obj << /Length ' + body.length + ' >>\nstream\n' + body + '\nendstream endobj\n' +
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n' +
    'trailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
  const r = await PLAN.readPdf(pdf);
  assert.equal(r.ok, true, 'the text should still be read');
  const p = PLAN.inferPlan(r);
  // one line of prose cannot form a chain in both directions
  assert.ok(!p.fields.baysY, 'a paragraph must not become a bay chain down the sheet');
  assert.ok(p.notes.length > 0, 'the gaps must be reported');
});

/* --- the seam into the detailing engine ------------------------------ */
test('a read sheet drives the existing frame and schedule unchanged', async function () {
  const r = await PLAN.readPdf(load('flate.pdf'));
  const plan = PLAN.inferPlan(r);
  const built = PLAN.planToFrameSpec(plan, {});

  assert.deepEqual(built.spec.baysXMm, [3000, 3600, 3000]);
  assert.equal(built.spec.floors, 2);
  assert.equal(built.provenance.baysX.source, 'sheet');
  assert.match(built.provenance.baysX.from, /3000/);

  const F = frame(Object.assign({}, built.spec, {
    template: {
      footing: { bars: [{ label: 'Bottom X', along: 'length', position: 'bottom',
                          dia: 16, spacingMm: 150, end: 'bend' }] },
      column: { bars: [{ label: 'Vertical', position: 'main', dia: 20, count: 8, end: 'continuous' }],
                stirrups: { shape: 'STIRRUP_RECT', dia: 8, spacingMm: 150, legs: 2 } },
      beam: { bars: [{ label: 'Bottom main', position: 'bottom', dia: 16, count: 4, end: 'hook' }],
              stirrups: { shape: 'STIRRUP_RECT', dia: 8, spacingMm: 150, legs: 2 } },
      slab: { bars: [{ label: 'Short span', along: 'length', position: 'bottom',
                       dia: 10, spacingMm: 125, end: 'hook' }] }
    }
  }));

  // 4 x 3 grid lines from 3 x 2 bays, two floors
  assert.equal(F.grid.intersections, 12);
  const out = generate({ members: F.members });
  assert.ok(out.summary.grossKg > 0, 'the sheet produced no steel');
  assert.ok(out.summary.concreteM3 > 0);
  out.members.forEach(function (m) { assert.ok(m.cage, m.id + ' has no cage to draw'); });
});

test('members adopted from a sheet are marked unverified for review', async function () {
  const r = await PLAN.readPdf(load('flate.pdf'));
  const built = PLAN.planToFrameSpec(PLAN.inferPlan(r), {});
  const F = frame(Object.assign({}, built.spec, {
    template: { column: { bars: [{ label: 'Vertical', position: 'main', dia: 20,
                                   count: 8, end: 'continuous' }] } }
  }));
  const adopted = adoptExternalMembers(F.members, 'pdf-plan');
  adopted.forEach(function (m) {
    assert.equal(m.provenance.id.verified, false);
    assert.equal(m.provenance.concrete.widthMm ? m.provenance.concrete.widthMm.source : 'pdf-plan',
                 'pdf-plan');
  });
  const out = generate({ members: adopted });
  assert.ok(out.members[0].unverifiedFields > 0, 'the viewer must see there is something to confirm');
});

test('a default standing in for a missing reading is labelled as one', function () {
  const empty = { fields: {}, notes: [] };
  const built = PLAN.planToFrameSpec(empty, { floors: 3 });
  assert.equal(built.spec.floors, 3);
  assert.equal(built.provenance.floors.source, 'default');
  assert.match(built.provenance.floors.from, /not on the sheet/);
  Object.keys(built.provenance).forEach(function (k) {
    assert.equal(built.provenance[k].source, 'default', k + ' claimed to come from the sheet');
  });
});

/* --- READ thresholds are config, not scattered literals -------------- */
test('the reader reads its thresholds from READ at call time', async function () {
  const r = await PLAN.readPdf(load('plain.pdf'));
  const before = PLAN.inferPlan(r).fields.baysX;
  assert.ok(before);
  const saved = PLAN.READ.span.minMm;
  try {
    PLAN.READ.span.minMm = 9000;              // no bay on the sheet is this big
    const after = PLAN.inferPlan(r).fields.baysX;
    assert.ok(!after, 'raising the floor should reject the chain');
  } finally { PLAN.READ.span.minMm = saved; }
  assert.ok(PLAN.inferPlan(r).fields.baysX, 'READ was not restored');
});
