# Live acceptance plan — mocked / non-send verification

**Purpose:** prove the corrective split-sheet + sync transport stack without sending real email, finalizing production sheets, or changing campaign state.

Do this only after the Lovable SQL apply + `control-center-api` redeploy (see [`HANDOFF_CLAUDE_SPLIT_SHEET_LOVABLE_SQL.md`](./HANDOFF_CLAUDE_SPLIT_SHEET_LOVABLE_SQL.md)).

## Environment

- Keep `AGH_PROVIDER_TEST_MODE=1` (or `AGH_TEST_MODE=1`) for the acceptance window if exercising send actions against the live project. If those flags are unset, Resend will be called — **do not unset them for this plan**.
- Do not rotate secrets.
- Do not approve Song DNA, samples, sync eligibility, or delivery authorization as Claude.

## What to verify (read / mocked only)

1. **Generated types** — `/admin` TypeScript surfaces still compile; split-sheet tables and `tracks.splits_ready_*` exist.
2. **Operating scope** — discovery work lists only `active_research ∩ operating_scope_track_ids`. Designed For Me stays out of new drafts. Do not flip its status.
3. **Evidence honesty** — upload a fixture file on a **non-production / draft** sheet if one exists; confirm `verification_status=unverified` and `document_kind` did not become signed. Do not verify it unless Fendi is performing the check.
4. **Claude download denial** — Claude `get_split_sheet_signed_url` returns 403 `claude_document_download_denied`.
5. **Delivery packet vs send** — if Fendi later grants a test authorization on a disposable sheet:
   - `web_form` → `awaiting_manual_submission`, `sent=false`
   - `email` in test mode → `sent` only with `provider_message_id` prefixed `test_`
   - failure flag → `delivery_result=failed`, retryable
6. **Sync submit** — Grok `submit_sync_outreach` / `execute_sync_pitch` in test mode (or `dry_run: true`):
   - email → `submitted` only after mock provider id; `licensing_pitch_log` row with `approved_by` / `sent_by` / `from_address`
   - `dry_run: true` → preview From (`Fendi Frost <pitches@fendifrost.com>` unless `FROM_EMAIL` is set); no send, no log
   - web_form → `awaiting_manual_submission` until `record_manual_sync_outreach_submission`
   - caller `subject`/`body` rejected
7. **Acceptance SQL** — re-run `docs/sql/split_sheet_non_send_acceptance.sql`. Zero false-ready tracks. Zero email `sent` rows without provider id.

## Explicitly out of scope

- Real Resend sends
- Inbox reply handling (Grok’s lane)
- Finalizing or rewriting a production final sheet
- Expanding operating scope
- Activating Designed For Me
- Claiming a signed URL is delivery
