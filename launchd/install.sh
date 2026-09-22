#!/bin/bash
# Install the daily water-bill watcher as a launchd user agent.
#
# launchd rather than cron: a LaunchAgent with StartCalendarInterval runs a
# missed job when the Mac next wakes, and it does not need the Full Disk Access
# grant that cron quietly requires on modern macOS.

set -euo pipefail

LABEL="com.lincware.rochester-water-bill"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"
NODE_BIN="$(command -v node)"

SMTP_USER="${SMTP_USER:-}"
MAIL_TO="${MAIL_TO:-$SMTP_USER}"
WATER_BILL_ADDRESS="${WATER_BILL_ADDRESS:-}"

if [ -z "$SMTP_USER" ] || [ -z "$WATER_BILL_ADDRESS" ]; then
  echo "Set SMTP_USER and WATER_BILL_ADDRESS first, e.g." >&2
  echo "  SMTP_USER=you@gmail.com WATER_BILL_ADDRESS='10 Felix St' $0" >&2
  exit 2
fi

if ! /usr/bin/security find-generic-password \
     -s rochester-water-bill -a "$SMTP_USER" -w >/dev/null 2>&1; then
  echo "No app password in the keychain yet. Add one with:" >&2
  echo "  security add-generic-password -s rochester-water-bill \\" >&2
  echo "    -a $SMTP_USER -w '<16-char Gmail app password>'" >&2
  exit 2
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$PROJECT_DIR/bill-watch.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>

  <!-- Daily. A missed run fires on the next wake, and an unchanged bill is a
       no-op, so checking often is free. -->
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>9</integer>
    <key>Minute</key><integer>15</integer>
  </dict>

  <key>EnvironmentVariables</key>
  <dict>
    <key>SMTP_USER</key><string>$SMTP_USER</string>
    <key>MAIL_TO</key><string>$MAIL_TO</string>
    <key>WATER_BILL_ADDRESS</key><string>$WATER_BILL_ADDRESS</string>
  </dict>

  <key>StandardOutPath</key>
  <string>$LOG_DIR/$LABEL.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/$LABEL.log</string>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"

echo "Installed $LABEL"
echo "  plist:  $PLIST"
echo "  log:    $LOG_DIR/$LABEL.log"
echo
echo "Run it once now:   launchctl kickstart -p gui/$UID/$LABEL"
echo "Check it is loaded: launchctl print gui/$UID/$LABEL | head"
echo "Remove it:         launchctl bootout gui/$UID/$LABEL && rm $PLIST"
