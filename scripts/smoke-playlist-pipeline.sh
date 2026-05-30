#!/usr/bin/env bash
# Smoke-test playlist pipeline via control-center-api (deploy gate).
set -euo pipefail

CCA="${CCA:-https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/control-center-api}"
HDR=(-H "content-type: application/json")
if [[ -n "${FANFUEL_HUB_KEY:-}" ]]; then
  HDR+=(-H "x-api-key: $FANFUEL_HUB_KEY")
fi

TMP=$(mktemp -d)
export TMP
trap 'rm -rf "$TMP"' EXIT

post() {
  local label="$1"
  local body="$2"
  local out="$TMP/$(echo "$label" | tr ' /' '__').json"
  echo "=== $label ==="
  curl -sS -X POST "$CCA" "${HDR[@]}" -d "$body" -o "$out"
  head -c 1500 "$out"
  echo -e "\n"
}

post "list_targets (deep_house)" '{"action":"list_targets","lane":"deep_house_groove"}'
post "connect_spotify_status" '{"action":"connect_spotify_status"}'
post "get_pitch_log" '{"action":"get_pitch_log","limit":3}'

echo "=== deploy gate checks ==="
python3 <<'PY'
import json, sys, glob, os

tmp = os.environ["TMP"]
files = glob.glob(os.path.join(tmp, "*.json"))
errors = []

def load(name_part):
    for f in files:
        if name_part in f:
            with open(f) as fh:
                return json.load(fh)
    return {}

# get_pitch_log
gpl = load("get_pitch_log")
if gpl.get("error") and "Unknown action" in str(gpl.get("error", "")):
    errors.append("get_pitch_log: action missing — redeploy control-center-api")

# list_targets corruption
lt = load("list_targets")
rows = lt.get("rows") or []
path_kws = {
    "reel", "reels", "p", "explore", "stories", "share", "accounts", "direct", "tv",
    "popular", "spotify",
}
bad_ig = [r for r in rows if (r.get("curator_instagram") or "").lower() in path_kws
          or (r.get("curator_instagram") or "").lower().startswith("spotify")
          or "." in (r.get("curator_instagram") or "")]
if bad_ig:
    errors.append(f"list_targets: {len(bad_ig)} corrupted IG handle(s) — run backfill SQL")

spotify_curators = [r for r in rows if (r.get("curator_name") or "").strip() == "Spotify"]
if spotify_curators:
    errors.append(f"list_targets: {len(spotify_curators)} active Spotify-owned row(s) — run deactivate SQL")

editorial_ids = [r for r in rows if (r.get("playlist_id") or "").lower().startswith("spotify:37i9dqzf")]
if editorial_ids:
    errors.append(f"list_targets: {len(editorial_ids)} active 37i9dQZF editorial playlist(s) — run deactivate SQL")

artist_ig = {"kaytranada", "channeltres", "sglewis", "disclosure", "honeydijon"}
bad_artist_ig = [r for r in rows if (r.get("curator_instagram") or "").lower().replace("@", "") in artist_ig]
if bad_artist_ig:
    errors.append(f"list_targets: {len(bad_artist_ig)} row(s) with artist-name IG handle — run clear_artist_ig_handles SQL")

if errors:
    print("FAIL:")
    for e in errors:
        print(" -", e)
    sys.exit(1)

print("PASS: get_pitch_log ok, no corrupted IG, no active Spotify curator rows in sample")
PY

echo "Optional (slow, uses Firecrawl):"
echo "  post quick research + enrich — see docs/LIVE_PITCH_TEST_FINDINGS_2026-05-29.md"
echo "Done. Manual E2E: docs/MANUAL_PITCH_PLAYBOOK_DEEP_HOUSE.md"
