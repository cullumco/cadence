---
name: new-signal
description: Add a new signal or provider to Cadence end-to-end. Use when adding any new input (calendar, typing tempo, focused app, weather-like opt-ins) or extending an existing provider with a new probe.
---

# Add a signal to Cadence

Every signal touches the same seven places. Skipping one leaves the signal
invisible somewhere — the Focus signal shipped in exactly this order.

## The touchpoint checklist

1. **Type** — `src/types.ts`: add the field to an existing signal interface
   or a new `XSignal` + add to the `Signal` union.
2. **Provider** — `src/providers/`: collector that ALWAYS resolves
   (`null`/`undefined` on any failure, never throws). macOS-only probes gate
   on `process.platform === "darwin"` and degrade silently elsewhere.
   Per-probe timeouts must fit the 1500ms hook budget (existing probes use
   500–900ms). Local file reads need no timeout.
3. **Dial mapping** — `src/cadence.ts` `deriveCadence()`: decide
   flavor-only vs nudge. **Default flavor-only, ship-and-observe** — add the
   candidate nudge as a comment in the dormant-nudge block. If enabling a
   nudge, placement = authority: apply BEFORE self-report so the user's word
   wins. One signal should usually move ONE dial.
4. **Render** — `src/inject.ts`: add to the right render function.
   Threshold-gate noisy values (only-shows-on, only ≥N) like
   battery/uptime/displays.
5. **Legibility** — `src/signals-view.ts`: a row that NEVER vanishes —
   show the live value, or the exact reason it's absent: `— macOS only`,
   `— off (run: ...)`, `— unavailable (needs <permission>)`, or the value
   plus `(hidden: <threshold>)`. The hidden-note must mirror the inject.ts
   threshold (drift risk is called out in the file header).
6. **Tests** — `test/cadence.test.js` (imports from `dist/` — build first):
   - dial test via `deriveCadence` (or "renders but does NOT move dials")
   - hierarchy test if it nudges (self-report must outrank it)
   - signals-table row test incl. the absent/hidden annotations
   - extract pure functions (pass `now`/`platform` in) so logic is
     fixture-testable; darwin-only smoke tests use
     `{ skip: process.platform !== "darwin" ? "macOS-only" : false }`
7. **Docs** — README signals list + roadmap section, BACKLOG entry
   (mark shipped, note remaining gaps), CLAUDE.md only if conventions
   changed.

## Conventions that bind

- No new network deps without a strong case; keyless + AbortController
  timeouts + opt-in for anything location-ish. No silent geolocation.
- Tri-state honestly: `false` = observed-off, `undefined` = couldn't look.
  Only collapse error→off when the error IS the off-state (dark mode), never
  when it's a permission failure (Focus).
- Run `node bin/cadence signals` and `node bin/cadence test` at the end to
  see the signal live.
