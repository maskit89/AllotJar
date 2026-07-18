# Staging + production environments

This describes the two-environment topology (IP-allowlisted **staging** + public
**production**), the single release pipeline that feeds both, and the runbook that
took us here at the 2026-07 GA cutover. For the base IIS/SQL deploy mechanics, see
[`README.md`](./README.md).

> History: before 2026-07 the single stack was the public "beta" at
> `app.allotjar.com` and `www`/apex served a Cloudflare-Worker coming-soon page
> (PR #121). At the cutover the beta stack was relabelled **staging** (keeping its
> data), a clean **production** stack was provisioned next to it, and the
> coming-soon Worker was retired. The old `app.allotjar.com` hostname is gone.

## The model

```
Cloudflare zone ──┬─ allotjar.com + www ──►  VPS IIS site 'ZeroBudget-Prod'  ─► API :5001 ─► SQL 'ZeroBudgetProd'
(allotjar.com)    │                          = PRODUCTION (public)
                  └─ staging.allotjar.com ─► VPS IIS site 'ZeroBudget'       ─► API :5000 ─► SQL 'ZeroBudget'
                       ▲                     = STAGING (the old beta stack + its data)
                       │
                WAF custom rule 'staging-ip-allowlist':
                block staging.allotjar.com unless ip.src is allowlisted

  merge to main ──► deploy.yml: build+deploy STAGING (auto)
                                └► deploy PRODUCTION (pauses for approval in the Actions UI)
```

- **Staging** = the original VPS stack **with its historical data**. Only
  allowlisted IPs get through Cloudflare; everyone else is blocked at the edge.
  The bundle is built with `VITE_APP_ENV=staging` (amber banner + data-loss signup
  consent) and **no GA measurement ID** (analytics inert).
- **Production** = the clean stack provisioned at cutover (own IIS sites/pools, API
  on `127.0.0.1:5001`, own database `ZeroBudgetProd`, own `appsettings.Production.json`
  with a fresh JWT signing key). Public at `allotjar.com`/`www`. Accounts do NOT
  carry over from staging — production started empty.
- **One pipeline** (`.github/workflows/deploy.yml`): every merge to `main` deploys
  staging automatically, then the production job waits on the `production`
  environment's required reviewer. Approving it ships the same commit to prod.
  Unapproved production jobs are superseded by newer runs (job-level concurrency
  group `production-deploy`), so approving always deploys the newest `main`.

## What's in the repo

| Piece | Where |
|---|---|
| Release pipeline (staging auto + prod approval) | `.github/workflows/deploy.yml` |
| Prod stack provisioning (manual, reviewer-gated) | `.github/workflows/provision-production.yml` + `deploy/Provision-Production.ps1` |
| Cloudflare DNS/WAF automation | `deploy/Setup-Cloudflare.ps1` |
| Server-side deploy (parametrised per stack) | `deploy/Deploy.ps1` (`-ApiProxyPort` patches the ARR port) |
| Staging banner + signup consent | `client/src/components/StagingBanner.tsx`, `client/src/lib/env.ts`, `LoginPage.tsx` |
| Daily DB backups (both databases) | `deploy/Backup-Database.ps1` + `deploy/Register-BackupTask.ps1` (tasks `ZeroBudget-DbBackup`, `ZeroBudget-Prod-DbBackup`) |
| Retired coming-soon page (archived source) | `marketing/coming-soon/` |

## Outbound email (password reset)

The API sends transactional email (today: password-reset links) through **Resend** when
`Email:ApiKey` is configured; without a key it logs instead of sending (fine for staging — the
reset flow is then effectively disabled there, which the IP-allowlisted audience can live with).

One-time production setup:

1. Create a Resend account and **verify the `allotjar.com` domain** (Resend dashboard → Domains →
   add the DKIM/SPF DNS records it lists into Cloudflare; verification is required before any
   send from `no-reply@allotjar.com`).
2. Create an API key and add to the server's `appsettings.Production.json` (preserved across
   deploys by `Deploy.ps1`'s robocopy exclude):
   `"Email": { "ApiKey": "…", "FromAddress": "AllotJar <no-reply@allotjar.com>", "AppBaseUrl": "https://www.allotjar.com" }`
3. Set `"DataProtection": { "KeysPath": "C:\\inetpub\\zerobudget-dp-keys" }` (create the folder,
   grant the API app-pool identity modify rights). **Without this, every app restart/deploy
   invalidates all outstanding reset links** — the IIS app pool doesn't load a user profile, so
   the DataProtection key ring is otherwise in-memory.
4. Smoke-test: request a reset from `https://www.allotjar.com/forgot-password` and follow the
   emailed link end-to-end.

`Email:AppBaseUrl` is deliberately config-only (never derived from request Host headers — a
spoofed header must not steer emailed links). Reset links are valid for 2 hours, single-use.

## Changing the staging IP allowlist

The allowlist lives in ONE place: the Cloudflare WAF custom rule
**`staging-ip-allowlist`** on the `allotjar.com` zone
(dash.cloudflare.com → the zone → Security → WAF → Custom rules). Its expression is

```
(http.host eq "staging.allotjar.com" and not ip.src in {<ip> <ip> ...})
```

with action **Block**. Edit the IP set in the dashboard, or re-run
`deploy/Setup-Cloudflare.ps1 -Phase staging -AllowedIps <ips...>` with a
zone-scoped API token (Zone→DNS Edit + Zone→Zone WAF Edit).

Note the origin firewall only admits Cloudflare's IP ranges, so the WAF rule can't
be bypassed by hitting the VPS directly.

## The cutover runbook (2026-07) — kept for reference / disaster recovery

1. **Merge the pipeline PR.** The next `main` build auto-deploys the
   staging-flagged bundle to the existing stack.
2. **Provision production**: Actions → *Provision production stack* → run (approve
   the gate). Idempotent; creates dirs/pools/sites/SNI-bindings/DB/settings/backup
   tasks. The prod API dir is empty until the first deploy.
3. **First production deploy**: approve the pending `deploy-production` job on the
   latest Deploy run (or re-run the workflow). Health check: `http://127.0.0.1:5001/health`
   on the VPS; EF migrations create the schema in `ZeroBudgetProd` on first start.
4. **Cloudflare — staging first** (never expose staging unfiltered):
   `deploy/Setup-Cloudflare.ps1 -ApiToken <t> -Phase staging` — creates the WAF
   allowlist rule, THEN the proxied `staging` A record.
5. **Cloudflare — retire the Worker**: dashboard → Workers & Pages →
   `allotjar-coming-soon` → Settings → Domains & Routes → remove `allotjar.com`
   and `www.allotjar.com` (needs account-scoped Workers perms, hence manual).
6. **Cloudflare — production**: `deploy/Setup-Cloudflare.ps1 -ApiToken <t> -Phase production`
   — proxied A records for apex + `www` → the origin, and deletes the `app` record.
7. **Trim staging bindings**: Actions → *Provision production stack* → run with
   `trim_staging_bindings=true`. Removes the catch-all/apex/www/app bindings from
   the staging site so each site answers exactly its own hostnames.
8. **Verify**: `www.allotjar.com` serves the app with no banner; `staging.allotjar.com`
   works from an allowlisted IP and is blocked elsewhere; `app.allotjar.com` no
   longer resolves; `Get-ScheduledTask ZeroBudget-DbBackup, ZeroBudget-Prod-DbBackup`
   both exist and run.

Rollback: the coming-soon Worker still exists (custom domains can be re-added in
the dashboard), and DNS records are plain proxied A records — re-point as needed.
The staging stack is untouched by all of this except for its extra hostname.
