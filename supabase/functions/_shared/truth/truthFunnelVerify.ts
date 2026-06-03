import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { attributePurchase } from "./attribution.ts";
import { ingestTruthEvent } from "./truthIngest.ts";

export type FunnelStepResult = {
  step: string;
  ok: boolean;
  event_id?: string;
  identity_id?: string | null;
  link_analytics_id?: string;
  converted?: boolean;
  error?: string;
  details?: Record<string, unknown>;
};

export type FullFunnelReport = {
  ok: boolean;
  mode: "full";
  smart_link_id: string | null;
  smart_link_slug: string | null;
  test_email: string;
  click_id: string;
  steps: FunnelStepResult[];
  capi: {
    optional: boolean;
    note: string;
    any_attempted: boolean;
    any_ok: boolean;
  };
};

async function resolveTestSmartLink(
  sb: SupabaseClient,
  smartLinkId?: string | null
): Promise<{ id: string; slug: string; user_id: string | null } | null> {
  if (smartLinkId) {
    const { data } = await sb
      .from("smart_links")
      .select("id, slug, user_id")
      .eq("id", smartLinkId)
      .maybeSingle();
    if (data?.id) return data as { id: string; slug: string; user_id: string | null };
  }
  const { data } = await sb
    .from("smart_links")
    .select("id, slug, user_id")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.id ? (data as { id: string; slug: string; user_id: string | null }) : null;
}

export async function runFullFunnelVerify(
  sb: SupabaseClient,
  options?: { smartLinkId?: string | null; requireCapi?: boolean }
): Promise<FullFunnelReport> {
  const ts = Date.now();
  const testEmail = `funnel-verify+${ts}@example.invalid`;
  const clickId = `funnel-click-${ts}`;
  const sessionId = `funnel-sess-${ts}`;
  const steps: FunnelStepResult[] = [];

  const link = await resolveTestSmartLink(sb, options?.smartLinkId);
  const smartLinkId = link?.id ?? null;
  const slug = link?.slug ?? "verify-slug";
  const ownerId = link?.user_id ?? null;

  const baseMeta = {
    campaign: null,
    source: "funnel_verify",
    medium: "script",
    referrer: null,
    session_id: sessionId,
    anonymous_id: sessionId,
    orderId: null,
    value: null,
    currency: null,
    smart_link_owner_id: ownerId,
    slug,
    content_id: slug,
  };

  // A. page_view
  try {
    const pv = await ingestTruthEvent(
      {
        event_type: "page_view",
        event_time: new Date().toISOString(),
        smartLinkId,
        fan_profile_id: null,
        source: "funnel_verify",
        platform: "web",
        identity_fields: { email: null, phone: null },
        metadata: { ...baseMeta, click_id: null },
      },
      { supabase: sb, awaitCapi: false }
    );
    const { data: row } = await sb
      .from("fan_events")
      .select("id, event_type, metadata")
      .eq("id", pv.eventId)
      .maybeSingle();
    const ok = Boolean(row && row.event_type === "page_view");
    steps.push({
      step: "page_view",
      ok,
      event_id: pv.eventId,
      details: { fan_events: ok, smart_link_id_in_meta: smartLinkId != null },
    });
  } catch (e) {
    steps.push({
      step: "page_view",
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // B. email_submit
  try {
    const em = await ingestTruthEvent(
      {
        event_type: "email_submit",
        event_time: new Date().toISOString(),
        smartLinkId,
        fan_profile_id: null,
        source: "funnel_verify",
        platform: "web",
        email: testEmail,
        identity_fields: { email: testEmail, phone: null },
        metadata: { ...baseMeta, click_id: null },
      },
      { supabase: sb, awaitCapi: true }
    );
    const { data: fe } = await sb
      .from("fan_events")
      .select("id, fan_profile_id")
      .eq("id", em.eventId)
      .maybeSingle();
    let profileOk = false;
    if (em.identityId) {
      const { data: prof } = await sb
        .from("fan_profiles")
        .select("id, email")
        .eq("id", em.identityId)
        .maybeSingle();
      profileOk = Boolean(prof?.email && String(prof.email).toLowerCase() === testEmail);
    }
    let leadOk: boolean | null = null;
    if (smartLinkId) {
      const { data: lead } = await sb
        .from("smart_link_leads")
        .select("id")
        .eq("email", testEmail)
        .eq("smart_link_id", smartLinkId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      leadOk = Boolean(lead?.id);
    }
    steps.push({
      step: "email_submit",
      ok: Boolean(fe && profileOk),
      event_id: em.eventId,
      identity_id: em.identityId,
      details: {
        fan_events: Boolean(fe),
        fan_profile: profileOk,
        smart_link_leads: leadOk,
        capi: em.capi ?? null,
      },
    });
  } catch (e) {
    steps.push({
      step: "email_submit",
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // C. link_click → link_analytics
  let linkAnalyticsId: string | undefined;
  try {
    if (!smartLinkId) {
      steps.push({
        step: "link_click",
        ok: false,
        error: "no active smart_links row — set TRUTH_TEST_SMART_LINK_ID or create an active link",
      });
    } else {
      const lc = await ingestTruthEvent(
        {
          event_type: "link_click",
          event_time: new Date().toISOString(),
          smartLinkId,
          fan_profile_id: null,
          source: "funnel_verify",
          platform: "spotify",
          identity_fields: { email: testEmail, phone: null },
          metadata: {
            ...baseMeta,
            click_id: clickId,
            user_agent: "TruthFunnelVerify/1.0",
          },
        },
        { supabase: sb, awaitCapi: true }
      );
      linkAnalyticsId = lc.eventId;
      const { data: la } = await sb
        .from("link_analytics")
        .select("id, link_id, metadata, converted")
        .eq("id", lc.eventId)
        .maybeSingle();
      const meta = (la?.metadata as Record<string, unknown>) || {};
      const ok =
        la != null &&
        la.link_id === smartLinkId &&
        String(meta.click_id ?? meta.clickId) === clickId;
      steps.push({
        step: "link_click",
        ok,
        event_id: lc.eventId,
        link_analytics_id: lc.eventId,
        details: { link_analytics: ok, click_id: clickId, capi: lc.capi ?? null },
      });
    }
  } catch (e) {
    steps.push({
      step: "link_click",
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // D. purchase + link_analytics.converted
  try {
    await attributePurchase(`funnel-ord-${ts}`, 1.0, "USD", "funnel_verify", {
      clickId,
      smartLinkId: smartLinkId ?? undefined,
      email: testEmail,
    });
    const since = new Date(Date.now() - 120_000).toISOString();
    const { data: purchases } = await sb
      .from("fan_events")
      .select("id, metadata")
      .eq("event_type", "purchase")
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: false })
      .limit(5);
    const purchaseRow = purchases?.find((p) => {
      const m = (p.metadata as Record<string, unknown>) || {};
      return String(m.orderId) === `funnel-ord-${ts}`;
    });
    let converted = false;
    if (linkAnalyticsId) {
      const { data: la } = await sb
        .from("link_analytics")
        .select("converted, conversion_value")
        .eq("id", linkAnalyticsId)
        .maybeSingle();
      converted = la?.converted === true;
    }
    steps.push({
      step: "purchase",
      ok: Boolean(purchaseRow) && (linkAnalyticsId ? converted : true),
      event_id: purchaseRow?.id as string | undefined,
      converted,
      details: {
        fan_events_purchase: Boolean(purchaseRow),
        link_analytics_converted: linkAnalyticsId ? converted : "skipped_no_link_click",
      },
    });
  } catch (e) {
    steps.push({
      step: "purchase",
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const since = new Date(Date.now() - 180_000).toISOString();
  const { data: capiLogs } = await sb
    .from("system_logs")
    .select("process_name, metadata")
    .in("process_name", ["capi:request", "capi:response", "capi:skipped"])
    .gte("created_at", since)
    .limit(20);
  const anyAttempted = Boolean(capiLogs?.some((l) => l.process_name === "capi:request"));
  const anyOk = Boolean(
    capiLogs?.some((l) => {
      if (l.process_name !== "capi:response") return false;
      const m = (l.metadata as Record<string, unknown>) || {};
      const st = m.httpStatus;
      return typeof st === "number" && st >= 200 && st < 300;
    })
  );

  const funnelOk = steps.every((s) => s.ok);
  const capiOk = !options?.requireCapi || anyOk;
  const ok = funnelOk && capiOk;

  return {
    ok,
    mode: "full",
    smart_link_id: smartLinkId,
    smart_link_slug: slug,
    test_email: testEmail,
    click_id: clickId,
    steps,
    capi: {
      optional: !options?.requireCapi,
      note: options?.requireCapi
        ? "CAPI required for pass"
        : "CAPI optional in local verify; set requireCapi=true to enforce",
      any_attempted: anyAttempted,
      any_ok: anyOk,
    },
  };
}
