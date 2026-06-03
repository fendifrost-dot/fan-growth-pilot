import type { SupabaseClient } from "@supabase/supabase-js";

export type DashboardMetrics = {
  generated_at: string;
  period_days: number;
  stats: {
    fan_profiles_total: number;
    fan_profiles_new_7d: number;
    fan_profiles_new_30d: number;
    link_clicks: number;
    email_submits: number;
    purchases: number;
    revenue: number;
    click_to_optin_rate: number | null;
    optin_to_purchase_rate: number | null;
  };
  funnel: { stage: string; value: number; percentage: number }[];
  top_smart_links: {
    id: string;
    slug: string;
    title: string | null;
    clicks: number;
    conversions: number;
  }[];
  recent_activity: {
    event_type: string;
    message: string;
    occurred_at: string;
  }[];
  message_sends: {
    total: number;
    succeeded: number;
    failed: number;
  } | null;
  sources_breakdown: { name: string; value: number; color: string }[];
};

const SOURCE_COLORS = [
  "#8b5cf6",
  "#06b6d4",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#e91e63",
  "#1db954",
];

function sinceDays(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

export async function fetchDashboardMetrics(
  sb: SupabaseClient,
  periodDays = 30
): Promise<DashboardMetrics> {
  const since = sinceDays(periodDays);
  const since7 = sinceDays(7);

  const { count: fanTotal } = await sb
    .from("fan_profiles")
    .select("*", { count: "exact", head: true });

  const { count: fanNew7 } = await sb
    .from("fan_profiles")
    .select("*", { count: "exact", head: true })
    .gte("created_at", since7);

  const { count: fanNew30 } = await sb
    .from("fan_profiles")
    .select("*", { count: "exact", head: true })
    .gte("created_at", since);

  const { count: linkClicks } = await sb
    .from("link_analytics")
    .select("*", { count: "exact", head: true })
    .gte("clicked_at", since);

  const { count: emailSubmits } = await sb
    .from("fan_events")
    .select("*", { count: "exact", head: true })
    .eq("event_type", "email_submit")
    .gte("occurred_at", since);

  const { data: purchaseRows } = await sb
    .from("fan_events")
    .select("metadata")
    .eq("event_type", "purchase")
    .gte("occurred_at", since);

  const purchases = purchaseRows?.length ?? 0;
  let revenue = 0;
  for (const r of purchaseRows ?? []) {
    const m = (r.metadata as Record<string, unknown>) || {};
    const v = m.value;
    if (v != null && !Number.isNaN(Number(v))) revenue += Number(v);
  }

  const { count: pageViews } = await sb
    .from("fan_events")
    .select("*", { count: "exact", head: true })
    .eq("event_type", "page_view")
    .gte("occurred_at", since);

  const impressions = pageViews ?? 0;
  const clicks = linkClicks ?? 0;
  const optIns = emailSubmits ?? 0;

  const funnel = [
    { stage: "Page views", value: impressions, percentage: 100 },
    { stage: "Link clicks", value: clicks, percentage: pct(clicks, impressions || clicks || 1) },
    { stage: "Email opt-ins", value: optIns, percentage: pct(optIns, clicks || optIns || 1) },
    { stage: "Purchases", value: purchases, percentage: pct(purchases, optIns || purchases || 1) },
  ];

  const { data: links } = await sb
    .from("smart_links")
    .select("id, slug, title, click_count, metadata")
    .eq("is_active", true)
    .order("click_count", { ascending: false })
    .limit(8);

  const topSmartLinks = await Promise.all(
    (links ?? []).map(async (link) => {
      const { count: conversions } = await sb
        .from("link_analytics")
        .select("*", { count: "exact", head: true })
        .eq("link_id", link.id as string)
        .eq("converted", true);
      const meta = (link.metadata as Record<string, unknown>) || {};
      const title =
        (link.title as string) ||
        (meta.campaignName as string) ||
        (meta.title as string) ||
        null;
      return {
        id: link.id as string,
        slug: link.slug as string,
        title,
        clicks: Number(link.click_count ?? 0),
        conversions: conversions ?? 0,
      };
    })
  );

  const { data: events } = await sb
    .from("fan_events")
    .select("event_type, occurred_at, metadata, event_source")
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false })
    .limit(12);

  const recent_activity = (events ?? []).map((e) => {
    const meta = (e.metadata as Record<string, unknown>) || {};
    const slug = (meta.slug as string) || "";
    const src = (e.event_source as string) || (meta.source as string) || "";
    const label = String(e.event_type).replace(/_/g, " ");
    const message = slug
      ? `${label} · ${slug}${src ? ` (${src})` : ""}`
      : `${label}${src ? ` · ${src}` : ""}`;
    return {
      event_type: e.event_type as string,
      message,
      occurred_at: e.occurred_at as string,
    };
  });

  const { data: sourceEvents } = await sb
    .from("fan_events")
    .select("event_source, metadata")
    .gte("occurred_at", since)
    .in("event_type", ["page_view", "link_click", "email_submit"]);

  const sourceCounts = new Map<string, number>();
  for (const e of sourceEvents ?? []) {
    const meta = (e.metadata as Record<string, unknown>) || {};
    const name = String(
      (meta.source as string) || (e.event_source as string) || "unknown"
    ).slice(0, 40);
    sourceCounts.set(name, (sourceCounts.get(name) ?? 0) + 1);
  }
  const sources_breakdown = Array.from(sourceCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7)
    .map(([name, value], i) => ({
      name,
      value,
      color: SOURCE_COLORS[i % SOURCE_COLORS.length],
    }));

  let message_sends: DashboardMetrics["message_sends"] = null;
  const { data: sends, error: sendsErr } = await sb
    .from("message_sends")
    .select("status")
    .gte("created_at", since);
  if (!sendsErr && sends) {
    message_sends = {
      total: sends.length,
      succeeded: sends.filter((s) => s.status === "sent" || s.status === "success").length,
      failed: sends.filter((s) => s.status === "failed" || s.status === "error").length,
    };
  }

  return {
    generated_at: new Date().toISOString(),
    period_days: periodDays,
    stats: {
      fan_profiles_total: fanTotal ?? 0,
      fan_profiles_new_7d: fanNew7 ?? 0,
      fan_profiles_new_30d: fanNew30 ?? 0,
      link_clicks: clicks,
      email_submits: optIns,
      purchases,
      revenue: Math.round(revenue * 100) / 100,
      click_to_optin_rate: clicks > 0 ? pct(optIns, clicks) : null,
      optin_to_purchase_rate: optIns > 0 ? pct(purchases, optIns) : null,
    },
    funnel,
    top_smart_links: topSmartLinks,
    recent_activity,
    message_sends,
    sources_breakdown,
  };
}

export type AudienceSegment = {
  id: string;
  name: string;
  description: string;
  count: number;
  lastUpdated: string;
  conversionRate: number | null;
  filters: { type: string; operator: string; value: string | number }[];
};

export async function fetchAudienceSegments(sb: SupabaseClient): Promise<AudienceSegment[]> {
  const since30 = sinceDays(30);
  const now = new Date().toISOString();

  const { count: allFans } = await sb
    .from("fan_profiles")
    .select("*", { count: "exact", head: true });

  const { count: leads } = await sb
    .from("smart_link_leads")
    .select("*", { count: "exact", head: true });

  const { data: purchaseEvents } = await sb
    .from("fan_events")
    .select("fan_profile_id")
    .eq("event_type", "purchase")
    .gte("occurred_at", since30);

  const purchaserIds = new Set(
    (purchaseEvents ?? []).map((r) => r.fan_profile_id).filter(Boolean) as string[]
  );

  const { count: recentClicks } = await sb
    .from("link_analytics")
    .select("*", { count: "exact", head: true })
    .gte("clicked_at", since30);

  const { count: emailSubmit30 } = await sb
    .from("fan_events")
    .select("*", { count: "exact", head: true })
    .eq("event_type", "email_submit")
    .gte("occurred_at", since30);

  const optIns = emailSubmit30 ?? 0;
  const purchases = purchaserIds.size;

  return [
    {
      id: "all-fans",
      name: "All fan profiles",
      description: "Resolved identities in fan_profiles",
      count: allFans ?? 0,
      lastUpdated: now,
      conversionRate: null,
      filters: [{ type: "segment", operator: "equals", value: "all" }],
    },
    {
      id: "smart-link-leads",
      name: "Smart link opt-ins",
      description: "Emails captured on smart link landings",
      count: leads ?? 0,
      lastUpdated: now,
      conversionRate: (leads ?? 0) > 0 ? pct(purchases, leads ?? 0) : null,
      filters: [{ type: "source", operator: "equals", value: "smart_link" }],
    },
    {
      id: "purchasers-30d",
      name: "Purchasers (30d)",
      description: "Fans with a purchase event in the last 30 days",
      count: purchases,
      lastUpdated: now,
      conversionRate: optIns > 0 ? pct(purchases, optIns) : null,
      filters: [{ type: "event", operator: "equals", value: "purchase" }],
    },
    {
      id: "link-clicks-30d",
      name: "Link clicks (30d)",
      description: "Clicks recorded in link_analytics",
      count: recentClicks ?? 0,
      lastUpdated: now,
      conversionRate:
        (recentClicks ?? 0) > 0 ? pct(leads ?? 0, recentClicks ?? 0) : null,
      filters: [{ type: "event", operator: "equals", value: "link_click" }],
    },
  ];
}
