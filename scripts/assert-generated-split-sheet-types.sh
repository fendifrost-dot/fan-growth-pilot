#!/usr/bin/env bash
# Fail if required generated Supabase types disappear again (7037ae2 regression).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TYPES="$ROOT/src/integrations/supabase/types.ts"

if [[ ! -f "$TYPES" ]]; then
  echo "FAIL: $TYPES missing"
  exit 1
fi

need() {
  local pat="$1"
  if ! grep -q "$pat" "$TYPES"; then
    echo "FAIL: generated types missing required definition: $pat"
    exit 1
  fi
  echo "OK: $pat"
}

need 'split_sheet_master_owners:'
need 'split_sheet_evidence:'
need 'split_sheet_deliveries:'
need 'rights_document_audit_events:'
need 'splits_ready:'
need 'splits_ready_legacy:'
need 'splits_ready_source:'
need 'current_split_sheet_id:'
need 'split_sheet_delivery_policy:'
need 'document_kind:'
need 'document_hash:'
need 'verification_status:'
need 'signer_contributor_id:'
need 'object_bytes_sha256:'
need 'provider_message_id:'
need 'send_idempotency_key:'

echo "==> PASS: required generated split-sheet / track types are present"
