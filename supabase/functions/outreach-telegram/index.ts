import { createSupabaseServiceClient } from "../_shared/truth/supabaseService.ts";
import { getTelegramBotToken } from "../_shared/telegramEnv.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-truth-verify-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const BROADCAST_DELAY_MS = 35;
const TG_API = "https://api.telegram.org/bot";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

function verifyAuth(req: Request): boolean {
  const secret = Deno.env.get("TRUTH_VERIFY_SECRET");
  const url = new URL(req.url);
  const provided =
    req.headers.get("x-truth-verify-secret") ||
    req.headers.get("x-api-key") ||
    url.searchParams.get("secret");
  return Boolean(secret && provided === secret);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendTelegram(
  chatId: string,
  text: string,
  inlineKeyboard?: { text: string; url?: string }[][]
): Promise<
  | { ok: true; messageId: number }
  | { ok: false; errorCode: string; errorMessage: string; httpStatus: number }
> {
  const token = getTelegramBotToken();
  if (!token) {
    return { ok: false, errorCode: "no_bot_token", errorMessage: "telegram_bot_token missing", httpStatus: 500 };
  }
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "MarkdownV2",
    disable_web_page_preview: false,
  };
  if (inlineKeyboard?.length) {
    body.reply_markup = { inline_keyboard: inlineKeyboard };
  }
  const res = await fetch(`${TG_API}${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.ok) {
    return { ok: true, messageId: data.result?.message_id as number };
  }
  const desc = (data.description as string) || "send_failed";
  const code = res.status === 403 ? "telegram_403_blocked" : `telegram_${res.status}`;
  return { ok: false, errorCode: code, errorMessage: desc, httpStatus: res.status };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!verifyAuth(req)) return json({ ok: false, error: "unauthorized" }, 401);

  const url = new URL(req.url);
  const sb = createSupabaseServiceClient();

  if (req.method === "GET") {
    const mode = url.searchParams.get("mode") || "stats";
    try {
      if (mode === "stats") {
        const { data, error } = await sb.from("telegram_inner_circle_stats").select("*").maybeSingle();
        if (error) return json({ ok: false, error: error.message }, 500);
        return json({ ok: true, stats: data ?? {} });
      }
      if (mode === "campaigns") {
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
        const { data, error } = await sb
          .from("telegram_campaign_send_summary")
          .select("*")
          .limit(limit);
        if (error) return json({ ok: false, error: error.message }, 500);
        return json({ ok: true, campaigns: data ?? [] });
      }
      if (mode === "sources") {
        const { data, error } = await sb
          .from("telegram_subscribers_by_source")
          .select("source_smart_link, active_subscribers")
          .gt("active_subscribers", 0);
        if (error) return json({ ok: false, error: error.message }, 500);
        const slugs = (data ?? [])
          .map((r) => r.source_smart_link as string)
          .filter((s) => s && s !== "(unknown)");
        return json({ ok: true, sources: slugs.sort() });
      }
      return json({ ok: false, error: "unknown_mode" }, 400);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return json({ ok: false, error: message }, 500);
    }
  }

  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "bad_json" }, 400);
  }

  if (body.mode !== "send") {
    return json({ ok: false, error: "POST requires mode=send" }, 400);
  }

  const campaign_name = String(body.campaign_name ?? "");
  const text = String(body.text ?? "");
  if (!campaign_name || !text) {
    return json({ ok: false, error: "campaign_name and text required" }, 400);
  }

  const campaignId = (body.campaign_id as string) || crypto.randomUUID();
  const filter = (body.filter as Record<string, unknown>) || {};
  const dryRun = filter.dry_run === true;
  const sourceFilter = filter.source_smart_link as string | undefined;
  const inline_buttons = body.inline_buttons as { text: string; url?: string }[][] | undefined;
  const batch_label = campaign_name.slice(0, 120);

  let q = sb
    .from("telegram_subscribers")
    .select("id, telegram_chat_id, first_name, source_smart_link, block_count")
    .eq("subscribed", true);
  if (sourceFilter) q = q.eq("source_smart_link", sourceFilter);

  const { data: subscribers, error: subErr } = await q;
  if (subErr) return json({ ok: false, error: subErr.message }, 500);

  const attempted = subscribers?.length ?? 0;
  let succeeded = 0;
  let failed = 0;
  let blocked = 0;

  if (attempted === 0) {
    return json({
      ok: true,
      campaign_id: campaignId,
      campaign_name,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      blocked: 0,
      dry_run: dryRun,
      note: "no subscribers matched the filter",
    });
  }

  if (dryRun) {
    return json({
      ok: true,
      campaign_id: campaignId,
      campaign_name,
      attempted,
      succeeded: attempted,
      failed: 0,
      blocked: 0,
      dry_run: true,
      note: "dry run — no Telegram API calls",
      sample: (subscribers ?? []).slice(0, 5).map((s) => ({
        chat_id: s.telegram_chat_id,
        source: s.source_smart_link,
      })),
    });
  }

  for (const sub of subscribers!) {
    const chatId = sub.telegram_chat_id as string;
    const subId = sub.id as string;

    const result = await sendTelegram(chatId, text, inline_buttons);
    if (result.ok) {
      succeeded++;
      await sb.from("telegram_sends").insert({
        campaign_id: campaignId,
        subscriber_id: subId,
        recipient_chat_id: chatId,
        status: "sent",
        telegram_message_id: String(result.messageId),
        test_send: false,
        batch_label,
        sent_at: new Date().toISOString(),
      });
    } else {
      failed++;
      await sb.from("telegram_sends").insert({
        campaign_id: campaignId,
        subscriber_id: subId,
        recipient_chat_id: chatId,
        status: "failed",
        error_code: result.errorCode,
        error_message: result.errorMessage,
        test_send: false,
        batch_label,
      });
      if (result.errorCode === "telegram_403_blocked") {
        blocked++;
        await sb
          .from("telegram_subscribers")
          .update({
            subscribed: false,
            unsubscribed_at: new Date().toISOString(),
            block_count: ((sub.block_count as number) ?? 0) + 1,
          })
          .eq("id", subId);
      }
    }
    await sleep(BROADCAST_DELAY_MS);
  }

  return json({
    ok: true,
    campaign_id: campaignId,
    campaign_name,
    attempted,
    succeeded,
    failed,
    blocked,
    dry_run: false,
  });
});
