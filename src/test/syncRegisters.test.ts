import { describe, it, expect } from "vitest";
import {
  EVEN_ARTIST_URL,
  assertGenreStampAllowed,
  computeSyncEligible,
  looksLikeIsrc,
  parseAggregator,
  patchForLicensingResponse,
  resolvePublicEvenUrl,
  stripIsrc,
} from "@/lib/syncRegisters";
import {
  TRACK_IDS,
  evaluateSyncReady,
  computeSyncEligible as catalogComputeSyncEligible,
} from "@/lib/catalogRules";

describe("sync register rules", () => {
  it("never treats has_sample alone as sync-eligible", () => {
    expect(computeSyncEligible("yes")).toBe(false);
    expect(computeSyncEligible("no")).toBe(false);
    expect(computeSyncEligible("unknown")).toBe(false);
    expect(catalogComputeSyncEligible("no")).toBe(false);
    expect(evaluateSyncReady({ hasSample: "no" }).ready).toBe(false);
  });

  it("blocks house stamp when rap DNA / current stamp contradicts", () => {
    expect(
      assertGenreStampAllowed({
        genreStamp: "house_electronic",
        currentStamp: "hip_hop_rap",
      }).ok,
    ).toBe(false);
    expect(
      assertGenreStampAllowed({
        genreStamp: "house_electronic",
        approvedPrimaryGenre: "Hip-Hop/Rap",
      }).ok,
    ).toBe(false);
    expect(
      assertGenreStampAllowed({
        genreStamp: "house_electronic",
        currentStamp: "unknown",
      }).ok,
    ).toBe(true);
  });

  it("keeps Meditate UUID as the month-1 candidate identity (not an approval)", () => {
    expect(TRACK_IDS.MEDITATE).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("defaults unknown aggregators to open (not unreleased)", () => {
    expect(parseAggregator("distrokid")).toBe("distrokid");
    expect(parseAggregator("whatever")).toBe("open");
    expect(parseAggregator(undefined)).toBe("open");
  });

  it("maps licensing responses the same way playlist pitch_log does", () => {
    expect(patchForLicensingResponse("licensed")).toEqual({
      reply_received: true,
      placed: true,
      response_status: "licensed",
    });
    expect(patchForLicensingResponse("awaiting")).toEqual({
      reply_received: false,
      placed: false,
      response_status: "awaiting",
    });
  });

  it("wires the locked EVEN artist URL onto listen-pills / runway", () => {
    expect(EVEN_ARTIST_URL).toContain("even");
    expect(resolvePublicEvenUrl("runwaymusic", {})).toBeNull();
    expect(
      resolvePublicEvenUrl("runwaymusic", { spotify_url: "https://open.spotify.com/x" }),
    ).toBe(EVEN_ARTIST_URL);
  });

  it("strips ISRC from public payloads and recognizes ISRC shape", () => {
    expect(stripIsrc({ name: "Meditate", isrc: "USXXX0000000", genre_stamp: "hip_hop_rap" })).toEqual({
      name: "Meditate",
      genre_stamp: "hip_hop_rap",
    });
    expect(looksLikeIsrc("USRC17607839")).toBe(true);
    expect(looksLikeIsrc("Meditate")).toBe(false);
  });
});
