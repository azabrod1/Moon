"""Shared by the moon-correction generator (run.py): load Horizons vectors and
the app's mean-element model at the same instants, form the residual in the
model's radial / along-track / normal frame, and fit spline-modulated
harmonic corrections to it. src/astronomy/moonCorrections.ts evaluates the
same model.

Data (written by fetch.mjs and export.test.ts), under
.moon-data-cache/moon-corrections/data:
  <moon>.<grid>.f64        rows (jdTdb, x, y, z)       Horizons, km, ICRF
  <moon>.<grid>.model.f64  rows (x, y, z, nx, ny, nz)  app model, km, ICRF
  elements.json            the app's element records
  guard.json               the app model at the two guard dates
Grids: main (fitted and scored), fine (an independent grid in three test
years, scored only), margin (two years past each end, fitted only).
"""
import json, os, math
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
WORK = os.path.join(ROOT, '.moon-data-cache', 'moon-corrections')
DATA = os.path.join(WORK, 'data')
OUT = os.path.join(WORK, 'out')
T0 = 2415020.5
T1 = T0 + 143 * 512
# The splines run two years past each end of the window, where fit-only
# margin samples hold them; past T0 and T1 the app eases the correction out.
PAD = 735.0
S0, S1 = T0 - PAD, T1 + PAD
DEG = math.pi / 180

# moon -> (parent, system, period in days for the timing metric)
MOONS = {
    'Phobos': ('Mars', 'mars', 0.3189),
    'Deimos': ('Mars', 'mars', 1.2624),
    'Io': ('Jupiter', 'jup', 1.769),
    'Europa': ('Jupiter', 'jup', 3.551),
    'Ganymede': ('Jupiter', 'jup', 7.155),
    'Callisto': ('Jupiter', 'jup', 16.689),
    'Mimas': ('Saturn', 'sat', 0.942),
    'Enceladus': ('Saturn', 'sat', 1.370),
    'Tethys': ('Saturn', 'sat', 1.888),
    'Dione': ('Saturn', 'sat', 2.737),
    'Rhea': ('Saturn', 'sat', 4.518),
    'Titan': ('Saturn', 'sat', 15.945),
    'Iapetus': ('Saturn', 'sat', 79.32),
    'Miranda': ('Uranus', 'ura', 1.413),
    'Ariel': ('Uranus', 'ura', 2.520),
    'Umbriel': ('Uranus', 'ura', 4.144),
    'Titania': ('Uranus', 'ura', 8.706),
    'Oberon': ('Uranus', 'ura', 13.463),
    'Triton': ('Neptune', 'nep', 5.877),
    'Charon': ('Pluto', 'plu', 6.387),
}
ORDER = list(MOONS)


def system_of(moon):
    return [m for m in ORDER if MOONS[m][1] == MOONS[moon][1]]


_elements = None


def elements(moon):
    global _elements
    if _elements is None:
        _elements = json.load(open(os.path.join(DATA, 'elements.json')))
    return _elements[moon]


def rates(moon):
    """Model angle rates (rad/day) and values at T0: mean anomaly M, argument
    of latitude u = M + w, summed longitude lam = M + w + node."""
    e = elements(moon)
    dt0 = T0 - e['epochJdTdb']
    Md, wd, Nd = e['meanAnomalyRateDegPerDay'], e['argPeriapsisRateDegPerDay'], e['ascendingNodeRateDegPerDay']
    M0 = e['meanAnomalyAtEpochDeg'] + Md * dt0
    w0 = e['argPeriapsisAtEpochDeg'] + wd * dt0
    N0 = e['ascendingNodeAtEpochDeg'] + Nd * dt0
    return {
        'M': (M0 * DEG, Md * DEG), 'u': ((M0 + w0) * DEG, (Md + wd) * DEG),
        'lam': ((M0 + w0 + N0) * DEG, (Md + wd + Nd) * DEG), 'w': (w0 * DEG, wd * DEG), 'node': (N0 * DEG, Nd * DEG),
    }


def load(moon, grid='main'):
    raw = np.fromfile(os.path.join(DATA, f'{moon}.{grid}.f64')).reshape(-1, 4)
    mod = np.fromfile(os.path.join(DATA, f'{moon}.{grid}.model.f64')).reshape(-1, 6)
    assert len(raw) == len(mod)
    return raw[:, 0].copy(), raw[:, 1:4].copy(), mod[:, 0:3].copy(), mod[:, 3:6].copy()


def load_margin(moon):
    """Fit-only samples two years past each end: (t, RTN residual)."""
    t, truth, model, normal = load(moon, 'margin')
    return t, to_rtn(truth - model, *frame(model, normal))


def frame(model, normal):
    r = model / np.linalg.norm(model, axis=1)[:, None]
    n = normal / np.linalg.norm(normal, axis=1)[:, None]
    a = np.cross(n, r)
    return r, a, n


def to_rtn(vec, r, a, n):
    return np.stack([(vec * r).sum(1), (vec * a).sum(1), (vec * n).sum(1)], axis=1)


def from_rtn(rtn, r, a, n):
    return rtn[:, 0:1] * r + rtn[:, 1:2] * a + rtn[:, 2:3] * n


# Calendar years (TDB Julian Date of 1 January, Gregorian)
def jd_of_year(y):
    a = (14 - 1) // 12
    yy = y + 4800 - a
    m = 1 + 12 * a - 3
    return 1 + (153 * m + 2) // 5 + 365 * yy + yy // 4 - yy // 100 + yy // 400 - 32045 - 0.5


YEAR_STARTS = np.array([jd_of_year(y) for y in range(1899, 2102)])


def year_of(t):
    return 1899 + np.searchsorted(YEAR_STARTS, t, side='right') - 1


def splits(t, seed=20261117):
    """Three-way split on the main grid.
    test:  every fifth year from 1902 (whole years), and in the other years a
           random quarter of the samples
    val:   every fifth year from 1904 (whole years), and another random
           quarter in the remaining years -- used only to choose settings
    train: the rest.  The final fit uses train + val and is scored on test.
    The interleave is random, not every n-th sample, so the zero-filled
    training spectrum carries no comb aliases."""
    y = year_of(t)
    u = np.random.default_rng(seed).random(len(t))
    test_year = (y % 5) == 2
    val_year = (y % 5) == 4
    other = ~test_year & ~val_year
    test = test_year | (other & (u < 0.25))
    val = val_year | (other & (u >= 0.25) & (u < 0.5))
    train = ~test & ~val
    return train, val, test, test_year, val_year


# ---------------------------------------------------------------- the model

def bspline_weights(t, L, t0=S0, t1=S1):
    """Uniform cubic B-spline on knots t0 + k L: first basis index j and the
    four weights for basis functions j .. j+3. nbasis = nseg + 3."""
    nseg = int(math.ceil((t1 - t0) / L - 1e-9))
    s = (t - t0) / L
    j = np.clip(np.floor(s).astype(np.int64), 0, nseg - 1)
    u = s - j
    u2, u3 = u * u, u * u * u
    w = np.stack([(1 - u) ** 3 / 6, (3 * u3 - 6 * u2 + 4) / 6, (-3 * u3 + 3 * u2 + 3 * u + 1) / 6, u3 / 6], axis=1)
    return j, w, nseg + 3


class Term:
    """One argument psi(t) = rate (t - T0), with cos/sin coefficients for R, T,
    N on a cubic B-spline of knot spacing L days. rate == 0 means the
    constant term (cos only)."""

    def __init__(self, name, rate, L):
        self.name, self.rate, self.L = name, rate, L
        self.ntrig = 1 if rate == 0 else 2
        self.nbasis = bspline_weights(np.array([T0]), L)[2]
        self.ncols = self.nbasis * self.ntrig

    def trig(self, t):
        if self.ntrig == 1:
            return np.ones((len(t), 1))
        psi = self.rate * (t - T0)
        return np.stack([np.cos(psi), np.sin(psi)], axis=1)

    def __repr__(self):
        per = 2 * math.pi / self.rate if self.rate else float('inf')
        return f'{self.name}(P={per:.4f} d, L={self.L:g} d)'


def local_design(t, terms, offsets):
    """Dense design over the columns active in this chunk of instants."""
    blocks, cols = [], []
    for term, off in zip(terms, offsets):
        j, w, nb = bspline_weights(t, term.L)
        jmin, jmax = j.min(), j.max() + 3
        span = jmax - jmin + 1
        B = np.zeros((len(t), span))
        rows = np.arange(len(t))
        for i in range(4):
            B[rows, j - jmin + i] += w[:, i]
        tr = term.trig(t)
        blk = (B[:, :, None] * tr[:, None, :]).reshape(len(t), span * term.ntrig)
        blocks.append(blk)
        base = off + jmin * term.ntrig
        cols.append(np.arange(base, base + span * term.ntrig))
    return np.hstack(blocks), np.concatenate(cols)


def offsets_of(terms):
    off, o = [], 0
    for term in terms:
        off.append(o)
        o += term.ncols
    return off, o


def normal_equations(t, Y, terms, lam=1e-3, chunk=8000):
    """X'X and X'Y for all spline coefficients, plus a second-difference
    penalty on each coefficient sequence (weight lam times the mean number of
    samples per knot, so lam is comparable across moons and spacings)."""
    order = np.argsort(t)
    t, Y = t[order], Y[order]
    off, ncols = offsets_of(terms)
    A = np.zeros((ncols, ncols))
    b = np.zeros((ncols, Y.shape[1]))
    for s in range(0, len(t), chunk):
        X, c = local_design(t[s:s + chunk], terms, off)
        A[np.ix_(c, c)] += X.T @ X
        b[c] += X.T @ Y[s:s + chunk]
    for term, o in zip(terms, off):
        nb = term.nbasis
        D = np.diff(np.eye(nb), 2, axis=0)
        P = D.T @ D * lam * (len(t) / (T1 - T0) * term.L) * 0.5
        for k in range(term.ntrig):
            idx = o + np.arange(nb) * term.ntrig + k
            A[np.ix_(idx, idx)] += P
    A[np.diag_indices(ncols)] += 1e-9 * np.mean(np.diag(A))
    return A, b


def fit(t, Y, terms, lam=1e-3):
    A, b = normal_equations(t, Y, terms, lam)
    return np.linalg.solve(A, b)


def predict(t, terms, coef):
    off, _ = offsets_of(terms)
    out = np.zeros((len(t), coef.shape[1]))
    for term, o in zip(terms, off):
        j, w, nb = bspline_weights(t, term.L)
        C = coef[o:o + term.ncols].reshape(nb, term.ntrig, -1)
        tr = term.trig(t)
        val = np.zeros((len(t), term.ntrig, coef.shape[1]))
        for i in range(4):
            val += w[:, i, None, None] * C[j + i]
        out += (val * tr[:, :, None]).sum(1)
    return out


# ------------------------------------------------------------------ metrics

def metrics(truth, corrected, moon):
    err = np.linalg.norm(truth - corrected, axis=1)
    cosang = (truth * corrected).sum(1) / (np.linalg.norm(truth, axis=1) * np.linalg.norm(corrected, axis=1))
    phase = np.degrees(np.arccos(np.clip(cosang, -1, 1)))
    period = MOONS[moon][2]
    return {
        'max_km': float(err.max()), 'rms_km': float(np.sqrt((err ** 2).mean())),
        'phase_max_deg': float(phase.max()), 'timing_max_min': float(phase.max() / 360 * period * 1440),
        'n': int(len(err)),
    }
