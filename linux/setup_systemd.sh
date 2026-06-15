#!/usr/bin/env bash
set -euo pipefail

REPO_PATH="$(cd "$(dirname "$0")/.." && pwd)"
MONITOR_PATH="$REPO_PATH/monitor.py"
SERVICE_TEMPLATE="$REPO_PATH/linux/eyeingggg.service.template"
SYSTEMD_PATH="/etc/systemd/system/eyeingggg.service"

if [ ! -f "$SERVICE_TEMPLATE" ]; then
  echo "Service template not found: $SERVICE_TEMPLATE"
  exit 1
fi

echo "Installing systemd unit for Eyeingggg monitor..."
sudo cp "$SERVICE_TEMPLATE" "$SYSTEMD_PATH"
sudo sed -i "s|/home/YOUR_USER/eyeingggg|$REPO_PATH|g" "$SYSTEMD_PATH"
sudo sed -i "s|WorkingDirectory=/home/YOUR_USER/eyeingggg|WorkingDirectory=$REPO_PATH|g" "$SYSTEMD_PATH"

sudo systemctl daemon-reload
sudo systemctl enable eyeingggg
sudo systemctl start eyeingggg

echo "Eyeingggg service installed and started."
echo "Logs available via journal: sudo journalctl -u eyeingggg -n 50 -f"
