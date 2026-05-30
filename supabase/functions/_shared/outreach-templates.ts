import type { IgRosterRow } from "./ig-roster.ts";

export type OutreachIdentity = {
  ig_handle: string;
  display_name: string;
  mutual_ok: boolean;
  mutual_detail: string;
  roster_verified: string | null;
  playlist_name: string;
  playlist_id: string;
  playlist_saves: string | null;
  featuring_track: string;
  pitch_track: string;
  pitch_reason: string;
  engagement_type: string;
  stream_link: string;
  lane: string | null;
  dm_ref: string;
};

function fmtSaves(n: number | null | undefined): string | null {
  if (n == null) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function engagementLabel(t: string): string {
  if (t === "thank_you") return "Thank-you only";
  if (t === "cross_pitch") return "Catalog pitch only";
  return "Thank-you + catalog pitch";
}

export function buildOutreachIdentity(
  row: Record<string, unknown>,
  pitchTrack: string,
  pitchReason: string,
  streamLink: string,
  engagementType: string,
  roster: IgRosterRow | null,
  dmRef: string,
): OutreachIdentity {
  const handle = String(
    (row.curator_submission_dm as string) || (row.curator_instagram as string) || "",
  ).replace(/^@/, "").trim();
  const mutualOk = roster?.is_mutual ?? false;
  let mutualDetail = "Not verified on roster";
  if (roster) {
    if (roster.is_mutual) mutualDetail = "Mutual ✓ — you follow + they follow you";
    else {
      const parts: string[] = [];
      if (!roster.i_follow) parts.push("you do NOT follow them");
      if (!roster.follows_me) parts.push("they do NOT follow you");
      mutualDetail = parts.join(" · ") || "Not mutual";
    }
  }
  const featuring = (() => {
    const rc = row.research_context as Record<string, unknown> | null;
    const raw = rc?.featuring_tracks;
    if (Array.isArray(raw) && raw[0]) return String(raw[0]);
    return "your pick (see playlist)";
  })();

  return {
    ig_handle: handle,
    display_name: (roster?.display_name as string) || (row.curator_name as string) || handle,
    mutual_ok: mutualOk,
    mutual_detail: mutualDetail,
    roster_verified: roster?.last_verified_at
      ? new Date(roster.last_verified_at).toLocaleDateString()
      : null,
    playlist_name: (row.playlist_name as string) || "playlist",
    playlist_id: String(row.playlist_id ?? ""),
    playlist_saves: fmtSaves(row.follower_count as number | null),
    featuring_track: featuring,
    pitch_track: pitchTrack,
    pitch_reason: pitchReason,
    engagement_type: engagementType,
    stream_link: streamLink,
    lane: (row.lane as string) ?? null,
    dm_ref: dmRef,
  };
}

function buildCleanDmBody(id: OutreachIdentity): string {
  const curator = id.display_name.split(" ")[0] || id.display_name;
  const lines: string[] = [`Hi ${curator},`, ""];

  if (id.engagement_type !== "cross_pitch") {
    lines.push(
      `Thank you for adding my music to ${id.playlist_name} — especially "${id.featuring_track}". That really means a lot.`,
      "",
    );
  }
  if (id.engagement_type !== "thank_you") {
    lines.push(
      `Since ${id.playlist_name} already fits my sound, I wanted to share another one: "${id.pitch_track}".`,
      "",
    );
    if (id.stream_link) lines.push(id.stream_link, "");
  }
  lines.push("No pressure — appreciate you either way.", "", "— Fendi Frost");
  return lines.join("\n");
}

export function buildOperatorBrief(id: OutreachIdentity): string {
  const date = new Date().toISOString().slice(0, 10);
  return [
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "FAN FUEL · OUTREACH BRIEF (operator)",
    `REF: ${id.dm_ref}`,
    `DATE: ${date} UTC`,
    "",
    "IDENTITY",
    `  Instagram:     @${id.ig_handle}`,
    `  Display name:  ${id.display_name}`,
    `  Relationship:  ${id.mutual_detail}`,
    id.roster_verified ? `  Roster check:  ${id.roster_verified}` : "  Roster check:  not recorded — verify in app",
    "",
    "PLAYLIST CONTEXT",
    `  Playlist:      ${id.playlist_name}`,
    `  ID:            ${id.playlist_id}`,
    id.playlist_saves ? `  Saves/follows:   ${id.playlist_saves}` : "",
    `  They spun:     ${id.featuring_track}`,
    id.lane ? `  Lane:          ${id.lane}` : "",
    "",
    "THIS OUTREACH",
    `  Type:          ${engagementLabel(id.engagement_type)}`,
    `  Pitch track:   ${id.pitch_track}`,
    `  Match reason:  ${id.pitch_reason}`,
    id.stream_link ? `  Stream:        ${id.stream_link}` : "",
    "",
    "BEFORE YOU SEND",
    "  1. Open Instagram → search @" + id.ig_handle,
    "  2. Confirm mutual follow + profile matches playlist curator",
    "  3. Paste ONLY the block below into DM (not this brief)",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    "MESSAGE TO SEND",
    "───────────────",
    buildCleanDmBody(id),
  ].filter(Boolean).join("\n");
}

export function buildPlacementEmail(id: OutreachIdentity): { subject: string; body: string } {
  const subject = `[${id.dm_ref}] ${id.playlist_name} — thank you + ${id.pitch_track}`;
  const curator = id.display_name.split(" ")[0] || "there";
  const lines = [
    `Hi ${curator},`,
    "",
    `REF: ${id.dm_ref} · Playlist: ${id.playlist_name} · Mutual: ${id.mutual_detail}`,
    "",
  ];
  if (id.engagement_type !== "cross_pitch") {
    lines.push(
      `Thank you for including "${id.featuring_track}" on ${id.playlist_name}. I really appreciate the support.`,
      "",
    );
  }
  if (id.engagement_type !== "thank_you") {
    lines.push(
      `I'd love to submit "${id.pitch_track}" for consideration — it matches the same energy (${id.pitch_reason}).`,
      "",
    );
    if (id.stream_link) lines.push(`Stream: ${id.stream_link}`, "");
  }
  lines.push("Thank you for your time.", "", "— Fendi Frost");
  return { subject, body: lines.join("\n") };
}

export async function nextDmRef(sb: import("@supabase/supabase-js@2.49.1").SupabaseClient): Promise<string> {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const { count } = await sb.from("social_engagement_queue")
    .select("*", { count: "exact", head: true })
    .eq("platform", "instagram")
    .gte("created_at", start.toISOString());
  const n = (count ?? 0) + 1;
  return `FF-IG-${day}-${String(n).padStart(3, "0")}`;
}

export function buildIgOutreachPackage(
  row: Record<string, unknown>,
  pitchTrack: string,
  pitchReason: string,
  streamLink: string,
  engagementType: "thank_you" | "cross_pitch" | "thank_and_pitch",
  roster: IgRosterRow | null,
  dmRef: string,
) {
  const identity = buildOutreachIdentity(row, pitchTrack, pitchReason, streamLink, engagementType, roster, dmRef);
  return {
    identity,
    dm_ref: dmRef,
    operator_brief: buildOperatorBrief(identity),
    dm_body: buildCleanDmBody(identity),
    email: buildPlacementEmail(identity),
  };
}
