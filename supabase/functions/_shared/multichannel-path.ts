/**
 * Multichannel submission-path verification.
 * "Verified" means a legitimate path exists (email OR web form OR IG DM) —
 * not merely that an email address is present.
 *
 * No automated form POST and no bulk / unattended IG DM sending live here.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import type { Actor } from "./outreach-auth.ts";
import {
  attributionFrom,
  resolveOpsActor,
  stripSpoofedAttribution,
} from "./ops-actors.ts";
import { assertKnownChannel } from "./handoff-queues.ts";
import { verifyEmail } from "./verify-target.ts";
import { enforceTrackDnaLaneEnvelope } from "./track-dna-envelope.ts";

export type RunResult = { status: number; data: Record<string, unknown> };

export const MULTICHANNEL_ACTIONS = [
  "verify_submission_path",
  "build_web_form_packet",
  "build_instagram_dm_draft",
] as const;

export function isMultichannelAction(action: string): boolean {
  return (MULTICHANNEL_ACTIONS as readonly string[]).includes(action);
}

const URL_RE = /^https?:\/\/.+/i;
const IG_HANDLE_RE = /^@?[A-Za-z0-9._]{2,30}$/;

export function isValidFormUrl(url: string | null | undefined): boolean {
  const u = (url ?? "").trim();
  return URL_RE.test(u);
}

export function isValidIgAccount(handle: string | null | undefined): boolean {
  const h = (handle ?? "").trim();
  return IG_HANDLE_RE.test(h);
}

export type PathVerifyInput = {
  submission_channel?: string | null;
  curator_email?: string | null;
  form_url?: string | null;
  form_source_evidence?: string | null;
  ig_curator_account?: string | null;
  ig_source_evidence?: string | null;
  submission_url?: string | null;
  curator_instagram?: string | null;
  song_dna_version_id?: string | null;
};

export type PathVerifyResult = {
  ok: boolean;
  path_verified: boolean;
  channel: string | null;
  status: "auto_verified" | "manually_verified" | "unverified";
  reason: string;
  code?: string;
};

/**
 * Pure path verification — email still uses MX/format checks;
 * form/DM require URL/handle + source evidence.
 */
export async function evaluateSubmissionPath(
  input: PathVerifyInput,
  opts?: { bounceCount?: number; sb?: SupabaseClient },
): Promise<PathVerifyResult> {
  const channelRaw = (input.submission_channel ?? "").trim().toLowerCase() || null;
  if (channelRaw) {
    const err = assertKnownChannel(channelRaw);
    if (err) {
      return {
        ok: false,
        path_verified: false,
        channel: channelRaw,
        status: "unverified",
        reason: err,
        code: "unknown_channel",
      };
    }
  }

  // Infer channel when not supplied.
  let channel = channelRaw;
  if (!channel) {
    if ((input.curator_email ?? "").trim()) channel = "email";
    else if (isValidFormUrl(input.form_url ?? input.submission_url)) channel = "web_form";
    else if (isValidIgAccount(input.ig_curator_account ?? input.curator_instagram)) {
      channel = "instagram_dm";
    }
  }
  if (!channel) {
    return {
      ok: false,
      path_verified: false,
      channel: null,
      status: "unverified",
      reason: "no legitimate submission path (email, web form, or IG DM)",
      code: "no_path",
    };
  }

  if (channel === "email") {
    if (!opts?.sb) {
      const email = (input.curator_email ?? "").trim();
      if (!email) {
        return {
          ok: false,
          path_verified: false,
          channel,
          status: "unverified",
          reason: "no email on file",
          code: "no_email",
        };
      }
      // Without DB, only format gate — caller should prefer full verifyEmail.
      return {
        ok: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
        path_verified: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
        channel,
        status: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? "auto_verified" : "unverified",
        reason: "format-only check (no DB)",
      };
    }
    const verdict = await verifyEmail(opts.sb, input.curator_email ?? "", opts.bounceCount ?? 0);
    return {
      ok: verdict.ok,
      path_verified: verdict.ok,
      channel,
      status: verdict.status === "auto_verified" ? "auto_verified" : "unverified",
      reason: verdict.reason,
    };
  }

  if (channel === "web_form") {
    const url = (input.form_url ?? input.submission_url ?? "").trim();
    const evidence = (input.form_source_evidence ?? "").trim();
    if (!isValidFormUrl(url)) {
      return {
        ok: false,
        path_verified: false,
        channel,
        status: "unverified",
        reason: "official form URL missing or invalid",
        code: "invalid_form_url",
      };
    }
    if (!evidence) {
      return {
        ok: false,
        path_verified: false,
        channel,
        status: "unverified",
        reason: "form source evidence required",
        code: "missing_form_evidence",
      };
    }
    return {
      ok: true,
      path_verified: true,
      channel,
      status: "auto_verified",
      reason: "web form URL + source evidence verified (no automated submit)",
    };
  }

  if (channel === "instagram_dm") {
    const handle = (input.ig_curator_account ?? input.curator_instagram ?? "").trim();
    const evidence = (input.ig_source_evidence ?? "").trim();
    if (!isValidIgAccount(handle)) {
      return {
        ok: false,
        path_verified: false,
        channel,
        status: "unverified",
        reason: "curator Instagram account missing or invalid",
        code: "invalid_ig_account",
      };
    }
    if (!evidence) {
      return {
        ok: false,
        path_verified: false,
        channel,
        status: "unverified",
        reason: "IG source evidence required",
        code: "missing_ig_evidence",
      };
    }
    return {
      ok: true,
      path_verified: true,
      channel,
      status: "auto_verified",
      reason: "IG curator account + source evidence verified (draft-only; no bulk DM)",
    };
  }

  return {
    ok: false,
    path_verified: false,
    channel,
    status: "unverified",
    reason: "unknown channel fail-closed",
    code: "unknown_channel",
  };
}

/** Build a structured web-form packet for Grok review — never auto-submits. */
export function buildWebFormPacket(row: Record<string, unknown>, opts?: {
  track_id?: string | null;
  song_dna_version_id?: string | null;
}): Record<string, unknown> {
  return {
    channel: "web_form",
    automated_submit: false,
    form_url: row.form_url ?? row.submission_url ?? null,
    source_evidence: row.form_source_evidence ?? null,
    date_verified: row.form_verified_at ?? row.last_verified_at ?? null,
    requirements: row.form_requirements ?? null,
    cost: row.form_cost ?? row.submission_cost ?? null,
    login_required: row.form_login_required ?? null,
    required_fields: row.form_required_fields ?? [],
    deadline: row.form_deadline ?? null,
    playlist_id: row.playlist_id ?? null,
    playlist_name: row.playlist_name ?? null,
    track_id: opts?.track_id ?? row.track_id ?? null,
    // Server-resolved DNA only — never playlist_targets.song_dna_version_id.
    song_dna_version_id: opts?.song_dna_version_id ?? null,
    path_verified: row.path_verified ?? false,
  };
}

/** Draft-only IG DM packet — no bulk / unattended send path. */
export function buildInstagramDmPacket(
  row: Record<string, unknown>,
  draftBody?: string | null,
  opts?: { track_id?: string | null; song_dna_version_id?: string | null },
): Record<string, unknown> {
  return {
    channel: "instagram_dm",
    bulk_dm: false,
    unattended_send: false,
    scrape_followers: false,
    curator_account: row.ig_curator_account ?? row.curator_instagram ?? null,
    source_evidence: row.ig_source_evidence ?? null,
    date_verified: row.ig_verified_at ?? row.last_verified_at ?? null,
    draft_body: draftBody ?? row.ig_dm_draft ?? null,
    playlist_id: row.playlist_id ?? null,
    playlist_name: row.playlist_name ?? null,
    track_id: opts?.track_id ?? row.track_id ?? null,
    song_dna_version_id: opts?.song_dna_version_id ?? null,
    path_verified: row.path_verified ?? false,
  };
}

/**
 * Song-DNA gate for form/DM packets: must carry track_id + approved DNA version.
 */
export function assertPacketDnaEnvelope(packet: Record<string, unknown>): string | null {
  if (packet.track_id == null || String(packet.track_id).trim() === "") {
    return "form/DM packet missing track_id — DNA must bind to the song";
  }
  const dna = packet.song_dna_version_id;
  if (dna == null || String(dna).trim() === "") {
    return "form/DM packet missing song_dna_version_id — cannot bypass Song-DNA enforcement";
  }
  return null;
}

export async function runMultichannelAction(
  action: string,
  body: Record<string, unknown>,
  sb: SupabaseClient,
  actor: Actor | null,
  req: Request | null,
): Promise<RunResult> {
  const ops = resolveOpsActor(actor, req);
  const clean = stripSpoofedAttribution(body);
  const attr = attributionFrom(ops);

  if (action === "verify_submission_path") {
    const playlistId = String(clean.playlist_id ?? "").trim();
    let row: Record<string, unknown> = { ...clean };
    if (playlistId) {
      const { data, error } = await sb.from("playlist_targets").select("*").eq("playlist_id", playlistId).maybeSingle();
      if (error) return { status: 500, data: { error: error.message } };
      if (data) row = { ...data, ...clean };
    }
    const verdict = await evaluateSubmissionPath(
      {
        submission_channel: (row.submission_channel ?? row.contact_method ?? row.submission_method) as string,
        curator_email: row.curator_email as string,
        form_url: (row.form_url ?? row.submission_url) as string,
        form_source_evidence: row.form_source_evidence as string,
        ig_curator_account: (row.ig_curator_account ?? row.curator_instagram) as string,
        ig_source_evidence: row.ig_source_evidence as string,
      },
      { sb, bounceCount: Number(row.bounce_count ?? 0) },
    );
    // Path verification alone does not authorize pitching — DNA/lane stays on draft/handoff.
    if (playlistId && verdict.path_verified) {
      const patch: Record<string, unknown> = {
        path_verified: true,
        path_verification_notes: verdict.reason,
        verification_status: verdict.status,
        verification_notes: verdict.reason,
        last_verified_at: new Date().toISOString(),
        verified_by: attr.actor_kind,
        verified_by_label: attr.actor_label,
        contact_method: verdict.channel,
        submission_method: verdict.channel,
        updated_at: new Date().toISOString(),
      };
      if (verdict.channel === "web_form") {
        patch.form_url = row.form_url ?? row.submission_url ?? null;
        patch.form_source_evidence = row.form_source_evidence ?? null;
        patch.form_verified_at = new Date().toISOString();
        if (row.form_requirements != null) patch.form_requirements = row.form_requirements;
        if (row.form_cost != null) patch.form_cost = row.form_cost;
        if (row.form_login_required != null) patch.form_login_required = row.form_login_required;
        if (row.form_required_fields != null) patch.form_required_fields = row.form_required_fields;
        if (row.form_deadline != null) patch.form_deadline = row.form_deadline;
      }
      if (verdict.channel === "instagram_dm") {
        patch.ig_curator_account = row.ig_curator_account ?? row.curator_instagram ?? null;
        patch.ig_source_evidence = row.ig_source_evidence ?? null;
        patch.ig_verified_at = new Date().toISOString();
      }
      // Do NOT write song_dna_version_id onto playlist_targets as authoritative.
      const { error: updErr } = await sb.from("playlist_targets").update(patch).eq("playlist_id", playlistId);
      if (updErr) return { status: 500, data: { error: updErr.message } };
    }
    return { status: 200, data: { ...verdict, ok: verdict.ok } };
  }

  if (action === "build_web_form_packet") {
    const playlistId = String(clean.playlist_id ?? "").trim();
    const trackId = String(clean.track_id ?? "").trim();
    if (!playlistId) return { status: 400, data: { error: "playlist_id required" } };
    if (!trackId) return { status: 422, data: { error: "track_id required", code: "missing_track_id" } };

    const envelope = await enforceTrackDnaLaneEnvelope(sb, {
      route: "build_web_form_packet",
      trackId,
      playlistId,
      callerSongDnaVersionId: clean.song_dna_version_id != null ? String(clean.song_dna_version_id) : null,
      actor: ops,
    });
    if (!envelope.ok) {
      return {
        status: 422,
        data: { error: envelope.errors[0] ?? "dna_lane_rejected", code: envelope.errors[0], errors: envelope.errors },
      };
    }

    const { data, error } = await sb.from("playlist_targets").select("*").eq("playlist_id", playlistId).maybeSingle();
    if (error) return { status: 500, data: { error: error.message } };
    if (!data) return { status: 404, data: { error: "target not found" } };
    const packet = buildWebFormPacket(data as Record<string, unknown>, {
      track_id: trackId,
      song_dna_version_id: envelope.songDnaVersionId,
    });
    const dnaErr = assertPacketDnaEnvelope(packet);
    if (dnaErr) return { status: 422, data: { error: dnaErr, code: "dna_required" } };
    return {
      status: 200,
      data: { ok: true, packet, automated_submit: false, auto_form_post: false },
    };
  }

  if (action === "build_instagram_dm_draft") {
    const playlistId = String(clean.playlist_id ?? "").trim();
    const trackId = String(clean.track_id ?? "").trim();
    if (!playlistId) return { status: 400, data: { error: "playlist_id required" } };
    if (!trackId) return { status: 422, data: { error: "track_id required", code: "missing_track_id" } };

    // Validate BEFORE any write — failed validation leaves no persisted copy.
    const envelope = await enforceTrackDnaLaneEnvelope(sb, {
      route: "build_instagram_dm_draft",
      trackId,
      playlistId,
      callerSongDnaVersionId: clean.song_dna_version_id != null ? String(clean.song_dna_version_id) : null,
      actor: ops,
    });
    if (!envelope.ok) {
      return {
        status: 422,
        data: {
          error: envelope.errors[0] ?? "dna_lane_rejected",
          code: envelope.errors[0],
          errors: envelope.errors,
          persisted: false,
        },
      };
    }

    const { data, error } = await sb.from("playlist_targets").select("*").eq("playlist_id", playlistId).maybeSingle();
    if (error) return { status: 500, data: { error: error.message } };
    if (!data) return { status: 404, data: { error: "target not found" } };

    const draftBody = clean.draft_body != null
      ? String(clean.draft_body)
      : (data as { ig_dm_draft?: string }).ig_dm_draft;

    if (clean.draft_body != null) {
      const { error: writeErr } = await sb
        .from("playlist_targets")
        .update({
          ig_dm_draft: String(clean.draft_body),
          updated_at: new Date().toISOString(),
        })
        .eq("playlist_id", playlistId);
      if (writeErr) return { status: 500, data: { error: writeErr.message, persisted: false } };
    }

    const packet = buildInstagramDmPacket(data as Record<string, unknown>, draftBody, {
      track_id: trackId,
      song_dna_version_id: envelope.songDnaVersionId,
    });
    const dnaErr = assertPacketDnaEnvelope(packet);
    if (dnaErr) return { status: 422, data: { error: dnaErr, code: "dna_required", persisted: false } };
    return {
      status: 200,
      data: {
        ok: true,
        packet,
        bulk_dm: false,
        unattended_send: false,
        scrape_followers: false,
      },
    };
  }

  return { status: 400, data: { error: `Unknown multichannel action: ${action}` } };
}
