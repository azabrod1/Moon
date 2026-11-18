"""Final fit and held-out score for one moon, with the coefficients rounded
the way the shipped file stores them.

   python3 -I tools/moon-corrections/final.py <moon>

Reads out/terms_<moon>.json (greedy.py's terms at the knot spacing run.py
chose on validation), fits on train + val (and the fit-only margins two years
past each end of the window), and scores on the test split only: the whole
test years (every fifth year from 1902), the random test quarter of the other
years, and the independent fine grid fetched inside three test years. Writes
out/final_<moon>.json and out/coef_<moon>.npz for encode.py.

Storage per term: rate f64, knot spacing f32, basis count u16, flags u8; per
stored component: scale f32, then int16 coefficients (nbasis x ntrig). A
component is dropped from a term when its largest coefficient is under
`--drop` km (default 0.5 km).
"""
import sys, os, json, argparse
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib as L

# name length + name (up to 9 chars), term count u16, heldOutKm f32, guard 6 x f64
HEADER_BYTES_PER_MOON = 16 + 48
TERM_HEADER_BYTES = 8 + 4 + 2 + 1  # rate f64, knotDays f32, basisCount u16, flags u8


def quantize(terms, coef, drop_km):
    off, _ = L.offsets_of(terms)
    q = coef.copy()
    nbytes = HEADER_BYTES_PER_MOON
    stored = []
    for term, o in zip(terms, off):
        nbytes += TERM_HEADER_BYTES
        mask = []
        for c in range(3):
            block = coef[o:o + term.ncols, c]
            peak = np.abs(block).max()
            if peak < drop_km:
                q[o:o + term.ncols, c] = 0
                mask.append(False)
                continue
            scale = float(np.float32(peak / 32767.0))
            ints = np.clip(np.round(block / scale), -32767, 32767)
            q[o:o + term.ncols, c] = ints * scale
            nbytes += 4 + 2 * term.ncols
            mask.append(True)
        stored.append(mask)
    return q, nbytes, stored


def score(moon, terms, lam, drop_km=0.5):
    t, truth, model, normal = L.load(moon)
    r, a, n = L.frame(model, normal)
    Y = L.to_rtn(truth - model, r, a, n)
    train, val, test, test_year, val_year = L.splits(t)
    fitmask = train | val
    tm, Ym = L.load_margin(moon)
    coef = L.fit(np.concatenate([t[fitmask], tm]), np.vstack([Y[fitmask], Ym]), terms, lam)
    qcoef, nbytes, stored = quantize(terms, coef, drop_km)
    out = {'moon': moon, 'terms': len(terms), 'bytes': int(nbytes), 'lam': lam,
           'term_list': [repr(x) for x in terms], 'stored_components': stored}

    def corrected(tt, mod, nor, c):
        rr, aa, nn = L.frame(mod, nor)
        return mod + L.from_rtn(L.predict(tt, terms, c), rr, aa, nn)

    sets = {'test_all': test, 'test_years': test_year, 'test_interleaved': test & ~test_year, 'fit_samples': fitmask}
    for label, m in sets.items():
        out[label] = L.metrics(truth[m], corrected(t[m], model[m], normal[m], qcoef), moon)
    tf, truthf, modelf, normalf = L.load(moon, 'fine')
    out['fine'] = L.metrics(truthf, corrected(tf, modelf, normalf, qcoef), moon)
    out['baseline_window'] = L.metrics(truth, model, moon)
    m = out['test_all']
    print(f'{moon}: {len(terms)} terms, {nbytes} bytes; mean elements alone {out["baseline_window"]["max_km"]:.0f} km at worst;'
          f' corrected, held out: max {max(m["max_km"], out["fine"]["max_km"]):.1f} km, rms {m["rms_km"]:.1f} km,'
          f' phase {m["phase_max_deg"]:.4f} deg, timing {m["timing_max_min"]:.2f} min')
    return out, coef, qcoef


def load_terms(moon):
    spec = json.load(open(os.path.join(L.OUT, f'terms_{moon}.json')))
    terms = [L.Term(x['name'], x['rate'], x['L']) for x in spec['terms']]
    return terms, spec


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('moon')
    ap.add_argument('--drop', type=float, default=0.5)
    args = ap.parse_args()
    terms, spec = load_terms(args.moon)
    out, coef, qcoef = score(args.moon, terms, spec['lam'], args.drop)
    out['spec'] = {k: spec[k] for k in ('Lc', 'Lp', 'lam')}
    out['drop_km'] = args.drop
    json.dump(out, open(os.path.join(L.OUT, f'final_{args.moon}.json'), 'w'), indent=1)
    np.savez(os.path.join(L.OUT, f'coef_{args.moon}.npz'), coef=coef, qcoef=qcoef,
             rates=np.array([x.rate for x in terms]), L=np.array([x.L for x in terms]))
