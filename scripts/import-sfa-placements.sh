#!/usr/bin/env bash
# Import Spotify for Artists playlist CSV into playlist_targets via control-center-api.
# Usage:
#   FANFUEL_HUB_URL=https://xxx.supabase.co/functions/v1/control-center-api \
#   FANFUEL_HUB_KEY=... \
#   ./scripts/import-sfa-placements.sh "/path/to/Fendi Frost-playlists-1year.csv" [period_label]

set -euo pipefail
CSV_PATH="${1:?CSV path required}"
PERIOD="${2:-1year}"
HUB_URL="${FANFUEL_HUB_URL:?Set FANFUEL_HUB_URL}"
HUB_KEY="${FANFUEL_HUB_KEY:?Set FANFUEL_HUB_KEY}"

CSV_JSON=$(python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' < "$CSV_PATH")

curl -sS -X POST "$HUB_URL" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $HUB_KEY" \
  -d "{\"action\":\"import_spotify_for_artists_csv\",\"csv_text\":$CSV_JSON,\"period_label\":\"$PERIOD\",\"lane\":\"deep_house_groove\"}" \
  | python3 -m json.tool
