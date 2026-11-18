/**
 * The Retro look: the app drawn as a 1990s screen. A fun mode, kept to this
 * folder; the rest of the app never needs to know it exists.
 *
 * What it does, all from here:
 *  - the picture: a post-process on the finished frame (RetroPass.ts) — big
 *    pixels, 256 colours, an ordered dither;
 *  - the interface: retro.css (bitmap type, banded cards, framed buttons),
 *    added the first time the look is turned on, with every font size the
 *    app's CSS sets mapped to a bitmap face (typography.ts) and the menu's
 *    pixel icons (icons.ts);
 *  - green target brackets on the body most prominent on screen (brackets.ts);
 *  - its own ship, a delta fighter built for big pixels (ship.ts);
 *  - its own Look row, added to the ☰ Display page.
 *
 * What it asks of the app (main.ts): put `pass()` last in the planetarium's
 * composer, keep the resample passes off while `on` (the pass reads the
 * finishing pass's own target and draws the canvas itself), draw the scene at
 * `sceneRatio()` while it is on (coarser than the canvas, since a picture of
 * about 240 lines needs no more: grid.ts), draw the Sun's veiling glare and
 * the bloom at `glare`'s share of their strength, fly the ship `ship` builds
 * in place of its own, and hand `frame` the most prominent body after each
 * planetarium frame.
 *
 * `?retro=1` or `?retro=0` overrides the saved look for one load
 * (setting.ts). Not offered where there is no composer (`canDraw` false).
 *
 * It imports nothing from the app, so a change to the app can never break
 * the build here; the app's markup and classes it styles are matched by
 * selectors, so a change there at worst leaves something less retro.
 */
import type * as THREE from 'three';
import { RetroTargetBrackets, type ScreenBox } from './brackets';
import { retroGrid, retroInterfacePixel, retroSceneRatio } from './grid';
import { installRetroIcons } from './icons';
import { RetroPass, type FrameSource } from './RetroPass';
import { createRetroShip, type RetroShip } from './ship';
import { LOOKS, LOOK_LABELS, LOOK_NOTES, lookSetting, resolveBootLook, type Look } from './setting';
import { installRetroTypography } from './typography';
import retroCss from './retro.css?raw';

export interface RetroHost {
  renderer: THREE.WebGLRenderer;
  /** Whether this device draws through the composer the pass needs. */
  canDraw: boolean;
  /** The look changed: re-wire the passes and draw a frame. */
  changed(): void;
}

/**
 * The share of the planetarium's glow the look keeps. A 1990s screen had no
 * wide glare, and the app's, as soft as it is in the Modern look, reaches a
 * third of the way across the screen from the Sun; cut to the palette, its
 * faint part is a disc you see. A third of the veil ends its faint edge at
 * about 0.6 of the radius (the wash falls as distance^-2.24, sun.ts), and a
 * third of the bloom keeps the ship's highlights from blurring into a halo.
 */
export interface RetroGlare {
  /** Of the Sun's veiling glare (PlanetariumMode.setVeilScale). */
  veil: number;
  /** Of the bloom's strength. */
  bloom: number;
}
const RETRO_GLARE: RetroGlare = { veil: 0.35, bloom: 0.35 };

export interface Retro {
  /** Whether the look is on. */
  readonly on: boolean;
  /** The glow to keep while the look is on, or null while it is off. */
  readonly glare: RetroGlare | null;
  /** While the look is on, what builds its ship at the app's ship unit
   *  (built once, then the same ship again); null while it is off. */
  readonly ship: ((referenceRadiusAU: number) => RetroShip) | null;
  /** The scene ratio to draw the planetarium at for a `cssWidth × cssHeight`
   *  canvas at `outputRatio`, or null while the look is off. */
  sceneRatio(cssWidth: number, cssHeight: number, outputRatio: number): number | null;
  /** The pass for a newly built planetarium composer, enabled while the look is on. */
  pass(source: FrameSource): RetroPass;
  /** After each planetarium frame: the body to frame, or null for none. */
  frame(target: (ScreenBox & { name: string }) | null): void;
}

export function createRetro(host: RetroHost): Retro {
  let look: Look = host.canDraw ? resolveBootLook(location.search) : 'modern';
  let pass: RetroPass | null = null;
  let stylesheet: HTMLStyleElement | null = null;
  let brackets: RetroTargetBrackets | null = null;
  let ship: RetroShip | null = null;
  const buildShip = (referenceRadiusAU: number) => (ship ??= createRetroShip(referenceRadiusAU));
  const root = document.documentElement;

  /** The stylesheet, the mapped sizes and the icons, the first time they are needed. */
  const installStyles = () => {
    if (stylesheet) return;
    stylesheet = document.createElement('style');
    stylesheet.id = 'retro-css';
    stylesheet.textContent = retroCss;
    document.head.appendChild(stylesheet);
    installRetroTypography(stylesheet);
    installRetroIcons(root);
  };

  /** The picture's grid as the canvas stands, and its big pixel on the page
   *  (`--px`, written only when it moves). */
  let pagePx = '';
  const pictureGrid = () => {
    const canvas = host.renderer.domElement;
    const grid = retroGrid(canvas.width, canvas.height, host.renderer.getPixelRatio());
    const px = `${grid.cssPixel}px`;
    if (px !== pagePx) root.style.setProperty('--px', (pagePx = px));
    return grid;
  };
  /** The interface's pixel follows the display. */
  const sizePage = () => {
    if (look === 'retro') root.style.setProperty('--ui-px', `${retroInterfacePixel(window.devicePixelRatio || 1)}px`);
  };

  const apply = () => {
    const retro = look === 'retro';
    if (retro) installStyles();
    root.classList.toggle('retro', retro);
    sizePage();
    if (pass) pass.enabled = retro;
    if (!retro) brackets?.hide();
    syncRow();
  };

  // The Look row, on the ☰ Display page, in the page's own markup.
  let row: HTMLElement | null = null;
  const syncRow = () => {
    if (!row) return;
    for (const button of row.querySelectorAll<HTMLElement>('[role="radio"]')) {
      const checked = button.dataset.value === look;
      button.classList.toggle('on', checked);
      button.setAttribute('aria-checked', String(checked));
    }
    const note = row.querySelector('.menu-note');
    if (note) note.textContent = LOOK_NOTES[look];
  };
  const page = document.getElementById('menu-page-display');
  if (host.canDraw && page) {
    row = document.createElement('div');
    row.className = 'menu-field';
    row.innerHTML = `<div class="menu-field-label">Look</div>
      <div class="menu-seg" role="radiogroup" aria-label="Look">${LOOKS.map((value) =>
        `<button type="button" class="menu-seg-btn" role="radio" aria-checked="false" data-value="${value}">${LOOK_LABELS[value]}</button>`).join('')}</div>
      <div class="menu-note"></div>`;
    page.appendChild(row);
    row.addEventListener('click', (event) => {
      const value = (event.target as HTMLElement | null)?.closest<HTMLElement>('[role="radio"]')?.dataset.value;
      if (!value || value === look) return;
      look = value as Look;
      lookSetting.write(look);
      apply();
      host.changed();
    });
  }

  window.addEventListener('resize', sizePage);
  apply();

  return {
    get on() {
      return look === 'retro';
    },
    get glare() {
      return look === 'retro' ? RETRO_GLARE : null;
    },
    get ship() {
      return look === 'retro' ? buildShip : null;
    },
    sceneRatio(cssWidth, cssHeight, outputRatio) {
      return look === 'retro' ? retroSceneRatio(cssWidth, cssHeight, outputRatio) : null;
    },
    pass(source) {
      pass = new RetroPass(source);
      pass.enabled = look === 'retro';
      return pass;
    },
    frame(target) {
      if (look !== 'retro' || !target) {
        brackets?.hide();
        return;
      }
      brackets ??= new RetroTargetBrackets();
      const canvas = host.renderer.domElement;
      brackets.show(target, pictureGrid().cssPixel, canvas.clientWidth, canvas.clientHeight);
    },
  };
}
