# Handoff — Claude-authored Instagram DM drafts

Code is on the branch. Nothing in this file has been applied to the live project.
Do not treat a green test run as `LIVE`.

## Why this exists

Playlist Control (the Grok bot) enforces "Claude writes the drafts". It could never be true
for Instagram: `create_playlist_draft_inventory` only produced an `outreach_drafts` row for
email. Instagram targets became a copy-free manual packet, and the DM text was written later,
by hand, outside the Hub. Every `instagram_dm` row in `outreach_drafts` since early October is
`generated_by = grok_cos` (14 approved-unsent, 47 rejected, 30 sent on 2026-10-22). Zero were
Claude's. The 2026-10-22 pack of five went out only on an author waiver from Fendi.

After this change the Hub composes the DM itself, from approved Song DNA copy, under the
Claude discovery credential. The draft row is `generated_by = claude_playlist_discovery`. The
DM is still hand-sent from the artist phone; nothing here sends.

## Status going in

| Thing | State |
|---|---|
| Code | Commit `a22e314` on `claude/instagram-dm-drafts-qepfqd`. Not merged. Not deployed. |
| Migration `supabase/migrations/20261022160000_claude_ig_dm_drafts.sql` | Not applied. Live RPC still ignores `draft` on `instagram_dm` items. |
| `pitch_templates` rows with `channel = 'instagram_dm'` | 0 live (measured 2026-10-22). The composer falls back to the email template until the migration seeds them. |
| `mcp-playlist-discovery` live | Old code. Instagram items are still copy-free packets with no draft. |
| Validated locally | `deno test` on every deterministic `_shared` suite: 644 passed. `scripts/test-daily-ops-migrations.sh` against Postgres 16: all assertions pass, including the new `ig_*` ones. Not validated against the live project. |

## Hard rules

* No `supabase` CLI. A 403 there is a false wall.
* No supabase.com dashboard. SQL goes in the Lovable SQL editor for project
  `4778d2a5-781c-45e5-b165-9497cdba4918` (Supabase ref `vsemrziqxrrfcquxfnwd`).
* Do not ask Fendi to paste SQL.
* Edge functions go through Lovable → Edge Functions → redeploy. Name the function:
  `mcp-playlist-discovery`. No other function changes.
* No Publish is needed. This change has no frontend.
* **Apply the migration before the redeploy.** The new edge code sends `draft` on Instagram
  items; the old RPC silently drops it and stores a packet with no draft row. The old edge code
  against the new RPC is harmless (no `draft`, so the old behavior).
* Do not edit the migration to make it run. If it errors, stop and report the error.
* Do not insert `instagram_dm` templates by hand. The migration seeds them with
  `on conflict do nothing`.
* Do not backfill or rewrite the existing `grok_cos` drafts or their handoff records. They are
  untouched by this change on purpose.
* Do not approve, send, or record a receipt as part of this deploy.

## Step 1 — Apply the migration

Paste the full file `supabase/migrations/20261022160000_claude_ig_dm_drafts.sql` into the
Lovable SQL editor. One shot. It is idempotent.

### Step 1a — Verify it landed

```sql
select
  (select count(*) from public.pitch_templates where channel = 'instagram_dm' and is_active) as ig_templates,
  position('ig_dm_drafts' in pg_get_functiondef('public.agh_mcp_persist_playlist_inventory(uuid,uuid,jsonb,jsonb)'::regprocedure)) > 0 as rpc_has_ig_branch;
```

**Expected exactly one row:** `ig_templates` = **8**, `rpc_has_ig_branch` = **true**.

Before the migration this query returns `0` and `false` (measured on 2026-10-22). Any other
pair means the paste was partial. Do not continue to Step 2 until both values match.

## Step 2 — Redeploy `mcp-playlist-discovery`

Lovable → Edge Functions → redeploy `mcp-playlist-discovery`. Nothing else.

### Step 2a — Verify the function, not the draft

```bash
B=https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1
curl -s -o /dev/null -w '%{http_code}\n' "$B/mcp-playlist-discovery"
```

* `401` or `405` → deployed and refusing an anonymous call. Good.
* `404` → not deployed.

Then, from a Claude session with the AGH Playlist Discovery MCP server, list tools. The
`create_playlist_draft_inventory` description must contain the phrase
`server-composed instagram_dm`. The old description says `form/IG → manual packets`. If the old
text still shows, the redeploy did not land.

## Step 3 — The first real Instagram draft

Nothing to click. The next Claude station run that calls `create_playlist_draft_inventory`
with a `verified_eligible` Instagram target creates the first draft. The call now returns an
`ig_dm_drafts` array next to `email_drafts` and `manual_packets`.

### Step 3a — Verify from the database

```sql
select d.id as draft_id, d.generated_by, d.status, d.recipient, left(d.body, 60) as body_start,
       r.id as handoff_record_id, r.queue_state, r.drafted_by,
       (r.packet ? 'body') as packet_has_body,
       r.packet->>'outreach_draft_id' = d.id::text as packet_links_draft,
       d.metadata->>'handoff_record_id' = r.id::text as draft_links_record
from public.outreach_drafts d
join public.agh_handoff_records r on r.outreach_draft_id = d.id
where d.channel = 'instagram_dm'
  and d.generated_by = 'claude_playlist_discovery'
order by d.created_at desc
limit 10;
```

**Expected per row:** `generated_by` = `claude_playlist_discovery`, `status` = `pending`,
`recipient` starts with `@`, `queue_state` = `AWAITING_GROK_REVIEW`, `drafted_by` =
`claude_playlist_discovery`, `packet_has_body` = **false**, `packet_links_draft` = **true**,
`draft_links_record` = **true**. `body_start` must read like a DM, not an email: no
`Subject:` line, and it should open with the curator greeting from the `instagram_dm`
template.

Zero rows after a station run that reported `ig_dm_drafts` is a finding. Report the call's
response and this query's output. Do not insert a row to make it pass.

### Step 3b — Failure codes the station may now return

| code | meaning | what to do |
|---|---|---|
| `missing_stream_link` | The track has no streaming URL for the target's platform, so no DM can carry a link. | Fix the track's platform URL in the Hub, then re-run. Not a bug in this change. |
| `missing_ig_curator_account` | No valid handle on the target or from the composer. | The target needs re-verification. Not a bug in this change. |
| `ig_dm_compose_failed` (or a passthrough 4xx) | The composer refused: missing approved DNA pitch copy, no active template, or a policy block. | Read the error text. A `No pitch template configured` error means Step 1 did not seed the templates. |

## Step 4 — Tell Playlist Control

Post on the Grok bot's board that from the next station run Instagram drafts are
`generated_by = claude_playlist_discovery`, with the draft id on the handoff record
(`outreach_draft_id`) and in the packet. Grok reviews the record and approves the linked draft
exactly as it approves email drafts today. Enki hand-sends and records the receipt via
`record_ig_dm_receipt` as before. The author waiver from 2026-10-22 is no longer needed for new
drafts. The 14 older `grok_cos` drafts stay as they are.

## Report back

1. The Step 1a values: `ig_templates` and `rpc_has_ig_branch`.
2. Which function was redeployed (must be `mcp-playlist-discovery`) and the Step 2a HTTP status.
3. Whether the MCP tool description shows `server-composed instagram_dm`.
4. After the first station run: the `ig_dm_drafts` array from the response and the Step 3a rows.
   If no Instagram target was eligible that day, say so. Do not mark Step 3 verified.
5. Any Step 3b code returned, with its error text.

## Do not

* Do not mark this live because the Deno suite and migration script passed.
* Do not grant `anon` or `authenticated` execute on the RPC. The migration keeps it
  `service_role` only.
* Do not approve a Claude Instagram draft to "see it work". Approval is Grok's.
* Do not send a DM to test this. The receipt path is unchanged and separately verified in
  `fendi-control-center` `docs/HANDOFF_MUSE_IG_DM_RECEIPT.md`.
