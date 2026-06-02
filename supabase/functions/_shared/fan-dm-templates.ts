/** Generic daily-stable templates; personalization layer fills {first_name} etc. */

export type FanDmStage = "opener" | "runway" | "invite";

export const FAN_DM_STAGE_ORDER: FanDmStage[] = ["opener", "runway", "invite"];

const OPENERS = [
  "Hey {first_name} — appreciate you being on the page. Hope your week's going smooth.",
  "Hi {first_name}, thanks for following — I've been catching more of the community side of IG lately and wanted to say hey.",
  "{first_name} — saw you pop up in notifications and wanted to reach out personally. No agenda, just connecting.",
  "Hey {first_name}! Grateful you're here. I've been heads-down on music but didn't want to be a ghost on here.",
  "Hi {first_name} — hope you're having a good one. I try to check in with people who actually follow instead of only posting.",
  "{first_name}, quick hello from my side — thanks for the follow. Always good to put a name to the support.",
  "Hey {first_name} — I've been quiet on DMs but wanted to say thanks for riding with the project.",
  "Hi {first_name}! Hope the week's treating you well. Appreciate you following — means more than the algo stuff.",
  "{first_name} — just wanted to check in and say hey. I don't spam DMs so if you're reading this, it's intentional.",
  "Hey {first_name}, thanks for being here. I'm trying to be more present with people who actually engage.",
];

const RUNWAY = [
  "Been deep in a new lane called Runway Music — moody, late-night, still groove-led. Curious if that world fits your taste.",
  "If you get a sec, my latest post is from the Runway Music side of things — different energy from the usual drops.",
  "Working on Runway Music right now — more cinematic house/rap blend. Would love your take if you ever listen to that vibe.",
  "I've been sharing snippets from Runway Music on the feed — it's the project I'm most excited about this month.",
  "Runway Music is where I'm putting the most care lately. If you browse my profile, that's the thread to peek at.",
  "My recent grid posts lean into Runway Music — trying to tell a story without shouting. Let me know if any of it lands.",
  "Been building Runway Music as a cohesive listen — not just singles. The latest post is a good entry point.",
  "If you're into late-night, designer-energy records, Runway Music might click. Latest post is a taste.",
  "I dropped something from Runway Music recently — would genuinely value a honest reaction if you have a minute.",
  "Runway Music is the focus — still Fendi Frost, just a sharper concept. Check the newest post when you can.",
];

const INVITES = [
  "If you ever want updates without relying on IG, I keep a small email list — happy to add you, no spam.",
  "I send occasional notes by email when there's real news (releases, shows) — want me to include you?",
  "Trying to build a list I actually control in case the algorithm hides posts — email's the cleanest. Interested?",
  "I don't pitch in DMs usually, but if you want a direct line for drops, I can add you to my mailing list.",
  "Last thing — I share early listens and BTS by email sometimes. Only if you want it; totally fine if not.",
];

const BY_STAGE: Record<FanDmStage, readonly string[]> = {
  opener: OPENERS,
  runway: RUNWAY,
  invite: INVITES,
};

/** Same calendar day UTC → same template index per stage (stable daily rotation). */
export function pickDailyTemplate(stage: FanDmStage, dayUtc = new Date()): { slug: string; body: string } {
  const list = BY_STAGE[stage];
  const dayKey = dayUtc.toISOString().slice(0, 10);
  let hash = 0;
  for (let i = 0; i < dayKey.length; i++) hash = (hash * 31 + dayKey.charCodeAt(i)) | 0;
  hash = (hash * 31 + stage.length) | 0;
  const idx = Math.abs(hash) % list.length;
  return { slug: `${stage}_${idx}`, body: list[idx] };
}

export function applyTemplateSlots(
  body: string,
  fan: { ig_handle: string; display_name?: string | null },
): string {
  const first = fanFirstName(fan);
  return body
    .replace(/\{first_name\}/g, first)
    .replace(/\{handle\}/g, fan.ig_handle)
    .replace(/\{display_name\}/g, fan.display_name?.trim() || first);
}

export function fanFirstName(fan: { ig_handle: string; display_name?: string | null }): string {
  const fromName = (fan.display_name ?? "").trim().split(/\s+/)[0];
  if (fromName && fromName.length >= 2 && !fromName.startsWith("@")) {
    return fromName.charAt(0).toUpperCase() + fromName.slice(1).toLowerCase();
  }
  const h = fan.ig_handle.replace(/[_.]/g, " ").trim();
  const word = h.split(/\s+/)[0] || "there";
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}
