# Observatory panel — minimize/restore UI exploration

Three directions for making the landed Observatory panel **minimizable + restorable**
(so closing it is never a dead-end), with the consolidated body-picker + action bar
and a double-click express path. All over the live sky, extending the real `--obs-*`
tokens. Each mockup is a self-contained HTML file with a dev state-switcher
(Picker / Panel open / Minimized) and a real ≤640px mobile bottom-sheet layout.

| | Minimized form (desktop) | Mobile form | Notes |
|---|---|---|---|
| **A · Living Chip** | Glass chip in the top-right corner (phase glyph + `Earth · 14:32 UTC` + expand) | Chip bottom-right, above the home indicator | Instrument shrinks to a glance; click to expand. Labeled. |
| **B · Header Rail** | Collapses to its own slim title bar (`Observatory · Earth · Waxing Gibbous · time · ▾`) | The collapsed rail **is** the bottom-sheet peek handle | Always shows body + phase + time. Same element in both states. |
| **C · Edge Dock** | Slides off the right edge to a vertical spine tab (🔭 + glyph + vertical clock) | Spine converts to a bottom drag-handle | Maximizes the sky; spine is more icon than label, and doesn't carry to mobile (converges to a bottom handle). |

## Captures
- `shots/montage-desktop.png` — 3 directions × 3 states, 1440×900
- `shots/montage-mobile.png` — 3 directions × 3 states, 390×844 (real bottom-sheet)
- `shots/montage-min.png` — tight crops of the three minimized forms (the decision)
- `shots/{A,B,C}-{desktop,mobile}-{picker,open,min}.png` — individual frames

Re-capture: `node _shoot-mocks.mjs` then `node _crop-min.mjs`.

## Research takeaways (deep-research pass)
**Well-supported (crux + mobile):**
- Avoid the collapsed dead-end with **contextual auto-restore** (Figma UI3 reopens the
  properties panel when you select an object) **+ a labeled control + a keyboard shortcut**.
- Mobile: use a **standard non-modal bottom sheet** so the scene stays interactive —
  three states: collapsed *peek* / expanded / hidden; restore by tap or swipe.
- **Never rely on the grab handle alone** (easy to ignore); pair it with a **labeled pill —
  a label beats a bare icon.**
- Double-**tap** is a poor touch gesture (long-tap is far more discoverable), which backs
  replacing the double-click express with an explicit **Land** button on touch.

**Unverified (API rate-limiting killed the verification votes — treat as directional, not sourced):**
the consolidated picker + contextual action-bar specifics, progressive-disclosure claims,
and glassmorphism legibility/blur guidance. Worth a re-research pass before leaning on them.

## Recommendation
**B · Header Rail** as the primary, **A · Living Chip** a close second.

B fits the research best: collapsing to a labeled title bar keeps context (which body,
phase, time) visible while minimized — so an "Orbit" (minimized) arrival is a glanceable
resting state, not a dead-end — and the same rail becomes the mobile peek handle, so desktop
and phone share one mental model. A is nearly as strong and frees a touch more sky.
C maximizes sky but its spine is the least labeled (weaker discoverability) and doesn't
survive to mobile as a spine.

Regardless of direction, add: contextual auto-restore (peek the panel on land / on event
jump), a keyboard toggle, and keep the restore affordance labeled.

## Open decisions (not blocking the visual pick)
- **Double-click target:** these mockups assume double-click on the **picker row**. The
  "double-click the planet in 3D" variant is a bigger raycasting job — deferred.
- **Naming:** "Orbit" (land minimized) vs "Land" (land open) — labels TBD.
