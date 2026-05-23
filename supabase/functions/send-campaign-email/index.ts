// send-campaign-email
//
// Sends a campaign through Resend, logging every attempt to email_sends.
//
// Auth: requires x-api-key (FANFUEL_HUB_KEY) — same pattern as send-pitch-email.
//
// Modes (one per request):
//   { mode: "test",  campaign_id, to_email, to_first_name? }
//   { mode: "batch", campaign_id, batch_size, batch_label? }
//   { mode: "preview", campaign_id, to_first_name? }   -> returns rendered HTML+text, doesn't send
//
// Personalization tokens: {{first_name}} {{unsubscribe_url}}
// Unsubscribe URL is built per recipient from email_contacts.unsubscribe_token.

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

const APP_BASE_URL = Deno.env.get("APP_BASE_URL") ?? "https://app.bemoremodest.com";

interface Contact {
  id: string;
  email: string;
  first_name: string | null;
  unsubscribe_token: string;
}

interface Template {
  id: string;
  subject: string;
  html_body: string;
  text_body: string;
}

interface Campaign {
  id: string;
  name: string;
  slug: string;
  from_email: string;
  from_name: string;
  reply_to: string | null;
  template_id: string;
  status: string;
}

function authOK(req: Request): boolean {
  const xApiKey = req.headers.get("x-api-key");
  const authHeader = req.headers.get("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const anonApiKey = req.headers.get("apikey");
  const providedKey = (xApiKey || bearerToken || anonApiKey || "").trim();
  const expectedKey = (Deno.env.get("FANFUEL_HUB_KEY") || "").trim();
  return !!expectedKey && providedKey === expectedKey;
}

async function loadCampaign(supabase: SupabaseClient, campaign_id: string): Promise<Campaign | null> {
  const { data, error } = await supabase
    .from("email_campaigns")
    .select("id, name, slug, from_email, from_name, reply_to, template_id, status")
    .eq("id", campaign_id)
    .maybeSingle();
  if (error) throw new Error(`Campaign lookup failed: ${error.message}`);
  return data as Campaign | null;
}

async function loadTemplate(supabase: SupabaseClient, template_id: string): Promise<Template | null> {
  const { data, error } = await supabase
    .from("email_templates")
    .select("id, subject, html_body, text_body")
    .eq("id", template_id)
    .maybeSingle();
  if (error) throw new Error(`Template lookup failed: ${error.message}`);
  return data as Template | null;
}

function renderBody(raw: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.replaceAll(`{{${k}}}`, v ?? ""),
    raw,
  );
}

function buildUnsubscribeUrl(token: string): string {
  return `${APP_BASE_URL}/unsubscribe?t=${encodeURIComponent(token)}`;
}

async function sendOne(args: {
  supabase: SupabaseClient;
  campaign: Campaign;
  template: Template;
  contact: { id: string | null; email: string; first_name: string | null; unsubscribe_token: string | null };
  resendKey: string;
  test: boolean;
  batchLabel: string | null;
}): Promise<{ ok: boolean; message_id?: string; error?: string }> {
  const { supabase, campaign, template, contact, resendKey, test, batchLabel } = args;

  const first_name = contact.first_name?.trim() || "";
  const unsubscribe_url = contact.unsubscribe_token
    ? buildUnsubscribeUrl(contact.unsubscribe_token)
    : `${APP_BASE_URL}/unsubscribe`;

  const vars = { first_name, unsubscribe_url };
  const subject = renderBody(template.subject, vars);
  const html_body = renderBody(template.html_body, vars);
  const text_body = renderBody(template.text_body, vars);

  const fromHeader = `${campaign.from_name} <${campaign.from_email}>`;
  const headers: Record<string, string> = {
    "List-Unsubscribe": `<${unsubscribe_url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };

  let message_id: string | undefined;
  let error_message: string | undefined;
  let status: "sent" | "failed" = "failed";

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromHeader,
        to: [contact.email],
        subject,
        html: html_body,
        text: text_body,
        reply_to: campaign.reply_to ?? undefined,
        headers,
        tags: [
          { name: "campaign_slug", value: campaign.slug },
          { name: "test", value: test ? "true" : "false" },
        ],
      }),
    });

    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      error_message = `Resend ${resp.status}: ${JSON.stringify(body).slice(0, 500)}`;
    } else {
      message_id = body?.id;
      status = "sent";
    }
  } catch (err) {
    error_message = `Fetch failed: ${(err as Error).message}`;
  }

  // Log the attempt — truth layer
  await supabase.from("email_sends").insert({
    campaign_id: campaign.id,
    contact_id: contact.id,
    recipient_email: contact.email,
    status,
    resend_message_id: message_id ?? null,
    error_message: error_message ?? null,
    test_send: test,
    batch_label: batchLabel,
  });

  // Stamp the contact's last_sent_at on real successful sends
  if (status === "sent" && !test && contact.id) {
    await supabase
      .from("email_contacts")
      .update({ last_sent_at: new Date().toISOString() })
      .eq("id", contact.id);
  }

  return { ok: status === "sent", message_id, error: error_message };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  if (!authOK(req)) return json({ error: "Unauthorized" }, 401);

  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (!resendKey) return json({ error: "RESEND_API_KEY not configured" }, 500);

  const supabase = createClient(
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
  const campaign_id = payload?.campaign_id;
  if (!campaign_id) return json({ error: "campaign_id is required" }, 400);

  const campaign = await loadCampaign(supabase, campaign_id);
  if (!campaign) return json({ error: "Campaign not found" }, 404);

  const template = await loadTemplate(supabase, campaign.template_id);
  if (!template) return json({ error: "Template not found" }, 404);

  // -----------------------------------------------------------------
  // PREVIEW MODE
  // -----------------------------------------------------------------
  if (mode === "preview") {
    const first_name = String(payload?.to_first_name ?? "Friend");
    const vars = { first_name, unsubscribe_url: `${APP_BASE_URL}/unsubscribe?t=PREVIEW_TOKEN` };
    return json({
      subject: renderBody(template.subject, vars),
      html:    renderBody(template.html_body, vars),
      text:    renderBody(template.text_body, vars),
      from:    `${campaign.from_name} <${campaign.from_email}>`,
    });
  }

  // -----------------------------------------------------------------
  // TEST MODE
  // -----------------------------------------------------------------
  if (mode === "test") {
    const to_email = String(payload?.to_email ?? "").trim().toLowerCase();
    if (!to_email) return json({ error: "to_email is required for test mode" }, 400);

    // If there's a real contact for this email use its token; else use a synthetic preview token
    const { data: existing } = await supabase
      .from("email_contacts")
      .select("id, email, first_name, unsubscribe_token")
      .eq("email", to_email)
      .maybeSingle();

    const contact = existing ?? {
      id: null,
      email: to_email,
      first_name: payload?.to_first_name ?? null,
      unsubscribe_token: null,
    };

    const result = await sendOne({
      supabase, campaign, template, contact,
      resendKey, test: true, batchLabel: "test",
    });

    return json({ mode: "test", result });
  }

  // -----------------------------------------------------------------
  // BATCH MODE
  // -----------------------------------------------------------------
  if (mode === "batch") {
    const batch_size = Math.max(1, Math.min(500, Number(payload?.batch_size ?? 100)));
    const batch_label = String(payload?.batch_label ?? `batch-${new Date().toISOString().slice(0, 16)}`);
    const dry_run = !!payload?.dry_run;

    // Mark campaign as sending if it was draft
    if (campaign.status === "draft") {
      await supabase
        .from("email_campaigns")
        .update({ status: "sending", started_at: new Date().toISOString() })
        .eq("id", campaign.id);
    }

    // Eligible audience: subscribed=true AND never sent this campaign successfully
    const { data: alreadySent } = await supabase
      .from("email_sends")
      .select("contact_id")
      .eq("campaign_id", campaign.id)
      .eq("status", "sent")
      .eq("test_send", false);

    const alreadySentSet = new Set((alreadySent ?? []).map((r: any) => r.contact_id).filter(Boolean));

    const { data: pool, error: poolErr } = await supabase
      .from("email_contacts")
      .select("id, email, first_name, unsubscribe_token")
      .eq("subscribed", true)
      .order("created_at", { ascending: true })
      .limit(batch_size + alreadySentSet.size + 100); // overshoot, we filter then slice

    if (poolErr) return json({ error: `Audience query failed: ${poolErr.message}` }, 500);

    const eligible = (pool ?? [])
      .filter((c: any) => !alreadySentSet.has(c.id))
      .slice(0, batch_size);

    if (dry_run) {
      return json({
        mode: "batch",
        dry_run: true,
        batch_label,
        would_send: eligible.length,
        sample: eligible.slice(0, 10).map((c: any) => c.email),
        already_sent_count: alreadySentSet.size,
      });
    }

    // Send sequentially with a small jitter to be a polite neighbor to Resend
    const results: Array<{ email: string; ok: boolean; error?: string; message_id?: string }> = [];
    let realSentDelta = 0;
    let realFailedDelta = 0;

    for (const c of eligible) {
      const r = await sendOne({
        supabase, campaign, template,
        contact: c as Contact,
        resendKey, test: false, batchLabel: batch_label,
      });
      results.push({ email: (c as Contact).email, ok: r.ok, error: r.error, message_id: r.message_id });
      if (r.ok) realSentDelta++;
      else realFailedDelta++;
      // ~120ms gap between sends -> ~8/sec, well under Resend's 10/sec free tier
      await new Promise((res) => setTimeout(res, 120));
    }

    // Update campaign counters by deltas
    if (realSentDelta || realFailedDelta) {
      const { data: current } = await supabase
        .from("email_campaigns")
        .select("total_sent, total_failed")
        .eq("id", campaign.id)
        .maybeSingle();
      await supabase
        .from("email_campaigns")
        .update({
          total_sent:   (current?.total_sent   ?? 0) + realSentDelta,
          total_failed: (current?.total_failed ?? 0) + realFailedDelta,
        })
        .eq("id", campaign.id);
    }

    // Mark campaign completed if pool drained
    const { count: subscribedCount } = await supabase
      .from("email_contacts")
      .select("*", { count: "exact", head: true })
      .eq("subscribed", true);

    const { data: sentRows } = await supabase
      .from("email_sends")
      .select("contact_id")
      .eq("campaign_id", campaign.id)
      .eq("status", "sent")
      .eq("test_send", false);
    const sentContactIds = new Set((sentRows ?? []).map((r: any) => r.contact_id).filter(Boolean));

    const remainingCount = Math.max(0, (subscribedCount ?? 0) - sentContactIds.size);
    if (remainingCount === 0) {
      await supabase
        .from("email_campaigns")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("id", campaign.id);
    }

    return json({
      mode: "batch",
      batch_label,
      attempted: results.length,
      sent: realSentDelta,
      failed: realFailedDelta,
      remaining_subscribed: remainingCount,
      sample: results.slice(0, 10),
    });
  }

  return json({ error: `Unknown mode: ${mode}` }, 400);
});
