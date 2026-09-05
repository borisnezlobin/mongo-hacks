#!/usr/bin/env bash
# Render the shard set. Pass --preview for a fast 256 px / 64 sample pass.
#   ./render.sh                 final 512 px, 256 samples, into app/assets/shards/
#   ./render.sh --preview       preview into app/assets/shards/preview/
set -euo pipefail

BLENDER="${BLENDER:-/Applications/Blender 5.2.app/Contents/MacOS/Blender}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${1:-}" == "--preview" ]]; then
  shift
  OUT="${OUT:-$HERE/../preview}"
  EXTRA=(--preview)
else
  OUT="${OUT:-$HERE/..}"
  EXTRA=(--size 512 --samples "${SAMPLES:-256}" --save-blend "$HERE/shards.blend")
fi

mkdir -p "$OUT"
"$BLENDER" --background --factory-startup \
  --python "$HERE/render_shards.py" -- \
  --out "$OUT" --seed "${SEED:-7}" --count "${COUNT:-14}" "${EXTRA[@]}" "$@"
