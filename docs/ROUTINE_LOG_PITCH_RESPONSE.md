# Logging curator replies without a browser login: `log-pitch-response`

This is for the Gmail reply-digest routine and any future routine that records a curator's response in
the Hub. It needs **no Supabase session token, no localStorage and no query strings**. Authentication is a
dedicated secret sent in a request header.

## One-time setup (Fendi, in Lovable only)

1. **Create the secret.** In Lovable Cloud → **Secrets**, add `PITCH_RESPONSE_LOG_KEY`. Any non-empty value
   works; there is no length requirement. Never paste it into chat or a doc.
2. **Redeploy the function.** Use Lovable chat: "Redeploy edge function `log-pitch-response` only."
3. **Apply the migration.** `20260930210000_response_attribution_route_recert.sql` must be applied,
   because the function writes through `agh_update_pitch_response`.
4. **Give the routine the key.** Store the same value in the routine's own secret or credential store, as
   `PITCH_RESPONSE_LOG_KEY`.

## The call

```
POST https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/log-pitch-response
Content-Type: application/json
x-pitch-log-key: <PITCH_RESPONSE_LOG_KEY>

{
  "curator_email": "digiindie@gmail.com",
  "track_name": "Meditate",
  "placement_status": "placed",
  "response_notes": "DIGIINDIE editorial selections: Meditate added",
  "source": "gmail_digest",
  "source_ref": "gmail thread <thread id>",
  "dry_run": true
}
```

**Fields:**
- `placement_status` must be one of:
  - `replied`, `declined`, `placed`, `accepted_free_promo`
  - `paid_solicitation_no_engage`, `declined_paid_solicitation`
  - `auto_ack_under_review`, `portal_only`, `blocked`, `no_response`
- `reply_received` and `placed` default from the status. Pass them only to override.
- `pitch_log_id` can replace `curator_email` + `track_name` when the routine already knows the row.

**Procedure:** send `"dry_run": true` first. Check `pitch_log` in the response, then send the same body
without `dry_run`.

## What the server does

- **Finding the row.** It finds the one sent pitch for this curator email and song (case-insensitive).
  Older rows are matched through the playlist's curator email. It never guesses:
  - **`404 no_matching_pitch`:** there is no sent pitch for that curator and song. The response lists the
    curator's other pitches as `candidates`.
  - **`409 ambiguous_pitch`:** more than one sent pitch matches. Pick from `candidates` and resend with
    `pitch_log_id`.
- **Writing.** It writes only response fields, through `agh_update_pitch_response`:
  - Notes are **appended** as `[source] text (ref …)`; they are never replaced.
  - A stronger existing outcome (e.g. `accepted_free_promo`, `declined_paid_solicitation`) is
    **kept**. The response shows `status_preserved: true` when that happens.
  - The write is recorded in `agh_pitch_response_events` with actor `log-pitch-response:<source>`.
- **It never sends, replies, approves or drafts anything.** Pay-to-play replies are logged as
  `paid_solicitation_no_engage` with no reply, unless the CoS or Fendi asked for a decline.

## Errors

- **401:** wrong or missing key.
- **503 `not_configured`:** the secret isn't set.
- **503 `migration_required`:** the SQL isn't applied.
- **400:** bad input. The message names the field.
- **A query string on the URL is rejected.** Put everything in the JSON body.
