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
  scrapeSpotifyUserProfile,
} from "./spotify-scrape.ts";

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

const DEFAULT_STREAM_LINKS: Record<string, string> = {
  "Designed For Me (Control)": "https://rnd.fm/runway-music-hlpad6",
};

async function resolveStreamLink(sb: SupabaseClient, trackName: string): Promise<string> {
  const { data } = await sb.from("artist_config").select("value").eq("key", "spotify_track_urls").maybeSingle();
  const urls = (data?.value && typeof data.value === "object" && !Array.isArray(data.value))
    ? data.value as Record<string, string>
    : {};
  return urls[trackName]?.trim() || DEFAULT_STREAM_LINKS[trackName] || "";
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
    "Happy to share extra context, stems, or a different mix if useful.",
    "Thank you for your time.",
    "",
    "— Fendi Frost",
  );
  return lines.join("\n");
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
  const streamLink = await resolveStreamLink(sb, trackName);
  const pitchBody = typeof body.override_body === "string" && body.override_body.trim()
    ? body.override_body.trim()
    : buildPitchBody(row, trackName, pitchAngle, streamLink);

  const { data: draft, error: insErr } = await sb.from("outreach_drafts").insert({
    playlist_id: playlistId, track_name: trackName, channel, recipient,
    subject: channel === "email" ? subject : null, body: pitchBody,
    generated_by: generatedBy, status: "pending",
    metadata: {
      lane: lane || null,
      why_it_fits: (row.why_it_fits as string | null) ?? null,
      stream_link: streamLink || null,
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
  playlistId: string,
  handle: string,
  lane: string | null,
  draftText?: string,
): Promise<boolean> {
  const clean = handle.replace(/^@/, "").trim();
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
    draft_text: draftText ?? null,
    playlist_id: playlistId,
    status: "pending",
    result: { lane, source: "enrich_v2" },
  });
  if (error) {
    console.error("[enrich] queue insert failed:", playlistId, error.message);
    return false;
  }
  return true;
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
  const draftText = buildPitchBody(row, trackName, pitchAngle, streamLink);

  const queued = await queueInstagramPitch(sb, playlistId, handle, lane || null, draftText);
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

  let query = sb
    .from("playlist_targets")
    .select(
      "playlist_id, playlist_name, curator_name, curator_email, curator_instagram, curator_linktree, curator_website, curator_submission_url, curator_submission_dm, research_context, lane, submission_method, contact_confidence, pitch_status",
    )
    .eq("is_active", true)
    .neq("pitch_status", "disclaim_brand")
    .or("curator_email.is.null,submission_method.is.null")
    .or(`last_enriched_at.is.null,last_enriched_at.lt.${staleBefore}`)
    .order("follower_count", { ascending: false, nullsFirst: false });

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

  for (const row of rows) {
    if (!row.playlist_id?.startsWith("spotify:")) continue;

    const spotifyId = row.playlist_id.replace(/^spotify:/, "");
    const patch: Record<string, unknown> = {};
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
        if (await queueInstagramPitch(sb, row.playlist_id, handle, row.lane, undefined)) {
          fieldsAdded.routed_instagram_dm++;
          recordConfidence(Math.max(bestConfidence, 4));
        }
      } else {
        patch.submission_method = "none";
      }

      patch.contact_confidence = bestConfidence;
      patch.last_enriched_at = new Date().toISOString();

      const { error: upErr } = await sb.from("playlist_targets").update(patch).eq("playlist_id", row.playlist_id);
      if (!upErr) enriched++;
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
      done,
      next_offset: done ? null : nextOffset,
      fields_added: fieldsAdded,
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
      "playlist_id, playlist_name, curator_name, curator_email, curator_instagram, curator_linktree, curator_submission_url, curator_submission_dm, curator_submission_note, lane, tier, authenticity_score, fraud_verdict, contact_confidence, pitch_status, follower_count, is_active, why_it_fits, recommended_pitch_angle, submission_url, submission_method, last_enriched_at",
    ).eq("is_active", true).order("follower_count", { ascending: false, nullsFirst: false }).limit(200);
    if (body.lane) q = q.eq("lane", String(body.lane));
    if (body.tier != null && body.tier !== "") q = q.eq("tier", Number(body.tier));
    if (body.fraud_verdict) q = q.eq("fraud_verdict", String(body.fraud_verdict));
    if (body.has_email) q = q.not("curator_email", "is", null);
    if (body.pitchable_only) q = q.in("submission_method", ["email", "instagram_dm"]);
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
      .select("id, platform, action, target_url, draft_text, playlist_id, status, created_at, result")
      .eq("platform", "instagram")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (status !== "all") q = q.eq("status", status);
    const { data, error } = await q;
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true, rows: data ?? [] } };
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
  "list_targets", "list_drafts", "update_draft", "deactivate_target", "patch_target", "get_pitch_log",
  "run_playlist_research", "send_campaign", "send_telegram_campaign",
  "connect_spotify_init", "connect_spotify_status",
  "queue_instagram_pitch",
  "reconcile_lane_targets",
  "list_social_queue",
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
    case "patch_target":
    case "get_pitch_log":
      return runPlaylistAdmin({ ...body, action }, sb);
    case "run_playlist_research":
      return runPlaylistResearchProxy(body, hubKey);
    case "send_campaign":
      return runSendCampaignProxy(body, hubKey);
    case "send_telegram_campaign":
      return runSendTelegramCampaignProxy(body, hubKey);
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
    default:
      return { status: 400, data: { error: `Unknown playlist agent action: ${action}` } };
  }
}
