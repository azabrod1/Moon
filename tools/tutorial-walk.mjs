// Walk the guided tutorial on a desktop window and at phone size, screenshot
// every beat and stop, and assert what each stop promises:
//   - a beat's spotlight rings a control that is on screen, and its bubble and
//     its cutout stay off the narrator card;
//   - the Saturn stop composes its subject inside the free area between the
//     chrome, with the ship model and the world labels out of the picture, a
//     live kicker on the card and the settled copy once the scene is up;
//   - the Moon stop waits for the user's own tap on the Moon row with "Show me"
//     offered (the desktop taps the row, the phone presses Show me), lands
//     quietly, opens the panel after the picture, presses Look up, and ends in
//     surface view with Earth on screen and a live phase on the card;
//   - Jupiter rings the time rail while the clock climbs three real detents to
//     1 hr/s with the panel closed; the eclipse presses the panel's own
//     next-solar arrow (parking three minutes before the 2027-08-02 peak),
//     rewinds to first contact, presses Look up, declutters the surface view
//     and approaches at 20 min/s, holding "Watching…" until totality's card;
//   - Next re-enables within a bound at every stop;
//   - ending the tour puts the ship, its heading, the landing and a live clock
//     back where the tour began;
//   - Esc in the middle of a beat drops the ring and the press at once, and
//     from a surface view the start had to leave it walks back in;
//   - on the phone, Back where I was from a surface view with the sheet
//     parked full brings the surface view and the park back;
//   - the wrap's three chips each restore the journey and then do what they
//     say: a teleport to Mars, the Moon landing with Earth overhead, the
//     Voyager 1 mission;
//   - the first run opens on the welcome, under which a held flight key does
//     not steer the ship, and whose three ways out all mark it
//     seen, and the ☰ row reads "Take the tour" until the tour has been
//     completed once, then "Replay the tour".
// Software rendering (the lab box has no GPU): frames take seconds, so every
// wait is state-driven and the time bounds are loose. Takes the browser lock.
// Usage: node tools/tutorial-walk.mjs [--url=http://127.0.0.1:5174] [--label=tutorial]
//        [--only=desktop|phone|chips] [--out=/tmp/moon-tutorial-walk]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { takeBrowserLock } from './browserLock.mjs';

const arg = (key, fallback) => {
  const match = process.argv.find((a) => a.startsWith(`--${key}=`));
  return match ? match.slice(key.length + 3) : fallback;
};
const URL = arg('url', 'http://127.0.0.1:5174');
const LABEL = arg('label', 'tutorial');
const ONLY = arg('only', null);
const OUT = `${arg('out', '/tmp/moon-tutorial-walk')}/${LABEL}`;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const GPU_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const log = [];
const failures = [];
const note = (line) => { console.log(line); log.push(line); };
const check = (ok, label, detail) => {
  const line = `${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`;
  note(`  ${line}`);
  if (!ok) failures.push(line);
};
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (inner, outer, tol = 0) =>
  inner.x >= outer.x - tol && inner.y >= outer.y - tol &&
  inner.x + inner.w <= outer.x + outer.w + tol && inner.y + inner.h <= outer.y + outer.h + tol;

const DESKTOP = { w: 1400, h: 900, dsf: 1 };
const PHONE = { w: 390, h: 844, dsf: 2 };
const SIZES = [['desktop', DESKTOP, false], ['phone', PHONE, true]].filter(([tag]) => !ONLY || tag === ONLY);

const release = await takeBrowserLock('tutorial-walk');
const browser = await chromium.launch({ headless: true, args: GPU_ARGS, executablePath: process.env.PW_CHROMIUM || undefined });
try {
  const fresh = async (viewport, { touch = false, helpSeen = true } = {}) => {
    const context = await browser.newContext({
      viewport: { width: viewport.w, height: viewport.h }, deviceScaleFactor: viewport.dsf ?? 1,
      hasTouch: touch, isMobile: touch,
    });
    // Software rendering: a click waits for a frame, and frames take seconds.
    context.setDefaultTimeout(120_000);
    await context.addInitScript((opts) => {
      try {
        // A fresh slate once per tab: a reload must keep what the page wrote.
        if (!sessionStorage.getItem('walk-cleared')) {
          localStorage.clear(); indexedDB.deleteDatabase('orbital-sim-storage');
          if (opts.helpSeen) localStorage.setItem('planetarium-help-seen', '1');
          localStorage.setItem('planetarium-surface-hint-seen', '1');
          sessionStorage.setItem('walk-cleared', '1');
        }
      } catch {}
      // Record what the page shows between polls: every veil caption shown,
      // and every press class put on a control (a press lasts 180 ms of
      // visible time — one frame under software rendering).
      window.__walk = { veilNotes: [], presses: [] };
      const watch = () => {
        const note = document.getElementById('arrival-veil-note');
        if (note) {
          new MutationObserver(() => {
            if (note.classList.contains('show') && note.textContent) window.__walk.veilNotes.push(note.textContent);
          }).observe(note, { attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true });
        }
        new MutationObserver((records) => {
          for (const record of records) {
            const el = record.target;
            if (el instanceof Element && el.classList.contains('tutorial-press')) {
              window.__walk.presses.push(el.id || el.className);
            }
          }
        }).observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });
      };
      if (document.body) watch(); else document.addEventListener('DOMContentLoaded', watch);
    }, { helpSeen });
    return context;
  };
  const boot = async (context) => {
    const page = await context.newPage();
    page.on('pageerror', (e) => { note(`[pageerror] ${e.message}`); failures.push(`pageerror ${e.message}`); });
    await page.goto(`${URL}/?auto=planetarium`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForFunction(() => window.__moon?.ready?.(), null, { timeout: 300_000 });
    await page.waitForFunction(() => {
      const screen = document.getElementById('loading-screen');
      return !screen || screen.classList.contains('hidden') || getComputedStyle(screen).display === 'none';
    }, null, { timeout: 300_000 });
    await sleep(2500);
    return page;
  };
  const tstate = (page) => page.evaluate(() => window.__moon.tutorialState());
  const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); note(`  shot ${name}`); };
  const cardText = (page) => page.evaluate(() => {
    const text = (id) => document.getElementById(id)?.textContent ?? '';
    const card = document.getElementById('tutorial-card')?.getBoundingClientRect();
    const dots = Array.from(document.querySelectorAll('#tutorial-dots .tutorial-dot')).map((d) => d.className.replace('tutorial-dot', '').trim() || 'todo');
    const primary = document.getElementById('tutorial-primary');
    return {
      count: text('tutorial-count'), title: text('tutorial-title'), kicker: text('tutorial-kicker'), body: text('tutorial-body'),
      back: text('tutorial-back'), ghost: text('tutorial-ghost'), primary: text('tutorial-primary'),
      primaryDisabled: primary?.disabled ?? null, busy: primary?.classList.contains('busy') ?? null, dots,
      rect: card && { x: card.x, y: card.y, w: card.width, h: card.height },
    };
  });
  const pressedCount = (page) => page.evaluate(() => document.querySelectorAll('.tutorial-press').length);
  const recorded = (page) => page.evaluate(() => ({ veilNotes: [...window.__walk.veilNotes], presses: [...window.__walk.presses] }));
  const resetRecorder = (page) => page.evaluate(() => { window.__walk.veilNotes = []; window.__walk.presses = []; });

  /** Wait for the stop to settle, screenshotting each new beat/stage on the way. */
  const waitReady = async (page, tag, stop, { shots = true, act = null } = {}) => {
    const started = Date.now();
    await resetRecorder(page);
    let lastBeat = null;
    let beatCount = 0;
    let acted = false;
    for (;;) {
      const state = await tstate(page);
      if (state.beat?.stage === 'await' && act && !acted) {
        acted = true;
        await act(state);
      }
      if (!state.active || state.phase === 'ready') {
        const seen = await recorded(page);
        note(`  ${stop}: ready after ${((Date.now() - started) / 1000).toFixed(1)}s phase=${state.phase} landed=${state.landedOn} veil=${JSON.stringify(seen.veilNotes)} presses=${JSON.stringify(seen.presses)}`);
        return { state, seen, beatCount, seconds: (Date.now() - started) / 1000 };
      }
      const key = state.beat ? `${state.beat.id}:${state.beat.stage}` : null;
      if (key && key !== lastBeat) {
        lastBeat = key;
        beatCount++;
        if (shots) await shot(page, `${tag}-${stop}-beat-${beatCount}-${state.beat.id}-${state.beat.stage}`);
        if (state.beat.stage === 'hold' && state.beat.hasSpotlight) await assertSpotlight(page, tag, stop, state);
        if (state.beat.id === 'moon-picture' && state.beat.stage === 'hold') {
          check(state.landedOn === 'Moon' && !state.panelOpen && !state.surface, `${tag} ${stop}/moon-picture: landed on the Moon with the panel still closed`, { landed: state.landedOn, panel: state.panelOpen });
        }
      }
      if (Date.now() - started > 420_000) {
        check(false, `${tag} ${stop}: never settled`, state);
        return { state, seen: await recorded(page), beatCount, seconds: (Date.now() - started) / 1000 };
      }
      await sleep(120);
    }
  };

  const assertSpotlight = async (page, tag, stop, state) => {
    const viewport = await page.evaluate(() => ({ x: 0, y: 0, w: innerWidth, h: innerHeight }));
    const card = (await cardText(page)).rect;
    const spot = state.spotlight;
    const beat = state.beat.id;
    check(!!spot, `${tag} ${stop}/${beat}: the spotlight is up during the hold`);
    if (!spot) return;
    check(inside(spot.cutout, viewport, 1), `${tag} ${stop}/${beat}: the cutout is on screen`, spot.cutout);
    check(inside(spot.bubble, viewport, 1), `${tag} ${stop}/${beat}: the bubble is on screen`, spot.bubble);
    check(!overlaps(spot.bubble, card), `${tag} ${stop}/${beat}: the bubble stays off the card`, { bubble: spot.bubble, card });
    check(!overlaps(spot.cutout, card), `${tag} ${stop}/${beat}: the ringed control is not under the card`, { cutout: spot.cutout, card });
    check(spot.cutout.w > 20 && spot.cutout.h > 20, `${tag} ${stop}/${beat}: the cutout has a control's size`, spot.cutout);
  };

  // The first run: the welcome over the live scene, on both sizes. On the
  // desktop "Explore on my own" marks it seen (a reload shows nothing); on the
  // phone "Take the tour" goes straight to Saturn.
  const heroState = (page) => page.evaluate(() => {
    const hero = document.getElementById('tutorial-hero');
    return {
      open: hero?.classList.contains('visible') ?? false,
      focused: document.activeElement?.id ?? null,
      seen: localStorage.getItem('planetarium-help-seen'),
      helpOpen: document.getElementById('planetarium-help')?.classList.contains('visible') ?? false,
      tour: document.getElementById('tutorial-hero-tour')?.getBoundingClientRect().height ?? 0,
      explore: document.getElementById('tutorial-hero-explore')?.getBoundingClientRect().height ?? 0,
    };
  });
  for (const [tag, vp, touch] of SIZES) {
    note(`[firstrun ${tag}]`);
    const context = await fresh(vp, { touch, helpSeen: false });
    const page = await boot(context);
    await sleep(800);
    let hero = await heroState(page);
    check(hero.open && !hero.helpOpen, `${tag} firstrun: the welcome is up, not the guide`, hero);
    check(hero.focused === 'tutorial-hero-title', `${tag} firstrun: focus starts on the heading`, hero.focused);
    check(hero.tour >= 44 && hero.explore >= 44 && Math.abs(hero.tour - hero.explore) < 1, `${tag} firstrun: two choices of equal size`, { tour: hero.tour, explore: hero.explore });
    await shot(page, `${tag}-00-firstrun-welcome`);
    if (tag === 'desktop') {
      // The welcome sits over the live sky, so the clock runs under it — but a
      // held flight key must not steer the ship behind a modal dialog.
      const course = (await tstate(page)).ship;
      await page.keyboard.down('a');
      await sleep(700);
      await page.keyboard.up('a');
      await sleep(200);
      const steered = (await tstate(page)).ship;
      check(steered.heading === course.heading && steered.pitch === course.pitch, `${tag} firstrun: a held flight key does not steer the ship under the welcome`, { before: course.heading, after: steered.heading });
      await page.click('#tutorial-hero-explore');
      await sleep(300);
      hero = await heroState(page);
      check(!hero.open && hero.seen === '1', `${tag} firstrun: Explore closes the welcome and marks it seen`, hero);
      check(!(await tstate(page)).active, `${tag} firstrun: no tour started`);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
      await page.waitForFunction(() => window.__moon?.ready?.(), null, { timeout: 300_000 });
      await sleep(1500);
      hero = await heroState(page);
      check(!hero.open, `${tag} firstrun: the welcome never comes back`, hero);
      await context.close();
      // The guide link: the welcome closes and Help opens, with a single tour button.
      const guide = await fresh(vp, { touch, helpSeen: false });
      const guidePage = await boot(guide);
      await sleep(800);
      await guidePage.click('#tutorial-hero-guide');
      await sleep(300);
      hero = await heroState(guidePage);
      const footer = await guidePage.evaluate(() => ({
        title: document.querySelector('#planetarium-help h3')?.textContent,
        buttons: Array.from(document.querySelectorAll('.help-tutorial-row button')).map((b) => b.textContent),
      }));
      check(!hero.open && hero.helpOpen && hero.seen === '1', `${tag} firstrun: Read the guide opens Help and marks the welcome seen`, hero);
      check(footer.title === 'Help' && footer.buttons.length === 1 && footer.buttons[0] === 'Take the tour', `${tag} firstrun: Help has one tour button in its footer`, footer);
      await shot(guidePage, `${tag}-00b-firstrun-guide`);
      await guide.close();
      continue;
    } else {
      await page.click('#tutorial-hero-tour');
      await sleep(300);
      hero = await heroState(page);
      const state = await tstate(page);
      check(!hero.open && hero.seen === '1' && state.active && state.stepId === 'saturn', `${tag} firstrun: Take the tour closes the welcome and stages Saturn at once`, { hero, stepId: state.stepId });
      await shot(page, `${tag}-00b-firstrun-tour-started`);
    }
    await context.close();
  }

  for (const [tag, vp, touch] of SIZES) {
    note(`[walk ${tag}]`);
    const context = await fresh(vp, { touch });
    const page = await boot(context);
    const before = await tstate(page);
    await shot(page, `${tag}-01-before`);
    const menuRow = (page) => page.evaluate(() => document.getElementById('planetarium-btn-tutorial')?.textContent);
    await page.click('#planetarium-btn-menu'); await sleep(500);
    check((await menuRow(page)) === 'Take the tour', `${tag}: the ☰ row offers the tour`, await menuRow(page));
    await shot(page, `${tag}-02-menu`);
    await page.click('#planetarium-btn-menu'); await sleep(400);
    const started = await page.evaluate(() => window.__moon.tutorialStart());
    check(started, `${tag}: the tour starts from idle`);
    await sleep(150);

    // Saturn stages at once: the demonstration, beat by beat, then the composed arrival.
    let card = await cardText(page);
    check(card.dots.length === 4 && card.dots[0] === 'current' && card.back === '', `${tag} saturn: the first dot is lit at once, no Back`, card.dots);
    check(card.busy && card.primary === 'Arriving…', `${tag} saturn: the primary says why it waits`, { primary: card.primary, busy: card.busy });
    check(/Four stops/.test(card.body), `${tag} saturn: the staging copy introduces the tour`, card.body);
    const saturn = await waitReady(page, tag, 'saturn');
    // Polling can miss a one-frame stage; the recorder below proves the presses.
    check(saturn.beatCount >= 2, `${tag} saturn: the beats played`, saturn.beatCount);
    check(saturn.seen.presses.includes('planetarium-btn-travel'), `${tag} saturn: the Teleport chip was visibly pressed`, saturn.seen.presses);
    check(saturn.seen.presses.some((p) => /pk-row/.test(p)), `${tag} saturn: the Saturn row was visibly pressed`, saturn.seen.presses);
    check(saturn.seen.veilNotes.length === 0 || saturn.seen.veilNotes.every((n) => /Teleporting to Saturn/.test(n)), `${tag} saturn: every veil caption was the tour's own (or no veil was needed)`, saturn.seen.veilNotes);
    card = await cardText(page);
    note(`  card ${JSON.stringify(card)}`);
    check(card.dots[0] === 'current', `${tag} saturn: the first dot is lit`, card.dots);
    check(/billion km from the Sun/.test(card.kicker), `${tag} saturn: the kicker is the live distance`, card.kicker);
    check(/One tap/.test(card.body), `${tag} saturn: the settled copy is the lesson`, card.body);
    check(card.primaryDisabled === false && card.primary === 'Next: the Moon', `${tag} saturn: Next is live`, card);
    const s = saturn.state;
    check(s.landedOn === null && s.shipVisible === false && s.labelsShown === false, `${tag} saturn: cruising at Saturn with the ship model and the labels out of the picture`, { landed: s.landedOn, ship: s.shipVisible, labels: s.labelsShown });
    check(s.panning === true || saturn.seconds > 12, `${tag} saturn: the slow pan is running (or has run its ten seconds)`, { panning: s.panning, seconds: saturn.seconds });
    check(!!s.composition, `${tag} saturn: the scene was composed`);
    if (s.composition) {
      const { subject, free } = s.composition;
      check(inside(subject, free, 2), `${tag} saturn: the subject's box sits inside the free area`, { subject, free });
      check(!overlaps(subject, card.rect), `${tag} saturn: the subject is clear of the card`, { subject, card: card.rect });
      const fill = Math.max(subject.w, subject.h) / Math.min(free.w, free.h);
      check(fill > 0.5 && fill < 0.75, `${tag} saturn: the subject spans about three fifths of the free area`, fill.toFixed(2));
    }
    check(s.spotlight === null, `${tag} saturn: no ring once the scene is the focal point`);
    check((await pressedCount(page)) === 0, `${tag} saturn: no press class left on any control`);
    await shot(page, `${tag}-12-saturn`);

    // The Moon: the chip beat, then the you-try. The desktop user taps the row
    // themselves; the phone user presses Show me.
    await page.evaluate(() => window.__moon.tutorialNext());
    await sleep(150);
    card = await cardText(page);
    check(/Tap the Moon/.test(card.body) && card.primary === 'Arriving…', `${tag} moon: the staging copy and the held primary`, { body: card.body, primary: card.primary });
    const moon = await waitReady(page, tag, 'moon', {
      act: async (state) => {
        const waiting = await cardText(page);
        check(waiting.primary === 'Show me' && waiting.primaryDisabled === false, `${tag} moon/moon-row: the primary offers Show me while it waits`, waiting.primary);
        check(state.spotlight !== null, `${tag} moon/moon-row: the Moon row is ringed while it waits`);
        await assertSpotlight(page, tag, 'moon', state);
        await shot(page, `${tag}-moon-await`);
        if (tag === 'desktop') {
          await page.click('#deck-list .pk-row[data-name="Moon"]');
          note('  acted: tapped the Moon row');
        } else {
          await page.click('#tutorial-primary');
          note('  acted: pressed Show me');
        }
      },
    });
    const m = moon.state;
    check(m.landedOn === 'Moon' && m.surface && m.panelOpen !== null, `${tag} moon: ends on the Moon in surface view`, { landed: m.landedOn, surface: m.surface });
    check(m.earthOnScreen === true, `${tag} moon: Earth is on screen after Look up`, m.earthOnScreen);
    check(m.labelsShown === false, `${tag} moon: the labels stay out of the picture`, m.labelsShown);
    check(moon.seen.veilNotes.length === 0 || moon.seen.veilNotes.every((n) => /Landing on the Moon/.test(n)), `${tag} moon: the veil caption was the tour's (or no veil was needed)`, moon.seen.veilNotes);
    if (tag === 'desktop') {
      check(m.userActed || moon.beatCount >= 3, `${tag} moon: the user's own tap was recognised`, { userActed: m.userActed, beats: moon.beatCount });
    } else {
      check(moon.seen.presses.some((p) => /pk-row/.test(p)), `${tag} moon: Show me visibly pressed the row`, moon.seen.presses);
    }
    card = await cardText(page);
    note(`  card ${JSON.stringify(card)}`);
    check(card.dots[0] === 'done' && card.dots[1] === 'current', `${tag} moon: the dots advance`, card.dots);
    check(/Earth · \d+% lit/.test(card.kicker), `${tag} moon: the kicker is Earth's live phase`, card.kicker);
    check(card.body === 'Look up, and there is Earth.' && card.primary === 'Next: speed up time', `${tag} moon: the settled copy and Next`, { body: card.body, primary: card.primary });
    await shot(page, `${tag}-14-moon`);
    // Jupiter: the arrival, then the rail ringed while the clock climbs.
    await page.evaluate(() => window.__moon.tutorialNext());
    const timelapse = await waitReady(page, tag, 'timelapse');
    const j = timelapse.state;
    check(j.landedOn === 'Jupiter' && !j.panelOpen && !j.surface, `${tag} timelapse: on Jupiter from orbit with the panel closed`, { landed: j.landedOn, panel: j.panelOpen });
    check(j.rate === 3600 && !j.paused, `${tag} timelapse: the clock landed on the 1 hr/s detent`, { rate: j.rate, paused: j.paused });
    check(timelapse.seen.veilNotes.length === 0 || timelapse.seen.veilNotes.every((n) => /Landing on Jupiter/.test(n)), `${tag} timelapse: the veil caption was the tour's`, timelapse.seen.veilNotes);
    card = await cardText(page);
    check(card.kicker === 'Jupiter · 1 hr/s' && /forty-two/.test(card.body) && card.primary === 'Next: an eclipse', `${tag} timelapse: the settled card`, { kicker: card.kicker, primary: card.primary });
    await shot(page, `${tag}-15-timelapse`);

    // The eclipse: the panel's own arrow, the rewind, Look up, the approach, totality.
    await page.evaluate(() => window.__moon.tutorialNext());
    const PEAK_MS = Date.parse('2027-08-02T10:06:41Z');
    let jumpedState = null;
    let rewoundState = null;
    const eclipseStaged = await (async () => {
      const started = Date.now();
      await resetRecorder(page);
      let lastBeat = null;
      for (;;) {
        const state = await tstate(page);
        if (!state.active || state.phase !== 'staging') return { state, seen: await recorded(page) };
        const key = state.beat ? `${state.beat.id}:${state.beat.stage}` : null;
        if (key && key !== lastBeat) {
          lastBeat = key;
          await shot(page, `${tag}-eclipse-${state.beat.id}-${state.beat.stage}`);
          if (state.beat.stage === 'hold' && state.beat.hasSpotlight) await assertSpotlight(page, tag, 'eclipse', state);
          if (state.beat.id === 'jumped' && state.beat.stage === 'hold') jumpedState = state;
          if (state.beat.id === 'look-up' && state.beat.stage === 'hold') rewoundState = state;
        }
        if (Date.now() - started > 420_000) { check(false, `${tag} eclipse: never left staging`, state); return { state, seen: await recorded(page) }; }
        await sleep(120);
      }
    })();
    check(jumpedState !== null && Math.abs(jumpedState.timeMs - (PEAK_MS - 3 * 60_000)) < 20 * 60_000 && jumpedState.rate === 1, `${tag} eclipse: the arrow parked the clock three minutes before the 2027-08-02 peak at realtime`, jumpedState && { timeMs: jumpedState.timeMs, rate: jumpedState.rate });
    check(jumpedState !== null && jumpedState.panelOpen && jumpedState.landedOn === 'Earth', `${tag} eclipse: on Earth with the panel open after the jump`, jumpedState && { panel: jumpedState.panelOpen, landed: jumpedState.landedOn });
    check(rewoundState !== null && jumpedState !== null && jumpedState.timeMs - rewoundState.timeMs > 60 * 60_000 && rewoundState.rate === 1, `${tag} eclipse: the rewind went back over an hour at realtime`, rewoundState && jumpedState && { back: (jumpedState.timeMs - rewoundState.timeMs) / 60_000 });
    check(eclipseStaged.seen.presses.includes('observatory-next-solar') && eclipseStaged.seen.presses.includes('observatory-lookup'), `${tag} eclipse: the arrow and the window were visibly pressed`, eclipseStaged.seen.presses);
    check(eclipseStaged.seen.veilNotes.length === 0 || eclipseStaged.seen.veilNotes.every((n) => /Landing on Earth/.test(n)), `${tag} eclipse: the veil caption was the tour's`, eclipseStaged.seen.veilNotes);
    const approach = eclipseStaged.state;
    check(approach.surface && approach.rate === 1200 && approach.declutter, `${tag} eclipse: approaching in a decluttered surface view at 20 min/s`, { surface: approach.surface, rate: approach.rate, declutter: approach.declutter });
    check(approach.sunOnScreen === true, `${tag} eclipse: the Sun is on screen during the approach`, approach.sunOnScreen);
    card = await cardText(page);
    check(card.primary === 'Watching…' && card.busy && /peak in|starts in/.test(card.kicker), `${tag} eclipse: Watching… with a live countdown`, { primary: card.primary, kicker: card.kicker });
    await sleep(1500);
    await shot(page, `${tag}-17-eclipse-approach`);
    const eclipse = await waitReady(page, tag, 'eclipse', { shots: false });
    check(eclipse.state.surface && eclipse.state.totalityReached && eclipse.state.rate === 1, `${tag} eclipse: in surface view at totality, back at realtime`, { surface: eclipse.state.surface, totality: eclipse.state.totalityReached, rate: eclipse.state.rate });
    card = await cardText(page);
    check(card.title === 'Totality' && /corona/.test(card.body) && card.primary === 'Next: wrap up', `${tag} eclipse: the climax card`, { title: card.title, primary: card.primary });
    check(!(await page.evaluate(() => document.getElementById('surface-trackpill')?.offsetParent !== null)), `${tag} eclipse: the tracking pill is out of the picture`);
    await shot(page, `${tag}-18-eclipse-totality`);
    await page.evaluate(() => window.__moon.tutorialNext());
    await waitReady(page, tag, 'wrap');
    card = await cardText(page);
    check(card.dots.every((d) => d === 'done'), `${tag} wrap: every dot done`, card.dots);
    const chips = await page.evaluate(() => Array.from(document.querySelectorAll('#tutorial-chips .tutorial-chip')).map((b) => [b.textContent, b.getBoundingClientRect().height]));
    check(chips.map((c) => c[0]).join('|') === 'Visit Mars|Earth from the Moon|Follow Voyager 1', `${tag} wrap: the three doors`, chips);
    if (tag === 'phone') check(chips.every((c) => c[1] >= 44), `${tag} wrap: the chips are 44 px targets`, chips);
    const ghostShown = await page.evaluate(() => (document.getElementById('tutorial-ghost')?.offsetParent ?? null) !== null);
    check(card.primary === 'Back where I was' && !ghostShown, `${tag} wrap: Back where I was, no skip`, { primary: card.primary, ghostShown });
    await shot(page, `${tag}-19-wrap`);
    await page.click('#tutorial-primary');
    await page.waitForFunction(() => !window.__moon.tutorialState().active, null, { timeout: 120_000 });
    await sleep(2500);
    await shot(page, `${tag}-20-after-end`);
    await page.click('#planetarium-btn-menu'); await sleep(400);
    check((await menuRow(page)) === 'Replay the tour', `${tag} end: the ☰ row now offers a replay`, await menuRow(page));
    await page.click('#planetarium-btn-menu'); await sleep(300);
    const after = await tstate(page);
    note(`  end state ${JSON.stringify(after)}`);
    // The boot ship is under way (a cruise jump always arrives moving), so the
    // restore puts it back on its course: the same heading, and a position
    // within the few light-seconds it flies between the two samples.
    const dist = Math.hypot(after.ship.x - before.ship.x, after.ship.y - before.ship.y, after.ship.z - before.ship.z);
    check(dist < 0.02, `${tag} end: the ship is back on its course (AU from the start sample)`, { dist });
    check(Math.abs(after.ship.heading - before.ship.heading) < 1e-6 && Math.abs(after.ship.pitch - before.ship.pitch) < 1e-6, `${tag} end: heading restored`, { before: before.ship, after: after.ship });
    check(after.landedOn === before.landedOn, `${tag} end: landing restored`, { before: before.landedOn, after: after.landedOn });
    check(Math.abs(after.timeMs - Date.now()) < 180_000 && after.rate === 1 && !after.paused, `${tag} end: the clock is live again`, { timeMs: after.timeMs, rate: after.rate });
    check(after.shipVisible === true && after.labelsShown === true, `${tag} end: the ship and the labels are back`, { ship: after.shipVisible, labels: after.labelsShown });
    check(after.declutter === false, `${tag} end: the surface declutter is lifted`);
    check((await pressedCount(page)) === 0 && after.spotlight === null, `${tag} end: nothing of the spotlight remains`);
    await context.close();
  }

  // Esc in the middle of the first beat: the ring and the press go at once.
  if (!ONLY || ONLY === 'desktop') {
    note('[esc mid-beat desktop]');
    const context = await fresh(DESKTOP);
    const page = await boot(context);
    const before = await tstate(page);
    await page.evaluate(() => window.__moon.tutorialStart());
    await page.waitForFunction(() => window.__moon.tutorialState().spotlight !== null, null, { timeout: 60_000 });
    await shot(page, 'desktop-30-esc-before');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.__moon.tutorialState().active, null, { timeout: 60_000 });
    await sleep(600);
    const after = await tstate(page);
    check(after.spotlight === null, 'esc: the spotlight is down');
    check((await pressedCount(page)) === 0, 'esc: no press left on a control');
    check(!(await page.evaluate(() => document.getElementById('tutorial-spotlight')?.classList.contains('visible'))), 'esc: the layer is hidden');
    check(!(await page.evaluate(() => document.getElementById('deck')?.classList.contains('visible'))), 'esc: the deck is closed');
    const dist = Math.hypot(after.ship.x - before.ship.x, after.ship.y - before.ship.y, after.ship.z - before.ship.z);
    check(dist < 0.02 && after.ship.heading === before.ship.heading, 'esc: the ship kept its own course (no scene was staged)', { dist });
    await shot(page, 'desktop-31-esc-after');
    await context.close();
  }

  // Esc during the first beat from a surface view: the start left it for the
  // orbit view the stagings need, and the early stop must walk back in.
  if (!ONLY || ONLY === 'desktop') {
    note('[esc from surface view desktop]');
    const context = await fresh(DESKTOP);
    const page = await boot(context);
    await page.evaluate(() => window.__moon.land('Moon'));
    await page.waitForFunction(() => window.__moon.tutorialState().landedOn === 'Moon', null, { timeout: 300_000 });
    await sleep(2000);
    await page.evaluate(() => window.__moon.openObservatory());
    await page.evaluate(() => window.__moon.lookUp());
    await page.waitForFunction(() => window.__moon.tutorialState().surface, null, { timeout: 120_000 });
    await sleep(1500);
    const before = await page.evaluate(() => window.__moon.probeLanded());
    await page.evaluate(() => window.__moon.tutorialStart());
    await page.waitForFunction(() => window.__moon.tutorialState().spotlight !== null, null, { timeout: 60_000 });
    const during = await tstate(page);
    check(!during.surface && during.landedOn === 'Moon', 'esc from surface: the start left the surface view for the stagings', { surface: during.surface, landed: during.landedOn });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.__moon.tutorialState().active, null, { timeout: 60_000 });
    await sleep(1500);
    const after = await page.evaluate(() => window.__moon.probeLanded());
    const state = await tstate(page);
    check(state.landedOn === 'Moon' && state.surface, 'esc from surface: back in the surface view on the same ground', { landed: state.landedOn, surface: state.surface });
    check(after.subjectName === before.subjectName, 'esc from surface: watching what it watched before', { before: before.subjectName, after: after.subjectName });
    check(state.panelOpen === true, 'esc from surface: the panel is still open', { panel: state.panelOpen });
    await shot(page, 'desktop-32-esc-from-surface');
    await context.close();
  }

  // Back where I was from a surface view with the sheet parked full: the
  // surface re-entry shows the panel again, which parks every sheet at peek,
  // and the snapshot's park must have the last word.
  if (!ONLY || ONLY === 'phone') {
    note('[return to surface sheet phone]');
    const context = await fresh(PHONE, { touch: true });
    const page = await boot(context);
    await page.evaluate(() => window.__moon.land('Moon'));
    await page.waitForFunction(() => window.__moon.tutorialState().landedOn === 'Moon', null, { timeout: 300_000 });
    await sleep(2000);
    await page.evaluate(() => window.__moon.openObservatory());
    await page.evaluate(() => window.__moon.lookUp());
    await page.waitForFunction(() => window.__moon.tutorialState().surface, null, { timeout: 120_000 });
    await page.evaluate(() => window.__moon.setSheetPark('full'));
    await sleep(1000);
    const before = await tstate(page);
    check(before.sheetPark === 'full' && before.panelOpen && before.surface, 'return sheet: starting in surface view with the sheet parked full', { park: before.sheetPark, panel: before.panelOpen, surface: before.surface });
    await page.evaluate(() => window.__moon.tutorialStart());
    await page.waitForFunction(() => window.__moon.tutorialState().active, null, { timeout: 60_000 });
    const staged = await page.evaluate(() => window.__moon.tutorialStage(4));
    await page.waitForFunction(() => window.__moon.tutorialState().stepId === 'wrap' && window.__moon.tutorialState().phase === 'ready', null, { timeout: 120_000 });
    check(staged, 'return sheet: the wrap card staged directly');
    await page.click('#tutorial-primary');
    await page.waitForFunction(() => !window.__moon.tutorialState().active, null, { timeout: 120_000 });
    await sleep(3000);
    const after = await tstate(page);
    check(after.landedOn === 'Moon' && after.surface && after.panelOpen, 'return sheet: back on the Moon in surface view with the panel open', { landed: after.landedOn, surface: after.surface, panel: after.panelOpen });
    check(after.sheetPark === 'full', 'return sheet: the sheet is parked full again', { park: after.sheetPark });
    await shot(page, 'phone-32-return-sheet');
    await context.close();
  }

  // The wrap's chips, each from a fresh boot: the wrap card is staged
  // directly (the dev bridge), the chip ends the tour as completed, and its
  // action follows once the restore has cleared.
  if (!ONLY || ONLY === 'desktop' || ONLY === 'chips') {
    const speedLabel = (page) => page.evaluate(() => document.getElementById('planetarium-speed-label')?.textContent ?? '');
    for (const [chip, expect] of [
      ['visit-mars', async (page) => {
        await page.waitForFunction(() => (document.getElementById('planetarium-speed-label')?.textContent ?? '') === 'Mars', null, { timeout: 300_000 }).catch(() => {});
        const state = await tstate(page);
        check((await speedLabel(page)) === 'Mars' && state.landedOn === null, 'chip visit-mars: teleported to Mars', { label: await speedLabel(page), landed: state.landedOn });
      }],
      ['earth-from-moon', async (page) => {
        await page.waitForFunction(() => { const s = window.__moon.tutorialState(); return s.landedOn === 'Moon' && s.surface && s.earthOnScreen; }, null, { timeout: 300_000 }).catch(() => {});
        const state = await tstate(page);
        check(state.landedOn === 'Moon' && state.surface && state.earthOnScreen === true, 'chip earth-from-moon: standing on the Moon looking at Earth', { landed: state.landedOn, surface: state.surface, earth: state.earthOnScreen });
      }],
      ['follow-voyager', async (page) => {
        await page.waitForFunction(() => window.__moon.tutorialState().missionActive, null, { timeout: 300_000 }).catch(() => {});
        const state = await tstate(page);
        check(state.missionActive === true, 'chip follow-voyager: the Voyager 1 mission is under way', state.missionActive);
      }],
    ]) {
      note(`[chip ${chip}]`);
      const context = await fresh(DESKTOP);
      const page = await boot(context);
      await page.evaluate(() => window.__moon.tutorialStart());
      await page.waitForFunction(() => window.__moon.tutorialState().active, null, { timeout: 60_000 });
      const staged = await page.evaluate(() => window.__moon.tutorialStage(4));
      await page.waitForFunction(() => window.__moon.tutorialState().stepId === 'wrap' && window.__moon.tutorialState().phase === 'ready', null, { timeout: 120_000 });
      check(staged, `chip ${chip}: the wrap card staged directly`);
      await page.click(`#tutorial-chips .tutorial-chip[data-chip="${chip}"]`);
      await page.waitForFunction(() => !window.__moon.tutorialState().active, null, { timeout: 120_000 });
      check(!(await tstate(page)).active, `chip ${chip}: the tour ended`);
      await expect(page);
      // The ☰ button is away in surface view and during a mission: read the
      // tour record the ☰ row and Help would read.
      const record = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('planetarium-tour') ?? 'null'); } catch { return null; } });
      check(record?.completed === true, `chip ${chip}: counts as completing the tour`, record);
      await shot(page, `desktop-40-chip-${chip}`);
      await context.close();
    }
  }
} finally {
  await browser.close();
  release();
  writeFileSync(`${OUT}/log.txt`, log.join('\n'));
  console.log(`[done] ${OUT} — ${failures.length} failure(s)`);
  for (const line of failures) console.log(`  ${line}`);
}
process.exit(failures.length ? 1 : 0);
