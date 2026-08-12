# Stride brand assets

The finalised logo, shared by both apps — the personal tracker at the repo root
and the self-service app in `../self-service/`. Both reference the same files,
so the logo only ever needs changing in one place.

## The mark — "The Stride S"

An S traced as a single continuous route line: one open-ended stroke, round
caps, no letterform construction. Geometric and abstract rather than a literal
runner, so it works as a standalone mark at any size.

The whole thing is one SVG path. If you ever need to reproduce it by hand:

```
d           M34 16 A 9.5 9.5 0 1 0 24 24 A 9.5 9.5 0 1 1 14 32
viewBox     0 0 48 48
stroke      #6f9ff2      (--blue, from the existing palette)
width       4.6
linecap     round
```

The stroke weight is deliberate: 4.6 is the point where the mark still reads at
16px without the counters closing up. Thinner loses the shape in a favicon,
heavier fills it in. Don't change it without checking at 16px.

Its visual bounds are 24.83 × 42.56 within the 48-unit box, centred on (24, 24)
— taller than it looks, because the arcs sweep well past their endpoints. That
matters when placing it: centre on (24, 24) and scale from the height.

## Files

| File | What it's for |
| --- | --- |
| `stride-mark.svg` | The mark alone, transparent. Reference copy — in the apps it's inlined so it can inherit size and colour. |
| `stride-icon.svg` | The mark on the dark navy tile, rounded corners. Source for the app icons and the favicon. |
| `stride-icon-maskable.svg` | Full-bleed background, smaller mark. For Android adaptive icons, where the OS applies its own shape. |
| `stride-lockup.svg` | Horizontal lockup: mark, spaced wordmark, tagline. |

The rasterised icons live in `../icons/` and are generated from these:
`icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`,
`favicon-32.png`, `favicon.svg`.

## The wordmark

`STRIDE`, uppercase, Manrope 800, `letter-spacing: 0.34em`. Spacing that wide
leaves a trailing gap after the final E with nothing to balance it before the S,
so anywhere the wordmark sits next to something else it carries
`margin-right: -0.34em` to stay optically centred.

0.34em was chosen against tighter and wider settings: below it the spacing stops
reading as deliberate, above it the word starts to come apart.

## The tagline

**Train · Adapt · Go Further.** Used only where a tagline earns its place — the
self-service app's signed-out landing page, and `stride-lockup.svg`. It is
deliberately absent from in-app headers and from the personal app's unlock
screen: those are daily-use surfaces, where it would be clutter.

## Colour

No new colours. Everything comes from the palette already in use:

| Token | Value | Used for |
| --- | --- | --- |
| `--blue` | `#6f9ff2` | the mark |
| tile gradient | `#1a2740` → `#0b1322` | icon background |
| `--heading` | `#f5f7fb` | wordmark |
| `--muted` | `#7c879c` | tagline |

The icon uses the darker navy tile rather than a lighter blue: more contrast at
small sizes, and it sits properly on the app's dark theme.

## Regenerating the icons

The PNGs are built from the SVGs by a script kept outside the repo (it renders
each SVG in headless Chromium and screenshots it at the required sizes). If the
mark ever changes, the icons need rebuilding from it — editing a PNG directly
will drift from the source.

Two things to remember when doing so:

- Bump `CACHE` in both `../sw.js` and `../self-service/sw.js`. The filenames stay
  the same, so without a bump anyone who has either app installed keeps the old
  icons from their cache.
- Check the result at 16px, not just at 512px.
