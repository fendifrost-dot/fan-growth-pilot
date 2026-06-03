// telegram-signup-redirect
//
// Public endpoint that turns a smart link click into a Telegram bot deep-link.
//
// Flow:
//   1. Fan hits GET /functions/v1/telegram-signup-redirect?slug=inner-circle
//      (or links.fendifrost.com/<slug>/telegram which DNS-routes here)
//   2. We generate a random one-time token, persist it in
//      telegram_signup_tokens with full UTM + Meta cookie attribution
//   3. 302 redirect to https://t.me/<bot>?start=<token>
//   4. Telegram delivers /start <token> to telegram-webhook, which consumes
//      the token and links the chat_id to a telegram_subscribers row.
//
// Auth: this endpoint is PUBLIC — it has to be, because fans click it
// from social bios, smart links, QR codes, etc. The token it issues is
// single-use and 24h-expiring, so there's no abuse vector beyond
// generating dead tokens.
//
// Config: requires verify_jwt = false in supabase/config.toml.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function cookieVal(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m?.[1]?.trim() ?? null;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function newToken(): string {
  // 32 random bytes -> URL-safe base64. ~43 chars. Plenty unique.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const slug = url.searchParams.get("slug") ?? "inner-circle";
  const email = (url.searchParams.get("email") ?? "").toLowerCase().trim() || null;
  const utmSource = url.searchParams.get("utm_source");
  const utmMedium = url.searchParams.get("utm_medium");
  const utmCampaign = url.searchParams.get("utm_campaign");
  const fbclid = url.searchParams.get("fbclid");

  const cookieHeader = req.headers.get("cookie");
  const fbp = cookieVal(cookieHeader, "_fbp");
  const fbc = cookieVal(cookieHeader, "_fbc");

  const userAgent = req.headers.get("user-agent");
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    null;
  const ipHash = ip ? await sha256Hex(ip) : null;

  const { getTelegramBotUsername } = await import("../_shared/telegramEnv.ts");
  const botUsername = getTelegramBotUsername();
  if (!botUsername) {
    console.error("[telegram-signup-redirect] telegram_bot_username not set");
    return new Response("server misconfigured", { status: 500, headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const token = newToken();
  const { error: insErr } = await supabase
    .from("telegram_signup_tokens")
    .insert({
      token,
      smart_link_slug: slug,
      email,
      utm_source: utmSource,
      utm_medium: utmMedium,
      utm_campaign: utmCampaign,
      fbclid,
      meta_fbp: fbp,
      meta_fbc: fbc,
      user_agent: userAgent,
      ip_hash: ipHash,
    });

  if (insErr) {
    console.error("[telegram-signup-redirect] token insert failed", insErr.message);
    // Still redirect — better to lose attribution than to block the fan.
  }

  const deepLink = `https://t.me/${botUsername.replace(/^@/, "")}?start=${encodeURIComponent(token)}`;
  return Response.redirect(deepLink, 302);
});
