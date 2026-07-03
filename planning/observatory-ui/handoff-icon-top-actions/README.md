# Handoff: Icon-Only Top Actions (Planetarium)

## Overview
The Planetarium's top-right action row (`#planetarium-actions` in `index.html`) currently renders five labeled chips: **Leave <body>**, **Observatory**, **Travel**, **Pilot**, **Menu**. This design converts Observatory, Travel, Pilot and Menu to **icon-only 38 px square buttons** with redrawn higher-resolution glyphs, hover tooltips, and an autopilot chip that grows a target label only while engaged. **Leave keeps its text label** (it names the body being left, e.g. "Leave the Moon").

Decisions settled during design review:
- Pilot glyph = **Heading hold** (craft marker inside a heading ring) — replaces the kite.
- Travel glyph = **rebuilt rocket** (swept fins, porthole ring, teardrop flame) — replaces the previous rocket.
- Leave glyph = **Lift-off** (ascent arrow off a curved horizon), redrawn on the 20-grid — mirrors the Land icon.
- Menu = **three bars** (was two).
- **All glyphs are monochrome.** The previous accent-blue tint on the Travel glyph (`.act-goto .act-glyph { color: var(--accent) }`) is removed; accent color is reserved for on/engaged states.
- Observatory button shows **in flight as well as landed** (previously landed-only).

## About the Design Files
The bundled `Icon-Only Top Actions.html` is a **design reference created in HTML** — a mockup showing intended look and behavior, not production code to copy directly. The task is to implement this design **in the existing app** (`index.html` markup/CSS + the TypeScript that drives it, e.g. `src/planetarium/PlanetariumMode.ts` / `ui/` classes), following the codebase's established patterns (vanilla HTML overlay, ids read via `getElementById`, CSS custom properties from the Obsidian theme).

## Fidelity
**High-fidelity.** Colors, sizes, radii, stroke weights and SVG path data are final. Recreate exactly, using the theme's existing CSS variables rather than hard-coded values.

## The Buttons

### Icon button (Observatory, Travel, Pilot, Menu)
- Size: **38 × 38 px**, `border-radius: var(--r-m)` (10 px)
- Background: `rgba(255,255,255,0.045)`; border: `1px solid var(--line)`; `backdrop-filter: blur(12px)`
- Glyph: **20 × 20 px** SVG, `viewBox="0 0 20 20"`, `stroke-width="1.6"`, `stroke-linecap="round"`, `stroke-linejoin="round"`, colored via `currentColor`; button color `var(--t2)`
- Hover: background `rgba(255,255,255,0.09)`, color `var(--t1)`, border `rgba(255,255,255,0.14)`
- On/engaged (`.on` / `.active`): background `rgba(var(--accent-rgb), 0.14)`, border `rgba(var(--accent-rgb), 0.35)`, glyph `var(--accent)`
- Transitions: background/color/border-color, `var(--dur) var(--ease)` (300 ms, cubic-bezier(0.22,1,0.36,1))
- Keep existing `title` attributes and add `aria-label` per button (labels are gone from the DOM text).

### Leave chip (labeled)
- Height **38 px**, padding `0 13px`, same background/border/hover as icon buttons
- Glyph 16 px (the 20-grid Lift-off icon scales down), gap 7 px, label 12 px / 500 weight, `letter-spacing: 0.2px`
- Label text unchanged: `Leave <span id="leave-body-name">`.

### Row
- Gap between buttons: **7 px** (unchanged from current `#planetarium-actions`).
- Order: Leave (landed only) · Observatory · Travel · Pilot · Menu. Observatory is no longer hidden in flight.

## Tooltips
- Appear **below** the button, centered; delay **~400 ms** after hover (mock uses `transition-delay: 0.38s` on opacity/transform; a 3 px rise-in)
- Style: background `rgba(8,10,15,0.94)`, `1px solid var(--line)`, radius 7 px, padding `5px 9px`, font 11 px `var(--t1)`, shadow `0 8px 24px rgba(0,0,0,0.5)`
- Copy: "Observatory", "Travel", "Pilot" + `<kbd>P</kbd>`, "Menu"; engaged pilot: "Autopilot engaged — click to disengage"
- Tooltips are hover-only chrome — suppress on touch devices (the `title` attr covers long-press).

## Autopilot engaged state
- Disengaged: icon-only 38 px button, rest styling.
- Engaged: button gets `.on` styling **and widens** to include the target name: padding `0 13px 0 10px`, gap 7 px, glyph 18 px, label 12 px / 500 (e.g. "Mars"). This replaces the current behavior of rewriting the `Pilot` label (`.autopilot-lbl`, `max-width: 120px` + ellipsis on `#planetarium-btn-autopilot` still applies to cap long moon names).
- On disengage the chip collapses back to 38 px square. Animate width if cheap (the theme's 300 ms ease); acceptable to snap.

## SVG Glyphs (final path data)
All are `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`.

### Observatory — telescope (tapered tube, lens band, eyepiece stub, tripod)
```html
<path d="M4.15 8.11 L12.68 3.17 L14.12 6.03 L5.05 9.89 Z"></path>
<path d="M11.9 3.75 L13.15 6.35"></path>
<path d="M4.5 9.05 L3.1 9.75"></path>
<path d="M9.4 8.2 L9.0 15.6 M9.0 15.6 L6.7 17.8 M9.0 15.6 L11.3 17.8"></path>
```

### Travel — rocket, lift-off 42° (solid silhouette, porthole ring knockout, swept fins, teardrop flame)
```html
<g transform="rotate(42 10 10)">
  <path fill-rule="evenodd" fill="currentColor" stroke="none" d="M10 1.4 C 8.1 3.4 7.1 6.3 7.1 9.5 L 7.1 14.2 C 7.1 14.75 7.5 15.1 8.05 15.1 L 11.95 15.1 C 12.5 15.1 12.9 14.75 12.9 14.2 L 12.9 9.5 C 12.9 6.3 11.9 3.4 10 1.4 Z M10 5.45 a1.65 1.65 0 1 1 0 3.3 a1.65 1.65 0 0 1 0 -3.3 Z M10 6.25 a0.85 0.85 0 1 1 0 1.7 a0.85 0.85 0 0 1 0 -1.7 Z"></path>
  <path fill="currentColor" stroke="none" d="M7.1 10.6 C 5.6 11.5 4.6 13.1 4.3 15.0 C 4.25 15.4 4.6 15.7 5.0 15.55 L 7.1 14.7 Z"></path>
  <path fill="currentColor" stroke="none" d="M12.9 10.6 C 14.4 11.5 15.4 13.1 15.7 15.0 C 15.75 15.4 15.4 15.7 15.0 15.55 L 12.9 14.7 Z"></path>
  <path fill="currentColor" stroke="none" d="M10 19.2 C 9.0 18.0 8.55 17.0 8.75 16.0 L 11.25 16.0 C 11.45 17.0 11.0 18.0 10 19.2 Z"></path>
</g>
```

### Pilot — heading hold (ring + solid craft marker)
```html
<circle cx="10" cy="10" r="7.4"></circle>
<path fill="currentColor" stroke="none" d="M10 5.2 L12.9 13 L10 11.15 L7.1 13 Z"></path>
```

### Menu — three bars
```html
<path d="M4 5.5 H16 M4 10 H16 M4 14.5 H16"></path>
```

### Leave — lift-off (ascent arrow off horizon; rendered 16 px inside the labeled chip)
```html
<path d="M3 15.4 Q10 12.6 17 15.4"></path>
<path d="M10 12.6 V3.4"></path>
<path d="M6.4 7 L10 3.4 L13.6 7"></path>
```

## Interactions & Behavior
- Click behavior of every button is unchanged (Observatory toggles `#observatory-panel` and gets `.on` while open; Travel opens the travel menu; Pilot engages/disengages autopilot, `P` shortcut; Menu toggles `#planetarium-menu-panel` with `.on`).
- The existing one-shot `act-handoff` pulse animation and `:focus-visible` outline carry over as-is.
- Observatory visibility: remove the landed-only `display:none` gating for `#planetarium-btn-observatory` (show it in flight too); Leave stays landed-only.

## Codebase touch points
- `index.html` — `#planetarium-actions` markup (replace chip contents/SVGs, drop `.act-lbl` spans except Leave's), the `.act-btn` CSS block (add icon-only sizing, tooltip styles, engaged-wide pilot chip), remove `.act-goto .act-glyph` accent rule.
- Mobile CSS: the `@media (max-width: 420px)` rule that hides `.travel-btn-text` / collapses chips is obsolete — the row is icon-only everywhere; delete rather than let it fight the new markup. Verify the landed row (Leave + 4 icons = ~230 px) fits 320 px wide screens; if tight, Leave's label may truncate the body name with ellipsis.
- `src/planetarium/PlanetariumMode.ts` (and/or the `ui/` panel classes) — wherever `.autopilot-lbl` text is set on engage/disengage: switch to adding/removing the target-name span + `.on`/wide class instead of rewriting the "Pilot" label.
- Keep all element ids identical (`planetarium-btn-observatory`, `-travel`, `-autopilot`, `-menu`, `-leave`) — the TS reads them by id.

## Design Tokens (from the existing Obsidian theme — use the vars, not literals)
- `--accent: #5e8bff`, `--accent-rgb: 94,139,255`
- `--t1: #eef1f7`, `--t2: #9aa4b8`, `--t3: #5b6377`
- `--line: rgba(255,255,255,0.08)`, `--line-dim: rgba(255,255,255,0.05)`
- `--r-m: 10px`, `--dur: 300ms`, `--ease: cubic-bezier(0.22,1,0.36,1)`
- Font: Geist (`--font-ui`); button/label text 12 px / 500

## Assets
None — all glyphs are inline SVG defined above. No external images or icon fonts.

## Files
- `Icon-Only Top Actions.html` — the interactive mockup: in-context strips (current vs proposed, landed + in-flight), final glyphs with states, tooltip demo, size rationale (34/38/42), plus the alternates that were considered (autopilot B chosen, Leave A chosen). Open it in a browser; hover the strips for live tooltips.
