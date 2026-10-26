#!/bin/bash
# Run Moodle Hub. With --install-service it starts automatically at boot (systemd, e.g. Raspberry Pi).
cd "$(dirname "$(readlink -f "$0")")"
DIR="$(pwd)"
if [ "$1" = "--install-service" ]; then
  sudo tee /etc/systemd/system/moodle-hub.service >/dev/null <<EOF
[Unit]
Description=Moodle Hub
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$DIR
ExecStart=/usr/bin/env python3 $DIR/hub.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now moodle-hub
  echo "Installed. Moodle Hub now starts at boot. Logs: journalctl -u moodle-hub -f"
  exit 0
fi
exec python3 hub.py
