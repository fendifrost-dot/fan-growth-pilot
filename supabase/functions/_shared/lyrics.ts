/**
 * Provider-neutral lyrics adapter + Hub actions.
 * Paid providers are DEFERRED (Phase 0 §6). Only manual/import paths run.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import type { Actor } from "./outreach-auth.ts";

export const LYRICS_ACTIONS = [
  "list_lyrics",
  "get_lyrics",
  "upsert_lyrics_manual",
  "mark_lyrics_ready",
  "request_lyrics_provider_job",
] as const;

export function isLyricsAction(action: string): boolean {
  return (LYRICS_ACTIONS as readonly string[]).includes(action);
}

export type LyricsProviderJobRequest = {
  trackId: string;
  audioStoragePath?: string;
  language?: string;
};

export type LyricsProviderJobResult =
  | { ok: true; providerId: string; jobId: string; status: "queued" }
  | { ok: false; error: string; code: "provider_deferred" | "not_configured" };

/** Neutral interface — concrete vendors plug in later after Fendi budget approval. */
export interface LyricsProviderAdapter {
  readonly id: string;
  requestTranscription(req: LyricsProviderJobRequest): Promise<LyricsProviderJobResult>;
}

/** Stub adapter — always refuses until a provider is authorized. */
export class DeferredLyricsProvider implements LyricsProviderAdapter {
  readonly id = "deferred";
  requestTranscription(_req: LyricsProviderJobRequest): Promise<LyricsProviderJobResult> {
    return Promise.resolve({
      ok: false,
      code: "provider_deferred",
      error:
        "Lyric provider is deferred (Phase 0 locked §6). Use manual upload/import. Do not purchase or wire a vendor without a separate Fendi decision.",
    });
  }
}

export const defaultLyricsProvider: LyricsProviderAdapter = new DeferredLyricsProvider();

type Result = { status: number; data: Record<string, unknown> };

function requireAdmin(actor: Actor | null): Result | null {
  if (!actor || actor.kind !== "user" || !actor.isAdmin) {
    return { status: 401, data: { error: "Admin JWT required for lyrics writes" } };
  }
  return null;
}

async function nextVersion(sb: SupabaseClient, trackId: string): Promise<number> {
  const { data } = await sb
    .from("lyrics_transcriptions")
    .select("version_number")
    .eq("track_id", trackId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  return Number(data?.version_number ?? 0) + 1;
}

export async function runLyricsAction(
  action: string,
  body: Record<string, unknown>,
  sb: SupabaseClient,
  actor: Actor | null = null,
  provider: LyricsProviderAdapter = defaultLyricsProvider,
): Promise<Result> {
  switch (action) {
    case "list_lyrics": {
      const trackId = String(body.track_id ?? "").trim();
      let q = sb
        .from("lyrics_transcriptions")
        .select("id, track_id, version_number, source, provider_id, status, language, plain_text, timed_lines, storage_path, notes, created_at, updated_at, tracks(name)")
        .order("version_number", { ascending: false })
        .limit(100);
      if (trackId) q = q.eq("track_id", trackId);
      const { data, error } = await q;
      if (error) {
        return {
          status: 503,
          data: { error: `lyrics_transcriptions unavailable (${error.message}). Apply 20260903100000.` },
        };
      }
      const rows = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
        ...r,
        track_name: (r.tracks as { name?: string } | null)?.name ?? null,
        tracks: undefined,
      }));
      return { status: 200, data: { ok: true, rows } };
    }
    case "get_lyrics": {
      const id = String(body.lyrics_id ?? "").trim();
      if (!id) return { status: 400, data: { error: "lyrics_id required" } };
      const { data, error } = await sb.from("lyrics_transcriptions").select("*").eq("id", id).maybeSingle();
      if (error) return { status: 500, data: { error: error.message } };
      if (!data) return { status: 404, data: { error: "Not found" } };
      return { status: 200, data: { ok: true, lyrics: data } };
    }
    case "upsert_lyrics_manual": {
      const authErr = requireAdmin(actor);
      if (authErr) return authErr;
      const trackId = String(body.track_id ?? "").trim();
      const plain = String(body.plain_text ?? "");
      if (!trackId) return { status: 400, data: { error: "track_id required" } };
      if (!plain.trim()) return { status: 400, data: { error: "plain_text required" } };

      const existingId = String(body.lyrics_id ?? "").trim();
      const userId = actor!.kind === "user" ? actor!.userId : null;
      const now = new Date().toISOString();

      if (existingId) {
        const { data, error } = await sb
          .from("lyrics_transcriptions")
          .update({
            plain_text: plain,
            timed_lines: body.timed_lines ?? [],
            language: String(body.language ?? "en"),
            notes: body.notes == null ? null : String(body.notes),
            storage_path: body.storage_path == null ? null : String(body.storage_path),
            updated_by: userId,
            updated_at: now,
            status: "draft",
          })
          .eq("id", existingId)
          .select("*")
          .single();
        if (error) throw error;
        return { status: 200, data: { ok: true, lyrics: data } };
      }

      const version_number = await nextVersion(sb, trackId);
      const { data, error } = await sb
        .from("lyrics_transcriptions")
        .insert({
          track_id: trackId,
          version_number,
          source: "manual",
          status: "draft",
          language: String(body.language ?? "en"),
          plain_text: plain,
          timed_lines: body.timed_lines ?? [],
          storage_path: body.storage_path == null ? null : String(body.storage_path),
          notes: body.notes == null ? null : String(body.notes),
          created_by: userId,
          updated_by: userId,
        })
        .select("*")
        .single();
      if (error) throw error;
      return { status: 200, data: { ok: true, lyrics: data } };
    }
    case "mark_lyrics_ready": {
      const authErr = requireAdmin(actor);
      if (authErr) return authErr;
      const id = String(body.lyrics_id ?? "").trim();
      if (!id) return { status: 400, data: { error: "lyrics_id required" } };
      const { data: current } = await sb.from("lyrics_transcriptions").select("*").eq("id", id).maybeSingle();
      if (!current) return { status: 404, data: { error: "Not found" } };
      if (!String(current.plain_text ?? "").trim()) {
        return { status: 400, data: { error: "Cannot mark ready with empty plain_text" } };
      }
      await sb
        .from("lyrics_transcriptions")
        .update({ status: "superseded", updated_at: new Date().toISOString() })
        .eq("track_id", current.track_id)
        .eq("status", "ready")
        .neq("id", id);
      const { data, error } = await sb
        .from("lyrics_transcriptions")
        .update({
          status: "ready",
          updated_by: actor!.kind === "user" ? actor!.userId : null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;
      return { status: 200, data: { ok: true, lyrics: data } };
    }
    case "request_lyrics_provider_job": {
      const authErr = requireAdmin(actor);
      if (authErr) return authErr;
      const trackId = String(body.track_id ?? "").trim();
      if (!trackId) return { status: 400, data: { error: "track_id required" } };
      const result = await provider.requestTranscription({
        trackId,
        audioStoragePath: body.audio_storage_path ? String(body.audio_storage_path) : undefined,
        language: body.language ? String(body.language) : "en",
      });
      if (!result.ok) {
        return { status: 501, data: { error: result.error, code: result.code } };
      }
      return { status: 200, data: { ok: true, job: result } };
    }
    default:
      return { status: 400, data: { error: `Unknown lyrics action: ${action}` } };
  }
}
