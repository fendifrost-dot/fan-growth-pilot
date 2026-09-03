/** Sync / licensing register helpers — operator-only song + pitch bookkeeping.
 *
 * Genre rules (artist-verified):
 * - MEDITATE is Hip-Hop/Rap. Never house / electronic.
 * - House/electronic pool is ONLY Balenciaga (Let Me Freeze), Electrilla,
 *   Designed For Me (Control).
 * - sync_eligible is true only when has_sample === "no".
 * - A DistroKid miss is not "unreleased". Aggregator OPEN means unknown/split.
 */

export const EVEN_ARTIST_URL = "https://www.even.biz/artists/fendi-frost";

export const MONTH1_SYNC_DEFAULT_TITLE = "Meditate";

export const AGGREGATORS = ["distrokid", "tunecore", "orchard", "open"] as const;
export type Aggregator = (typeof AGGREGATORS)[number];

export const SAMPLE_FLAGS = ["yes", "no", "unknown"] as const;
export type SampleFlag = (typeof SAMPLE_FLAGS)[number];

export const GENRE_STAMPS = ["hip_hop_rap", "house_electronic", "unknown"] as const;
export type GenreStamp = (typeof GENRE_STAMPS)[number];

export const LICENSING_RESPONSES = ["awaiting", "replied", "licensed", "declined"] as const;
export type LicensingResponse = (typeof LICENSING_RESPONSES)[number];

/** House/electronic pool — titles only, matched case-insensitively. */
export const HOUSE_ELECTRONIC_TITLES = [
  "Balenciaga (Let Me Freeze)",
  "Electrilla",
  "Designed For Me (Control)",
] as const;

export const CATALOG_SEED_TITLES = [
  "Meditate",
  "Balenciaga (Let Me Freeze)",
  "Electrilla",
  "Designed For Me (Control)",
  "Neva Too Much Prada",
] as const;

export function normalizeTitle(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function isMeditateTitle(name: string | null | undefined): boolean {
  return normalizeTitle(name) === "meditate";
}

export function isHouseElectronicTitle(name: string | null | undefined): boolean {
  const n = normalizeTitle(name);
  return (
    n === "balenciaga (let me freeze)" ||
    n === "electrilla" ||
    n.includes("designed for me")
  );
}

export function isNevaTooMuchPrada(name: string | null | undefined): boolean {
  return normalizeTitle(name).includes("neva too much prada");
}

export function computeSyncEligible(hasSample: SampleFlag | string | null | undefined): boolean {
  return hasSample === "no";
}

/** Reject house stamps on Meditate. Other titles may be stamped by the operator. */
export function assertGenreStampAllowed(
  name: string,
  genreStamp: string,
): { ok: true } | { ok: false; error: string } {
  if (isMeditateTitle(name) && genreStamp === "house_electronic") {
    return {
      ok: false,
      error: 'Meditate is Hip-Hop/Rap — never stamp it house / deep house.',
    };
  }
  return { ok: true };
}

export function parseAggregator(v: unknown): Aggregator {
  const s = String(v ?? "open").trim().toLowerCase();
  return (AGGREGATORS as readonly string[]).includes(s) ? (s as Aggregator) : "open";
}

export function parseSampleFlag(v: unknown): SampleFlag {
  const s = String(v ?? "unknown").trim().toLowerCase();
  return (SAMPLE_FLAGS as readonly string[]).includes(s) ? (s as SampleFlag) : "unknown";
}

export function parseGenreStamp(v: unknown): GenreStamp {
  const s = String(v ?? "unknown").trim().toLowerCase();
  return (GENRE_STAMPS as readonly string[]).includes(s) ? (s as GenreStamp) : "unknown";
}

export function parseLicensingResponse(v: unknown): LicensingResponse {
  const s = String(v ?? "awaiting").trim().toLowerCase();
  return (LICENSING_RESPONSES as readonly string[]).includes(s) ? (s as LicensingResponse) : "awaiting";
}

export function patchForLicensingResponse(c: LicensingResponse): {
  reply_received: boolean;
  placed: boolean;
  response_status: string;
} {
  if (c === "licensed") return { reply_received: true, placed: true, response_status: "licensed" };
  if (c === "replied") return { reply_received: true, placed: false, response_status: "replied" };
  if (c === "declined") return { reply_received: true, placed: false, response_status: "declined" };
  return { reply_received: false, placed: false, response_status: "awaiting" };
}

export function licensingResponseFromRow(r: {
  placed?: boolean | null;
  reply_received?: boolean | null;
  response_status?: string | null;
}): LicensingResponse {
  if (r.placed === true || r.response_status === "licensed") return "licensed";
  if (r.response_status === "declined") return "declined";
  if (r.reply_received === true || r.response_status === "replied") return "replied";
  return "awaiting";
}

export const GENRE_STAMP_LABEL: Record<GenreStamp, string> = {
  hip_hop_rap: "Hip-Hop/Rap",
  house_electronic: "House/Electronic",
  unknown: "Unknown",
};

export const AGGREGATOR_LABEL: Record<Aggregator, string> = {
  distrokid: "DistroKid",
  tunecore: "TuneCore",
  orchard: "Orchard",
  open: "OPEN (unknown / split)",
};

export const SAMPLE_FLAG_LABEL: Record<SampleFlag, string> = {
  yes: "Yes — has sample",
  no: "No sample",
  unknown: "Unknown",
};

/** Strip ISRC from any object before it can reach a public/unauthenticated surface. */
export function stripIsrc<T extends Record<string, unknown>>(row: T): Omit<T, "isrc"> {
  const { isrc: _omit, ...rest } = row;
  return rest;
}

const ISRC_SHAPE = /\b[A-Z]{2}[A-Z0-9]{3}\d{7}\b/i;

export function looksLikeIsrc(value: string | null | undefined): boolean {
  if (!value) return false;
  return ISRC_SHAPE.test(value.replace(/[\s-]/g, ""));
}

export function collectPublicMetadataUrls(meta: Record<string, string> | null | undefined): {
  spotify_url?: string;
  apple_music_url?: string;
  soundcloud_url?: string;
  youtube_url?: string;
  tidal_url?: string;
  even_url?: string;
} {
  if (!meta) return {};
  return {
    spotify_url: meta.spotify_url,
    apple_music_url: meta.apple_music_url,
    soundcloud_url: meta.soundcloud_url,
    youtube_url: meta.youtube_url,
    tidal_url: meta.tidal_url,
    even_url: meta.even_url,
  };
}

/** Attach the locked EVEN artist URL only when a listen-pills stack already exists. */
export function resolvePublicEvenUrl(
  slug: string | undefined,
  meta: Record<string, string> | null | undefined,
): string | null {
  if (meta?.even_url?.trim()) return meta.even_url.trim();
  const hasListenPills = Boolean(
    meta?.spotify_url ||
      meta?.apple_music_url ||
      meta?.soundcloud_url ||
      meta?.youtube_url ||
      meta?.tidal_url,
  );
  if (hasListenPills) return EVEN_ARTIST_URL;
  return null;
}
