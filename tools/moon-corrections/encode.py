"""Write the shipped correction file (format v1, see
src/astronomy/moonCorrections.ts) from final.py's fits, and its Horizons
golden for the tests.

   python3 -I tools/moon-corrections/encode.py [--out public/ephemeris/moon-corrections.v1.bin]

Refuses to write when any moon's worst held-out error is over CEILING_KM.
Coefficients are quantized exactly as final.py scored them. The golden
(src/astronomy/moonCorrections.goldens.json) holds three Horizons positions
per moon from the fine grid, which no fit ever saw: one in each of its years.
"""
import sys, os, json, struct, argparse
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib as L
from final import load_terms, quantize

CEILING_KM = 100.0

ap = argparse.ArgumentParser()
ap.add_argument('--out', default=os.path.join(L.ROOT, 'public', 'ephemeris', 'moon-corrections.v1.bin'))
ap.add_argument('--golden', default=os.path.join(L.ROOT, 'src', 'astronomy', 'moonCorrections.goldens.json'))
args = ap.parse_args()

guard = json.load(open(os.path.join(L.DATA, 'guard.json')))
blob = bytearray()
blob += b'MSCR' + struct.pack('<HH', 1, len(L.ORDER))
blob += struct.pack('<7d', L.T0, L.S0, L.S1, L.T0, L.T1, *guard['guardJd'])
golden = {'note': 'Horizons positions on the held-out fine grid (tools/moon-corrections). '
                  'km, ICRF axes, about the planet\'s centre; jdTdb is taken as TT.', 'moons': {}}
rng = np.random.default_rng(7)
misses = []
print(f'{"moon":10s} {"terms":>5s} {"bytes":>6s} {"held out km":>12s} {"elements alone km":>18s}')
for moon in L.ORDER:
    terms, spec = load_terms(moon)
    npz = np.load(os.path.join(L.OUT, f'coef_{moon}.npz'))
    fin = json.load(open(os.path.join(L.OUT, f'final_{moon}.json')))
    # the fit must come from exactly this term list (a stale coef file of the same size would pass a shape check)
    assert np.array_equal(npz['rates'], np.array([x.rate for x in terms])) and np.array_equal(npz['L'], np.array([x.L for x in terms])), moon
    assert fin['term_list'] == [repr(x) for x in terms], moon
    coef = npz['coef']
    held_out_km = max(fin['test_all']['max_km'], fin['fine']['max_km'])
    if held_out_km > CEILING_KM:
        misses.append(f'{moon} {held_out_km:.1f} km')
    qcoef, _, stored = quantize(terms, coef, fin['drop_km'])
    start = len(blob)
    name = moon.encode()
    blob += struct.pack('<B', len(name)) + name + struct.pack('<Hf', len(terms), held_out_km)
    blob += struct.pack('<6d', *guard['moons'][moon])
    off, _ = L.offsets_of(terms)
    for term, o, mask in zip(terms, off, stored):
        flags = (1 if term.ntrig == 1 else 0) | sum(2 << c for c in range(3) if mask[c])
        blob += struct.pack('<dfHB', term.rate, term.L, term.nbasis, flags)
        for c in range(3):
            if not mask[c]:
                continue
            block = coef[o:o + term.ncols, c]
            scale = float(np.float32(np.abs(block).max() / 32767.0))
            ints = np.clip(np.round(block / scale), -32767, 32767).astype('<i2')
            assert np.allclose(ints * scale, qcoef[o:o + term.ncols, c])
            blob += struct.pack('<f', scale) + ints.tobytes()
    print(f'{moon:10s} {len(terms):5d} {len(blob) - start:6d} {held_out_km:12.1f} {fin["baseline_window"]["max_km"]:18.0f}')
    tf, truthf, _, _ = L.load(moon, 'fine')
    years = L.year_of(tf)
    rows = []
    for year in sorted(set(years.tolist())):
        k = int(rng.choice(np.where(years == year)[0]))
        rows.append({'jdTdb': float(tf[k]), 'km': [float(v) for v in truthf[k]]})
    golden['moons'][moon] = rows

if misses:
    raise SystemExit(f'encode: over the {CEILING_KM:g} km ceiling, nothing written: ' + ', '.join(misses))
open(args.out, 'wb').write(blob)
json.dump(golden, open(args.golden, 'w'), indent=1)
open(args.golden, 'a').write('\n')
print(f'wrote {os.path.relpath(args.out, L.ROOT)}: {len(blob)} bytes ({len(blob) / 1024:.1f} KiB), '
      f'and {os.path.relpath(args.golden, L.ROOT)}')
