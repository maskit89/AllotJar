# CI on a self-hosted runner

Why: the repository is private, so GitHub bills Actions minutes (the Pro plan includes 3,000 a month; a full CI run was about 17 billed minutes before the 4 October trims). A self-hosted runner's minutes are free. This page is the setup, the switch, and the way back.

## What moves and what stays

| | Runs on |
|---|---|
| `ci.yml` (changes, backend, integration with the journeys, frontend, a11y, deploy-scripts) and `security-scan.yml` | the self-hosted runner, once the variable `CI_RUNS_ON` is set |
| `deploy.yml` (build, deploy, the `ci-passed` gate) and `provision-production.yml` | always GitHub's own runners |

Deploy stays on GitHub on purpose: those jobs hold the keys to staging and production, and the runner executes code from every pull request, Dependabot's included. The `ci-passed` gate reads CI results from GitHub whichever runner produced them, so the production gate is unchanged.

## The machine

- A separate x64 Linux machine, Ubuntu 22.04 or 24.04, **not the production VPS**: CI would compete with production for memory and CPU, and pull-request code would run beside live data. x64 is required: CI starts SQL Server 2022 in a Docker container, which has no ARM image.
- At least 4 GB RAM (SQL Server alone wants 2 GB), 2 vCPUs, 40 GB disk. Always on: a job sent to an offline runner waits in the queue (see "Way back").
- Nothing else on it and no secrets on it: no deploy keys, no Cloudflare or R2 credentials, no personal files. The CI workflows need none (the test database password in `ci.yml` is a throwaway).
- A home PC works if it stays on and runs Ubuntu (a VM is fine); the runner user can start containers, which is root-equivalent on that machine.

## Setup (about 15 minutes)

1. On GitHub: the repository's Settings > Actions > Runners > **New self-hosted runner**, Linux, x64. Copy only the registration token from the `./config.sh` line (it lasts an hour).
2. On the machine, copy `deploy/ci-runner/setup-runner.sh` over (or `git clone` the repository there) and run:

   ```
   sudo RUNNER_TOKEN=<the token> ./setup-runner.sh
   ```

   It installs Docker, PowerShell and Chromium's libraries, creates a `runner` user without sudo, installs the runner as a service named `allotjar-ci-1` with the label `allotjar-ci`, and adds a weekly Docker clean-up. Running it again is safe.
3. Settings > Actions > Runners should now list `allotjar-ci-1` as **Idle**.
4. Run **one** runner process on the machine. The integration job publishes SQL Server on port 1433 and the journeys use ports 5099 and 4173, so two jobs at once would collide; one runner makes the jobs of a run queue one behind another (a full run takes roughly 10 to 15 minutes).

## Try it before trusting it

1. Settings > Secrets and variables > Actions > **Variables** > New repository variable: name `CI_RUNS_ON`, value `["self-hosted","linux","allotjar-ci"]`.
2. Actions > CI > Run workflow on `main` (a hand-started run includes the journeys and a11y). Every job should show `allotjar-ci-1` as its runner and pass.
3. Open or push to any pull request and check its CI the same way. Dependabot's Thursday batch exercises it too.

If a job fails only on the runner, delete the variable (below) and tell Claude; the likely causes are a missing system library or a leftover container.

## Way back (and when the machine is off)

Delete the variable `CI_RUNS_ON` (Settings > Secrets and variables > Actions > Variables). New runs go back to GitHub's runners at once. A run already queued for the offline runner stays queued: cancel it and run it again. Nothing in the repository needs to change either way.

## Keeping it safe and tidy

- The runner is a normal user in the `docker` group, no sudo; the machine holds no secrets, so the worst a malicious pull request can do is wreck the machine, which you rebuild with the script.
- Rebuild or at least reboot it now and then, and update the runner: GitHub warns in the Runners page when its version is old, and the runner updates itself when idle.
- `docker system prune` runs weekly. If the disk fills (`df -h`), run `sudo docker system prune -af` and `rm -rf /opt/actions-runner/_work/_temp`.
- To remove the runner: Settings > Actions > Runners > the runner > Remove, then `cd /opt/actions-runner && sudo ./svc.sh stop && sudo ./svc.sh uninstall`.

## What the workflows do differently on the runner

`runner.environment` is `self-hosted`, so the Playwright steps skip `--with-deps` / `install-deps` (they need sudo; the setup script installed the libraries). `actions/cache` still works but is redundant on a persistent disk. Everything else is identical.
