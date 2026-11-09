#!/usr/bin/env bash
# Uploads release.zip through the stack's upload-only account and waits for the VPS's deploy
# task (AllotJar-UploadDeploy, every minute, deploy/Invoke-PendingDeploy.ps1) to deploy it.
# Usage: upload-deploy.sh <staging|production>   (needs the "vps" alias from write-ssh-config.sh)
# Env: RELEASE_ID, "<run id>-<attempt>-<stack>", echoed back in the server's status.txt.
#
# The account can only use sftp, inside its own folder: it may write /incoming and read
# /status.txt, which only the server's task writes. The upload goes in as .part and is renamed,
# so the task never sees half a file.
set -euo pipefail
stack="$1"
id="${RELEASE_ID:?}"
case "$id" in *-"$stack") ;; *) echo "::error::RELEASE_ID $id does not end in -$stack"; exit 1 ;; esac
[ -f release.zip ] || { echo "::error::release.zip is missing"; exit 1; }

printf '%s\n' "$id" > release.id
sftp -b - vps <<'SFTP'
-rm /incoming/release.zip.part
-rm /incoming/release.zip
put release.id /incoming/release.id
put release.zip /incoming/release.zip.part
rename /incoming/release.zip.part /incoming/release.zip
SFTP
echo "Uploaded $id. Waiting for the server's deploy task (it looks every minute)."

token="stop-$(date +%s)-$RANDOM$RANDOM"
deadline=$((SECONDS + 720))
while [ "$SECONDS" -lt "$deadline" ]; do
  sleep 10
  rm -f status.txt status.clean
  if ! printf 'get /status.txt status.txt\n' | sftp -q -b - vps >/dev/null 2>&1; then continue; fi
  [ -f status.txt ] || continue
  tr -d '\r' < status.txt > status.clean
  [ "$(sed -n 's/^id=//p' status.clean | head -n 1)" = "$id" ] || continue
  state=$(sed -n 's/^state=//p' status.clean | head -n 1)
  msg=$(sed -n 's/^message=//p' status.clean | head -n 1)
  case "$state" in
    ok|failed|blocked)
      # The server's log is shown as plain text: no line in it can act as a workflow command.
      echo "::stop-commands::$token"
      sed -n 's/^log: //p' status.clean
      echo "$msg"
      echo "::$token::"
      if [ "$state" = ok ]; then exit 0; fi
      echo "::error::The $stack deploy $state. See the message above."
      exit 1 ;;
  esac
done
echo "::error::No result from the server's deploy task within 12 minutes. On the VPS, check the scheduled task AllotJar-UploadDeploy and the Application log (source AllotJar Deploy)."
exit 1
