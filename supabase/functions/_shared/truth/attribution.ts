import { createSupabaseServiceClient } from "./supabaseService.ts";
import { ingestTruthEvent } from "./truthIngest.ts";

interface AttributionResult {
  clickId?: string;
  smartLinkId?: string;
  userId?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
}

export async function findClickAttribution(clickId: string): Promise<AttributionResult> {
  const sb = createSupabaseServiceClient();
  const out: AttributionResult = { clickId };

  const { data: la } = await sb
    .from("link_analytics")
    .select("link_id, user_id, metadata")
    .filter("metadata->>click_id", "eq", clickId)
    .order("clicked_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (la) {
    const meta = (la.metadata as Record<string, unknown>) || {};
    out.userId = (la.user_id as string) || undefined;
    out.smartLinkId = (la.link_id as string) || undefined;
    out.utmSource =
      (meta.source as string) || (meta.utm_source as string) || (meta.utmSource as string);
    out.utmMedium =
      (meta.medium as string) || (meta.utm_medium as string) || (meta.utmMedium as string);
    out.utmCampaign =
      (meta.campaign as string) || (meta.utm_campaign as string) || (meta.utmCampaign as string);
    return out;
  }

  const { data: fe } = await sb
    .from("fan_events")
    .select("user_id, metadata")
    .filter("metadata->>click_id", "eq", clickId)
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (fe) {
    const meta = (fe.metadata as Record<string, unknown>) || {};
    out.userId = (fe.user_id as string) || undefined;
    out.smartLinkId = (meta.smartLinkId as string) || undefined;
    out.utmSource =
      (meta.source as string) || (meta.utm_source as string) || (meta.utmSource as string);
    out.utmMedium =
      (meta.medium as string) || (meta.utm_medium as string) || (meta.utmMedium as string);
    out.utmCampaign =
      (meta.campaign as string) || (meta.utm_campaign as string) || (meta.utmCampaign as string);
  }

  return out;
}

export async function attributePurchase(
  orderId: string,
  value: number,
  currency: string,
  source: string,
  identifiers: {
    clickId?: string;
    smartLinkId?: string;
    fbclid?: string;
    email?: string;
    phone?: string;
  }
): Promise<void> {
  let attribution: AttributionResult = {};
  if (identifiers.clickId) {
    attribution = await findClickAttribution(identifiers.clickId);
  }
  const smartLinkId = identifiers.smartLinkId || attribution.smartLinkId;

  const clickId = identifiers.clickId ?? attribution.clickId ?? null;

  await ingestTruthEvent(
    {
      event_type: "purchase",
      event_time: new Date().toISOString(),
      smartLinkId: smartLinkId ?? null,
      fan_profile_id: null,
      source,
      metadata: {
        campaign: attribution.utmCampaign ?? null,
        source: attribution.utmSource ?? source ?? null,
        medium: attribution.utmMedium ?? null,
        referrer: null,
        session_id: null,
        anonymous_id: null,
        click_id: clickId,
        orderId,
        value,
        currency,
        smart_link_owner_id: attribution.userId ?? null,
        smartLinkId,
      },
      identity_fields: {
        email: identifiers.email,
        phone: identifiers.phone,
      },
      fbclid: identifiers.fbclid,
    },
    { awaitCapi: true }
  );
}
