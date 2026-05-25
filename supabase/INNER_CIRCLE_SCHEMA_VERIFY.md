# Inner Circle — schema verification (2026-05-24)

Verified edge function references against `supabase/types/database.ts` and migrations `20260524230000_*` / `20260524230001_*`.

**Result: no drift.** All table/column names in the three Telegram functions match production types. No code patches required for schema alignment.

| Table / column | telegram-webhook | telegram-signup-redirect | telegram-send-campaign |
|----------------|------------------|--------------------------|------------------------|
| `telegram_webhook_processed_updates.update_id` | insert | — | — |
| `telegram_subscribers.*` | select/insert/update | — | select/update |
| `telegram_signup_tokens.*` | select/update | insert | — |
| `email_contacts.id, email` | select | — | — |
| `telegram_sends.*` | — | — | insert |
| `email_campaigns.total_sent, total_failed` | — | — | read/update |

Env vars (not in DB): `INNER_CIRCLE_BOT_TOKEN`, `INNER_CIRCLE_BOT_USERNAME`, `INNER_CIRCLE_WEBHOOK_SECRET`, `FANFUEL_HUB_KEY`.
