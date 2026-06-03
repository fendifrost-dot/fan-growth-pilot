#!/usr/bin/env node
/**
 * Truth funnel verify — Lovable Cloud only.
 *
 * Path A (preferred when service role is hidden in Lovable UI):
 *   TRUTH_VERIFY_SECRET + VITE_SUPABASE_URL + VITE_SUPABASE_PUBLISHABLE_KEY
 *   Calls deployed Edge function truth-verify (mode=full).
 *   Lovable injects SUPABASE_SERVICE_ROLE_KEY into Edge at runtime — you never copy it.
 *
 * Path B (optional):
 *   SUPABASE_SERVICE_ROLE_KEY in .env — direct DB writes from this script.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvFile(resolve(root, ".env"));

const url = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "").replace(/\/$/, "");
const anon = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const verifySecret = process.env.TRUTH_VERIFY_SECRET;

async function verifyViaEdge() {
  if (!verifySecret) {
    console.error(
      "Edge verify needs TRUTH_VERIFY_SECRET in .env (you create this in Lovable Cloud → Secrets)."
    );
    process.exit(1);
  }
  if (!url || !anon) {
    console.error("Need VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env");
    process.exit(1);
  }

  const payload = { mode: "full" };
  if (process.env.TRUTH_TEST_SMART_LINK_ID) {
    payload.smartLinkId = process.env.TRUTH_TEST_SMART_LINK_ID;
  }
  if (process.env.REQUIRE_CAPI === "1") payload.requireCapi = true;

  const endpoint = `${url}/functions/v1/truth-verify`;
  console.error(`POST ${endpoint} (mode=full, via Lovable Edge — service role not needed locally)`);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: anon,
      authorization: `Bearer ${anon}`,
      "x-truth-verify-secret": verifySecret,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  console.log(JSON.stringify(body, null, 2));

  if (res.status === 404) {
    console.error(
      "\ntruth-verify not deployed yet. In Lovable: Publish the truth-verify function from this repo (supabase/functions/truth-verify)."
    );
    process.exit(1);
  }
  if (!res.ok) process.exit(1);
  process.exit(body.ok ? 0 : 1);
}

async function verifyViaServiceRole() {
  const sb = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  async function upsertFanProfile(fields) {
    const email = fields.email?.trim();
    if (!email) return null;
    const { data: existing } = await sb.from("fan_profiles").select("id").ilike("email", email).maybeSingle();
    if (existing?.id) {
      await sb.from("fan_profiles").update({ email }).eq("id", existing.id);
      return existing.id;
    }
    const { data: created, error } = await sb
      .from("fan_profiles")
      .insert({ email, phone: null, metadata: {} })
      .select("id")
      .single();
    if (error) throw new Error(`fan_profiles: ${error.message}`);
    return created?.id ?? null;
  }

  async function resolveSmartLink(id) {
    if (id) {
      const { data } = await sb.from("smart_links").select("id, slug, user_id").eq("id", id).maybeSingle();
      if (data?.id) return data;
    }
    const { data } = await sb
      .from("smart_links")
      .select("id, slug, user_id")
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return data?.id ? data : null;
  }

  const ts = Date.now();
  const testEmail = `funnel-verify+${ts}@example.invalid`;
  const clickId = `funnel-click-${ts}`;
  const sessionId = `funnel-sess-${ts}`;
  const steps = [];

  const link = await resolveSmartLink(process.env.TRUTH_TEST_SMART_LINK_ID);
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
    click_id: null,
    orderId: null,
    value: null,
    currency: null,
    smart_link_owner_id: ownerId,
    slug,
  };

  try {
    const { data: row, error } = await sb
      .from("fan_events")
      .insert({
        user_id: ownerId,
        fan_profile_id: null,
        event_type: "page_view",
        event_source: "funnel_verify",
        song_slug: slug,
        metadata: { ...baseMeta, smartLinkId },
        occurred_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error) throw error;
    steps.push({ step: "page_view", ok: true, event_id: row.id });
  } catch (e) {
    steps.push({ step: "page_view", ok: false, error: String(e.message || e) });
  }

  try {
    const profileId = await upsertFanProfile({ email: testEmail });
    const { data: row, error } = await sb
      .from("fan_events")
      .insert({
        user_id: ownerId,
        fan_profile_id: profileId,
        event_type: "email_submit",
        event_source: "funnel_verify",
        song_slug: slug,
        metadata: { ...baseMeta, email: testEmail, smartLinkId },
        occurred_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error) throw error;
    steps.push({ step: "email_submit", ok: Boolean(row?.id && profileId), event_id: row?.id, identity_id: profileId });
  } catch (e) {
    steps.push({ step: "email_submit", ok: false, error: String(e.message || e) });
  }

  let linkAnalyticsId;
  try {
    if (!smartLinkId) throw new Error("no active smart_links row");
    const { data: row, error } = await sb
      .from("link_analytics")
      .insert({
        link_id: smartLinkId,
        user_id: ownerId,
        converted: false,
        metadata: { ...baseMeta, click_id: clickId, platform: "spotify" },
        clicked_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error) throw error;
    linkAnalyticsId = row.id;
    steps.push({ step: "link_click", ok: true, link_analytics_id: row.id });
  } catch (e) {
    steps.push({ step: "link_click", ok: false, error: String(e.message || e) });
  }

  try {
    await sb.from("fan_events").insert({
      user_id: ownerId,
      event_type: "purchase",
      event_source: "funnel_verify",
      song_slug: "purchase",
      metadata: { ...baseMeta, click_id: clickId, orderId: `funnel-ord-${ts}`, value: 1, currency: "USD", smartLinkId },
      occurred_at: new Date().toISOString(),
    });
    if (linkAnalyticsId) {
      await sb.from("link_analytics").update({ converted: true, conversion_value: 1 }).eq("id", linkAnalyticsId);
      const { data: la } = await sb.from("link_analytics").select("converted").eq("id", linkAnalyticsId).single();
      steps.push({ step: "purchase", ok: la?.converted === true });
    } else {
      steps.push({ step: "purchase", ok: true });
    }
  } catch (e) {
    steps.push({ step: "purchase", ok: false, error: String(e.message || e) });
  }

  const ok = steps.every((s) => s.ok);
  console.log(JSON.stringify({ ok, mode: "direct", steps }, null, 2));
  process.exit(ok ? 0 : 1);
}

if (!url) {
  console.error("Missing VITE_SUPABASE_URL in .env");
  process.exit(1);
}

// Prefer Edge when service role is not available locally (Lovable hides it).
if (serviceKey && process.env.VERIFY_VIA_EDGE !== "1") {
  console.error("Using direct DB path (SUPABASE_SERVICE_ROLE_KEY in .env)");
  await verifyViaServiceRole();
} else {
  await verifyViaEdge();
}
