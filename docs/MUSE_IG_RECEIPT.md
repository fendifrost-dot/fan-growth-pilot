# Muse Instagram receipt actor

Enki (Muse) can record that an already-approved Instagram DM was sent. Muse is not a reviewer and not a sender. `grok_playlist_control` remains the only machine that reviews and approves playlist handoffs. Fendi can still do both.

## Credential

Set `MUSE_IG_RECEIPT_SECRET` on the Control Center edge function (`control-center-api`). The value must be distinct from `FANFUEL_HUB_KEY`, `GROK_PLAYLIST_CONTROL_SECRET`, the Claude secrets, and `OUTREACH_SCHEDULER_SECRET`. A copied secret does not authenticate as Muse.

Control Center sends either header:

- `x-muse-ig-receipt-secret: <secret>`
- `x-api-key: <secret>`

## The only allowed action

`mark_manual_ig_dm_submitted`

Every other action, including reads, review, approve, web-form receipts, and promotion, returns 403.

```json
{
  "action": "mark_manual_ig_dm_submitted",
  "handoff_record_id": "<agh_handoff_records.id>",
  "evidence": {
    "result": "submitted",
    "reference": "<operator reference for this send>",
    "notes": "<what was sent, without pasting the pitch>",
    "submitted_at": "2026-10-13T15:04:00.000Z"
  }
}
```

The record must already be `APPROVED_FOR_SEND`, the Instagram route must be submission-ready, and the song DNA envelope must pass. Muse does not receive `send_playlist_pitches`, `approve_playlist_drafts`, or `review_handoff_batch`. `submitted_by` is stamped `muse_ig_receipt`.

This does not send the DM. It records a receipt for a send a person already made.
