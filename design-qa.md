# Production V1 design QA

## Compared state

- Viewport: 390 x 844 CSS pixels.
- Target: `C:\Users\陈奕炜\.codex\generated_images\019fa730-c793-78c0-89a4-9c374395c375\exec-e4119547-131e-4b15-b7ec-052d0091aadc.png`.
- Prototype conversation: `C:\Users\陈奕炜\.codex\visualizations\2026\07\28\019fa730-c793-78c0-89a4-9c374395c375\task6a-readonly-audit\01-conversation-390x844.png`.
- Prototype information sheet: `C:\Users\陈奕炜\.codex\visualizations\2026\07\28\019fa730-c793-78c0-89a4-9c374395c375\task6a-readonly-audit\02-about-sheet-390x844.png`.
- Prototype editable draft: `C:\Users\陈奕炜\.codex\visualizations\2026\07\28\019fa730-c793-78c0-89a4-9c374395c375\task6a-readonly-audit\03-composer-draft-390x844.png`.
- Side-by-side comparison: `production-v1/reports/preview/design-comparison.png`.

## Visible acceptance

- PASS: one-conversation mobile hierarchy; no legacy mode or scenario controls.
- PASS: assistant identity remains visible through the header and message avatar.
- PASS: assistant and student messages have distinct, readable alignment and contrast.
- PASS: official-source cards stay attached to the answer they support.
- PASS: the composer, voice control, and Send action remain together at the bottom.
- PASS: the editable voice transcript uses the same composer instead of creating a call screen.
- PASS: the About sheet clearly says this is an AI guide, exposes privacy/grounding boundaries, and keeps destructive clear-session action separate.
- PASS: Simplify attribution is restrained and present in both the composer and information sheet.
- PASS: 44 px minimum interactive targets, keyboard focus treatment, safe-area padding, and reduced-motion rules are implemented in the stylesheet.

Intentional differences from the visual target: the implementation uses a text-labelled `About` control instead of an unlabeled information glyph; real source cards show publisher and verification state; and long conversations scroll behind a fixed composer. These improve clarity without changing the selected visual direction.

## Current runtime verification

- `GET /`, liveness, CSS, JavaScript, avatar, and Simplify assets returned successfully from the isolated preview.
- LAN-origin anonymous session bootstrap returned 201 with text, ASR-preview, and TTS-preview capabilities configured; no provider call was made for this check.
- The latest automated Chrome recapture could not be started because the local browser-control kernel failed before executing browser code. The saved 390 x 844 screenshots cover the committed UI tranche, which has not changed since capture; current HTTP behavior was rechecked separately.
- No old application deployment or configuration was changed.
