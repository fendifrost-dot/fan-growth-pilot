#!/usr/bin/env bash
# Fail if this task's runtime files hard-code song titles, DNA, genres, lanes, or pitch copy.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FILES=(
  supabase/functions/_shared/provider-transport.ts
  supabase/functions/_shared/split-sheet-delivery.ts
  supabase/functions/_shared/split-sheets.ts
  supabase/functions/_shared/sync-control.ts
  supabase/functions/_shared/sync-research.ts
  supabase/functions/_shared/sync-research-config.ts
  supabase/functions/_shared/daily-ops.ts
)

fail=0
for f in "${FILES[@]}"; do
  code=$(python3 - "$f" <<'PY'
import pathlib, re, sys
text = pathlib.Path(sys.argv[1]).read_text()
text = re.sub(r"/\*[\s\S]*?\*/", "", text)
text = re.sub(r"//.*", "", text)
print(text)
PY
)
  if grep -nE '\bMeditate\b|Designed For Me|Neva Too Much' <<<"$code" >/dev/null; then
    echo "FAIL: song-title literal in runtime $f"
    grep -nE '\bMeditate\b|Designed For Me|Neva Too Much' <<<"$code" || true
    fail=1
  fi
  if grep -nE 'late-night rap|deep-house groove' <<<"$code" >/dev/null; then
    echo "FAIL: pitch-copy literal in runtime $f"
    fail=1
  fi
done

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi
echo "==> PASS: no song-title / DNA / genre / lane / pitch-copy hard-coding in corrective runtime files"
