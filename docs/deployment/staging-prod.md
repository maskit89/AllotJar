# Beta + production environments, and the GA cutover

This describes the split between a rolling **beta** environment and a manually
promoted **production** (GA) environment, the **coming-soon** page on the public URL,
and the one-time steps to wire it all up. For the base IIS/SQL deploy mechanics, see
[`README.md`](./README.md).

## The model

```
                         ┌─ allotjar.com + www ──►  Cloudflare Pages  ──►  "coming soon" one-pager
Cloudflare zone ─────────┤                          (marketing/coming-soon/)
(allotjar.com)           └─ app.allotjar.com  ──►  VPS IIS front site  ──►  API ──► SQL (the real data)
                            (proxied → 74.50.82.13)        = BETA

  merge to main ──► "Deploy to beta" workflow (auto) ─────────────► BETA  (app.allotjar.com)
                    "Promote to production" workflow (manual, ──►  PRODUCTION  (GA, provisioned at cutover)
                     reviewer-gated)
```

- **Beta** = the *existing* live VPS stack, **with its current data** (the family/friends
  testers). It is just given the `app.allotjar.com` hostname and a beta-flagged build
  (`VITE_APP_ENV=beta`) that shows the under-construction banner + a data-loss
  acknowledgment on signup. Every merge to `main` auto-deploys here.
- **Production** = a *future*, clean GA stack, stood up at cutover. Until then the public
  URL is the coming-soon page, so nothing app-shaped runs there yet. The
  **Promote to production** workflow is the manual, approval-gated path to it.
- Open signup is allowed on beta (anyone with the URL who accepts the beta terms); the
  URL is simply not advertised on the coming-soon page.

## What's already in the repo

| Piece | Where |
|---|---|
| Beta auto-deploy | `.github/workflows/deploy.yml` (builds `VITE_APP_ENV=beta`) |
| Manual prod promotion | `.github/workflows/promote-to-production.yml` (reviewer-gated) |
| Beta banner + signup consent | `client/src/components/BetaBanner.tsx`, `client/src/lib/env.ts`, `LoginPage.tsx` |
| Coming-soon page | `marketing/coming-soon/` (+ its own README) |

## One-time setup (do these to go live with beta + coming-soon)

### 1. GitHub environments
- Settings → Environments → create **`beta`** (no reviewers — auto-deploys).
- Create **`production`** and add yourself under **Required reviewers**. This is what
  makes *Promote to production* pause for a manual approval click.

### 2. Cloudflare — coming-soon page on apex + www
- Deploy `marketing/coming-soon/` to **Cloudflare Pages** (see that folder's README:
  output dir `marketing/coming-soon`, no build command).
- Add custom domains **`allotjar.com`** and **`www.allotjar.com`** to the Pages project.
  Cloudflare repoints their DNS to Pages automatically.

### 3. Cloudflare + IIS — beta on app.allotjar.com
- Cloudflare DNS: add an **A record `app` → `74.50.82.13`, Proxied (orange)**. Proxying
  keeps the existing CF-IP origin firewall valid and gives `app.*` edge TLS/HSTS.
- On the VPS, add `app.allotjar.com` host-header bindings to the existing front site
  (the same site that serves the app today), reusing the current origin cert. Mirror how
  the `allotjar.com` binding was set up; representative PowerShell:
  ```powershell
  Import-Module WebAdministration
  New-WebBinding -Name 'ZeroBudget' -Protocol http  -Port 80  -HostHeader 'app.allotjar.com'
  New-WebBinding -Name 'ZeroBudget' -Protocol https -Port 443 -HostHeader 'app.allotjar.com' -SslFlags 1
  # then assign the existing self-signed cert to the SNI binding (see the TLS notes in README/ops)
  ```
- The apex/www bindings on the VPS become inert (CF now serves those from Pages); leave
  or remove them.

> After this, merging to `main` ships the beta build to `app.allotjar.com`, and the public
> URL shows the coming-soon page. The next merge will show the beta banner on the app —
> expected.

## GA cutover checklist (when you're ready to launch publicly)

1. **Provision the production stack** on the VPS (mirrors README, parallel to beta):
   - IIS sites/dirs `C:\inetpub\zerobudget-prod\{api,web}`, app pools
     `ZeroBudget-Prod-Api` / `ZeroBudget-Prod-Web`, API bound on **127.0.0.1:5001**.
   - A **fresh SQL database** + its own `appsettings.Production.json` (server-only,
     gitignored — new JWT key, connection string). The deploy never touches the DB.
   - Grant the prod API app-pool identity access to the prod DB.
2. **Secrets**: add `PROD_VPS_HOST` / `PROD_VPS_SSH_USER` / `PROD_VPS_SSH_KEY` /
   `PROD_VPS_SSH_PORT` (mirror the beta `VPS_*` values if it's the same box).
3. **Promote**: Actions → *Promote to production* → Run workflow → approve the gate.
   It builds a GA-flagged SPA (no beta banner) and deploys to the prod stack.
4. **Smoke-test privately** against the prod stack before exposing it (it answers on
   `127.0.0.1:5001`; or add a temporary internal host binding).
5. **Flip DNS**: move `allotjar.com` + `www` off Cloudflare Pages and onto the prod app
   (proxied A → the VPS / prod site binding). Decide beta's fate: keep `app.allotjar.com`
   as an ongoing beta channel, or retire it.
6. Update `client/index.html` canonical/OG (already `www.allotjar.com`) and the
   `robots.txt`/`sitemap.xml` hosts as needed.
