"""Fit the moon corrections (src/astronomy/moonCorrections.ts) to JPL Horizons
and write public/ephemeris/moon-corrections.v1.bin with its test golden.

   npm run gen:moon-corrections [-- --offline] [-- --jobs 4]

Needs python3 with numpy. The Horizons fetch is cached under
.moon-data-cache/horizons-moons (about 300 MB; --offline refuses to fetch a
miss); everything derived goes under .moon-data-cache/moon-corrections, logs
included. About ten minutes on four cores from a warm cache.

Steps:
  1. fetch.mjs          Horizons vectors on each moon's grids
  2. export.test.ts     the app's mean-element model at the same instants, and
                        at the two guard dates
  3. greedy.py          each moon's terms, from the spectrum of the residual,
                        at each knot-spacing option
  4. (here)             the option with the better validation maximum
  5. final.py           fit on train + val, score on the held-out test split
                        and the fine grid
  6. encode.py          the file and its golden; refuses a moon over 100 km

A fit that changes ships under a new name (moon-corrections.v2.bin), as every
data file does: the service worker keeps the old one under the old name.
Every moon must be refitted after `npm run gen:moons`: the corrections are
residuals against those elements, and moonCorrections.test.ts fails until
they match again.
"""
import sys, os, json, shutil, subprocess, argparse, time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lib as L

# (constant-term, periodic-term) knot spacings in days, chosen between on
# validation only. Iapetus has one: at a one-year constant spline its few
# orbits per knot overfit.
DEFAULT_OPTIONS = [(365.25, 1826.25), (1461.0, 1826.25)]
OPTIONS = {moon: DEFAULT_OPTIONS for moon in L.ORDER}
OPTIONS['Iapetus'] = [(1461.0, 3652.5)]

ap = argparse.ArgumentParser()
ap.add_argument('--offline', action='store_true')
ap.add_argument('--jobs', type=int, default=4)
args = ap.parse_args()
LOGS = os.path.join(L.WORK, 'logs')
os.makedirs(LOGS, exist_ok=True)
os.makedirs(L.OUT, exist_ok=True)
ENV = dict(os.environ, OMP_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1')
PY = ['python3', '-I']
TOOL = os.path.relpath(HERE, L.ROOT)
T_START = time.time()


def run(cmd, log, env=None):
    with open(os.path.join(LOGS, log), 'w') as fh:
        result = subprocess.run(cmd, cwd=L.ROOT, stdout=fh, stderr=subprocess.STDOUT, env=env or ENV)
    if result.returncode != 0:
        raise SystemExit(f'failed ({result.returncode}): {" ".join(cmd)} -- see {os.path.join(LOGS, log)}')


def stage(name):
    print(f'[{time.time() - T_START:6.0f} s] {name}', flush=True)


def parallel(jobs):
    with ThreadPoolExecutor(args.jobs) as pool:
        for future in [pool.submit(run, *job) for job in jobs]:
            future.result()


stage('fetch')
run(['node', f'{TOOL}/fetch.mjs'] + (['--offline'] if args.offline else []), 'fetch.log')
stage('model export')
run(['npx', 'vitest', 'run', '--dir', TOOL, 'export', '--reporter=verbose', '--silent=false'], 'export.log',
    dict(ENV, MOON_CORRECTIONS_EXPORT='1'))

stage('greedy term selection')
jobs = []
for moon in L.ORDER:
    for constant_days, periodic_days in OPTIONS[moon]:
        tag = f'_lc{constant_days:g}'
        jobs.append((PY + [f'{TOOL}/greedy.py', moon, '--Lc', str(constant_days), '--Lp', str(periodic_days), '--max', '40', '--tag', tag],
                     f'greedy_{moon}{tag}.log'))
parallel(jobs)

stage('choose the constant spline on validation')
for moon in L.ORDER:
    best = None
    for constant_days, _ in OPTIONS[moon]:
        spec = json.load(open(os.path.join(L.OUT, f'terms_{moon}_lc{constant_days:g}.json')))
        validation_max = min(entry['val_max'] for entry in spec['history'])
        if best is None or validation_max < best[0]:
            best = (validation_max, constant_days)
    shutil.copyfile(os.path.join(L.OUT, f'terms_{moon}_lc{best[1]:g}.json'), os.path.join(L.OUT, f'terms_{moon}.json'))

stage('fit and score')
parallel([(PY + [f'{TOOL}/final.py', moon], f'final_{moon}.log') for moon in L.ORDER])
for moon in L.ORDER:
    print('  ' + open(os.path.join(LOGS, f'final_{moon}.log')).read().strip())
stage('encode')
run(PY + [f'{TOOL}/encode.py'], 'encode.log')
print(open(os.path.join(LOGS, 'encode.log')).read())
stage('done')
