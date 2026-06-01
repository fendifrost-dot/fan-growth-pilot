/**
 * Shared playlist-agent handlers — used by standalone edge functions AND control-center-api.
 * Workaround: Lovable Publish redeploys existing functions only; new function names 404 until registered.
 */
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  confidenceForEmailSource,
  extractEmails,
  extractLinktreeUrls,
  extractSubmissionDM,
  extractIgHandle,
  extractSubmissionLinkFromMarkdown,
  extractSubmissionNote,
  isValidCuratorIgHandle,
  sanitizeCuratorIgHandle,
  scoreHunterEmail,
} from "./contact-extract.ts";
import { firecrawl, firecrawlSearch } from "./firecrawl.ts";
import {
  isArtistAsCurator,
  isArtistIgHandle,
  isDisclaimBrand,
  isSpotifyOwnedCurator,
} from "./curator-filters.ts";
import {
  isLaneGenreMismatch,
  laneRegexBoost,
  loadLanesConfig,
  type LaneConfig,
  rowMatchesLane,
} from "./playlist-lanes.ts";
import {
  profileCuratorBioLinks,
  scrapeSpotifyPlaylistDetail,
  scrapeSpotifySearchPlaylists,
  scrapeSpotifyUserProfile,
} from "./spotify-scrape.ts";
import { discoverSpotifyPlacements } from "./spotify-placements.ts";
import { importSpotifyForArtistsCsv } from "./spotify-for-artists-csv.ts";
import { isWarmPlacementSource } from "./placement-sources.ts";
import {
  buildIgQueueInsert,
  queueIgDm,
  runQueueIgOutreachBatch,
  IG_DM_DAILY_CAP,
  countIgDmsToday,
  type IgQueueInsert,
} from "./ig-outreach.ts";
import { runIgRosterAdmin, getRosterEntry } from "./ig-roster.ts";
import { loadCatalogTracks, pickCatalogTrackForPlacement } from "./catalog-match.ts";
import { buildIgOutreachPackage, nextDmRef } from "./outreach-templates.ts";
import {
  renderPitchBody,
  trackUrlForPlatform,
  type Platform,
  type Tone,
} from "./pitch-templates.ts";
import { defaultPlaylistPitchSubject } from "./resend-pitch.ts";
import {
  DEFAULT_STRATEGY_ORDER,
  newContext as newCuratorContext,
  runStrategyChain as runCuratorStrategyChain,
  type AttemptLog as CuratorAttemptLog,
  type CuratorRow,
  type StrategyName as CuratorStrategyName,
} from "./curator-strategies.ts";

export type RunResult = { status: number; data: unknown };

const RATE_MS = 2000;

function rowDiscoveryReferences(
  row: { research_context?: unknown; similar_artists?: unknown; lane?: string | null },
  lanesConfig: Record<string, LaneConfig>,
  bodyReferences: string[] = [],
): string[] {
  const rc = row.research_context as Record<string, unknown> | null;
  if (Array.isArray(rc?.references) && rc.references.length) {
    return rc.references.map(String).filter(Boolean);
  }
  if (bodyReferences.length) return bodyReferences;
  if (Array.isArray(row.similar_artists) && row.similar_artists.length) {
    return row.similar_artists.map(String);
  }
  const lane = String(row.lane ?? "").trim();
  return lane && lanesConfig[lane]?.references ? [...lanesConfig[lane].references!] : [];
}

function tryAssignCuratorInstagram(
  patch: Record<string, unknown>,
  row: { curator_instagram?: string | null },
  handle: string | null | undefined,
  references: string[],
  fieldsAdded?: Record<string, number>,
): boolean {
  if (!handle || patch.curator_instagram || row.curator_instagram) return false;
  const clean = handle.replace(/^@/, "").trim();
  if (!isValidCuratorIgHandle(clean)) return false;
  if (isArtistIgHandle(clean, references)) return false;
  patch.curator_instagram = clean;
  if (fieldsAdded) fieldsAdded.curator_instagram = (fieldsAdded.curator_instagram ?? 0) + 1;
  return true;
}

function pickChannel(row: Record<string, unknown>, channelOverride?: string): string | null {
  const ch = (channelOverride ?? "").trim().toLowerCase();
  if (ch) return ch;
  const method = (row.submission_method as string | null)?.trim();
  if (method === "email" && (row.curator_email as string | null)?.trim()) return "email";
  if (method === "web_form" && (row.submission_url as string | null)?.trim()) return "web_form";
  if (method === "instagram_dm" && isValidCuratorIgHandle(row.curator_instagram as string)) return "instagram_dm";
  if ((row.curator_email as string | null)?.trim()) return "email";
  if (isValidCuratorIgHandle(row.curator_instagram as string)) return "instagram_dm";
  if ((row.submission_url as string | null)?.trim()) return "web_form";
  return null;
}

async function resolveStreamLink(sb: SupabaseClient, trackName: string): Promise<string> {
  const { data } = await sb.from("artist_config").select("value").eq("key", "spotify_track_urls").maybeSingle();
  const urls = (data?.value && typeof data.value === "object" && !Array.isArray(data.value))
    ? data.value as Record<string, string>
    : {};
  const url = urls[trackName]?.trim();
  if (!url) {
    console.warn(`resolveStreamLink: no spotify_track_urls entry for ${JSON.stringify(trackName)}`);
    return "";
  }
  return url;
}

function buildPitchBody(row: Record<string, unknown>, trackName: string, pitchAngle: string, streamLink: string): string {
  const curator = (row.curator_name as string | null)?.trim() || "there";
  const playlist = (row.playlist_name as string | null)?.trim() || "your playlist";
  const angle = pitchAngle || (row.recommended_pitch_angle as string | null)?.trim() ||
    "Melodic rap with a deep-house groove — late-night luxury energy.";
  const lines = [
    `Hi ${curator},`,
    "",
    `I'd love to submit **${trackName}** for *${playlist}*.`,
    "",
    angle,
  ];
  if (streamLink) {
    lines.push("", `Stream: ${streamLink}`);
  }
  lines.push(
    "Happy to share extra context or a different mix if useful.",
    "Thank you for your time.",
    "",
    "— Fendi Frost",
  );
  return lines.join("\n");
}

const VALID_TONES = new Set(["warm_personal", "casual_friendly", "business_formal", "hyped_energetic"]);

async function detectWarmPlacement(
  sb: SupabaseClient,
  playlistId: string,
): Promise<{ isWarm: boolean; priorTrack?: string }> {
  const { data: warmRows } = await sb.from("pitch_log")
    .select("track_name, pitched_at")
    .eq("playlist_id", playlistId)
    .or("placed.eq.true,placement_status.eq.placed")
    .order("pitched_at", { ascending: false })
    .limit(1);
  const warm = warmRows?.[0];
  if (!warm) return { isWarm: false };
  return { isWarm: true, priorTrack: String(warm.track_name ?? "").trim() || undefined };
}

export async function runDraftPitch(body: Record<string, unknown>, sb: SupabaseClient): Promise<RunResult> {
  const playlistId = String(body.playlist_id ?? "").trim();
  const trackId = String(body.track_id ?? "").trim();
  let trackName = String(body.track_name ?? "").trim();
  const channelOverride = typeof body.channel === "string" ? body.channel : "";
  const generatedBy = String(body.generated_by ?? body.approved_by ?? "auto").trim() || "auto";
  if (!playlistId) return { status: 400, data: { error: "playlist_id required" } };

  const { data: row, error: rowErr } = await sb.from("playlist_targets")
    .select("*, playlist_categories(category_id, categories(id, slug, label, family))")
    .eq("playlist_id", playlistId)
    .maybeSingle();
  if (rowErr || !row) return { status: 404, data: { error: "Playlist not found" } };

  if (trackId) {
    const { data: track, error: trackErr } = await sb.from("tracks")
      .select("*, track_categories(category_id, categories(id, slug, label, family))")
      .eq("id", trackId)
      .maybeSingle();
    if (trackErr || !track) return { status: 404, data: { error: "Track not found" } };

    trackName = String(track.name ?? "").trim();
    const channel = pickChannel(row, channelOverride);
    if (!channel) return { status: 400, data: { error: "No outreach channel available (email, IG, or submission URL)" } };
    if (channel !== "email") {
      return { status: 400, data: { error: "Catalogue pitch composer supports email channel only" } };
    }

    const trackCatIds = ((track.track_categories ?? []) as { category_id: string }[]).map((tc) => tc.category_id);
    const playlistCatIds = ((row.playlist_categories ?? []) as { category_id: string }[]).map((pc) => pc.category_id);
    const trackCats = ((track.track_categories ?? []) as { categories: { id: string; slug: string; label: string } | null }[])
      .map((tc) => tc.categories).filter(Boolean);
    const playlistCats = ((row.playlist_categories ?? []) as { categories: { id: string; slug: string; label: string } | null }[])
      .map((pc) => pc.categories).filter(Boolean);
    const overlap = trackCatIds.filter((id) => playlistCatIds.includes(id));
    if (overlap.length === 0 && !Boolean(body.override_category_check)) {
      return {
        status: 422,
        data: {
          error: "Category mismatch",
          track_categories: trackCats,
          playlist_categories: playlistCats,
        },
      };
    }

    const platform = (String(row.platform ?? "spotify").trim() || "spotify") as Platform;
    const streamUrl = trackUrlForPlatform(track, platform);
    if (!streamUrl) {
      return { status: 400, data: { error: `Track has no URL for platform: ${platform}` } };
    }

    const toneRaw = String(body.tone ?? track.default_tone ?? "warm_personal");
    const tone = (VALID_TONES.has(toneRaw) ? toneRaw : "warm_personal") as Tone;
    const { isWarm, priorTrack } = await detectWarmPlacement(sb, playlistId);
    if (isWarm && !priorTrack) {
      return { status: 422, data: { error: "Warm placement found but prior track name missing" } };
    }

    const shortPitch = String(track.short_pitch ?? track.pitch_angle ?? "").trim()
      || "Melodic rap with a deep-house groove — late-night luxury energy.";
    const rendered = renderPitchBody({
      curatorName: (row.curator_name as string | null)?.trim() || "there",
      playlistName: (row.playlist_name as string | null)?.trim() || "your playlist",
      trackName,
      shortPitch,
      platform,
      streamUrl,
      isWarm,
      priorTrack,
      tone,
      artistName: "Fendi Frost",
    });

    let subject = rendered.subject;
    let pitchBody = rendered.body;
    if (typeof body.override_body === "string" && body.override_body.trim()) {
      pitchBody = body.override_body.trim();
    }
    if (typeof body.override_subject === "string" && body.override_subject.trim()) {
      subject = body.override_subject.trim();
    }

    const recipient = (row.curator_email as string)?.trim() ?? null;
    const lane = String(row.lane ?? "").trim();

    const { data: draft, error: insErr } = await sb.from("outreach_drafts").insert({
      playlist_id: playlistId, track_name: trackName, channel: "email", recipient,
      subject, body: pitchBody,
      generated_by: generatedBy, status: "pending",
      metadata: {
        lane: lane || null,
        why_it_fits: (row.why_it_fits as string | null) ?? null,
        stream_link: streamUrl,
        tone,
        platform,
        is_warm: isWarm,
        prior_track: priorTrack ?? null,
        track_id: trackId,
      },
    }).select("id, channel, subject, body, recipient").single();

    if (insErr) return { status: 500, data: { error: insErr.message } };
    return {
      status: 200,
      data: { ok: true, draft_id: draft.id, channel: draft.channel, subject: draft.subject, body: draft.body, recipient: draft.recipient },
    };
  }

  const rc = row.research_context as Record<string, unknown> | null;
  const isPlacement = isWarmPlacementSource(rc?.source as string | undefined);
  const catalog = await loadCatalogTracks(sb);
  if (!trackName) {
    const pick = pickCatalogTrackForPlacement(row, catalog, catalog[0]?.name ?? "Designed For Me (Control)");
    trackName = pick.track;
  }

  const channel = pickChannel(row, channelOverride);
  if (!channel) return { status: 400, data: { error: "No outreach channel available (email, IG, or submission URL)" } };

  const lanes = await loadLanesConfig(sb);
  const lane = String(row.lane ?? "").trim();
  const pitchAngle = lane ? (lanes[lane]?.pitch_angle ?? "") : "";

  let recipient: string | null = null;
  if (channel === "email") recipient = (row.curator_email as string)?.trim() ?? null;
  else if (channel === "instagram_dm") recipient = (row.curator_instagram as string)?.trim() ?? null;
  else if (channel === "web_form") recipient = (row.submission_url as string)?.trim() ?? null;

  const streamLink = await resolveStreamLink(sb, trackName);
  let subject: string;
  let pitchBody: string;
  let operatorBrief: string | null = null;
  let dmRef: string | null = null;

  if (typeof body.override_body === "string" && body.override_body.trim()) {
    pitchBody = body.override_body.trim();
    subject = typeof body.override_subject === "string" && body.override_subject.trim()
      ? body.override_subject.trim()
      : defaultPlaylistPitchSubject(trackName, String(row.playlist_name ?? ""));
  } else if (isPlacement && channel === "email") {
    const handle = ((row.curator_submission_dm as string) || (row.curator_instagram as string) || "")
      .replace(/^@/, "").trim();
    const roster = handle ? await getRosterEntry(sb, handle) : null;
    const { reason } = pickCatalogTrackForPlacement(row, catalog, trackName);
    dmRef = await nextDmRef(sb);
    const pkg = buildIgOutreachPackage(
      row,
      trackName,
      reason,
      streamLink,
      "thank_and_pitch",
      roster,
      dmRef,
    );
    subject = pkg.email.subject;
    pitchBody = pkg.email.body;
    operatorBrief = pkg.operator_brief;
  } else {
    subject = typeof body.override_subject === "string" && body.override_subject.trim()
      ? body.override_subject.trim()
      : defaultPlaylistPitchSubject(trackName, String(row.playlist_name ?? ""));
    pitchBody = buildPitchBody(row, trackName, pitchAngle, streamLink);
  }

  const { data: draft, error: insErr } = await sb.from("outreach_drafts").insert({
    playlist_id: playlistId, track_name: trackName, channel, recipient,
    subject: channel === "email" ? subject : null, body: pitchBody,
    generated_by: generatedBy, status: "pending",
    metadata: {
      lane: lane || null,
      why_it_fits: (row.why_it_fits as string | null) ?? null,
      stream_link: streamLink || null,
      placement_source: isPlacement ? (rc?.source as string) : null,
      operator_brief: operatorBrief,
      dm_ref: dmRef,
    },
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
  const testMode = Boolean(body.test_mode);
  const batchOverrideCap = Boolean(body.batch_override_cap);
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
  const execRes = await fetch(`${base}/functions/v1/execute-pitch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": hubKey },
    body: JSON.stringify({
      playlist_id: draft.playlist_id,
      track_name: draft.track_name,
      draft_id: draftId,
      test_mode: testMode,
      test_email: typeof body.test_email === "string" ? body.test_email.trim() : undefined,
      batch_override_cap: batchOverrideCap,
    }),
  });
  const execData = await execRes.json().catch(() => ({})) as {
    ok?: boolean;
    action_taken?: string;
    message_to_user?: string;
    cooldown_until?: string | null;
    pitch_log_id?: string | null;
  };
  const execMsg = execData.message_to_user ?? (execData as { error?: string }).error ?? "";
  if (!execRes.ok || !execData.ok || execData.action_taken !== "email_sent") {
    const auditBroken = typeof execMsg === "string" && execMsg.includes("logging failed");
    if (auditBroken) {
      await sb.from("outreach_drafts").update({
        status: "sent_audit_broken",
        sent_at: new Date().toISOString(),
      }).eq("id", draftId);
    }
    return {
      status: execRes.ok ? 422 : execRes.status,
      data: {
        ok: false,
        status: auditBroken ? "sent_audit_broken" : "approved",
        sent: false,
        error: execMsg || `Send failed ${execRes.status}`,
        execute_pitch: execData,
      },
    };
  }

  if (testMode) {
    // Zero state footprint: delete the draft (it was a QA send), skip playlist_targets pitch_status update.
    await sb.from("outreach_drafts").delete().eq("id", draftId);
    return {
      status: 200,
      data: {
        ok: true,
        status: "sent_test",
        sent: true,
        channel: "email",
        cooldown_until: null,
        message: execData.message_to_user,
        pitch_log_id: null,
        test_mode: true,
      },
    };
  }
  const pitchLogId = execData.pitch_log_id ?? null;
  const { data: logRow } = pitchLogId
    ? { data: { id: pitchLogId } }
    : await sb.from("pitch_log").select("id").eq("playlist_id", draft.playlist_id)
      .eq("track_name", draft.track_name).eq("status", "sent").order("pitched_at", { ascending: false }).limit(1).maybeSingle();
  await sb.from("outreach_drafts").update({
    status: "sent",
    sent_at: new Date().toISOString(),
    pitch_log_id: logRow?.id ?? null,
  }).eq("id", draftId);
  await sb.from("playlist_targets").update({ pitch_status: "pitched" }).eq("playlist_id", draft.playlist_id);

  return {
    status: 200,
    data: {
      ok: true,
      status: "sent",
      sent: true,
      channel: "email",
      cooldown_until: execData.cooldown_until ?? null,
      message: execData.message_to_user,
      pitch_log_id: logRow?.id ?? null,
    },
  };
}

type Extracted = { curator_instagram?: string; curator_tiktok?: string; curator_twitter?: string; curator_website?: string; curator_linktree?: string; curator_email?: string };

function extractContacts(text: string): Extracted {
  const out: Extracted = {};
  const ig = text.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-zA-Z0-9._]+)/i);
  if (ig) {
    const handle = extractIgHandle(`https://www.instagram.com/${ig[1]}/`);
    if (handle) out.curator_instagram = handle;
  }
  const tt = text.match(/(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@([a-zA-Z0-9._]+)/i);
  if (tt) out.curator_tiktok = tt[1];
  const tw = text.match(/(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/([a-zA-Z0-9_]+)/i);
  if (tw) out.curator_twitter = tw[1];
  const lt = text.match(/(?:https?:\/\/)?(?:linktr\.ee|beacons\.ai)\/([a-zA-Z0-9._-]+)/i);
  if (lt) out.curator_linktree = lt[0];
  const handle = text.match(/@([a-zA-Z0-9._]{2,30})/);
  if (handle && !out.curator_instagram) {
    const h = sanitizeCuratorIgHandle(handle[1]);
    if (h) out.curator_instagram = h;
  }
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

const ENRICH_POLLITE_MS = 1500;
const ENRICH_PER_CALL_LIMIT = 8;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function enrichFromWebSearch(
  curatorName: string | null,
  playlistName: string | null,
): Promise<{ linktreeUrls: string[]; ig: string | null }> {
  const curator = curatorName?.trim();
  const playlist = playlistName?.trim();
  if (!curator && !playlist) return { linktreeUrls: [], ig: null };
  const query = [curator, playlist, "playlist curator", "linktree instagram contact"].filter(Boolean).join(" ");
  const hits = await firecrawlSearch(query, 5);
  const blob = hits.map((h) => `${h.title ?? ""}\n${h.description ?? ""}\n${h.url}`).join("\n\n");
  let ig: string | null = null;
  for (const h of hits) {
    const fromUrl = extractIgHandle(h.url);
    if (fromUrl && isValidCuratorIgHandle(fromUrl)) {
      ig = fromUrl;
      break;
    }
  }
  if (!ig) {
    const fromBlob = extractIgHandle(blob);
    if (fromBlob && isValidCuratorIgHandle(fromBlob)) ig = fromBlob;
  }
  return { linktreeUrls: extractLinktreeUrls(blob), ig };
}

async function queueInstagramPitch(
  sb: SupabaseClient,
  row: Record<string, unknown>,
  insert: IgQueueInsert | null,
  lane: string | null,
  resultMeta?: Record<string, unknown>,
): Promise<boolean> {
  const playlistId = String(row.playlist_id ?? "");
  if (!insert) {
    const clean = String(
      (row.curator_submission_dm as string) || (row.curator_instagram as string) || "",
    ).replace(/^@/, "").trim();
    if (!isValidCuratorIgHandle(clean)) return false;
    const { data: existing } = await sb.from("social_engagement_queue")
      .select("id")
      .eq("playlist_id", playlistId)
      .eq("platform", "instagram")
      .eq("status", "pending")
      .limit(1)
      .maybeSingle();
    if (existing?.id) return true;
    const { error } = await sb.from("social_engagement_queue").insert({
      platform: "instagram",
      action: "pitch_dm",
      target_url: `https://www.instagram.com/${clean}/`,
      draft_text: typeof resultMeta?.draft_text === "string" ? resultMeta.draft_text : null,
      ig_handle: clean.toLowerCase(),
      playlist_id: playlistId,
      status: "pending",
      result: { lane, source: "enrich_v2", ...resultMeta },
    });
    if (error) {
      console.error("[enrich] queue insert failed:", playlistId, error.message);
      return false;
    }
    return true;
  }
  return queueIgDm(sb, row, { ...insert, meta: { lane, ...insert.meta, ...resultMeta } });
}

export async function runQueueInstagramPitch(
  body: Record<string, unknown>,
  sb: SupabaseClient,
): Promise<RunResult> {
  const playlistId = String(body.playlist_id ?? "").trim();
  const trackName = String(body.track_name ?? "").trim();
  if (!playlistId || !trackName) {
    return { status: 400, data: { error: "playlist_id and track_name required" } };
  }

  const { data: row, error } = await sb.from("playlist_targets").select("*").eq("playlist_id", playlistId).maybeSingle();
  if (error || !row) return { status: 404, data: { error: "Playlist not found" } };

  const rawHandle = (row.curator_submission_dm as string | null)?.trim() ||
    (row.curator_instagram as string | null)?.trim();
  if (!rawHandle || !isValidCuratorIgHandle(rawHandle)) {
    return { status: 400, data: { error: "No valid Instagram handle on this row" } };
  }
  const handle = rawHandle.replace(/^@/, "").trim();

  const lanes = await loadLanesConfig(sb);
  const refs = rowDiscoveryReferences(row, lanes, []);
  if (isArtistIgHandle(handle, refs)) {
    return { status: 400, data: { error: "Curator IG matches a lane reference artist; reject mis-targeted DM" } };
  }
  const lane = String(row.lane ?? "").trim();
  const pitchAngle = lane ? (lanes[lane]?.pitch_angle ?? "") : "";
  const streamLink = await resolveStreamLink(sb, trackName);
  const rc = row.research_context as Record<string, unknown> | null;
  const isPlacement = isWarmPlacementSource(rc?.source as string | undefined);
  const engagementType = ((body.engagement_type as string) || (isPlacement ? "thank_and_pitch" : "cross_pitch")) as
    "thank_you" | "cross_pitch" | "thank_and_pitch";
  const requireMutual = body.require_mutual !== false;

  const queuedToday = await countIgDmsToday(sb);
  if (queuedToday >= IG_DM_DAILY_CAP) {
    return { status: 429, data: { error: `IG DM daily cap (${IG_DM_DAILY_CAP}) reached for today UTC` } };
  }

  if (isPlacement) {
    const { reason } = pickCatalogTrackForPlacement(row, await loadCatalogTracks(sb), trackName);
    const built = await buildIgQueueInsert(
      sb,
      row,
      trackName,
      reason,
      streamLink,
      engagementType,
      requireMutual,
      { source: "spotify_placement" },
    );
    if (!built.ok) {
      return { status: 400, data: { error: built.reason, hint: "Add curator to IG roster with mutual flags" } };
    }
    const queued = await queueIgDm(sb, row, built.insert);
    if (!queued) return { status: 500, data: { error: "Failed to queue DM (duplicate?)" } };
    return {
      status: 200,
      data: {
        ok: true,
        queued: true,
        dm_ref: built.insert.dm_ref,
        target_url: `https://www.instagram.com/${built.insert.ig_handle}/`,
        draft_text: built.insert.draft_text,
        operator_brief: built.insert.operator_brief,
      },
    };
  }

  const draftText = buildPitchBody(row, trackName, pitchAngle, streamLink);
  const queued = await queueInstagramPitch(sb, row, null, lane || null, {
    engagement_type: engagementType,
    source: "manual_queue",
    draft_text: draftText,
  });
  if (!queued) return { status: 500, data: { error: "Failed to queue DM" } };

  return {
    status: 200,
    data: { ok: true, queued: true, target_url: `https://www.instagram.com/${handle.replace(/^@/, "")}/`, draft_text: draftText },
  };
}

export async function runEnrichCuratorContacts(body: Record<string, unknown>, sb: SupabaseClient): Promise<RunResult> {
  if (!Deno.env.get("FIRECRAWL_API_KEY")) {
    return { status: 500, data: { error: "FIRECRAWL_API_KEY not configured" } };
  }

  const playlistIds = Array.isArray(body.playlist_ids) ? body.playlist_ids.map(String).filter(Boolean) : [];
  const trackName = String(body.track_name ?? "").trim();
  const lane = typeof body.lane === "string" ? body.lane.trim() : "";
  const bodyReferences = Array.isArray(body.references) ? body.references.map(String).filter(Boolean) : [];
  const lanesConfig = await loadLanesConfig(sb);
  const offset = Math.max(0, Number(body.offset) || 0);
  const limit = Math.min(12, Math.max(1, Number(body.limit) || ENRICH_PER_CALL_LIMIT));
  const staleBefore = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  // v2 expanded-strategy chain controls
  const includeInactive = Boolean(body.include_inactive);
  const reactivateOnSuccess = Boolean(body.reactivate_on_success);
  const runExpandedStrategies = body.run_expanded_strategies !== false; // default ON
  const expandedOrder: CuratorStrategyName[] =
    Array.isArray(body.expanded_strategies) && body.expanded_strategies.length
      ? (body.expanded_strategies as CuratorStrategyName[])
      : DEFAULT_STRATEGY_ORDER;

  let query = sb
    .from("playlist_targets")
    .select(
      "playlist_id, playlist_name, curator_name, curator_email, curator_instagram, curator_linktree, curator_website, curator_submission_url, curator_submission_dm, research_context, lane, submission_method, contact_confidence, pitch_status, is_active",
    )
    .neq("pitch_status", "disclaim_brand")
    .or("curator_email.is.null,submission_method.is.null")
    .or(`last_enriched_at.is.null,last_enriched_at.lt.${staleBefore}`)
    .order("follower_count", { ascending: false, nullsFirst: false });

  // Default: only active rows. Caller can opt in to inactive (e.g. to re-run the
  // 18 deep-house rows that were soft-deactivated after the prior enrichment
  // sweep surfaced no emails).
  if (!includeInactive) query = query.eq("is_active", true);

  if (playlistIds.length) {
    query = query.in("playlist_id", playlistIds.slice(0, 30));
  } else if (lane) {
    query = query.eq("lane", lane);
  } else if (trackName) {
    if (body.lane) query = query.eq("lane", String(body.lane));
  } else {
    return { status: 400, data: { error: "lane, track_name, or playlist_ids required" } };
  }

  const { data: rows, error } = await query.range(offset, offset + limit - 1);
  if (error) return { status: 500, data: { ok: false, error: error.message } };
  if (!rows?.length) {
    return { status: 200, data: { ok: true, enriched: 0, done: true, fields_added: {}, next_offset: null } };
  }

  const fieldsAdded: Record<string, number> = {
    curator_email: 0,
    curator_instagram: 0,
    curator_website: 0,
    curator_linktree: 0,
    curator_submission_url: 0,
    curator_submission_dm: 0,
    routed_instagram_dm: 0,
  };
  let enriched = 0;
  let reactivated = 0;
  const perRowResults: Array<Record<string, unknown>> = [];

  for (const row of rows) {
    if (!row.playlist_id?.startsWith("spotify:")) continue;

    let spotifyId = row.playlist_id.replace(/^spotify:/, "");
    if (spotifyId.startsWith("sfa:") && row.playlist_name) {
      const rc0 = row.research_context as Record<string, unknown> | null;
      const cached = typeof rc0?.spotify_playlist_id === "string" ? rc0.spotify_playlist_id : "";
      if (cached && !cached.startsWith("37i9dQZF")) {
        spotifyId = cached.replace(/^spotify:/, "");
      } else {
        const stubs = await scrapeSpotifySearchPlaylists(String(row.playlist_name));
        const want = String(row.playlist_name).toLowerCase();
        const hit = stubs.find((s) =>
          s.playlist_id && !s.playlist_id.startsWith("37i9dQZF") &&
          (s.name ?? "").toLowerCase().includes(want.slice(0, Math.min(12, want.length))),
        );
        if (!hit?.playlist_id) continue;
        spotifyId = hit.playlist_id;
      }
    }
    const patch: Record<string, unknown> = {};
    if (row.playlist_id.replace(/^spotify:/, "").startsWith("sfa:") && !spotifyId.startsWith("sfa:")) {
      patch.submission_url = `https://open.spotify.com/playlist/${spotifyId}`;
      patch.research_context = {
        ...(row.research_context as Record<string, unknown> ?? {}),
        spotify_playlist_id: spotifyId,
      };
    }
    let bestConfidence = Number((row as { contact_confidence?: number }).contact_confidence ?? 0) || 0;
    const recordConfidence = (c: number) => {
      if (c > bestConfidence) bestConfidence = c;
    };

    try {
      if ((row as { pitch_status?: string }).pitch_status === "disclaim_brand") continue;

      const detail = await scrapeSpotifyPlaylistDetail(spotifyId);
      if (!detail) continue;

      const rowRefs = rowDiscoveryReferences(row, lanesConfig, bodyReferences);

      if (row.curator_instagram) {
        const stored = String(row.curator_instagram).replace(/^@/, "");
        if (!isValidCuratorIgHandle(stored) || isArtistIgHandle(stored, rowRefs)) {
          patch.curator_instagram = null;
        }
      }

      const playlistHaystack = [detail.description ?? "", detail.name ?? ""].join("\n");
      const linktreeSeen = new Set<string>(
        row.curator_linktree ? [String(row.curator_linktree)] : [],
      );
      const addLinktrees = (urls: string[]) => {
        for (const u of urls) {
          if (!linktreeSeen.has(u)) linktreeSeen.add(u);
        }
      };
      addLinktrees(extractLinktreeUrls(playlistHaystack));

      if (!row.curator_email && !patch.curator_email) {
        const fromPl = extractEmails(playlistHaystack);
        if (fromPl.length) {
          patch.curator_email = fromPl[0].value;
          fieldsAdded.curator_email++;
          recordConfidence(confidenceForEmailSource(fromPl[0].source));
        }
      }

      tryAssignCuratorInstagram(patch, row, extractIgHandle(playlistHaystack), rowRefs, fieldsAdded);

      let profile: Awaited<ReturnType<typeof scrapeSpotifyUserProfile>> = null;
      if (detail.owner_id) {
        profile = await scrapeSpotifyUserProfile(detail.owner_id);
        await sleep(ENRICH_POLLITE_MS);
      }

      if (profile) {
        const bioLinks = profileCuratorBioLinks(profile);
        const bioText = [profile.bio ?? "", bioLinks.join("\n")].join("\n");
        addLinktrees(extractLinktreeUrls(bioText));

        if (!row.curator_email && !patch.curator_email && profile.bio) {
          const found = extractEmails(profile.bio);
          if (found.length) {
            patch.curator_email = found[0].value;
            fieldsAdded.curator_email++;
            recordConfidence(9);
          }
        }

        for (const link of bioLinks) {
          if (tryAssignCuratorInstagram(patch, row, extractIgHandle(link), rowRefs, fieldsAdded)) break;
          if (/^https?:\/\//i.test(link) && !extractIgHandle(link) && !patch.curator_website && !row.curator_website) {
            if (!/tiktok|twitter|x\.com|open\.spotify|linktr\.ee|beacons\.ai|lnk\.bio/i.test(link)) {
              patch.curator_website = link;
              fieldsAdded.curator_website++;
            }
          }
        }
      }

      const needsWebSearch = !patch.curator_email && !row.curator_email &&
        linktreeSeen.size === 0 && !patch.curator_instagram && !row.curator_instagram;
      if (needsWebSearch) {
        try {
          const ws = await enrichFromWebSearch(
            detail.owner_name ?? (row as { curator_name?: string }).curator_name ?? null,
            detail.name ?? (row as { playlist_name?: string }).playlist_name ?? null,
          );
          addLinktrees(ws.linktreeUrls);
          tryAssignCuratorInstagram(patch, row, ws.ig, rowRefs, fieldsAdded);
          await sleep(ENRICH_POLLITE_MS);
        } catch (e) {
          console.error(`[enrich] web search failed for ${row.playlist_id}:`, errMsg(e));
        }
      }

      const linktreeUrls = [...linktreeSeen];
      if (linktreeUrls[0] && !patch.curator_linktree && !row.curator_linktree) {
        patch.curator_linktree = linktreeUrls[0];
        fieldsAdded.curator_linktree++;
      }

      const linktreeUrl = (patch.curator_linktree as string) || row.curator_linktree;
      if (linktreeUrl && !patch.curator_email && !row.curator_email) {
        try {
          const lt = await firecrawl(linktreeUrl, { formats: ["markdown", "html"], waitFor: 2000 });
          const md = lt.data.markdown;
          const html = lt.data.html;
          if (isDisclaimBrand(`${md}\n${html}`)) {
            patch.pitch_status = "disclaim_brand";
            patch.submission_method = "none";
            patch.last_enriched_at = new Date().toISOString();
            await sb.from("playlist_targets").update(patch).eq("playlist_id", row.playlist_id);
            enriched++;
            continue;
          }
          const found = extractEmails(md, html);
          if (found.length) {
            patch.curator_email = found[0].value;
            fieldsAdded.curator_email++;
            recordConfidence(confidenceForEmailSource(found[0].source));
          }
          const subLink = extractSubmissionLinkFromMarkdown(md);
          if (subLink && !patch.curator_submission_url) {
            patch.curator_submission_url = subLink;
            fieldsAdded.curator_submission_url++;
          }
          tryAssignCuratorInstagram(patch, row, extractIgHandle(md) || extractIgHandle(html), rowRefs, fieldsAdded);
          await sleep(ENRICH_POLLITE_MS);
        } catch (e) {
          console.error(`[enrich] linktree ${linktreeUrl} failed:`, errMsg(e));
        }
      }

      const igRaw = (patch.curator_instagram as string) || row.curator_instagram || "";
      const igHandle = isValidCuratorIgHandle(igRaw) ? igRaw.replace(/^@/, "") : "";
      if (igHandle && !patch.curator_email && !row.curator_email) {
        try {
          const ig = await firecrawl(`https://www.instagram.com/${igHandle}/`, {
            formats: ["markdown", "html"],
            waitFor: 2000,
          });
          const md = ig.data.markdown;
          const html = ig.data.html;
          const found = extractEmails(md, html);
          if (found.length) {
            patch.curator_email = found[0].value;
            fieldsAdded.curator_email++;
            recordConfidence(confidenceForEmailSource(found[0].source));
          }
          const dm = extractSubmissionDM(md);
          if (dm && !patch.curator_submission_dm) {
            patch.curator_submission_dm = dm;
            fieldsAdded.curator_submission_dm++;
          }
          const note = extractSubmissionNote(md);
          if (note) patch.curator_submission_note = note;
          await sleep(ENRICH_POLLITE_MS);
        } catch (e) {
          console.error(`[enrich] IG ${igHandle} failed:`, errMsg(e));
        }
      }

      const hunterKey = Deno.env.get("HUNTER_API_KEY");
      const website = (patch.curator_website as string) || row.curator_website;
      if (!patch.curator_email && !row.curator_email && hunterKey && website) {
        try {
          const domain = new URL(website.startsWith("http") ? website : `https://${website}`).hostname.replace(/^www\./, "");
          const r = await fetch(
            `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=5&api_key=${hunterKey}`,
          );
          const j = await r.json();
          const emails = (j?.data?.emails ?? []) as Array<{ value: string; confidence?: number; type?: string; first_name?: string }>;
          const ranked = emails
            .map((e) => ({ ...e, score: scoreHunterEmail(e) }))
            .sort((a, b) => (b.score - a.score) || ((b.confidence ?? 0) - (a.confidence ?? 0)));
          if (ranked[0] && (ranked[0].confidence ?? 0) >= 50) {
            patch.curator_email = ranked[0].value.toLowerCase();
            fieldsAdded.curator_email++;
            recordConfidence(3);
          }
        } catch (e) {
          console.error(`[enrich] hunter for ${website} failed:`, errMsg(e));
        }
      }

      const websiteForDisclaim = (patch.curator_website as string) || row.curator_website;
      if (!patch.pitch_status && websiteForDisclaim && !patch.curator_email && !row.curator_email) {
        try {
          const w = await firecrawl(
            websiteForDisclaim.startsWith("http") ? websiteForDisclaim : `https://${websiteForDisclaim}`,
            { formats: ["markdown", "html"], waitFor: 2000 },
          );
          if (isDisclaimBrand(`${w.data.markdown}\n${w.data.html}`)) {
            patch.pitch_status = "disclaim_brand";
            patch.submission_method = "none";
            patch.last_enriched_at = new Date().toISOString();
            await sb.from("playlist_targets").update(patch).eq("playlist_id", row.playlist_id);
            enriched++;
            continue;
          }
          await sleep(ENRICH_POLLITE_MS);
        } catch (e) {
          console.error(`[enrich] website disclaim ${websiteForDisclaim} failed:`, errMsg(e));
        }
      }

      // ---- v2 expanded discovery chain ---------------------------------
      // The existing pipeline above is the well-trodden Spotify→Linktree→IG
      // path. It works when curators expose contact info on those surfaces.
      // For curators that don't (the dominant case for independent
      // deep-house playlists), we now run a wider strategy chain that probes
      // Twitter/X, personal websites with /contact /submit /about, other
      // playlists by the same creator, the Wayback Machine, free-read
      // submission-aggregator profiles, Substack/beehiiv newsletters, and
      // does targeted Google-style dorking via firecrawl search.
      //
      // The chain short-circuits on the first plausible verified email. It
      // never adds a paid dependency — Firecrawl is the only outbound, and
      // it was already on the stack. LinkedIn and Hunter.io are explicitly
      // omitted (per the project's standing direction).
      let expandedHit:
        | { email: string; source: string; source_url?: string; confidence: number }
        | null = null;
      let expandedAttempts: CuratorAttemptLog[] = [];
      let expandedDiscoveredUrls: string[] = [];
      let expandedDiscoveredHandles: Record<string, string> = {};
      const emailBeforeExpanded = (patch.curator_email as string | undefined) ?? row.curator_email ?? null;

      if (runExpandedStrategies && !emailBeforeExpanded) {
        try {
          const expCtx = newCuratorContext(row as CuratorRow);
          expandedHit = await runCuratorStrategyChain(expCtx, expandedOrder);
          expandedAttempts = expCtx.attempts;
          expandedDiscoveredUrls = [...expCtx.discoveredUrls].slice(0, 30);
          expandedDiscoveredHandles = Object.fromEntries(expCtx.discoveredHandles.entries());
        } catch (e) {
          console.error(`[enrich] expanded chain ${row.playlist_id} failed:`, errMsg(e));
        }
        if (expandedHit) {
          patch.curator_email = expandedHit.email;
          fieldsAdded.curator_email++;
          recordConfidence(expandedHit.confidence);
        }
      }

      const finalEmail = (patch.curator_email as string) ?? row.curator_email ?? null;
      const finalIgRaw = (patch.curator_instagram as string) ?? row.curator_instagram ?? null;
      let finalIg = finalIgRaw && isValidCuratorIgHandle(finalIgRaw) ? finalIgRaw.replace(/^@/, "") : null;
      if (finalIg && isArtistIgHandle(finalIg, rowRefs)) finalIg = null;
      if (finalIgRaw && !finalIg) patch.curator_instagram = null;
      const finalSubUrl = (patch.curator_submission_url as string) ?? row.curator_submission_url ?? null;
      const finalSubDm = (patch.curator_submission_dm as string) ?? row.curator_submission_dm ?? null;

      if (finalEmail) {
        patch.submission_method = "email";
      } else if (finalSubUrl) {
        patch.submission_method = "web_form";
        patch.curator_submission_url = finalSubUrl;
        patch.submission_url = finalSubUrl;
      } else if (finalSubDm || finalIg) {
        patch.submission_method = "instagram_dm";
        const handle = finalSubDm || `@${String(finalIg).replace(/^@/, "")}`;
        if (await queueInstagramPitch(sb, row as Record<string, unknown>, null, row.lane, { routed_handle: handle })) {
          fieldsAdded.routed_instagram_dm++;
          recordConfidence(Math.max(bestConfidence, 4));
        }
      } else {
        patch.submission_method = "none";
      }

      // Reactivate when the caller asks for it AND we landed a verified email
      // on a row that was previously soft-deactivated.
      let reactivatedThisRow = false;
      if (reactivateOnSuccess && finalEmail && (row as { is_active?: boolean }).is_active === false) {
        patch.is_active = true;
        reactivatedThisRow = true;
      }

      patch.contact_confidence = bestConfidence;
      patch.last_enriched_at = new Date().toISOString();

      // Audit: record what the expanded chain tried into research_context so
      // we have a per-row trail of "we ran X, Y, Z and they all returned
      // nothing" without polluting the schema with a new column.
      if (runExpandedStrategies) {
        const existingCtx = (row.research_context as Record<string, unknown> | null) ?? {};
        patch.research_context = {
          ...(typeof patch.research_context === "object" && patch.research_context !== null
            ? patch.research_context as Record<string, unknown>
            : existingCtx),
          curator_strategy_audit: {
            ran_at: patch.last_enriched_at,
            order: expandedOrder,
            attempts: expandedAttempts,
            result: expandedHit
              ? { hit: true, source: expandedHit.source, confidence: expandedHit.confidence, source_url: expandedHit.source_url }
              : { hit: false },
            discovered_handles: expandedDiscoveredHandles,
            discovered_urls: expandedDiscoveredUrls,
            reactivated: reactivatedThisRow,
          },
        };
      }

      const { error: upErr } = await sb.from("playlist_targets").update(patch).eq("playlist_id", row.playlist_id);
      if (!upErr) {
        enriched++;
        if (reactivatedThisRow) reactivated++;
        perRowResults.push({
          playlist_id: row.playlist_id,
          playlist_name: row.playlist_name,
          email: finalEmail ?? null,
          source: expandedHit?.source ?? (finalEmail ? "existing_pipeline" : null),
          source_url: expandedHit?.source_url ?? null,
          confidence: bestConfidence || null,
          reactivated: reactivatedThisRow,
          attempts: expandedAttempts,
        });
      }
    } catch (e) {
      console.error(`[enrich] ${row.playlist_id} failed:`, errMsg(e));
    }
  }

  const nextOffset = offset + rows.length;
  const done = rows.length < limit;

  return {
    status: 200,
    data: {
      ok: true,
      enriched,
      reactivated,
      done,
      next_offset: done ? null : nextOffset,
      fields_added: fieldsAdded,
      results: perRowResults,
    },
  };
}

export async function runReconcileLaneTargets(
  body: Record<string, unknown>,
  sb: SupabaseClient,
): Promise<RunResult> {
  const laneFilter = typeof body.lane === "string" ? body.lane.trim() : "";
  const dryRun = Boolean(body.dry_run);
  const lanesConfig = await loadLanesConfig(sb);

  let q = sb.from("playlist_targets")
    .select("playlist_id, playlist_name, curator_name, curator_instagram, lane, vibe_tags, similar_artists, platform, research_context")
    .eq("is_active", true);
  if (laneFilter) q = q.eq("lane", laneFilter);

  const { data: rows, error } = await q.limit(500);
  if (error) return { status: 500, data: { ok: false, error: error.message } };

  const deactivated: { playlist_id: string; reason: string }[] = [];

  for (const row of rows ?? []) {
    const lane = String(row.lane ?? "").trim();
    if (!lane) continue;

    const refs = rowDiscoveryReferences(row, lanesConfig, []);
    const laneRe = laneRegexBoost(lanesConfig, lane);
    let reason: string | null = null;

    if (isLaneGenreMismatch(lane, row.playlist_name, row.curator_name)) {
      reason = "genre_mismatch";
    } else if (!rowMatchesLane(row, lane, laneRe, refs)) {
      reason = "lane_mismatch";
    } else if (isSpotifyOwnedCurator(row.curator_name, row.playlist_name, row.playlist_id)) {
      reason = "spotify_owned";
    } else if (isArtistAsCurator(row.curator_name, refs)) {
      reason = "artist_as_curator";
    } else if (row.curator_instagram && isArtistIgHandle(String(row.curator_instagram), refs)) {
      reason = "artist_ig_handle";
    } else if ((row.platform as string) === "youtube" && lane === "deep_house_groove") {
      reason = "platform_lane_mismatch";
    }

    if (!reason) continue;
    deactivated.push({ playlist_id: row.playlist_id, reason });

    if (!dryRun) {
      await sb.from("playlist_targets").update({
        is_active: false,
        pitch_status: `reconcile_${reason}`,
        lane: null,
        why_it_fits: null,
        recommended_pitch_angle: null,
        submission_method: "none",
      }).eq("playlist_id", row.playlist_id);
    }
  }

  return {
    status: 200,
    data: {
      ok: true,
      dry_run: dryRun,
      scanned: rows?.length ?? 0,
      deactivated_count: deactivated.length,
      deactivated: deactivated.slice(0, 50),
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
      "playlist_id, playlist_name, curator_name, curator_email, curator_instagram, curator_linktree, curator_submission_url, curator_submission_dm, curator_submission_note, lane, tier, authenticity_score, fraud_verdict, contact_confidence, pitch_status, follower_count, is_active, why_it_fits, recommended_pitch_angle, submission_url, submission_method, last_enriched_at, research_context",
    ).eq("is_active", true).order("follower_count", { ascending: false, nullsFirst: false }).limit(200);
    if (body.lane) q = q.eq("lane", String(body.lane));
    if (body.tier != null && body.tier !== "") q = q.eq("tier", Number(body.tier));
    if (body.fraud_verdict) q = q.eq("fraud_verdict", String(body.fraud_verdict));
    if (body.has_email) q = q.not("curator_email", "is", null);
    if (body.pitchable_only) q = q.in("submission_method", ["email", "instagram_dm"]);
    if (body.placement_only) {
      q = q.or("research_context->>source.eq.spotify_placement,research_context->>source.eq.spotify_for_artists_csv");
    }
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
  if (action === "activate_target") {
    const playlistId = String(body.playlist_id ?? "").trim();
    if (!playlistId) return { status: 400, data: { error: "playlist_id required" } };
    const { error } = await sb.from("playlist_targets").update({ is_active: true }).eq("playlist_id", playlistId);
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true } };
  }
  if (action === "patch_target") {
    const playlistId = String(body.playlist_id ?? "").trim();
    if (!playlistId) return { status: 400, data: { error: "playlist_id required" } };
    const { data: existingRow } = await sb.from("playlist_targets")
      .select("lane, research_context, similar_artists, curator_instagram")
      .eq("playlist_id", playlistId)
      .maybeSingle();
    const lanesForPatch = await loadLanesConfig(sb);
    const patchRefs = existingRow ? rowDiscoveryReferences(existingRow, lanesForPatch, []) : [];
    const patch: Record<string, unknown> = {};
    if (body.curator_email !== undefined) {
      const em = String(body.curator_email ?? "").trim();
      patch.curator_email = em || null;
      if (em) {
        patch.contact_confidence = 9;
        patch.submission_method = "email";
      }
    }
    if (body.curator_instagram !== undefined) {
      const raw = String(body.curator_instagram ?? "").trim();
      const sanitized = raw ? sanitizeCuratorIgHandle(raw) : null;
      if (raw && !sanitized) {
        return { status: 400, data: { error: "Invalid Instagram handle (corporate/chrome or domain-shaped handles rejected)" } };
      }
      if (sanitized && isArtistIgHandle(sanitized, patchRefs)) {
        return { status: 400, data: { error: "Curator IG matches a lane reference artist; reject mis-targeted DM" } };
      }
      patch.curator_instagram = sanitized;
    }
    if (body.lane !== undefined) patch.lane = String(body.lane ?? "").trim() || null;
    if (body.submission_url !== undefined) {
      patch.submission_url = String(body.submission_url ?? "").trim() || null;
    }
    if (!Object.keys(patch).length) return { status: 400, data: { error: "Nothing to patch (curator_email, curator_instagram, lane, submission_url)" } };
    const { error } = await sb.from("playlist_targets").update(patch).eq("playlist_id", playlistId);
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true, playlist_id: playlistId, patched: Object.keys(patch) } };
  }
  if (action === "list_social_queue") {
    const limit = Math.min(50, Math.max(1, Number(body.limit) || 30));
    const status = String(body.status ?? "pending").trim() || "pending";
    let q = sb.from("social_engagement_queue")
      .select("id, platform, action, target_url, draft_text, operator_brief, dm_ref, ig_handle, playlist_id, status, created_at, result")
      .eq("platform", "instagram")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (status !== "all") q = q.eq("status", status);
    const { data, error } = await q;
    if (error) return { status: 500, data: { error: error.message } };
    const queuedToday = await countIgDmsToday(sb);
    return {
      status: 200,
      data: {
        ok: true,
        rows: data ?? [],
        ig_dm_cap: IG_DM_DAILY_CAP,
        ig_dm_queued_today: queuedToday,
        ig_dm_remaining: Math.max(0, IG_DM_DAILY_CAP - queuedToday),
      },
    };
  }
  if (action === "mark_social_queue_sent") {
    const id = String(body.queue_id ?? "").trim();
    if (!id) return { status: 400, data: { error: "queue_id required" } };
    const { error } = await sb.from("social_engagement_queue").update({
      status: "sent",
      performed_at: new Date().toISOString(),
      performed_by: String(body.performed_by ?? "admin:ui"),
    }).eq("id", id);
    if (error) return { status: 500, data: { error: error.message } };
    const { data: item } = await sb.from("social_engagement_queue").select("playlist_id").eq("id", id).maybeSingle();
    if (item?.playlist_id) {
      await sb.from("playlist_targets").update({
        pitch_status: "pitched",
        last_contact_at: new Date().toISOString(),
      }).eq("playlist_id", item.playlist_id);
    }
    return { status: 200, data: { ok: true } };
  }
  if (action === "get_pitch_log") {
    const limit = Math.min(50, Math.max(1, Number(body.limit) || 10));
    const trackName = String(body.track_name ?? "").trim();
    let q = sb.from("pitch_log").select("*").order("created_at", { ascending: false }).limit(limit);
    if (trackName) q = q.ilike("track_name", `%${trackName}%`);
    const { data, error } = await q;
    if (error) return { status: 500, data: { error: error.message } };
    const since24h = new Date(Date.now() - 86400000).toISOString();
    const { count: email24 } = await sb.from("pitch_log").select("*", { count: "exact", head: true })
      .gte("sent_at", since24h);
    return {
      status: 200,
      data: {
        ok: true,
        rows: data ?? [],
        summary: { email_pitches_last_24h: email24 ?? 0 },
      },
    };
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
    if (body.status !== undefined) patch.status = body.status;
    const { error } = await sb.from("outreach_drafts").update(patch).eq("id", draftId);
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true } };
  }
  if (action === "delete_draft") {
    const draftId = String(body.draft_id ?? "").trim();
    if (!draftId) return { status: 400, data: { error: "draft_id required" } };
    const { error } = await sb.from("outreach_drafts").delete().eq("id", draftId);
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true, draft_id: draftId } };
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

export async function runSendTelegramCampaignProxy(
  body: Record<string, unknown>,
  hubKey: string,
): Promise<RunResult> {
  return proxyToEdgeFunction("telegram-send-campaign", body, hubKey);
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
  "list_targets", "list_drafts", "update_draft", "delete_draft", "deactivate_target", "activate_target", "patch_target", "get_pitch_log",
  "run_playlist_research", "send_campaign", "send_telegram_campaign",
  "connect_spotify_init", "connect_spotify_status",
  "queue_instagram_pitch",
  "reconcile_lane_targets",
  "list_social_queue", "mark_social_queue_sent",
  "discover_spotify_placements", "queue_ig_outreach_batch",
  "import_spotify_for_artists_csv",
  "list_ig_roster", "patch_ig_roster", "import_ig_roster", "sync_ig_roster_from_targets",
  "list_tracks", "upsert_track", "delete_track",
  "list_categories", "upsert_category", "delete_category",
  "set_track_categories", "set_playlist_categories",
  "recommend_targets_for_track", "list_warm_curators",
  "mark_pitch_response", "pitch_stats_summary", "list_pitches",
]);

export async function runCatalogueAdmin(body: Record<string, unknown>, sb: SupabaseClient): Promise<RunResult> {
  const action = String(body.action ?? "").trim();

  if (action === "list_tracks") {
    const { data: tracks } = await sb.from("tracks")
      .select("*, track_categories(category_id, categories(id, slug, label, family))")
      .order("updated_at", { ascending: false });
    return { status: 200, data: { ok: true, rows: tracks ?? [] } };
  }

  if (action === "list_categories") {
    const { data } = await sb.from("categories").select("*").order("family").order("label");
    return { status: 200, data: { ok: true, rows: data ?? [] } };
  }

  if (action === "upsert_category") {
    const slug = String(body.slug ?? "").trim();
    const label = String(body.label ?? "").trim();
    if (!slug || !label) return { status: 400, data: { error: "slug and label required" } };
    const family = (["genre", "vibe", "mood"].includes(String(body.family)) ? String(body.family) : "genre");
    const { data, error } = await sb.from("categories").upsert(
      { slug, label, family, description: body.description ?? null },
      { onConflict: "slug" },
    ).select().single();
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true, category: data } };
  }

  if (action === "delete_category") {
    const id = String(body.id ?? "").trim();
    if (!id) return { status: 400, data: { error: "id required" } };
    const { error } = await sb.from("categories").delete().eq("id", id);
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true } };
  }

  if (action === "upsert_track") {
    const id = body.id ? String(body.id) : null;
    const fields: Record<string, unknown> = {
      name: String(body.name ?? "").trim(),
      isrc: body.isrc ? String(body.isrc).trim() : null,
      spotify_url: body.spotify_url ? String(body.spotify_url).trim() : null,
      apple_music_url: body.apple_music_url ? String(body.apple_music_url).trim() : null,
      soundcloud_url: body.soundcloud_url ? String(body.soundcloud_url).trim() : null,
      status: ["active", "archived", "unreleased"].includes(String(body.status)) ? String(body.status) : "active",
      release_date: body.release_date ?? null,
      default_tone: VALID_TONES.has(String(body.default_tone)) ? String(body.default_tone) : "warm_personal",
      short_pitch: body.short_pitch ?? null,
      pitch_angle: body.pitch_angle ?? null,
      reference_artists: Array.isArray(body.reference_artists) ? body.reference_artists.map(String) : [],
      notes: body.notes ?? null,
      updated_at: new Date().toISOString(),
    };
    if (!fields.name) return { status: 400, data: { error: "name required" } };
    let track;
    if (id) {
      const { data, error } = await sb.from("tracks").update(fields).eq("id", id).select().single();
      if (error) return { status: 500, data: { error: error.message } };
      track = data;
    } else {
      const { data, error } = await sb.from("tracks").insert(fields).select().single();
      if (error) return { status: 500, data: { error: error.message } };
      track = data;
    }
    if (Array.isArray(body.category_ids)) {
      const ids = body.category_ids.slice(0, 5).map(String);
      await sb.from("track_categories").delete().eq("track_id", track.id);
      if (ids.length) {
        await sb.from("track_categories").insert(ids.map((cid) => ({ track_id: track.id, category_id: cid })));
      }
    }
    return { status: 200, data: { ok: true, track } };
  }

  if (action === "delete_track") {
    const id = String(body.id ?? "").trim();
    if (!id) return { status: 400, data: { error: "id required" } };
    const { error } = await sb.from("tracks").delete().eq("id", id);
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true } };
  }

  if (action === "set_track_categories") {
    const trackId = String(body.track_id ?? "").trim();
    if (!trackId) return { status: 400, data: { error: "track_id required" } };
    const ids = Array.isArray(body.category_ids) ? body.category_ids.slice(0, 5).map(String) : [];
    await sb.from("track_categories").delete().eq("track_id", trackId);
    if (ids.length) {
      const { error } = await sb.from("track_categories").insert(ids.map((cid) => ({ track_id: trackId, category_id: cid })));
      if (error) return { status: 500, data: { error: error.message } };
    }
    return { status: 200, data: { ok: true } };
  }

  if (action === "set_playlist_categories") {
    const pid = String(body.playlist_id ?? "").trim();
    if (!pid) return { status: 400, data: { error: "playlist_id required" } };
    const ids = Array.isArray(body.category_ids) ? body.category_ids.slice(0, 5).map(String) : [];
    await sb.from("playlist_categories").delete().eq("playlist_id", pid);
    if (ids.length) {
      const { error } = await sb.from("playlist_categories").insert(ids.map((cid) => ({ playlist_id: pid, category_id: cid })));
      if (error) return { status: 500, data: { error: error.message } };
    }
    return { status: 200, data: { ok: true } };
  }

  if (action === "recommend_targets_for_track") {
    const trackId = String(body.track_id ?? "").trim();
    if (!trackId) return { status: 400, data: { error: "track_id required" } };
    const mode = String(body.mode ?? "warm_aligned");
    const limit = Math.min(200, Math.max(1, Number(body.limit) || 50));

    const { data: track } = await sb.from("tracks").select("*, track_categories(category_id)").eq("id", trackId).single();
    if (!track) return { status: 404, data: { error: "Track not found" } };
    const trackCatIds = (track.track_categories ?? []).map((tc: { category_id: string }) => tc.category_id);

    const availablePlatforms: string[] = [];
    if (track.spotify_url) availablePlatforms.push("spotify");
    if (track.apple_music_url) availablePlatforms.push("apple_music");
    if (track.soundcloud_url) availablePlatforms.push("soundcloud");
    if (availablePlatforms.length === 0) return { status: 400, data: { error: "Track has no streaming URL on any platform" } };

    const { data: placedLog } = await sb.from("pitch_log")
      .select("playlist_id, track_name")
      .or("placed.eq.true,placement_status.eq.placed");
    const warmPids = new Set((placedLog ?? []).map((r: { playlist_id: string }) => r.playlist_id));

    const { data: targets } = await sb.from("playlist_targets")
      .select("*, playlist_categories(category_id)")
      .eq("is_active", true)
      .in("platform", availablePlatforms)
      .limit(500);
    const rows = targets ?? [];

    type Scored = { row: Record<string, unknown>; overlap: number; warm: boolean; tier: number; followers: number };
    const scored: Scored[] = rows.map((r: Record<string, unknown>) => {
      const pcs = (r.playlist_categories ?? []) as { category_id: string }[];
      const overlap = pcs.filter((pc) => trackCatIds.includes(pc.category_id)).length;
      return {
        row: r,
        overlap,
        warm: warmPids.has(r.playlist_id as string),
        tier: Number(r.tier ?? 99),
        followers: Number(r.follower_count ?? 0),
      };
    });

    let filtered: Scored[];
    if (mode === "warm_aligned") {
      filtered = scored.filter((s) => s.warm && s.overlap > 0);
    } else if (mode === "new_cold") {
      // Exclude already-pitched rows and inactive rows
      filtered = scored.filter((s) =>
        !s.warm && s.overlap > 0 &&
        (s.row.pitch_status !== "pitched") &&
        (s.row.is_active !== false)
      );
    } else if (mode === "all_warm") {
      filtered = scored.filter((s) => s.warm);
    } else {
      return { status: 400, data: { error: "mode must be warm_aligned | new_cold | all_warm" } };
    }

    filtered.sort((a, b) => (b.overlap - a.overlap) || (a.tier - b.tier) || (b.followers - a.followers));
    return {
      status: 200,
      data: {
        ok: true,
        mode,
        track_id: trackId,
        available_platforms: availablePlatforms,
        rows: filtered.slice(0, limit).map((s) => ({ ...s.row, _overlap: s.overlap, _warm: s.warm })),
      },
    };
  }

  if (action === "list_warm_curators") {
    const { data: log } = await sb.from("pitch_log")
      .select("playlist_id, track_name, pitched_at")
      .or("placed.eq.true,placement_status.eq.placed")
      .order("pitched_at", { ascending: false });
    const byPid = new Map<string, { last_placed_track: string; last_placed_at: string }>();
    for (const r of log ?? []) {
      if (!byPid.has(r.playlist_id)) {
        byPid.set(r.playlist_id, { last_placed_track: r.track_name, last_placed_at: r.pitched_at });
      }
    }
    const pids = Array.from(byPid.keys());
    if (pids.length === 0) return { status: 200, data: { ok: true, rows: [] } };
    const { data: targets } = await sb.from("playlist_targets")
      .select("*, playlist_categories(category_id)")
      .in("playlist_id", pids);
    const rows = (targets ?? []).map((r: Record<string, unknown>) => ({
      ...r,
      ...byPid.get(r.playlist_id as string),
    }));
    return { status: 200, data: { ok: true, rows } };
  }

  if (action === "mark_pitch_response") {
    const id = String(body.pitch_log_id ?? body.id ?? "").trim();
    if (!id) return { status: 400, data: { error: "pitch_log_id required" } };
    const patch: Record<string, unknown> = {};
    if (typeof body.reply_received === "boolean") patch.reply_received = body.reply_received;
    if (typeof body.placed === "boolean") patch.placed = body.placed;
    if (typeof body.placement_status === "string") patch.placement_status = body.placement_status.trim() || null;
    if (typeof body.response_notes === "string") patch.response_notes = body.response_notes.trim() || null;
    if (typeof body.follow_up_at === "string") patch.follow_up_at = body.follow_up_at;
    if (!Object.keys(patch).length) return { status: 400, data: { error: "Nothing to update (reply_received | placed | placement_status | response_notes | follow_up_at)" } };
    const { data, error } = await sb.from("pitch_log").update(patch).eq("id", id).select().single();
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true, row: data } };
  }

  if (action === "pitch_stats_summary") {
    const trackName = String(body.track_name ?? "").trim();
    let base = sb.from("pitch_log").select("status, reply_received, placed, placement_status, sent_at, method, playlist_id, track_name");
    if (trackName) base = base.ilike("track_name", `%${trackName}%`);
    const { data: all, error } = await base;
    if (error) return { status: 500, data: { error: error.message } };
    const rows = all ?? [];
    const sent = rows.filter((r) => r.status === "sent").length;
    const replied = rows.filter((r) => r.reply_received === true).length;
    const placed = rows.filter((r) => r.placed === true || r.placement_status === "placed").length;
    const errored = rows.filter((r) => r.status === "error").length;
    const pending = rows.filter((r) => r.status === "sent" && !r.reply_received && !r.placed).length;
    const now = Date.now();
    const since24h = rows.filter((r) => r.sent_at && new Date(r.sent_at).getTime() > now - 86400000).length;
    const since7d = rows.filter((r) => r.sent_at && new Date(r.sent_at).getTime() > now - 7 * 86400000).length;
    const replyRate = sent > 0 ? Math.round((replied / sent) * 1000) / 10 : 0;
    const placementRate = sent > 0 ? Math.round((placed / sent) * 1000) / 10 : 0;
    return {
      status: 200,
      data: {
        ok: true,
        track_name: trackName || null,
        totals: {
          sent, replied, placed, errored, pending,
          sent_last_24h: since24h,
          sent_last_7d: since7d,
          reply_rate_pct: replyRate,
          placement_rate_pct: placementRate,
        },
      },
    };
  }

  if (action === "list_pitches") {
    const limit = Math.min(200, Math.max(1, Number(body.limit) || 50));
    const trackName = String(body.track_name ?? "").trim();
    const statusFilter = String(body.status ?? "").trim();
    const onlyPending = Boolean(body.only_pending_response);
    let q = sb.from("pitch_log").select("*").order("sent_at", { ascending: false }).limit(limit);
    if (trackName) q = q.ilike("track_name", `%${trackName}%`);
    if (statusFilter) q = q.eq("status", statusFilter);
    if (onlyPending) q = q.eq("status", "sent").eq("reply_received", false).eq("placed", false);
    const { data, error } = await q;
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true, rows: data ?? [] } };
  }

  return { status: 400, data: { error: `Unknown catalogue action: ${action}` } };
}

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
    case "delete_draft":
    case "deactivate_target":
    case "activate_target":
    case "patch_target":
    case "get_pitch_log":
      return runPlaylistAdmin({ ...body, action }, sb);
    case "run_playlist_research":
      return runPlaylistResearchProxy(body, hubKey);
    case "send_campaign":
      return runSendCampaignProxy(body, hubKey);
    case "send_telegram_campaign":
      return runSendTelegramCampaignProxy(body, hubKey);
    case "discover_spotify_placements":
      try {
        const trackName = String(body.track_name ?? "").trim();
        const trackNames = Array.isArray(body.track_names)
          ? body.track_names.map(String).filter(Boolean)
          : trackName ? [trackName] : undefined;
        const result = await discoverSpotifyPlacements(sb, {
          lane: String(body.lane ?? "").trim(),
          references: Array.isArray(body.references) ? body.references.map(String) : [],
          track_names: trackNames,
          quick: Boolean(body.quick),
        });
        return { status: 200, data: { ok: true, ...result } };
      } catch (e) {
        return { status: 500, data: { error: errMsg(e) } };
      }
    case "import_spotify_for_artists_csv":
      try {
        const csvText = String(body.csv_text ?? "").trim();
        if (!csvText) return { status: 400, data: { error: "csv_text required" } };
        const result = await importSpotifyForArtistsCsv(sb, {
          csv_text: csvText,
          period_label: String(body.period_label ?? "").trim() || undefined,
          lane: String(body.lane ?? "").trim(),
          references: Array.isArray(body.references) ? body.references.map(String) : [],
          artist_name: String(body.artist_name ?? "").trim() || undefined,
          resolve_urls: Boolean(body.resolve_urls),
          resolve_limit: Number(body.resolve_limit) || 12,
          deactivate_missing: Boolean(body.deactivate_missing),
        });
        return { status: 200, data: { ok: true, ...result } };
      } catch (e) {
        return { status: 400, data: { error: errMsg(e) } };
      }
    case "queue_ig_outreach_batch":
      return runQueueIgOutreachBatch(sb, body, resolveStreamLink, rowDiscoveryReferences);
    case "connect_spotify_init":
      return runConnectSpotifyInit(body);
    case "connect_spotify_status":
      return runConnectSpotifyStatus(body, sb);
    case "queue_instagram_pitch":
      return runQueueInstagramPitch(body, sb);
    case "reconcile_lane_targets":
      return runReconcileLaneTargets(body, sb);
    case "list_social_queue":
      return runPlaylistAdmin({ ...body, action: "list_social_queue" }, sb);
    case "mark_social_queue_sent":
      return runPlaylistAdmin({ ...body, action: "mark_social_queue_sent" }, sb);
    case "list_ig_roster":
    case "patch_ig_roster":
    case "import_ig_roster":
    case "sync_ig_roster_from_targets":
      return runIgRosterAdmin(action, body, sb);
    case "list_tracks":
    case "upsert_track":
    case "delete_track":
    case "list_categories":
    case "upsert_category":
    case "delete_category":
    case "set_track_categories":
    case "set_playlist_categories":
    case "recommend_targets_for_track":
    case "list_warm_curators":
    case "mark_pitch_response":
    case "pitch_stats_summary":
    case "list_pitches":
      return runCatalogueAdmin({ ...body, action }, sb);
    default:
      return { status: 400, data: { error: `Unknown playlist agent action: ${action}` } };
  }
}
