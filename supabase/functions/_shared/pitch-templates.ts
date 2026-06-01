export type Tone = "warm_personal" | "casual_friendly" | "business_formal" | "hyped_energetic";
export type Platform = "spotify" | "apple_music" | "soundcloud" | "youtube" | "blog";

export interface PitchContext {
  curatorName: string;
  playlistName: string;
  trackName: string;
  shortPitch: string;
  platform: Platform;
  streamUrl: string;
  isWarm: boolean;
  priorTrack?: string;
  tone: Tone;
  artistName: string;
}

export interface RenderedPitch {
  subject: string;
  body: string;
}

const PLATFORM_LINK_PREFIX: Record<Platform, string> = {
  spotify: "Stream:",
  apple_music: "Listen on Apple Music:",
  soundcloud: "Listen on SoundCloud:",
  youtube: "Watch:",
  blog: "Listen:",
};

function platformLinkLine(platform: Platform, url: string): string {
  return `${PLATFORM_LINK_PREFIX[platform]} ${url}`;
}

function requirePriorTrack(ctx: PitchContext): string {
  return ctx.priorTrack?.trim() || "your last track";
}

export function renderPitchBody(ctx: PitchContext): RenderedPitch {
  const {
    curatorName,
    playlistName,
    trackName,
    shortPitch,
    platform,
    streamUrl,
    isWarm,
    tone,
    artistName,
  } = ctx;
  const priorTrack = requirePriorTrack(ctx);
  const link = platformLinkLine(platform, streamUrl);
  const pitch = shortPitch.trim();

  if (tone === "warm_personal") {
    if (!isWarm) {
      return {
        subject: `Submission for ${playlistName}: ${artistName} — ${trackName}`,
        body: [
          `Hi ${curatorName},`,
          "",
          `I'd love to submit **${trackName}** for *${playlistName}*.`,
          "",
          pitch,
          "",
          link,
          "Happy to share extra context or a different mix if useful.",
          "Thank you for your time.",
          "",
          `— ${artistName}`,
        ].join("\n"),
      };
    }
    return {
      subject: `Thanks for the ${priorTrack} add — new release for ${playlistName}`,
      body: [
        `Hi ${curatorName},`,
        "",
        `Thank you for adding **${priorTrack}** to *${playlistName}* — meant a lot.`,
        "",
        `I just released **${trackName}** — ${pitch} Feels like it lives in the same lane as what landed last time.`,
        "",
        link,
        "",
        "No pressure if it's not the right fit. Wanted to share it with you first either way.",
        "",
        `— ${artistName}`,
      ].join("\n"),
    };
  }

  if (tone === "casual_friendly") {
    if (!isWarm) {
      return {
        subject: `${trackName} for ${playlistName} — would love your ear`,
        body: [
          `Hey ${curatorName},`,
          "",
          `Hope your week's been good. Wanted to share my new song — **${trackName}** — for *${playlistName}*.`,
          "",
          pitch,
          "",
          link,
          "",
          "Appreciate you taking a listen.",
          "",
          `— ${artistName}`,
        ].join("\n"),
      };
    }
    return {
      subject: `Round 2 — new song for ${playlistName}`,
      body: [
        `Hey ${curatorName},`,
        "",
        `Quick note — thanks again for the **${priorTrack}** add on *${playlistName}*. Really appreciated.`,
        "",
        `Just dropped **${trackName}** — ${pitch} Wanted to put it in front of you before anyone else.`,
        "",
        link,
        "",
        "Hope you dig it.",
        "",
        `— ${artistName}`,
      ].join("\n"),
    };
  }

  if (tone === "business_formal") {
    if (!isWarm) {
      return {
        subject: `Pitch: ${artistName} — ${trackName} for ${playlistName}`,
        body: [
          `Hello ${curatorName},`,
          "",
          `I'd like to submit **${trackName}** by ${artistName} for consideration in *${playlistName}*.`,
          "",
          pitch,
          "",
          link,
          "",
          "Thank you for your time and consideration.",
          "",
          "Regards,",
          artistName,
        ].join("\n"),
      };
    }
    return {
      subject: `Follow-up: new release from ${artistName} for ${playlistName}`,
      body: [
        `Hello ${curatorName},`,
        "",
        `Following up on **${priorTrack}**, which you added to *${playlistName}* — thank you again for that placement.`,
        "",
        `I'd like to share my latest release, **${trackName}**, for your consideration. ${pitch}`,
        "",
        link,
        "",
        "Thank you for your continued support.",
        "",
        "Regards,",
        artistName,
      ].join("\n"),
    };
  }

  // hyped_energetic
  if (!isWarm) {
    return {
      subject: `New heat: ${artistName} — ${trackName}`,
      body: [
        `Yo ${curatorName},`,
        "",
        `Got something I think is perfect for *${playlistName}*: **${trackName}**.`,
        "",
        pitch,
        "",
        link,
        "",
        "Run it back, let me know what you think.",
        "",
        `— ${artistName}`,
      ].join("\n"),
    };
  }
  return {
    subject: `Back with another one for ${playlistName}`,
    body: [
      `Yo ${curatorName},`,
      "",
      `Massive thanks for the **${priorTrack}** add — that played a real part in the wave.`,
      "",
      `Got the next one: **${trackName}**. ${pitch} Honestly think it might hit even harder for *${playlistName}*.`,
      "",
      link,
      "",
      "Lemme know.",
      "",
      `— ${artistName}`,
    ].join("\n"),
  };
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
