# Inner Circle Telegram — setup runbook

**Bot:** NEW BotFather bot (e.g. `@FendiInnerCircle`). **Never** reuse `@FendiAIbot` (Fendi Control Center personal agent). See `CC_RECONCILIATION.md` in Fan Fuel Hub docs.

**Project:** `vsemrziqxrrfcquxfnwd`

## Workflow

| Layer | Where to edit |
|-------|----------------|
| Edge functions | GitHub `supabase/functions/telegram-*` → Lovable sync → **Publish** |
| DB schema | Already applied in prod via SQL Editor; migrations in repo are version control |
| Frontend CTA | GitHub `src/components/InnerCircleSubscribeButton.tsx` + SmartLink integration |

## 1. Secrets (Lovable → Cloud → Secrets)

| Name | Value |
|------|--------|
| `INNER_CIRCLE_BOT_TOKEN` | Token from BotFather for the **new** bot |
| `INNER_CIRCLE_BOT_USERNAME` | e.g. `FendiInnerCircle` (no `@`) |
| `INNER_CIRCLE_WEBHOOK_SECRET` | `openssl rand -hex 32` |
| `FANFUEL_HUB_KEY` | Existing hub key (broadcast endpoint) |

## 2. Lovable Publish

After GitHub push, open Lovable → **Publish** so `telegram-webhook`, `telegram-signup-redirect`, and `telegram-send-campaign` deploy (push alone may not update Edge Functions timestamps).

## 3. Register webhook

```bash
curl -X POST "https://api.telegram.org/bot${INNER_CIRCLE_BOT_TOKEN}/setWebhook" \
  -H "content-type: application/json" \
  -d "{
    \"url\": \"https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/telegram-webhook\",
    \"secret_token\": \"${INNER_CIRCLE_WEBHOOK_SECRET}\",
    \"allowed_updates\": [\"message\"],
    \"drop_pending_updates\": false
  }"
```

Confirm `$INNER_CIRCLE_BOT_TOKEN` is the Inner Circle bot, **not** FendiAIbot.

## 4. Smoke test

1. Open `https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/telegram-signup-redirect?slug=inner-circle` on a phone.
2. Tap START in Telegram → welcome message (🐻‍❄️ polar bear).
3. SQL: `SELECT id, telegram_chat_id, subscribed, source_smart_link FROM telegram_subscribers ORDER BY subscribed_at DESC LIMIT 5;`
4. `/stop` → `subscribed = false`; re-click link → resubscribe.
5. Test send:

```bash
curl -X POST "https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/telegram-send-campaign" \
  -H "x-api-key: ${FANFUEL_HUB_KEY}" \
  -H "content-type: application/json" \
  -d '{"mode":"test","to_chat_id":"<your_chat_id>","text":"🐻‍❄️ test\\.\\n\\nfendi here\\."}'
```

## 5. Smart link CTA

See `lovable-frontend/INTEGRATE_INNER_CIRCLE_ON_SMARTLINK.md`. Enable per link via `smart_links.metadata.inner_circle_enabled: true` or slug `inner-circle`.
