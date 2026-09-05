import { afterEach, describe, it, expect, vi } from 'vitest';
import { touchFirstDevice, resetDeviceClassForTests } from './device';

function asDevice(userAgent: string, platform: string, maxTouchPoints: number, innerWidth: number): void {
  resetDeviceClassForTests();
  vi.stubGlobal('navigator', { userAgent, platform, maxTouchPoints });
  vi.stubGlobal('window', { innerWidth });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetDeviceClassForTests();
});

describe('touchFirstDevice', () => {
  it('answers false with no DOM at all, so a headless import is safe', () => {
    resetDeviceClassForTests();
    vi.stubGlobal('window', undefined);
    expect(touchFirstDevice()).toBe(false);
  });

  it('recognises an iPhone', () => {
    asDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 'iPhone', 5, 390);
    expect(touchFirstDevice()).toBe(true);
  });

  it('recognises an iPad behind its desktop user agent', () => {
    asDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 5, 1366);
    expect(touchFirstDevice()).toBe(true);
  });

  it('calls a touchscreen laptop a desktop', () => {
    asDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32', 10, 1440);
    expect(touchFirstDevice()).toBe(false);
  });

  it('calls a narrow touch viewport touch-first', () => {
    asDevice('Mozilla/5.0 (Linux; Android 14)', 'Linux armv8l', 5, 900);
    expect(touchFirstDevice()).toBe(true);
  });

  it('calls a mouse-only desktop a desktop', () => {
    asDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 0, 1600);
    expect(touchFirstDevice()).toBe(false);
  });

  it('keeps one verdict for the page even when the window is resized', () => {
    asDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32', 10, 1440);
    expect(touchFirstDevice()).toBe(false);
    vi.stubGlobal('window', { innerWidth: 700 });
    expect(touchFirstDevice()).toBe(false);
  });
});
