// resend-webhook
//
// Public endpoint for Resend delivery failures. On a hard bounce, a suppression,
// or a spam complaint we mark the matching playlist_targets row: bump bounce_count,
// stamp last_bounced_at, and after 2 bounces flip verification_status to 'bounced'
// and add the domain to domain_blocklist so it stops re-entering the draft pipeline.
// The matching pitch_log is status bounced, placement_status bounced, and its
// cooldown is cleared. The linked email handoff is stamped bounced and is not
// left labeled SENT. Soundplate routes and generated_by='fendi' drafts stay put;
// that skip lives in markLinkedHandoffEmailBounced.
//
// Subscribe the Resend webhook to email.bounced, email.complained, and
// email.suppressed. Point it at:
//   https://<project-ref>.supabase.co/functions/v1/resend-webhook
// Auth: Svix signature (svix-id, svix-timestamp, svix-signature) when
// RESEND_WEBHOOK_SECRET is the endpoint's whsec_ signing secret, or the legacy
// shared secret via ?secret= / x-webhook-secret. A normal Resend delivery does
// not send the query secret, so a whsec_ secret is what makes subscription work.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { markLinkedHandoffEmailBounced } from "../_shared/handoff-sent.ts";
import {
  authorizeResendWebhook,
  pitchLogBouncePatch,
  resendDeliveryFailure,
  resendProviderEmailId,
  resendRecipients,
} from "../_shared/resend-webhook-event.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-api-key, svix-id, svix-timestamp, svix-signature, webhook-id, webhook-timestamp, webhook-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BOUNCE_BLOCK_THRESHOLD = 2;

type ResendEvent = {
  type?: string;
  data?: Record<string, unknown>;
};

function header(req: Request, ...names: string[]): string | null {
  for (const name of names) {
    const value = req.headers.get(name);
    if (value) return value;
  }
  return null;
}

function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  return at < 0 ? null : email.slice(at + 1).toLowerCase() || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  const rawBody = await req.text();
  const expectedSecret = Deno.env.get("RESEND_WEBHOOK_SECRET") ?? "";
  const provided = new URL(req.url).searchParams.get("secret") ?? req.headers.get("x-webhook-secret");
  const authorized = await authorizeResendWebhook({
    expectedSecret,
    providedSecret: provided,
    rawBody,
    svixId: header(req, "svix-id", "webhook-id"),
    svixTimestamp: header(req, "svix-timestamp", "webhook-timestamp"),
    svixSignature: header(req, "svix-signature", "webhook-signature"),
  });
  if (!authorized) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let ev: ResendEvent;
  try {
    ev = JSON.parse(rawBody) as ResendEvent;
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const type = String(ev.type ?? "");
  const failure = resendDeliveryFailure(type);
  if (!failure) {
    return new Response(JSON.stringify({ ok: true, ignored: type }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const emails = resendRecipients(ev.data);
  const reason = failure === "complaint" ? "spam_flag" : "bounce";
  const updated: string[] = [];
  const emailId = resendProviderEmailId(ev.data);
  const bouncedPitchIds: string[] = [];
  const bouncePatch = pitchLogBouncePatch();

  // Match the provider id even when the recipient list is missing. The id is
  // data.email_id. Do not fall back to a different song when that id is present
  // and matches nothing.
  if (emailId) {
    const { error } = await supabase.from("pitch_log").update(bouncePatch)
      .eq("status", "sent")
      .eq("resend_message_id", emailId);
    if (error) console.error("pitch_log bounce update failed:", error.message, { emailId });
  }

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

    const domain = domainOf(email);
    if (domain && (reason === "spam_flag" || (targets?.some((t) => Number(t.bounce_count ?? 0) + 1 >= BOUNCE_BLOCK_THRESHOLD)))) {
      await supabase.from("domain_blocklist").upsert(
        { domain, reason, added_by: "resend-webhook" },
        { onConflict: "domain" },
      );
    }

    if (!emailId) {
      const { data: latest } = await supabase.from("pitch_log")
        .select("id")
        .ilike("curator_email", email)
        .eq("status", "sent")
        .order("sent_at", { ascending: false })
        .limit(1);
      const pitchId = latest?.[0]?.id;
      if (pitchId) {
        await supabase.from("pitch_log").update(bouncePatch).eq("id", pitchId).eq("status", "sent");
        bouncedPitchIds.push(String(pitchId));
      }
    }
  }

  const bouncedAt = new Date().toISOString();
  if (emailId) {
    const handoff = await markLinkedHandoffEmailBounced(supabase, {
      resendMessageId: emailId,
      bouncedAt,
    });
    if (handoff.error) console.error("handoff bounce stamp failed:", handoff.error, { emailId });
  } else {
    for (const pitchId of bouncedPitchIds) {
      const handoff = await markLinkedHandoffEmailBounced(supabase, {
        resendMessageId: null,
        pitchLogId: pitchId,
        bouncedAt,
      });
      if (handoff.error) console.error("handoff bounce stamp failed:", handoff.error, { pitchId });
    }
  }

  return new Response(JSON.stringify({ ok: true, event: type, recipients: emails, targets_updated: updated }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
