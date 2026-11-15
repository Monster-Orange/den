# den-ui

The UI kit Den is built from: design tokens, self-hosted fonts and, over
time, the components more than one product needs. It is framework-free:
plain CSS custom properties, ES modules and custom elements, with no build
step at runtime.

It lives in Den's repository as a workspace package and ships inside Den.
Another product consumes it by pinning an exact version and bundling its
own copy, so a page never mixes two versions.

## What's in it

- `src/tokens.css`: colour (light and dark), type, radius, shadow,
  spacing, motion, layers and touch targets, as CSS custom properties.
  Light is the default. `data-mode="light"` or `"dark"` on `<html>` picks a
  mode; with none set, the kit follows `prefers-color-scheme`. Every rule
  has zero specificity (`:where()`), so a theme laid on top always wins.
- `src/fonts.css`: Rubik (400, 500) and Space Mono (400), latin and
  latin-ext, as woff2, `font-display: swap`. Nothing is fetched from a
  third party. Japanese uses the system's fonts.
- `src/base.css`: one reduced-motion rule (every duration token goes to 0) and Japanese line breaking.

## Themes

A theme may override every colour in both modes, the shadow, the bar,
type, radius, radius-button, density and fonts. It never overrides
spacing, motion or layers, so layouts stay the same.

## Rules

- Components use tokens only: a test fails on a raw colour outside
  `tokens.css`.
- Every text and background pair passes WCAG AA in both modes (4.5:1 for
  text, 3:1 for marks); status pills are checked on their own tint.
- The fonts stay within 120 KB.

## Licence

MIT (`LICENSE`). The fonts are under the SIL Open Font License 1.1
(`src/fonts/OFL.txt`).
