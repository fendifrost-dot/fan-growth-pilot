#!/usr/bin/env bash
# rerun-deep-house-enrichment.sh
#
# One-shot: re-runs the v2 curator-email discovery pipeline (added in
# commit 523e5e3) against the 18 deep-house playlist_targets rows that
# were soft-deactivated overnight.
#
# What it does:
#   1. Lists the deactivated deep_house_groove rows from playlist_targets.
#   2. Calls enrich-curator-contacts with include_inactive=true and
#      reactivate_on_success=true. The expanded chain runs as fallback
#      after the existing Spotify→Linktree→IG pipeline. Rows where a
#      verified email surfaces are reactivated (is_active=true,
#      curator_email set, submission_method='email').
#   3. Prints a per-row breakdown of which strategy hit (or which all
#      failed) — useful for the audit trail.
#
# Required env:
#   FANFUEL_HUB_KEY   server-to-server hub key (lives in Lovable
#                     Supabase Edge secrets; surface it via `supabase
#                     secrets list` or the Lovable Project Settings →
#                     Backend → Edge Function Secrets panel).
#
# Optional env:
#   SUPABASE_URL      defaults to the fan-growth-pilot prod project.
#   BATCH_SIZE        per-call limit; the edge function caps at 12. Set
#                     up to 12 to enrich all 18 in two batches.
#
# Usage:
#   FANFUEL_HUB_KEY="<key>" ./scripts/rerun-deep-house-enrichment.sh
#
set -euo pipefail

: "${FANFUEL_HUB_KEY:?Set FANFUEL_HUB_KEY (from Lovable edge secrets)}"
SUPABASE_URL="${SUPABASE_URL:-https://vsemrziqxrrfcquxfnwd.supabase.co}"
BATCH_SIZE="${BATCH_SIZE:-12}"

API="$SUPABASE_URL/functions/v1"

echo "==> Fetching the deactivated deep_house_groove rows…"
LIST_RESP=$(curl -fsSL -X POST "$API/control-center-api" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $FANFUEL_HUB_KEY" \
  -d '{"action":"list_targets","lane":"deep_house_groove","include_inactive":true}')
# list_targets only returns is_active=true rows currently; fall back to
# direct PostgREST via service-side proxy if the response is empty.
echo "$LIST_RESP" | python3 -m json.tool | head -30 || true

# We don't trust list_targets to surface inactive rows (the helper hard-codes
# is_active=true). Drive the enrichment directly by lane + include_inactive
# instead — the new code path queries inactive rows when asked.

echo ""
echo "==> Round 1 — first $BATCH_SIZE rows…"
R1=$(curl -fsSL -X POST "$API/enrich-curator-contacts" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $FANFUEL_HUB_KEY" \
  -d "{
    \"lane\": \"deep_house_groove\",
    \"include_inactive\": true,
    \"reactivate_on_success\": true,
    \"run_expanded_strategies\": true,
    \"limit\": $BATCH_SIZE,
    \"offset\": 0
  }")
echo "$R1" | python3 -m json.tool

R1_ENRICHED=$(echo "$R1" | python3 -c "import sys,json;print(json.load(sys.stdin).get('enriched',0))")
R1_REACT=$(echo "$R1" | python3 -c "import sys,json;print(json.load(sys.stdin).get('reactivated',0))")
R1_DONE=$(echo "$R1" | python3 -c "import sys,json;print(json.load(sys.stdin).get('done',True))")

if [ "$R1_DONE" = "False" ]; then
  echo ""
  echo "==> Round 2 — next batch…"
  R2=$(curl -fsSL -X POST "$API/enrich-curator-contacts" \
    -H "Content-Type: application/json" \
    -H "x-api-key: $FANFUEL_HUB_KEY" \
    -d "{
      \"lane\": \"deep_house_groove\",
      \"include_inactive\": true,
      \"reactivate_on_success\": true,
      \"run_expanded_strategies\": true,
      \"limit\": $BATCH_SIZE,
      \"offset\": $BATCH_SIZE
    }")
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
