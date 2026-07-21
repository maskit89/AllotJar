# Production deployment — Windows Server (native IIS) runbook

AllotJar runs **natively on a Windows Server VPS** (no Docker):

| Tier | Host | Notes |
|------|------|-------|
| SPA (React `dist`) | IIS site **ZeroBudget** on :80/:443 | also reverse-proxies `/api` → the API |
| API (.NET 10) | IIS site **ZeroBudget-Api** on `localhost:5000`, hosted via the ASP.NET Core Module (ANCM) | IIS owns the process lifecycle |
| Database | **SQL Server Express** Windows service | data files on disk → survive every deploy |

```
Internet :443 ──► IIS "ZeroBudget" (SPA + URL Rewrite)
                      │  proxy ^api/(.*) ──► http://localhost:5000/api/{R:1}
                      ▼
                 IIS "ZeroBudget-Api" (ANCM) ──► SQL Server Express (Windows auth)
```

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
| `src/AllotJar.Api/appsettings.Production.json.example` | template | copy to the server, fill in secrets (gitignored) |

---

## One-time server setup (manual)

> Run in an **elevated PowerShell** over RDP on the VPS, from the extracted `deploy` folder.

### 1. Bootstrap everything (one command)
```powershell
powershell -ExecutionPolicy Bypass -File .\Bootstrap.ps1
```
This runs IIS + module install, SQL Server Express install, the database + grant, writes `appsettings.Production.json` with an **auto-generated `Jwt:Key`**, and registers the daily backup task. It's **idempotent** — if a step fails (e.g. a stale download URL), fix it and re-run; completed steps are skipped.

Notes:
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

### Adding a domain + TLS (later)
Once you have a domain:
- Point a DNS **A record** at the VPS public IP, then re-run `Setup-Server.ps1 -Domain "budget.yourdomain.com"` to bind the host header.
- Install free Let's Encrypt TLS with **win-acme** (`wacs.exe`): pick the `ZeroBudget` site; it creates the 443 binding **and** offers the HTTP->HTTPS redirect, and schedules auto-renewal. (The IIS-native equivalent of Caddy's auto-HTTPS.)

---

## GitHub repo configuration (manual)

Add these **Actions secrets** (Settings → Secrets and variables → Actions):

| Secret | Value |
|--------|-------|
| `VPS_HOST` | VPS public IP or hostname |
| `VPS_SSH_USER` | e.g. `Administrator` |
| `VPS_SSH_KEY` | the **private** key from step 2 (full file contents) |
| `VPS_SSH_PORT` | `22` (or your custom SSH port) |

Recommended: **branch protection** on `main` requiring the existing `backend` / `frontend` / `a11y` CI checks, so only green code can merge and deploy. Optionally add a required reviewer on the `production` environment to gate the deploy job.

---

## The deploy flow (automatic)

1. You merge a PR into `main`.
2. `deploy.yml` builds the release on an Ubuntu runner: `dotnet publish` (win-x64) + `npm run build`, zipped as `release.zip` (`api/`, `web/`, `Deploy.ps1`).
3. `scp` copies the zip to `C:\deploy\incoming` on the VPS.
4. `ssh` extracts it to `C:\deploy\staging` and runs `Deploy.ps1`, which:
   - drops `app_offline.htm` (releases the API's file locks),
   - `robocopy /MIR`s the new files — **preserving** `appsettings.Production.json`, the offline marker, and the ANCM `logs` folder,
   - removes the marker, recycles both app pools,
   - polls `http://localhost:5000/health` until `200` (EF migrations run on first hit), failing the job otherwise.

**Data safety:** only the API/SPA file trees are replaced. The SQL Server database and its `.mdf`/`.ldf` files are never touched, so data persists across every deploy. EF Core migrations are additive/idempotent — they only apply *pending* schema changes and never drop data.

---

> **Environment names (post-GA cutover):** production DB = `ZeroBudgetProd` (API :5001,
> pool `ZeroBudget-Prod-Api`); `ZeroBudget` (API :5000) is now **staging**. See
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

### Off-host backups (Cloudflare R2)

Local `.bak` files are point-in-time recovery only — a disk/host/ransomware event takes out the
data **and** the backups together. `Backup-Database.ps1 -R2Bucket <bucket>` also ships each
**verified** backup to Cloudflare R2 (via `Upload-BackupToR2.ps1`), where the bucket's **Object
Lock** retention makes copies immutable — unremovable even by a compromised server.

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
3. **Test it** — one verified backup, shipped off-host and size-checked:
   ```powershell
   powershell -File C:\deploy\Backup-Database.ps1 -Database ZeroBudgetProd -R2Bucket <bucket>
   ```
4. **Automate it** — re-register the daily prod task with the R2 flag so every night's verified
   backup goes off-host:
   ```powershell
   powershell -File .\Register-BackupTask.ps1 -Database ZeroBudgetProd -TaskName ZeroBudget-Prod-DbBackup -R2Bucket <bucket>
   ```

Remote retention is enforced by the bucket's Object Lock + lifecycle rules (set in the Cloudflare
dashboard), independent of the local `-RetentionDays` prune. Periodically restore from R2 into a
scratch SQL instance to prove the off-host copies are usable.

## Rollback

Re-run a previous successful **Deploy** workflow from the Actions tab (it re-pushes that commit's artifact), or check out the previous commit and `workflow_dispatch`. Take an ad-hoc backup before any deploy that includes a migration (`-Database` is required — name the target env):
```powershell
powershell -File C:\deploy\Backup-Database.ps1 -Database ZeroBudgetProd
```
Restore a `.bak` if needed:
```powershell
sqlcmd -S .\SQLEXPRESS -E -Q "RESTORE DATABASE [ZeroBudgetProd] FROM DISK='C:\deploy\backups\ZeroBudgetProd_<stamp>.bak' WITH REPLACE"
```

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `500.19` / `500.30` on the API site | Hosting Bundle missing or installed **before** IIS — reinstall it, then `iisreset`. |
| `/api` returns 404 from the SPA site | ARR proxy not enabled at server level (re-run `Setup-Server.ps1`), or URL Rewrite missing. |
| API up but DB errors at startup | app-pool login not granted — re-run `Setup-Database.sql`; check the connection string instance name (`\SQLEXPRESS`). |
| Deploy fails on file-in-use | `app_offline.htm` step didn't take — confirm the app pool exists and ANCM is installed. |
| Health check times out | check ANCM stdout logs in `C:\inetpub\zerobudget\api\logs`. |
