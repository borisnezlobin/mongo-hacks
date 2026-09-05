#!/usr/bin/env bash
# Build and flash the glasses firmware to the one attached XIAO ESP32-S3.
set -eo pipefail

cd "$(dirname "$0")"
# shellcheck source=port.sh
source ./port.sh

source_idf_env
wait_for_port 30

echo "Flashing $GLASSES_PORT"
if ! idf.py -p "$GLASSES_PORT" flash; then
  echo "Flashing failed." >&2
  download_mode_help
  exit 1
fi
