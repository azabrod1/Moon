/**
 * The Retro look: the app drawn as a 1990s screen. A fun mode, kept to this
 * folder; the rest of the app never needs to know it exists.
 *
 * What it does, all from here:
 *  - the picture: a post-process on the finished frame (RetroPass.ts) — big
 *    pixels, 256 colours, an ordered dither;
 *  - the interface: retro.css (bitmap type, banded cards, framed buttons),
 *    loaded only while the look is on, with every font size the app's CSS
 *    sets mapped to a bitmap face (typography.ts) and the menu's pixel icons
 *    (icons.ts);
 *  - green target brackets on the body most prominent on screen (brackets.ts);
 *  - its own Look row, added to the ☰ Display page.
 *
 * What it asks of the app (main.ts): put `pass()` last in the planetarium's
 * composer, keep the resample passes off while `on` (the pass reads the
 * finishing pass's own target and draws the canvas itself), and hand `frame`
 * the most prominent body after each planetarium frame.
 *
 * `?retro=1` or `?retro=0` overrides the saved look for one load
 * (setting.ts). Not offered where there is no composer (`canDraw` false).
 */
import type * as THREE from 'three';
import type { OutputTargetPass } from '../app/UpscalePass';
import { setSegmentValue, wireSegmented } from '../planetarium/ui/SegmentedControl';
import { RetroTargetBrackets, type ScreenBox } from './brackets';
import { retroGrid, retroInterfacePixel } from './grid';
import { installRetroIcons } from './icons';
import { RetroPass } from './RetroPass';
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

export interface Retro {
  /** Whether the look is on. */
  readonly on: boolean;
  /** The pass for a newly built planetarium composer, enabled while the look is on. */
  pass(source: OutputTargetPass): RetroPass;
  /** After each planetarium frame: the body to frame, or null for none. */
  frame(target: (ScreenBox & { name: string }) | null): void;
}

export function createRetro(host: RetroHost): Retro {
  let look: Look = host.canDraw ? resolveBootLook(location.search) : 'modern';
  let pass: RetroPass | null = null;
  let stylesheet: HTMLStyleElement | null = null;
  let brackets: RetroTargetBrackets | null = null;
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
    setSegmentValue(row.querySelector('.menu-seg'), look);
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
    wireSegmented(row.querySelector('.menu-seg'), (value) => {
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
      brackets.show(target.name, target, pictureGrid().cssPixel, canvas.clientWidth, canvas.clientHeight);
    },
  };
}
