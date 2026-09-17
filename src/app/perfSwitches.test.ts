import { describe, expect, it } from 'vitest';
import { PERF_SWITCHES, perfSwitchOn, perfSwitchState, setPerfSwitch } from './perfSwitches';

describe('the efficiency-switch registry', () => {
  it('has no key for the render resolution', () => {
    // The graphics-quality levels are that A/B (`?quality=medium` is the
    // picture as it was, `?upscale=<ratio>` pins a scene ratio). A key here
    // would be a second writer of the same variable: it armed itself at module
    // init whenever the scene ratio was non-null, so every DEV boot would arm
    // it once a level asked for a ratio, the sweep would enumerate a row for
    // it by default, and perfArm would silently overrule the user's level.
    const keys = PERF_SWITCHES.map((s) => s.key as string);
    expect(keys).not.toContain('upscale');
    expect(keys).not.toContain('quality');
    expect(Object.keys(perfSwitchState())).toEqual(keys);
  });

  it('lists every key its defaults table owns, and no others', () => {
    // The labelled table and the defaults are two separate literals — the
    // defaults deliberately so, as a literal a bundler can fold away — and a
    // key added to or removed from one of them is invisible until a switch
    // silently does nothing. setPerfSwitch refuses a key the defaults do not
    // own, which is what makes the two testable against each other.
    for (const s of PERF_SWITCHES) {
      const was = perfSwitchOn(s.key);
      expect(setPerfSwitch(s.key, !was)).toBe(true);
      expect(perfSwitchOn(s.key)).toBe(!was);
      setPerfSwitch(s.key, was);
      expect(perfSwitchOn(s.key)).toBe(was);
      // And the table's stated default is the state a fresh module has.
      expect(was).toBe(s.on);
    }
    expect(setPerfSwitch('not-a-switch', true)).toBe(false);
  });
});
