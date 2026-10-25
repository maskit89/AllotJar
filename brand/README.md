# AllotJar — Brand & Logo Assets

The AllotJar mark is a **glass jar of euro coins with a screw-band lid** — a literal picture of the product: allot every euro into a jar. "Every euro has a job."

The single source of truth for the design is **`AllotJar Logo v6.dc.html`** (open it in the editor to see the full system, clearspace, and on-dark/scale behaviour). This folder contains the production-ready exports.

---

## 1. Asset index

All vector files live in `brand/`. Pre-rendered raster files live in `brand/png/`.

| File | What it is | Use it for |
|---|---|---|
| `allotjar-mark.svg` | **Primary mark** — full-detail realistic jar: stacked coins, glass sheen, metallic lid, euro coin dropping through the slot, cast shadow. | Hero / marketing / splash / large feature moments (≥ 96 px tall). The "showpiece" logo. |
| `allotjar-mark-flat.svg` | **Flat mark** — green jar, gold fill, gold lid. No coins/shadow. | Default UI mark wherever the realistic one is too busy or too small (24–96 px): nav, headers, cards. |
| `allotjar-mark-mono.svg` | **Monochrome** silhouette. Uses `currentColor` (defaults to ink). | One-colour contexts: print, embossing, watermarks, disabled/ghost states. Recolour by setting CSS `color`. |
| `allotjar-mark-reversed.svg` | **Reversed** — cream jar + gold, for dark/coloured backgrounds. | Any time the mark sits on a dark or saturated surface. |
| `allotjar-app-icon.svg` | **App icon** — the app's glass jar (gold screw lid, wavy gold fill, as on the Dashboard's jar shelf) on the hero card's green, as a squircle (160×160). Raster sizes are made by `client/scripts/make-pwa-icons.mjs`. | iOS/Android/desktop app icon, store listings, the share image's jar (`client/scripts/make-og-image.mjs`). |
| `allotjar-favicon.svg` | **Favicon** — the app icon's glass jar, bigger on a tighter tile with bolder lines and no lid ridges, so it reads at 16 px. PNGs are made by `client/scripts/make-pwa-icons.mjs`. | Browser tab icon (`<link rel="icon">`), the share image's brand row. |
| `allotjar-lockup.svg` | **Horizontal lockup** — flat mark + "AllotJar" wordmark ("Jar" in green). | Light backgrounds: site header, email signature, docs, footers. |
| `allotjar-lockup-reversed.svg` | Lockup for **dark** backgrounds. | Dark site header, dark email, video end-cards. |
| `brand/png/*` | Raster renders of the above at common sizes (app icon 1024/512/192/180, favicon 32/16, mark 512, flat 256). | Anywhere SVG isn't accepted: app stores, social, OG images, Slack, etc. |
| `brand/png/allotjar-app-icon-maskable-512.png` / `-180.png` | The app icon with the tile's corners squared off (made by `client/scripts/make-pwa-icons.mjs` from `allotjar-app-icon.svg`). The jar already sits inside the central safe zone. | Platforms that cut their own shape: Android's maskable icon (web app manifest) and the iPhone home screen (`apple-touch-icon`). |

> The wordmark in the lockup SVGs is **live text** set in Hanken Grotesk. It renders correctly only where that font is available. For a portable, pixel-exact wordmark, **convert the text to outlines** in your vector tool before shipping (or use a PNG export).

---

## 2. Choosing a mark

- **Is it on a dark or coloured background?** → `-reversed` (or the app icon / realistic, which carry their own background).
- **Is it ≥ 96 px and a feature moment?** → `allotjar-mark.svg` (realistic).
- **Is it 24–96 px UI chrome?** → `allotjar-mark-flat.svg`.
- **Is it ≤ 24 px (favicon, dense lists)?** → `allotjar-favicon.svg` (or the 16/32 PNG).
- **One ink colour only?** → `allotjar-mark-mono.svg`.
- **Need the name with it?** → a lockup.

Rule of thumb: **realistic for showpieces, flat for the product, mono for constraints.** Don't shrink the realistic mark below ~96 px — the coins turn to mud; switch to flat.

---

## 3. Colour tokens

| Token | Hex | Role |
|---|---|---|
| Jar Green | `#1C6B49` | Primary brand colour, jar body, accents. |
| Green (deep) | `#15533A` | Gradient shadow end / hero gradients. |
| Green (light) | `#2C8059` | Gradient highlight end. |
| Lid / Coin Gold | `#D7A93E` | Lid, coins, the "money" accent. |
| Gold (deep) | `#9C7421` | Coin shadow / gradient end. |
| Ink | `#15201B` | Text, monochrome mark on light. |
| Paper | `#F4F6F3` | App background (light). |
| Cream | `#FBF7EE` | Reversed jar body. |

In-app dark mode shifts green to `#5FC093` and gold to `#E8C36A` (see §6).

---

## 4. Typography

- **Typeface:** Hanken Grotesk (Google Fonts).
- **Wordmark:** weight **800**, letter-spacing **−3.5%** (`-0.035em`). Cased "AllotJar" — capital A and J, one word.
- **Colour:** ink (`#15201B`) for "Allot", Jar Green (`#1C6B49`) for "Jar". On dark, paper + `#5FC093`.
- Tagline (optional, never inside the lockup): "Every euro has a job." — Hanken Grotesk 600, muted.

---

## 5. Clearspace & minimum sizes

- **Clearspace:** keep padding ≥ the height of the lid band on all sides of the mark (≈ ¼ of the jar height). For the lockup, use the mark's lid-height as the margin unit.
- **Minimum sizes:** realistic mark **96 px**; flat mark **20 px**; favicon **16 px**; lockup **120 px** wide.

### Don'ts
- Don't recolour the jar outside the tokens above (no rainbow jars).
- Don't rotate, skew, add drop-shadows/outer glows, or re-tilt the drop coin.
- Don't use the realistic mark on a busy photo — use flat/reversed on a solid swatch.
- Don't typeset the wordmark in another font, lowercase it, or letter-space it loosely.
- Don't stretch — scale uniformly.

---

## 6. In-app usage (theme-aware)

Inside the AllotJar app the mark is drawn as **inline SVG that reads the theme CSS variables**, so it follows light/dark and the green/blue tone switcher automatically. This is what ships in `SideNav.dc.html` and `AllotJar Auth.dc.html`:

```html
<svg width="30" height="39" viewBox="0 0 64 84" fill="none" style="flex-shrink:0">
  <path d="M17 19L17 25C17 30 9 31 9 39L9 66A13 13 0 0 0 22 79L42 79A13 13 0 0 0 55 66L55 39C55 31 47 30 47 25L47 19Z" fill="var(--accent)"/>
  <path d="M9 48Q32 45 55 48L55 66A13 13 0 0 1 42 79L22 79A13 13 0 0 1 9 66Z" fill="var(--gold)"/>
  <rect x="13" y="14.5" width="38" height="5" rx="2.5" fill="var(--gold)"/>
  <rect x="15" y="3.5" width="34" height="12.5" rx="3.5" fill="var(--gold)"/>
  <rect x="16.5" y="4.8" width="31" height="2.6" rx="1.3" fill="#ffffff" opacity=".28"/>
</svg>
```

Variable mapping: `--accent` = jar body, `--gold` = lid + fill. Provide both (light: `--accent:#1F6B4D; --gold:#D7A93E` / dark: `--accent:#5FC093; --gold:#E8C36A`). Use the **standalone** files in `brand/` only where you can't inject theme variables.

---

## 7. Install snippets

**Favicon**
```html
<link rel="icon" type="image/svg+xml" href="/brand/allotjar-favicon.svg?v=2">
<link rel="icon" type="image/png" sizes="32x32" href="/brand/png/allotjar-favicon-32.png?v=2">
```

**Apple touch icon**
```html
<link rel="apple-touch-icon" sizes="180x180" href="/brand/png/allotjar-app-icon-maskable-180.png?v=2">
```

App stores: upload `allotjar-app-icon-1024.png`. (iOS applies its own corner mask — the squircle in the SVG matches the iOS radius, so it also looks right ungated.)

---

## 8. Regenerating

PNGs are rendered from the SVGs. To re-export at other sizes, render each SVG to a canvas at the target dimensions and save as PNG (the SVGs are resolution-independent — scale freely). Keep the realistic mark's aspect ratio **64 : 101** (it includes the drop coin above and the cast shadow below); all other marks are **64 : 84**.

---

## 9. For Claude Code

- **Source of truth:** `AllotJar Logo v6.dc.html`. Earlier `v1`–`v5` are the iteration history — ignore unless asked.
- **Geometry:** every jar shares one body path (`M17 19 … Z`, viewBox `0 0 64 84`). The flat gold fill is a clip-free path (`M9 48 … Z`) so it needs no `<clipPath>`. Reuse these verbatim — don't redraw.
- **In-product:** prefer the theme-aware inline SVG (§6), not the standalone files, so dark mode + tone switching keep working. The standalone `brand/` files use fixed brand colours.
- **Sizing logic:** realistic ≥ 96 px, flat 20–96 px, favicon ≤ 24 px. Pick the asset by size, don't scale the realistic one down.
- **Wordmark:** Hanken Grotesk 800, `-0.035em`, "AllotJar", "Jar" in `--accent`. Outline the text for any non-web export.
- **Don't invent colours** — use the tokens in §3. New harmonious shades, if ever needed, should hold the same chroma/lightness and only shift hue.
