// telegram-webhook
//
// Inner Circle bot webhook. Handles /start <token>, /stop, and drops all
// other text (v1 reply policy — see INNER_CIRCLE_MARKETING_TECHNIQUE.md §9).
//
// This runs the Inner Circle bot — a NEW bot from BotFather (e.g.
// @FendiInnerCircle). DO NOT point fendi-control-center's @FendiAIbot at
// this URL; that bot has its own webhook in CC and powers the personal AI
// agent (Lane 1 /do commands, Grok+Gemini routing, etc).
//
// Setup (one-time, after deploy):
//   curl -X POST "https://api.telegram.org/bot${INNER_CIRCLE_BOT_TOKEN}/setWebhook" \
//     -H "content-type: application/json" \
//     -d "{
//       \"url\": \"https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/telegram-webhook\",
//       \"secret_token\": \"${INNER_CIRCLE_WEBHOOK_SECRET}\",
//       \"allowed_updates\": [\"message\"]
//     }"
//
// Auth: Telegram sends our secret in X-Telegram-Bot-Api-Secret-Token.
// We reject any request without the matching INNER_CIRCLE_WEBHOOK_SECRET.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-telegram-bot-api-secret-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string; username?: string };
  date: number;
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, (m) => `\\${m}`);
}

async function sendTelegramMessage(
  botToken: string,
  chatId: string | number,
  text: string,
  opts: { parseMode?: "MarkdownV2" | "HTML"; disableWebPagePreview?: boolean } = {},
) {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: opts.parseMode ?? "MarkdownV2",
    disable_web_page_preview: opts.disableWebPagePreview ?? false,
  };
  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await resp.json().catch(() => ({ ok: false }));
  } catch (e) {
    return { ok: false, description: (e as Error).message };
  }
}

// --- Copy in INNER_CIRCLE_MARKETING_TECHNIQUE.md §6. Polar bear ZWJ.
function welcomeText(): string {
  return escapeMarkdownV2(
    [
      "🐻‍❄️ you're in.",
      "",
      "inner circle is small on purpose. here's what you get:",
      "— new music 24-48 hours before anyone else",
      "— studio shit nobody else sees",
      "— first crack at every modest drop",
      "",
      "next one drops soon. you'll be the first to know.",
      "",
      "— fendi",
      "",
      "ps — reply /stop any time to leave. no hard feelings.",
    ].join("\n"),
  );
}

function alreadySubscribedText(): string {
  return escapeMarkdownV2("🐻‍❄️ you're already in. next drop comes straight to you.");
}

function noTokenText(): string {
  return escapeMarkdownV2(
    "🐻‍❄️ inner circle is invite-only via the link.\n\ngrab it here: links.fendifrost.com",
  );
}

function stopAckText(): string {
  return escapeMarkdownV2("you're out. 🐻‍❄️");
}

function expiredTokenText(): string {
  return escapeMarkdownV2(
    "🐻‍❄️ that link expired. grab a fresh one from links.fendifrost.com.",
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const { getTelegramBotToken, getTelegramWebhookSecret } = await import("../_shared/telegramEnv.ts");

  // 1) Verify Telegram secret token header.
  const expectedSecret = getTelegramWebhookSecret();
  const gotSecret = req.headers.get("x-telegram-bot-api-secret-token");
  if (!expectedSecret) {
    console.error("[telegram-webhook] telegram_webhook_secret not configured");
    return json({ error: "server_misconfigured" }, 500);
  }
  if (gotSecret !== expectedSecret) {
    console.warn("[telegram-webhook] secret mismatch — refusing");
    return json({ error: "forbidden" }, 403);
  }

  const botToken = getTelegramBotToken();
  if (!botToken) {
    console.error("[telegram-webhook] telegram_bot_token not configured");
    return json({ error: "server_misconfigured" }, 500);
  }

  // 2) Parse the update.
  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return json({ error: "bad_json" }, 400);
  }

  const supabase: SupabaseClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // 2a) Dedupe by update_id (pattern from fendi-control-center).
  if (typeof update.update_id === "number") {
    const { error: dedupeErr } = await supabase
      .from("telegram_webhook_processed_updates")
      .insert({ update_id: update.update_id });
    if (dedupeErr) {
      const code = (dedupeErr as { code?: string }).code;
      if (code === "23505") {
        // duplicate — already processed
        return json({ ok: true, handled: "duplicate_update_id" });
      }
      // Other errors: log + continue (dedupe is defense in depth).
      console.error("[telegram-webhook] dedupe insert failed", dedupeErr.message);
    }
  }

  const msg = update.message;
  if (!msg || !msg.text || !msg.from) {
    return json({ ok: true, handled: "non_text_message" });
  }

  const text = msg.text.trim();
  const chatId = String(msg.chat.id);
  const fromUsername = msg.from.username ?? null;
  const firstName = msg.from.first_name ?? null;
  const languageCode = msg.from.language_code ?? null;

  // -----------------------------------------------------------------
  // /start [<token>]
  // -----------------------------------------------------------------
  if (text.startsWith("/start")) {
    const parts = text.split(/\s+/);
    const token = parts.length > 1 ? parts[1] : "";

    if (!token) {
      await sendTelegramMessage(botToken, chatId, noTokenText());
      return json({ ok: true, handled: "start_no_token" });
    }

    // Look up the token.
    const { data: tokenRow, error: tokenErr } = await supabase
      .from("telegram_signup_tokens")
      .select("*")
      .eq("token", token)
      .maybeSingle();

    if (tokenErr || !tokenRow) {
      await sendTelegramMessage(botToken, chatId, noTokenText());
      return json({ ok: true, handled: "start_invalid_token" });
    }

    if (tokenRow.expires_at && new Date(tokenRow.expires_at) < new Date()) {
      await sendTelegramMessage(botToken, chatId, expiredTokenText());
      return json({ ok: true, handled: "start_expired_token" });
    }

    // Already subscribed by chat_id?
    const { data: existing } = await supabase
      .from("telegram_subscribers")
      .select("id, subscribed")
      .eq("telegram_chat_id", chatId)
      .maybeSingle();

    if (existing && existing.subscribed) {
      await sendTelegramMessage(botToken, chatId, alreadySubscribedText());
      // Consume the token anyway so it can't be reused.
      await supabase
        .from("telegram_signup_tokens")
        .update({
          consumed_at: new Date().toISOString(),
          consumed_chat_id: chatId,
          consumed_subscriber_id: existing.id,
        })
        .eq("token", token);
      return json({ ok: true, handled: "start_already_subscribed" });
    }

    // Optional contact_id: if the token carried an email and that email
    // exists in email_contacts, link the subscriber to it. NEVER touch the
    // existing email_contacts row's subscribed/unsubscribed_at state.
    let contactId: string | null = null;
    if (tokenRow.email) {
      const { data: contact } = await supabase
        .from("email_contacts")
        .select("id")
        .eq("email", String(tokenRow.email).toLowerCase().trim())
        .maybeSingle();
      if (contact) contactId = contact.id;
    }

    let subscriberId: string | null = null;

    if (existing) {
      // Re-subscribe (was unsubscribed before)
      subscriberId = existing.id;
      const { error: upErr } = await supabase
        .from("telegram_subscribers")
        .update({
          subscribed: true,
          subscribed_at: new Date().toISOString(),
          unsubscribed_at: null,
          source_smart_link: tokenRow.smart_link_slug,
          telegram_username: fromUsername,
          first_name: firstName,
          language_code: languageCode,
          contact_id: contactId,
        })
        .eq("id", existing.id);
      if (upErr) console.error("[telegram-webhook] resubscribe failed", upErr.message);
    } else {
      // Fresh subscriber.
      const { data: inserted, error: insErr } = await supabase
        .from("telegram_subscribers")
        .insert({
          telegram_chat_id: chatId,
          telegram_username: fromUsername,
          first_name: firstName,
          language_code: languageCode,
          contact_id: contactId,
          source_smart_link: tokenRow.smart_link_slug,
          metadata: {
            utm_source: tokenRow.utm_source,
            utm_medium: tokenRow.utm_medium,
            utm_campaign: tokenRow.utm_campaign,
            fbclid: tokenRow.fbclid,
            meta_fbp: tokenRow.meta_fbp,
            meta_fbc: tokenRow.meta_fbc,
          },
        })
        .select("id")
        .single();
      if (insErr) {
        console.error("[telegram-webhook] insert subscriber failed", insErr.message);
      } else if (inserted) {
        subscriberId = inserted.id;
      }
    }

    // Mark token consumed.
    await supabase
      .from("telegram_signup_tokens")
      .update({
        consumed_at: new Date().toISOString(),
        consumed_chat_id: chatId,
        consumed_subscriber_id: subscriberId,
      })
      .eq("token", token);

    await sendTelegramMessage(botToken, chatId, welcomeText());

    return json({ ok: true, handled: "start_subscribed", subscriber_id: subscriberId });
  }

  // -----------------------------------------------------------------
  // /stop or /unsubscribe
  // -----------------------------------------------------------------
  if (text === "/stop" || text === "/unsubscribe") {
    const { error: upErr } = await supabase
      .from("telegram_subscribers")
      .update({
        subscribed: false,
        unsubscribed_at: new Date().toISOString(),
      })
      .eq("telegram_chat_id", chatId);
    if (upErr) console.error("[telegram-webhook] /stop failed", upErr.message);
    await sendTelegramMessage(botToken, chatId, stopAckText());
    return json({ ok: true, handled: "stop" });
  }

  // -----------------------------------------------------------------
  // Anything else: silently drop (v1 reply policy).
  // -----------------------------------------------------------------
  return json({ ok: true, handled: "dropped" });
});
