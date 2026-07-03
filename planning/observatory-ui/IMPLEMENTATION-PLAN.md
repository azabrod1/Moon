# Observatory UI → real app — implementation plan (v2)

Port the **mock-G** design (locked) into the live app. Mockups stay local; only real app files change.

**v2 folds in a 4-way fresh review** (3 subagents: correctness / design / naming + codex gpt-5.5 xhigh). Consensus: **Phase 1 = ship-with-changes; Phase 2 = needs-rework** (it under-counted three multi-site rewrites and inherited mock scaffolding the app must not copy). The rework is below. The verified real bugs the review caught are tracked in "Review findings → resolutions" at the end.

- **Source of truth:** `mock-G-topbar.html` (skin + IA target), `uplift/theme.css` (tokens). **Caveat:** mock-G is a copy of the mock-F rail with the rail markup still present — its desktop `.obs-rail`/`#mod-observatory`/`data-folded`/folded-glance and its mock `#observatory-panel` (mobile-sheet-only, `display:none` desktop) are **non-shipping artifacts**. The real app's single right-docked `#observatory-panel.visible` is what we keep. Do **not** port the rail/module/fold machinery.
- **Target files:** `index.html`, `src/planetarium/PlanetariumMode.ts`, `src/planetarium/ui/ObservatoryPanel.ts`, `src/planetarium/ui/PlanetariumBottomBar.ts`.
- **Branch:** `observatory-ui` (already cut; `obs-surface-swap-fix` merged in). **Reference code by SYMBOL name, not line number** — the merge shifted `PlanetariumMode.ts` by ~305 lines, which is why v1's line cites were all wrong.

## Guardrails
- **Mockups never ship.** `planning/` stays untracked.
- **Preserve the element-id set** the TS reads. Renames go in lockstep with the TS. **Separately:** the cluster's `.planetarium-sm-btn` → `.act-btn` is a deliberate **class** rename (not covered by id-preservation) — carry its `:hover` AND `:disabled` rules over (`.planetarium-sm-btn:disabled` drives the mission-dim).
- **Keep the real `#observatory-panel`** element + its `.visible` show/hide + the mobile-sheet drag/peek machinery (`ObservatoryPanel.bind/render` depend on its ids; sheet drag depends on `.obs-eyebrow`/`.obs-vantage`). Reskin it in place.
- **Scrub mock comments when porting CSS** — drop every "the hybrid / Mock F / this mock / lifted from index.html"; keep only comments that state the behavioral constraint itself.
- Panels read **black** (accent only as accent); **no glint**; picker actions **equal-weight neutral**; copy plain/human.
- Verify with **before/after** GPU headless screenshots (`--use-gl=angle --use-angle=metal --enable-gpu --ignore-gpu-blocklist`, deviceScaleFactor 2). `npm run build` + `npm test` after each phase. **Note:** the colocated `ObservatoryPanel.test.ts`/`surfaceView.test.ts` are pure-function (no DOM) — green tests do **not** prove the reskin is safe; a browser walkthrough is the real check.

---

## Phase 1 — Obsidian skin (skin-only, no IA change)
Reskin in place; every surface keeps its id and role.

- **`:root` tokens — REPLACE, don't append.** The app already defines `--accent` (`#7c9aff`), `--obs-*`, `--text-*`, `--panel-*` with different values; the mock's block supersedes them (`--accent: #5e8bff`, `--obs-*` → aliases). Genuinely new + additive: `--accent-rgb`, `--ember(-rgb)`, `--glass-a`, `--r-l/m/s` (16/10/7), `--line(-dim)`, `--font-ui/mono`, `--ease`, `--dur`. State "replace the existing values" so nobody duplicates declarations.
- **Fonts:** Geist + Geist Mono `<link>`s; set `--font-ui/mono`.
- **Material:** `.pn`/`.pn-high` under `body.mat-glass` (no glint). Apply to bottom bar row, `#observatory-panel`, both menus, time/stats popovers. Strip each surface's bespoke glass.
- **Class rename:** `.planetarium-sm-btn` → `.act-btn` + role modifiers (`.act-goto/.act-pilot/.act-obs/.act-leave/.act-menu/.act-icon`, label `.act-lbl`, glyph `.act-glyph`), plus `.act-btn:hover`, `.act-btn:disabled`, `.act-btn.on`, `.act-btn.active`. Ids unchanged.
- **Icons:** emoji → inline SVG. **Each SVG-glyph button must route its JS text through a dedicated `.act-lbl` span, never `innerHTML`/`textContent` on the button.** Concretely: `updateAutopilotButton()` rewrites `#planetarium-btn-autopilot` `innerHTML` to `🤖 Pilot` / `🤖 → name` on every autopilot change — it **will** clobber the SVG. Rewrite it to set only the label span. (The `['planetarium-btn-travel','']` entry the v1 plan named only sets `style.display` — not a clobber; ignore it.) Also re-skin Travel's bare `🚀` text node, Leave (keep `#leave-body-name` span), Menu.
- **Ember = live/now:** now-bar dot + tag turn ember (CSS only); keep `#observatory-now`/`#observatory-now-tag` driven by `observatoryNowTag()`.
- **16/10/7 radii** replace stadium/ad-hoc radii.
- Reskin both menus (`#travel-menu`, `#observatory-menu`) and the panel to the new grammar — **but do not** give the reskinned menus the consolidated picker's twin-primary layout (that's P3); they stay structurally as-is so they don't masquerade as the finished picker.

**Verify:** before/after at cruise / landed-open / picker(menu) / surface view + ≤640px; confirm Pilot glyph survives an autopilot toggle; confirm mission-dim still greys the cluster.

## Phase 2 — Two safe IA moves (Pilot + Stats). No Observatory-chip repurposing.
*The "Observatory chip toggles the panel" move is rescheduled to P3 — see the box below.*

**2a — Pilot → cluster.** Move `#planetarium-btn-autopilot` from `.bar-speed-main` into `#planetarium-actions`. Then:
- The handler is unchanged, but moving it isn't free: convert `enterLandedMode`/`exitLandedMode`'s `speedGroup.style.display='none'/''` toggles to a **`.speed-group.inert`** class (opacity + pointer-events, still laid out) — with Pilot gone, `display:none` empties `.bar-speed-main` and the centered bar **reflows**. The mock relies on `.inert`.
- Port disabled styling: Pilot is in `MISSION_CONTROL_IDS` (gets `disabled`), so `.act-btn:disabled` must exist; migrate the autopilot active state from `.planetarium-icon-btn.active` → `.act-btn.active`/`.on`.
- Note (decide): landed, clicking Pilot still `exitLandedMode()` + opens travel — now sitting next to Observatory, more accidentally hittable. Keep or guard.

**2b — Stats → bottom-right docked card, with a single owned API.**
- Relocate `#stats-popover` **out of** `#planetarium-bottom-bar` to document top level (the bar's `transform: translateX(-50%)` re-anchors `position:fixed` descendants). Restyle: `position:fixed` bottom-right, slide-in, `.stats-pop-head`. Delete `#stats-chevron` from markup **and** remove the `statsChevron` field + its `.expanded` toggles in `PlanetariumBottomBar.ts` (`noUnusedLocals`). Decide which element gets `.on` (the real toggle is the `#bar-stats-toggle` `.bar-section` div — convert to a button or light the div).
- **Single owner.** `PlanetariumBottomBar` gets public `closeStats()` / `isStatsOpen()` + an `onStatsToggle` callback; `PlanetariumMode` arbitrates. `closeStats()` updates popover + button `.on` together.
- **Restore the hide paths the bar gave Stats for free** (it was a bar descendant; now it isn't). Call `closeStats()` on: **mission activation** (`updateMissionControlState`), **surface-view entry** (`enterSurfaceView`), **mode deactivate**, **mobile sheet open**, and **Observatory open**. Add CSS failsafes: `body.surface-view-active #stats-popover{display:none}` and the `observatory-sheet-open` equivalent.
- **Outside-click fix:** the bar's document-level handler must exclude the relocated card (`!bar.contains(t) && !statsPopover.contains(t)`).
- **Mutual-exclusion (Stats ⇄ Observatory panel):** opening Stats → `closeObservatoryPanel()`; any Observatory-open path (`pickObservatoryBody`, restore) → `closeStats()`. Needs a **visible hand-off** (the panel doesn't just silently vanish): pulse the chip / brief collapse animation, and a **`prefers-reduced-motion`** fallback (no slide → the lit button is the only button↔card link — verify it reads).
- **Keyboard/a11y:** add Esc-closes-Stats to the existing Escape cascade; `aria-expanded` on the Stats button.

**Verify:** Stats card docks bottom-right, never floats over surface view / missions / sheet; opening it tucks the panel with visible feedback; bar doesn't reflow on land/leave with Pilot gone; Pilot works + dims in missions.

> ### Rescheduled to P3 (was P2): the Observatory chip becomes the panel toggle
> The review found this is **entangled with the picker merge** and can't ship cleanly in P2:
> - **Stranding (blocker):** the landed Observatory chip's menu is *also* the "switch which body I'm standing on" path. Repurposing the chip to toggle the panel removes vantage-switching until the unified picker (P3) restores it.
> - **Overloaded interim (design):** a chip that opens a *menu* in cruise but toggles a *panel* landed, both styled as the same lit toggle, lies about its behavior.
> - **Close-contract (blocker):** `ObservatoryPanel.hide()` runs *before* `onClose`, so mapping the panel `×` to `toggleObservatoryPanel()` would immediately **reopen** it.
>
> So P2 leaves the Observatory chip as the reskinned vantage-menu opener (no lighting, no toggle). All of it moves to P3.

## Phase 3 — IA consolidation (gated on the parked picker-action fork)
- Merge `#travel-menu` + `#observatory-menu` into one picker with the resolved action model. "Land — sky open" = `pickObservatoryBody`; "Orbit — sky tucked" = old Land & Orbit; Autopilot + Jump unchanged. The picker becomes the vantage-switch path (closes the P2 stranding).
- **Now** repurpose the chips: remove the cruise Observatory chip; the **landed** chip toggles `#observatory-panel` + lights via a single `syncObservatoryChip()` reading `observatoryPanel.isOpen()` (called from toggle/close/`finalizeSurfaceExit`/restore — never inferred from clicks; the surface HUD's own `#surface-observatory` also toggles the panel, so the cluster chip must re-sync on surface-exit). Branch the chip's click: cruise→picker; landed-on-subject→toggle panel; **landed-on-moonless-body (Mercury)→still the picker** (no subject to panel).
- **Panel `×` stays `closeObservatoryPanel()`** (not the toggle). Door model: chip = open/restore + lit status; `×`/Esc = close. (Confirm with Alex — see open decisions.)
- Reconcile fork #3 (the `⇄` companion swap as a scoped "Nearby" view of the picker). Retire the dead second menu + ids (`noUnusedLocals`).

---

## Open decisions for Alex (defaults stand if you don't weigh in)
- **#2 picker action model** — *parked, yours.* Gates P3. Standing middle-ground: two group labels, Land/Orbit buttons, Jump/Fly segmented toggle.
- **Door model (P3):** chip = toggle+status, `×`/Esc = close (recommended) — vs chip-only (drop the `×`). The prior critique killed a *redundant open* door; one open affordance + a close `×` is conventional, but confirm.
- **Stats coexistence** — mutual-exclusion (default) vs stacking (Stats is 6 short rows; could sit open below a height-capped panel). Mutual-exclusion needs the visible hand-off above.
- **#5 selected picker row** — neutral white (default) vs faint-accent tint.
- **#6 telescope icon** — C (default); update `theme.css` T2→C for parity.
- **Mobile `#obs-bar-toggle`** — recommend **skip it**; the real sheet has a full drag model and the cluster chip already works ≤640px. Don't import the mock's toy `toggleSheet`. (Reconcile with `body.observatory-sheet-open #planetarium-bottom-bar{display:none}`.)

## Review findings → resolutions (all verified against the merged code)
- **Don't import mock's rail/`#mod-observatory`/fold scaffolding; keep real `#observatory-panel`.** → Guardrails + caveat.
- **`updateAutopilotButton` innerHTML clobbers the SVG.** → P1 icons bullet (the real clobber; v1 named a false positive).
- **`:root` is a replace, not an append.** → P1.
- **`.planetarium-sm-btn`→`.act-btn` rename incl. `:disabled` (mission-dim).** → Guardrails + P1.
- **Speed-group `display:none`→`.inert` (else bar reflows with Pilot gone).** → P2a.
- **Stats loses 4 implicit hide paths (surface/mission/sheet/deactivate) when it leaves the bar; only outside-click was covered.** → P2b.
- **Mutual-exclusion ownership split across two files.** → single owned Stats API in P2b.
- **Panel `×` → toggle would reopen (hide-before-onClose).** → P3 keeps `×`=`closeObservatoryPanel`.
- **Chip repurpose strands landed vantage-switch; overloaded interim.** → rescheduled to P3.
- **Chip click is a handler rewrite (3-way: cruise/landed-subject/moonless), not an "extend"; `.on` via `syncObservatoryChip`.** → P3.
- **Tests are pure-function — won't catch DOM breakage.** → Guardrails verification note.
- **Stale line numbers (post-merge shift).** → symbol names throughout.

## Out of scope / deferred
- Obsidian "crown" time-scrub wheel + search scan-line.
- Stats-coexistence stacking variant.
- Any planet-beauty / 4K work (separate concern; note the uncommitted atmosphere-shells-off WIP riding this branch).

## Status log
- **P1 (Obsidian skin) — DONE + verified, UNCOMMITTED on `observatory-ui` (2026-06-21).** All in `index.html` + `PlanetariumMode.ts`. Tokens replaced (accent #5e8bff, ember, 16/10/7, Geist via `<link>`); both `:root` blocks consolidated (obs-* now alias the palette). `.pn/.pn-high` material under `body.mat-glass` on bar/panel/menus/popovers (bespoke glass stripped). Cluster `.planetarium-sm-btn`→`.act-btn` (+ role mods, SVG glyphs, `.act-lbl`); Travel leads via accent glyph only (old blue-fill rule deleted). Bar `.planetarium-icon-btn` reskinned (`--r-s`, `--line-dim`, `.bar-glyph`, `.on`/`.active` retokenized). `updateAutopilotButton` now sets the `.autopilot-lbl` span (not `innerHTML`) — SVG survives toggle (runtime-verified). 25 hardcoded old-accent `rgba(124,154,255)` literals swept to `rgba(var(--accent-rgb),…)`. Ember now-bar (dot/tag/flash). Build green + 614 tests pass; mission-dim `.act-btn:disabled` verified (opacity 0.4).
  - **Dev-server gotcha:** `:5173` = `/Users/alex/Developer/Moon` (this branch, the reskin). `:5190` = the `obs-surface-swap-fix` worktree (pre-reskin). Shoot/preview against **5173**. Before/after shots in `/tmp/moon-ui/{before,after,crop}`; UI shooters are `planning/observatory-ui/_shoot-{ui,crop,pop}.mjs`.
- **P2 (Pilot→cluster + Stats card) — DONE + verified, COMMITTED `746291f` (2026-06-21).** `index.html` + `PlanetariumMode.ts` + `PlanetariumBottomBar.ts`. **2a:** Pilot moved into `#planetarium-actions` as `.act-btn act-pilot`; speed group dims `.inert` (no bar reflow); **Pilot hides when landed** (decision — flight control, Travel covers "go elsewhere"; flip = drop the hide in `applyLandedTarget`/`exitLandedMode`). **2b:** `#stats-popover` relocated out of the bar to a fixed bottom-right docked card (`.pn pn-high`, slide-in, `.stats-pop-head`); `PlanetariumBottomBar` is the single owner (`closeStats()`/`isStatsOpen()`/`onStatsToggle`, lit `#bar-stats-toggle` + aria-expanded, keyboard, outside-click excludes the card); mutual-exclusion Stats⇄Observatory panel with hand-off pulse (`pulseObservatoryChip`); `closeStats()` on Escape / panel-open / mission / surface entry / deactivate / landing; failsafes for surface-view + sheet-open; reduced-motion + mobile (`bottom:104px`, cluster labels collapse to icons ≤420px keeping Observatory). Runtime-verified (mutual-exclusion, hand-off, failsafe), build green + 614 tests.
  - **P1 committed `ad5b7b9`.** Next: **P3** (picker merge), gated on Alex's parked picker-action fork #2.
- **Icon-only top actions (design handoff, between P2 and P3) — DONE + verified, UNCOMMITTED (2026-07-03).** From `handoff-icon-top-actions/` (Alex's design-env export, `~/Downloads/Moon.zip`). `index.html` + `updateAutopilotButton`. Observatory/Travel/Pilot/Menu → 38 px icon squares, 20-grid glyphs (tapered telescope, solid swept-fin rocket, heading-hold ring, three-bar menu); Leave keeps its label, bumps to 38 px, 20-grid lift-off glyph. Travel's accent-glyph rule deleted (accent = state only). Engaged Pilot widens with the target name via `.act-wide` (label ellipsis ≤96px; `→` prefix dropped); tip copy swaps engaged/rest in TS. Hover tooltips `.act-tip` (0.38 s delay, hover+pointer-fine only, **right-anchored** — centered tips clipped at the viewport for the corner buttons); `title` attrs dropped in favor of `aria-label` + tips (native title double-tooltips). Layering: row z 21→22 so tips clear the observatory panel; panel + menu dropdown top 42→56 px under the taller row. 420 px label-collapse media rules deleted (row is icon-only everywhere); Leave label capped 31vw with ellipsis. **Deviations from the handoff README (stale baseline):** Observatory already showed in flight (no-op); Pilot stays hidden when landed (P2 decision kept — the mock's landed strip predates it). Verified: build + 614 tests green, zero console errors; shots `/tmp/moon-ui/icon-actions/` (cruise, engaged pill, tip-over-panel, stats, 360 px Enceladus fit 283 px); shooter `_shoot-icon-actions.mjs`.
- **Onboarding autopilot default REMOVED (2026-07-03, Alex).** Fresh boots / Restart / New-journey no longer silently engage autopilot toward Mercury (with the icon row, the accent-lit Pilot square advertised a state the user never chose). The alive opening survives: default state keeps `moving: true` + `pointTowardMercury()`, so new users still glide toward Mercury — they just aren't steered. `autopilot` now defaults false in the field init + `createDefaultPlanetariumState`; restore path unchanged (user trips still resume). Legacy plumbing kept: the store's Mercury-provenance heuristic and the retire-on-landing branch still cover old saves (comments retensed). Also erased a latent inconsistency: the New-journey path forgot to reset `autopilotUserEngaged`, so the silent Mercury trip could masquerade as a user pick. Verified fresh boot: Pilot chip classes `act-btn act-icon`, no label, no destination; build + 614 tests green.
- **Stats reads as a button (2026-07-03, Alex: "make it more obv that stats is a button").** `#bar-stats-toggle` was a bare 10px word after a hairline — same visual weight as the "Space" caption. Now a chip in the bar's button family (28 px, `--r-s`, `--line-dim` border, 0.04 fill, hover lift) with a 13 px three-bar stats glyph + 11 px label; open state = accent tint/border, accent glyph, bright label (same `.on` language as the top row; old label-only accent rule replaced). Div/role/id untouched — zero TS churn. Verified rest/hover/open + 320 px bar fit (281 px, no overflow); shots `/tmp/moon-ui/icon-actions/d*.png`.
