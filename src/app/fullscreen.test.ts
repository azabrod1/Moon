import { describe, expect, it } from 'vitest';
import { isFullscreenKey, type FullscreenKeyEvent } from './fullscreen';
import fullscreenSource from './fullscreen.ts?raw';
import html from '../../index.html?raw';
import planetariumSource from '../planetarium/PlanetariumMode.ts?raw';
import interiorSource from '../interior/InteriorMode.ts?raw';
import compareSource from '../volumeCompare/VolumeCompareMode.ts?raw';

// The request itself, the lock and the change events need a real browser and
// a real gesture, and a fake DOM would only pin the fake: those are proved by
// driving the app (tools/fullscreen-probe.mjs). What is pinned here is the one
// pure decision — which key presses are the shortcut — and, as text, where
// each mode asks it.

const press = (overrides: Partial<FullscreenKeyEvent> & { key: string }): FullscreenKeyEvent => ({
  ctrlKey: false, metaKey: false, altKey: false, target: null, ...overrides,
});
const typedInto = (tagName: string, isContentEditable = false) =>
  ({ tagName, isContentEditable }) as unknown as EventTarget;

describe('the F key', () => {
  it('is F on its own, in either case', () => {
    expect(isFullscreenKey(press({ key: 'f' }))).toBe(true);
    // Shift and Caps Lock, as the app's other letter keys allow them.
    expect(isFullscreenKey(press({ key: 'F' }))).toBe(true);
  });

  it('is no other key', () => {
    for (const key of ['g', 'Escape', 'F11', 'Enter', ' ']) {
      expect(isFullscreenKey(press({ key })), key).toBe(false);
    }
  });

  it('leaves the browser its own chords', () => {
    // Ctrl+F and Cmd+F are Find; Alt+F opens the browser's menu on Windows.
    expect(isFullscreenKey(press({ key: 'f', ctrlKey: true }))).toBe(false);
    expect(isFullscreenKey(press({ key: 'f', metaKey: true }))).toBe(false);
    expect(isFullscreenKey(press({ key: 'f', altKey: true }))).toBe(false);
  });

  it('is a letter when it is typed into a field', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT', 'input']) {
      expect(isFullscreenKey(press({ key: 'f', target: typedInto(tag) })), tag).toBe(false);
    }
    expect(isFullscreenKey(press({ key: 'f', target: typedInto('DIV', true) }))).toBe(false);
  });

  it('is the shortcut on a focused control or the page itself', () => {
    for (const tag of ['BODY', 'BUTTON', 'CANVAS', 'svg']) {
      expect(isFullscreenKey(press({ key: 'f', target: typedInto(tag) })), tag).toBe(true);
    }
  });
});

describe('the ☰ row\'s key chip', () => {
  const toggle = html.indexOf('id="settings-fullscreen-toggle"');
  const row = html.slice(html.lastIndexOf('<div class="settings-row"', toggle), html.indexOf('</div>', toggle));

  it('names the key the shortcut listens for, to the eye and to a screen reader', () => {
    // The chip is the only place a reader learns F exists, so a key changed in
    // isFullscreenKey must not leave the row naming the old one.
    const chip = row.match(/<kbd class="kbd">([^<]+)<\/kbd>/)?.[1];
    const announced = row.match(/aria-keyshortcuts="([^"]+)"/)?.[1];
    expect(chip).toBeDefined();
    expect(isFullscreenKey(press({ key: chip! }))).toBe(true);
    expect(announced).toBe(chip);
  });

  it('is hidden where there is no keyboard to press it', () => {
    // The row is offered on phones and tablets too; a key chip there names a
    // keyboard the reader does not have. The menu's touch block is where the
    // rows already grow for a finger.
    const touchBlock = html.match(/@media \(hover: none\) and \(pointer: coarse\) \{\s*\.menu-action, \.settings-row[\s\S]*?\n {4}\}/)?.[0] ?? '';
    expect(touchBlock).toContain('.settings-label .kbd { display: none; }');
  });
});

describe('where each mode asks', () => {
  it('lets the deck have F first in the planetarium', () => {
    // With the deck open a printable key is the start of a search, and the
    // deck's branch moves focus into its field so the letter lands there. An F
    // branch above it would take the letter and go full screen instead.
    const handler = planetariumSource.slice(planetariumSource.indexOf('private handleKeyDown(e: KeyboardEvent)'));
    const deck = handler.indexOf('if (this.isDeckOpen() && !e.metaKey');
    const fullscreen = handler.indexOf('isFullscreenKey(e)');
    expect(deck).toBeGreaterThan(0);
    expect(fullscreen).toBeGreaterThan(deck);
  });

  it('hands F to the module in the tools that take keys', () => {
    for (const [name, source] of [['InteriorMode', interiorSource], ['VolumeCompareMode', compareSource]]) {
      expect(source, name).toContain('handleFullscreenKey(');
    }
  });

  it('asks for full screen before awaiting anything', () => {
    // A browser grants full screen only to a user's gesture, and some have
    // tied that to the handler itself rather than to a window of time after
    // it, so the request is made in the same turn as the press, never after
    // an await.
    const toggle = fullscreenSource.slice(fullscreenSource.indexOf('export function toggleFullscreen'));
    const body = toggle.slice(0, toggle.indexOf('\n}\n'));
    expect(body).toContain('requestFullscreen(');
    expect(body).not.toContain('await ');
    expect(body).not.toContain('async ');
  });
});
