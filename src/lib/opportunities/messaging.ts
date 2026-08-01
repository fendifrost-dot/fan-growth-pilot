// Opportunity Engine — deterministic action + message generation.
//
// Produces a recommended action and a DRAFT outreach message from the fields we
// actually hold. It never fabricates facts: any missing piece is simply omitted.
// This is a template, explicitly labelled as a draft for human review — not an
// "AI agent". Phase 2 can swap the internals for an LLM behind the same signature.

import type { EntityType } from "./types.ts";

export interface MessageContext {
  entityName?: string | null;
  entityType?: EntityType | string | null;
  contactName?: string | null;
  songName?: string | null;
  clipStart?: number | null;
  clipEnd?: number | null;
  sourceUrl?: string | null;
  smartLinkUrl?: string | null;
  whyDiscovered?: string | null;
}

const ACTION_BY_TYPE: Record<string, string> = {
  playlist_pitch: "Send a personal playlist pitch",
  creator_collab: "Propose a collaboration / duet",
  radio_play: "Send a radio submission",
  dj_support: "Offer the track for DJ support",
  press_feature: "Pitch a feature / premiere",
  event_booking: "Enquire about a booking / set",
  conversation_reply: "Reply to the inbound message",
  fan_activation: "Send the fan a tracked smart link",
  referral: "Ask for an intro / referral",
  newsletter_feature: "Pitch a newsletter inclusion",
  podcast_feature: "Pitch a podcast feature",
};

export function recommendAction(opportunityType: string): string {
  return ACTION_BY_TYPE[opportunityType] ?? "Reach out with a tailored message";
}

function fmtClip(start?: number | null, end?: number | null): string | null {
  if (start == null || end == null) return null;
  const mm = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return `${mm(start)}–${mm(end)}`;
}

/**
 * Build a short, honest draft message. Returns the message plus the discrete parts
 * used, so the UI can show what was and wasn't filled in.
 */
export function generateMessage(ctx: MessageContext): { message: string; usedParts: string[] } {
  const parts: string[] = [];
  const used: string[] = [];

  const greetingName = ctx.contactName?.trim() || ctx.entityName?.trim();
  parts.push(greetingName ? `Hi ${greetingName},` : "Hi,");
  if (greetingName) used.push("name");

  if (ctx.songName) {
    parts.push(`I'm Fendi Frost — I'd love to share my track "${ctx.songName}" with you.`);
    used.push("song");
  } else {
    parts.push("I'm Fendi Frost and I'd love to share my music with you.");
  }

  if (ctx.whyDiscovered) {
    parts.push(ctx.whyDiscovered.trim().replace(/\.?$/, "."));
    used.push("why");
  }

  const clip = fmtClip(ctx.clipStart, ctx.clipEnd);
  if (clip) {
    parts.push(`If it helps, the standout section is ${clip}.`);
    used.push("clip");
  }

  const link = ctx.smartLinkUrl || ctx.sourceUrl;
  if (link) {
    parts.push(`Here's the link: ${link}`);
    used.push("link");
  }

  parts.push("No worries at all if it's not a fit — thanks for listening either way.");
  parts.push("— Fendi Frost");

  return { message: parts.join("\n\n"), usedParts: used };
}
