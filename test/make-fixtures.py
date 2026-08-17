"""Build small structural-drawing PDFs to test src/plan.js against.

These are written by hand rather than with a library so the expected values
are known exactly. Three variants:

  plain.pdf   uncompressed content stream
  flate.pdf   FlateDecode content stream
  objstm.pdf  objects packed into a compressed object stream (PDF 1.5)
  scanned.pdf a page holding only an image, no text - must be detected, not guessed

Run: py -3.13 test/make-fixtures.py
"""
import os
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'fixtures')

# ---------------------------------------------------------------- drawing ----
# A 3 x 2 bay grid at 3000 / 3600 / 3000 across and 3600 / 3600 down, G+1,
# with the schedules an engineer would letter onto the sheet.
GRID_X = [3000, 3600, 3000]
GRID_Y = [3600, 3600]

TEXT = []


def t(x, y, s, size=9):
    TEXT.append((x, y, s, size))


# dimension chain across the top: the numbers sit between the grid lines
t(90, 545, 'GROUND + FIRST FLOOR FRAMING PLAN', 13)
t(90, 528, 'SCALE 1:100   ALL DIMENSIONS IN mm', 8)

xs = [80]
for b in GRID_X:
    xs.append(xs[-1] + b / 20.0)          # 1:20 of a mm on the sheet
for i, b in enumerate(GRID_X):
    t((xs[i] + xs[i + 1]) / 2 - 12, 500, str(b), 10)

ys = [460]
for b in GRID_Y:
    ys.append(ys[-1] - b / 20.0)
for i, b in enumerate(GRID_Y):
    t(52, (ys[i] + ys[i + 1]) / 2, str(b), 10)

# schedules
t(430, 470, 'COLUMN SCHEDULE', 10)
t(430, 455, 'C1   300 x 450   8 NOS 20 DIA', 9)
t(430, 442, 'TIES 8 DIA @ 150 C/C', 9)
t(430, 420, 'BEAM SCHEDULE', 10)
t(430, 405, 'B1   230 x 450', 9)
t(430, 392, '4 NOS 16 DIA BOTTOM, 2 NOS 12 DIA TOP', 9)
t(430, 379, 'STIRRUPS 8 DIA @ 150 C/C', 9)
t(430, 357, 'SLAB   125 THK', 10)
t(430, 344, '10 DIA @ 125 C/C BOTH WAYS', 9)
t(430, 322, 'FOOTING F1   1500 x 1500 x 450', 10)
t(430, 309, '16 DIA @ 150 C/C BOTH WAYS', 9)
t(430, 287, 'CLEAR COVER 40 mm COLUMNS, 25 mm BEAMS', 9)
t(430, 274, 'CONCRETE M25   STEEL Fe500', 9)
t(430, 261, 'FLOORS G+1   FLOOR HEIGHT 3000', 9)

LINES = []
for x in xs:
    LINES.append((x, ys[-1] - 20, x, ys[0] + 20))
for y in ys:
    LINES.append((xs[0] - 20, y, xs[-1] + 20, y))


def esc(s):
    return s.replace('\\', r'\\').replace('(', r'\(').replace(')', r'\)')


def content_stream():
    ops = ['0.6 w']
    for (x0, y0, x1, y1) in LINES:
        ops.append('%.2f %.2f m %.2f %.2f l S' % (x0, y0, x1, y1))
    # a couple of filled rects, as a column blob would be drawn
    for x in xs:
        for y in ys:
            ops.append('%.2f %.2f 8 12 re f' % (x - 4, y - 6))
    for (x, y, s, size) in TEXT:
        ops.append('BT /F1 %d Tf %.2f %.2f Td (%s) Tj ET' % (size, x, y, esc(s)))
    return '\n'.join(ops).encode('latin-1')


# ------------------------------------------------------------------ writer ----
def build(path, compress=False, objstm=False, scanned=False):
    if scanned:
        body = b'q 500 0 0 300 80 200 cm /Im0 Do Q'
    else:
        body = content_stream()

    objs = {}
    if compress:
        objs[4] = (b'<< /Length %d /Filter /FlateDecode >>' % len(zlib.compress(body)),
                   zlib.compress(body))
    else:
        objs[4] = (b'<< /Length %d >>' % len(body), body)

    res = b'<< /Font << /F1 5 0 R >> >>'
    if scanned:
        res = (b'<< /XObject << /Im0 6 0 R >> >>')
        px = bytes([200]) * (8 * 8)
        objs[6] = (b'<< /Type /XObject /Subtype /Image /Width 8 /Height 8 '
                   b'/ColorSpace /DeviceGray /BitsPerComponent 8 /Length %d >>' % len(px), px)

    objs[1] = (b'<< /Type /Catalog /Pages 2 0 R >>', None)
    objs[2] = (b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>', None)
    objs[3] = (b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] '
               b'/Resources ' + res + b' /Contents 4 0 R >>', None)
    objs[5] = (b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', None)

    out = bytearray(b'%PDF-1.5\n')
    offsets = {}

    if objstm:
        # pack the plain dictionary objects into one compressed object stream
        packed = [n for n in (1, 2, 3, 5) if n in objs]
        pairs, blob = [], bytearray()
        for n in packed:
            pairs.append('%d %d' % (n, len(blob)))
            blob += objs[n][0] + b'\n'
        header = (' '.join(pairs) + '\n').encode('latin-1')
        full = header + bytes(blob)
        comp = zlib.compress(full)
        stm = (b'<< /Type /ObjStm /N %d /First %d /Length %d /Filter /FlateDecode >>'
               % (len(packed), len(header), len(comp)))
        objs = {k: v for k, v in objs.items() if k not in packed}
        objs[7] = (stm, comp)

    for n in sorted(objs):
        d, s = objs[n]
        offsets[n] = len(out)
        out += b'%d 0 obj\n' % n + d + b'\n'
        if s is not None:
            out += b'stream\n' + s + b'\nendstream\n'
        out += b'endobj\n'

    start = len(out)
    top = max(offsets) + 1
    out += b'xref\n0 %d\n' % top
    out += b'0000000000 65535 f \n'
    for n in range(1, top):
        out += (b'%010d 00000 n \n' % offsets[n]) if n in offsets else b'0000000000 65535 f \n'
    out += b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (top, start)

    open(path, 'wb').write(bytes(out))
    return len(out)


if __name__ == '__main__':
    if not os.path.isdir(OUT):
        os.makedirs(OUT)
    for name, kw in [('plain.pdf', {}),
                     ('flate.pdf', {'compress': True}),
                     ('objstm.pdf', {'compress': True, 'objstm': True}),
                     ('scanned.pdf', {'scanned': True})]:
        n = build(os.path.join(OUT, name), **kw)
        print('%-12s %6d bytes' % (name, n))
    print('grid x', GRID_X, 'grid y', GRID_Y)
