# Pipeline follow-up: live PLC check, the response overwrite writer, route recertification (2026-09-30)

This builds on PR #43 (`20260930190000_pipeline_repair.sql`). Nothing in #42 or #43 is changed. The
migration is forward-only. It sends no outreach and moves no records.

## 1. Live PLC verification (read-only, 2026-09-30)

These checks used the Lovable database and the discovery connector.

**Database side: live.**
- `agh_pipeline_health()` returns `version 2026-09-30.2`, `record_review`, `manual_receipts` and
  `response_audit` all true.
- Triggers `agh_guard_draft_policy`, `agh_log_manual_submission` and `agh_preserve_pitch_response` are
  installed.
- `pitch_log` = 390 rows and `agh_handoff_records` = 1191 rows. Both match #43's preservation proof.

**Edge side of #43: NOT live.**
- The live `per_song_funnel` still undercounts. Meditate shows 227 rejected / 191 pending, but the
  database has 260 / 208.
- There are 1,191 handoff records, and the old unpaginated query stops at 1,000 rows.
- So #43's edge code has not been redeployed. That code covers:
  - pagination;
  - `approve_handoff_records` / `reject_handoff_records`;
  - the `pipeline_health` / `get_quota` actions;
  - the `execute-pitch` dispatch rechecks.
- **Redeploy the 12 edge functions listed under Deploy below.** Every function that imports a file #43
  or this change touched is on that list (found with `deno info`).

## 2. The historical response overwrite (incident `ops_incidents aa07270d`)

**What happened.** Two rows were rewritten between 9/28 ~8 PM CT and 9/29 ~9:30 AM CT:
- DigiIndie `2ccb1e2e`: `accepted_free_promo` became `placed` with `placed=false`, and the notes were
  replaced by one line.
- Geovio `f51a90f6`: the status became `replied`.

**Finding (strong inference, not proof).**
- **Code paths.** The only code path that writes `pitch_log.placement_status` is `mark_pitch_response`
  (`_shared/playlist-agent-run.ts`). Its documented values are `replied | declined | blocked | placed`,
  which are exactly the values found on both rows.
- **What it did.** Before #43's trigger it replaced `placement_status`, `placed` and `response_notes`
  wholesale. Without a `pitch_log_id`, it resolved "the latest row for this playlist", which could be a
  different song's row.
- **Other writer ruled out.** The other response writer, `update-pitch-status`, sets `status` to
  `responded`/`rejected`. No row has either value, so it is not the writer of these changes.
- **Who can call it.** `mark_pitch_response` needs `classify_replies`, which only Grok
  (`grok_playlist_control`, the PLC), Fendi and human admin hold.
- **Timing.** The window matches the PLC inbox routine that was recording replies. Incident `572d81f4`
  documents that routine acting on the Geovio thread on 9/28.
- **Why it can't be proven.** There is no request log for these actions, and `pitch_log` has no
  history. #43's trigger records future writes as `unattributed:<db user>`, because every edge function
  shares one database role.

**Fix (this change).**
- **`agh_update_pitch_response(p_id, p_patch, p_actor)`.** It sets `agh.response_actor` for the
  transaction, so #43's trigger now records the real caller: for example
  `grok_playlist_control:mark_pitch_response` or `hub_key:update-pitch-status`. Only response fields
  can be written, and #43's append/protect rules are unchanged.
- **`mark_pitch_response`** writes through that RPC. A lookup by playlist only, spanning more than one
  song, now returns `409 ambiguous_pitch_log_row` instead of guessing.
- **`update-pitch-status`** writes notes through the RPC, and blank notes no longer wipe existing notes.
- **Fallback.** Both fall back to the previous direct write only if the migration is not applied yet.
  The fallback is labelled `attribution: unavailable_migration_missing`.

## 3. Route-verification hardening

**Live state (read-only).** 201 targets still carry `path_verified=true` but fail the shared route rule:
- 143 `web_form` / `missing_form_url`;
- 57 `evidence_not_linked_to_form`;
- 1 `no_route_channel`.

Six of them have open packets.

**Impact today.** The flags are stale, not dangerous.
- Inventory, approval (`approve_handoff_records` → `checkTargetSubmissionReady`), manual submit and send
  all re-run the route rule.
- The SQL approval gate `agh_record_can_approve` checks only the flag, so it depends on that app-layer
  check.

**Audit of in-flight records.** `agh_route_hold_audit(false)` flags 203 records. Almost all are already
in repair batches. Three are still in `AWAITING_GROK_REVIEW` with `target_inactive`, in batches
`0ec7496f`, `27b5187c` and `169812c8`. Approval refuses them.

**Fix (this change).** `agh_route_recertify_targets(p_apply boolean default false)`:
- the preview lists failing targets by code;
- the apply sets `path_verified=false` with a `ROUTE_RECERT:` note that keeps the prior note;
- `verification_status` is not changed and no records move.

Demoted rows that a human marked `manually_verified` then show up in
`get_playlist_discovery_work.manually_verified_supply` for re-verification.

## Deploy (Lovable only)

1. **SQL:** `20260930210000_response_attribution_route_recert.sql`. Apply it after
   `20260930190000`, as one transaction.
2. **Route recert:** run `select public.agh_route_recertify_targets(false);`. Apply `(true)` only if the
   preview is still about 201 targets with the codes above.
3. **Redeploy the 12 edge functions** (#43's edge code plus this change):
   `approve-draft`, `control-center-api`, `draft-pitch`, `enrich-curator-contacts`, `execute-pitch`, `mcp-playlist-discovery`, `mcp-sync-discovery`, `playlist-admin-api`, `playlist-research`, `schedule-follow-up`, `send-pitch-email`, `update-pitch-status`.

## Not changed

- The #42 inventory planning, including the fact that `usable_inflight_packets` makes the discovery
  need 0 while more than 500 packets await review.
- The #43 gates and triggers.
- Grok's approval and sending ownership.
