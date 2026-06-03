import { createHash } from "node:crypto";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { createSupabaseServiceClient } from "./supabaseService.ts";
import {
  normalizeIngestPayload,
  isAllowedEventType,
  type CanonicalIngestInput,
  type TruthIdentityFieldsCanonical,
} from "./truthContract.ts";

export type { TruthIdentityFieldsCanonical as TruthIdentityFields } from "./truthContract.ts";

function env(name: string): string | undefined {
  return Deno.env.get(name) ?? undefined;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function mapInternalTypeToCapiEventName(eventType: string): string | null {
  const t = eventType.toLowerCase();
  if (t === "link_click") return "ViewContent";
  if (t === "email_submit") return "Lead";
  if (t === "purchase") return "Purchase";
  return null;
}

function normalizeMetaExternalId(profileId: string | null, emailPlain?: string): string[] {
  const out: string[] = [];
  if (profileId) out.push(sha256Hex(`fan_profile:${profileId}`));
  if (emailPlain) {
    const em = emailPlain.trim().toLowerCase();
    if (em) out.push(sha256Hex(em));
  }
  return out;
}

function coarseDeviceType(userAgent?: string): string | null {
  if (!userAgent) return null;
  const u = userAgent.toLowerCase();
  if (/mobile|android|iphone|ipod/.test(u)) return "mobile";
  if (/tablet|ipad/.test(u)) return "tablet";
  return "desktop";
}

async function logSystem(
  sb: SupabaseClient,
  step: string,
  payload: unknown,
  result?: unknown
) {
  console.log(`[truth-layer] ${step}`, JSON.stringify({ payload, result }));
  const row: Record<string, unknown> = {
    process_name: step,
    metadata: payload === undefined || payload === null ? {} : payload,
    message: result !== undefined ? JSON.stringify(result) : null,
  };
  const { error } = await sb.from("system_logs").insert(row);
  if (error) console.error("[truth-layer] system_logs insert failed", error.message);
}

async function resolveOwnerUserId(
  sb: SupabaseClient,
  metadata: Record<string, unknown>,
  smartLinkId?: string
): Promise<string | null> {
  let owner =
    (metadata.smart_link_owner_id as string) ||
    (metadata.owner_user_id as string) ||
    null;
  if (!owner && smartLinkId) {
    const { data } = await sb.from("smart_links").select("user_id").eq("id", smartLinkId).maybeSingle();
    owner = (data?.user_id as string) || null;
  }
  if (!owner) {
    const envId = (env("ARTIST_USER_ID") || "").trim();
    if (envId) owner = envId;
  }
  if (!owner) {
    const { data } = await sb.from("profiles").select("id").limit(1).maybeSingle();
    owner = (data?.id as string) || null;
  }
  return owner;
}

async function upsertFanProfile(
  sb: SupabaseClient,
  fields: TruthIdentityFieldsCanonical,
  ownerUserId: string | null
): Promise<string | null> {
  const hasAny = Object.values(fields).some((v) => v != null && String(v).length > 0);
  if (!hasAny) return null;
  if (!ownerUserId) {
    console.warn("[truth-layer] skip fan_profile: no owner user_id");
    return null;
  }

  const meta: Record<string, string> = {};
  if (fields.meta_fbp) meta.meta_fbp = fields.meta_fbp;
  if (fields.meta_fbc) meta.meta_fbc = fields.meta_fbc;
  if (fields.device_id) meta.device_id = fields.device_id;
  if (fields.telegram_id) meta.telegram_id = fields.telegram_id;
  if (fields.external_id) meta.external_id = fields.external_id;
  if (fields.anonymous_id) meta.anonymous_id = fields.anonymous_id;

  let existing: { id: string } | null = null;

  if (fields.email?.trim()) {
    const { data } = await sb
      .from("fan_profiles")
      .select("id")
      .eq("user_id", ownerUserId)
      .ilike("email", fields.email.trim())
      .maybeSingle();
    if (data?.id) existing = data;
  }
  if (!existing && fields.phone?.trim()) {
    const { data } = await sb
      .from("fan_profiles")
      .select("id")
      .eq("user_id", ownerUserId)
      .eq("phone", fields.phone.trim())
      .maybeSingle();
    if (data?.id) existing = data;
  }
  if (!existing && fields.device_id) {
    const { data } = await sb
      .from("fan_profiles")
      .select("id")
      .eq("user_id", ownerUserId)
      .contains("metadata", { device_id: fields.device_id })
      .maybeSingle();
    if (data?.id) existing = data;
  }

  const row: Record<string, unknown> = {
    user_id: ownerUserId,
    email: fields.email?.trim() || null,
    phone: fields.phone?.trim() || null,
    metadata: Object.keys(meta).length ? meta : {},
  };

  if (existing) {
    const { data: cur } = await sb.from("fan_profiles").select("metadata").eq("id", existing.id).single();
    const merged = { ...((cur?.metadata as Record<string, string>) || {}), ...meta };
    const { data: updated, error } = await sb
      .from("fan_profiles")
      .update({
        email: (row.email as string) || undefined,
        phone: (row.phone as string) || undefined,
        metadata: merged,
      })
      .eq("id", existing.id)
      .select("id")
      .single();
    if (error) throw new Error(`fan_profiles update: ${error.message}`);
    return updated?.id ?? existing.id;
  }

  const { data: created, error } = await sb.from("fan_profiles").insert(row).select("id").single();
  if (error) throw new Error(`fan_profiles insert: ${error.message}`);
  return created?.id ?? null;
}

async function forwardToMetaCapi(params: {
  eventId: string;
  eventType: string;
  fanProfileId: string | null;
  identityFields?: TruthIdentityFieldsCanonical;
  topLevelEmail?: string;
  eventSourceUrl?: string;
  customData?: Record<string, unknown>;
}): Promise<{ ok: boolean; status?: number; body?: unknown; skipped?: string }> {
  const capiName = mapInternalTypeToCapiEventName(params.eventType);
  if (!capiName) {
    return { ok: true, skipped: "no_capi_mapping_for_event_type" };
  }

  const base = env("SUPABASE_URL");
  const anon = env("SUPABASE_ANON_KEY");
  if (!base || !anon) {
    return { ok: false, skipped: "missing_SUPABASE_URL_or_SUPABASE_ANON_KEY" };
  }

  const emailPlain = params.identityFields?.email ?? params.topLevelEmail;
  const user_data: Record<string, unknown> = {
    external_id: normalizeMetaExternalId(params.fanProfileId, emailPlain),
    client_ip_address: params.customData?.ip_address as string | undefined,
    client_user_agent: params.customData?.user_agent as string | undefined,
  };
  if (emailPlain) {
    const em = emailPlain.trim().toLowerCase();
    if (em) user_data.em = [sha256Hex(em)];
  }
  if (params.identityFields?.meta_fbp) user_data.fbp = params.identityFields.meta_fbp;
  if (params.identityFields?.meta_fbc) user_data.fbc = params.identityFields.meta_fbc;

  const payload = {
    capi_event_name: capiName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: params.eventId,
    action_source: "website",
    event_source_url: params.eventSourceUrl || env("APP_BASE_URL") || "",
    user_data,
    custom_data: params.customData ?? {},
  };

  const url = `${base.replace(/\/$/, "")}/functions/v1/meta-conversions`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: anon },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { ok: false, body: { error: String(e) } };
  }

  let parsed: unknown;
  const text = await res.text();
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  return { ok: res.ok, status: res.status, body: parsed };
}

export type IngestTruthResult = {
  eventId: string;
  identityId: string | null;
  capi?: { ok: boolean; status?: number; body?: unknown; skipped?: string };
  leadId?: string | null;
};

export async function ingestTruthEvent(
  body: Record<string, unknown>,
  options?: { awaitCapi?: boolean; supabase?: SupabaseClient }
): Promise<IngestTruthResult> {
  const canon = normalizeIngestPayload(body);
  const sb = options?.supabase ?? createSupabaseServiceClient();

  await logSystem(sb, "ingest:input", canon, undefined);

  const { event_type: eventType, source, platform, metadata, identity_fields, fan_profile_id, fbclid } =
    canon;
  if (!eventType) {
    throw new Error("event_type or type is required");
  }

  if (!isAllowedEventType(eventType)) {
    await logSystem(sb, "ingest:invalid_event_type", { eventType }, { ok: false });
    throw new Error(
      `Unsupported event_type: ${eventType}. Allowed: page_view, link_click, email_submit, purchase.`
    );
  }

  if (fbclid && metadata.fbclid === undefined) metadata.fbclid = fbclid;
  if (platform && metadata.platform === undefined) metadata.platform = platform;

  const anonymousId =
    (metadata.anonymous_id as string) || (metadata.anonymousId as string) || undefined;

  const payloadObj: Record<string, unknown> = {
    ...metadata,
    event_type: eventType,
    source,
    anonymous_id: anonymousId,
  };

  const smartLinkId = (metadata.smartLinkId ?? metadata.smart_link_id) as string | undefined;
  const ownerUserId = await resolveOwnerUserId(sb, metadata, smartLinkId);

  let fanProfileId: string | null = fan_profile_id || null;

  const fields: TruthIdentityFieldsCanonical = { ...identity_fields };
  if (anonymousId && !fields.anonymous_id) fields.anonymous_id = anonymousId;

  if (Object.values(fields).some((v) => v != null && String(v).length > 0)) {
    const id = await upsertFanProfile(sb, fields, ownerUserId);
    if (id) fanProfileId = id;
    await logSystem(sb, "ingest:fan_profile", { fanProfileId, ownerUserId }, { ok: true });
  }
  const isLinkClick = eventType.toLowerCase() === "link_click";
  const occurredAt = canon.event_time
    ? new Date(canon.event_time).toISOString()
    : new Date().toISOString();

  let eventId: string;
  let leadId: string | null = null;

  if (isLinkClick && smartLinkId) {
    const la: Record<string, unknown> = {
      link_id: smartLinkId,
      user_id: ownerUserId,
      referrer: (metadata.referer as string) || (metadata.referrer as string) || null,
      user_agent: (metadata.user_agent as string) || null,
      ip_address: (metadata.ip_address as string) || null,
      device_type: coarseDeviceType(metadata.user_agent as string | undefined),
      country: null,
      city: null,
      converted: false,
      metadata: {
        ...payloadObj,
        platform: platform ?? metadata.platform,
        click_id: metadata.click_id ?? metadata.clickId,
      },
      clicked_at: occurredAt,
    };
    const { data: laRow, error: laErr } = await sb
      .from("link_analytics")
      .insert(la)
      .select("id")
      .single();

    if (laErr) {
      await logSystem(sb, "ingest:link_analytics_error", la, { error: laErr.message });
      throw new Error(`link_analytics insert: ${laErr.message}`);
    }
    eventId = laRow!.id as string;
    await logSystem(sb, "ingest:link_analytics", { eventId, link_id: smartLinkId }, { ok: true });
  } else {
    const eventSourceCol = String(
      metadata.source != null && String(metadata.source).length > 0 ? metadata.source : source
    );

    const eventRow: Record<string, unknown> = {
      user_id: ownerUserId,
      fan_profile_id: fanProfileId,
      event_type: eventType,
      event_source: eventSourceCol,
      song_slug:
        (metadata.content_id as string) ||
        (metadata.slug as string) ||
        (eventType.toLowerCase() === "page_view" ? "page_view" : "event"),
      metadata: {
        ...payloadObj,
        platform: platform ?? metadata.platform,
        click_id: metadata.click_id ?? metadata.clickId,
      },
      occurred_at: occurredAt,
    };

    const { data: insertedEvent, error: evErr } = await sb
      .from("fan_events")
      .insert(eventRow)
      .select("id")
      .single();

    if (evErr) {
      await logSystem(sb, "ingest:fan_events_error", eventRow, { error: evErr.message });
      throw new Error(`fan_events insert: ${evErr.message}`);
    }

    eventId = insertedEvent!.id as string;
    await logSystem(sb, "ingest:fan_events", { eventId, type: eventType }, { ok: true });

    const et = eventType.toLowerCase();
    if (et === "purchase") {
      const cid = (metadata.click_id ?? metadata.clickId) as string | undefined;
      const valRaw = metadata.value;
      const val = valRaw != null ? Number(valRaw) : null;
      if (cid) {
        const { data: laMatches, error: laFindErr } = await sb
          .from("link_analytics")
          .select("id")
          .filter("metadata->>click_id", "eq", String(cid))
          .limit(5);
        if (!laFindErr && laMatches?.length) {
          for (const row of laMatches) {
            await sb
              .from("link_analytics")
              .update({
                converted: true,
                conversion_value: Number.isFinite(val as number) ? val : null,
              })
              .eq("id", row.id as string);
          }
          await logSystem(sb, "ingest:link_analytics_convert", { click_id: cid, rows: laMatches.length }, {
            ok: true,
          });
        }
      }
    }

    const emailSubmit = et === "email_submit";
    const email =
      fields.email?.trim() || (metadata.email as string)?.trim() || (body.email as string)?.trim();
    if (emailSubmit && smartLinkId && email) {
      const leadRow: Record<string, unknown> = {
        email,
        smart_link_id: smartLinkId,
        user_id: ownerUserId,
        converted: false,
        metadata: {
          fan_profile_id: fanProfileId,
          ...payloadObj,
        },
      };
      const { data: lead, error: leadErr } = await sb
        .from("smart_link_leads")
        .insert(leadRow)
        .select("id")
        .single();
      if (leadErr) {
        await logSystem(sb, "ingest:smart_link_leads_error", leadRow, { error: leadErr.message });
        console.error("[truth-layer] smart_link_leads", leadErr.message);
      } else {
        leadId = (lead?.id as string) ?? null;
        await logSystem(sb, "ingest:smart_link_leads", { leadId }, { ok: true });
      }
    }
  }

  const emailForCapi = fields.email || (metadata.email as string) || (body.email as string);

  const appBase = env("APP_BASE_URL") ?? "";

  const runCapi = async () => {
    const capiName = mapInternalTypeToCapiEventName(eventType);
    if (!capiName) {
      return { ok: true, skipped: "no_capi_mapping_for_event_type" } as const;
    }

    const emailPlain = fields.email || emailForCapi;
    const user_data: Record<string, unknown> = {
      external_id: normalizeMetaExternalId(fanProfileId, emailPlain),
      client_ip_address: metadata.ip_address as string | undefined,
      client_user_agent: metadata.user_agent as string | undefined,
    };
    if (emailPlain) {
      const em = String(emailPlain).trim().toLowerCase();
      if (em) user_data.em = [sha256Hex(em)];
    }
    if (fields.meta_fbp) user_data.fbp = fields.meta_fbp;
    if (fields.meta_fbc) user_data.fbc = fields.meta_fbc;

    const capiPayload = {
      capi_event_name: capiName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      action_source: "website",
      event_source_url: appBase,
      user_data,
      custom_data: metadata,
    };
    await logSystem(sb, "capi:request", capiPayload, undefined);

    const out = await forwardToMetaCapi({
      eventId,
      eventType,
      fanProfileId,
      identityFields: fields,
      topLevelEmail: emailForCapi,
      eventSourceUrl: appBase,
      customData: metadata,
    });
    await logSystem(sb, "capi:response", { eventId, httpStatus: out.status }, out.body ?? out);
    return out;
  };

  if (options?.awaitCapi) {
    const capi = await runCapi();
    return { eventId, identityId: fanProfileId, capi, leadId };
  }

  runCapi()
    .then((capi) => console.log("[truth-layer] capi async", JSON.stringify({ eventId, capi })))
    .catch((e) => console.error("[truth-layer] capi async error", e));

  return { eventId, identityId: fanProfileId, leadId };
}

export async function ingestTruthEventCanonical(
  canon: CanonicalIngestInput,
  options?: { awaitCapi?: boolean; supabase?: SupabaseClient }
): Promise<IngestTruthResult> {
  return ingestTruthEvent(
    {
      event_type: canon.event_type,
      event_time: canon.event_time,
      source: canon.source,
      platform: canon.platform ?? undefined,
      fan_profile_id: canon.fan_profile_id ?? undefined,
      identity_fields: canon.identity_fields,
      metadata: canon.metadata,
      fbclid: canon.fbclid,
    },
    options
  );
}
