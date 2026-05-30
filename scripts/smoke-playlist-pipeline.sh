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

# pitch_log rows must include curator_email when present (catches NOT NULL audit gap)
rows_gpl = gpl.get("rows") or []
missing_email = [r for r in rows_gpl if r.get("status") == "sent" and not (r.get("curator_email") or "").strip()]
if missing_email:
    errors.append(f"get_pitch_log: {len(missing_email)} sent row(s) missing curator_email")

if errors:
    print("FAIL:")
    for e in errors:
        print(" -", e)
    sys.exit(1)

print("PASS: get_pitch_log ok, no corrupted IG, no active Spotify curator rows in sample")
PY

# Optional E2E: patch → draft → approve+send → verify pitch_log row (requires hub key + test playlist)
if [[ "${SMOKE_E2E_SEND:-}" == "1" && -n "${FANFUEL_HUB_KEY:-}" ]]; then
  PID="${SMOKE_TEST_PLAYLIST_ID:?Set SMOKE_TEST_PLAYLIST_ID for SMOKE_E2E_SEND=1}"
  TRACK="${SMOKE_TEST_TRACK_NAME:-Designed For Me (Control)}"
  TEST_EMAIL="${SMOKE_TEST_EMAIL:-fendifrost@gmail.com}"
  echo "=== E2E send smoke (patch → draft → approve) ==="
  post "e2e_patch_email" "{\"action\":\"patch_target\",\"playlist_id\":\"$PID\",\"curator_email\":\"$TEST_EMAIL\"}"
  DRAFT_OUT="$TMP/e2e_draft.json"
  curl -sS -X POST "$CCA" "${HDR[@]}" -d "{\"action\":\"draft_pitch\",\"playlist_id\":\"$PID\",\"track_name\":\"$TRACK\"}" -o "$DRAFT_OUT"
  DRAFT_ID=$(python3 -c "import json; print(json.load(open('$DRAFT_OUT')).get('draft_id',''))")
  if [[ -z "$DRAFT_ID" ]]; then
    echo "FAIL: draft_pitch did not return draft_id"
    exit 1
  fi
  SEND_OUT="$TMP/e2e_send.json"
  curl -sS -X POST "$CCA" "${HDR[@]}" -d "{\"action\":\"approve_draft\",\"draft_id\":\"$DRAFT_ID\",\"send_immediately\":true}" -o "$SEND_OUT"
  python3 <<PY
import json, sys, time
send = json.load(open("$SEND_OUT"))
if not send.get("sent") or not send.get("pitch_log_id"):
    print("FAIL: approve_draft:", json.dumps(send)[:800])
    sys.exit(1)
if send.get("error"):
    print("FAIL: approve_draft error:", send["error"])
    sys.exit(1)
print("OK: sent=true pitch_log_id=", send.get("pitch_log_id"))
PY
  sleep 2
  post "e2e_get_pitch_log" "{\"action\":\"get_pitch_log\",\"track_name\":\"$TRACK\",\"limit\":5}"
  python3 <<PY
import json, glob, os
tmp = os.environ["TMP"]
gpl = {}
for f in glob.glob(os.path.join(tmp, "*get_pitch_log*.json")):
    gpl = json.load(open(f))
rows = [r for r in (gpl.get("rows") or []) if r.get("status") == "sent" and (r.get("curator_email") or "").strip()]
if not rows:
    print("FAIL: no sent pitch_log row with curator_email after E2E send")
    sys.exit(1)
print("OK: pitch_log sent row curator_email=", rows[0].get("curator_email"))
PY
  post "e2e_revert_email" "{\"action\":\"patch_target\",\"playlist_id\":\"$PID\",\"curator_email\":\"\"}"
  echo "E2E send smoke passed"
fi

echo "Optional (slow, uses Firecrawl):"
echo "  post quick research + enrich — see docs/LIVE_PITCH_TEST_FINDINGS_2026-05-29.md"
echo "Done. Manual E2E: docs/MANUAL_PITCH_PLAYBOOK_DEEP_HOUSE.md"
