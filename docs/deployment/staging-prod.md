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
                                └► PRODUCTION only on a hand-started run ("Also deploy to production")
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
  staging automatically and never touches production. To ship production, run the
  Deploy workflow by hand on `main` (Actions > Deploy > Run workflow) with **Also
  deploy to production** ticked: that run redeploys staging with the newest `main`,
  then deploys the same commit to production. Until 3 Oct 2026 the gate was the
  `production` environment's required reviewer; GitHub ignores environment
  protection rules on a private repo on the Free, Pro and Team plans, so it stopped
  applying when the repo went private. The production jobs first check that CI
  passed on main for that commit and stop if it failed or is still running. If a
  merge lands while the run waits for staging, the run shows as cancelled; start
  it again.

## What's in the repo

| Piece | Where |
|---|---|
| Release pipeline (staging auto + prod on a manual run) | `.github/workflows/deploy.yml` |
| Prod stack provisioning (manual run) | `.github/workflows/provision-production.yml` + `deploy/Provision-Production.ps1` |
| Cloudflare DNS/WAF automation | `deploy/Setup-Cloudflare.ps1` |
| Server-side deploy (parametrised per stack) | `deploy/Deploy.ps1` (`-ApiProxyPort` patches the ARR port) |
| Staging banner + signup consent | `client/src/components/StagingBanner.tsx`, `client/src/lib/env.ts`, `LoginPage.tsx` |
| Daily DB backups (both databases) | `deploy/Backup-Database.ps1` + `deploy/Register-BackupTask.ps1` (tasks `ZeroBudget-DbBackup`, `ZeroBudget-Prod-DbBackup`) |
| Retired coming-soon page (archived source) | `marketing/coming-soon/` |

## Outbound email (password reset)

The API sends transactional email (today: password-reset links) through a **configurable provider** —
**Cloudflare Email Service** or **Resend** — selected by `Email:Provider`. Without an `Email:ApiKey`
it logs instead of sending (fine for staging — the reset flow is then effectively disabled there,
which the IP-allowlisted audience can live with).

Provider is config, not code: switching (e.g. falling back off Cloudflare's beta) is an
`appsettings.Production.json` edit + an app-pool recycle, never a redeploy.

### One-time production setup

**1. Onboard the sending domain with your chosen provider.**

- *Cloudflare Email Service* (requires the domain to use Cloudflare DNS — `allotjar.com` already
  does): dashboard → Email → Email Sending → onboard `allotjar.com`, then add the MX/SPF/DKIM/DMARC
  records it lists. Create an API token with the **`Email Sending: Edit`** permission and note your
  **account id**. NOTE: Email Sending is in **public beta** — APIs may change before GA; that is the
  reason the Resend path is kept selectable.
- *Resend*: create the account, add `allotjar.com` under Domains, add the DKIM/SPF records it lists
  into Cloudflare DNS, wait for Verified, then create an API key.

Either way, verification must complete before any send from `no-reply@allotjar.com` is accepted.

**2. Put the provider config in the server's `appsettings.Production.json`** (preserved across
deploys by `Deploy.ps1`'s robocopy exclude):

```jsonc
// Cloudflare
"Email": {
  "Provider": "cloudflare",
  "ApiKey": "<API token with Email Sending: Edit>",
  "AccountId": "<32 hex characters>",       // required — the send endpoint is account-scoped
  "FromAddress": "AllotJar <no-reply@allotjar.com>",
  "AppBaseUrl": "https://www.allotjar.com"
}
// Resend — same block without AccountId, and "Provider": "resend" (or omit Provider entirely)
```

> **`AccountId` must be the FULL 32-character hex id** — from the dashboard URL
> (`https://dash.cloudflare.com/<account-id>/…`) or the account-home sidebar. Dashboards and docs
> often *display* it truncated with an ellipsis; pasting that (`49033e69c8021025…`) passes every
> not-empty check, so startup reports a healthy provider and then every send 404s with
> *"could not route … perhaps your object identifier is invalid?"* — off-request, so the user just
> never receives the email. Startup now warns when the id isn't 32 hex characters (see step 5).

**3. Set `"DataProtection": { "KeysPath": "C:\\inetpub\\zerobudget-dp-keys" }`** (create the folder,
grant the API app-pool identity modify rights). **Without this, every app restart/deploy invalidates
all outstanding reset links** — the IIS app pool doesn't load a user profile, so the DataProtection
key ring is otherwise in-memory. The ring is encrypted at rest with LocalMachine DPAPI.

**4. Recycle the API app pool.** The provider is chosen **once at startup** (see
`AddInfrastructure`), so editing the config file alone does not switch it over.

**5. Confirm it took, from the Windows Event Log.** Startup emits either
`Outbound email provider: CloudflareEmailSender` / `ResendEmailSender`, or
`Outbound email is NOT configured … : <reason>` naming the specific problem (missing `ApiKey`,
missing `AccountId`, or an unrecognised `Provider` — a typo like `"cloudfare"` says so). Both are
logged at **Warning** on purpose: the Console provider writes to ANCM stdout, which
`stdoutLogEnabled` leaves off and the deploy re-mirrors anyway, and the EventLog provider filters
out anything below Warning — an Information line would be invisible here. Check this before testing
by hand: an incomplete provider config deliberately degrades to log-only rather than taking the API
down, so it is otherwise silent.

A **second** line can follow even when a provider DID resolve:
`Outbound email configuration looks wrong: Email:AccountId does not look like a Cloudflare account
id (expected 32 hex characters, got N)`. Sending is live but every send will 404 until the full id
is in — fix it and recycle.

Note for Cloudflare: the sending identity is derived from `FromAddress`. A display-name value like
`AllotJar <no-reply@allotjar.com>` is split into Cloudflare's `{ address, name }` form
automatically — do NOT expect the raw RFC5322 string to be accepted by their API.

**6. Smoke-test:** request a reset from `https://www.allotjar.com/forgot-password` and follow the
emailed link end-to-end.

`Email:AppBaseUrl` is deliberately config-only (never derived from request Host headers — a
spoofed header must not steer emailed links). Reset links are valid for 2 hours, single-use.

Registration also sends a **"confirm your email"** message through the same provider (no extra
config), and re-uses the reset link as a **claim** email when someone registers an address that
already has an *unverified* account. So once the email provider is configured, verification and
reclaim work automatically. With NO provider configured, accounts still register and work — they
just stay unverified (the in-app banner shows, but there's nothing to click).

## Sign in with Google

Google sign-in is OFF until a client id is configured, on both the server (`Google:ClientId`, for
ID-token audience validation) and the SPA build (`VITE_GOOGLE_CLIENT_ID`, to render the button).
The client id is **public** — it ships in the SPA bundle — so unlike the Jwt key it may live in
committed config; ONE OAuth client serves every environment via its authorized origins.

One-time setup:

1. **Google Cloud Console** → APIs & Services → Credentials → **Create OAuth client ID** → type
   **Web application**. Under **Authorized JavaScript origins** add every host the button loads
   from: `https://www.allotjar.com`, `https://allotjar.com`, and (if you ever enable it there)
   `https://staging.allotjar.com`. No redirect URI is needed — this flow returns an ID token to the
   page, it does not redirect. Complete the **OAuth consent screen** (external, the app name +
   support email + the privacy/terms links already at allotjar.com) or Google shows an "unverified
   app" warning.
2. Copy the client id (`….apps.googleusercontent.com`).
3. **Server**: add to `appsettings.Production.json` (preserved across deploys):
   `"Google": { "ClientId": "….apps.googleusercontent.com" }`, then **recycle the app pool** (the
   validator's audience is read via `IOptions` at startup — see the email note above for the
   recycle rationale).
4. **SPA**: set the repository variable **`VITE_GOOGLE_CLIENT_ID`** (Settings → Secrets and
   variables → Actions → Variables) to the SAME client id. The production build step inlines it
   (`deploy/deploy.yml`); the next deploy renders the button. Staging deliberately leaves it unset.
5. **CSP** already allows `accounts.google.com/gsi/*` (script/frame/connect/style-src in
   `deploy/web/web.config`) — no action, but don't strip those directives.
6. **Smoke-test**: `https://www.allotjar.com/login` shows **Continue with Google**; completing it
   signs in (first time: the Terms modal, then the empty dashboard).

If the button doesn't appear, `VITE_GOOGLE_CLIENT_ID` wasn't inlined at build time. If it appears
but sign-in 401s, the server's `Google:ClientId` is missing/mismatched (audience check) or the app
pool wasn't recycled. A Google-created account has no password — the Account page routes such users
to **Forgot password** to add one (reset works for passwordless accounts).

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
