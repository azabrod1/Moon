import { describe, expect, it } from 'vitest';
import { HOVER_CARD_MARGIN_PX, HOVER_CARD_OFFSET_PX, HoverCard, hoverDepthText, placeHoverCard, type HoverCardSurface } from './hoverCard';

/** A surface that records every call, with a size that follows its content. */
function fakeSurface(size = { width: 140, height: 52 }) {
  const calls: string[] = [];
  const surface: HoverCardSurface = {
    setContent: (name, kicker) => { calls.push(`content:${name}|${kicker}`); },
    setDepth: (text) => { calls.push(`depth:${text}`); },
    measure: () => { calls.push('measure'); return { ...size }; },
    place: (x, y) => { calls.push(`place:${x},${y}`); },
    setVisible: (visible) => { calls.push(`visible:${visible}`); },
  };
  return { surface, calls, take: () => calls.splice(0) };
}

const viewport = { width: 1400, height: 800 };
const crust = { key: 'crust', name: 'Crust', kicker: 'Silicate rock · solid' };
const mantle = { key: 'mantle', name: 'Upper mantle', kicker: 'Silicate rock · solid' };

describe('placeHoverCard', () => {
  it('sits beside the pointer and stays inside the viewport', () => {
    expect(placeHoverCard(100, 200, 140, 52, viewport)).toEqual({ x: 100 + HOVER_CARD_OFFSET_PX, y: 200 + HOVER_CARD_OFFSET_PX });
    // Against the right and bottom edges it steps back by its own size and the margin.
    expect(placeHoverCard(1390, 790, 140, 52, viewport)).toEqual({ x: 1400 - 140 - HOVER_CARD_MARGIN_PX, y: 800 - 52 - HOVER_CARD_MARGIN_PX });
    // And never past the top-left margin, whatever the pointer says.
    expect(placeHoverCard(-100, -100, 140, 52, viewport)).toEqual({ x: HOVER_CARD_MARGIN_PX, y: HOVER_CARD_MARGIN_PX });
  });
});

describe('hoverDepthText', () => {
  it('formats the depth and never says a negative one', () => {
    expect(hoverDepthText(1234.4)).toBe('1,234 km down');
    expect(hoverDepthText(-3)).toBe('0 km down');
    expect(hoverDepthText(null)).toBeNull();
  });
});

describe('HoverCard', () => {
  it('builds the content once and then only moves', () => {
    const { surface, take } = fakeSurface();
    const card = new HoverCard(surface);
    card.show(crust, '12 km down', 100, 200, viewport);
    expect(take()).toEqual(['content:Crust|Silicate rock · solid', 'depth:12 km down', 'visible:true', 'measure', `place:${114},${214}`]);
    // A move within the region: the depth text changes, its length does not — no measure.
    card.show(crust, '15 km down', 110, 205, viewport);
    expect(take()).toEqual(['depth:15 km down', 'place:124,219']);
    // The same depth text again: nothing but the move.
    card.show(crust, '15 km down', 111, 205, viewport);
    expect(take()).toEqual(['place:125,219']);
  });

  it('measures again when the content could have changed its size', () => {
    const { surface, take } = fakeSurface();
    const card = new HoverCard(surface);
    card.show(crust, '15 km down', 100, 200, viewport);
    take();
    // A longer depth line may be wider.
    card.show(crust, '1,015 km down', 100, 200, viewport);
    expect(take()).toEqual(['depth:1,015 km down', 'measure', 'place:114,214']);
    // Another region: name and kicker, then a measure.
    card.show(mantle, '1,015 km down', 100, 200, viewport);
    expect(take()).toEqual(['content:Upper mantle|Silicate rock · solid', 'measure', 'place:114,214']);
    // The depth line coming and going is a content change too.
    card.show(mantle, null, 100, 200, viewport);
    expect(take()).toEqual(['depth:null', 'measure', 'place:114,214']);
  });

  it('hides once and comes back without a measure while its content stands', () => {
    const { surface, take } = fakeSurface();
    const card = new HoverCard(surface);
    expect(card.isVisible()).toBe(false);
    card.hide();
    expect(take()).toEqual([]);
    card.show(crust, '15 km down', 100, 200, viewport);
    take();
    card.hide();
    card.hide();
    expect(take()).toEqual(['visible:false']);
    expect(card.isVisible()).toBe(false);
    card.show(crust, '15 km down', 300, 300, viewport);
    expect(take()).toEqual(['visible:true', 'place:314,314']);
    // Told the fonts arrived, the next show measures.
    card.invalidateSize();
    card.show(crust, '15 km down', 300, 300, viewport);
    expect(take()).toEqual(['measure', 'place:314,314']);
  });

  it('places by the size it measured, clamped to the viewport', () => {
    const { surface, take } = fakeSurface({ width: 200, height: 60 });
    const card = new HoverCard(surface);
    card.show(crust, null, 1395, 795, viewport);
    expect(take().pop()).toBe(`place:${1400 - 200 - HOVER_CARD_MARGIN_PX},${800 - 60 - HOVER_CARD_MARGIN_PX}`);
  });
});
