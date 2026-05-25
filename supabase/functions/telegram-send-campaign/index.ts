// telegram-send-campaign
//
// Broadcast a Telegram message to all opted-in Inner Circle subscribers.
// Mirrors the auth + mode + logging pattern of send-campaign-email so admin
// tooling can target either channel symmetrically.
//
// Auth: requires x-api-key (FANFUEL_HUB_KEY). Same as send-campaign-email.
//
// Modes (one per request):
//   { mode: "test",    text, inline_buttons?, to_chat_id }
//   { mode: "preview", text, inline_buttons? }                       -> returns the rendered payload only
//   { mode: "batch",   campaign_id?, batch_label?, text, inline_buttons?,
//                      filter?: { source_smart_link, dry_run } }
//
// Personalization tokens supported in text: {{first_name}}
// text MUST be MarkdownV2-escaped by the caller (e.g. dots and dashes
// backslashed). The function does NOT escape — it forwards verbatim.
//
// Rate limiting: 35ms between sends ~= 28/sec, comfortably under Telegram's
// 30/sec per-bot global ceiling.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });

const BROADCAST_DELAY_MS = 35;

function authOK(req: Request): boolean {
  const xApiKey = req.headers.get("x-api-key");
  const authHeader = req.headers.get("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const anonApiKey = req.headers.get("apikey");
  const providedKey = (xApiKey || bearerToken || anonApiKey || "").trim();
  const expectedKey = (Deno.env.get("FANFUEL_HUB_KEY") || "").trim();
  return !!expectedKey && providedKey === expectedKey;
}

interface InlineButton {
  text: string;
  url?: string;
  callback_data?: string;
}

interface Subscriber {
  id: string;
  telegram_chat_id: string;
  first_name: string | null;
  source_smart_link: string | null;
  block_count: number;
}

function renderText(raw: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.replaceAll(`{{${k}}}`, v ?? ""),
    raw,
  );
}

interface SendResult {
  ok: boolean;
  messageId?: number;
  errorCode?: string;
  errorMessage?: string;
}

async function sendOne(
  botToken: string,
  chatId: string,
  text: string,
  buttons?: InlineButton[][],
): Promise<SendResult> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "MarkdownV2",
    disable_web_page_preview: false,
  };
  if (buttons && buttons.length > 0) {
    body.reply_markup = { inline_keyboard: buttons };
  }

  let resp: Response;
  try {
    resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, errorCode: "telegram_network_error", errorMessage: (e as Error).message };
  }

  const parsed = await resp.json().catch(() => null) as { ok?: boolean; result?: { message_id?: number }; description?: string } | null;

  if (resp.ok && parsed?.ok && parsed.result?.message_id) {
    return { ok: true, messageId: parsed.result.message_id };
  }

  const description = parsed?.description ?? `http_${resp.status}`;
  let errorCode = "telegram_unknown_error";
  if (resp.status === 403 || /bot was blocked/i.test(description)) {
    errorCode = "telegram_403_blocked";
  } else if (resp.status === 400 && /chat not found/i.test(description)) {
    errorCode = "telegram_400_chat_not_found";
  } else if (resp.status === 429) {
    errorCode = "telegram_429_rate_limited";
  } else if (resp.status >= 500) {
    errorCode = "telegram_5xx_server_error";
  } else if (resp.status === 400) {
    errorCode = "telegram_400_bad_request";
  }
  return { ok: false, errorCode, errorMessage: description };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  if (!authOK(req)) return json({ error: "Unauthorized" }, 401);

  const botToken = Deno.env.get("INNER_CIRCLE_BOT_TOKEN");
  if (!botToken) return json({ error: "INNER_CIRCLE_BOT_TOKEN not configured" }, 500);

  const supabase: SupabaseClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const mode = payload?.mode;
  const text: string = String(payload?.text ?? "");
  const inlineButtons: InlineButton[][] | undefined = payload?.inline_buttons;

  if (!text) return json({ error: "text is required" }, 400);

  // ---------------- PREVIEW ----------------
  if (mode === "preview") {
    const first_name = String(payload?.to_first_name ?? "Friend");
    return json({
      text: renderText(text, { first_name }),
      inline_buttons: inlineButtons ?? null,
    });
  }

  // ---------------- TEST -------------------
  if (mode === "test") {
    const to_chat_id = String(payload?.to_chat_id ?? "").trim();
    if (!to_chat_id) return json({ error: "to_chat_id is required for test mode" }, 400);

    const { data: sub } = await supabase
      .from("telegram_subscribers")
      .select("id, telegram_chat_id, first_name")
      .eq("telegram_chat_id", to_chat_id)
      .maybeSingle();

    const first_name = sub?.first_name ?? String(payload?.to_first_name ?? "");
    const rendered = renderText(text, { first_name });

    const result = await sendOne(botToken, to_chat_id, rendered, inlineButtons);

    await supabase.from("telegram_sends").insert({
      campaign_id: payload?.campaign_id ?? null,
      subscriber_id: sub?.id ?? null,
      recipient_chat_id: to_chat_id,
      status: result.ok ? "sent" : "failed",
      telegram_message_id: result.messageId ? String(result.messageId) : null,
      error_code: result.errorCode ?? null,
      error_message: result.errorMessage ?? null,
      test_send: true,
      batch_label: "test",
    });

    return json({ mode: "test", result });
  }

  // ---------------- BATCH ------------------
  if (mode === "batch") {
    const campaign_id: string | null = payload?.campaign_id ?? null;
    const batch_label = String(payload?.batch_label ?? `tg-batch-${new Date().toISOString().slice(0, 16)}`);
    const dry_run = !!payload?.filter?.dry_run;
    const sourceFilter: string | null = payload?.filter?.source_smart_link ?? null;

    // Audience: subscribed=true + optional source filter + not already-sent to in this campaign.
    let q = supabase
      .from("telegram_subscribers")
      .select("id, telegram_chat_id, first_name, source_smart_link, block_count")
      .eq("subscribed", true);
    if (sourceFilter) q = q.eq("source_smart_link", sourceFilter);

    const { data: pool, error: poolErr } = await q;
    if (poolErr) return json({ error: `Audience query failed: ${poolErr.message}` }, 500);

    let eligible: Subscriber[] = (pool ?? []) as Subscriber[];

    if (campaign_id) {
      const { data: alreadySent } = await supabase
        .from("telegram_sends")
        .select("subscriber_id")
        .eq("campaign_id", campaign_id)
        .eq("status", "sent")
        .eq("test_send", false);
      const sentSet = new Set((alreadySent ?? []).map((r: any) => r.subscriber_id).filter(Boolean));
      eligible = eligible.filter((s) => !sentSet.has(s.id));
    }

    if (dry_run) {
      return json({
        mode: "batch",
        dry_run: true,
        batch_label,
        would_send: eligible.length,
        sample: eligible.slice(0, 10).map((s) => ({
          chat_id: s.telegram_chat_id,
          source: s.source_smart_link,
        })),
      });
    }

    const results: Array<{ chat_id: string; ok: boolean; error_code?: string }> = [];
    let succeeded = 0;
    let failed = 0;
    let blocked = 0;

    for (const sub of eligible) {
      const rendered = renderText(text, { first_name: sub.first_name ?? "" });
      const r = await sendOne(botToken, sub.telegram_chat_id, rendered, inlineButtons);

      if (r.ok) {
        succeeded++;
        await supabase.from("telegram_sends").insert({
          campaign_id,
          subscriber_id: sub.id,
          recipient_chat_id: sub.telegram_chat_id,
          status: "sent",
          telegram_message_id: r.messageId ? String(r.messageId) : null,
          test_send: false,
          batch_label,
        });
      } else {
        failed++;
        await supabase.from("telegram_sends").insert({
          campaign_id,
          subscriber_id: sub.id,
          recipient_chat_id: sub.telegram_chat_id,
          status: "failed",
          error_code: r.errorCode ?? "telegram_unknown_error",
          error_message: r.errorMessage,
          test_send: false,
          batch_label,
        });

        if (r.errorCode === "telegram_403_blocked") {
          blocked++;
          // Auto-unsubscribe — they blocked the bot, stop trying.
          await supabase
            .from("telegram_subscribers")
            .update({
              subscribed: false,
              unsubscribed_at: new Date().toISOString(),
              block_count: (sub.block_count ?? 0) + 1,
            })
            .eq("id", sub.id);
        }
      }

      results.push({
        chat_id: sub.telegram_chat_id,
        ok: r.ok,
        error_code: r.errorCode,
      });

      await new Promise((res) => setTimeout(res, BROADCAST_DELAY_MS));
    }

    // Update email_campaigns counters if a campaign_id was provided.
    if (campaign_id && (succeeded > 0 || failed > 0)) {
      const { data: current } = await supabase
        .from("email_campaigns")
        .select("total_sent, total_failed")
        .eq("id", campaign_id)
        .maybeSingle();
      if (current) {
        await supabase
          .from("email_campaigns")
          .update({
            total_sent: (current.total_sent ?? 0) + succeeded,
            total_failed: (current.total_failed ?? 0) + failed,
          })
          .eq("id", campaign_id);
      }
    }

    return json({
      mode: "batch",
      batch_label,
      attempted: eligible.length,
      succeeded,
      failed,
      blocked,
      sample: results.slice(0, 10),
    });
  }

  return json({ error: `Unknown mode: ${mode}` }, 400);
});
