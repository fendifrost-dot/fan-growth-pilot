/**
 * Canonical ingest contract (Edge). Mirrors lib/truthContract.ts.
 */

export const CANONICAL_EVENT_TYPES = ["page_view", "link_click", "email_submit", "purchase"] as const;

export function isAllowedEventType(eventType: string): boolean {
  const t = eventType.toLowerCase();
  return (CANONICAL_EVENT_TYPES as readonly string[]).includes(t);
}

export type TruthIdentityFieldsCanonical = {
  email?: string;
  phone?: string;
  telegram_id?: string;
  device_id?: string;
  meta_fbp?: string;
  meta_fbc?: string;
  external_id?: string;
  anonymous_id?: string;
};

export type CanonicalIngestInput = {
  event_type: string;
  event_time?: string;
  source: string;
  platform?: string | null;
  fan_profile_id?: string | null;
  identity_fields?: TruthIdentityFieldsCanonical;
  metadata: Record<string, unknown>;
  fbclid?: string;
};

const META_KEYS = [
  "smart_link_id",
  "smartLinkId",
  "slug",
  "campaign",
  "medium",
  "referrer",
  "referer",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "click_id",
  "clickId",
  "session_id",
  "anonymous_id",
  "anonymousId",
  "ip_address",
  "user_agent",
  "content_id",
  "smart_link_owner_id",
  "owner_user_id",
  "orderId",
  "value",
  "currency",
  "email",
  "platform",
] as const;

export function normalizeIngestPayload(raw: Record<string, unknown>): CanonicalIngestInput {
  const event_type = String(raw.event_type ?? raw.type ?? "").trim();
  const metaIn =
    raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
      ? { ...(raw.metadata as Record<string, unknown>) }
      : {};

  const metadata: Record<string, unknown> = { ...metaIn };

  for (const k of META_KEYS) {
    const v = raw[k];
    if (v !== undefined && v !== null && metadata[k] === undefined) {
      metadata[k] = v;
    }
  }

  const topSl = raw.smartLinkId ?? raw.smart_link_id;
  if (topSl != null && String(topSl).length > 0 && metadata.smartLinkId === undefined) {
    metadata.smartLinkId = topSl;
  }
  const topFp = raw.fan_profile_id ?? raw.fanProfileId;
  if (topFp != null && String(topFp).length > 0 && metadata.fan_profile_id === undefined) {
    metadata.fan_profile_id = topFp;
  }

  if (metadata.source === undefined && raw.source != null && String(raw.source).length > 0) {
    metadata.source = String(raw.source);
  }
  if (metadata.source === undefined && metadata.utm_source != null) {
    metadata.source = String(metadata.utm_source);
  }
  if (metadata.medium === undefined && metadata.utm_medium != null) {
    metadata.medium = String(metadata.utm_medium);
  }
  if (metadata.campaign === undefined && metadata.utm_campaign != null) {
    metadata.campaign = String(metadata.utm_campaign);
  }
  if (metadata.referrer === undefined && metadata.referer != null) {
    metadata.referrer = String(metadata.referer);
  }
  if (metadata.click_id === undefined && metadata.clickId != null) {
    metadata.click_id = metadata.clickId;
  }

  if (metadata.smartLinkId === undefined && metadata.smart_link_id !== undefined) {
    metadata.smartLinkId = metadata.smart_link_id;
  }
  if (metadata.smart_link_id === undefined && metadata.smartLinkId !== undefined) {
    metadata.smart_link_id = metadata.smartLinkId;
  }

  const ifRaw = raw.identity_fields;
  let identity_fields: TruthIdentityFieldsCanonical | undefined;
  if (ifRaw && typeof ifRaw === "object" && !Array.isArray(ifRaw)) {
    identity_fields = { ...(ifRaw as TruthIdentityFieldsCanonical) };
  }
  if (raw.email && !identity_fields?.email) {
    identity_fields = { ...identity_fields, email: String(raw.email) };
  }
  if (raw.phone && !identity_fields?.phone) {
    identity_fields = { ...identity_fields, phone: String(raw.phone) };
  }

  const resolvedSource = String(
    metadata.source != null && String(metadata.source).length > 0 ? metadata.source : raw.source ?? "unknown"
  );

  return {
    event_type,
    event_time: raw.event_time != null ? String(raw.event_time) : undefined,
    source: resolvedSource,
    platform: raw.platform != null ? String(raw.platform) : null,
    fan_profile_id: (raw.fan_profile_id ?? raw.fanProfileId ?? null) as string | null,
    identity_fields,
    metadata,
    fbclid: raw.fbclid != null ? String(raw.fbclid) : undefined,
  };
}
