"""Choose a moon's correction terms greedily from the spectrum of what is
left, on training data only, stopping on the validation split (run.py runs
it for each moon at each knot-spacing option).

   python3 -I tools/moon-corrections/greedy.py <moon> [--Lc days] [--Lp days] [--lam x] [--max n] [--tag suffix]

Each round: residual (training samples) -> zero-filled FFT on the uniform
grid -> strongest line (summed over R, T, N) above the slow band -> its
frequency, matched to an integer combination of the system's model
longitude rates (and the moon's own apse/node rates, and the planet's
heliocentric mean motion) when one lies within 1.5 bins -> new term ->
refit everything. Writes out/terms_<moon><tag>.json.
"""
import sys, os, json, itertools, argparse, time
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib as L

PLANET_PERIOD_D = {'Mars': 686.98, 'Jupiter': 4332.59, 'Saturn': 10759.22, 'Uranus': 30688.5, 'Neptune': 60182.0, 'Pluto': 90560.0}


class Candidates:
    """Integer combinations sum k_j lam_j (at most 3 moons, |k_j| <= 4,
    sum |k_j| <= 7) + p wdot + q nodedot + s n_planet (|p|,|q|,|s| <= 2) of the
    model rates, in cycles/day; labels built on demand."""

    def __init__(self, moon):
        sysm = L.system_of(moon)
        own = L.rates(moon)
        self.names = [m[:2] for m in sysm] + ['w', 'N', 'S']
        base = np.array([L.rates(m)['lam'][1] / (2 * np.pi) for m in sysm] +
                        [own['w'][1] / (2 * np.pi), own['node'][1] / (2 * np.pi), 1 / PLANET_PERIOD_D[L.MOONS[moon][0]]])
        nm = len(sysm)
        combos = [np.zeros(nm, int)]
        for count in (1, 2, 3):
            for which in itertools.combinations(range(nm), count):
                for ks in itertools.product([k for k in range(-4, 5) if k], repeat=count):
                    if sum(abs(k) for k in ks) > 7:
                        continue
                    v = np.zeros(nm, int)
                    v[list(which)] = ks
                    combos.append(v)
        moonpart = np.array(combos)
        extra = np.array(list(itertools.product(range(-2, 3), repeat=3)))
        K = np.hstack([np.repeat(moonpart, len(extra), axis=0), np.tile(extra, (len(moonpart), 1))])
        f = K @ base
        keep = f > 0
        self.K, self.f = K[keep], f[keep]
        self.complexity = np.abs(self.K).sum(1)

    def label(self, i):
        return ' '.join(f'{k:+d}{n}' for k, n in zip(self.K[i], self.names) if k)

    def match(self, f, tol):
        # only simple combinations: in Saturn's system almost any frequency lies
        # within a bin of some complicated one, which would name nothing
        near = np.where((np.abs(self.f - f) <= tol) & (self.complexity <= 5))[0]
        if not len(near):
            return None
        return near[np.argmin(self.complexity[near] * 1000 + np.abs(self.f[near] - f) / tol)]


def strongest_line(t_all, res_full, have, fmin, exclude):
    """Zero-filled Hann FFT of the training residual on the uniform grid."""
    N = len(t_all)
    dt = t_all[1] - t_all[0]
    win = np.hanning(N) * have
    freqs = np.fft.rfftfreq(N, dt)
    amp2 = 0
    comps = []
    for c in range(3):
        F = np.fft.rfft(res_full[:, c] * win)
        a = 2 * np.abs(F) / win.sum()
        comps.append(a)
        amp2 = amp2 + a ** 2
    tot = np.sqrt(amp2)
    ok = freqs > fmin
    for f0 in exclude:  # lines already modelled (spline modulation covers +-1/(3 Lp))
        ok &= np.abs(freqs - f0[0]) > f0[1]
    tot_ok = np.where(ok, tot, 0)
    k = int(np.argmax(tot_ok))
    # parabolic refinement on log amplitude
    if 0 < k < len(tot) - 1:
        y0, y1, y2 = np.log(tot[k - 1] + 1e-30), np.log(tot[k] + 1e-30), np.log(tot[k + 1] + 1e-30)
        d = 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2) if (y0 - 2 * y1 + y2) != 0 else 0
    else:
        d = 0
    f = freqs[k] + d * (freqs[1] - freqs[0])
    return f, tot[k], [comps[c][k] for c in range(3)], freqs[1] - freqs[0]


def evaluate(t, Y, terms, coef, mask):
    res = Y[mask] - L.predict(t[mask], terms, coef)
    e = np.linalg.norm(res, axis=1)
    return float(e.max()), float(np.sqrt((e ** 2).mean()))


def run(moon, Lc, Lp, lam, max_terms, min_amp, patience=4, verbose=True):
    t, truth, model, normal = L.load(moon)
    r, a, n = L.frame(model, normal)
    Y = L.to_rtn(truth - model, r, a, n)
    train, val, test, test_year, val_year = L.splits(t)
    val_in = val & ~val_year
    tm, Ym = L.load_margin(moon)
    cand = Candidates(moon)
    terms = [L.Term('const', 0.0, Lc)]
    fmin = 1.0 / (2.5 * Lc)
    exclude = []
    history = []
    best = (np.inf, None)
    stall = 0
    t_start = time.time()
    while True:
        coef = L.fit(np.concatenate([t[train], tm]), np.vstack([Y[train], Ym]), terms, lam)
        vmax, vrms = evaluate(t, Y, terms, coef, val)
        tmax, trms = evaluate(t, Y, terms, coef, train)
        ymax, _ = evaluate(t, Y, terms, coef, val_year)
        imax, _ = evaluate(t, Y, terms, coef, val_in)
        history.append({'terms': len(terms), 'val_max': vmax, 'val_rms': vrms, 'train_max': tmax, 'train_rms': trms,
                        'val_year_max': ymax, 'val_interleaved_max': imax, 'added': repr(terms[-1])})
        if verbose:
            print(f'  {len(terms):3d} terms  train max {tmax:9.1f} rms {trms:8.1f} | val max {vmax:9.1f} rms {vrms:8.1f}'
                  f' (years {ymax:8.1f}, interleaved {imax:8.1f})  [{time.time()-t_start:5.0f} s] {terms[-1]!r}', flush=True)
        if vmax < best[0] * 0.995:
            best = (vmax, list(terms))
            stall = 0
        else:
            stall += 1
        if stall >= patience or len(terms) >= max_terms:
            break
        res_full = np.zeros_like(Y)
        res_full[train] = Y[train] - L.predict(t[train], terms, coef)
        f, amp, comps, binw = strongest_line(t, res_full, train.astype(float), fmin, exclude)
        if amp < min_amp:
            if verbose:
                print(f'  strongest remaining line {amp:.2f} km < {min_amp} km: stop')
            break
        pick = cand.match(f, 0.6 * binw)
        if pick is not None:
            rate, label = cand.f[pick], cand.label(pick)
        else:
            rate, label = f, f'measured {f:.7f}'
        if verbose:
            print(f'      line {f:.7f} c/d (P {1/f:.3f} d) amp {amp:.1f} km [R {comps[0]:.1f} T {comps[1]:.1f} N {comps[2]:.1f}] -> {label}')
        terms.append(L.Term(label, 2 * np.pi * rate, Lp))
        exclude.append((rate, 1.0 / (3 * Lp)))
    return best[1], history


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('moon')
    ap.add_argument('--Lc', type=float, default=365.25)
    ap.add_argument('--Lp', type=float, default=1826.25)
    ap.add_argument('--lam', type=float, default=1e-3)
    ap.add_argument('--max', type=int, default=40)
    ap.add_argument('--min-amp', type=float, default=1.0)
    ap.add_argument('--tag', default='')
    args = ap.parse_args()
    terms, history = run(args.moon, args.Lc, args.Lp, args.lam, args.max, args.min_amp)
    os.makedirs(L.OUT, exist_ok=True)
    json.dump({'moon': args.moon, 'Lc': args.Lc, 'Lp': args.Lp, 'lam': args.lam,
               'terms': [{'name': x.name, 'rate': x.rate, 'L': x.L} for x in terms], 'history': history},
              open(os.path.join(L.OUT, f'terms_{args.moon}{args.tag}.json'), 'w'), indent=1)
    print(f'{args.moon}: chose {len(terms)} terms')
