# Sourced by flash.sh. Shared helpers: the ESP-IDF environment and finding the
# single attached XIAO.

download_mode_help() {
  cat >&2 <<'EOF'

Whatever is on the board now owns the USB port (the UVC firmware enumerates as
a camera, and a half-written flash enumerates as nothing), so esptool cannot
auto-reset it into download mode. Do it by hand, now:

  1. Hold BOOT.
  2. Tap RESET (still holding BOOT).
  3. Release BOOT.

The board then re-enumerates as 303a:1001 and a /dev/cu.usbmodem* device
appears. If none ever appears, try a different USB-C cable — charge-only cables
are common and carry no data lines.
EOF
}

# idf-env.sh ends with `conda deactivate`, which returns non-zero whenever no
# conda environment is active. Under `set -e` that silently killed the script
# before it ever reached esptool, so the sourcing is fenced off and the result
# is checked explicitly instead.
source_idf_env() {
  local env_file="$HOME/esp/idf-env.sh"
  if [ ! -r "$env_file" ]; then
    echo "ESP-IDF environment script not found at $env_file." >&2
    exit 1
  fi

  set +e
  # shellcheck source=/dev/null
  . "$env_file"
  set -e

  if ! command -v idf.py >/dev/null 2>&1; then
    echo "Sourced $env_file but idf.py is still not on PATH." >&2
    exit 1
  fi
}

# Sets GLASSES_PORT and returns 0 when exactly one port is present, returns
# 1 when there are none, and exits when there are several.
find_port() {
  local ports=()
  local candidate
  for candidate in /dev/cu.usbmodem*; do
    [ -e "$candidate" ] && ports+=("$candidate")
  done

  if [ "${#ports[@]}" -gt 1 ]; then
    echo "Found ${#ports[@]} candidate ports, refusing to guess:" >&2
    printf '  %s\n' "${ports[@]}" >&2
    echo "Unplug the others and try again." >&2
    exit 1
  fi

  if [ "${#ports[@]}" -eq 0 ]; then
    return 1
  fi

  GLASSES_PORT="${ports[0]}"
  return 0
}

wait_for_port() {
  local timeout_seconds="${1:-30}"
  if find_port; then
    return 0
  fi

  echo "No /dev/cu.usbmodem* device found." >&2
  download_mode_help
  echo "Waiting up to ${timeout_seconds}s for the port to appear..." >&2

  local waited=0
  while [ "$waited" -lt "$timeout_seconds" ]; do
    sleep 1
    waited=$((waited + 1))
    if find_port; then
      echo "Found $GLASSES_PORT after ${waited}s."
      return 0
    fi
  done

  echo "Still no port after ${timeout_seconds}s — nothing was flashed." >&2
  exit 1
}
