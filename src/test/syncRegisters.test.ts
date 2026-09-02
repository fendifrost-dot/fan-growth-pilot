import { describe, it, expect } from "vitest";
import {
  EVEN_ARTIST_URL,
  MONTH1_SYNC_DEFAULT_TITLE,
  TRACK_IDS,
  assertGenreStampAllowed,
  computeSyncEligible,
  isHouseElectronicTitle,
  isMeditateTitle,
  isNevaTooMuchPrada,
  looksLikeIsrc,
  parseAggregator,
  patchForLicensingResponse,
  resolvePublicEvenUrl,
  stripIsrc,
} from "@/lib/syncRegisters";
import { evaluateSyncReady } from "@/lib/catalogRules";

describe("sync register rules", () => {
  it("refuses house stamp on Meditate by UUID at the write boundary", () => {
    expect(isMeditateTitle("Meditate")).toBe(true);
    expect(assertGenreStampAllowed("Meditate", "house_electronic", TRACK_IDS.MEDITATE).ok).toBe(false);
    expect(assertGenreStampAllowed("Meditate", "hip_hop_rap", TRACK_IDS.MEDITATE).ok).toBe(true);
  });

  it("limits house/electronic writes to the three allow-listed track UUIDs", () => {
    expect(assertGenreStampAllowed("x", "house_electronic", TRACK_IDS.BALENCIAGA).ok).toBe(true);
    expect(assertGenreStampAllowed("x", "house_electronic", TRACK_IDS.ELECTRILLA).ok).toBe(true);
    expect(assertGenreStampAllowed("x", "house_electronic", TRACK_IDS.CONTROL).ok).toBe(true);
    expect(assertGenreStampAllowed("Meditate", "house_electronic", TRACK_IDS.MEDITATE).ok).toBe(false);
    expect(assertGenreStampAllowed("Neva", "house_electronic", TRACK_IDS.NEVA_TOO_MUCH_PRADA).ok).toBe(false);
    expect(assertGenreStampAllowed("Designed For Me (Control)", "house_electronic").ok).toBe(false);
  });

  it("keeps title helpers for display only", () => {
    expect(isHouseElectronicTitle("Balenciaga (Let Me Freeze)")).toBe(true);
    expect(isHouseElectronicTitle("Meditate")).toBe(false);
  });

  it("marks Neva Too Much Prada as the sampled title and never sync-eligible from sample alone", () => {
    expect(isNevaTooMuchPrada("Neva Too Much Prada")).toBe(true);
    expect(computeSyncEligible("yes")).toBe(false);
    expect(computeSyncEligible("no")).toBe(false);
  });

  it("does not treat has_sample=no as sync-eligible", () => {
    expect(computeSyncEligible("no")).toBe(false);
    expect(computeSyncEligible("yes")).toBe(false);
    expect(computeSyncEligible("unknown")).toBe(false);
    expect(evaluateSyncReady({ hasSample: "no" }).ready).toBe(false);
  });

  it("defaults unknown aggregators to OPEN (not unreleased)", () => {
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

  it("wires the locked EVEN artist URL onto existing listen-pills / runway", () => {
    expect(EVEN_ARTIST_URL).toBe("https://www.even.biz/artists/fendi-frost");
    expect(resolvePublicEvenUrl("runwaymusic", {})).toBeNull();
    expect(resolvePublicEvenUrl("runwaymusic", { spotify_url: "https://open.spotify.com/x" })).toBe(EVEN_ARTIST_URL);
    expect(resolvePublicEvenUrl("heartchakra", { spotify_url: "https://open.spotify.com/x" })).toBe(EVEN_ARTIST_URL);
    expect(resolvePublicEvenUrl("heartchakra", { even_url: "https://even.biz/custom" })).toBe("https://even.biz/custom");
    expect(resolvePublicEvenUrl("random", {})).toBeNull();
  });

  it("strips ISRC from public payloads and recognizes ISRC shape", () => {
    expect(stripIsrc({ name: "Meditate", isrc: "USXXX0000000", genre_stamp: "hip_hop_rap" })).toEqual({
      name: "Meditate",
      genre_stamp: "hip_hop_rap",
    });
    expect(looksLikeIsrc("USRC17607839")).toBe(true);
    expect(looksLikeIsrc("Meditate")).toBe(false);
  });

  it("keeps Meditate as the month-1 candidate title (not an approval)", () => {
    expect(MONTH1_SYNC_DEFAULT_TITLE).toBe("Meditate");
  });
});
