/** Resolve Telegram secrets — supports Lovable `telegram_bot_token` and legacy names. */

export function getTelegramBotToken(): string {
  return (
    Deno.env.get("telegram_bot_token")?.trim() ||
    Deno.env.get("TELEGRAM_BOT_TOKEN")?.trim() ||
    Deno.env.get("INNER_CIRCLE_BOT_TOKEN")?.trim() ||
    ""
  );
}

export function getTelegramBotUsername(): string {
  const u =
    Deno.env.get("telegram_bot_username")?.trim() ||
    Deno.env.get("TELEGRAM_BOT_USERNAME")?.trim() ||
    Deno.env.get("INNER_CIRCLE_BOT_USERNAME")?.trim() ||
    "";
  return u.replace(/^@/, "");
}

export function getTelegramWebhookSecret(): string {
  return (
    Deno.env.get("telegram_webhook_secret")?.trim() ||
    Deno.env.get("TELEGRAM_WEBHOOK_SECRET")?.trim() ||
    Deno.env.get("INNER_CIRCLE_WEBHOOK_SECRET")?.trim() ||
    ""
  );
}
