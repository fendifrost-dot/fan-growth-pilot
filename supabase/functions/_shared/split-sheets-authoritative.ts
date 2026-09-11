/**
 * Authoritative split-sheet / rights helpers (pure logic + mockable RPC contract).
 *
 * Full edge handlers live elsewhere; this module owns validation, delivery policy,
 * sync-gate provenance, signed-link TTL, and audit helpers used by tests and callers.
 *
 * Honest labeling: agh_generated_summary is never "signed".
 */

import { stripSpoofedAttribution } from "./ops-actors.ts";

export const SPLIT_SHEET_STATUSES = [
  "draft",
  "awaiting_contributor_confirmation",
  "partially_confirmed",
  "ready_for_fendi_review",
  "approved",
  "final",
  "superseded",
  "disputed",
] as const;

export type SplitSheetStatus = (typeof SPLIT_SHEET_STATUSES)[number];

export const RIGHTS_DOCUMENTS_BUCKET = "rights-documents";
/** Private bucket — never set public=true. */
export const RIGHTS_DOCUMENTS_BUCKET_IS_PUBLIC = false;

export const DEFAULT_SECURE_LINK_TTL_SECONDS = 900;

export type CompositionContributorInput = {
  legal_name?: string | null;
  role?: string | null;
  split_percent?: number | string | null;
  professional_name?: string | null;
  pro_affiliation?: string | null;
  ipi_number?: string | null;
  publisher_name?: string | null;
  notes?: string | null;
};

export type MasterOwnerInput = {
  legal_name?: string | null;
  ownership_percent?: number | string | null;
  split_percent?: number | string | null;
  professional_name?: string | null;
  label_name?: string | null;
  may_license_master?: boolean;
  notes?: string | null;
};

export type ContributorSetValidation = {
  ok: boolean;
  errors: string[];
  composition_total: number;
  master_total: number;
};

function parsePercent(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  return n;
}

/** Local mirror of public._split_sheet_validate_contributor_set. */
export function validateContributorSetLocal(
  composition: CompositionContributorInput[],
  master: MasterOwnerInput[] = [],
): ContributorSetValidation {
  const errors: string[] = [];
  let compositionTotal = 0;
  let masterTotal = 0;

  if (!Array.isArray(composition) || composition.length === 0) {
    errors.push("composition_contributors_required");
  } else {
    const seen: string[] = [];
    for (const item of composition) {
      const name = String(item.legal_name ?? "").trim().toLowerCase();
      if (!name) errors.push("composition_legal_name_required");
      if (!String(item.role ?? "").trim()) errors.push("composition_role_required");
      const pct = parsePercent(item.split_percent);
      if (pct == null) {
        errors.push("composition_percent_invalid");
      } else if (pct < 0 || pct > 100) {
        errors.push("composition_percent_out_of_range");
      } else {
        compositionTotal += pct;
      }
      const key = `${name}|${String(item.role ?? "").trim().toLowerCase()}`;
      if (name && seen.includes(key)) errors.push("duplicate_composition_contributor");
      else if (name) seen.push(key);
    }
    if (Math.abs(compositionTotal - 100) > 0.001) {
      errors.push("composition_total_must_equal_100");
    }
  }

  if (Array.isArray(master) && master.length > 0) {
    const seen: string[] = [];
    for (const item of master) {
      const name = String(item.legal_name ?? "").trim().toLowerCase();
      if (!name) errors.push("master_legal_name_required");
      const pct = parsePercent(item.ownership_percent ?? item.split_percent);
      if (pct == null || pct < 0 || pct > 100) {
        errors.push("master_percent_out_of_range");
      } else {
        masterTotal += pct;
      }
      if (name && seen.includes(name)) errors.push("duplicate_master_owner");
      else if (name) seen.push(name);
    }
    if (Math.abs(masterTotal - 100) > 0.001) {
      errors.push("master_total_must_equal_100");
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    composition_total: compositionTotal,
    master_total: masterTotal,
  };
}

/**
 * Initial sync pitches must never auto-attach full split sheets.
 * Delivery is request_only / opportunity / Fendi-authorized only.
 */
export function shouldAttachSplitSheetToInitialPitch(
  _policy?: { allow_auto_attach_on_initial_pitch?: boolean } | null,
): boolean {
  // Seeded ops_settings.allow_auto_attach_on_initial_pitch is false; hard-default false.
  if (_policy?.allow_auto_attach_on_initial_pitch === true) {
    // Even if misconfigured, product rule: never auto-attach on initial pitch.
    return false;
  }
  return false;
}

export function secureLinkExpiresAt(
  nowMs: number = Date.now(),
  ttlSeconds: number = DEFAULT_SECURE_LINK_TTL_SECONDS,
): Date {
  const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0
    ? ttlSeconds
    : DEFAULT_SECURE_LINK_TTL_SECONDS;
  return new Date(nowMs + ttl * 1000);
}

export function isSecureLinkExpired(
  expiresAt: string | Date | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!expiresAt) return true;
  const t = typeof expiresAt === "string" ? Date.parse(expiresAt) : expiresAt.getTime();
  if (!Number.isFinite(t)) return true;
  return t <= nowMs;
}

/** Statuses Grok may deliver (final/approved only — never draft/superseded). */
export function isDeliverableSplitSheetStatus(status: string): boolean {
  return status === "final" || status === "approved";
}

/**
 * splits_ready alone is insufficient when provenance is unverified_legacy.
 * Only authoritative_final clears the sync eligibility gate.
 */
export function splitsReadyPassesSyncGate(track: {
  splits_ready?: boolean | null;
  splits_ready_source?: string | null;
}): boolean {
  return (
    track.splits_ready === true &&
    String(track.splits_ready_source ?? "") === "authoritative_final"
  );
}

/** Alias used by sync-eligibility / callers. */
export const splitsReadyIsAuthoritative = splitsReadyPassesSyncGate;

export type SplitSheetRow = {
  id: string;
  track_id: string;
  version_number: number;
  status: string;
  is_current?: boolean;
  composition?: CompositionContributorInput[];
  master?: MasterOwnerInput[];
  document_kind?: string;
  [key: string]: unknown;
};

export type CreateVersionRpcResult =
  | {
    ok: true;
    split_sheet_id: string;
    version_number: number;
    composition_total: number;
    master_total: number;
    previous_sheet_id: string | null;
  }
  | {
    ok: false;
    code: string;
    errors?: string[];
    composition_total?: number;
    master_total?: number;
  };

/**
 * In-memory stand-in for create_split_sheet_version RPC.
 * Failed validation must leave the store unchanged (no partial delete).
 */
export function mockCreateSplitSheetVersion(
  store: { sheets: SplitSheetRow[] },
  args: {
    track_id: string;
    composition: CompositionContributorInput[];
    master?: MasterOwnerInput[];
    title?: string | null;
  },
): CreateVersionRpcResult {
  const validation = validateContributorSetLocal(args.composition, args.master ?? []);
  if (!validation.ok) {
    return {
      ok: false,
      code: "validation_failed",
      errors: validation.errors,
      composition_total: validation.composition_total,
      master_total: validation.master_total,
    };
  }

  const prev = store.sheets.find((s) => s.track_id === args.track_id && s.is_current);
  const nextVersion =
    store.sheets
      .filter((s) => s.track_id === args.track_id)
      .reduce((m, s) => Math.max(m, s.version_number), 0) + 1;
  const id = `sheet-v${nextVersion}-${crypto.randomUUID().slice(0, 8)}`;

  if (prev) {
    prev.is_current = false;
    if (["final", "approved", "signed"].includes(prev.status)) {
      prev.status = "superseded";
    }
    prev.superseded_by = id;
  }

  store.sheets.push({
    id,
    track_id: args.track_id,
    version_number: nextVersion,
    status: "draft",
    is_current: true,
    composition: args.composition,
    master: args.master ?? [],
    document_kind: "agh_generated_summary",
    title: args.title ?? null,
  });

  return {
    ok: true,
    split_sheet_id: id,
    version_number: nextVersion,
    composition_total: validation.composition_total,
    master_total: validation.master_total,
    previous_sheet_id: prev?.id ?? null,
  };
}

/** Finalized / superseded sheets cannot be edited in place — corrections need a new version. */
export function assertSplitSheetMutable(sheet: { status: string }): {
  ok: true;
} | { ok: false; status: number; code: string; error: string } {
  if (sheet.status === "final" || sheet.status === "superseded") {
    return {
      ok: false,
      status: 410,
      code: "immutable",
      error: "Finalized split sheets are immutable; create a correction version",
    };
  }
  return { ok: true };
}

/** Deprecated in-place contributor replace — always 410. */
export function deprecatedUpdateSplitSheetContributors(): {
  status: number;
  data: { error: string; code: string };
} {
  return {
    status: 410,
    data: {
      code: "gone",
      error:
        "update_split_sheet_contributors is deprecated; use create_split_sheet_version",
    },
  };
}

export type RightsAuditEvent = {
  event_kind: string;
  track_id?: string | null;
  split_sheet_id?: string | null;
  actor_kind: string;
  actor_label: string;
  document_hash?: string | null;
  detail?: Record<string, unknown>;
  created_at: string;
};

export function recordRightsAuditEvent(
  sink: RightsAuditEvent[],
  entry: Omit<RightsAuditEvent, "created_at"> & { created_at?: string },
): RightsAuditEvent {
  const row: RightsAuditEvent = {
    ...entry,
    created_at: entry.created_at ?? new Date().toISOString(),
  };
  sink.push(row);
  return row;
}

/** Strip spoofable approval identity before persistence. */
export function sanitizeSplitSheetBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  return stripSpoofedAttribution(body);
}

/**
 * RPC contract documentation (applied via Lovable SQL Editor — not local CLI):
 *
 * create_split_sheet_version(track_id, composition jsonb, master jsonb, …)
 *   → { ok:false, code:'validation_failed', errors } WITHOUT mutating prior version
 *   → { ok:true, split_sheet_id, version_number, previous_sheet_id } and sets is_current
 *
 * finalize_split_sheet_version(…)
 *   → fendi_only when actor_kind ≠ 'fendi'
 *   → immutable when status in (final, superseded)
 *   → sets tracks.splits_ready=true, splits_ready_source='authoritative_final'
 */
export const SPLIT_SHEET_RPC_CONTRACT = {
  create_split_sheet_version: {
    validation_failed_preserves_prior: true,
    supersedes_current_on_success: true,
  },
  finalize_split_sheet_version: {
    fendi_only: true,
    immutable_when_final: true,
    sets_splits_ready_source: "authoritative_final",
  },
} as const;
