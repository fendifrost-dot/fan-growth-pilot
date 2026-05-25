# Inner Circle — Telegram setup (Lovable / fan-growth-pilot)

Strategy doc: `~/Documents/Claude/Projects/Fan Fuel Hub/INNER_CIRCLE_MARKETING_TECHNIQUE.md`
CC reconciliation: `~/Documents/Claude/Projects/Fan Fuel Hub/CC_RECONCILIATION.md`

## 0) Create a NEW bot — do NOT reuse @FendiAIbot

> ⚠️ `@FendiAIbot` is wired to `fendi-control-center`'s `telegram-webhook`
> edge function. It runs your personal AI agent. Repointing it at this
> project would silence the assistant. Inner Circle needs a SEPARATE bot.

1. Open [@BotFather](https://t.me/BotFather).
2. `/newbot` — recommended username `@FendiInnerCircle` (fallback `@FendiFrostInnerCircle`).
3. Copy the HTTP API token.
4. `/setdescription` — "the inner circle. early music, studio shit, first dibs."
5. `/setuserpic` — Modest / 🐻‍❄️ mark.
6. `/setcommands`:
   ```
   start - join the inner circle (use your invite link)
   stop  - leave the inner circle
   ```

## 1) Env vars (Lovable → Project → Settings → Edge Function Secrets)

| Name | Value |
|---|---|
| `INNER_CIRCLE_BOT_TOKEN` | The NEW Inner Circle bot token from step 0 — NOT FendiAIbot's |
| `INNER_CIRCLE_BOT_USERNAME` | The new bot @ without the leading @ (e.g. `FendiInnerCircle`) |
| `INNER_CIRCLE_WEBHOOK_SECRET` | `openssl rand -hex 32` — random per-deploy secret |

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `FANFUEL_HUB_KEY` are already
set for the project.

## 2) Run the migrations via Lovable SQL Editor

> Use Supabase → SQL Editor inside Lovable. **Never the chat.**

Paste each file, in order, hit Run. Both are idempotent.

1. `supabase/migrations/20260524230000_telegram_inner_circle.sql`
   - Creates `telegram_subscribers`, `telegram_signup_tokens`, `telegram_sends`
   - Creates views `telegram_inner_circle_stats`, `telegram_campaign_send_summary`, `telegram_subscribers_by_source`
2. `supabase/migrations/20260524230001_telegram_update_dedupe.sql`
   - Creates `telegram_webhook_processed_updates` dedupe ledger

Verify:
```sql
SELECT * FROM telegram_inner_circle_stats;
-- subscribers_active | subscribers_added_7d | ... -> all zeros, no errors
```

## 3) Register the webhook

> ⚠️ Confirm `$INNER_CIRCLE_BOT_TOKEN` is the NEW bot's token before
> running. The wrong token here silences your personal AI assistant.

Replace `<PROJECT_REF>` with `vsemrziqxrrfcquxfnwd` (FanFuel Hub Supabase ref):

```bash
curl -X POST "https://api.telegram.org/bot${INNER_CIRCLE_BOT_TOKEN}/setWebhook" \
  -H "content-type: application/json" \
  -d "{
    \"url\": \"https://<PROJECT_REF>.supabase.co/functions/v1/telegram-webhook\",
    \"secret_token\": \"${INNER_CIRCLE_WEBHOOK_SECRET}\",
    \"allowed_updates\": [\"message\"],
    \"drop_pending_updates\": false
  }"
```

Confirm:
```bash
curl "https://api.telegram.org/bot${INNER_CIRCLE_BOT_TOKEN}/getWebhookInfo"
# expect: url matches, pending_update_count: 0
```

## 4) Test the redirect → bot → subscribe loop

The public Inner Circle subscribe URL is:

```
https://<PROJECT_REF>.supabase.co/functions/v1/telegram-signup-redirect?slug=inner-circle
```

(Optionally DNS-mask it as `links.fendifrost.com/inner-circle/telegram` via your existing redirect infra.)

Test from your phone:
1. Click the URL.
2. Telegram opens to your new bot. Tap START.
3. Bot replies with the polar bear welcome message.
4. Verify:
   ```sql
   SELECT id, telegram_chat_id, subscribed, source_smart_link, subscribed_at
   FROM telegram_subscribers
   ORDER BY subscribed_at DESC LIMIT 5;
   ```
5. Reply `/stop` to the bot. Confirm `subscribed` flips to false.
6. Click the link again — verify resubscribe works.

## 5) First test broadcast (preview, test, then live)

Note: text must be MarkdownV2-escaped by you. Dots, dashes, `(`/`)`/`!` etc must be backslash-escaped.

**Preview only (no send):**
```bash
curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/telegram-send-campaign" \
  -H "x-api-key: ${FANFUEL_HUB_KEY}" \
  -H "content-type: application/json" \
  -d '{
    "mode": "preview",
    "text": "🐻‍❄️ test\\.\\n\\nfendi here\\."
  }'
```

**Test to one chat_id (yours):**
```bash
curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/telegram-send-campaign" \
  -H "x-api-key: ${FANFUEL_HUB_KEY}" \
  -H "content-type: application/json" \
  -d '{
    "mode": "test",
    "to_chat_id": "<your_telegram_user_id>",
    "text": "🐻‍❄️ test\\.\\n\\nfendi here\\."
  }'
```

**Batch broadcast (dry-run first):**
```bash
curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/telegram-send-campaign" \
  -H "x-api-key: ${FANFUEL_HUB_KEY}" \
  -H "content-type: application/json" \
  -d '{
    "mode": "batch",
    "campaign_id": "<email_campaigns_id_for_this_drop>",
    "text": "🐻‍❄️ early\\.\\n\\nnew one drops in 24 hours\\.",
    "inline_buttons": [[{"text":"hear it first","url":"https://links.fendifrost.com/..."}]],
    "filter": { "dry_run": true }
  }'
```

When dry_run looks right, flip to `"dry_run": false`.

## 6) Dashboard query

The five Inner Circle metrics that admin UI should show:

```sql
SELECT * FROM telegram_inner_circle_stats;
SELECT * FROM telegram_subscribers_by_source;
SELECT * FROM telegram_campaign_send_summary LIMIT 10;
```

These are the only Telegram metrics that come from real rows. Any
"engagement score" / "estimated reach" / "open rate" request — push back.
Telegram doesn't expose bot DM read receipts. We don't fabricate metrics.

## 7) File map

| Piece | Path |
|---|---|
| Migration — subscribers + sends + tokens + views | `supabase/migrations/20260524230000_telegram_inner_circle.sql` |
| Migration — update_id dedupe | `supabase/migrations/20260524230001_telegram_update_dedupe.sql` |
| Edge function — bot webhook | `supabase/functions/telegram-webhook/index.ts` |
| Edge function — subscribe redirect | `supabase/functions/telegram-signup-redirect/index.ts` |
| Edge function — broadcast | `supabase/functions/telegram-send-campaign/index.ts` |
| Config entries | `supabase/config.toml` (verify_jwt = false for webhook + signup-redirect) |

## 8) What's NOT built in v1

- **WhatsApp anything.** Per strategy doc — gated until Telegram > 100 subs.
- **React subscribe CTA on smart-link landing page.** Until added, share the redirect URL directly (or DNS-mask it).
- **Reply routing.** Fan replies are silently dropped (v1 reply policy).
- **Admin dashboard widgets.** SQL views exist; the UI cards are a follow-up.
- **Outbox queue.** Direct loop is fine until > 500 subs.
