#!/usr/bin/env bash
# One-time setup of a GitHub Actions self-hosted runner for AllotJar's CI (ci.yml and
# security-scan.yml). Run as root on a fresh x64 Ubuntu 22.04/24.04 VM that holds
# nothing else: CI runs the repository's code, Dependabot's included, and the runner user
# is in the docker group, which is root on that machine.
#
#   sudo RUNNER_TOKEN=<registration token> ./setup-runner.sh
#
# The token comes from GitHub: repository Settings > Actions > Runners > New self-hosted
# runner (it expires after an hour). Re-running the script is safe: it skips what is done.
# Steps, checks and removal: docs/ops/ci-self-hosted-runner.md.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/maskit89/AllotJar}"
RUNNER_NAME="${RUNNER_NAME:-allotjar-ci-1}"
RUNNER_LABELS="${RUNNER_LABELS:-allotjar-ci}"   # self-hosted and linux are added automatically
RUNNER_USER="${RUNNER_USER:-runner}"
RUNNER_DIR="${RUNNER_DIR:-/opt/actions-runner}"

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
[ "$(uname -m)" = x86_64 ] || { echo "x64 only: CI's SQL Server 2022 container has no ARM image." >&2; exit 1; }
. /etc/os-release
case "$ID-$VERSION_ID" in ubuntu-22.04|ubuntu-24.04) ;; *) echo "Tested on Ubuntu 22.04/24.04, found $PRETTY_NAME." >&2; exit 1 ;; esac

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git jq unzip tar gnupg wget apt-transport-https

# Docker: the SQL Server service container in the integration job.
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

# PowerShell: the deploy-scripts job runs the helper tests with pwsh.
if ! command -v pwsh >/dev/null; then
  wget -q "https://packages.microsoft.com/config/ubuntu/${VERSION_ID}/packages-microsoft-prod.deb" -O /tmp/msprod.deb
  dpkg -i /tmp/msprod.deb && rm /tmp/msprod.deb
  apt-get update -y
  apt-get install -y powershell
fi

# Chromium's system libraries for Playwright. The runner user has no sudo, so the
# workflow skips `playwright install --with-deps` here (runner.environment check).
apt-get install -y libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 \
  libpango-1.0-0 libcairo2 fonts-liberation xvfb 2>/dev/null \
  || apt-get install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
       libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
       libpango-1.0-0 libcairo2 fonts-liberation xvfb

# The runner user: in the docker group (service containers), no sudo.
id "$RUNNER_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$RUNNER_USER"
usermod -aG docker "$RUNNER_USER"

# The runner itself.
mkdir -p "$RUNNER_DIR"
if [ ! -x "$RUNNER_DIR/run.sh" ]; then
  version=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name | sed 's/^v//')
  curl -fsSL "https://github.com/actions/runner/releases/download/v${version}/actions-runner-linux-x64-${version}.tar.gz" | tar xz -C "$RUNNER_DIR"
fi
chown -R "$RUNNER_USER":"$RUNNER_USER" "$RUNNER_DIR"

if [ ! -f "$RUNNER_DIR/.runner" ]; then
  : "${RUNNER_TOKEN:?Set RUNNER_TOKEN to the registration token from GitHub (see the header).}"
  sudo -u "$RUNNER_USER" "$RUNNER_DIR/config.sh" --unattended --url "$REPO_URL" --token "$RUNNER_TOKEN" \
    --name "$RUNNER_NAME" --labels "$RUNNER_LABELS" --work _work --replace
fi

# actions/setup-dotnet installs to /usr/share/dotnet unless told otherwise, which the
# runner user (no sudo) cannot write. The runner exports .env into every job.
runner_home=$(getent passwd "$RUNNER_USER" | cut -d: -f6)
touch "$RUNNER_DIR/.env"
grep -q '^DOTNET_INSTALL_DIR=' "$RUNNER_DIR/.env" || echo "DOTNET_INSTALL_DIR=$runner_home/.dotnet" >> "$RUNNER_DIR/.env"
grep -q '^DOTNET_CLI_TELEMETRY_OPTOUT=' "$RUNNER_DIR/.env" || echo "DOTNET_CLI_TELEMETRY_OPTOUT=1" >> "$RUNNER_DIR/.env"
chown "$RUNNER_USER":"$RUNNER_USER" "$RUNNER_DIR/.env"

# Run as a service that survives reboots.
cd "$RUNNER_DIR"
if ! ls /etc/systemd/system/actions.runner.*.service >/dev/null 2>&1; then
  ./svc.sh install "$RUNNER_USER"
fi
./svc.sh stop >/dev/null 2>&1 || true   # a re-run picks up a changed .env
./svc.sh start

# Weekly clean-up of images and the runner's work folder leftovers (disk fills otherwise).
cat > /etc/cron.weekly/allotjar-ci-prune <<'CRON'
#!/bin/sh
docker system prune -af --volumes >/dev/null 2>&1
CRON
chmod +x /etc/cron.weekly/allotjar-ci-prune

echo
echo "Runner '$RUNNER_NAME' is installed and started."
echo "Next: GitHub > repository Settings > Actions > Runners should show it Idle, then set the"
echo "variable CI_RUNS_ON to the label: $RUNNER_LABELS (see docs/ops/ci-self-hosted-runner.md)."
