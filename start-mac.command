#!/bin/bash
cd "$(dirname "$0")"
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is not installed. Get it from https://www.python.org/downloads/ and run this again."
  read -n 1; exit 1
fi
# keep the Mac awake while the Hub runs (screen can still turn off)
exec caffeinate -i python3 hub.py
