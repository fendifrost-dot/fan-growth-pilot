#!/usr/bin/env bash
# rerun-deep-house-enrichment.sh
#
# One-shot: re-runs the v2 curator-email discovery pipeline (added in
# commit 523e5e3) against the 18 deep-house playlist_targets rows that
# were soft-deactivated overnight.
#
# What it does:
#   1. Calls enrich-curator-contacts with include_inactive=true and
#      reactivate_on_success=true. The expanded chain runs as fallback
#      after the existing Spotify→Linktree→IG pipeline. Rows where a
#      verified email surfaces are reactivated (is_active=true,
#      curator_email set, submission_method='email').
#   2. Prints a per-row breakdown of which strategy hit (or which all
#      failed) — useful for the audit trail.
#
# Auth: enrich-curator-contacts now accepts internal (un-keyed) calls —
# same loosening pattern as control-center-api (commit b03f00d) and
# execute-pitch. No FANFUEL_HUB_KEY required. Service-role mutations
# behind the function still enforce DB safety.
#
# Optional env:
#   SUPABASE_URL      defaults to the fan-growth-pilot prod project.
#   BATCH_SIZE        per-call limit; the edge function caps at 12. Set
#                     up to 12 to enrich all 18 in two batches.
#   FANFUEL_HUB_KEY   only used if explicitly set (back-compat path).
#
# Usage:
#   ./scripts/rerun-deep-house-enrichment.sh
#
set -euo pipefail

SUPABASE_URL="${SUPABASE_URL:-https://vsemrziqxrrfcquxfnwd.supabase.co}"
BATCH_SIZE="${BATCH_SIZE:-12}"

API="$SUPABASE_URL/functions/v1"

# Optional auth: only sent if the caller has explicitly set the env var.
AUTH_HEADER=()
if [ -n "${FANFUEL_HUB_KEY:-}" ]; then
  AUTH_HEADER=(-H "x-api-key: $FANFUEL_HUB_KEY")
fi

run_batch() {
  local offset="$1"
  curl -fsSL -X POST "$API/enrich-curator-contacts" \
    -H "Content-Type: application/json" \
    "${AUTH_HEADER[@]}" \
    -d "{
      \"lane\": \"deep_house_groove\",
      \"include_inactive\": true,
      \"reactivate_on_success\": true,
      \"run_expanded_strategies\": true,
      \"limit\": $BATCH_SIZE,
      \"offset\": $offset
    }"
}

echo "==> Round 1 — first $BATCH_SIZE rows…"
R1=$(run_batch 0)
echo "$R1" | python3 -m json.tool

R1_ENRICHED=$(echo "$R1" | python3 -c "import sys,json;print(json.load(sys.stdin).get('enriched',0))")
R1_REACT=$(echo "$R1" | python3 -c "import sys,json;print(json.load(sys.stdin).get('reactivated',0))")
R1_DONE=$(echo "$R1" | python3 -c "import sys,json;print(json.load(sys.stdin).get('done',True))")

if [ "$R1_DONE" = "False" ]; then
  echo ""
  echo "==> Round 2 — next batch…"
  R2=$(run_batch "$BATCH_SIZE")
  echo "$R2" | python3 -m json.tool
  R2_ENRICHED=$(echo "$R2" | python3 -c "import sys,json;print(json.load(sys.stdin).get('enriched',0))")
  R2_REACT=$(echo "$R2" | python3 -c "import sys,json;print(json.load(sys.stdin).get('reactivated',0))")
else
  R2_ENRICHED=0
  R2_REACT=0
fi

TOTAL_ENRICHED=$((R1_ENRICHED + R2_ENRICHED))
TOTAL_REACT=$((R1_REACT + R2_REACT))

echo ""
echo "============================================================"
echo "SUMMARY"
echo "  Rows touched (enrichment ran):  $TOTAL_ENRICHED"
echo "  Rows reactivated (email found): $TOTAL_REACT"
echo "============================================================"
echo ""
echo "Per-row breakdown is in the JSON 'results' array above —"
echo "each row's 'attempts' list shows which strategies tried and"
echo "what they returned (found / not_found / error)."
