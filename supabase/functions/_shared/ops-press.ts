/**
 * Ops incidents, press kits, private license evidence — CoS / PR operating surfaces.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import type { Actor } from "./outreach-auth.ts";

export const OPS_PRESS_ACTIONS = [
  "list_ops_incidents",
  "log_ops_incident",
  "ack_ops_incident",
  "resolve_ops_incident",
  "list_press_kits",
  "upsert_press_kit",
  "list_private_licenses",
  "register_private_license",
] as const;

export function isOpsPressAction(action: string): boolean {
  return (OPS_PRESS_ACTIONS as readonly string[]).includes(action);
}

type Result = { status: number; data: Record<string, unknown> };

function requireAdmin(actor: Actor | null): Result | null {
  if (!actor || actor.kind !== "user" || !actor.isAdmin) {
    return { status: 401, data: { error: "Admin JWT required" } };
  }
  return null;
}

export async function runOpsPressAction(
  action: string,
  body: Record<string, unknown>,
  sb: SupabaseClient,
  actor: Actor | null = null,
): Promise<Result> {
  switch (action) {
    case "list_ops_incidents": {
      const status = String(body.status ?? "open").trim();
      let q = sb.from("ops_incidents").select("*").order("created_at", { ascending: false }).limit(100);
      if (status && status !== "all") q = q.eq("status", status);
      const { data, error } = await q;
      if (error) {
        return { status: 503, data: { error: `ops_incidents unavailable (${error.message})` } };
      }
      return { status: 200, data: { ok: true, rows: data ?? [] } };
    }
    case "log_ops_incident": {
      const authErr = requireAdmin(actor);
      if (authErr) return authErr;
      const title = String(body.title ?? "").trim();
      if (!title) return { status: 400, data: { error: "title required" } };
      const { data, error } = await sb
        .from("ops_incidents")
        .insert({
          title,
          severity: String(body.severity ?? "info"),
          category: String(body.category ?? "general"),
          detail: body.detail ?? {},
          track_id: body.track_id ? String(body.track_id) : null,
          campaign_id: body.campaign_id ? String(body.campaign_id) : null,
          related_entity: body.related_entity ? String(body.related_entity) : null,
          related_id: body.related_id ? String(body.related_id) : null,
          created_by: actor!.kind === "user" ? actor!.userId : null,
        })
        .select("*")
        .single();
      if (error) throw error;
      return { status: 200, data: { ok: true, incident: data } };
    }
    case "ack_ops_incident":
    case "resolve_ops_incident": {
      const authErr = requireAdmin(actor);
      if (authErr) return authErr;
      const id = String(body.incident_id ?? "").trim();
      if (!id) return { status: 400, data: { error: "incident_id required" } };
      const next = action === "ack_ops_incident" ? "acknowledged" : "resolved";
      const patch: Record<string, unknown> = {
        status: next,
        updated_at: new Date().toISOString(),
      };
      if (next === "acknowledged") patch.acknowledged_by = actor!.kind === "user" ? actor!.userId : null;
      if (next === "resolved") patch.resolved_by = actor!.kind === "user" ? actor!.userId : null;
      const { data, error } = await sb.from("ops_incidents").update(patch).eq("id", id).select("*").single();
      if (error) throw error;
      return { status: 200, data: { ok: true, incident: data } };
    }
    case "list_press_kits": {
      const { data, error } = await sb
        .from("press_kits")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(50);
      if (error) return { status: 503, data: { error: error.message } };
      return { status: 200, data: { ok: true, rows: data ?? [] } };
    }
    case "upsert_press_kit": {
      const authErr = requireAdmin(actor);
      if (authErr) return authErr;
      const slug = String(body.slug ?? "").trim().toLowerCase();
      const title = String(body.title ?? "").trim();
      if (!slug || !title) return { status: 400, data: { error: "slug and title required" } };
      const userId = actor!.kind === "user" ? actor!.userId : null;
      const row = {
        slug,
        title,
        status: String(body.status ?? "draft"),
        one_liner: body.one_liner == null ? null : String(body.one_liner),
        bio_short: body.bio_short == null ? null : String(body.bio_short),
        bio_long: body.bio_long == null ? null : String(body.bio_long),
        press_email: body.press_email == null ? null : String(body.press_email),
        assets: body.assets ?? [],
        links: body.links ?? {},
        notes: body.notes == null ? null : String(body.notes),
        updated_by: userId,
        updated_at: new Date().toISOString(),
        published_at: String(body.status ?? "") === "published" ? new Date().toISOString() : null,
      };
      const id = String(body.press_kit_id ?? "").trim();
      if (id) {
        const { data, error } = await sb.from("press_kits").update(row).eq("id", id).select("*").single();
        if (error) throw error;
        return { status: 200, data: { ok: true, press_kit: data } };
      }
      const { data, error } = await sb
        .from("press_kits")
        .insert({ ...row, created_by: userId })
        .select("*")
        .single();
      if (error) throw error;
      return { status: 200, data: { ok: true, press_kit: data } };
    }
    case "list_private_licenses": {
      const trackId = String(body.track_id ?? "").trim();
      let q = sb.from("private_license_evidence").select("*").order("created_at", { ascending: false }).limit(100);
      if (trackId) q = q.eq("track_id", trackId);
      const { data, error } = await q;
      if (error) return { status: 503, data: { error: error.message } };
      return { status: 200, data: { ok: true, rows: data ?? [] } };
    }
    case "register_private_license": {
      const authErr = requireAdmin(actor);
      if (authErr) return authErr;
      const trackId = String(body.track_id ?? "").trim();
      const label = String(body.label ?? "").trim();
      if (!trackId || !label) return { status: 400, data: { error: "track_id and label required" } };
      const { data, error } = await sb
        .from("private_license_evidence")
        .insert({
          track_id: trackId,
          label,
          storage_path: body.storage_path == null ? null : String(body.storage_path),
          notes: body.notes == null ? null : String(body.notes),
          uploaded_by: actor!.kind === "user" ? actor!.userId : null,
        })
        .select("*")
        .single();
      if (error) throw error;
      try {
        const { recomputeTrackSyncEligible } = await import("./sync-eligibility.ts");
        const sync = await recomputeTrackSyncEligible(sb, trackId);
        return { status: 200, data: { ok: true, evidence: data, sync } };
      } catch (e) {
        console.error("sync recompute after private license register failed:", e);
        return {
          status: 200,
          data: {
            ok: true,
            evidence: data,
            sync_recompute_error: e instanceof Error ? e.message : String(e),
          },
        };
      }
    }
    default:
      return { status: 400, data: { error: `Unknown ops/press action: ${action}` } };
  }
}
