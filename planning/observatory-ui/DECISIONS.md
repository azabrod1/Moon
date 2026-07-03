# Observatory UI — decisions & next build

Compact log of where the exploration landed and the direction we're trying next.
All mockups live in this folder (served at http://localhost:8777).

## Mocks so far
- **A Living Chip / B Header Rail / C Edge Dock** — floating collapsed handles
  (corner chip / title-rail / edge spine); panel docks right.
- **D Bottom Bar** — Observatory as a popover in the bottom bar, spare collapsed
  segment. (Fixed: panel now docks right, emojis → mono glyphs.)
- **E Dock-launcher Hybrid** — D's bar launcher + B's live collapsed segment
  (phase glyph + body + UTC) + right-docked panel + Land/Orbit twin-primary picker.

## Three-lens review consensus
Bar *entry* is discoverable, but a right-docked panel that collapses to the
bottom-center bar creates a **"where did it go" jump** — the panel and its restore
handle end up in different corners. **A panel and its handle must live in the same place.**

## Decision — try the FULL side-dock (mock-F), responsive

**PC / desktop**
- **Bottom bar → Time + speed only** (flight controls stay put).
- **Right side panel → Stats + Observatory** (info / instruments). Both open and
  fold **in place on the right** — this kills the "where did it go."
- **Top-right actions → one merged Travel+Observatory entry** (the consolidation)
  **+ Autopilot moved here** + Leave + Menu. Merging Travel+Observatory frees the
  slot Autopilot moves into.

**Mobile**
- **One bottom bar** (Time, speed, Stats, Observatory-as-sheet) — no side rail.
- **Autopilot also moves** up into the top action cluster (same as PC).

**Rationale:** flight controls (time/speed) live on the bottom; instruments &
readouts (stats/observatory) live on the right and fold in place; autopilot becomes
an action button beside the merged Travel/Observatory entry.

## Next
Build **mock-F**: PC right-side dock (Stats + Observatory pop & fold from the right;
Time+speed stay bottom; Autopilot up in the actions). Mobile = current bottom-bar +
sheet, with Autopilot moved to the actions. Then compare against E.

## Built — mock-F (milled rail) ← current
Workflow `mock-f-side-dock` (3 designers → synthesize → build → review).
**Winner: the milled rail** — a fixed right-edge dock with two stacked glass
modules (Observatory over Stats). **Each module header IS its restore handle:**
folding collapses the body (grid `1fr→0fr`) in place, so the header never moves —
the "where did it go" jump is structurally impossible (Observatory header measured
byte-identical in open vs folded). Bottom bar → flight only (date + speed). Top
cluster → context-swap lead pill (cruise "Go there" picker / landed "Earth" unfolds
Observatory) + Pilot + Leave + Menu. Mobile → rail gone, Observatory re-houses to the
non-modal drag sheet, Pilot up top.
Files: `mock-F-side-dock.html`, `shots/F-{desktop,mobile}-{picker,open,min}.png`, `shots/montage-F.png`.

Fixed after review: the mobile "Earth ▾" bar segment was leaking onto the desktop bar
(a 2nd live restore handle) — `#obs-bar-toggle` now hard-hidden on desktop, re-shown
only ≤640px.

Open (review punch-list):
- **Stats co-location** — only the *active* module's header is truly fixed. The folded
  Stats glance rides the bottom of Observatory's body, so it jumps when Observatory
  folds/unfolds. Decide: anchor Stats to the rail bottom (both fixed) vs honest relabel.
- Both modules can't be open at once at 1440×900 (soft-accordion folds the other). Stats
  is 6 short rows — consider letting it always sit open below Observatory.
- Landed speed still reads "1.0c" (inert) — show "Parked" instead.
- Folded-glance text small / low-contrast on 1× displays.

## Tweaks — round 2
- Lead pill: landed face "Earth" → **"Observe"** (phase globe carries phase where it
  makes sense; plain lit globe otherwise). Cruise face "Go there" → **"Travel"** (+ picker
  eyebrow). Travel = the merged entry's destination picker; the ☰ Menu (help / settings /
  historic) is untouched.
- Folded **Stats** glance trimmed to just the AU ("STATS · 1.02 AU"); dropped fps.
- Picker now defaults to **Earth · the Moon** (was Neptune/Triton — off-theme while landed
  on Earth, so the Moon was nowhere). Picker actions are now **all equal-weight neutral
  buttons** — no primary emphasis on any (started as a bright solid-blue Land; no accent
  fill belongs on these).
- Moon selection: **moons are their own indented rows** under each planet (one tap, no
  drill-in). The `›` chevron is just a select affordance now. Search still covers typing a
  moon name; the Observatory `⇄` companion swap still flips body⇄moon once landed.
- **Travel** lead pill toned down to a faint tint (fill .10 / border .26) so it sits
  barely above the neutral Pilot/Menu instead of a loud blue fill.

## Design-critique pass (3 agents: interaction / visual / IA)
All three independently flagged the same top 3:
1. **Landed "Observe" pill = redundant third door.** The Observatory already has its
   co-located rail handle; the pill duplicates it (~250px away), is styled as the loudest
   thing on screen, and its hidden toggle *hides* the panel on 2nd press — re-creating the
   very "where did it go" split this mock exists to kill. → Drop the landed face (rail header
   owns show/hide) or repurpose it to a real action ("Look up").
2. **Picker action model is muddled.** Single-click selects but doesn't commit; the
   advertised "double-click to land" isn't wired; the 4 equal buttons mix two axes —
   Land/Orbit (arrival state) vs Autopilot/Jump (travel method) — and Orbit ≈ Jump Nearby.
   → Collapse to the real two decisions; single-tap commits; wire or delete double-click.
3. **Picker vs the in-panel ⇄ swap = two body-choosers that don't reconcile.** The swap's
   1:1 pair assumption breaks on Jupiter/Saturn (swap to *which* moon?); Earth-only hides it.
   → Make the swap a scoped view of the picker ("Nearby" = this system's bodies). One
   catalog, two zoom levels.

Visual craft:
- The "milled rail" is just two floating cards — no real spine/seam. Make it one continuous
  column with the modules as bays (or fuse with an inset groove).
- Cluster hierarchy inverted: "Leave" (the consequential action) is the quietest — give it a
  faint warm edge; Menu → icon-only.
- Radius/token drift: radii 4/9/10/14/16/999 (no scale); two "white" tokens (--text-primary
  vs --obs-t1); two glass-border values; icon strokes 1.4–1.6; raw ⇄/∅ glyphs vs SVG.
- Hero number line too dim; the date floater has no background (washes over a bright limb).

Smaller / fidelity: no keyboard (Esc/Enter/↑↓/focus); picker scrim-click *lands* you instead
of cancelling; "Surface view" is really "Look up" (already on the surface); Stats may not
earn a co-equal rail slot (it's passive cruise telemetry — consider demoting / moving to flight).

Agreed keepers: co-located fold + live folded glance; Travel→picker cruise identity;
right-dock honoring "never cover the planet"; the hero + now-bar; mobile re-housing.

## Implementing the critique
**#1 DONE — landed "Observe" pill (decision: remove).** On desktop the rail header is now
the sole Observatory open/restore handle; landed cluster = Pilot · Leave · Menu. Mobile keeps
the bar's phase segment as the sheet opener. Removed dead `focusObservatory()` + `.act-goto-disc`
CSS. Cluster polish: Leave gets a faint warm edge (the one consequential action); Menu is
icon-only.
Next: **#2** picker actions (two real axes: arrival state × travel method), **#3** picker↔swap
(scoped "Nearby"), then the **visual pass** (milled-rail spine, radius/token scale, SVG glyphs).

### #2 picker actions — PARKED (Alex thinking)
Explored two options in `mock-F-picker-options.html` (shot `shots/picker-options.png`): Option 1 =
two buttons (Land / Orbit) + a "Fly there" toggle; Option 2 = four buttons in two labeled pairs
(Arrive: Land | Orbit / Travel: Jump | Fly). Alex not thrilled with either — likes Option 2's
**two-groups** idea but feels four full buttons is a bit much. **Middle-ground to try next:** keep the
two group labels, but Land/Orbit as buttons and Jump/Fly as a small **segmented toggle** (grouped
without being four full buttons).

## Theme north star — "Obsidian" (Alex's Moon Theme Uplift)
Read from the claude.ai/design project `a8d5f236-2b38-489c-8770-4696a3c20021` via DesignSync
(`Moon Theme Uplift.html`; substance in `uplift/theme.css` + `uplift/chrome.jsx`). A finished
black-forward liquid-glass theme. Carry into the app as the **skin over our current IA**:
- **Fonts:** Geist (UI) + Geist Mono (numbers/labels).
- **Tokens:** accent `#5e8bff` (interactive); ember `#ffb88a` reserved for **live/now** (pulse, live
  rate, crown). Radius scale **16/10/7** (panel/button/small) — fixes the drift the reviewer flagged.
- **Icons:** one unified 1.4-stroke SVG family (observatory dish, rocket, pilot delta, stats bars,
  swap, leave, lookup, play/pause/now, search, 2-line menu) — replaces all emoji.
- **Glass:** `.pn` / `.pn-high` two tiers; signature **sun-aware glint** (panel top edge catches warm
  light from the scene's sun). Bonus: a drag time "crown" + a search scan-line.
Caveat: the theme predates our Travel+Observatory merge + side-dock rail (it has separate Travel/Obs
chips, Pilot in the bar, a centered Travel modal). Keep our IA; adopt the skin.
Next: re-skin mock-F into Obsidian (Geist + icons + 16/10/7 + accent/ember + `.pn` glass + glint), before/after.

### Obsidian re-skin — DONE (`mock-F-obsidian.html`)
Re-skinned the milled side-dock into Obsidian — **same IA, new skin** (separate file so the
before/after stays clean; `mock-F-side-dock.html` is the "before"). Carried over verbatim from
the design system's `theme.css` + `chrome.jsx` (re-pulled via DesignSync):
- **Type:** Geist (UI) + Geist Mono (numbers/labels), loaded from Google Fonts.
- **Tokens:** accent `#5e8bff`, ember `#ffb88a`, the **16/10/7** radius scale, `--t1/2/3`, `--line(-dim)`,
  `--ease`/`--dur`. The mock's older `--obs-*` / `--text-*` / `--panel-*` names are now **aliases** onto
  these, so every existing reference re-skinned for free; new surfaces use the canonical tokens.
- **Material:** ported `.pn` / `.pn-high` (`body.mat-glass`) — near-black glass, faint top-lit gradient,
  inset hairlines. Applied to the rail modules, picker, bottom bar, time popover, mobile sheet. Stripped
  each surface's bespoke glass so one material rules them all. The theme's **sun-aware glint is NOT used**
  (see below).
- **Icons:** swapped to the unified 1.4-stroke set — travel rocket, pilot delta, leave (eject-up), menu
  (2-line), swap ⇄, lookup (up-from-ground, replaces the ✦), search. Phase disc kept (it's data, not chrome).
- **Ember = live/now:** the now-bar dot + "REALTIME" label turned ember; the bar is now a neutral glass row.
- **Glint removed entirely** (Alex: "get rid of the sunlight shadow effect on buttons" → then "No glint").
  Dropped the `glint` body class + the `.pn::before` rule. The action chips were also flattened off `.pn`
  to plain hairline glass (blur, no gradient), padding tightened 14→10px (gap 6). Panels keep the `.pn`
  glass (gradient + hairlines), just no top-edge light streak.
- **Cluster chips fully neutral + compact** (Alex: "buttons are long … orange outline on Leave for no
  reason"). Removed the ember edge on Leave (now a plain neutral chip, equal-weight with the rest), and
  shortened its label "Leave Earth" → **"Leave"** (the `title` tooltip keeps the full body name).
- **Folded rail modules → a matched compact pair** (Alex: "these too long … same size … drop the 71% lit").
  Folded modules share ONE fixed width (140px), right-anchored (`.obs-rail` → `align-items: flex-end`),
  collapsed body pinned to `width: 0` so it can't force the bar wider — both bars equal, chevrons aligned.
  Open, the module returns to full width. Rail trimmed 344→320px.
- **Module identity = icon, folded Observatory = the planet** (Alex: "Observatory + that icon … or just
  Earth + Icon, the planet itself is the draw"). Each module header carries an identity icon (Observatory
  dish / Stats bars). Open shows `[icon] LABEL`; folded drops the word. **Observatory's dish also yields**
  when folded — replaced by the live phase-Earth disc + "Earth", so the planet is the draw (`◐ Earth ›`).
  Stats keeps its bars icon folded (no planet to show: `▦ 1.02 AU ›`). Glance also dropped "· 71% lit".
- **Chevron convention confirmed** (Alex asked): `›` when folded / `⌄` (down) when open — the standard
  disclosure-triangle pattern (right = collapsed, down = expanded). Already implemented, no change.
- **Observatory mark → telescope on a tripod** (Alex: the dish "reads paper-plane" at 16px — it does).
  Compared candidates rendered at true 14px in the real rail header (`_shoot-obsicon.mjs` →
  `shots/obsicon-montage.png`): steep refractor (T1) collapses to a pencil; the clear tripod-scope reads
  are C / T2 / T5. Chose **C ("Telescope on tripod")** — tube angled up at the sky, legs visible. (Design
  system has **T2**, the shallower one, wired into theme.css — a one-line swap if mock↔theme parity wins.)
  Detail was muddy at first (Alex: "hard to see the detail") — bumped the module icon to 16px, brightened
  it t3→t2 (t1 folded), stroke 1.4→1.55, so the tube + legs hold. The icon is the identity, so it now
  sits a step above the dim eyebrow.
- **Action icons refreshed** (Alex supplied a new sheet, `~/Downloads/Button Icons.html`). Adopted the
  cohesive redraw: **Leave** = craft lifting off the curved limb (was a bare up-arrow); **Land** = its
  mirror, settling onto the surface; **Orbit** = a body with a satellite on a tilted path; **Jump Nearby**
  = a leap-arc between two points (was a clock that read as *time*). **Autopilot** uses the Pilot delta we
  already have (per Alex — autopilot ≡ pilot; this also retires the old letter-"A"). Pilot + Menu kept.
- **Radius scale:** the 999px stadiums (bottom bar, action pills, swap, jump-pills, step buttons) became
  16/10/7 rounded rects — closes the reviewer's radius-drift item.
Shots: `shots/ab-{before,after}-{open,picker}.png`, `shots/montage-obsidian.png`, plus close crops
`shots/crop-{cluster,rail,picker}.png`. Harness: `_shoot-ab.mjs`, `_crop-check.mjs`.
Verified in crops: Geist loads, glint reads on the top edge, ember now-bar, all icons render, picker
hierarchy (indented moon rows) clean, Earth selected as a **neutral** highlight (no blue).

Open / optional next:
- **Selected picker row** is a neutral white highlight (our earlier "equal weight, no blue" call).
  Obsidian tints the selected row faint-accent — could adopt for the *row* (the *actions* stay neutral).
- Picker **actions** still the 4 equal buttons — **#2 is still parked** (segmented-toggle middle-ground
  untouched; the re-skin doesn't decide it).
- Mobile sheet got the palette + glint but keeps its id-level bg (no full gradient) — fine; desktop was the focus.
- Not yet ported: the **crown** time-scrub wheel + the **scan-line** search animation (bonus Obsidian bits).
- Picker/panel colour: **DECIDED black** (app end-state). Toned the mock to match —
  `--obs-glass` darkened to `rgba(9,10,13,.85)` (neutral, near-opaque) and dropped
  `saturate(140%)` from the blur. The blue was mostly the bright limb bleeding through +
  the saturation, not the token. Panels now read black like the app's menus while keeping
  a subtle glass blur + hairline.

## Variant — mock-G "Top-bar toggle" (`mock-G-topbar.html`)
Alex wanted to try the Obsidian-native IA instead of the two-module rail: **"put Stats back in the
center bar, and an Observatory button next to Pilot."** Built as a separate file (copy of the Obsidian
re-skin) so the rail version stays intact for comparison.
- **Observatory = a top-cluster chip** beside Pilot (landed only). It toggles the single right-docked
  panel and lights (accent `.on`) while open. The panel's own header click also closes it (`setState('min')`).
  Closed = no panel; the chip sits in the same corner the panel occupied, so no "where did it go."
- **Stats → bottom-bar popover** (where it is in the real app / Obsidian theme): a `Stats` segment in the
  bar (bars icon + label, divided from the speed group) opens a two-column readout grid (`.stat-grid`)
  above the bar. Time + Stats popovers are mutually exclusive.
- Rail reduced to the single Observatory module (Stats section deleted); `data-when="open"` hides it when
  closed. Dropped the fold-in-place `toggleMod`/`accordionGuard` and the folded-glance machinery (unused
  here). Mobile unchanged (sheet); the top chip drives it via setState.
- Shots: `shots/g-{open,min,stats,cluster}.png`. Harness: `_shoot-g.mjs`. No console errors.
- **Trade vs the rail (mock-F):** simpler, matches the theme's native layout, frees the right edge when
  closed — but loses the rail's live folded glance (phase-Earth / AU at a peek) and the single co-located
  fold handle. **Open question for Alex:** which to carry forward.

### mock-G — Stats-on-the-right (Alex: "show Stats on the right even though the button's in the center — clean?")
The center-button→right-panel hop is the "where did it go" split unless connected. Made it clean with
four things together: (1) the Stats card **docks to the screen's bottom-right** (same instrument zone as
the Observatory), (2) its **center bar button lights** while showing (ties button↔card across the gap),
(3) it **slides in from the right edge** (reads as docking, not teleporting), (4) the **right zone holds
one instrument** — opening Stats tucks the Observatory (`setState('min')`) and opening the Observatory
closes Stats, so two cards never stack in the corner.
Gotcha fixed: the card must live OUTSIDE `#planetarium-bottom-bar` in the DOM — the bar's
`transform: translateX(-50%)` makes any `position:fixed` descendant anchor to the bar, not the viewport,
so the card was landing at the bar's right edge (center) instead of the screen edge.
Dropped the Stats button's ▼ chevron (Alex: the arrow implies vertical expand, but the card slides in from
the right) — the button is now `▦ Stats`, lit-when-active like the Observatory chip. (Time keeps its chevron:
its popover genuinely rises up from the button.)
Shots: `shots/g4-stats-clean.png` (Stats card alone, Observatory tucked), `shots/g5-bar-on.png` (lit button).
Harness: `_shoot-g{,2,3,4,5}.mjs`.
Open: mutual-exclusion means you can't see Stats + Observatory at once — fine for passive telemetry, but
if Alex wants both, the alternative is stacking (Stats bottom-right + Observatory max-height capped above it).

## ▶ READY TO PLAN — open forks to lock before implementing in the real app
The mockups are done. Implementation = porting the chosen design into the real app (`index.html` UI +
`src/planetarium/ui/*` + `PlanetariumMode`), NOT the mockups. Decisions still open:

1. **THE BIG FORK — which IA?**
   - **mock-F-obsidian** (milled rail): Observatory + Stats as two right-edge modules that fold in place;
     live folded glance (`◐ Earth` / `1.02 AU`); single co-located handle. Richest, but two right cards.
   - **mock-G-topbar** (Obsidian-native): Observatory = top chip beside Pilot → single right panel;
     Stats = bottom-bar button → bottom-right card; right zone holds one at a time. Simpler, theme-native.
   - Everything else depends on this pick.
2. **Stats coexistence** (only if mock-G): mutual-exclusion (current) vs stacking (both visible, Observatory
   height capped above the Stats card).
3. **#2 picker action model** — still parked. 4 equal buttons now; the segmented-toggle middle-ground
   (two group labels, Land/Orbit buttons + Jump/Fly toggle) untried.
4. **#3 picker ↔ in-panel swap** — make the `⇄` companion swap a scoped "Nearby" view of the picker.
5. **Selected picker row** — neutral white highlight (current) vs faint-accent tint (Obsidian-native).
6. **Telescope icon** — using C in the mock; theme.css has T2 wired. Pick one for mock↔app parity.

Carried (not open): Geist + Geist Mono, accent `#5e8bff` / ember `#ffb88a` (live/now), 16/10/7 radii, the
`.pn` glass (no glint), the refreshed action-icon set, panels read black, moons-as-rows in the picker.

## ✅ IA LOCKED — mock-G (top-bar chip). Plan: `IMPLEMENTATION-PLAN.md`
Big fork resolved: **mock-G-topbar** (Observatory = top chip → single right panel; Stats = bottom-bar
button → bottom-right card; one instrument at a time). Implementation plan written — ports the skin + IA
into the real app in three phases (skin → IA-non-merge → picker merge), the picker merge **gated on the
parked fork #2**. Minor forks defaulted in the plan: Stats = mutual-exclusion, selected row = neutral,
telescope = C. Next: fresh-subagent + codex review of the plan, then build on a fresh branch off `main`.

## Icon-only top actions (2026-07-03) — SHIPPED
Alex's design-env handoff (`handoff-icon-top-actions/`, from `~/Downloads/Moon.zip`): the top-right
cluster goes icon-only — 38 px squares, redrawn 20-grid glyphs (tapered telescope, solid swept-fin
rocket, **heading-hold** for Pilot, three-bar menu), all monochrome (Travel's accent tint removed —
accent now marks only on/engaged). Leave keeps its text (names the body). Guards: hover tooltips
(pointer-fine only, right-anchored at the screen corner), engaged Pilot widens with the target name.
Two stale-baseline items resolved during build: Observatory already showed in flight; Pilot stays
hidden when landed (P2 decision kept). Built directly without a review panel — Alex: simple
well-specified changes don't need one.
