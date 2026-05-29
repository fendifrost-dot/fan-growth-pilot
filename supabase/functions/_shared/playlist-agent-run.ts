/**
 * Shared playlist-agent handlers — used by standalone edge functions AND control-center-api.
 * Workaround: Lovable Publish redeploys existing functions only; new function names 404 until registered.
 */
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { firecrawlMarkdown } from "./firecrawl.ts";
import { loadLanesConfig } from "./playlist-lanes.ts";
import { scrapeSpotifyPlaylistDetail, scrapeSpotifyUserProfile } from "./spotify-scrape.ts";

export type RunResult = { status: number; data: unknown };

const RATE_MS = 2000;

function pickChannel(row: Record<string, unknown>, channelOverride?: string): string | null {
  const ch = (channelOverride ?? "").trim().toLowerCase();
  if (ch) return ch;
  if ((row.curator_email as string | null)?.trim()) return "email";
  if ((row.curator_instagram as string | null)?.trim()) return "instagram_dm";
  if ((row.submission_url as string | null)?.trim()) return "web_form";
  return null;
}

function buildPitchBody(row: Record<string, unknown>, trackName: string, pitchAngle: string): string {
  const curator = (row.curator_name as string | null)?.trim() || "there";
  const playlist = (row.playlist_name as string | null)?.trim() || "your playlist";
  const why = (row.why_it_fits as string | null)?.trim();
  const angle = pitchAngle || (row.recommended_pitch_angle as string | null)?.trim() ||
    "Melodic rap with a deep-house groove — late-night luxury energy.";
  return [
    `Hi ${curator},`, "", `I'd love to submit **${trackName}** by **Fendi Frost** for *${playlist}*.`,
    "", angle, why ? `\n${why}` : "",
    "", "Happy to share the Spotify link or any extra context. Thank you for your time.", "", "— Fendi Frost",
  ].filter(Boolean).join("\n");
}

export async function runDraftPitch(body: Record<string, unknown>, sb: SupabaseClient): Promise<RunResult> {
  const playlistId = String(body.playlist_id ?? "").trim();
  const trackName = String(body.track_name ?? "").trim();
  const channelOverride = typeof body.channel === "string" ? body.channel : "";
  const generatedBy = String(body.generated_by ?? body.approved_by ?? "auto").trim() || "auto";
  if (!playlistId || !trackName) return { status: 400, data: { error: "playlist_id and track_name required" } };

  const { data: row, error: rowErr } = await sb.from("playlist_targets").select("*").eq("playlist_id", playlistId).maybeSingle();
  if (rowErr || !row) return { status: 404, data: { error: "Playlist not found" } };

  const channel = pickChannel(row, channelOverride);
  if (!channel) return { status: 400, data: { error: "No outreach channel available (email, IG, or submission URL)" } };

  const lanes = await loadLanesConfig(sb);
  const lane = String(row.lane ?? "").trim();
  const pitchAngle = lane ? (lanes[lane]?.pitch_angle ?? "") : "";

  let recipient: string | null = null;
  if (channel === "email") recipient = (row.curator_email as string)?.trim() ?? null;
  else if (channel === "instagram_dm") recipient = (row.curator_instagram as string)?.trim() ?? null;
  else if (channel === "web_form") recipient = (row.submission_url as string)?.trim() ?? null;

  const subject = typeof body.override_subject === "string" && body.override_subject.trim()
    ? body.override_subject.trim()
    : `Submission for ${row.playlist_name}: Fendi Frost — ${trackName}`;
  const pitchBody = typeof body.override_body === "string" && body.override_body.trim()
    ? body.override_body.trim()
    : buildPitchBody(row, trackName, pitchAngle);

  const { data: draft, error: insErr } = await sb.from("outreach_drafts").insert({
    playlist_id: playlistId, track_name: trackName, channel, recipient,
    subject: channel === "email" ? subject : null, body: pitchBody,
    generated_by: generatedBy, status: "pending", metadata: { lane: lane || null },
  }).select("id, channel, subject, body, recipient").single();

  if (insErr) return { status: 500, data: { error: insErr.message } };
  return {
    status: 200,
    data: { ok: true, draft_id: draft.id, channel: draft.channel, subject: draft.subject, body: draft.body, recipient: draft.recipient },
  };
}

export async function runApproveDraft(body: Record<string, unknown>, sb: SupabaseClient, hubKey: string): Promise<RunResult> {
  const draftId = String(body.draft_id ?? "").trim();
  const approvedBy = String(body.approved_by ?? "admin").trim();
  const sendImmediately = Boolean(body.send_immediately);
  const reject = Boolean(body.reject);
  if (!draftId) return { status: 400, data: { error: "draft_id required" } };

  const { data: draft, error: dErr } = await sb.from("outreach_drafts")
    .select("*, playlist_targets(playlist_name, curator_name, curator_email, curator_instagram)")
    .eq("id", draftId).maybeSingle();
  if (dErr || !draft) return { status: 404, data: { error: "Draft not found" } };
  if (draft.status !== "pending") return { status: 400, data: { error: `Draft status is ${draft.status}, expected pending` } };

  if (reject) {
    await sb.from("outreach_drafts").update({ status: "rejected", approved_at: new Date().toISOString(), approved_by: approvedBy }).eq("id", draftId);
    return { status: 200, data: { ok: true, status: "rejected" } };
  }

  await sb.from("outreach_drafts").update({ status: "approved", approved_at: new Date().toISOString(), approved_by: approvedBy }).eq("id", draftId);
  if (!sendImmediately) return { status: 200, data: { ok: true, status: "approved", sent: false } };

  const pl = draft.playlist_targets as Record<string, unknown> | null;
  const playlistName = (pl?.playlist_name as string) ?? draft.playlist_id;
  const curatorName = (pl?.curator_name as string) ?? "";
  const channel = draft.channel as string;

  if (channel === "web_form") {
    return { status: 200, data: { ok: true, status: "approved", sent: false, manual_submit: true, submission_url: draft.recipient, message: "Open the submission URL and paste the draft body manually." } };
  }
  if (channel === "instagram_dm") {
    return { status: 422, data: { ok: true, status: "approved", sent: false, needs_manual_dm: true, recipient: draft.recipient, body: draft.body, message: "IG username → recipient_id resolution not automated. Copy body and DM manually." } };
  }
  if (channel !== "email") return { status: 400, data: { error: `Send not implemented for channel: ${channel}` } };

  const base = Deno.env.get("SUPABASE_URL")!.replace(/\/$/, "");
  const email = (draft.recipient as string)?.trim() || (pl?.curator_email as string | undefined)?.trim();
  if (!email) return { status: 400, data: { error: "No recipient email on draft" } };

  const sendRes = await fetch(`${base}/functions/v1/send-pitch-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": hubKey },
    body: JSON.stringify({
      playlist_id: draft.playlist_id, curator_email: email, curator_name: curatorName,
      playlist_name: playlistName, track_name: draft.track_name,
      subject: draft.subject ?? `Submission: ${draft.track_name} — Fendi Frost`, body: draft.body,
    }),
  });
  const sendData = await sendRes.json().catch(() => ({}));
  if (!sendRes.ok) return { status: 500, data: { error: (sendData as { error?: string }).error ?? `Send failed ${sendRes.status}` } };

  const { data: logRow } = await sb.from("pitch_log").select("id").eq("playlist_id", draft.playlist_id)
    .eq("track_name", draft.track_name).order("pitched_at", { ascending: false }).limit(1).maybeSingle();
  await sb.from("outreach_drafts").update({ status: "sent", sent_at: new Date().toISOString(), pitch_log_id: logRow?.id ?? null }).eq("id", draftId);
  return { status: 200, data: { ok: true, status: "sent", sent: true, channel: "email", send_result: sendData, pitch_log_id: logRow?.id ?? null } };
}

type Extracted = { curator_instagram?: string; curator_tiktok?: string; curator_twitter?: string; curator_website?: string; curator_linktree?: string; curator_email?: string };

function extractContacts(text: string): Extracted {
  const out: Extracted = {};
  const ig = text.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-zA-Z0-9._]+)/i);
  if (ig) out.curator_instagram = ig[1].replace(/\/$/, "");
  const tt = text.match(/(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@([a-zA-Z0-9._]+)/i);
  if (tt) out.curator_tiktok = tt[1];
  const tw = text.match(/(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/([a-zA-Z0-9_]+)/i);
  if (tw) out.curator_twitter = tw[1];
  const lt = text.match(/(?:https?:\/\/)?(?:linktr\.ee|beacons\.ai)\/([a-zA-Z0-9._-]+)/i);
  if (lt) out.curator_linktree = lt[0];
  const handle = text.match(/@([a-zA-Z0-9._]{2,30})/);
  if (handle && !out.curator_instagram) out.curator_instagram = handle[1];
  const email = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (email) out.curator_email = email[0].toLowerCase();
  const web = text.match(/https?:\/\/(?!open\.spotify|instagram|tiktok|twitter|x\.com|linktr|beacons)[^\s)]+/i);
  if (web) out.curator_website = web[0];
  return out;
}

function contactConfidence(found: Extracted, hadEmail: boolean): number {
  if (found.curator_email && found.curator_instagram) return 8;
  if (found.curator_instagram) return 6;
  if (hadEmail) return 7;
  if (found.curator_linktree || found.curator_website) return 5;
  if (Object.keys(found).length) return 3;
  return 1;
}

function mergePatch(existing: Record<string, unknown>, found: Extracted): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(found)) {
    if (v == null || v === "") continue;
    const cur = existing[k];
    if (cur != null && String(cur).trim() !== "") continue;
    patch[k] = v;
  }
  return patch;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const IG_RE = /(?:instagram\.com\/|@)([A-Za-z0-9._]+)/i;
const LINKTREE_RE = /(linktr\.ee|linktree\.com|beacons\.ai)\/([A-Za-z0-9._-]+)/i;
const ENRICH_BATCH_SIZE = 5;
const ENRICH_DEADLINE_MS = 50_000;

export async function runEnrichCuratorContacts(body: Record<string, unknown>, sb: SupabaseClient): Promise<RunResult> {
  if (!Deno.env.get("FIRECRAWL_API_KEY")) {
    return { status: 500, data: { error: "FIRECRAWL_API_KEY not configured" } };
  }

  const playlistIds = Array.isArray(body.playlist_ids) ? body.playlist_ids.map(String).filter(Boolean) : [];
  const trackName = String(body.track_name ?? "").trim();
  const offset = Math.max(0, Number(body.offset) || 0);
  const requestedLimit = Math.min(30, Math.max(1, Number(body.limit) || 10));
  const batchSize = Math.min(ENRICH_BATCH_SIZE, requestedLimit);

  let query = sb
    .from("playlist_targets")
    .select("playlist_id, curator_email, curator_instagram, curator_website, curator_linktree, platform, research_context")
    .eq("is_active", true)
    .or("curator_email.is.null,curator_instagram.is.null");

  if (playlistIds.length) {
    query = query.in("playlist_id", playlistIds.slice(0, 30));
  } else if (trackName) {
    query = query.order("follower_count", { ascending: false, nullsFirst: false });
    if (body.lane) query = query.eq("lane", String(body.lane));
  } else {
    return { status: 400, data: { error: "playlist_ids or track_name required" } };
  }

  const { data: rows, error } = await query.range(offset, offset + batchSize - 1);
  if (error) return { status: 500, data: { error: error.message } };
  if (!rows?.length) {
    return { status: 200, data: { ok: true, enriched: 0, fields_added: {}, done: true, next_offset: offset } };
  }

  const deadline = Date.now() + ENRICH_DEADLINE_MS;
  const fieldsAdded: Record<string, number> = {
    curator_email: 0,
    curator_instagram: 0,
    curator_website: 0,
    curator_linktree: 0,
  };
  let enriched = 0;

  for (const row of rows) {
    if (Date.now() > deadline) break;
    if (!String(row.playlist_id ?? "").startsWith("spotify:")) continue;

    const spotifyId = String(row.playlist_id).replace(/^spotify:/, "");
    const hadEmail = Boolean((row.curator_email as string | null)?.trim());

    try {
      const detail = await scrapeSpotifyPlaylistDetail(spotifyId);
      if (!detail) continue;

      const ownerId = detail.owner_id ??
        (row.research_context as { spotify_owner_id?: string } | null)?.spotify_owner_id;
      if (!ownerId) continue;

      const profile = await scrapeSpotifyUserProfile(ownerId);
      await sleep(1500);

      const patch: Record<string, unknown> = {};
      const bio = profile?.bio ?? "";
      const bioEmails = bio.match(EMAIL_RE);
      if (bioEmails?.length && !row.curator_email) {
        patch.curator_email = bioEmails[0].toLowerCase();
        fieldsAdded.curator_email++;
      }

      const links = profile?.social_links ?? [];
      for (const link of links) {
        const ig = link.match(IG_RE);
        if (ig && !row.curator_instagram && !patch.curator_instagram) {
          patch.curator_instagram = ig[1];
          fieldsAdded.curator_instagram++;
        }
        const lt = link.match(LINKTREE_RE);
        if (lt && !patch.curator_linktree) {
          patch.curator_linktree = `https://${lt[1]}/${lt[2]}`;
          fieldsAdded.curator_linktree++;
        }
        if (/^https?:\/\//.test(link) && !ig && !lt && !patch.curator_website && !row.curator_website) {
          patch.curator_website = link;
          fieldsAdded.curator_website++;
        }
      }

      if (!patch.curator_email && detail.description) {
        const descEmails = detail.description.match(EMAIL_RE);
        if (descEmails?.length) {
          patch.curator_email = descEmails[0].toLowerCase();
          fieldsAdded.curator_email++;
        }
      }

      const igHandle = (patch.curator_instagram ?? row.curator_instagram) as string | undefined;
      if (igHandle && !patch.curator_email && !row.curator_email) {
        try {
          const md = await firecrawlMarkdown(`https://www.instagram.com/${igHandle}/`, 2000);
          const igEmails = md.match(EMAIL_RE);
          if (igEmails?.length) {
            patch.curator_email = igEmails[0].toLowerCase();
            fieldsAdded.curator_email++;
          }
          await sleep(1500);
        } catch {
          /* IG may rate-limit */
        }
      }

      if (Object.keys(patch).length) {
        patch.contact_confidence = patch.curator_email ? 8 : (patch.curator_instagram ? 5 : 2);
        const { error: upErr } = await sb.from("playlist_targets").update(patch).eq("playlist_id", row.playlist_id);
        if (!upErr) enriched++;
      }
    } catch (e) {
      console.error(`[enrich] ${row.playlist_id} failed:`, e instanceof Error ? e.message : String(e));
    }
  }

  const next_offset = offset + rows.length;
  const done = rows.length < batchSize;

  return {
    status: 200,
    data: {
      ok: true,
      enriched,
      fields_added: fieldsAdded,
      done,
      next_offset: done ? null : next_offset,
    },
  };
}

export async function runScheduleFollowUp(body: Record<string, unknown>, sb: SupabaseClient, _hubKey: string): Promise<RunResult> {
  if (body.run === "cron") {
    const now = new Date().toISOString();
    const { data: due, error } = await sb.from("pitch_log").select("id, playlist_id, track_name, method")
      .eq("status", "sent").lte("follow_up_at", now).not("follow_up_at", "is", null);
    if (error) return { status: 500, data: { error: error.message } };

    const created: string[] = [];
    const errors: string[] = [];
    for (const row of due ?? []) {
      const channel = row.method === "email" ? "email" : row.method === "instagram_dm" ? "instagram_dm" : "web_form";
      const draftResult = await runDraftPitch({
        playlist_id: row.playlist_id, track_name: row.track_name, channel, generated_by: "schedule-follow-up:cron",
      }, sb);
      if (draftResult.status !== 200) {
        errors.push(`${row.id}: ${(draftResult.data as { error?: string }).error ?? draftResult.status}`);
        continue;
      }
      const draftId = (draftResult.data as { draft_id?: string }).draft_id;
      if (draftId) {
        const baseBody = (draftResult.data as { body?: string }).body ?? "";
        await sb.from("outreach_drafts").update({ body: "Quick follow-up — " + baseBody, metadata: { follow_up_for: row.id } }).eq("id", draftId);
        created.push(draftId);
      }
      await sb.from("pitch_log").update({ follow_up_at: null }).eq("id", row.id);
    }
    return { status: 200, data: { ok: true, due_count: due?.length ?? 0, drafts_created: created.length, draft_ids: created, errors } };
  }

  const pitchLogId = String(body.pitch_log_id ?? "").trim();
  const days = Number(body.days);
  if (!pitchLogId || !Number.isFinite(days) || days < 1) return { status: 400, data: { error: "pitch_log_id and days (>=1) required" } };
  const followUpAt = new Date(Date.now() + days * 86400000).toISOString();
  const { error: upErr } = await sb.from("pitch_log").update({ follow_up_at: followUpAt }).eq("id", pitchLogId);
  if (upErr) return { status: 500, data: { error: upErr.message } };
  return { status: 200, data: { ok: true, pitch_log_id: pitchLogId, follow_up_at: followUpAt } };
}

export async function runPlaylistAdmin(body: Record<string, unknown>, sb: SupabaseClient): Promise<RunResult> {
  const action = String(body.action ?? "").trim();
  if (action === "list_targets") {
    let q = sb.from("playlist_targets").select(
      "playlist_id, playlist_name, curator_name, curator_email, curator_instagram, lane, tier, authenticity_score, fraud_verdict, contact_confidence, pitch_status, follower_count, is_active, why_it_fits, recommended_pitch_angle, submission_url",
    ).eq("is_active", true).order("follower_count", { ascending: false, nullsFirst: false }).limit(200);
    if (body.lane) q = q.eq("lane", String(body.lane));
    if (body.tier != null && body.tier !== "") q = q.eq("tier", Number(body.tier));
    if (body.fraud_verdict) q = q.eq("fraud_verdict", String(body.fraud_verdict));
    if (body.has_email) q = q.not("curator_email", "is", null);
    if (body.has_social) q = q.or("curator_instagram.not.is.null,curator_tiktok.not.is.null,curator_twitter.not.is.null");
    const { data, error } = await q;
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true, rows: data ?? [] } };
  }
  if (action === "deactivate_target") {
    const playlistId = String(body.playlist_id ?? "").trim();
    if (!playlistId) return { status: 400, data: { error: "playlist_id required" } };
    const { error } = await sb.from("playlist_targets").update({ is_active: false }).eq("playlist_id", playlistId);
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true } };
  }
  if (action === "list_drafts") {
    const statuses = body.statuses ?? ["pending", "approved"];
    const { data, error } = await sb.from("outreach_drafts").select("*").in("status", statuses as string[])
      .order("generated_at", { ascending: false }).limit(100);
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true, rows: data ?? [] } };
  }
  if (action === "update_draft") {
    const draftId = String(body.draft_id ?? "").trim();
    if (!draftId) return { status: 400, data: { error: "draft_id required" } };
    const patch: Record<string, unknown> = {};
    if (body.subject !== undefined) patch.subject = body.subject;
    if (body.body !== undefined) patch.body = body.body;
    if (body.recipient !== undefined) patch.recipient = body.recipient;
    const { error } = await sb.from("outreach_drafts").update(patch).eq("id", draftId);
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true } };
  }
  return { status: 400, data: { error: `Unknown playlist admin action: ${action}` } };
}

async function proxyToEdgeFunction(
  fnName: string,
  body: Record<string, unknown>,
  hubKey: string,
): Promise<RunResult> {
  const base = Deno.env.get("SUPABASE_URL")!.replace(/\/$/, "");
  const { action: _action, ...rest } = body;
  const res = await fetch(`${base}/functions/v1/${fnName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": hubKey },
    body: JSON.stringify(rest),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

export async function runPlaylistResearchProxy(
  body: Record<string, unknown>,
  hubKey: string,
): Promise<RunResult> {
  return proxyToEdgeFunction("playlist-research", body, hubKey);
}

export async function runSendCampaignProxy(
  body: Record<string, unknown>,
  hubKey: string,
): Promise<RunResult> {
  return proxyToEdgeFunction("send-campaign-email", body, hubKey);
}

export async function runConnectSpotifyInit(_body: Record<string, unknown>): Promise<RunResult> {
  const artistUserId = (Deno.env.get("ARTIST_USER_ID") || "").trim();
  const clientId = Deno.env.get("SPOTIFY_CLIENT_ID");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!artistUserId) return { status: 500, data: { error: "ARTIST_USER_ID not set" } };
  if (!clientId) return { status: 500, data: { error: "SPOTIFY_CLIENT_ID not set" } };
  if (!supabaseUrl) return { status: 500, data: { error: "SUPABASE_URL not set" } };
  if (!serviceKey) return { status: 500, data: { error: "SUPABASE_SERVICE_ROLE_KEY not set" } };

  const redirectUri = `${supabaseUrl.replace(/\/$/, "")}/functions/v1/spotify-callback`;
  const scopes = [
    "user-read-email",
    "user-read-private",
    "user-top-read",
    "user-read-recently-played",
    "user-follow-read",
    "playlist-read-private",
    "user-library-read",
  ].join(" ");

  const timestamp = Date.now();
  const statePayload = `${artistUserId}:${timestamp}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(serviceKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(statePayload));
  const signatureHex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const signedState = `${statePayload}:${signatureHex}`;

  const url = new URL("https://accounts.spotify.com/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes);
  url.searchParams.set("state", signedState);

  return { status: 200, data: { ok: true, auth_url: url.toString() } };
}

export async function runConnectSpotifyStatus(
  _body: Record<string, unknown>,
  sb: SupabaseClient,
): Promise<RunResult> {
  const artistUserId = (Deno.env.get("ARTIST_USER_ID") || "").trim();
  if (!artistUserId) {
    return { status: 200, data: { connected: false, reason: "ARTIST_USER_ID not set" } };
  }
  const { data, error } = await sb
    .from("platform_connections")
    .select("token_expires_at, updated_at, is_connected")
    .eq("user_id", artistUserId)
    .eq("platform", "Spotify")
    .maybeSingle();
  if (error || !data) {
    return { status: 200, data: { connected: false, reason: error?.message ?? "no connection row" } };
  }
  return {
    status: 200,
    data: {
      connected: !!data.is_connected,
      token_expires_at: data.token_expires_at,
      updated_at: data.updated_at,
    },
  };
}

const PLAYLIST_AGENT_ACTIONS = new Set([
  "draft_pitch", "approve_draft", "enrich_curator_contacts", "schedule_follow_up",
  "list_targets", "list_drafts", "update_draft", "deactivate_target",
  "run_playlist_research", "send_campaign",
  "connect_spotify_init", "connect_spotify_status",
]);

export function isPlaylistAgentAction(action: string): boolean {
  return PLAYLIST_AGENT_ACTIONS.has(action);
}

export async function runPlaylistAgentAction(
  action: string,
  body: Record<string, unknown>,
  sb: SupabaseClient,
  hubKey: string,
): Promise<RunResult> {
  switch (action) {
    case "draft_pitch": return runDraftPitch(body, sb);
    case "approve_draft": return runApproveDraft(body, sb, hubKey);
    case "enrich_curator_contacts": return runEnrichCuratorContacts(body, sb);
    case "schedule_follow_up": return runScheduleFollowUp(body, sb, hubKey);
    case "list_targets":
    case "list_drafts":
    case "update_draft":
    case "deactivate_target":
      return runPlaylistAdmin({ ...body, action }, sb);
    case "run_playlist_research":
      return runPlaylistResearchProxy(body, hubKey);
    case "send_campaign":
      return runSendCampaignProxy(body, hubKey);
    case "connect_spotify_init":
      return runConnectSpotifyInit(body);
    case "connect_spotify_status":
      return runConnectSpotifyStatus(body, sb);
    default:
      return { status: 400, data: { error: `Unknown playlist agent action: ${action}` } };
  }
}
