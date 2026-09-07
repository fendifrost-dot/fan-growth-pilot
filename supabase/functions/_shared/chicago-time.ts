/**
 * America/Chicago business-date helpers + station ownership.
 * Never permanently encode UTC offsets — DST-safe via Intl.
 */

export const AGH_OPS_TIMEZONE = "America/Chicago";

export const CLAUDE_STATION_IDS = [
  "playlist_discovery_begin",
  "playlist_tranche_first",
  "playlist_tranche_final",
  "sync_batch_ready",
] as const;

export const GROK_STATION_IDS = [
  "grok_playlist_review",
  "grok_playlist_send",
] as const;

export const DAILY_STATION_IDS = [
  ...CLAUDE_STATION_IDS,
  ...GROK_STATION_IDS,
] as const;

export type DailyStationId = (typeof DAILY_STATION_IDS)[number];
export type StationOwnerKind = "claude" | "grok_playlist_control";

const STATION_LOCAL_TIMES: Record<string, string> = {
  playlist_discovery_begin: "04:30",
  playlist_tranche_first: "07:00",
  playlist_tranche_final: "08:30",
  sync_batch_ready: "12:00",
  grok_playlist_review: "13:00",
  grok_playlist_send: "15:00",
};

const STATION_OWNER: Record<DailyStationId, StationOwnerKind> = {
  playlist_discovery_begin: "claude",
  playlist_tranche_first: "claude",
  playlist_tranche_final: "claude",
  sync_batch_ready: "claude",
  grok_playlist_review: "grok_playlist_control",
  grok_playlist_send: "grok_playlist_control",
};

/**
 * Scheduler behavior (documented):
 * OUTREACH_SCHEDULER_SECRET may *start* Claude stations (kick the run to
 * "running") but must not complete Claude discovery work and must never
 * operate Grok review/send stations. Completion of Claude stations requires
 * the Claude credential (or Fendi for oversight). Grok stations require
 * GROK_PLAYLIST_CONTROL_SECRET or Fendi.
 */
export const SCHEDULER_MAY_START_CLAUDE_STATIONS = true;

export function isDailyStationId(v: string): v is DailyStationId {
  return (DAILY_STATION_IDS as readonly string[]).includes(v);
}

export function isClaudeStationId(v: string): boolean {
  return (CLAUDE_STATION_IDS as readonly string[]).includes(v);
}

export function isGrokStationId(v: string): boolean {
  return (GROK_STATION_IDS as readonly string[]).includes(v);
}

export function stationOwner(stationId: string): StationOwnerKind | null {
  if (!isDailyStationId(stationId)) return null;
  return STATION_OWNER[stationId];
}

/** Upstream station dependency — Grok review cannot front-run Claude complete. */
export const STATION_UPSTREAM: Partial<Record<DailyStationId, DailyStationId>> = {
  playlist_tranche_first: "playlist_discovery_begin",
  playlist_tranche_final: "playlist_tranche_first",
  sync_batch_ready: "playlist_tranche_final",
  grok_playlist_review: "playlist_tranche_final",
  grok_playlist_send: "grok_playlist_review",
};

/** Upstream handoff queue state required before a Grok station may complete. */
export const STATION_REQUIRED_UPSTREAM_QUEUE: Partial<Record<DailyStationId, string>> = {
  grok_playlist_review: "CLAUDE_PLAYLIST_COMPLETE",
  grok_playlist_send: "APPROVED_FOR_SEND",
};

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

export function chicagoLocalHm(instant: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: AGH_OPS_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const h = parts.find((p) => p.type === "hour")?.value ?? "00";
  const min = parts.find((p) => p.type === "minute")?.value ?? "00";
  const hour = h === "24" ? "00" : h.padStart(2, "0");
  return `${hour}:${min.padStart(2, "0")}`;
}

export function stationLocalTime(stationId: string): string | null {
  return STATION_LOCAL_TIMES[stationId] ?? null;
}

/**
 * Authorize an actor to operate a station.
 * mode=start: Claude stations → claude | scheduler | fendi
 *             Grok stations → grok | fendi
 * mode=complete|resume: Claude stations → claude | fendi (NOT scheduler/service/grok)
 *                       Grok stations → grok | fendi (NOT claude/service/scheduler)
 */
export function authorizeStationOperator(
  stationId: string,
  actorKind: string,
  mode: "start" | "complete" | "resume",
): string | null {
  if (!isDailyStationId(stationId)) return `Unknown station_id: ${stationId}`;
  const owner = stationOwner(stationId)!;

  if (owner === "claude") {
    if (mode === "start") {
      if (actorKind === "claude" || actorKind === "fendi") return null;
      if (actorKind === "scheduler" && SCHEDULER_MAY_START_CLAUDE_STATIONS) return null;
      return `${actorKind} cannot start Claude station ${stationId}`;
    }
    // complete / resume — Claude credential only (Fendi oversight allowed)
    if (actorKind === "claude" || actorKind === "fendi") return null;
    if (actorKind === "grok_playlist_control") {
      return "Grok cannot complete or impersonate Claude discovery stations";
    }
    if (actorKind === "scheduler" || actorKind === "service") {
      return `${actorKind} cannot complete Claude discovery work`;
    }
    return `${actorKind} cannot operate Claude station ${stationId}`;
  }

  // Grok stations
  if (actorKind === "grok_playlist_control" || actorKind === "fendi") return null;
  if (actorKind === "claude" || actorKind === "service" || actorKind === "scheduler") {
    return `${actorKind} cannot complete Grok review or send work`;
  }
  return `${actorKind} cannot operate Grok station ${stationId}`;
}
