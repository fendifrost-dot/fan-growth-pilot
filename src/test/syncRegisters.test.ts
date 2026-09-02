import { describe, it, expect } from "vitest";
import {
  EVEN_ARTIST_URL,
  MONTH1_SYNC_DEFAULT_TITLE,
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

describe("sync register rules", () => {
  it("treats Meditate as Hip-Hop/Rap and refuses a house stamp", () => {
    expect(isMeditateTitle("Meditate")).toBe(true);
    expect(isMeditateTitle("  MEDITATE ")).toBe(true);
    expect(assertGenreStampAllowed("Meditate", "house_electronic").ok).toBe(false);
    expect(assertGenreStampAllowed("Meditate", "hip_hop_rap").ok).toBe(true);
  });

  it("limits the house/electronic pool to the three named titles", () => {
    expect(isHouseElectronicTitle("Balenciaga (Let Me Freeze)")).toBe(true);
    expect(isHouseElectronicTitle("Electrilla")).toBe(true);
    expect(isHouseElectronicTitle("Designed For Me (Control)")).toBe(true);
    expect(isHouseElectronicTitle("Meditate")).toBe(false);
    expect(isHouseElectronicTitle("Neva Too Much Prada")).toBe(false);
  });

  it("marks Neva Too Much Prada as the sampled title", () => {
    expect(isNevaTooMuchPrada("Neva Too Much Prada")).toBe(true);
    expect(computeSyncEligible("yes")).toBe(false);
  });

  it("is sync-eligible only when has_sample is no", () => {
    expect(computeSyncEligible("no")).toBe(true);
    expect(computeSyncEligible("yes")).toBe(false);
    expect(computeSyncEligible("unknown")).toBe(false);
    expect(computeSyncEligible(null)).toBe(false);
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

  it("keeps Meditate as the month-1 default title", () => {
    expect(MONTH1_SYNC_DEFAULT_TITLE).toBe("Meditate");
  });
});
