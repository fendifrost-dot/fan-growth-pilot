/**
 * Authoritative split-sheet / ownership summary stack.
 *
 * Versions are created atomically via RPC `create_split_sheet_version`
 * (never delete-then-insert contributors in place). Finalize is Fendi-only
 * via `finalize_split_sheet_version`. Document kinds are honest:
 * agh_generated_summary ≠ signed.
 *
 * Claude may draft / identify gaps. Claude may NOT finalize, deliver,
 * invent ownership, or change eligibility. Ordinary admin ≠ Fendi.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import type { Actor } from "./outreach-auth.ts";
import {
  attributionFrom,
  can,
  resolveOpsActor,
  stripSpoofedAttribution,
  type OpsActor,
} from "./ops-actors.ts";

export type Result = { status: number; data: Record<string, unknown> };

export const SPLIT_SHEET_ACTIONS = [
  "list_split_sheets",
  "get_split_sheet",
  "create_split_sheet_version",
  "regenerate_split_sheet_document",
  "record_contributor_confirmation",
  "upload_split_sheet_evidence",
  "mark_split_sheet_disputed",
  "submit_split_sheet_for_fendi_review",
  "finalize_split_sheet",
  "get_split_sheet_signed_url",
  "get_track_split_readiness",
] as const;

export function isSplitSheetAction(action: string): boolean {
  return (
    (SPLIT_SHEET_ACTIONS as readonly string[]).includes(action) ||
    action === "update_split_sheet_contributors" ||
    action === "create_split_sheet"
  );
}

export const DOCUMENT_KINDS = [
  "agh_generated_summary",
  "contributor_confirmed",
  "uploaded_signed",
  "provider_signed",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const RIGHTS_DOCUMENTS_BUCKET = "rights-documents";

export type CompositionContributorInput = {
  legal_name?: string | null;
  professional_name?: string | null;
  role?: string | null;
  split_percent?: number | null;
  ipi_number?: string | null;
  pro_affiliation?: string | null;
  publisher_name?: string | null;
  publishing_administrator?: string | null;
  share_controlled?: boolean | null;
  contact_email?: string | null;
  notes?: string | null;
};

export type MasterOwnerInput = {
  legal_name?: string | null;
  professional_name?: string | null;
  ownership_percent?: number | null;
  split_percent?: number | null;
  label_name?: string | null;
  may_license_master?: boolean | null;
  evidence_reference?: string | null;
  notes?: string | null;
};

export type ContributorSetValidation = {
  ok: boolean;
  errors: string[];
  composition_total: number;
  master_total: number;
};

const SPOOF_EXTRA = [
  "fendi_approved_by",
  "fendi_reviewed_by",
  "finalized_by",
  "approved_by",
  "confirmed_by",
  "verified_by",
  "uploaded_by",
] as const;

function cleanBody(body: Record<string, unknown>): Record<string, unknown> {
  const out = stripSpoofedAttribution(body);
  for (const key of SPOOF_EXTRA) delete out[key];
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function documentKindLabel(kind: string): string {
  switch (kind) {
    case "contributor_confirmed":
      return "Contributor-confirmed ownership summary";
    case "uploaded_signed":
      return "Uploaded signed split sheet";
    case "provider_signed":
      return "Provider-signed split sheet";
    case "agh_generated_summary":
    default:
      return "AGH-generated ownership summary (not a signed instrument)";
  }
}

function isClaudeKind(ops: OpsActor): boolean {
  return (
    ops.kind === "claude" ||
    ops.kind === "claude_sync_discovery" ||
    ops.kind === "claude_playlist_discovery"
  );
}

function canReadSplitSheets(ops: OpsActor): boolean {
  return ops.kind !== "anonymous";
}

function canDraftSplitSheets(ops: OpsActor): boolean {
  return (
    ops.kind === "claude" ||
    ops.kind === "claude_sync_discovery" ||
    ops.kind === "fendi" ||
    ops.kind === "human_admin" ||
    ops.kind === "service"
  );
}

function canManageRightsEvidence(ops: OpsActor): boolean {
  return ops.kind === "fendi" || ops.kind === "human_admin";
}

function denyClaudeMutateEligibility(ops: OpsActor): Result | null {
  if (isClaudeKind(ops)) {
    return {
      status: 403,
      data: {
        error:
          "Claude may draft and identify gaps but may not finalize, deliver, invent ownership, or change eligibility",
        code: "claude_split_sheet_denied",
      },
    };
  }
  return null;
}

/** Local mirror of `_split_sheet_validate_contributor_set`. */
export function validateContributorSetLocal(
  composition: CompositionContributorInput[],
  master: MasterOwnerInput[] = [],
): ContributorSetValidation {
  const errors: string[] = [];
  let compositionTotal = 0;
  let masterTotal = 0;
  const seenComp: string[] = [];
  const seenMaster: string[] = [];

  if (!composition.length) {
    errors.push("composition_contributors_required");
  } else {
    for (const c of composition) {
      const name = String(c.legal_name ?? "").trim().toLowerCase();
      const role = String(c.role ?? "").trim();
      if (!name) errors.push("composition_legal_name_required");
      if (!role) errors.push("composition_role_required");
      const pct = c.split_percent == null ? NaN : Number(c.split_percent);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        errors.push("composition_percent_out_of_range");
      } else {
        compositionTotal += pct;
      }
      const key = `${name}|${role.toLowerCase()}`;
      if (name && seenComp.includes(key)) errors.push("duplicate_composition_contributor");
      else if (name) seenComp.push(key);
    }
    if (Math.abs(compositionTotal - 100) > 0.001) {
      errors.push("composition_total_must_equal_100");
    }
  }

  for (const m of master) {
    const name = String(m.legal_name ?? "").trim().toLowerCase();
    if (!name) errors.push("master_legal_name_required");
    const raw = m.ownership_percent ?? m.split_percent;
    const pct = raw == null ? NaN : Number(raw);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      errors.push("master_percent_out_of_range");
    } else {
      masterTotal += pct;
    }
    if (name && seenMaster.includes(name)) errors.push("duplicate_master_owner");
    else if (name) seenMaster.push(name);
  }
  if (master.length && Math.abs(masterTotal - 100) > 0.001) {
    errors.push("master_total_must_equal_100");
  }

  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    composition_total: compositionTotal,
    master_total: masterTotal,
  };
}

/** SHA-256 hex of UTF-8 HTML (Web Crypto). */
export async function computeDocumentHash(html: string): Promise<string> {
  const bytes = new TextEncoder().encode(html);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function renderAuthoritativeSplitSheetHtml(opts: {
  trackName: string;
  title?: string | null;
  versionNumber: number;
  documentKind: string;
  documentHash?: string | null;
  oneStopMaster?: boolean;
  publishingControlled?: boolean;
  masterControlled?: boolean;
  composition: CompositionContributorInput[];
  master: MasterOwnerInput[];
  generatedAt: string;
  status?: string | null;
}): string {
  const kindLabel = documentKindLabel(opts.documentKind);
  const compRows = opts.composition
    .map(
      (c) =>
        `<tr><td>${escapeHtml(String(c.legal_name ?? ""))}</td><td>${escapeHtml(
          String(c.professional_name ?? ""),
        )}</td><td>${escapeHtml(String(c.role ?? ""))}</td><td>${
          c.split_percent == null ? "—" : `${Number(c.split_percent)}%`
        }</td><td>${escapeHtml(String(c.pro_affiliation ?? ""))}</td><td>${escapeHtml(
          String(c.ipi_number ?? ""),
        )}</td><td>${escapeHtml(String(c.publisher_name ?? ""))}</td></tr>`,
    )
    .join("");
  const masterRows = opts.master
    .map((m) => {
      const pct = m.ownership_percent ?? m.split_percent;
      return `<tr><td>${escapeHtml(String(m.legal_name ?? ""))}</td><td>${escapeHtml(
        String(m.professional_name ?? ""),
      )}</td><td>${pct == null ? "—" : `${Number(pct)}%`}</td><td>${escapeHtml(
        String(m.label_name ?? ""),
      )}</td><td>${m.may_license_master ? "yes" : "no"}</td></tr>`;
    })
    .join("");
  const oneStop = opts.oneStopMaster
    ? "One-stop master licensing indicated"
    : "One-stop master licensing not asserted";
  const title = opts.title || `Ownership summary — ${opts.trackName}`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
body{font-family:Georgia,"Times New Roman",serif;max-width:820px;margin:2rem auto;padding:0 1rem;color:#1a1a1a;line-height:1.45}
h1{font-size:1.45rem;margin-bottom:.25rem}h2{font-size:1.1rem;margin-top:1.75rem;border-bottom:1px solid #ccc;padding-bottom:.25rem}
.meta{color:#444;font-size:.9rem}.notice{background:#f7f4ee;border:1px solid #d9d0c0;padding:1rem;margin:1.25rem 0}
table{width:100%;border-collapse:collapse;margin:.75rem 0}th,td{border:1px solid #bbb;padding:.45rem .55rem;text-align:left;font-size:.92rem}
th{background:#f0ede6}.hash{font-family:ui-monospace,Menlo,monospace;font-size:.78rem;word-break:break-all}
.footer{margin-top:2rem;font-size:.85rem;color:#555}
</style></head><body>
<h1>${escapeHtml(title)}</h1>
<p class="meta">Track: ${escapeHtml(opts.trackName)} · Version ${opts.versionNumber}${
    opts.status ? ` · Status: ${escapeHtml(String(opts.status))}` : ""
  }</p>
<p class="meta">Document class: <strong>${escapeHtml(kindLabel)}</strong></p>
<div class="notice"><strong>Confidential.</strong> This document is an internal ownership
summary for sync/licensing operations. It is not a public release. Unsigned AGH-generated
HTML must never be labeled or treated as a signed legal instrument.</div>
<h2>Composition ownership</h2>
<table><thead><tr><th>Legal name</th><th>Professional</th><th>Role</th><th>Share %</th><th>PRO</th><th>IPI</th><th>Publisher</th></tr></thead>
<tbody>${compRows || "<tr><td colspan=7>No composition contributors</td></tr>"}</tbody></table>
<h2>Master ownership</h2>
<table><thead><tr><th>Legal name</th><th>Professional</th><th>Ownership %</th><th>Label</th><th>May license</th></tr></thead>
<tbody>${masterRows || "<tr><td colspan=5>No master owners listed</td></tr>"}</tbody></table>
<p><strong>One-stop status:</strong> ${escapeHtml(oneStop)}.
Publishing controlled: ${opts.publishingControlled ? "yes" : "no"}.
Master controlled: ${opts.masterControlled ? "yes" : "no"}.</p>
<p class="footer">Generated ${escapeHtml(opts.generatedAt)}
${opts.documentHash ? ` · Document hash (SHA-256): <span class="hash">${escapeHtml(opts.documentHash)}</span>` : ""}</p>
</body></html>`;
}

/** Server-side readiness derivation from a sheet row (pure). */
export function deriveSplitsReadyFromSheet(sheet: {
  status?: string | null;
  is_current?: boolean | null;
  document_kind?: string | null;
}): { splits_ready: boolean; splits_ready_source: string } {
  const finalOk =
    String(sheet.status ?? "") === "final" &&
    sheet.is_current === true &&
    DOCUMENT_KINDS.includes(String(sheet.document_kind ?? "") as DocumentKind);
  if (finalOk) {
    return { splits_ready: true, splits_ready_source: "authoritative_final" };
  }
  return { splits_ready: false, splits_ready_source: "none" };
}

/**
 * Operational disclosure for initial sync pitches — never attaches the full sheet.
 */
export function initialPitchRightsDisclosure(input?: {
  track_name?: string | null;
  splits_ready?: boolean | null;
  splits_ready_source?: string | null;
}): Record<string, unknown> {
  return {
    split_sheet_attached: false,
    split_sheet_delivery_policy: "request_only",
    disclosure:
      "Full ownership documentation is available on request under AGH request_only delivery policy. Initial sync pitches do not attach split sheets.",
    track_name: input?.track_name ?? null,
    splits_ready: input?.splits_ready === true,
    splits_ready_source: input?.splits_ready_source ?? null,
    document_included: false,
  };
}

function storagePath(trackId: string, sheetId: string, version: number): string {
  return `tracks/${trackId}/split-sheets/${sheetId}/v${version}.html`;
}

async function storeHtml(
  sb: SupabaseClient,
  path: string,
  html: string,
): Promise<{ ok: boolean; path: string | null; error?: string }> {
  try {
    const { error } = await sb.storage.from(RIGHTS_DOCUMENTS_BUCKET).upload(path, html, {
      contentType: "text/html; charset=utf-8",
      upsert: true,
    });
    if (error) {
      // Tolerate missing bucket in tests / pre-migration environments.
      return { ok: false, path: null, error: error.message };
    }
    return { ok: true, path };
  } catch (e) {
    return { ok: false, path: null, error: e instanceof Error ? e.message : String(e) };
  }
}

async function auditEvent(
  sb: SupabaseClient,
  entry: {
    track_id: string | null;
    split_sheet_id: string | null;
    event_kind: string;
    ops: OpsActor;
    document_hash?: string | null;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  const attr = attributionFrom(entry.ops);
  await sb.from("rights_document_audit_events").insert({
    track_id: entry.track_id,
    split_sheet_id: entry.split_sheet_id,
    event_kind: entry.event_kind,
    actor_kind: attr.actor_kind,
    actor_label: attr.actor_label,
    actor_user_id: attr.actor_user_id,
    document_hash: entry.document_hash ?? null,
    detail: entry.detail ?? {},
  });
}

async function loadSheetBundle(
  sb: SupabaseClient,
  sheetId: string,
): Promise<Result> {
  const { data: sheet, error } = await sb.from("split_sheets").select("*").eq("id", sheetId)
    .maybeSingle();
  if (error) return { status: 500, data: { error: error.message } };
  if (!sheet) return { status: 404, data: { error: "Not found" } };
  const { data: contributors } = await sb
    .from("split_sheet_contributors")
    .select("*")
    .eq("split_sheet_id", sheetId)
    .order("sort_order");
  const { data: master } = await sb
    .from("split_sheet_master_owners")
    .select("*")
    .eq("split_sheet_id", sheetId)
    .order("sort_order");
  return {
    status: 200,
    data: {
      ok: true,
      sheet,
      contributors: contributors ?? [],
      master_owners: master ?? [],
    },
  };
}

export async function runSplitSheetAction(
  action: string,
  body: Record<string, unknown>,
  sb: SupabaseClient,
  actor: Actor | null = null,
  req: Request | null = null,
): Promise<Result> {
  // Legacy destructive path retired — never delete-then-insert contributors.
  if (action === "update_split_sheet_contributors" || action === "create_split_sheet") {
    return {
      status: 410,
      data: {
        error:
          "update_split_sheet_contributors / create_split_sheet retired. Use create_split_sheet_version (atomic RPC).",
        code: "split_sheet_destructive_path_retired",
      },
    };
  }

  const ops = resolveOpsActor(actor, req);
  const clean = cleanBody(body);

  switch (action) {
    case "list_split_sheets": {
      if (!canReadSplitSheets(ops)) {
        return { status: 401, data: { error: "Authentication required" } };
      }
      const trackId = String(clean.track_id ?? "").trim();
      let q = sb
        .from("split_sheets")
        .select(
          "id, track_id, version_number, status, title, notes, action_items, document_kind, document_hash, document_storage_path, is_current, composition_total_percent, master_total_percent, one_stop_master, publishing_controlled, master_controlled, finalized_at, created_at, updated_at, tracks(name)",
        )
        .order("version_number", { ascending: false })
        .limit(100);
      if (trackId) q = q.eq("track_id", trackId);
      const { data, error } = await q;
      if (error) {
        return {
          status: 503,
          data: {
            error: `split_sheets unavailable (${error.message}). Apply 20260911160000 via Lovable SQL Editor.`,
          },
        };
      }
      const rows = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
        ...r,
        track_name: (r.tracks as { name?: string } | null)?.name ?? null,
        tracks: undefined,
      }));
      return { status: 200, data: { ok: true, rows } };
    }

    case "get_split_sheet": {
      if (!canReadSplitSheets(ops)) {
        return { status: 401, data: { error: "Authentication required" } };
      }
      const id = String(clean.split_sheet_id ?? clean.id ?? "").trim();
      if (!id) return { status: 400, data: { error: "split_sheet_id required" } };
      return loadSheetBundle(sb, id);
    }

    case "create_split_sheet_version": {
      if (!canDraftSplitSheets(ops)) {
        return {
          status: 403,
          data: { error: `${ops.label} may not create split-sheet versions` },
        };
      }
      const trackId = String(clean.track_id ?? "").trim();
      if (!trackId) return { status: 400, data: { error: "track_id required" } };

      const composition = (Array.isArray(clean.composition)
        ? clean.composition
        : Array.isArray(clean.contributors)
        ? clean.contributors
        : []) as CompositionContributorInput[];
      const master = (Array.isArray(clean.master)
        ? clean.master
        : Array.isArray(clean.master_owners)
        ? clean.master_owners
        : []) as MasterOwnerInput[];

      const validation = validateContributorSetLocal(composition, master);
      if (!validation.ok) {
        return {
          status: 422,
          data: {
            error: "contributor set validation failed",
            code: "validation_failed",
            ...validation,
          },
        };
      }

      const { data: track } = await sb.from("tracks").select("id, name").eq("id", trackId)
        .maybeSingle();
      if (!track) return { status: 404, data: { error: "Track not found" } };

      // Preview next version for HTML; RPC assigns authoritative version_number.
      const { data: latest } = await sb
        .from("split_sheets")
        .select("version_number")
        .eq("track_id", trackId)
        .order("version_number", { ascending: false })
        .limit(1)
        .maybeSingle();
      const previewVersion = Number(latest?.version_number ?? 0) + 1;
      const now = new Date().toISOString();
      const title = clean.title != null
        ? String(clean.title)
        : `Ownership summary — ${track.name}`;
      const html = renderAuthoritativeSplitSheetHtml({
        trackName: String(track.name),
        title,
        versionNumber: previewVersion,
        documentKind: "agh_generated_summary",
        composition,
        master,
        generatedAt: now,
        oneStopMaster: clean.one_stop_master === true,
        publishingControlled: clean.publishing_controlled === true,
        masterControlled: clean.master_controlled === true,
        status: "draft",
      });
      const documentHash = await computeDocumentHash(html);
      const htmlWithHash = renderAuthoritativeSplitSheetHtml({
        trackName: String(track.name),
        title,
        versionNumber: previewVersion,
        documentKind: "agh_generated_summary",
        documentHash,
        composition,
        master,
        generatedAt: now,
        oneStopMaster: clean.one_stop_master === true,
        publishingControlled: clean.publishing_controlled === true,
        masterControlled: clean.master_controlled === true,
        status: "draft",
      });
      const finalHash = await computeDocumentHash(htmlWithHash);
      const attr = attributionFrom(ops);

      const { data: rpcData, error: rpcErr } = await sb.rpc("create_split_sheet_version", {
        p_track_id: trackId,
        p_composition: composition,
        p_master: master,
        p_title: title,
        p_notes: clean.notes == null ? null : String(clean.notes),
        p_one_stop_master: clean.one_stop_master === true,
        p_publishing_controlled: clean.publishing_controlled === true,
        p_master_controlled: clean.master_controlled === true,
        p_actor_kind: attr.actor_kind,
        p_actor_label: attr.actor_label,
        p_actor_user_id: attr.actor_user_id,
        p_generated_html: htmlWithHash,
        p_document_hash: finalHash,
      });
      if (rpcErr) {
        return { status: 500, data: { error: rpcErr.message, code: "rpc_failed" } };
      }
      const result = (rpcData ?? {}) as Record<string, unknown>;
      if (result.ok !== true) {
        return {
          status: 422,
          data: { error: "create_split_sheet_version rejected", ...result },
        };
      }

      const sheetId = String(result.split_sheet_id);
      const versionNumber = Number(result.version_number ?? previewVersion);
      const path = storagePath(trackId, sheetId, versionNumber);
      const stored = await storeHtml(sb, path, htmlWithHash);
      if (stored.ok && stored.path) {
        await sb
          .from("split_sheets")
          .update({
            document_storage_path: stored.path,
            document_mime: "text/html",
            updated_at: new Date().toISOString(),
          })
          .eq("id", sheetId);
      }

      const bundle = await loadSheetBundle(sb, sheetId);
      return {
        status: 200,
        data: {
          ok: true,
          rpc: result,
          storage: stored,
          document_hash: finalHash,
          document_kind: "agh_generated_summary",
          sheet: bundle.data.sheet ?? null,
          contributors: bundle.data.contributors ?? [],
          master_owners: bundle.data.master_owners ?? [],
        },
      };
    }

    case "regenerate_split_sheet_document": {
      if (!canDraftSplitSheets(ops)) {
        return { status: 403, data: { error: `${ops.label} may not regenerate documents` } };
      }
      const id = String(clean.split_sheet_id ?? "").trim();
      if (!id) return { status: 400, data: { error: "split_sheet_id required" } };
      const bundle = await loadSheetBundle(sb, id);
      if (bundle.status !== 200) return bundle;
      const sheet = bundle.data.sheet as Record<string, unknown>;
      if (String(sheet.status) === "final" || String(sheet.status) === "superseded") {
        return {
          status: 409,
          data: { error: "finalized/superseded versions are immutable", code: "immutable" },
        };
      }
      const contributors = (bundle.data.contributors as Record<string, unknown>[]).filter(
        (c) => String(c.ownership_side ?? "composition") === "composition",
      ) as CompositionContributorInput[];
      const masterFromTable = (bundle.data.master_owners as MasterOwnerInput[]) ?? [];
      const masterFromContrib = (
        (bundle.data.contributors as Record<string, unknown>[]).filter(
          (c) => String(c.ownership_side) === "master",
        ) as MasterOwnerInput[]
      ).map((c) => ({
        ...c,
        ownership_percent: (c as { split_percent?: number }).split_percent,
      }));
      const master = masterFromTable.length ? masterFromTable : masterFromContrib;
      const { data: track } = await sb.from("tracks").select("name").eq("id", sheet.track_id)
        .maybeSingle();
      const now = new Date().toISOString();
      const kind = String(sheet.document_kind ?? "agh_generated_summary");
      const htmlBase = renderAuthoritativeSplitSheetHtml({
        trackName: String(track?.name ?? "Track"),
        title: sheet.title as string | null,
        versionNumber: Number(sheet.version_number ?? 1),
        documentKind: kind,
        composition: contributors,
        master,
        generatedAt: now,
        oneStopMaster: sheet.one_stop_master === true,
        publishingControlled: sheet.publishing_controlled === true,
        masterControlled: sheet.master_controlled === true,
        status: String(sheet.status ?? ""),
      });
      const hash = await computeDocumentHash(htmlBase);
      const html = renderAuthoritativeSplitSheetHtml({
        trackName: String(track?.name ?? "Track"),
        title: sheet.title as string | null,
        versionNumber: Number(sheet.version_number ?? 1),
        documentKind: kind,
        documentHash: hash,
        composition: contributors,
        master,
        generatedAt: now,
        oneStopMaster: sheet.one_stop_master === true,
        publishingControlled: sheet.publishing_controlled === true,
        masterControlled: sheet.master_controlled === true,
        status: String(sheet.status ?? ""),
      });
      const finalHash = await computeDocumentHash(html);
      const path = storagePath(
        String(sheet.track_id),
        id,
        Number(sheet.version_number ?? 1),
      );
      const stored = await storeHtml(sb, path, html);
      const { data, error } = await sb
        .from("split_sheets")
        .update({
          generated_html: html,
          document_hash: finalHash,
          document_storage_path: stored.ok ? path : sheet.document_storage_path,
          document_mime: "text/html",
          updated_at: now,
        })
        .eq("id", id)
        .select("*")
        .single();
      if (error) return { status: 500, data: { error: error.message } };
      return {
        status: 200,
        data: {
          ok: true,
          sheet: data,
          document_hash: finalHash,
          document_kind: kind,
          storage: stored,
        },
      };
    }

    case "record_contributor_confirmation": {
      const denied = denyClaudeMutateEligibility(ops);
      if (denied) return denied;
      if (!canManageRightsEvidence(ops) && ops.kind !== "service") {
        return { status: 403, data: { error: `${ops.label} may not record confirmations` } };
      }
      const sheetId = String(clean.split_sheet_id ?? "").trim();
      const contributorId = String(clean.contributor_id ?? "").trim();
      if (!sheetId || !contributorId) {
        return { status: 400, data: { error: "split_sheet_id and contributor_id required" } };
      }
      const status = String(clean.confirmation_status ?? "confirmed").trim();
      if (!["confirmed", "disputed", "waived_by_fendi", "unconfirmed"].includes(status)) {
        return { status: 400, data: { error: "invalid confirmation_status" } };
      }
      if (status === "waived_by_fendi" && ops.kind !== "fendi") {
        return { status: 403, data: { error: "waived_by_fendi is Fendi-only" } };
      }
      const attr = attributionFrom(ops);
      const now = new Date().toISOString();
      const { data, error } = await sb
        .from("split_sheet_contributors")
        .update({
          confirmation_status: status,
          confirmed_at: status === "confirmed" || status === "waived_by_fendi" ? now : null,
          confirmed_by: attr.actor_label,
          confirmation_method: clean.confirmation_method != null
            ? String(clean.confirmation_method)
            : "ops_record",
          updated_at: now,
        })
        .eq("id", contributorId)
        .eq("split_sheet_id", sheetId)
        .select("*")
        .single();
      if (error) return { status: 500, data: { error: error.message } };

      const { data: sheet } = await sb.from("split_sheets").select("track_id, status")
        .eq("id", sheetId).maybeSingle();
      if (sheet && String(sheet.status) !== "final") {
        const { count } = await sb
          .from("split_sheet_contributors")
          .select("id", { count: "exact", head: true })
          .eq("split_sheet_id", sheetId)
          .eq("ownership_side", "composition")
          .not("confirmation_status", "in", "(confirmed,waived_by_fendi)");
        const nextStatus = (count ?? 0) === 0
          ? "ready_for_fendi_review"
          : "partially_confirmed";
        await sb.from("split_sheets").update({
          status: nextStatus,
          awaiting_confirmation_at: now,
          updated_at: now,
        }).eq("id", sheetId);
      }
      await auditEvent(sb, {
        track_id: sheet ? String(sheet.track_id) : null,
        split_sheet_id: sheetId,
        event_kind: "confirm",
        ops,
        detail: { contributor_id: contributorId, confirmation_status: status },
      });
      return { status: 200, data: { ok: true, contributor: data } };
    }

    case "upload_split_sheet_evidence": {
      const denied = denyClaudeMutateEligibility(ops);
      if (denied) return denied;
      if (!canManageRightsEvidence(ops)) {
        return { status: 403, data: { error: `${ops.label} may not upload rights evidence` } };
      }
      const sheetId = String(clean.split_sheet_id ?? "").trim();
      const trackId = String(clean.track_id ?? "").trim();
      if (!sheetId || !trackId) {
        return { status: 400, data: { error: "split_sheet_id and track_id required" } };
      }
      const evidenceKind = String(clean.evidence_kind ?? "uploaded_signed_split").trim();
      const attr = attributionFrom(ops);
      const storagePathVal = clean.storage_path != null ? String(clean.storage_path) : null;
      const { data, error } = await sb
        .from("split_sheet_evidence")
        .insert({
          split_sheet_id: sheetId,
          track_id: trackId,
          evidence_kind: evidenceKind,
          storage_path: storagePathVal,
          document_hash: clean.document_hash != null ? String(clean.document_hash) : null,
          mime_type: clean.mime_type != null ? String(clean.mime_type) : null,
          provider_reference: clean.provider_reference != null
            ? String(clean.provider_reference)
            : null,
          notes: clean.notes == null ? null : String(clean.notes),
          uploaded_by: attr.actor_label,
          verification_status: "unverified",
        })
        .select("*")
        .single();
      if (error) return { status: 500, data: { error: error.message } };

      // Honest document_kind upgrade when signed evidence is attached — never invent "signed" for HTML alone.
      if (evidenceKind === "uploaded_signed_split" || evidenceKind === "signature_provider_ref") {
        const nextKind = evidenceKind === "signature_provider_ref"
          ? "provider_signed"
          : "uploaded_signed";
        await sb.from("split_sheets").update({
          document_kind: nextKind,
          updated_at: new Date().toISOString(),
        }).eq("id", sheetId).neq("status", "final");
      }
      await auditEvent(sb, {
        track_id: trackId,
        split_sheet_id: sheetId,
        event_kind: "evidence_upload",
        ops,
        document_hash: clean.document_hash != null ? String(clean.document_hash) : null,
        detail: { evidence_id: data.id, evidence_kind: evidenceKind },
      });
      return { status: 200, data: { ok: true, evidence: data } };
    }

    case "mark_split_sheet_disputed": {
      const denied = denyClaudeMutateEligibility(ops);
      if (denied) return denied;
      if (!canManageRightsEvidence(ops)) {
        return { status: 403, data: { error: `${ops.label} may not mark disputes` } };
      }
      const sheetId = String(clean.split_sheet_id ?? "").trim();
      const reason = String(clean.dispute_reason ?? clean.reason ?? "").trim();
      if (!sheetId || !reason) {
        return { status: 400, data: { error: "split_sheet_id and dispute_reason required" } };
      }
      const { data: sheet, error: sErr } = await sb.from("split_sheets").select("*").eq("id", sheetId)
        .maybeSingle();
      if (sErr) return { status: 500, data: { error: sErr.message } };
      if (!sheet) return { status: 404, data: { error: "Not found" } };
      const now = new Date().toISOString();
      const { data, error } = await sb
        .from("split_sheets")
        .update({
          status: "disputed",
          dispute_reason: reason,
          updated_at: now,
        })
        .eq("id", sheetId)
        .select("*")
        .single();
      if (error) return { status: 500, data: { error: error.message } };
      await sb.from("tracks").update({
        splits_ready: false,
        splits_ready_source: "none",
        updated_at: now,
      }).eq("id", sheet.track_id);
      await auditEvent(sb, {
        track_id: String(sheet.track_id),
        split_sheet_id: sheetId,
        event_kind: "dispute",
        ops,
        detail: { dispute_reason: reason },
      });
      return { status: 200, data: { ok: true, sheet: data, splits_ready: false } };
    }

    case "submit_split_sheet_for_fendi_review": {
      if (!canDraftSplitSheets(ops) && !canManageRightsEvidence(ops)) {
        return { status: 403, data: { error: `${ops.label} may not submit for review` } };
      }
      const sheetId = String(clean.split_sheet_id ?? "").trim();
      if (!sheetId) return { status: 400, data: { error: "split_sheet_id required" } };
      const { data: sheet } = await sb.from("split_sheets").select("*").eq("id", sheetId)
        .maybeSingle();
      if (!sheet) return { status: 404, data: { error: "Not found" } };
      if (String(sheet.status) === "final") {
        return { status: 409, data: { error: "already finalized", code: "immutable" } };
      }
      const now = new Date().toISOString();
      const { data, error } = await sb
        .from("split_sheets")
        .update({
          status: "ready_for_fendi_review",
          awaiting_confirmation_at: now,
          updated_at: now,
        })
        .eq("id", sheetId)
        .select("*")
        .single();
      if (error) return { status: 500, data: { error: error.message } };
      return { status: 200, data: { ok: true, sheet: data } };
    }

    case "finalize_split_sheet": {
      // Exact Fendi identity only — ordinary admin ≠ Fendi.
      if (ops.kind !== "fendi") {
        return {
          status: 403,
          data: {
            error: "finalize_split_sheet is Fendi-only (exact ARTIST_USER_ID)",
            code: "fendi_only",
          },
        };
      }
      const sheetId = String(clean.split_sheet_id ?? "").trim();
      if (!sheetId) return { status: 400, data: { error: "split_sheet_id required" } };
      const bundle = await loadSheetBundle(sb, sheetId);
      if (bundle.status !== 200) return bundle;
      const sheet = bundle.data.sheet as Record<string, unknown>;
      if (String(sheet.status) === "disputed") {
        return { status: 409, data: { error: "cannot finalize disputed sheet", code: "disputed" } };
      }

      const contributors = (bundle.data.contributors as Record<string, unknown>[]).filter(
        (c) => String(c.ownership_side ?? "composition") === "composition",
      ) as CompositionContributorInput[];
      const master = (bundle.data.master_owners as MasterOwnerInput[]) ?? [];
      const { data: track } = await sb.from("tracks").select("name").eq("id", sheet.track_id)
        .maybeSingle();
      const now = new Date().toISOString();
      let documentKind = String(
        clean.document_kind ?? sheet.document_kind ?? "agh_generated_summary",
      );
      if (!DOCUMENT_KINDS.includes(documentKind as DocumentKind)) {
        return { status: 400, data: { error: "invalid document_kind" } };
      }
      // Never label unsigned HTML as signed.
      if (
        (documentKind === "uploaded_signed" || documentKind === "provider_signed") &&
        !clean.evidence_verified &&
        String(sheet.document_kind) === "agh_generated_summary"
      ) {
        documentKind = "agh_generated_summary";
      }

      const html = renderAuthoritativeSplitSheetHtml({
        trackName: String(track?.name ?? "Track"),
        title: sheet.title as string | null,
        versionNumber: Number(sheet.version_number ?? 1),
        documentKind,
        composition: contributors,
        master,
        generatedAt: now,
        oneStopMaster: sheet.one_stop_master === true,
        publishingControlled: sheet.publishing_controlled === true,
        masterControlled: sheet.master_controlled === true,
        status: "final",
      });
      const hashProbe = await computeDocumentHash(html);
      const htmlFinal = renderAuthoritativeSplitSheetHtml({
        trackName: String(track?.name ?? "Track"),
        title: sheet.title as string | null,
        versionNumber: Number(sheet.version_number ?? 1),
        documentKind,
        documentHash: hashProbe,
        composition: contributors,
        master,
        generatedAt: now,
        oneStopMaster: sheet.one_stop_master === true,
        publishingControlled: sheet.publishing_controlled === true,
        masterControlled: sheet.master_controlled === true,
        status: "final",
      });
      const documentHash = await computeDocumentHash(htmlFinal);
      const path = storagePath(
        String(sheet.track_id),
        sheetId,
        Number(sheet.version_number ?? 1),
      );
      const stored = await storeHtml(sb, path, htmlFinal);
      const attr = attributionFrom(ops);

      await sb.from("split_sheets").update({
        generated_html: htmlFinal,
        document_hash: documentHash,
        document_storage_path: stored.ok ? path : sheet.document_storage_path,
        document_mime: "text/html",
        updated_at: now,
      }).eq("id", sheetId);

      const { data: rpcData, error: rpcErr } = await sb.rpc("finalize_split_sheet_version", {
        p_split_sheet_id: sheetId,
        p_actor_kind: attr.actor_kind,
        p_actor_label: attr.actor_label,
        p_actor_user_id: attr.actor_user_id,
        p_document_hash: documentHash,
        p_document_storage_path: stored.ok ? path : sheet.document_storage_path ?? null,
        p_document_mime: "text/html",
        p_document_kind: documentKind,
        p_require_confirmations: clean.require_confirmations !== false,
      });
      if (rpcErr) return { status: 500, data: { error: rpcErr.message } };
      const result = (rpcData ?? {}) as Record<string, unknown>;
      if (result.ok !== true) {
        return { status: 422, data: { error: "finalize rejected", ...result } };
      }
      const refreshed = await loadSheetBundle(sb, sheetId);
      return {
        status: 200,
        data: {
          ok: true,
          rpc: result,
          sheet: refreshed.data.sheet,
          document_hash: documentHash,
          document_kind: documentKind,
          storage: stored,
          splits_ready: true,
          splits_ready_source: "authoritative_final",
        },
      };
    }

    case "get_split_sheet_signed_url": {
      // Claude may read metadata / identify gaps but must not mint signed URLs
      // that expose contributor PII documents.
      if (isClaudeKind(ops)) {
        return {
          status: 403,
          data: {
            error: "Claude may not download split-sheet documents or mint signed URLs",
            code: "claude_document_download_denied",
          },
        };
      }
      if (!can(ops, "download_split_sheet_document") && !canReadSplitSheets(ops)) {
        return { status: 401, data: { error: "Authentication required" } };
      }
      if (!can(ops, "download_split_sheet_document")) {
        return {
          status: 403,
          data: {
            error: "download_split_sheet_document capability required",
            code: "signed_url_denied",
          },
        };
      }
      const sheetId = String(clean.split_sheet_id ?? "").trim();
      if (!sheetId) return { status: 400, data: { error: "split_sheet_id required" } };
      const { data: sheet } = await sb.from("split_sheets").select("*").eq("id", sheetId)
        .maybeSingle();
      if (!sheet) return { status: 404, data: { error: "Not found" } };
      const path = String(sheet.document_storage_path ?? "").trim();
      if (!path) {
        return {
          status: 404,
          data: { error: "No stored document path", code: "missing_storage_path" },
        };
      }
      const ttl = Math.min(Math.max(Number(clean.ttl_seconds) || 900, 60), 3600);
      const purpose = String(clean.purpose ?? "view").trim() === "download" ? "download" : "view";
      const { data: signed, error } = await sb.storage
        .from(RIGHTS_DOCUMENTS_BUCKET)
        .createSignedUrl(path, ttl);
      if (error) {
        return { status: 503, data: { error: error.message, code: "signed_url_failed" } };
      }
      await auditEvent(sb, {
        track_id: String(sheet.track_id),
        split_sheet_id: sheetId,
        event_kind: purpose === "download" ? "download" : "view",
        ops,
        document_hash: sheet.document_hash,
        detail: { ttl_seconds: ttl, path },
      });
      return {
        status: 200,
        data: {
          ok: true,
          signed_url: signed?.signedUrl ?? null,
          expires_in_seconds: ttl,
          document_kind: sheet.document_kind,
          document_hash: sheet.document_hash,
          purpose,
        },
      };
    }

    case "get_track_split_readiness": {
      if (!canReadSplitSheets(ops)) {
        return { status: 401, data: { error: "Authentication required" } };
      }
      const trackId = String(clean.track_id ?? "").trim();
      if (!trackId) return { status: 400, data: { error: "track_id required" } };
      const { data: track, error } = await sb
        .from("tracks")
        .select(
          "id, name, splits_ready, splits_ready_source, splits_ready_legacy, current_split_sheet_id, split_sheet_delivery_policy",
        )
        .eq("id", trackId)
        .maybeSingle();
      if (error) return { status: 500, data: { error: error.message } };
      if (!track) return { status: 404, data: { error: "Track not found" } };

      let sheet: Record<string, unknown> | null = null;
      const currentId = track.current_split_sheet_id
        ? String(track.current_split_sheet_id)
        : null;
      if (currentId) {
        const { data } = await sb.from("split_sheets").select(
          "id, status, is_current, document_kind, document_hash, version_number, dispute_reason, finalized_at",
        ).eq("id", currentId).maybeSingle();
        sheet = data;
      }
      const gaps: string[] = [];
      if (!sheet) gaps.push("no_current_split_sheet");
      else {
        if (String(sheet.status) !== "final") gaps.push("sheet_not_final");
        if (sheet.is_current !== true) gaps.push("sheet_not_current");
        if (String(sheet.status) === "disputed") gaps.push("sheet_disputed");
      }
      if (track.splits_ready_source !== "authoritative_final") {
        gaps.push("splits_ready_source_not_authoritative_final");
      }
      if (track.splits_ready !== true) gaps.push("splits_ready_false");

      return {
        status: 200,
        data: {
          ok: true,
          track,
          current_sheet: sheet,
          gaps,
          ready: gaps.length === 0,
          disclosure: initialPitchRightsDisclosure({
            track_name: track.name,
            splits_ready: track.splits_ready,
            splits_ready_source: track.splits_ready_source,
          }),
        },
      };
    }

    default:
      return { status: 400, data: { error: `Unknown split-sheet action: ${action}` } };
  }
}
