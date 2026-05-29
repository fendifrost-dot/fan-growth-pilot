#!/usr/bin/env bash
# Smoke-test playlist pipeline via control-center-api (no secrets in repo).
set -euo pipefail

CCA="${CCA:-https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/control-center-api}"
HDR=(-H "content-type: application/json")
if [[ -n "${FANFUEL_HUB_KEY:-}" ]]; then
  HDR+=(-H "x-api-key: $FANFUEL_HUB_KEY")
fi

post() {
  local label="$1"
  local body="$2"
  echo "=== $label ==="
  curl -sS -X POST "$CCA" "${HDR[@]}" -d "$body" | head -c 2000
  echo -e "\n"
}

post "list_targets (deep_house)" '{"action":"list_targets","lane":"deep_house_groove","limit":5}'
post "connect_spotify_status" '{"action":"connect_spotify_status"}'
post "quick research" '{"action":"run_playlist_research","track_name":"Designed For Me (Control)","lane":"deep_house_groove","references":["Kaytranada"],"user_vibe":"deep house","quick":true}'
post "enrich batch" '{"action":"enrich_curator_contacts","track_name":"Designed For Me (Control)","lane":"deep_house_groove","limit":5,"offset":0}'

echo "Done. For draft/send: patch_target → draft_pitch → approve_draft (see docs/PLAYLIST_PITCH_FAST_PATH.md)"
