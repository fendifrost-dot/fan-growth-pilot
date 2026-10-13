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
import {
  assertCopyAgainstDnaDescriptors,
  rejectCallerPlaylistCopy,
} from "./pitch-descriptor-guard.ts";
import { resolveTrackPitchCopy } from "./pitch-copy.ts";
import { assessSubmissionRoute, hostLabel, hostOf, isFormBuilderHost, isNonFormHost } from "./submission-route.ts";
import {
  blockingSignal,
  classifyRoutePage,
  fetchRoutePage,
  isDeferredFetch,
  isFirstPartySource,
  isInstagramHost,
  renderJsPage,
  routeFetchRecord,
  type RouteFetchDeps,
  type RoutePage,
  type RoutePageSignals,
} from "./route-fetch.ts";

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
  /** The playlist's own URL — never accepted as a form route. */
  playlist_url?: string | null;
  /** Listing page the candidate came from (may name the form's site). */
  source_url?: string | null;
  song_dna_version_id?: string | null;
};

export type RouteVerificationMethod = "server_fetch" | "server_route_rules" | "agent_text";

export type PathVerifyResult = {
  ok: boolean;
  path_verified: boolean;
  channel: string | null;
  status: "auto_verified" | "manually_verified" | "unverified";
  reason: string;
  code?: string;
  /** Temporary host/lookup failure — defer and retry; never a permanent rejection. */
  retryable?: boolean;
  /** ISO time the caller may resubmit after a temporary fetch failure. */
  retry_after?: string | null;
  /** What decided the route. Packet method is server_fetch only when the fetch decided it. */
  route_method?: RouteVerificationMethod;
  /** Stored on playlist_targets.research_context.route_fetch. No page body. */
  route_fetch?: Record<string, unknown> | null;
  /**
   * Login wall, paywall, captcha, dead form, follow gate, closed submissions, or SSRF.
   * Do not insert a playlist_targets row.
   */
  block_insert?: boolean;
};

const RETRY_AFTER_MS = 30 * 60 * 1000;

export type { RouteFetchDeps };

/**
 * Pure path verification — email still uses MX/format checks;
 * form/DM require URL/handle + source evidence.
 */
export async function evaluateSubmissionPath(
  input: PathVerifyInput,
  opts?: { bounceCount?: number; sb?: SupabaseClient; routeFetch?: RouteFetchDeps },
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

  // Infer channel when not supplied. A platform/listening URL (e.g. the playlist's own
  // Spotify link) never implies a web-form route.
  let channel = channelRaw;
  if (!channel) {
    const formCandidate = input.form_url ?? input.submission_url;
    if ((input.curator_email ?? "").trim()) channel = "email";
    else if (isValidFormUrl(formCandidate) && !isNonFormHost(String(formCandidate))) channel = "web_form";
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
    if (!opts?.sb) {
      // Without DB, only format gate — caller should prefer full verifyEmail.
      const okFmt = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      return {
        ok: okFmt,
        path_verified: okFmt,
        channel,
        status: okFmt ? "auto_verified" : "unverified",
        reason: "format-only check (no DB)",
        ...(okFmt ? {} : { code: "invalid_curator_email" }),
      };
    }
    const verdict = await verifyEmail(opts.sb, email, opts.bounceCount ?? 0);
    return {
      ok: verdict.ok,
      path_verified: verdict.ok,
      channel,
      status: verdict.status === "auto_verified" ? "auto_verified" : "unverified",
      reason: verdict.reason,
      ...(verdict.retryable ? { retryable: true, code: "temporary_host_failure" } : {}),
    };
  }

  if (channel === "web_form") {
    return await evaluateWebFormPath(input, opts);
  }

  if (channel === "instagram_dm") {
    return await evaluateInstagramPath(input, opts);
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

function unverified(
  channel: string,
  reason: string,
  code: string,
  extra: Partial<PathVerifyResult> = {},
): PathVerifyResult {
  return { ok: false, path_verified: false, channel, status: "unverified", reason, code, ...extra };
}

function deferredPath(channel: string, reason: string): PathVerifyResult {
  return unverified(channel, reason, "temporary_host_failure", {
    retryable: true,
    retry_after: new Date(Date.now() + RETRY_AFTER_MS).toISOString(),
    route_method: "server_fetch",
  });
}

function fetchFailure(channel: string, page: RoutePage): PathVerifyResult | null {
  if (page.error_class === "ssrf" || page.error_class === "non_https") {
    return unverified(channel, `refused to fetch route: ${page.error ?? page.error_class}`, "ssrf_refused", {
      block_insert: true,
      route_method: "server_fetch",
    });
  }
  if (page.error_class === "policy") {
    return unverified(channel, "instagram.com is not scraped", "instagram_not_scraped", {
      block_insert: true,
      route_method: "server_fetch",
    });
  }
  if (isDeferredFetch(page)) {
    return deferredPath(channel, `temporary fetch failure (${page.error_class}): ${page.error ?? "unreachable"}`);
  }
  return null;
}

function hardPageRejection(channel: string, page: RoutePage, code: string): PathVerifyResult {
  return unverified(channel, `submission page rejected: ${code}`, code, {
    block_insert: true,
    route_method: "server_fetch",
    route_fetch: routeFetchRecord(page),
  });
}

function passPath(channel: string, reason: string, page: RoutePage): PathVerifyResult {
  return {
    ok: true,
    path_verified: true,
    channel,
    status: "auto_verified",
    reason,
    route_method: "server_fetch",
    route_fetch: routeFetchRecord(page),
  };
}

function labelsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ha = hostOf(a);
  const hb = hostOf(b);
  if (!ha || !hb) return false;
  if (ha === hb) return true;
  const la = hostLabel(ha);
  const lb = hostLabel(hb);
  return la.length >= 3 && la === lb;
}

function pageNamesHandle(page: RoutePage, handle: string): boolean {
  const h = handle.replace(/^@/, "").toLowerCase();
  if (!h) return false;
  const hay = `${page.title ?? ""} ${page.text_excerpt} ${page.links.join(" ")}`.toLowerCase();
  if (hay.includes(`instagram.com/${h}`)) return true;
  const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9._])${escaped}([^a-z0-9._]|$)`, "i").test(hay);
}

async function evaluateWebFormPath(
  input: PathVerifyInput,
  opts?: { sb?: SupabaseClient; routeFetch?: RouteFetchDeps },
): Promise<PathVerifyResult> {
  const formUrl = (input.form_url ?? input.submission_url ?? "").trim();
  const structural = assessSubmissionRoute(
    {
      form_url: formUrl || null,
      form_source_evidence: input.form_source_evidence ?? "server-fetch",
      playlist_url: input.playlist_url ?? null,
      source_url: input.source_url ?? null,
    },
    "web_form",
  );
  // URL shape only. Evidence text is a hint; a missing or unlinked note is not a rejection yet.
  if (!structural.ok && structural.code !== "missing_form_evidence" && structural.code !== "evidence_not_linked_to_form" &&
    structural.code !== "evidence_negates_route") {
    return unverified("web_form", structural.reason, structural.code);
  }
  if (!formUrl) return unverified("web_form", structural.reason, structural.code || "missing_form_url");

  const page = await fetchRoutePage(formUrl, { deps: opts?.routeFetch, formUrl });
  const failed = fetchFailure("web_form", page);
  if (failed) return failed;
  const blocked = blockingSignal(page.signals);
  if (blocked) return hardPageRejection("web_form", page, blocked);

  const builder = isFormBuilderHost(formUrl) || (!!page.final_url && isFormBuilderHost(page.final_url));
  const formOnHost = page.signals.has_form && labelsMatch(page.final_url ?? formUrl, formUrl);
  let sourceLinks = false;
  const sourceUrl = (input.source_url ?? "").trim();
  if (sourceUrl && isFirstPartySource(sourceUrl) && !labelsMatch(sourceUrl, formUrl) && !isInstagramHost(sourceUrl)) {
    const source = await fetchRoutePage(sourceUrl, { deps: opts?.routeFetch, formUrl });
    const sourceFailed = fetchFailure("web_form", source);
    if (sourceFailed?.retryable && !formOnHost && !builder) return sourceFailed;
    if (sourceFailed?.block_insert) return sourceFailed;
    if (!sourceFailed && source.signals.links_to_form && !blockingSignal(source.signals)) sourceLinks = true;
  }

  if (formOnHost || builder || sourceLinks) {
    return passPath("web_form", "server fetched the submission page (no automated submit)", page);
  }

  if (page.signals.js_only) {
    const rendered = await renderJsPage(opts?.sb as never, page.final_url ?? formUrl, opts?.routeFetch);
    if (rendered) {
      const signals: RoutePageSignals = classifyRoutePage({
        status: 200,
        final_url: page.final_url,
        title: page.title,
        text_excerpt: rendered.markdown.slice(0, 8_000),
        html: rendered.html,
        links: page.links,
      }, { formUrl });
      const renderedPage: RoutePage = { ...page, signals, text_excerpt: rendered.markdown.slice(0, 1_500), error: null, error_class: null, ok: true };
      const again = blockingSignal(signals);
      if (again) return hardPageRejection("web_form", renderedPage, again);
      if (signals.has_form || signals.links_to_form) {
        return passPath("web_form", "server fetched the submission page via JS render (no automated submit)", renderedPage);
      }
    }
    return unverified(
      "web_form",
      "page looks JavaScript-only; Firecrawl fallback is off or did not render a form",
      "js_render_required",
      { route_method: "server_fetch", route_fetch: routeFetchRecord({ ...page, signals: { ...page.signals, js_only: true } }) },
    );
  }

  return unverified("web_form", "fetched page has no submission form", "no_form_on_page", {
    route_method: "server_fetch",
    route_fetch: routeFetchRecord(page),
  });
}

async function evaluateInstagramPath(
  input: PathVerifyInput,
  opts?: { routeFetch?: RouteFetchDeps },
): Promise<PathVerifyResult> {
  const handle = (input.ig_curator_account ?? input.curator_instagram ?? "").trim();
  const structural = assessSubmissionRoute(
    {
      ig_curator_account: handle || null,
      ig_source_evidence: input.ig_source_evidence ?? null,
    },
    "instagram_dm",
  );
  if (!structural.ok && structural.code !== "missing_ig_evidence" && structural.code !== "evidence_negates_route") {
    return unverified("instagram_dm", structural.reason, structural.code);
  }
  if (!handle) return unverified("instagram_dm", structural.reason, structural.code || "missing_ig_account");

  const sourceUrl = (input.source_url ?? "").trim();
  // instagram.com is never scraped. Without a first-party source, the text rule stands.
  if (!isFirstPartySource(sourceUrl)) {
    if (!structural.ok) return unverified("instagram_dm", structural.reason, structural.code);
    return {
      ok: true,
      path_verified: true,
      channel: "instagram_dm",
      status: "auto_verified",
      reason: "IG curator account + source evidence verified (draft-only; no bulk DM)",
      route_method: "agent_text",
    };
  }

  const page = await fetchRoutePage(sourceUrl, { deps: opts?.routeFetch });
  const failed = fetchFailure("instagram_dm", page);
  if (failed) return failed;
  const blocked = blockingSignal(page.signals);
  if (blocked) return hardPageRejection("instagram_dm", page, blocked);
  if (!pageNamesHandle(page, handle)) {
    return unverified("instagram_dm", "first-party source page does not name the Instagram handle", "ig_handle_not_on_source", {
      route_method: "server_fetch",
      route_fetch: routeFetchRecord(page),
    });
  }
  return passPath("instagram_dm", "server fetched a page that names the Instagram handle (draft-only; no bulk DM)", page);
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
    const rowRc = (row.research_context && typeof row.research_context === "object")
      ? row.research_context as Record<string, unknown>
      : {};
    const verdict = await evaluateSubmissionPath(
      {
        submission_channel: (row.submission_channel ?? row.contact_method ?? row.submission_method) as string,
        curator_email: row.curator_email as string,
        form_url: (row.form_url ?? row.submission_url) as string,
        form_source_evidence: row.form_source_evidence as string,
        ig_curator_account: (row.ig_curator_account ?? row.curator_instagram) as string,
        ig_source_evidence: row.ig_source_evidence as string,
        playlist_url: (rowRc.playlist_url as string) ?? null,
        source_url: (row.source_url as string) ?? (rowRc.source_url as string) ?? null,
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
      if (verdict.route_fetch) {
        patch.research_context = {
          ...rowRc,
          route_fetch: verdict.route_fetch,
          route_verified_by: verdict.route_method ?? "server_fetch",
        };
      } else if (verdict.route_method) {
        patch.research_context = { ...rowRc, route_verified_by: verdict.route_method };
      }
      // Do NOT write song_dna_version_id onto playlist_targets as authoritative.
      const { error: updErr } = await sb.from("playlist_targets").update(patch).eq("playlist_id", playlistId);
      if (updErr) return { status: 500, data: { error: updErr.message } };
    }
    return { status: 200, data: { ...verdict, ok: verdict.ok } };
  }

  if (action === "build_web_form_packet") {
    const callerCopy = rejectCallerPlaylistCopy(body);
    if (callerCopy) return callerCopy;

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

    const { data: dnaRow } = await sb
      .from("song_dna_versions")
      .select("id, short_pitch, approval_state, primary_genre, approved_lanes, excluded_lanes")
      .eq("id", envelope.songDnaVersionId!)
      .maybeSingle();
    const pitch = resolveTrackPitchCopy({ approvedDna: dnaRow, requireApprovedDna: true });
    if (!pitch.ok) {
      return { status: 422, data: { error: "missing approved Song DNA pitch copy", code: "missing_track_pitch_copy" } };
    }
    const descErr = assertCopyAgainstDnaDescriptors(pitch.pitch, {
      primary_genre: dnaRow?.primary_genre as string | null,
      approved_lanes: (dnaRow?.approved_lanes as string[]) ?? envelope.approvedLanes,
      excluded_lanes: (dnaRow?.excluded_lanes as string[]) ?? envelope.excludedLanes,
    });
    if (descErr) return { status: 422, data: { error: descErr, code: descErr } };

    const { data, error } = await sb.from("playlist_targets").select("*").eq("playlist_id", playlistId).maybeSingle();
    if (error) return { status: 500, data: { error: error.message } };
    if (!data) return { status: 404, data: { error: "target not found" } };
    const packet = buildWebFormPacket(data as Record<string, unknown>, {
      track_id: trackId,
      song_dna_version_id: envelope.songDnaVersionId,
    });
    packet.pitch = pitch.pitch;
    packet.draft_body = pitch.pitch;
    packet.pitch_copy_source = pitch.source;
    const dnaErr = assertPacketDnaEnvelope(packet);
    if (dnaErr) return { status: 422, data: { error: dnaErr, code: "dna_required" } };
    return {
      status: 200,
      data: { ok: true, packet, automated_submit: false, auto_form_post: false },
    };
  }

  if (action === "build_instagram_dm_draft") {
    // Caller-written playlist copy is hard-rejected — compose from approved DNA only.
    const callerCopy = rejectCallerPlaylistCopy(body);
    if (callerCopy) return callerCopy;

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

    const { data: dnaRow } = await sb
      .from("song_dna_versions")
      .select("id, short_pitch, approval_state, primary_genre, approved_lanes, excluded_lanes")
      .eq("id", envelope.songDnaVersionId!)
      .maybeSingle();
    const pitch = resolveTrackPitchCopy({ approvedDna: dnaRow, requireApprovedDna: true });
    if (!pitch.ok) {
      return {
        status: 422,
        data: { error: "missing approved Song DNA pitch copy", code: "missing_track_pitch_copy", persisted: false },
      };
    }
    const descErr = assertCopyAgainstDnaDescriptors(pitch.pitch, {
      primary_genre: dnaRow?.primary_genre as string | null,
      approved_lanes: (dnaRow?.approved_lanes as string[]) ?? envelope.approvedLanes,
      excluded_lanes: (dnaRow?.excluded_lanes as string[]) ?? envelope.excludedLanes,
    });
    if (descErr) {
      return { status: 422, data: { error: descErr, code: descErr, persisted: false } };
    }

    const { data, error } = await sb.from("playlist_targets").select("*").eq("playlist_id", playlistId).maybeSingle();
    if (error) return { status: 500, data: { error: error.message } };
    if (!data) return { status: 404, data: { error: "target not found" } };

    // Persist server-composed DNA pitch only (never caller draft_body).
    const { error: writeErr } = await sb
      .from("playlist_targets")
      .update({
        ig_dm_draft: pitch.pitch,
        updated_at: new Date().toISOString(),
      })
      .eq("playlist_id", playlistId);
    if (writeErr) return { status: 500, data: { error: writeErr.message, persisted: false } };

    const packet = buildInstagramDmPacket(data as Record<string, unknown>, pitch.pitch, {
      track_id: trackId,
      song_dna_version_id: envelope.songDnaVersionId,
    });
    packet.pitch = pitch.pitch;
    packet.pitch_copy_source = pitch.source;
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
