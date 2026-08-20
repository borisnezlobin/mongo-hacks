#!/bin/bash
# Grid over the simultaneity penalty and the merge threshold, for one window
# geometry, reporting the landmark verdicts for every cell.
#
# The question this exists to answer is not "which cell is best" but whether any
# (penalty, threshold) is good at MORE THAN ONE window size. A mechanism that
# peaks in a different cell for every geometry is fitted, however good the peak.
#
#   eval/real/penalty_sweep.sh <stem> <window> <hop> [penalties] [thresholds]
set -u
cd "$(dirname "$0")/../.."
export HF_TOKEN=$(grep -m1 '^HF_TOKEN=' .env | cut -d= -f2-)
stem=$1; w=$2; h=$3
penalties=${4:-0,0.25,0.5,1.0,2.0}
thresholds=${5:-0.2,0.3,0.4,0.5}

PYTHONPATH=eval/real sidecar/.venv/bin/python eval/real/sortformer_pooled.py \
  "$stem" --window "$w" --hop "$h" --thresholds="$thresholds" --penalties="$penalties" \
  2>/dev/null | grep -E '^penalty' | while read -r line; do
  pen=$(echo "$line" | sed -E 's/penalty ([0-9.]+).*/\1/')
  thr=$(echo "$line" | sed -E 's/.*threshold ([0-9.]+).*/\1/')
  people=$(echo "$line" | sed -E 's/.*: ([0-9]+) people.*/\1/')
  f=$(echo "$line" | sed 's/.*-> //')
  lm=$(npx tsx eval/real/landmark-check.mts "$stem" "$f" 2>/dev/null | sed -n 2p | tr -s ' ')
  sc=$(sidecar/.venv/bin/python eval/real/score_diarization.py "$f" "$stem" 2>/dev/null \
       | sed -n 2p | sed -E 's/.*(DER +[0-9.]+%).*(conf [0-9.]+%).*/\1 \2/')
  printf "%-9s %-6s %-6s %-8s %-26s %s\n" "${w}s/${h}s" "$pen" "$thr" "$people" "$lm" "$sc"
done
