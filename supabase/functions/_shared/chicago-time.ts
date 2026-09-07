/**
 * America/Chicago business-date helpers.
 * Never permanently encode UTC offsets — rely on Intl / Temporal-style
 * local calendar computation so DST transitions stay correct.
 */

export const AGH_OPS_TIMEZONE = "America/Chicago";

const STATION_LOCAL_TIMES: Record<string, string> = {
  playlist_discovery_begin: "04:30",
  playlist_tranche_first: "07:00",
  playlist_tranche_final: "08:30",
  sync_batch_ready: "12:00",
};

export const DAILY_STATION_IDS = [
  "playlist_discovery_begin",
  "playlist_tranche_first",
  "playlist_tranche_final",
  "sync_batch_ready",
] as const;

export type DailyStationId = (typeof DAILY_STATION_IDS)[number];

export function isDailyStationId(v: string): v is DailyStationId {
  return (DAILY_STATION_IDS as readonly string[]).includes(v);
}

/** Central-Time calendar date (YYYY-MM-DD) for an instant. */
export function chicagoBusinessDate(instant: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: AGH_OPS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

/** Local HH:MM in America/Chicago for an instant. */
export function chicagoLocalHm(instant: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: AGH_OPS_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const h = parts.find((p) => p.type === "hour")?.value ?? "00";
  const min = parts.find((p) => p.type === "minute")?.value ?? "00";
  // Some environments emit "24" for midnight — normalize.
  const hour = h === "24" ? "00" : h.padStart(2, "0");
  return `${hour}:${min.padStart(2, "0")}`;
}

export function stationLocalTime(stationId: string): string | null {
  return STATION_LOCAL_TIMES[stationId] ?? null;
}

/** Upstream station dependency map (later stations consume earlier output). */
export const STATION_UPSTREAM: Partial<Record<DailyStationId, DailyStationId>> = {
  playlist_tranche_first: "playlist_discovery_begin",
  playlist_tranche_final: "playlist_tranche_first",
  sync_batch_ready: "playlist_tranche_final",
};
