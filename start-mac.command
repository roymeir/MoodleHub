#!/bin/bash
cd "$(dirname "$0")"
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is not installed. Get it from https://www.python.org/downloads/ and run this again."
  read -n 1 -s -r -p "Press any key to close."; exit 1
fi
# keep the Mac awake while the Hub runs (screen can still turn off)
caffeinate -i python3 hub.py
status=$?
if [ $status -ne 0 ]; then
  echo
  read -n 1 -s -r -p "Moodle Hub stopped with an error (see above). Press any key to close."
fi
exit $status
