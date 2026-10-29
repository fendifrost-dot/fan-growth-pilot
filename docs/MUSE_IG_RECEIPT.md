# Muse on the Instagram path (send queue + receipt)

The approved Instagram pitch path, as the Hub enforces it:

| Step | Who | Hub action | Credential |
|---|---|---|---|
| 1. Find the curator and compose the DM inside the Hub | Claude | `create_playlist_draft_inventory` (MCP) | `claude_playlist_discovery` |
| 2. Review the handoff record and approve the draft | Grok Playlist Control | `review_handoff_records` / `approve_handoff_records`, `approve_draft` | `grok_playlist_control` |
| 3. Send when the pre-send gate passes | Outreach scheduler | `dispatch_ig_curator_sends` | `x-outreach-scheduler-secret` |
| 4. Receipt is the send log | Dispatcher | `agh_ig_dm_send_log` plus the handoff stamp | service role |

Muse is not a reviewer and is not asked to confirm a send. Fendi's approval is the
shared pre-send gate. When that gate marks a row sendable, `dispatch_ig_curator_sends`
claims it and sends it. The kill switch is `IG_CURATOR_SEND_ENABLED=true` (anything
else pauses every send). The daily cap is `IG_CURATOR_DAILY_CAP` (default 10, America/Chicago).

`list_ig_dm_send_queue` is a status read. It is not a pack to send by hand.
`warnings` may include `terms_unconfirmed` ("confirm paid status on reply"). That
warning does not block the DM body. A blocker still withholds `dm_body`.

The old per-send confirmation lived in `approve_draft`: an Instagram draft returned
`needs_manual_dm` and the body, and this document told Enki to send each sendable
row and then call `mark_manual_ig_dm_submitted`. That handoff is what a scheduler
could list twice (the 2026-10-14 duplicate batch). It is gone.

## Credential

Set `MUSE_IG_RECEIPT_SECRET` on the Hub (`control-center-api`). The value must be distinct
from `FANFUEL_HUB_KEY`, `GROK_PLAYLIST_CONTROL_SECRET`, the Claude secrets, and
`OUTREACH_SCHEDULER_SECRET`. A copied secret does not authenticate as Muse.

Control Center sends either header:

- `x-muse-ig-receipt-secret: <secret>`
- `x-api-key: <secret>`

## Action 1 — `list_ig_dm_send_queue` (read)

```json
{ "action": "list_ig_dm_send_queue", "limit": 100 }
```

Returns every Instagram handoff record at `APPROVED_FOR_SEND` with no receipt, oldest
first, joined to its approved draft:

```json
{
  "ok": true,
  "send_owner": "ig_curator_auto_send",
  "receipt_action": "dispatch_ig_curator_sends",
  "path": ["claude_playlist_discovery composes…", "grok_playlist_control reviews…", "scheduler calls dispatch_ig_curator_sends…", "dispatcher writes the send log…"],
  "total_count": 2,
  "sendable_count": 1,
  "rows": [
    {
      "handoff_record_id": "…", "batch_id": "…",
      "track_name": "Meditate", "playlist_name": "Lyrical Rap",
      "ig_handle": "@akhilsagar", "ig_url": "https://instagram.com/akhilsagar",
      "dm_body": "Hi Akhil Sagar, I'm Fendi Frost. …",
      "outreach_draft_id": "…", "draft_status": "approved", "generated_by": "claude_playlist_discovery",
      "record_approved_by": "grok_playlist_control", "draft_approved_by": "grok_playlist_control",
      "send_owner": "ig_curator_auto_send", "receipt_action": "dispatch_ig_curator_sends",
      "sendable": true, "blockers": [], "warnings": []
    }
  ]
}
```

`dm_body` is the text the dispatcher would send. It is null, and `sendable` is false,
whenever a blocker is present. `warnings` such as `terms_unconfirmed` do not withhold it.
Do not copy this queue onto Instagram by hand:

| blocker | meaning |
|---|---|
| `draft_missing` | the record has no Instagram draft at all |
| `draft_pending` / `draft_rejected` / `draft_superseded` | Grok has not approved the draft, or retired it |
| `draft_body_empty` | approved draft with no text |
| `attribution_held` | Fendi-authored draft; stays on hold |
| `ig_handle_missing` | no usable handle on the draft, packet, or target |
| `target_inactive` | the playlist target is inactive |

A row with blockers stays unsent. Grok fixes review state and Claude re-drafts.
The dispatcher does not ask Fendi or Enki to approve it.

## Action 2 — `dispatch_ig_curator_sends`

```json
{ "action": "dispatch_ig_curator_sends" }
```

The outreach scheduler calls this. It re-runs the pre-send gate, claims one row per
song and handle, then calls the Instagram Graph messages API. Set
`IG_CURATOR_SEND_ENABLED=true` or every row comes back `kill_switch` and nothing is
sent. A second call for the same song and handle does not send again.

## Action 3 — `mark_manual_ig_dm_submitted` (legacy receipt)

The automatic path does not use this action. It remains so a receipt that was already
sent can still be recorded.

```json
{
  "action": "mark_manual_ig_dm_submitted",
  "handoff_record_id": "<handoff_record_id from the queue row>",
  "evidence": {
    "result": "submitted",
    "reference": "<Instagram thread or message reference>",
    "notes": "<what was sent, without pasting the pitch>",
    "submitted_at": "2026-10-22T15:04:00.000Z"
  }
}
```

The record must be `APPROVED_FOR_SEND`, the Instagram route must be submission-ready, and
the song DNA envelope must pass. The receipt moves the record to `SENT` and writes the
`pitch_log` row that drives cooldowns. A second receipt for the same record is an
idempotent replay. The automatic sender stamps `submitted_by` as `ig_curator_auto_send`
after the migration in this change is applied.

## Everything else

`approve_handoff_records`, `review_handoff_records`, `send_playlist_pitches`,
`list_web_form_handoffs`, `list_handoff_batches`, and every other action return `403` for
this credential. Grok still wins when the Grok secret is presented.
