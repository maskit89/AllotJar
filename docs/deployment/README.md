# Production deployment — Windows Server (native IIS) runbook

AllotJar runs **natively on a Windows Server VPS** (no Docker):

| Tier | Host | Notes |
|------|------|-------|
| SPA (React `dist`) | IIS site **ZeroBudget-Staging** / **ZeroBudget-Prod** on :80/:443 | also reverse-proxies `/api` → the API |
| API (.NET 10) | IIS site **ZeroBudget-Staging-Api** on `localhost:5000` / **ZeroBudget-Prod-Api** on `localhost:5001`, hosted via the ASP.NET Core Module (ANCM) | IIS owns the process lifecycle |
| Database | **SQL Server Express** Windows service (`ZeroBudgetStaging`, `ZeroBudgetProd`) | data files on disk → survive every deploy |

```
Internet :443 ──► IIS "ZeroBudget-Staging" / "ZeroBudget-Prod" (SPA + URL Rewrite)
                      │  proxy ^api/(.*) ──► http://localhost:5000 (staging) or :5001 (production) /api/{R:1}
                      ▼
                 IIS "ZeroBudget-Staging-Api" / "ZeroBudget-Prod-Api" (ANCM) ──► SQL Server Express (Windows auth)
```

Every server-side name carries its environment, so nothing of staging's is called production:

| | Staging | Production |
|---|---|---|
| Folders | `C:\inetpub\zerobudget-staging\{api,web}` | `C:\inetpub\zerobudget-prod\{api,web}` |
| IIS sites | `ZeroBudget-Staging`, `ZeroBudget-Staging-Api` | `ZeroBudget-Prod`, `ZeroBudget-Prod-Api` |
| App pools | `ZeroBudget-Staging-Web`, `ZeroBudget-Staging-Api` | `ZeroBudget-Prod-Web`, `ZeroBudget-Prod-Api` |
| API port | 5000 | 5001 |
| `ASPNETCORE_ENVIRONMENT` (pinned by `Deploy.ps1` in the API's `web.config`) | `Staging` | `Production` |
| Settings file (server-only, gitignored) | `appsettings.Staging.json` | `appsettings.Production.json` |
| Database | `ZeroBudgetStaging` | `ZeroBudgetProd` |
| Backup task | `ZeroBudget-Staging-DbBackup` (local only, 03:30 server time) | `ZeroBudget-Prod-DbBackup` (shipped to R2, 02:30) |
| DataProtection key folder (`DataProtection:KeysPath`) | `C:\inetpub\zerobudget-staging-dp-keys` | `C:\inetpub\zerobudget-dp-keys` |
| Origin inside emailed links (`Email:AppBaseUrl`; staging must set it, the built-in default is production's) | `https://staging.allotjar.com` | `https://www.allotjar.com` (or the apex `https://allotjar.com`) |
| Release unpacked in | `C:\deploy\release-staging` (from `C:\deploy\incoming-staging`) | `C:\deploy\release-production` (from `C:\deploy\incoming-production`) |

Until 4 October 2026 staging kept the names of the original single stack (`ZeroBudget`, `C:\inetpub\zerobudget`, database `ZeroBudget`) and, because nothing set its ASP.NET Core environment, read `appsettings.Production.json`. `deploy/Rename-StagingStack.ps1` renamed it in place (run once, on the VPS; `-Check` only reports).

The React client already calls the same-origin `/api` prefix, so the proxy needs **no frontend changes** and there is **no CORS** in production.

---

## Files in this repo

| File | Runs where | Purpose |
|------|-----------|---------|
| `deploy/Bootstrap.ps1` | VPS, once | **one-shot bundler** — runs everything below (Setup-Server + SQL Express + Setup-Database + secrets + backup task) |
| `deploy/Setup-Server.ps1` | VPS, once | IIS + URL Rewrite + ARR + .NET Hosting Bundle + OpenSSH + app pools/sites + firewall |
| `deploy/Setup-Database.sql` | VPS, once | create DB (if absent) + grant the app-pool login `db_owner` |
| `deploy/web/web.config` | shipped to the SPA site | the `/api` reverse-proxy + SPA-fallback rewrite rules |
| `deploy/Deploy.ps1` | VPS, every deploy | `app_offline` swap + robocopy + pool recycle + `/health` smoke test |
| `deploy/Export-DevData.ps1` | dev machine, once | LocalDB → `.bacpac` |
| `deploy/Import-ToServer.ps1` | VPS, once | `.bacpac` → SQL Server |
| `deploy/Backup-Database.ps1` | VPS | timestamped `.bak` + retention pruning |
| `deploy/Register-BackupTask.ps1` | VPS, once | register the daily backup as a Scheduled Task (runs as SYSTEM) |
| `.github/workflows/deploy.yml` | GitHub Actions | build → SSH-push → deploy on merge to `main` |
| `src/AllotJar.Api/appsettings.Production.json.example` | template | copy to the server as `appsettings.Production.json` (production) or `appsettings.Staging.json` (staging), fill in secrets (both gitignored) |
| `deploy/Rename-StagingStack.ps1` | VPS, once (done 4 Oct 2026) | renamed the original stack's sites, pools, folders, database, settings file and backup task to their staging names |

---

## One-time server setup (manual)

> Run in an **elevated PowerShell** over RDP on the VPS, from the extracted `deploy` folder.

### 1. Bootstrap everything (one command)
```powershell
powershell -ExecutionPolicy Bypass -File .\Bootstrap.ps1
```
This runs IIS + module install, SQL Server Express install, the database + grant, writes `appsettings.Staging.json` with an **auto-generated `Jwt:Key`**, and registers the daily backup task (a fresh box starts as the staging stack; `Provision-Production.ps1` adds production). It's **idempotent** — if a step fails (e.g. a stale download URL), fix it and re-run; completed steps are skipped.

Notes:
- **Keep each stack's `Jwt:Key` once set.** Changing it voids every recovery code (they are hashed under a key derived from it): logins with a passkey still sign in with it, then get fresh codes with **New codes**.
- **No domain needed.** The site binds to the server IP over HTTP; the app will be reachable at `http://<vps-ip>` after the first deploy. (Add a domain + HTTPS later — see *Adding a domain + TLS* below.)
- Verify the **.NET 10 Hosting Bundle** URL in `Setup-Server.ps1` is current before running (Microsoft bumps the patch version). After it finishes, `dotnet --list-runtimes` should show `Microsoft.AspNetCore.App 10.x`.
- If the SQL auto-install link 404s, install **SQL Server Express** by hand (Basic) and re-run `Bootstrap.ps1`.
- When it finishes, it prints your VPS IP and the exact GitHub-secret values to use.

> Prefer to run the steps individually? Each script (`Setup-Server.ps1`, `Setup-Database.sql`, `Register-BackupTask.ps1`) still works standalone — `Bootstrap.ps1` just chains them.

### 2. SSH deploy key
On **your machine**, create a keypair dedicated to deploys:
```powershell
ssh-keygen -t ed25519 -f $HOME\.ssh\zerobudget_deploy -C "github-actions"
```
Copy the **public** half (`zerobudget_deploy.pub`) to the VPS, then there:
```powershell
Add-Content C:\ProgramData\ssh\administrators_authorized_keys (Get-Content .\zerobudget_deploy.pub)
icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"
```
Test from your machine: `ssh -i $HOME\.ssh\zerobudget_deploy Administrator@<vps-ip>`.

### 3. (Optional) migrate existing household data
Skip this for an empty start. To bring your dev data across, on the **dev machine**:
```powershell
dotnet tool install -g microsoft.sqlpackage
powershell -File .\Export-DevData.ps1          # -> deploy\ZeroBudget.bacpac
```
Copy `ZeroBudget.bacpac` to the VPS, then on the **VPS** — import **before** the grant (import creates the DB):
```powershell
powershell -File .\Import-ToServer.ps1 -BacpacPath C:\deploy\ZeroBudget.bacpac
powershell -ExecutionPolicy Bypass -File .\Bootstrap.ps1   # skips SQL install; grants on the new DB
```

### 4. Bank details key (only for rolling back)

From 27 October 2026 AllotJar keeps no bank details (IBAN, BIC, sort code, account number). The
`RemoveBankDetails` migration drops the four columns, with whatever they held, on the first start of
that build, and the API and `Deploy.ps1` no longer read or check `BankDetailsEncryption`.

**Keep the `BankDetailsEncryption` section in each stack's settings file, and its passphrase in the
password manager, for as long as you might roll back** past that build: an older build refuses to start
(and its `Deploy.ps1` refuses to deploy) without the key. Once rolling back that far is off the table and
the last nightly backup taken before the deploy has aged out of R2 (35 days), delete both.

**Rolling back** to a build from before `RemoveBankDetails`: an older build does not know that migration,
so it neither undoes it nor puts the columns back, and every account screen fails. Before redeploying the
older build, take a backup, then run this on the stack's database (empty columns, and the migration
forgotten so the newer build re-runs it later):

```sql
ALTER TABLE Accounts ADD Iban nvarchar(256) NULL, Bic nvarchar(256) NULL,
    SortCode nvarchar(256) NULL, AccountNumber nvarchar(256) NULL;
DELETE FROM __EFMigrationsHistory WHERE MigrationId = '20261027201120_RemoveBankDetails';
```

Or restore a `.bak` taken before the deploy.

### Adding a domain + TLS (later)
Once you have a domain:
- Point a DNS **A record** at the VPS public IP, then re-run `Setup-Server.ps1 -Domain "budget.yourdomain.com"` to bind the host header.
- Install free Let's Encrypt TLS with **win-acme** (`wacs.exe`): pick the `ZeroBudget-Staging` site; it creates the 443 binding **and** offers the HTTP->HTTPS redirect, and schedules auto-renewal. (The IIS-native equivalent of Caddy's auto-HTTPS.)

---

## GitHub repo configuration (manual)

Add these **Actions secrets** (Settings → Secrets and variables → Actions):

| Secret | Value |
|--------|-------|
| `VPS_HOST` | VPS public IP or hostname |
| `VPS_SSH_USER` | e.g. `Administrator` |
| `VPS_SSH_KEY` | the **private** key from step 2 (full file contents) |
| `VPS_SSH_PORT` | `22` (or your custom SSH port) |

Production deploys only on a hand-started Deploy run with **Also deploy to production** ticked, and only when CI passed on that commit (see [staging-prod.md](staging-prod.md)). The repo is private on GitHub Free, where branch protection and environment required reviewers do not apply.

---

## The deploy flow (automatic)

1. You merge a PR into `main`.
2. `deploy.yml` builds the release on an Ubuntu runner: `dotnet publish` (win-x64) + `npm run build`, zipped as `release.zip` (`api/`, `web/`, `Deploy.ps1`, `ProvisionHelpers.psm1`).
3. `scp` copies the zip to `C:\deploy\incoming-staging` on the VPS (`incoming-production` for the production job).
4. `ssh` extracts it to `C:\deploy\release-staging` (`release-production`) and runs `Deploy.ps1` with that stack's folders, pools, port and `-AspNetEnvironment`, which:
   - checks the pools and the stack's `appsettings.<Env>.json` exist (a clear error, not a failed health check, if not),
   - drops `app_offline.htm` (releases the API's file locks),
   - `robocopy /MIR`s the new files — **preserving** `appsettings.Staging.json` / `appsettings.Production.json`, the offline marker, and the ANCM `logs` folder,
   - pins `ASPNETCORE_ENVIRONMENT` in the API's `web.config` (so staging reads `appsettings.Staging.json`) and the `/api` proxy port in the SPA's,
   - removes the marker, recycles both app pools,
   - polls `http://localhost:5000/health` until `200` (EF migrations run on first hit), failing the job otherwise.

**Data safety:** only the API/SPA file trees are replaced. The SQL Server database and its `.mdf`/`.ldf` files are never touched, so data persists across every deploy. EF Core migrations are additive/idempotent — they only apply *pending* schema changes and never drop data.

---

> **Environment names:** production DB = `ZeroBudgetProd` (API :5001, pool `ZeroBudget-Prod-Api`);
> staging DB = `ZeroBudgetStaging` (API :5000, pool `ZeroBudget-Staging-Api`). See
> [`staging-prod.md`](staging-prod.md) for the authoritative topology — the commands below
> name the **production** database explicitly; swap in the staging values when targeting staging.

## Backups

After SQL Server is installed, register the daily backup (runs as SYSTEM, prunes to 14 days).
`Provision-Production.ps1` registers one task per environment; to (re)register by hand pass the
target DB explicitly:
```powershell
powershell -ExecutionPolicy Bypass -File .\Register-BackupTask.ps1 -Database ZeroBudgetProd -TaskName ZeroBudget-Prod-DbBackup
# verify:  Start-ScheduledTask -TaskName ZeroBudget-Prod-DbBackup ; Get-ChildItem C:\deploy\backups
```
`.bak` files land in `C:\deploy\backups`. Run `Register-BackupTask.ps1` again to change the time/retention. If the task can't back up, the SYSTEM account lacks rights on the instance — grant it (or re-run the task as your SQL admin).

### Off-host backups (Cloudflare R2, encrypted)

Local `.bak` files are point-in-time recovery only — a disk/host/ransomware event takes out the
data **and** the backups together. `Backup-Database.ps1 -R2Bucket <bucket>` also ships each
**verified** backup to Cloudflare R2 (via `Upload-BackupToR2.ps1`). The backup holds every user's
financial data, so it is **encrypted on the VPS before it leaves** (rclone `crypt`, authenticated
XSalsa20-Poly1305) and lands as `db-backups-enc/<name>.bak.bin`. File names stay readable so the
newest backup can be found. The upload **refuses to run** unless `rclone.conf` has the matching
`[r2crypt]` remote; it never falls back to a plain upload.

One-time setup on the VPS:

1. **Install rclone** (single portable binary) to `C:\deploy\rclone\rclone.exe` — from <https://rclone.org/downloads/> (Windows AMD64). Verify the download's SHA-256 against the published `SHA256SUMS` before trusting it.
2. **Create the R2 remote** — an rclone config file **outside the repo**, e.g. `C:\deploy\rclone.conf`:
   ```ini
   [r2]
   type = s3
   provider = Cloudflare
   access_key_id = <R2 Access Key ID>
   secret_access_key = <R2 Secret Access Key>
   endpoint = https://<account-id>.r2.cloudflarestorage.com
   acl = private
   ```
   Use an **Account API token** scoped to the one bucket with **Object Read & Write**. The secret
   sits here in plaintext, so lock the file down:
   ```powershell
   icacls C:\deploy\rclone.conf /inheritance:r /grant:r "SYSTEM:R" "BUILTIN\Administrators:F"
   ```
3. **Create the encryption key** — `Set-BackupEncryption.ps1 -Bucket <bucket>`. You type two long random
   secrets (a password and a salt, 20+ characters each, generated and **saved in your password manager
   first**) as hidden input; the script adds an `[r2crypt]` remote to `rclone.conf` and proves it with a
   throwaway file (stored encrypted, read back identical). It never prints a secret and refuses to run
   when `[r2crypt]` exists, so it cannot replace a key by accident. `-VerifyOnly` re-runs only the proof.
   **The password manager entry is the real home of the key**: `rclone.conf` only holds it in obscured
   (reversible) form on the VPS, and a lost VPS loses that copy. Lose the secrets and every backup in R2
   is unreadable for good.
4. **Automate it** — re-register the daily prod task from the new `deploy` folder (this also copies
   the new scripts into `C:\deploy`, so do step 3 first; until you do, the registered task keeps running
   its old copy of the script and keeps uploading plain backups):
   ```powershell
   powershell -File .\Register-BackupTask.ps1 -Database ZeroBudgetProd -TaskName ZeroBudget-Prod-DbBackup -R2Bucket <bucket> -PingUrl <healthchecks url>
   ```
5. **Test it** — one verified backup, encrypted, shipped off-host and size-checked (the encrypted object
   is about 2 KB larger than the `.bak`), then prove the password-manager entry matches the VPS:
   ```powershell
   powershell -File C:\deploy\Backup-Database.ps1 -Database ZeroBudgetProd -R2Bucket <bucket>
   powershell -File .\Set-BackupEncryption.ps1 -Bucket <bucket> -CheckKey
   ```
   `-CheckKey` asks for the two secrets again (copy them from the password manager) and prints OK or MISMATCH.
6. **Expire old copies** — R2 lifecycle rules, set in the Cloudflare dashboard (R2 > the bucket >
   Settings > Object lifecycle rules; the bucket-scoped token cannot do this):
   * prefix `db-backups-enc/` — delete objects after **35 days**;
   * prefix `db-backups/` — delete objects after **7 days** (the plain-text backups from before
     encryption). Add this one only after `-CheckKey` says OK.

   **Type the trailing slash**: `db-backups` alone also matches `db-backups-enc/`.

   Local copies still follow `-RetentionDays` (14). If the bucket has a bucket lock (retention) rule,
   keep every expiry at or above its period. Backups outlive an account deletion by up to the expiry
   period; the privacy policy should say so.

Tasks registered before this change carry `-R2Prefix "db-backups"`. They keep running the old copy of the
script (and uploading plain backups) until re-registered in step 4; if the new script is ever run with that
old prefix it refuses to upload, because the crypt remote points at `db-backups-enc`.

### Restore test (prove the off-host copies are usable)

A backup nobody has restored is a hope, not a backup. Restore production's newest nightly `.bak`
from R2 onto **staging** every so often (staging is offline for about a minute; production is not
touched). On the VPS, in an elevated Windows PowerShell, from a copy of this `deploy` folder:
```powershell
# 1. keep staging's own data so it can be put back afterwards
powershell -File .\Backup-Database.ps1 -Database ZeroBudgetStaging
# 2. fetch the newest production backup from R2, decrypted (prints the .bak's path)
powershell -File .\Get-BackupFromR2.ps1 -Bucket allotjar
# 3. restore it onto staging (asks you to type the target database name)
powershell -File .\Migrate-FromBak.ps1 -Environment staging -BakPath C:\deploy\restore-test\ZeroBudgetProd_<stamp>.bak
# 4. afterwards, put staging's own data back the same way, from the file step 1 wrote
# 5. delete C:\deploy\restore-test\*.bak: the decrypted copy holds every user's data in plain text
```
`Migrate-FromBak.ps1` verifies the file first (`RESTORE VERIFYONLY WITH CHECKSUM`), restores onto
the target database's **own** files (never the source's: production's `.mdf` is a live file of
another database on the same instance, and the script refuses any destination that is), renames the
logical files after the target, re-grants the app-pool login and health-checks the API. `Migrate-FromBak.ps1` refuses a
still-encrypted file. Record each restore test (date, backup used, result) in the development log.

**If the VPS is lost** the backups are still in R2, and the key is in your password manager. On the
replacement server: install rclone, create `C:\deploy\rclone.conf` with an `[r2]` remote (a new Object Read & Write
token is fine, the setup proof uploads and deletes a test file; step 2 above), run `Set-BackupEncryption.ps1 -Bucket allotjar` and paste the **same** password and salt from the password
manager, then `Get-BackupFromR2.ps1 -Bucket allotjar` and `Migrate-FromBak.ps1`. A wrong password or
salt fails with `failed to authenticate decrypted block`; it can never produce a wrong database.

**Provisioning can no longer downgrade this.** `Provision-Production.ps1` re-registers the daily
tasks, and `Register-ScheduledTask -Force` overwrites — so a re-run used to silently replace an
R2-enabled prod task with a local-only one. It now resolves the bucket from `-ProdR2Bucket`, else
**preserves** the bucket on the existing `ZeroBudget-Prod-DbBackup` task, else **refuses to run**;
after registering, it reads the task back and asserts the R2 arguments are on the stored action.
The "Provision production stack" workflow passes the bucket from the `BACKUP_R2_BUCKET` secret
(and the TLS pin from `ORIGIN_CERT_THUMBPRINT`) and fails before touching the VPS if either is
missing.

## Rollback

Re-run a previous successful **Deploy** workflow from the Actions tab (it re-pushes that commit's artifact), or check out the previous commit and `workflow_dispatch`. Take an ad-hoc backup before any deploy that includes a migration (`-Database` is required — name the target env):
```powershell
powershell -File C:\deploy\Backup-Database.ps1 -Database ZeroBudgetProd
```
Restore a `.bak` if needed (stops the API pool, verifies the file, restores onto the database's own files, re-grants the pool login, health-checks):
```powershell
powershell -File C:\deploy\Migrate-FromBak.ps1 -Environment production -BakPath C:\deploy\backups\ZeroBudgetProd_<stamp>.bak
```

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `500.19` / `500.30` on the API site | Hosting Bundle missing or installed **before** IIS — reinstall it, then `iisreset`. |
| `/api` returns 404 from the SPA site | ARR proxy not enabled at server level (re-run `Setup-Server.ps1`), or URL Rewrite missing. |
| API up but DB errors at startup | app-pool login not granted — re-run `Setup-Database.sql`; check the connection string instance name (`\SQLEXPRESS`). |
| Deploy fails on file-in-use | `app_offline.htm` step didn't take — confirm the app pool exists and ANCM is installed. |
| Health check times out | check ANCM stdout logs in `C:\inetpub\zerobudget-staging\api\logs` (`zerobudget-prod` for production). |
| Deploy stops at "App pool ... does not exist" or "appsettings.Staging.json is missing" | the staging stack still has its pre-rename names: run `deploy\Rename-StagingStack.ps1` once. |
