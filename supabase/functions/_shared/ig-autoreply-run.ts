/**
 * Instagram inbound webhook → auto-reply orchestration.
 * Reply-only: only reachable from verified Meta webhook events.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { createSupabaseServiceClient } from "./truth/supabaseService.ts";
import { ingestTruthEvent } from "./truth/truthIngest.ts";

export type IgTriggerType = "story_reply" | "comment" | "dm";

export type IgInboundEvent = {
  igUserId: string;
  igHandle: string | null;
  triggerType: IgTriggerType;
  inboundText: string | null;
  eventTimestampMs: number;
  commentId: string | null;
};

type AutoreplyRule = {
  id: string;
  trigger_type: string;
  keyword: string | null;
  smartlink_url: string;
  reply_template: string;
  album_slug: string | null;
  active: boolean;
  priority: number;
};

export const OPT_OUT_WORDS = ["stop", "unsubscribe"] as const;
export const PER_USER_REPLY_CAP_24H = 3;
export const GLOBAL_REPLY_CAP_HOUR = 199;
export const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;
// Private replies to a comment are permitted within 7 days of the comment.
export const COMMENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const OPT_OUT_CONFIRM =
  "you're unsubscribed — we won't auto-message you again. reply anytime to re-engage.";

export function parseInstagramWebhook(body: Record<string, unknown>): IgInboundEvent[] {
  const events: IgInboundEvent[] = [];
  const entries = Array.isArray(body.entry) ? body.entry : [];

  for (const rawEntry of entries) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as Record<string, unknown>;

    const messaging = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const rawMsg of messaging) {
      if (!rawMsg || typeof rawMsg !== "object") continue;
      const msg = rawMsg as Record<string, unknown>;
      const sender = msg.sender as Record<string, unknown> | undefined;
      const senderId = sender?.id;
      if (!senderId) continue;

      const message = msg.message as Record<string, unknown> | undefined;
      if (message?.is_echo) continue;

      const postback = msg.postback as Record<string, unknown> | undefined;
      const text =
        (message?.text != null ? String(message.text) : null) ??
        (postback?.payload != null ? String(postback.payload) : null);
      if (!text && !message?.reply_to) continue;

      const timestamp = msg.timestamp != null ? Number(msg.timestamp) : Date.now();
      const replyTo = message?.reply_to as Record<string, unknown> | undefined;
      const isStoryReply = Boolean(replyTo?.story);

      events.push({
        igUserId: String(senderId),
        igHandle: sender?.username != null ? String(sender.username) : null,
        triggerType: isStoryReply ? "story_reply" : "dm",
        inboundText: text,
        eventTimestampMs: timestamp,
        commentId: null,
      });
    }

    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const rawChange of changes) {
      if (!rawChange || typeof rawChange !== "object") continue;
      const change = rawChange as Record<string, unknown>;
      if (change.field !== "comments") continue;

      const value = change.value as Record<string, unknown> | undefined;
      const from = value?.from as Record<string, unknown> | undefined;
      if (!from?.id) continue;

      const entryTime = entry.time != null ? Number(entry.time) * 1000 : Date.now();
      events.push({
        igUserId: String(from.id),
        igHandle: from.username != null ? String(from.username) : null,
        triggerType: "comment",
        inboundText: value?.text != null ? String(value.text) : null,
        eventTimestampMs: entryTime,
        commentId: value?.id != null ? String(value.id) : null,
      });
    }
  }

  return events;
}

export async function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = signatureHeader.slice(7).toLowerCase();

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const computed = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return computed === expected;
}

function rosterHandle(igUserId: string, igHandle: string | null): string {
  if (igHandle) return igHandle.replace(/^@/, "").trim().toLowerCase();
  return `uid_${igUserId}`;
}

function isOptOutText(text: string | null): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase().replace(/[^a-z\s]/g, "").trim();
  // Only treat as opt-out on short, command-like messages so a compliment like
  // "don't stop the music" doesn't silently unsubscribe an engaged fan.
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  if (wordCount > 3) return false;
  return OPT_OUT_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(normalized));
}

function matchRule(
  rules: AutoreplyRule[],
  triggerType: IgTriggerType,
  inboundText: string | null,
): AutoreplyRule | null {
  const applicable = rules
    .filter((r) => r.active && r.trigger_type === triggerType)
    .sort((a, b) => a.priority - b.priority);

  const textLower = (inboundText ?? "").toLowerCase().trim();

  for (const rule of applicable) {
    if (rule.keyword) {
      const kw = rule.keyword.toLowerCase().trim();
      if (textLower.includes(kw)) return rule;
    }
  }
  for (const rule of applicable) {
    if (!rule.keyword) return rule;
  }
  return null;
}

function renderTemplate(template: string, smartlinkUrl: string): string {
  return template.replace(/\{\{link\}\}/g, smartlinkUrl);
}

async function resolveSmartLinkId(
  sb: SupabaseClient,
  albumSlug: string | null,
): Promise<string | null> {
  if (!albumSlug) return null;
  const { data } = await sb
    .from("smart_links")
    .select("id")
    .eq("slug", albumSlug)
    .maybeSingle();
  return (data?.id as string) ?? null;
}

async function countUserReplies24h(sb: SupabaseClient, igUserId: string): Promise<number> {
  const since = new Date(Date.now() - MESSAGING_WINDOW_MS).toISOString();
  const { count } = await sb
    .from("ig_autoreply_log")
    .select("*", { count: "exact", head: true })
    .eq("ig_user_id", igUserId)
    .eq("reply_sent", true)
    .gte("created_at", since);
  return count ?? 0;
}

async function countGlobalRepliesHour(sb: SupabaseClient): Promise<number> {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await sb
    .from("ig_autoreply_log")
    .select("*", { count: "exact", head: true })
    .eq("reply_sent", true)
    .gte("created_at", since);
  return count ?? 0;
}

async function insertLog(
  sb: SupabaseClient,
  row: Record<string, unknown>,
): Promise<string | null> {
  const { data, error } = await sb.from("ig_autoreply_log").insert(row).select("id").maybeSingle();
  if (error) {
    console.error("[ig-autoreply] log insert failed:", error.message);
    return null;
  }
  return (data?.id as string) ?? null;
}

async function sendInstagramMessage(
  recipientId: string,
  message: string,
  opts?: { commentId?: string | null },
): Promise<{ ok: boolean; details?: unknown }> {
  const base = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "");
  if (!base) return { ok: false, details: { error: "SUPABASE_URL missing" } };

  // Comment triggers reply privately via comment_id; DM/story reply via user id.
  const payload = opts?.commentId
    ? { comment_id: opts.commentId, message }
    : { recipient_id: recipientId, message };

  const res = await fetch(`${base}/functions/v1/instagram-messaging`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const details = await res.json().catch(() => ({}));
  return { ok: res.ok, details };
}

async function fireMetaLead(eventId: string, igUserId: string): Promise<void> {
  const base = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "");
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!base) return;

  try {
    await fetch(`${base}/functions/v1/meta-conversions`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: anon },
      body: JSON.stringify({
        event_name: "Lead",
        event_id: eventId,
        action_source: "other",
        user_data: { external_id: igUserId },
      }),
    });
  } catch (e) {
    console.error("[ig-autoreply] meta-conversions failed:", e);
  }
}

async function logEngagementReceived(
  sb: SupabaseClient,
  event: IgInboundEvent,
): Promise<void> {
  try {
    await ingestTruthEvent(
      {
        event_type: "ig_engagement_received",
        source: "instagram",
        platform: "instagram",
        identity_fields: { external_id: event.igUserId },
        metadata: {
          trigger_type: event.triggerType,
          inbound_text: event.inboundText,
          ig_handle: event.igHandle,
        },
      },
      { supabase: sb, awaitCapi: false },
    );
  } catch (e) {
    console.error("[ig-autoreply] ig_engagement_received ingest failed:", e);
  }
}

async function handleSkip(
  sb: SupabaseClient,
  event: IgInboundEvent,
  skipReason: string,
  matchedRuleId: string | null = null,
): Promise<void> {
  await insertLog(sb, {
    ig_user_id: event.igUserId,
    ig_handle: event.igHandle,
    trigger_type: event.triggerType,
    inbound_text: event.inboundText,
    matched_rule: matchedRuleId,
    reply_sent: false,
    skip_reason: skipReason,
  });
}

export async function processInstagramWebhook(
  body: Record<string, unknown>,
  sb?: SupabaseClient,
): Promise<{ processed: number; results: Record<string, unknown>[] }> {
  const client = sb ?? createSupabaseServiceClient();
  const events = parseInstagramWebhook(body);
  const results: Record<string, unknown>[] = [];

  const { data: rules, error: rulesErr } = await client
    .from("ig_autoreply_rules")
    .select("*")
    .eq("active", true);
  if (rulesErr) {
    console.error("[ig-autoreply] rules fetch failed:", rulesErr.message);
    return { processed: 0, results: [{ error: rulesErr.message }] };
  }

  for (const event of events) {
    await logEngagementReceived(client, event);

    const handle = rosterHandle(event.igUserId, event.igHandle);
    const { data: roster } = await client
      .from("instagram_fan_roster")
      .select("do_not_contact, ig_handle")
      .or(`ig_user_id.eq.${event.igUserId},ig_handle.eq.${handle}`)
      .maybeSingle();

    if (roster?.do_not_contact) {
      await handleSkip(client, event, "opt_out");
      results.push({ ig_user_id: event.igUserId, skip_reason: "opt_out" });
      continue;
    }

    const windowMs = event.triggerType === "comment" ? COMMENT_WINDOW_MS : MESSAGING_WINDOW_MS;
    const ageMs = Date.now() - event.eventTimestampMs;
    if (ageMs > windowMs) {
      await handleSkip(client, event, "outside_window");
      results.push({ ig_user_id: event.igUserId, skip_reason: "outside_window" });
      continue;
    }

    if (isOptOutText(event.inboundText)) {
      await client.from("instagram_fan_roster").upsert(
        {
          ig_handle: roster?.ig_handle ?? handle,
          ig_user_id: event.igUserId,
          do_not_contact: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "ig_handle" },
      );
      await sendInstagramMessage(event.igUserId, OPT_OUT_CONFIRM);
      await handleSkip(client, event, "opt_out");
      results.push({ ig_user_id: event.igUserId, skip_reason: "opt_out", opt_out_confirmed: true });
      continue;
    }

    const userReplies = await countUserReplies24h(client, event.igUserId);
    if (userReplies >= PER_USER_REPLY_CAP_24H) {
      await handleSkip(client, event, "rate_capped");
      results.push({ ig_user_id: event.igUserId, skip_reason: "rate_capped", scope: "per_user" });
      continue;
    }

    const globalReplies = await countGlobalRepliesHour(client);
    if (globalReplies >= GLOBAL_REPLY_CAP_HOUR) {
      await handleSkip(client, event, "rate_capped");
      results.push({ ig_user_id: event.igUserId, skip_reason: "rate_capped", scope: "global" });
      continue;
    }

    const rule = matchRule((rules ?? []) as AutoreplyRule[], event.triggerType, event.inboundText);
    if (!rule) {
      await handleSkip(client, event, "no_match");
      results.push({ ig_user_id: event.igUserId, skip_reason: "no_match" });
      continue;
    }

    const replyText = renderTemplate(rule.reply_template, rule.smartlink_url);
    const sendResult = await sendInstagramMessage(event.igUserId, replyText, {
      commentId: event.triggerType === "comment" ? event.commentId : null,
    });
    if (!sendResult.ok) {
      await insertLog(client, {
        ig_user_id: event.igUserId,
        ig_handle: event.igHandle,
        trigger_type: event.triggerType,
        inbound_text: event.inboundText,
        matched_rule: rule.id,
        reply_sent: false,
        reply_text: replyText,
        skip_reason: "send_failed",
      });
      results.push({
        ig_user_id: event.igUserId,
        skip_reason: "send_failed",
        details: sendResult.details,
      });
      continue;
    }

    const smartLinkId = await resolveSmartLinkId(client, rule.album_slug);
    let truthEventId: string | null = null;
    try {
      const ingested = await ingestTruthEvent(
        {
          event_type: "ig_autoreply_sent",
          source: "instagram",
          platform: "instagram",
          identity_fields: { external_id: event.igUserId },
          metadata: {
            smart_link_id: smartLinkId,
            smartLinkId,
            album_slug: rule.album_slug,
            rule_id: rule.id,
            smartlink_url: rule.smartlink_url,
            trigger_type: event.triggerType,
          },
        },
        { supabase: client, awaitCapi: false },
      );
      truthEventId = ingested.eventId;
    } catch (e) {
      console.error("[ig-autoreply] ig_autoreply_sent ingest failed:", e);
    }

    const logId = await insertLog(client, {
      ig_user_id: event.igUserId,
      ig_handle: event.igHandle,
      trigger_type: event.triggerType,
      inbound_text: event.inboundText,
      matched_rule: rule.id,
      reply_sent: true,
      reply_text: replyText,
      event_id: truthEventId,
    });

    if (logId) {
      await fireMetaLead(logId, event.igUserId);
    }

    const now = new Date().toISOString();
    await client.from("instagram_fan_roster").upsert(
      {
        ig_handle: roster?.ig_handle ?? handle,
        ig_user_id: event.igUserId,
        last_contacted_at: now,
        updated_at: now,
      },
      { onConflict: "ig_handle" },
    );

    results.push({
      ig_user_id: event.igUserId,
      reply_sent: true,
      rule_id: rule.id,
      log_id: logId,
      event_id: truthEventId,
    });
  }

  return { processed: events.length, results };
}
