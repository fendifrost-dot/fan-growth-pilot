/**
 * Pitch email renderer. Wording lives in `pitch_templates` (editable in Admin).
 * This module only substitutes placeholders — it must not contain song or
 * campaign copy.
 */
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export type Tone = "warm_personal" | "casual_friendly" | "business_formal" | "hyped_energetic";
export type Platform = "spotify" | "apple_music" | "soundcloud" | "youtube" | "blog";

export const VALID_TONES = new Set<string>([
  "warm_personal",
  "casual_friendly",
  "business_formal",
  "hyped_energetic",
]);

/**
 * Allowed template tokens. {{fit_reason}} is intentionally excluded — lane /
 * playlist fit copy must not make genre claims about the song in outbound email.
 * Fit metadata stays on the draft row (metadata.fit_reason) for operators only.
 */
export const PITCH_TEMPLATE_PLACEHOLDERS = [
  "curator_name",
  "playlist_name",
  "track_name",
  "pitch",
  "stream_link",
  "artist_name",
  "prior_track",
] as const;

export type PitchTemplateVars = Record<(typeof PITCH_TEMPLATE_PLACEHOLDERS)[number], string>;

export interface PitchContext {
  curatorName: string;
  playlistName: string;
  trackName: string;
  shortPitch: string;
  /** Operator-facing fit metadata only — not a template placeholder. */
  fitReason?: string;
  platform: Platform;
  streamUrl: string;
  isWarm: boolean;
  priorTrack?: string;
  tone: Tone;
  artistName: string;
  channel?: string;
}

export interface RenderedPitch {
  subject: string;
  body: string;
}

export type PitchTemplateRow = {
  id?: string;
  tone: string;
  channel: string;
  is_warm: boolean;
  subject_template: string;
  body_template: string;
  is_active?: boolean;
};

const PLATFORM_LINK_PREFIX: Record<Platform, string> = {
  spotify: "Stream:",
  apple_music: "Listen on Apple Music:",
  soundcloud: "Listen on SoundCloud:",
  youtube: "Watch:",
  blog: "Listen:",
};

export function platformLinkLine(platform: Platform, url: string): string {
  return `${PLATFORM_LINK_PREFIX[platform]} ${url}`;
}

export class UnknownPitchPlaceholderError extends Error {
  constructor(public readonly placeholder: string) {
    super(`Unknown pitch template placeholder: {{${placeholder}}}`);
    this.name = "UnknownPitchPlaceholderError";
  }
}

export function applyPitchTemplate(
  subjectTemplate: string,
  bodyTemplate: string,
  vars: PitchTemplateVars,
): RenderedPitch {
  const known = new Set<string>(PITCH_TEMPLATE_PLACEHOLDERS);
  const sub = (template: string) =>
    template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, key: string) => {
      const k = key.toLowerCase();
      if (!known.has(k)) {
        throw new UnknownPitchPlaceholderError(k);
      }
      return vars[k as keyof PitchTemplateVars] ?? "";
    });
  return { subject: sub(subjectTemplate), body: sub(bodyTemplate) };
}

export function varsFromPitchContext(ctx: PitchContext): PitchTemplateVars {
  const priorTrack = ctx.priorTrack?.trim() || "your last track";
  const streamLink = ctx.streamUrl?.trim() ? platformLinkLine(ctx.platform, ctx.streamUrl.trim()) : "";
  // fitReason is retained on PitchContext for draft metadata only — never substituted.
  void ctx.fitReason;
  return {
    curator_name: ctx.curatorName,
    playlist_name: ctx.playlistName,
    track_name: ctx.trackName,
    pitch: ctx.shortPitch.trim(),
    stream_link: streamLink,
    artist_name: ctx.artistName,
    prior_track: priorTrack,
  };
}

/** Reject templates that still reference the retired {{fit_reason}} token. */
export function templateUsesForbiddenFitReason(subject: string, body: string): boolean {
  return /\{\{\s*fit_reason\s*\}\}/i.test(subject) || /\{\{\s*fit_reason\s*\}\}/i.test(body);
}

export async function loadPitchTemplate(
  sb: SupabaseClient,
  opts: { tone: Tone; channel?: string; isWarm: boolean },
): Promise<PitchTemplateRow | null> {
  const channel = (opts.channel ?? "email").trim() || "email";
  const load = async (ch: string) => {
    const { data } = await sb.from("pitch_templates")
      .select("id, tone, channel, is_warm, subject_template, body_template, is_active")
      .eq("tone", opts.tone)
      .eq("channel", ch)
      .eq("is_warm", opts.isWarm)
      .eq("is_active", true)
      .maybeSingle();
    return (data as PitchTemplateRow | null) ?? null;
  };
  const exact = await load(channel);
  if (exact?.subject_template && exact?.body_template) return exact;
  if (channel !== "email") {
    const fallback = await load("email");
    if (fallback?.subject_template && fallback?.body_template) return fallback;
  }
  return null;
}

export async function renderPitchBody(
  sb: SupabaseClient,
  ctx: PitchContext,
): Promise<RenderedPitch | { error: string; tone: string; channel: string; is_warm: boolean }> {
  const channel = (ctx.channel ?? "email").trim() || "email";
  const tpl = await loadPitchTemplate(sb, { tone: ctx.tone, channel, isWarm: ctx.isWarm });
  if (!tpl) {
    return {
      error: "No pitch template configured",
      tone: ctx.tone,
      channel,
      is_warm: ctx.isWarm,
    };
  }
  return applyPitchTemplate(tpl.subject_template, tpl.body_template, varsFromPitchContext(ctx));
}

export function trackUrlForPlatform(
  track: { spotify_url?: string | null; apple_music_url?: string | null; soundcloud_url?: string | null },
  platform: Platform,
): string | null {
  switch (platform) {
    case "spotify":
      return track.spotify_url?.trim() || null;
    case "apple_music":
      return track.apple_music_url?.trim() || null;
    case "soundcloud":
      return track.soundcloud_url?.trim() || null;
    default:
      return track.spotify_url?.trim() || null;
  }
}
