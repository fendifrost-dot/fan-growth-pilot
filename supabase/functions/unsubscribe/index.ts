// unsubscribe
//
// Public, unauthenticated endpoint. Handles both:
//   GET  /unsubscribe?t=<token>     -> shows confirmation page + flips subscribed=false
//   POST /unsubscribe?t=<token>     -> List-Unsubscribe one-click (RFC 8058) -> 204
//
// SECURITY: token is a 48-char hex secret per contact; no enumeration risk.
// We perform the unsubscribe on GET because most mail clients only follow GETs
// for the visible "unsubscribe" link, and RFC 8058 mandates POST works too.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function pageHTML(opts: {
  status: "ok" | "already" | "missing" | "error";
  email?: string;
  errorMessage?: string;
}): string {
  const { status, email, errorMessage } = opts;
  const safeEmail = email ? email.replace(/</g, "&lt;").replace(/>/g, "&gt;") : "";

  const headline =
    status === "ok"        ? "You're unsubscribed."
    : status === "already" ? "Already unsubscribed."
    : status === "missing" ? "Link expired."
                            : "Something went wrong.";

  const sub =
    status === "ok" || status === "already"
      ? safeEmail
        ? `${safeEmail} won't receive emails from Fendi Frost anymore.`
        : `You won't receive emails from Fendi Frost anymore.`
      : status === "missing"
        ? "This unsubscribe link is no longer valid. If you keep receiving emails, reply to the last one and we'll handle it manually."
        : (errorMessage || "Please try again, or reply to the email and we'll take you off the list manually.");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Unsubscribe — Fendi Frost</title>
<style>
  html, body { margin: 0; padding: 0; background: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif; color: #111; }
  .wrap { max-width: 560px; margin: 0 auto; padding: 80px 24px; text-align: center; }
  .card { background: #fff; padding: 56px 32px; border-radius: 4px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 16px; letter-spacing: -0.01em; }
  p  { font-size: 15px; line-height: 1.65; color: #555; margin: 0 0 28px; }
  .footer { font-size: 12px; color: #999; margin-top: 28px; letter-spacing: 0.04em; text-transform: uppercase; }
  a  { color: #111; text-decoration: underline; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>${headline}</h1>
      <p>${sub}</p>
      <div class="footer">Fendi Frost · fendifrost.com</div>
    </div>
  </div>
</body>
</html>`;
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const token = url.searchParams.get("t") || url.searchParams.get("token") || "";

  // One-click POST (RFC 8058) — no UI needed, just 204
  if (req.method === "POST") {
    if (!token) return new Response(null, { status: 400 });
    try {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      await supabase.rpc("unsubscribe_by_token", { p_token: token });
    } catch (e) {
      console.error("Unsubscribe POST failed", e);
    }
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  if (!token) {
    return htmlResponse(pageHTML({ status: "missing" }), 400);
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data, error } = await supabase.rpc("unsubscribe_by_token", { p_token: token });
    if (error) {
      console.error("RPC error", error);
      return htmlResponse(pageHTML({ status: "error", errorMessage: error.message }), 500);
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.email) {
      return htmlResponse(pageHTML({ status: "missing" }), 404);
    }

    return htmlResponse(
      pageHTML({
        status: row.already_unsubscribed ? "already" : "ok",
        email: row.email,
      }),
    );
  } catch (e) {
    console.error("Unsubscribe failed", e);
    return htmlResponse(pageHTML({ status: "error", errorMessage: (e as Error).message }), 500);
  }
});
