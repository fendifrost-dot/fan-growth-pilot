import { describe, it, expect } from "vitest";
import {
  entityDedupeKey,
  normalizeExternalId,
  normalizePlatform,
  normalizeText,
  normalizeUrl,
  opportunityDedupeKey,
} from "@/lib/opportunities/normalization";

describe("entity normalization", () => {
  it("normalizes text (case, whitespace)", () => {
    expect(normalizeText("  Deep   House  ")).toBe("deep house");
    expect(normalizeText(null)).toBe("");
  });

  it("normalizes platform to a slug", () => {
    expect(normalizePlatform("Spotify")).toBe("spotify");
    expect(normalizePlatform("Apple Music")).toBe("applemusic");
    expect(normalizePlatform(" YouTube ")).toBe("youtube");
  });

  it("normalizes handles and path ids", () => {
    expect(normalizeExternalId("@Curator")).toBe("curator");
    expect(normalizeExternalId("/playlist/37i9XYZ/")).toBe("playlist/37i9xyz");
    expect(normalizeExternalId(null)).toBe("");
  });

  it("normalizes urls (scheme, www, trailing slash)", () => {
    expect(normalizeUrl("https://www.Example.com/Path/")).toBe("example.com/path");
    expect(normalizeUrl("http://open.spotify.com/playlist/1")).toBe("open.spotify.com/playlist/1");
  });

  it("same real entity -> same key regardless of casing/handle punctuation", () => {
    const a = entityDedupeKey({
      entity_type: "playlist",
      name: "Deep House Vibes",
      platform: "Spotify",
      platform_external_id: "@37iABC",
    });
    const b = entityDedupeKey({
      entity_type: "playlist",
      name: "deep house vibes",
      platform: "spotify",
      platform_external_id: "37iabc",
    });
    expect(a).toBe(b);
    expect(a).toBe("spotify:id:37iabc");
  });

  it("falls back to url then name when no external id", () => {
    expect(
      entityDedupeKey({ entity_type: "creator", name: "X", platform: "ig", canonical_url: "https://ig.com/x/" }),
    ).toBe("ig:url:ig.com/x");
    expect(entityDedupeKey({ entity_type: "venue", name: "The Loft" })).toBe("venue:name:the loft");
  });
});

describe("opportunity dedupe keys", () => {
  it("keys on entity + type + song when a song is recommended", () => {
    expect(
      opportunityDedupeKey({ entity_id: "E1", opportunity_type: "playlist_pitch", recommended_song_id: "S1" }),
    ).toBe("e1|playlist_pitch|song:s1");
  });

  it("keys on source url when no song", () => {
    expect(
      opportunityDedupeKey({
        entity_id: "E1",
        opportunity_type: "radio_play",
        source_url: "https://Station.fm/Show/",
      }),
    ).toBe("e1|radio_play|url:station.fm/show");
  });

  it("distinct songs to the same entity are distinct opportunities", () => {
    const a = opportunityDedupeKey({ entity_id: "E1", opportunity_type: "playlist_pitch", recommended_song_id: "S1" });
    const b = opportunityDedupeKey({ entity_id: "E1", opportunity_type: "playlist_pitch", recommended_song_id: "S2" });
    expect(a).not.toBe(b);
  });
});
