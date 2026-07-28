# Simplify Parent-Brand Attribution Design

## Goal

Show that Simplify is the company behind Hong Kong Buddy in the same quiet,
parent-brand manner as “WhatsApp from Meta,” while keeping Hong Kong Buddy and
the daily Cantonese practice task as the primary product identity.

## Approved Direction

Use a persistent footer attribution and a fuller About-dialog attribution:

- Footer: a compact `from` label followed by the supplied Simplify wordmark.
- About: a short, localized statement that Hong Kong Buddy is a Simplify
  product, paired with the same wordmark.
- Header and Today content: unchanged. They remain dedicated to product
  identity, navigation, language, system status, and the main learning action.

The user delegated the final placement decision and authorized direct
implementation and Azure redeployment on 2026-07-28.

## Considered Approaches

### 1. Header co-branding

This gives Simplify the highest persistent visibility, but the header already
contains product identity, support links, language selection, and runtime
status. A second brand there would compete with the product name and increase
mobile wrapping risk.

### 2. Footer attribution plus About detail — selected

This establishes company ownership on every view without interrupting the
learning workflow. The About dialog provides the explicit relationship for
users who want context. This most closely matches the intended understated
“from Meta” pattern.

### 3. Today-view co-branding

This gives the company mark strong first-view exposure, but it inserts company
promotion into the product’s primary learning task and weakens the Cantonese
habit hierarchy.

## Components and Assets

### Brand asset

- Copy the supplied `simplify-wordmark.svg` into
  `frontend/assets/brand/simplify-wordmark.svg` without modifying its paths,
  colors, view box, title, or description.
- Extend the existing frontend-to-public sync manifest so the SVG is copied to
  `backend/public/assets/brand/simplify-wordmark.svg` for deployment.

### Footer attribution

- Keep the existing Hong Kong Buddy footer sentence and footer links.
- Add a separate attribution lockup containing `from` and the Simplify SVG.
- Use the SVG’s natural black color, a restrained visual height, and existing
  muted footer typography.
- On narrow screens, allow the footer content to stack without clipping or
  reducing the wordmark below a readable size.

### About attribution

- Add a localized ownership sentence beneath the existing About mission cards.
- Pair it with the same SVG asset; do not duplicate or redraw the logo.
- Keep the attribution visually secondary to the About title and product
  explanation.

## Accessibility

- The logo image uses `alt="Simplify"`; together with the adjacent visible
  `from` label, assistive technology reads the relationship as “from Simplify.”
- The About sentence provides a complete textual ownership statement in
  Traditional Chinese, Simplified Chinese, and English.
- The attribution retains adequate contrast and does not introduce a link or
  control without a destination.

## Data Flow and Failure Behavior

This is a static presentation change. It does not alter application state, API
requests, analytics, authentication, or provider behavior.

If the SVG cannot load, the image alt text still exposes the Simplify name and
the layout must remain stable. The deployment sync check must fail closed if the
frontend and `backend/public` copies differ or the asset is absent.

## Testing and Verification

1. Add a focused static brand-attribution contract test before implementation.
2. Confirm it fails because the asset and attribution markup are absent.
3. Implement the smallest HTML, CSS, i18n, and sync-manifest changes.
4. Sync `frontend` to `backend/public` and confirm parity.
5. Run the focused contract plus the V2 shell and full UI regression suite.
6. Run the app locally and inspect desktop and mobile layouts in a browser.
7. Deploy the verified `backend` package to the existing Azure Web App.
8. Verify the live asset, rendered attribution, `/api/health`, and application
   version/provider fields after deployment.

## Deployment Boundary

The repository’s `frontend` directory remains the source of truth, while
`backend/public` is the static copy served by Azure. Deployment must include the
synced public asset. A successful deploy does not waive the live smoke checks.

## Out of Scope

- Renaming Hong Kong Buddy.
- Replacing its HK logo or favicon.
- Adding a Simplify link without a confirmed destination.
- Changing the main navigation, daily practice flow, translation flow, or API.
- Reworking the broader visual system.

## Acceptance Criteria

- Every app view ends with a readable `from Simplify` footer attribution.
- The About dialog explicitly identifies Hong Kong Buddy as a Simplify product.
- The supplied SVG is used unchanged and is present in both source and deployed
  public asset trees.
- Desktop and mobile layouts remain unclipped and preserve the current product
  hierarchy.
- Focused and regression tests pass.
- The Azure site serves the updated HTML, CSS, logo asset, and healthy API.
