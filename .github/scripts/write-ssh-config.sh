#!/usr/bin/env bash
# Writes the deploy key and an ssh config alias "vps" for one stack's upload-only account.
# Env: KEY (private key), HOST_KEY (the VPS's public host key line), HOST, PORT, USER.
# The VPS's own ed25519 host key is pinned, so the runner refuses to talk to anything else
# answering at HOST (no trust on first use).
set -euo pipefail
for v in KEY HOST_KEY HOST PORT USER; do
  if [ -z "${!v:-}" ]; then echo "::error::$v is empty: is its secret set?"; exit 1; fi
done
# First line only, with stray spaces from copy-paste trimmed.
HOST_KEY=$(printf '%s\n' "$HOST_KEY" | tr -d '\r' | head -n 1 | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
case "$HOST_KEY" in
  "ssh-ed25519 AAAA"*) ;;
  *) echo "::error::Secret VPS_HOST_KEY must hold the VPS's public host key line, starting 'ssh-ed25519 AAAA'."; exit 1 ;;
esac
mkdir -p ~/.ssh && chmod 700 ~/.ssh
printf '%s\n' "$KEY" | tr -d '\r' > ~/.ssh/deploy_key
chmod 600 ~/.ssh/deploy_key
printf 'allotjar-vps %s\n' "$HOST_KEY" > ~/.ssh/known_hosts_vps
{
  echo 'Host vps'
  echo "  HostName $HOST"
  echo "  Port $PORT"
  echo "  User $USER"
  echo '  IdentityFile ~/.ssh/deploy_key'
  echo '  IdentitiesOnly yes'
  echo '  BatchMode yes'
  echo '  ConnectTimeout 20'
  echo '  HostKeyAlias allotjar-vps'
  echo '  UserKnownHostsFile ~/.ssh/known_hosts_vps'
  echo '  GlobalKnownHostsFile /dev/null'
  echo '  StrictHostKeyChecking yes'
} > ~/.ssh/config
chmod 600 ~/.ssh/config
