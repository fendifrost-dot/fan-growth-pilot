# Muse on the Instagram path (send queue + receipt)

The approved Instagram pitch path, as the Hub enforces it:

| Step | Who | Hub action | Credential |
|---|---|---|---|
| 1. Find the curator and compose the DM inside the Hub | Claude | `create_playlist_draft_inventory` (MCP) | `claude_playlist_discovery` |
| 2. Review the handoff record and approve the draft | Grok Playlist Control | `review_handoff_records` / `approve_handoff_records`, `approve_draft` | `grok_playlist_control` |
| 3. Read what was approved and send it on Instagram | Muse (Enki, Control Center) | `list_ig_dm_send_queue` | `muse_ig_receipt` |
| 4. Record the receipt | Muse | `mark_manual_ig_dm_submitted` | `muse_ig_receipt` |

Muse is not a reviewer. It cannot approve, reject, draft, or read anything other than
its own send queue. Fendi can do everything. Nobody hand-sends from the artist phone:
drafts carry `send_mode = muse_instagram_send` and `send_owner = muse`.

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
  "send_owner": "muse",
  "receipt_action": "mark_manual_ig_dm_submitted",
  "path": ["claude_playlist_discovery composes…", "grok_playlist_control reviews…", "muse reads…", "muse records…"],
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
      "send_owner": "muse", "receipt_action": "mark_manual_ig_dm_submitted",
      "sendable": true, "blockers": []
    }
  ]
}
```

`dm_body` is the exact text to send. It is null, and `sendable` is false, whenever a
blocker is present:

| blocker | meaning |
|---|---|
| `draft_missing` | the record has no Instagram draft at all |
| `draft_pending` / `draft_rejected` / `draft_superseded` | Grok has not approved the draft, or retired it |
| `draft_body_empty` | approved draft with no text |
| `attribution_held` | Fendi-authored draft; stays on hold |
| `ig_handle_missing` | no usable handle on the draft, packet, or target |
| `target_inactive` | the playlist target is inactive |

A row with blockers is not Muse's to fix. It is Grok's (review state) or Claude's
(re-draft). Muse skips it and says why on the board.

## Action 2 — `mark_manual_ig_dm_submitted` (receipt)

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
the song DNA envelope must pass. `submitted_by` is stamped `muse_ig_receipt`. The receipt
moves the record to `SENT`, stamps the draft `sent`, and writes the `pitch_log` row that
drives cooldowns. A second receipt for the same record is an idempotent replay.

## Everything else

`approve_handoff_records`, `review_handoff_records`, `send_playlist_pitches`,
`list_web_form_handoffs`, `list_handoff_batches`, and every other action return `403` for
this credential. Grok still wins when the Grok secret is presented.
