# THE BOOK — Accessibility

Current state (slice) and commitments.

## In place

- **Keyboard**: every interactive control is a real `<button>`, `<input>`, or
  `<select>` — natively focusable and activatable; `:focus-visible` outlines on all
  controls (2px crimson, offset).
- **Reduced motion**: `prefers-reduced-motion: reduce` disables all transitions and
  animations globally (theme.css).
- **Contrast**: ink-on-paper palette (#171410 on #f5f2ea ≈ 15:1); semantic
  green/crimson signals are paired with words or arrows, never color-only (▲/▼ in the
  ledger, signed numbers, labels).
- **Structure**: semantic tables for data, one `<h1>` per screen, labeled nav
  (`aria-label`), tooltips carried in `title` attributes describing game mechanics.
- **Layout**: 1440×900 target, usable at 1366×768 (booker collapses gracefully),
  no horizontal scroll at target sizes.

## Known gaps (tracked for Phase 6)

- No skip-to-content link; screen-reader landmarks are minimal (nav/main only).
- Drag-and-drop has a full keyboard/click equivalent (click-to-assign), but the drag
  affordance itself is not announced to assistive tech.
- No in-app UI scale control yet (browser zoom works; layouts hold to 125%).
- Meters convey value numerically alongside the bar (good), but confidence badges rely
  on small type — needs a size pass.
- Live Show reveal is click-driven (no auto-advance), which is the accessible default,
  but there is no ARIA live region announcing new segments yet.
