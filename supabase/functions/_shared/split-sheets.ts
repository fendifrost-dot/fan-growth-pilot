/**
 * Split-sheet generator. Incomplete contributor data creates action items — never blocks code.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import type { Actor } from "./outreach-auth.ts";

export const SPLIT_SHEET_ACTIONS = [
  "list_split_sheets",
  "get_split_sheet",
  "create_split_sheet",
  "update_split_sheet_contributors",
  "regenerate_split_sheet_document",
] as const;

export function isSplitSheetAction(action: string): boolean {
  return (SPLIT_SHEET_ACTIONS as readonly string[]).includes(action);
}

type Result = { status: number; data: Record<string, unknown> };

export type ContributorInput = {
  legal_name?: string | null;
  role?: string;
  split_percent?: number | null;
  ipi_number?: string | null;
  pro_affiliation?: string | null;
  notes?: string | null;
};

export function computeSplitActionItems(
  contributors: ContributorInput[],
): string[] {
  const items: string[] = [];
  if (contributors.length === 0) {
    items.push("Add at least one contributor with legal name, role, and split %");
    return items;
  }
  let sum = 0;
  contributors.forEach((c, i) => {
    const n = i + 1;
    if (!String(c.legal_name ?? "").trim()) items.push(`Contributor #${n}: legal name missing`);
    if (c.split_percent == null || !Number.isFinite(Number(c.split_percent))) {
      items.push(`Contributor #${n}: split % missing`);
    } else {
      sum += Number(c.split_percent);
    }
    if (!String(c.role ?? "").trim()) items.push(`Contributor #${n}: role missing`);
  });
  if (contributors.some((c) => c.split_percent != null) && Math.abs(sum - 100) > 0.01) {
    items.push(`Split percentages sum to ${sum.toFixed(2)}% (must total 100%)`);
  }
  return items;
}

export function renderSplitSheetHtml(opts: {
  trackName: string;
  title?: string | null;
  contributors: ContributorInput[];
  actionItems: string[];
  generatedAt: string;
}): string {
  const rows = opts.contributors
    .map(
      (c) =>
        `<tr><td>${escapeHtml(c.legal_name || "TBD")}</td><td>${escapeHtml(c.role || "")}</td><td>${
          c.split_percent == null ? "TBD" : `${c.split_percent}%`
        }</td><td>${escapeHtml(c.pro_affiliation || "")}</td><td>${escapeHtml(c.ipi_number || "")}</td></tr>`,
    )
    .join("");
  const actions = opts.actionItems.map((a) => `<li>${escapeHtml(a)}</li>`).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(
    opts.title || `Split sheet — ${opts.trackName}`,
  )}</title>
<style>body{font-family:Georgia,serif;max-width:720px;margin:2rem auto;color:#111}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ccc;padding:.5rem;text-align:left}h1{font-size:1.4rem}.meta{color:#555;font-size:.9rem}.actions{background:#fff8e6;padding:1rem;border:1px solid #e6d7a8}</style>
</head><body>
<h1>${escapeHtml(opts.title || `Split sheet — ${opts.trackName}`)}</h1>
<p class="meta">Generated ${escapeHtml(opts.generatedAt)} · Incomplete sheets are valid work products until legal facts are entered.</p>
<table><thead><tr><th>Legal name</th><th>Role</th><th>Split %</th><th>PRO</th><th>IPI</th></tr></thead>
<tbody>${rows || "<tr><td colspan=5>No contributors yet</td></tr>"}</tbody></table>
${
    opts.actionItems.length
      ? `<div class="actions"><strong>Action items</strong><ul>${actions}</ul></div>`
      : `<p><strong>Status:</strong> contributor fields complete (ready for signature workflow).</p>`
  }
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function requireAdmin(actor: Actor | null): Result | null {
  if (!actor || actor.kind !== "user" || !actor.isAdmin) {
    return { status: 401, data: { error: "Admin JWT required for split-sheet writes" } };
  }
  return null;
}

async function nextVersion(sb: SupabaseClient, trackId: string): Promise<number> {
  const { data } = await sb
    .from("split_sheets")
    .select("version_number")
    .eq("track_id", trackId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  return Number(data?.version_number ?? 0) + 1;
}

export async function runSplitSheetAction(
  action: string,
  body: Record<string, unknown>,
  sb: SupabaseClient,
  actor: Actor | null = null,
): Promise<Result> {
  switch (action) {
    case "list_split_sheets": {
      const trackId = String(body.track_id ?? "").trim();
      let q = sb
        .from("split_sheets")
        .select("id, track_id, version_number, status, title, notes, action_items, document_storage_path, created_at, updated_at, tracks(name)")
        .order("version_number", { ascending: false })
        .limit(100);
      if (trackId) q = q.eq("track_id", trackId);
      const { data, error } = await q;
      if (error) {
        return {
          status: 503,
          data: { error: `split_sheets unavailable (${error.message}). Apply 20260903110000.` },
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
      const id = String(body.split_sheet_id ?? "").trim();
      if (!id) return { status: 400, data: { error: "split_sheet_id required" } };
      const { data, error } = await sb.from("split_sheets").select("*").eq("id", id).maybeSingle();
      if (error) return { status: 500, data: { error: error.message } };
      if (!data) return { status: 404, data: { error: "Not found" } };
      const { data: contributors } = await sb
        .from("split_sheet_contributors")
        .select("*")
        .eq("split_sheet_id", id)
        .order("sort_order");
      return { status: 200, data: { ok: true, sheet: data, contributors: contributors ?? [] } };
    }
    case "create_split_sheet": {
      const authErr = requireAdmin(actor);
      if (authErr) return authErr;
      const trackId = String(body.track_id ?? "").trim();
      if (!trackId) return { status: 400, data: { error: "track_id required" } };
      const { data: track } = await sb.from("tracks").select("id, name").eq("id", trackId).maybeSingle();
      if (!track) return { status: 404, data: { error: "Track not found" } };

      const contributors = (Array.isArray(body.contributors) ? body.contributors : []) as ContributorInput[];
      const actionItems = computeSplitActionItems(contributors);
      const version_number = await nextVersion(sb, trackId);
      const now = new Date().toISOString();
      const html = renderSplitSheetHtml({
        trackName: String(track.name),
        title: body.title ? String(body.title) : null,
        contributors,
        actionItems,
        generatedAt: now,
      });

      const { data: sheet, error } = await sb
        .from("split_sheets")
        .insert({
          track_id: trackId,
          version_number,
          status: actionItems.length ? "incomplete" : "ready_for_signatures",
          title: body.title == null ? `Split sheet — ${track.name}` : String(body.title),
          notes: body.notes == null ? null : String(body.notes),
          action_items: actionItems,
          generated_html: html,
          created_by: actor!.kind === "user" ? actor!.userId : null,
          updated_by: actor!.kind === "user" ? actor!.userId : null,
        })
        .select("*")
        .single();
      if (error) throw error;

      if (contributors.length) {
        const rows = contributors.map((c, i) => ({
          split_sheet_id: sheet.id,
          legal_name: c.legal_name == null ? null : String(c.legal_name),
          role: String(c.role ?? "writer"),
          split_percent: c.split_percent == null ? null : Number(c.split_percent),
          ipi_number: c.ipi_number == null ? null : String(c.ipi_number),
          pro_affiliation: c.pro_affiliation == null ? null : String(c.pro_affiliation),
          notes: c.notes == null ? null : String(c.notes),
          sort_order: i,
        }));
        const { error: cErr } = await sb.from("split_sheet_contributors").insert(rows);
        if (cErr) throw cErr;
      }

      return {
        status: 200,
        data: { ok: true, sheet, action_items: actionItems, contributors },
      };
    }
    case "update_split_sheet_contributors": {
      const authErr = requireAdmin(actor);
      if (authErr) return authErr;
      const id = String(body.split_sheet_id ?? "").trim();
      if (!id) return { status: 400, data: { error: "split_sheet_id required" } };
      const { data: sheet } = await sb.from("split_sheets").select("*, tracks(name)").eq("id", id).maybeSingle();
      if (!sheet) return { status: 404, data: { error: "Not found" } };

      const contributors = (Array.isArray(body.contributors) ? body.contributors : []) as ContributorInput[];
      const actionItems = computeSplitActionItems(contributors);
      await sb.from("split_sheet_contributors").delete().eq("split_sheet_id", id);
      if (contributors.length) {
        await sb.from("split_sheet_contributors").insert(
          contributors.map((c, i) => ({
            split_sheet_id: id,
            legal_name: c.legal_name == null ? null : String(c.legal_name),
            role: String(c.role ?? "writer"),
            split_percent: c.split_percent == null ? null : Number(c.split_percent),
            ipi_number: c.ipi_number == null ? null : String(c.ipi_number),
            pro_affiliation: c.pro_affiliation == null ? null : String(c.pro_affiliation),
            notes: c.notes == null ? null : String(c.notes),
            sort_order: i,
          })),
        );
      }
      const now = new Date().toISOString();
      const trackName = (sheet.tracks as { name?: string } | null)?.name ?? "Track";
      const html = renderSplitSheetHtml({
        trackName,
        title: sheet.title as string | null,
        contributors,
        actionItems,
        generatedAt: now,
      });
      const { data, error } = await sb
        .from("split_sheets")
        .update({
          action_items: actionItems,
          status: actionItems.length ? "incomplete" : "ready_for_signatures",
          generated_html: html,
          updated_by: actor!.kind === "user" ? actor!.userId : null,
          updated_at: now,
        })
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;
      return { status: 200, data: { ok: true, sheet: data, action_items: actionItems } };
    }
    case "regenerate_split_sheet_document": {
      const authErr = requireAdmin(actor);
      if (authErr) return authErr;
      const id = String(body.split_sheet_id ?? "").trim();
      if (!id) return { status: 400, data: { error: "split_sheet_id required" } };
      const got = await runSplitSheetAction("get_split_sheet", { split_sheet_id: id }, sb, actor);
      if (got.status !== 200) return got;
      const sheet = got.data.sheet as Record<string, unknown>;
      const contributors = got.data.contributors as ContributorInput[];
      const { data: track } = await sb.from("tracks").select("name").eq("id", sheet.track_id).maybeSingle();
      const actionItems = computeSplitActionItems(contributors);
      const now = new Date().toISOString();
      const html = renderSplitSheetHtml({
        trackName: String(track?.name ?? "Track"),
        title: sheet.title as string | null,
        contributors,
        actionItems,
        generatedAt: now,
      });
      const { data, error } = await sb
        .from("split_sheets")
        .update({
          generated_html: html,
          action_items: actionItems,
          status: actionItems.length ? "incomplete" : "ready_for_signatures",
          updated_at: now,
          updated_by: actor!.kind === "user" ? actor!.userId : null,
        })
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;
      return { status: 200, data: { ok: true, sheet: data, html, action_items: actionItems } };
    }
    default:
      return { status: 400, data: { error: `Unknown split-sheet action: ${action}` } };
  }
}
