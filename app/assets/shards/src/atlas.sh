#!/usr/bin/env bash
# Pack the 16-bit renders into two 8-bit 2048x2048 atlases plus atlas.json, and
# cut the static shard mark. Run after render.sh.
#
#   ./atlas.sh              packs app/assets/shards/
#   DIR=../preview ./atlas.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="$(cd "${DIR:-$HERE/..}" && pwd)"
ATLAS=2048
TILE=512
COLUMNS=$((ATLAS / TILE))
MARK_SIZE=192
MARK_SHARD="${MARK_SHARD:-shard-14}"

shards=()
while IFS= read -r file; do shards+=("$(basename "$file" .png)"); done \
  < <(find "$DIR" -maxdepth 1 -name 'shard-[0-9][0-9].png' | sort)

if [[ ${#shards[@]} -eq 0 ]]; then
  echo "atlas.sh: no shard-NN.png in $DIR — run render.sh first" >&2
  exit 1
fi
if [[ ${#shards[@]} -gt $((COLUMNS * COLUMNS)) ]]; then
  echo "atlas.sh: ${#shards[@]} shards will not fit a ${COLUMNS}x${COLUMNS} atlas" >&2
  exit 1
fi

pack() {
  local suffix="$1" out="$2"
  local inputs=()
  for id in "${shards[@]}"; do inputs+=("$DIR/${id}${suffix}.png"); done
  magick montage "${inputs[@]}" \
    -tile "${COLUMNS}x${COLUMNS}" -geometry "${TILE}x${TILE}+0+0" \
    -background none -depth 8 "PNG32:$out"
  magick "$out" -background none -extent "${ATLAS}x${ATLAS}" -depth 8 "PNG32:$out"
}

pack "" "$DIR/beauty.png"
pack "-normal" "$DIR/normal.png"

{
  echo '{'
  echo "  \"size\": $ATLAS,"
  echo "  \"tile\": $TILE,"
  echo '  "beauty": "beauty.png",'
  echo '  "normal": "normal.png",'
  echo '  "frames": {'
  last=$((${#shards[@]} - 1))
  for i in "${!shards[@]}"; do
    x=$(((i % COLUMNS) * TILE))
    y=$(((i / COLUMNS) * TILE))
    comma=","
    [[ $i -eq $last ]] && comma=""
    echo "    \"${shards[$i]}\": { \"x\": $x, \"y\": $y, \"w\": $TILE, \"h\": $TILE }$comma"
  done
  echo '  }'
  echo '}'
} > "$DIR/atlas.json"

# The static mark: one shard over a soft red-orange glow.
magick -size "${MARK_SIZE}x${MARK_SIZE}" radial-gradient:'#FF6A3D'-'#FF4A1C00' \
  -alpha set -channel A -evaluate multiply 0.85 +channel \
  \( "$DIR/${MARK_SHARD}.png" -resize "$((MARK_SIZE * 78 / 100))x$((MARK_SIZE * 78 / 100))" \) \
  -gravity center -compose over -composite \
  -depth 8 "PNG32:$DIR/shard-mark.png"

echo "atlas.sh: packed ${#shards[@]} shards into $DIR/{beauty,normal}.png + atlas.json + shard-mark.png"
