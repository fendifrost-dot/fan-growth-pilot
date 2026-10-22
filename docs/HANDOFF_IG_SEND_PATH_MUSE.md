# Handoff — the approved Instagram path (Claude drafts → Grok approves → Muse sends)

Fendi, 2026-10-22: "Claude finds the curators and creates the message inside the Hub.
Grok approves it. Muse, which is approved to send on Facebook, goes in and actually sends
the messages. That is the path."

Until this change the Hub disagreed with that in two places: the Muse credential could only
record a receipt (it could not read what to send), and every Instagram draft was stamped
`send_mode = manual_from_artist_phone`, which Enki read as "not mine to send" and skipped.

## What this branch changes

| Where | Change |
|---|---|
| `_shared/ig-dm-send-queue.ts` (new) | `list_ig_dm_send_queue`: approved, unsent Instagram handoffs joined to their approved draft. Returns `dm_body`, `ig_handle`, ids, `send_owner: muse`, `receipt_action`, and per-row `blockers` / `sendable`. Read-only. |
| `_shared/handoff-queues.ts` | Registers and dispatches the action. |
| `_shared/outreach-auth.ts` | `MUSE_IG_ACTIONS` = `list_ig_dm_send_queue` + `mark_manual_ig_dm_submitted`. The Muse credential may call these two and nothing else. |
| `_shared/playlist-discovery-mcp.ts` | New Instagram drafts carry `send_mode: muse_instagram_send`, `send_owner: muse`. |
| `_shared/playlist-agent-run.ts` | Approving an Instagram draft now says Muse sends it from the queue, instead of "copy and DM manually". |
| Migration `20261022190000_ig_dm_send_owner_muse.sql` | Persist RPC stamps the same `send_mode` / `send_owner`; packets get `send_owner: muse`; restamps the Claude drafts created earlier today. Nothing sent, nothing approved. |
| `docs/MUSE_IG_RECEIPT.md` | Now documents both actions and the four-step path. |
| Tests | `ig-dm-send-queue.test.ts` (7 tests). Deterministic `_shared` suite: 651 passed. Migration CI script: passes, including `ig_send_owner_is_muse`. |

Control Center gets the matching read surface: `GET /executive/ig-send-queue` on
`muse-executive` proxies this action with the Muse secret. See
`fendi-control-center/docs/HANDOFF_MUSE_IG_SEND_QUEUE.md`.

## Status 2026-10-22 16:19 UTC — LIVE, verified from live output

| Thing | State |
|---|---|
| Code | `main` `fa9ca5a`. |
| Migration | Applied through Lovable's database tool. Check returned `rpc_names_sender` true, `claude_drafts_owned_by_muse` 5, `still_hand_send` 0. |
| `control-center-api`, `mcp-playlist-discovery` | Redeployed by the Lovable agent from `fa9ca5a`. Anonymous probe 401 (sign-in gate runs first, so it cannot name the action). |
| End-to-end | Control Center `GET /executive/ig-send-queue` (redeployed `muse-executive`, CC `main` `8438a9d`) returned 200 with `send_owner: muse`, 15 rows, 14 sendable: the five Claude drafts (Grok approved them 15:54–15:55 UTC) and nine older `grok_cos` rows; one older row blocked `draft_rejected`. Read with a one-use token that was revoked afterwards. |

Nothing below remains to be applied. Kept as the record and the re-check procedure.


## Hard rules

* No `supabase` CLI. No supabase.com dashboard. SQL goes through Lovable (project
  `4778d2a5-781c-45e5-b165-9497cdba4918`, Supabase ref `vsemrziqxrrfcquxfnwd`).
* Apply the migration first, then redeploy. Name both functions when you do.
* Do not edit the migration to make it run. If it errors, stop and report.
* Do not approve, send, or record a receipt to "test" this.

## Step 1 — Apply the migration

Paste `supabase/migrations/20261022190000_ig_dm_send_owner_muse.sql` in full. Verify:

```sql
select
  position('send_owner' in pg_get_functiondef('public.agh_mcp_persist_playlist_inventory(uuid,uuid,jsonb,jsonb)'::regprocedure)) > 0 as rpc_names_sender,
  (select count(*) from public.outreach_drafts where channel = 'instagram_dm' and generated_by = 'claude_playlist_discovery' and metadata->>'send_owner' = 'muse') as claude_drafts_owned_by_muse,
  (select count(*) from public.outreach_drafts where channel = 'instagram_dm' and generated_by = 'claude_playlist_discovery' and metadata->>'send_mode' = 'manual_from_artist_phone') as still_hand_send;
```

**Expected:** `rpc_names_sender` = true, `claude_drafts_owned_by_muse` ≥ 5 (the five from
2026-10-22 plus any since), `still_hand_send` = 0.

## Step 2 — Redeploy `control-center-api` and `mcp-playlist-discovery`

Lovable → Edge Functions → redeploy both. Verify the action exists without a credential:

```bash
B=https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$B/control-center-api" \
  -H 'Content-Type: application/json' -d '{"action":"list_ig_dm_send_queue"}'
```

**Expected:** `403` (known action, anonymous denied). A `403` whose body says
`Unknown action` means the redeploy did not land. `404` means the function is not deployed.

With the Muse secret (Control Center holds it; never paste it here):

```bash
curl -s -X POST "$B/control-center-api" -H "x-muse-ig-receipt-secret: $MUSE_IG_RECEIPT_SECRET" \
  -H 'Content-Type: application/json' -d '{"action":"list_ig_dm_send_queue"}'
```

**Expected:** `200`, `send_owner` = `muse`, and one row per approved unsent Instagram
handoff. On 2026-10-22 that is the 10 older `grok_cos` rows (all `sendable: true` if their
drafts are approved) plus whichever of today's five Grok has approved.

## Step 3 — Tell Grok Bot and Enki

Post on the Control Center board (mission `6f14b53d-4c16-49ec-a475-a1bf94229499`):

* Instagram DMs are sent by Muse. There is no hand-send lane and no author waiver.
* Grok reviews the record and approves the draft in the Hub, as for email. Grok's pack
  note should say "send via Muse" and list the `handoff_record_id`s.
* Enki reads `GET /executive/ig-send-queue` on Control Center (or the Hub action directly),
  sends each `sendable` row's `dm_body` to `ig_handle`, then records the receipt with
  `record_ig_dm_receipt` (which forwards `mark_manual_ig_dm_submitted`). Rows with
  `blockers` are skipped and reported, not sent.

## Report back

1. The three Step 1 values.
2. Which functions were redeployed and the anonymous `403` body.
3. The `sendable_count` and `total_count` from the Muse-credential read, without the row text.
4. The first SENT receipt that comes back through the queue, with its `handoff_record_id`.
