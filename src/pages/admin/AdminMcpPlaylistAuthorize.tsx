/**
 * One-click Fendi consent for the Claude playlist-discovery MCP connector.
 * Uses the existing AGH Supabase session — never asks for a pasted JWT or secret.
 */
import React, { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";

function mcpAuthorizeUrl(): string {
  const explicit = (import.meta.env.VITE_AGH_MCP_PLAYLIST_DISCOVERY_URL as string | undefined)?.replace(/\/$/, "");
  if (explicit) return `${explicit}/oauth/authorize`;
  const base = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, "");
  return `${base}/functions/v1/mcp-playlist-discovery/oauth/authorize`;
}

const AdminMcpPlaylistAuthorize: React.FC = () => {
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const clientId = params.get("client_id") || "";
  const redirectUri = params.get("redirect_uri") || "";
  const state = params.get("state") || "";
  const codeChallenge = params.get("code_challenge") || "";
  const codeChallengeMethod = params.get("code_challenge_method") || "S256";
  const scope = params.get("scope") || "playlist_discovery";

  const onCancel = () => {
    if (!redirectUri) {
      setError("Missing redirect_uri");
      return;
    }
    const u = new URL(redirectUri);
    u.searchParams.set("error", "access_denied");
    if (state) u.searchParams.set("state", state);
    window.location.href = u.toString();
  };

  const onAuthorize = async () => {
    setBusy(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setError("Sign in to AGH first, then return to authorize.");
        setBusy(false);
        return;
      }
      const res = await fetch(mcpAuthorizeUrl(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          client_id: clientId,
          redirect_uri: redirectUri,
          state,
          code_challenge: codeChallenge,
          code_challenge_method: codeChallengeMethod,
          scope,
          decision: "authorize",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(String(body.error_description || body.error || `HTTP ${res.status}`));
        setBusy(false);
        return;
      }
      if (body.redirect_to) {
        window.location.href = String(body.redirect_to);
        return;
      }
      setError("Authorize succeeded but no redirect was returned.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-md space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Authorize playlist discovery</h1>
      <p className="text-sm text-muted-foreground leading-relaxed">
        Grants Claude’s scheduled connector the narrow <code>playlist_discovery</code> scope.
        Approve/send and Song DNA stay with Grok / you. Only your Fendi AGH session can approve.
      </p>
      <div className="flex gap-3 pt-2">
        <button
          type="button"
          disabled={busy || !clientId || !redirectUri}
          onClick={onAuthorize}
          className="rounded-md bg-foreground text-background px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {busy ? "Authorizing…" : "Authorize"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="rounded-md border px-4 py-2 text-sm"
        >
          Cancel
        </button>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
};

export default AdminMcpPlaylistAuthorize;
