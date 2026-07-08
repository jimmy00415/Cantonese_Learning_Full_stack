---
name: awesome-design-md
description: Use when a UI/UX task needs a concrete visual design reference, DESIGN.md brand language, design tokens, component styling rules, layout principles, or an aesthetic direction selected from the VoltAgent awesome-design-md collection.
---

# Awesome DESIGN.md

## Overview

Use this project-local skill to choose and apply a `DESIGN.md` reference from the VoltAgent `awesome-design-md` collection. Treat these files as visual-language references for UI generation, not as permission to copy a brand, logo, trademark, or exact product surface.

## Resources

- Design files: `references/design-md/<slug>/DESIGN.md`
- Upstream README: `references/UPSTREAM_README.md`
- Upstream license: `references/LICENSE`
- Project index: `references/PROJECT_INDEX.md`

## Workflow

1. Read `references/PROJECT_INDEX.md` first.
2. Pick one primary reference and, only when useful, one secondary reference.
3. Read the selected `references/design-md/<slug>/DESIGN.md` before editing UI.
4. Extract usable rules: palette roles, typography scale, spacing, component states, layout density, motion, and anti-patterns.
5. Adapt the rules to Hong Kong Buddy's product: Cantonese learning habit first, daily-life translation second.
6. Preserve existing product constraints: visit translation clarity, readable bilingual text, accessible contrast, no component overlap, no hidden safety or AI confirmation messages.
7. Do not add brand assets, trademarks, logos, or copy that impersonates the referenced brand.
8. Verify the result with local UI checks, regression tests, and at least one responsive/browser or DOM check when the app is running.

## Hong Kong Buddy Starting Points

- `intercom`: best first pick for conversation, support, chat, and live-assistance surfaces.
- `apple`: use for calm, premium, high-whitespace learning flows.
- `notion`: use for structured learning notes, phrasebook, and lightweight knowledge surfaces.
- `minimax`: use sparingly for AI-provider or model-quality surfaces; avoid making the main student workflow too dark or neon.
- `linear.app`: use for compact operational dashboards, admin views, and status-heavy tools.
- `airbnb`: use for warm, human, community-visit screens where trust and approachability matter.

For the current product, prefer `intercom` plus restrained `apple` or `notion` cues before reaching for cinematic dark references.

## Invocation Examples

- "Use `design-skills/awesome-design-md` with the `intercom` reference to redesign the visit translation console."
- "Use `design-skills/awesome-design-md/references/design-md/apple/DESIGN.md` as a visual reference, but preserve Hong Kong Buddy's existing controls."
- "Audit the current UI against `intercom` and `notion`; report only actionable mismatches."
- "Before building this new page, choose the most suitable `DESIGN.md` reference from the local awesome-design-md collection and explain the choice."

## Root DESIGN.md Policy

Do not overwrite or create the project root `DESIGN.md` unless the user explicitly asks to make one reference the project's durable design contract. For one-off redesigns, read the selected reference in place.
