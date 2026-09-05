/**
 * Playlist operations ledger — one row per track × target (or campaign).
 * Attribution is always derived from OpsActor (never request body).
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  assertCan,
  attributionFrom,
  stripSpoofedAttribution,
  type OpsActor,
} from "./ops-actors.ts";

export const PLAYLIST_OPS_ACTIONS = [
  "upsert_playlist_ops_ledger",
  "get_playlist_ops_ledger",
  "list_playlist_ops_ledger",
  "record_playlist_discovery",
  "record_playlist_verification",
  "record_playlist_draft",
  "record_playlist_approval",
  "record_playlist_draft_decision",
  "record_playlist_send",
  "record_inbox_check",
  "record_reply_classification",
  "record_curator_reply",
  "record_response_draft",
  "record_sent_response",
  "record_placement_check",
  "record_placement_evidence",
  "open_playlist_ops_incident",
  "get_ops_metrics",
  "get_playlist_ops_metrics",
] as const;

export type PlaylistOpsAction = (typeof PLAYLIST_OPS_ACTIONS)[number];

export function isPlaylistOpsAction(action: string): action is PlaylistOpsAction {
  return (PLAYLIST_OPS_ACTIONS as readonly string[]).includes(action);
}

type Json = Record<string, unknown>;
type Result = { status: number; data: Json };

function requireUuid(v: unknown, label: string): string {
  const s = String(v ?? "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)) {
    throw new Error(`${label} must be a uuid`);
  }
  return s;
}

function startOfUtcDayIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function statusOf(err: unknown): number {
  if (err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  return 400;
}

export async function runPlaylistOpsAction(
  action: string,
  bodyIn: Json,
  supabase: SupabaseClient,
  actor: OpsActor,
): Promise<Result> {
  const body = stripSpoofedAttribution(bodyIn);
  const a = attributionFrom(actor);

  try {
    switch (action as PlaylistOpsAction) {
      case "upsert_playlist_ops_ledger": {
        assertCan(actor, "write_playlist_ops");
        const trackId = requireUuid(body.track_id, "track_id");
        const playlistTargetId = body.playlist_target_id
          ? requireUuid(body.playlist_target_id, "playlist_target_id")
          : null;
        const campaignId = body.campaign_id ? requireUuid(body.campaign_id, "campaign_id") : null;

        const row: Json = {
          track_id: trackId,
          playlist_target_id: playlistTargetId,
          campaign_id: campaignId,
          approved_song_dna_version_id: body.approved_song_dna_version_id ?? null,
          discovery_source: body.discovery_source ?? null,
          discovery_date: body.discovery_date ?? null,
          draft_id: body.draft_id ?? null,
          email_message_id: body.email_message_id ?? null,
          email_thread_id: body.email_thread_id ?? null,
          response_status: body.response_status ?? null,
          placement_status: body.placement_status ?? null,
          rejection_or_shortfall_reason: body.rejection_or_shortfall_reason ?? null,
          updated_at: new Date().toISOString(),
        };

        if (body.id) {
          const { data, error } = await supabase
            .from("playlist_ops_ledger")
            .update(row)
            .eq("id", requireUuid(body.id, "id"))
            .select("*")
            .single();
          if (error) throw new Error(error.message);
          return { status: 200, data: { ok: true, ledger: data } };
        }

        const { data, error } = await supabase
          .from("playlist_ops_ledger")
          .insert({
            ...row,
            discovered_by: a.actor_key,
            discovered_by_label: a.actor_label,
          })
          .select("*")
          .single();
        if (error) throw new Error(error.message);
        return { status: 200, data: { ok: true, ledger: data } };
      }

      case "get_playlist_ops_ledger": {
        assertCan(actor, "read_playlist_ops");
        const id = requireUuid(body.id ?? body.ledger_id, "id");
        const { data, error } = await supabase.from("playlist_ops_ledger").select("*").eq("id", id).maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) return { status: 404, data: { error: "Ledger row not found" } };
        return { status: 200, data: { ok: true, ledger: data } };
      }

      case "list_playlist_ops_ledger": {
        assertCan(actor, "read_playlist_ops");
        let q = supabase.from("playlist_ops_ledger").select("*").order("updated_at", { ascending: false }).limit(200);
        if (body.track_id) q = q.eq("track_id", requireUuid(body.track_id, "track_id"));
        if (body.campaign_id) q = q.eq("campaign_id", requireUuid(body.campaign_id, "campaign_id"));
        if (body.playlist_target_id) {
          q = q.eq("playlist_target_id", requireUuid(body.playlist_target_id, "playlist_target_id"));
        }
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        return { status: 200, data: { ok: true, items: data ?? [] } };
      }

      case "record_playlist_discovery": {
        assertCan(actor, "research_playlist_targets");
        const trackId = requireUuid(body.track_id, "track_id");
        const now = new Date().toISOString();
        const { data, error } = await supabase
          .from("playlist_ops_ledger")
          .insert({
            track_id: trackId,
            playlist_target_id: body.playlist_target_id
              ? requireUuid(body.playlist_target_id, "playlist_target_id")
              : null,
            campaign_id: body.campaign_id ? requireUuid(body.campaign_id, "campaign_id") : null,
            discovery_source: body.discovery_source ?? null,
            discovery_date: body.discovery_date ?? now.slice(0, 10),
            discovered_by: a.actor_key,
            discovered_by_label: a.actor_label,
            discovered_at: now,
          })
          .select("*")
          .single();
        if (error) throw new Error(error.message);
        return { status: 200, data: { ok: true, ledger: data } };
      }

      case "record_playlist_verification": {
        assertCan(actor, "verify_playlist_targets");
        const id = requireUuid(body.id ?? body.ledger_id, "id");
        const result = String(body.verification_result ?? "").trim();
        if (!result) throw new Error("verification_result is required");
        const now = new Date().toISOString();
        const { data, error } = await supabase
          .from("playlist_ops_ledger")
          .update({
            verification_result: result,
            verified_by: a.actor_key,
            verified_by_label: a.actor_label,
            verified_at: now,
            rejection_or_shortfall_reason:
              result === "rejected" ? (body.rejection_or_shortfall_reason ?? null) : null,
            updated_at: now,
          })
          .eq("id", id)
          .select("*")
          .single();
        if (error) throw new Error(error.message);
        return { status: 200, data: { ok: true, ledger: data } };
      }

      case "record_playlist_draft": {
        assertCan(actor, "generate_playlist_drafts");
        const id = requireUuid(body.id ?? body.ledger_id, "id");
        const draftId = String(body.draft_id ?? "").trim();
        if (!draftId) throw new Error("draft_id is required");
        const now = new Date().toISOString();
        const { data, error } = await supabase
          .from("playlist_ops_ledger")
          .update({
            draft_id: draftId,
            drafted_by: a.actor_key,
            drafted_by_label: a.actor_label,
            drafted_at: now,
            approved_song_dna_version_id: body.approved_song_dna_version_id ?? null,
            updated_at: now,
          })
          .eq("id", id)
          .select("*")
          .single();
        if (error) throw new Error(error.message);
        return { status: 200, data: { ok: true, ledger: data } };
      }

      case "record_playlist_draft_decision":
      case "record_playlist_approval": {
        const id = requireUuid(body.id ?? body.ledger_id, "id");
        const result = String(body.approval_result ?? body.decision ?? "").trim();
        if (!["approved", "rejected"].includes(result)) {
          throw new Error("approval_result must be approved or rejected");
        }
        assertCan(
          actor,
          result === "rejected" ? "reject_playlist_drafts" : "approve_playlist_drafts",
        );
        const now = new Date().toISOString();
        const { data, error } = await supabase
          .from("playlist_ops_ledger")
          .update({
            approval_result: result,
            approved_by: a.actor_key,
            approved_by_label: a.actor_label,
            approved_at: now,
            rejection_or_shortfall_reason:
              result === "rejected" ? (body.rejection_or_shortfall_reason ?? null) : null,
            updated_at: now,
          })
          .eq("id", id)
          .select("*")
          .single();
        if (error) throw new Error(error.message);
        return { status: 200, data: { ok: true, ledger: data } };
      }

      case "record_playlist_send": {
        assertCan(actor, "send_playlist_pitches");
        const id = requireUuid(body.id ?? body.ledger_id, "id");
        const sendResult = String(body.send_result ?? "sent").trim();
        const now = new Date().toISOString();
        const { data, error } = await supabase
          .from("playlist_ops_ledger")
          .update({
            send_result: sendResult,
            sent_by: a.actor_key,
            sent_by_label: a.actor_label,
            sent_at: now,
            email_message_id: body.email_message_id ?? null,
            email_thread_id: body.email_thread_id ?? null,
            updated_at: now,
          })
          .eq("id", id)
          .select("*")
          .single();
        if (error) throw new Error(error.message);
        return { status: 200, data: { ok: true, ledger: data } };
      }

      case "record_inbox_check": {
        assertCan(actor, "monitor_inbox");
        const id = requireUuid(body.id ?? body.ledger_id, "id");
        const now = new Date().toISOString();
        const next = body.next_response_check_at
          ? String(body.next_response_check_at)
          : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        const patch: Json = {
          last_inbox_check_at: now,
          next_response_check_at: next,
          response_checked_by: a.actor_key,
          response_checked_by_label: a.actor_label,
          updated_at: now,
        };
        if (body.email_thread_id != null) patch.email_thread_id = body.email_thread_id;
        const { data, error } = await supabase
          .from("playlist_ops_ledger")
          .update(patch)
          .eq("id", id)
          .select("*")
          .single();
        if (error) throw new Error(error.message);
        return { status: 200, data: { ok: true, ledger: data } };
      }

      case "record_curator_reply":
      case "record_reply_classification": {
        assertCan(actor, "classify_replies");
        const id = requireUuid(body.id ?? body.ledger_id, "id");
        const status = String(body.response_status ?? "").trim();
        if (!status) throw new Error("response_status is required");
        const now = new Date().toISOString();
        const { data, error } = await supabase
          .from("playlist_ops_ledger")
          .update({
            response_status: status,
            response_checked_by: a.actor_key,
            response_checked_by_label: a.actor_label,
            last_inbox_check_at: now,
            updated_at: now,
          })
          .eq("id", id)
          .select("*")
          .single();
        if (error) throw new Error(error.message);
        return { status: 200, data: { ok: true, ledger: data } };
      }

      case "record_response_draft": {
        assertCan(actor, "respond_to_curators");
        const id = requireUuid(body.id ?? body.ledger_id, "id");
        const now = new Date().toISOString();
        const { data, error } = await supabase
          .from("playlist_ops_ledger")
          .update({
            response_draft: body.response_draft ?? null,
            response_status: body.response_status ?? "response_drafted",
            updated_at: now,
          })
          .eq("id", id)
          .select("*")
          .single();
        if (error) throw new Error(error.message);
        return { status: 200, data: { ok: true, ledger: data } };
      }

      case "record_sent_response": {
        assertCan(actor, "respond_to_curators");
        const id = requireUuid(body.id ?? body.ledger_id, "id");
        const now = new Date().toISOString();
        const { data, error } = await supabase
          .from("playlist_ops_ledger")
          .update({
            response_status: "response_sent",
            response_sent_at: now,
            email_message_id: body.email_message_id ?? null,
            email_thread_id: body.email_thread_id ?? null,
            updated_at: now,
          })
          .eq("id", id)
          .select("*")
          .single();
        if (error) throw new Error(error.message);
        return { status: 200, data: { ok: true, ledger: data } };
      }

      case "record_placement_check": {
        assertCan(actor, "record_placement_evidence");
        const id = requireUuid(body.id ?? body.ledger_id, "id");
        const now = new Date().toISOString();
        const intervalHours = Number(body.check_interval_hours ?? 72);
        const next = body.next_placement_check_at
          ? String(body.next_placement_check_at)
          : new Date(Date.now() + Math.max(1, intervalHours) * 60 * 60 * 1000).toISOString();
        const patch: Json = {
          last_placement_check_at: now,
          next_placement_check_at: next,
          placement_checked_by: a.actor_key,
          placement_checked_by_label: a.actor_label,
          updated_at: now,
        };
        if (body.placement_status != null) patch.placement_status = body.placement_status;
        const { data, error } = await supabase
          .from("playlist_ops_ledger")
          .update(patch)
          .eq("id", id)
          .select("*")
          .single();
        if (error) throw new Error(error.message);
        return { status: 200, data: { ok: true, ledger: data } };
      }

      case "record_placement_evidence": {
        assertCan(actor, "record_placement_evidence");
        const id = requireUuid(body.id ?? body.ledger_id, "id");
        const evidence = body.placement_evidence;
        if (!evidence || typeof evidence !== "object") {
          throw new Error("placement_evidence object is required (never infer from stream thresholds alone)");
        }
        const now = new Date().toISOString();
        const { data, error } = await supabase
          .from("playlist_ops_ledger")
          .update({
            placement_status: String(body.placement_status ?? "placed"),
            placement_evidence: evidence,
            placement_checked_by: a.actor_key,
            placement_checked_by_label: a.actor_label,
            last_placement_check_at: now,
            updated_at: now,
          })
          .eq("id", id)
          .select("*")
          .single();
        if (error) throw new Error(error.message);
        return { status: 200, data: { ok: true, ledger: data } };
      }

      case "open_playlist_ops_incident": {
        assertCan(actor, "open_incidents");
        const id = requireUuid(body.id ?? body.ledger_id, "id");
        const title = String(body.title ?? "").trim();
        if (!title) throw new Error("title is required");
        const { data: incident, error: iErr } = await supabase
          .from("ops_incidents")
          .insert({
            title,
            detail: {
              description: body.description ?? null,
              ledger_id: id,
            },
            severity: String(body.severity ?? "warn"),
            category: "playlist_ops",
            status: "open",
            related_entity: "playlist_ops_ledger",
            related_id: id,
            created_by: a.actor_user_id,
          })
          .select("id")
          .single();
        if (iErr) throw new Error(iErr.message);
        const now = new Date().toISOString();
        const { data, error } = await supabase
          .from("playlist_ops_ledger")
          .update({
            incident_id: incident.id,
            rejection_or_shortfall_reason: body.rejection_or_shortfall_reason ?? title,
            updated_at: now,
          })
          .eq("id", id)
          .select("*")
          .single();
        if (error) throw new Error(error.message);
        return { status: 200, data: { ok: true, ledger: data, incident_id: incident.id } };
      }

      case "get_playlist_ops_metrics":
      case "get_ops_metrics": {
        assertCan(actor, "read_ops_metrics");
        const dayStart = startOfUtcDayIso();
        const trackId = body.track_id ? requireUuid(body.track_id, "track_id") : null;
        const sendTarget = Number(body.send_target_per_song ?? 30);

        let q = supabase.from("playlist_ops_ledger").select("*");
        if (trackId) q = q.eq("track_id", trackId);
        const { data: rows, error } = await q;
        if (error) throw new Error(error.message);
        const items = rows ?? [];
        const now = Date.now();

        const bySong: Record<string, Json> = {};
        const byAgent: Record<string, Json> = {};

        const emptyBag = (key: string): Json => ({
          key,
          discovered_today: 0,
          verified_today: 0,
          rejected_today: 0,
          drafts_today: 0,
          drafts_created_today: 0,
          drafts_approved_today: 0,
          drafts_rejected_today: 0,
          pitches_sent_today: 0,
          replies_received: 0,
          replies_awaiting_action: 0,
          placements_found: 0,
          placement_checks_overdue: 0,
          inbox_checks_overdue: 0,
          shortfall_reasons: [] as string[],
        });

        const bump = (bag: Record<string, Json>, key: string, field: string, n = 1) => {
          if (!bag[key]) bag[key] = emptyBag(key);
          (bag[key] as Json)[field] = Number((bag[key] as Json)[field] ?? 0) + n;
        };

        const agentKey = (v: unknown) => String(v ?? "unknown");

        for (const r of items) {
          const song = String(r.track_id);
          if (r.discovered_at && String(r.discovered_at) >= dayStart) {
            bump(bySong, song, "discovered_today");
            bump(byAgent, agentKey(r.discovered_by), "discovered_today");
          }
          if (r.verified_at && String(r.verified_at) >= dayStart) {
            if (r.verification_result === "rejected") {
              bump(bySong, song, "rejected_today");
              bump(byAgent, agentKey(r.verified_by), "rejected_today");
            } else {
              bump(bySong, song, "verified_today");
              bump(byAgent, agentKey(r.verified_by), "verified_today");
            }
          }
          if (r.drafted_at && String(r.drafted_at) >= dayStart) {
            bump(bySong, song, "drafts_today");
            bump(bySong, song, "drafts_created_today");
            bump(byAgent, agentKey(r.drafted_by), "drafts_today");
            bump(byAgent, agentKey(r.drafted_by), "drafts_created_today");
          }
          if (r.approved_at && String(r.approved_at) >= dayStart) {
            if (r.approval_result === "approved") {
              bump(bySong, song, "drafts_approved_today");
              bump(byAgent, agentKey(r.approved_by), "drafts_approved_today");
            } else if (r.approval_result === "rejected") {
              bump(bySong, song, "drafts_rejected_today");
              bump(byAgent, agentKey(r.approved_by), "drafts_rejected_today");
            }
          }
          if (r.sent_at && String(r.sent_at) >= dayStart) {
            bump(bySong, song, "pitches_sent_today");
            bump(byAgent, agentKey(r.sent_by), "pitches_sent_today");
          }
          if (r.response_status && r.response_status !== "none") {
            bump(bySong, song, "replies_received");
            bump(byAgent, agentKey(r.response_checked_by), "replies_received");
          }
          if (["awaiting_action", "needs_reply", "response_drafted"].includes(String(r.response_status ?? ""))) {
            bump(bySong, song, "replies_awaiting_action");
          }
          if (r.placement_status === "placed" || r.placement_evidence) {
            bump(bySong, song, "placements_found");
          }
          if (r.next_placement_check_at && new Date(String(r.next_placement_check_at)).getTime() < now) {
            bump(bySong, song, "placement_checks_overdue");
          }
          if (r.next_response_check_at && new Date(String(r.next_response_check_at)).getTime() < now) {
            bump(bySong, song, "inbox_checks_overdue");
          }
          if (r.rejection_or_shortfall_reason) {
            if (!bySong[song]) bySong[song] = emptyBag(song);
            (bySong[song].shortfall_reasons as string[]).push(String(r.rejection_or_shortfall_reason));
          }
        }

        const songs = Object.values(bySong).map((s) => {
          const sent = Number(s.pitches_sent_today ?? 0);
          return {
            ...s,
            track_id: s.key,
            send_target: sendTarget,
            supply_required_to_target: Math.max(0, sendTarget - sent),
            supply_needed: Math.max(0, sendTarget - sent),
          };
        });

        const agents = Object.values(byAgent).map((s) => ({
          ...s,
          agent: s.key,
        }));

        return {
          status: 200,
          data: {
            ok: true,
            as_of: new Date().toISOString(),
            day_start_utc: dayStart,
            send_target_per_song: sendTarget,
            by_song: songs,
            by_agent: agents,
            rows: [...songs, ...agents],
            totals: {
              ledger_rows: items.length,
              pitches_sent_today: items.filter((r) => r.sent_at && String(r.sent_at) >= dayStart).length,
              placement_checks_overdue: items.filter(
                (r) => r.next_placement_check_at && new Date(String(r.next_placement_check_at)).getTime() < now,
              ).length,
              inbox_checks_overdue: items.filter(
                (r) => r.next_response_check_at && new Date(String(r.next_response_check_at)).getTime() < now,
              ).length,
            },
          },
        };
      }

      default:
        return { status: 400, data: { error: `Unhandled playlist ops action: ${action}` } };
    }
  } catch (e) {
    return {
      status: statusOf(e),
      data: { error: e instanceof Error ? e.message : String(e) },
    };
  }
}
