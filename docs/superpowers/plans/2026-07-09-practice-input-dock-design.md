# Practice Input Dock Design Fix

> Superpowers plan: execute in small checkpoints and verify before claiming complete.

## Goal

Fix the broken bottom Practice input dock shown in the screenshot, then align the control surface with the provided Together.ai `DESIGN.md` language without impersonating that brand.

## Root Cause

The dock currently lays recording, timer, text input, voice select, speed slider, replay, correction, and send controls into one dense row. Long recording labels and the audio-control minimum widths push the right-side controls offscreen.

## Design Rules

- Use explicit grid areas instead of implicit flex/grid placement.
- Keep primary action black with restrained 4px radius.
- Use hairline borders and compact mono labels for technical controls.
- Keep the voice/timer state compact; do not let recording text resize the whole dock.
- Collapse before controls become cramped.

## Tasks

- [x] Add a stable `voice / input / send` row and separate `timer / audio` row.
- [x] Shorten recording and processing labels through i18n.
- [x] Add static regression checks for the dock contract.
- [x] Sync frontend to `backend/public`.
- [ ] Run regressions, browser smoke, then deploy to Azure if clean.
