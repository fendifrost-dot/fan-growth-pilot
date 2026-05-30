import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { callHubFn } from "@/lib/hubApi";

type RosterRow = {
  ig_handle: string;
  display_name: string | null;
  follows_me: boolean;
  i_follow: boolean;
  is_mutual: boolean;
  relationship_notes: string | null;
  last_verified_at: string | null;
};

const AdminIgRoster: React.FC = () => {
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [mutualOnly, setMutualOnly] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [importText, setImportText] = useState("");

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const data = await callHubFn<{ rows: RosterRow[] }>("list_ig_roster", { mutual_only: mutualOnly });
      setRows(data.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [mutualOnly]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  const patch = async (handle: string, field: "follows_me" | "i_follow", value: boolean) => {
    setBusy(handle + field);
    try {
      await callHubFn("patch_ig_roster", { ig_handle: handle, [field]: value });
      await fetchRows();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const syncFromTargets = async () => {
    setBusy("sync");
    try {
      const res = await callHubFn<{ synced: number }>("sync_ig_roster_from_targets", {});
      toast.success(`Synced ${res.synced} handles from playlist targets — mark mutual flags next`);
      await fetchRows();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const runImport = async () => {
    const lines = importText.split("\n").map((l) => l.trim()).filter(Boolean);
    const entries = lines.map((line) => {
      const parts = line.split(/[\t,|]/).map((p) => p.trim());
      const handle = (parts[0] ?? "").replace(/^@/, "");
      return {
        ig_handle: handle,
        display_name: parts[1] || undefined,
        i_follow: parts[2] === "1" || parts[2]?.toLowerCase() === "yes",
        follows_me: parts[3] === "1" || parts[3]?.toLowerCase() === "yes",
        notes: parts[4],
      };
    }).filter((e) => e.ig_handle);

    if (!entries.length) {
      toast.error("Paste handles: one per line — handle, name, you_follow, they_follow, notes");
      return;
    }
    setBusy("import");
    try {
      const res = await callHubFn<{ upserted: number }>("import_ig_roster", { entries });
      toast.success(`Imported ${res.upserted} roster rows`);
      setImportText("");
      await fetchRows();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const mutualCount = rows.filter((r) => r.is_mutual).length;

  return (
    <div className="space-y-8">
      <div>
        <Link to="/admin/send" className="text-xs text-muted-foreground hover:underline">← Send center</Link>
        <h1 className="text-2xl font-semibold tracking-tight mt-1">Instagram curator roster</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          IG DMs only queue when a curator is <strong>mutual</strong> (you follow them and they follow you).
          Followers change — verify handles here before batching DMs.
        </p>
      </div>

      <Card className="p-4 flex flex-wrap gap-3 items-center justify-between">
        <div className="text-sm">
          Showing <strong>{rows.length}</strong>
          {mutualOnly ? " mutual" : ""} · <strong>{mutualCount}</strong> mutual in view
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant={mutualOnly ? "default" : "outline"} size="sm" onClick={() => setMutualOnly((v) => !v)}>
            {mutualOnly ? "All handles" : "Mutual only"}
          </Button>
          <Button variant="outline" size="sm" disabled={busy === "sync"} onClick={syncFromTargets}>
            Sync from playlists
          </Button>
          <Button variant="outline" size="sm" onClick={fetchRows}>Refresh</Button>
        </div>
      </Card>

      <Card className="p-4 space-y-3">
        <h2 className="text-sm font-medium">Bulk import</h2>
        <p className="text-xs text-muted-foreground">
          One line per curator: <code>handle, display name, you_follow (yes/1), they_follow (yes/1), notes</code>
        </p>
        <textarea
          className="w-full min-h-[80px] text-xs font-mono border rounded p-2 bg-background"
          placeholder="@curatorname, DJ Name, yes, yes, met at show"
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
        />
        <Button size="sm" disabled={busy === "import"} onClick={runImport}>Import lines</Button>
      </Card>

      <div className="rounded border overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-2">@handle</th>
              <th className="text-left p-2">Name</th>
              <th className="text-center p-2">I follow</th>
              <th className="text-center p-2">Follows me</th>
              <th className="text-center p-2">Mutual</th>
              <th className="text-left p-2">Verified</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="p-4 text-muted-foreground">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-4 text-muted-foreground">
                  No roster rows. Sync from playlists, then toggle follow flags after checking IG.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.ig_handle} className="border-t">
                  <td className="p-2 font-mono text-xs">@{r.ig_handle}</td>
                  <td className="p-2">{r.display_name ?? "—"}</td>
                  <td className="p-2 text-center">
                    <Button
                      size="sm"
                      variant={r.i_follow ? "default" : "outline"}
                      disabled={busy === r.ig_handle + "i_follow"}
                      onClick={() => patch(r.ig_handle, "i_follow", !r.i_follow)}
                    >
                      {r.i_follow ? "Yes" : "No"}
                    </Button>
                  </td>
                  <td className="p-2 text-center">
                    <Button
                      size="sm"
                      variant={r.follows_me ? "default" : "outline"}
                      disabled={busy === r.ig_handle + "follows_me"}
                      onClick={() => patch(r.ig_handle, "follows_me", !r.follows_me)}
                    >
                      {r.follows_me ? "Yes" : "No"}
                    </Button>
                  </td>
                  <td className="p-2 text-center text-xs">{r.is_mutual ? "✓" : "—"}</td>
                  <td className="p-2 text-xs text-muted-foreground">
                    {r.last_verified_at ? new Date(r.last_verified_at).toLocaleDateString() : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default AdminIgRoster;
