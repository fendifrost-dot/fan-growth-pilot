// resend-webhook
//
// Public endpoint for Resend delivery events (bounces / complaints). On a hard bounce or
// spam complaint we mark the matching playlist_targets row: bump bounce_count, stamp
// last_bounced_at, and after 2 bounces flip verification_status to 'bounced' and add the
// domain to domain_blocklist so it stops re-entering the draft pipeline.
//
// Configure in Resend → Webhooks, pointing at:
//   https://<project-ref>.functions.supabase.co/resend-webhook?secret=<RESEND_WEBHOOK_SECRET>
// SECURITY: this verifies a shared ?secret= against RESEND_WEBHOOK_SECRET when that env var
// is set. (Resend also offers Svix-signed webhooks; swap in svix verification if preferred.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BOUNCE_BLOCK_THRESHOLD = 2;

type ResendEvent = {
  type?: string;
  data?: { to?: string[] | string; email?: string; subject?: string };
};

function recipients(ev: ResendEvent): string[] {
  const to = ev.data?.to ?? ev.data?.email ?? [];
  const arr = Array.isArray(to) ? to : [to];
  return arr.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
}

function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  return at < 0 ? null : email.slice(at + 1).toLowerCase() || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  const expectedSecret = Deno.env.get("RESEND_WEBHOOK_SECRET");
  if (expectedSecret) {
    const provided = new URL(req.url).searchParams.get("secret")
      ?? req.headers.get("x-webhook-secret");
    if (provided !== expectedSecret) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  }

  let ev: ResendEvent;
  try {
    ev = await req.json() as ResendEvent;
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const type = String(ev.type ?? "");
  const isBounce = type === "email.bounced" || type === "email.complained";
  if (!isBounce) {
    // Acknowledge other event types (delivered, opened, …) without action.
    return new Response(JSON.stringify({ ok: true, ignored: type }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const emails = recipients(ev);
  const reason = type === "email.complained" ? "spam_flag" : "bounce";
  const updated: string[] = [];

  for (const email of emails) {
    const { data: targets } = await supabase.from("playlist_targets")
      .select("playlist_id, bounce_count")
      .eq("curator_email", email);
    for (const t of targets ?? []) {
      const nextCount = Number(t.bounce_count ?? 0) + 1;
      const patch: Record<string, unknown> = {
        bounce_count: nextCount,
        last_bounced_at: new Date().toISOString(),
      };
      if (reason === "spam_flag") patch.verification_status = "spam_flagged";
      else if (nextCount >= BOUNCE_BLOCK_THRESHOLD) patch.verification_status = "bounced";
      await supabase.from("playlist_targets").update(patch).eq("playlist_id", t.playlist_id);
      updated.push(String(t.playlist_id));
    }

    // Block the domain after the threshold (or immediately on a complaint).
    const domain = domainOf(email);
    if (domain && (reason === "spam_flag" || (targets?.some((t) => Number(t.bounce_count ?? 0) + 1 >= BOUNCE_BLOCK_THRESHOLD)))) {
      await supabase.from("domain_blocklist").upsert(
        { domain, reason, added_by: "resend-webhook" },
        { onConflict: "domain" },
      );
    }
  }

  return new Response(JSON.stringify({ ok: true, event: type, recipients: emails, targets_updated: updated }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
