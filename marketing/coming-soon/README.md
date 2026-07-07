# AllotJar — "coming soon" page

A self-contained static one-pager for the **public production URL** (`allotjar.com` +
`www.allotjar.com`) while the app itself runs as a beta at `app.allotjar.com`. No build
step, no framework — just `index.html`, `styles.css` and two assets.

## Files

| File | Purpose |
|---|---|
| `index.html` | The page. Inline brand mark + Hanken Grotesk wordmark, brand hero gradient. |
| `styles.css` | All styling (external so the CSP needs no `'unsafe-inline'`). |
| `favicon.svg` | Browser-tab icon (copied from `brand/`). |
| `og.png` | 1200×630 social-share image (copied from `client/public/og/`). |
| `_headers` | Cloudflare Pages security headers (CSP, X-Frame-Options, …). |
| `robots.txt` | Allows indexing of the coming-soon page. |

> The headline cycles a currency word ("give every euro / dollar / rupee … a job")
> as a CSS-only animation (the CSP forbids JS). Its word list is hardcoded in
> `index.html`; keep it in sync with `CURRENCY_NOUNS` in `client/src/lib/money.ts`
> (one entry per distinct noun, euro first) if the app's currency set changes.

## Before you deploy

- **Set the contact address.** `index.html` uses `mailto:hello@allotjar.com` in the CTA
  and footer. Point it at a mailbox/alias you actually read (e.g. `hello@allotjar.com`).
  To capture emails instead of a mailto, swap the `<a class="cta">` for a small form that
  posts to a Cloudflare Pages Function, Formspree, or similar — then loosen `form-action`
  in `_headers`.

## Deploy to Cloudflare Pages

1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** (this repo)
   — or **Direct Upload** of this folder.
2. Build settings (for the Git option): **Framework preset = None**, **Build command =
   _(blank)_**, **Build output directory = `marketing/coming-soon`**.
3. Deploy, then add custom domains **`allotjar.com`** and **`www.allotjar.com`** to the
   Pages project (Cloudflare wires the DNS automatically since the zone is already on CF).

> Switching the apex/www to Pages is what frees `app.allotjar.com` to point at the VPS app.
> See `docs/deployment/staging-prod.md` for the full topology and cutover order.
