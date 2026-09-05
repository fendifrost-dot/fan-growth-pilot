import React, { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { callHubFn } from "@/lib/hubApi";

type CoverageSample = {
  playlist_id: string;
  playlist_name: string | null;
  curator_name: string | null;
  platform: string | null;
  is_active: boolean | null;
  category_count: number;
};

type CoverageAudit = {
  ok: boolean;
  active_only: boolean;
  scanned: number;
  with_categories: number;
  without_categories: number;
  coverage_pct: number;
  sample_missing: CoverageSample[];
  sample_covered: CoverageSample[];
};

const AdminCategoryCoverage: React.FC = () => {
  const [activeOnly, setActiveOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [audit, setAudit] = useState<CoverageAudit | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setLoadError(null);
    try {
      const data = await callHubFn<CoverageAudit>("audit_playlist_category_coverage", {
        active_only: activeOnly,
        sample_limit: 40,
      });
      setAudit(data);
      if (data.without_categories > 0) {
        toast.message(
          `${data.without_categories} playlist(s) lack categories — genre-fit will refuse sends to them once the identity gate is armed.`,
        );
      } else {
        toast.success("All scanned playlists have at least one category");
      }
    } catch (e) {
      const msg = (e as Error).message || "Audit failed";
      setLoadError(msg);
      setAudit(null);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }, [activeOnly]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Playlist category coverage</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          Armed playlist sends fail closed when a target has zero categories. Run this audit before
          cutover; assign categories on{" "}
          <Link className="underline" to="/admin/playlists">playlist targets</Link> or{" "}
          <Link className="underline" to="/admin/categories">Categories</Link>.
        </p>
      </div>

      <Card className="p-5 space-y-4">
        <div className="flex items-center gap-3">
          <Switch checked={activeOnly} onCheckedChange={setActiveOnly} id="active-only" />
          <Label htmlFor="active-only">Active targets only</Label>
        </div>
        <Button onClick={() => void run()} disabled={busy}>
          {busy ? "Auditing…" : "Run coverage audit"}
        </Button>
      </Card>

      {loadError && (
        <Card className="p-4 space-y-2">
          <p className="font-medium text-destructive">Coverage audit failed</p>
          <p className="text-sm text-muted-foreground break-words">{loadError}</p>
          <Button size="sm" variant="outline" onClick={() => void run()}>Retry</Button>
        </Card>
      )}
      {!loadError && audit && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card className="p-4">
              <p className="text-xs text-muted-foreground">Scanned</p>
              <p className="text-2xl font-semibold">{audit.scanned}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-muted-foreground">With categories</p>
              <p className="text-2xl font-semibold">{audit.with_categories}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-muted-foreground">Missing categories</p>
              <p className="text-2xl font-semibold text-amber-700">{audit.without_categories}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-muted-foreground">Coverage</p>
              <p className="text-2xl font-semibold">{audit.coverage_pct}%</p>
            </Card>
          </div>

          <Card className="p-5 space-y-3">
            <h2 className="font-medium">Sample — missing categories</h2>
            {!audit.sample_missing.length && (
              <p className="text-sm text-muted-foreground">None in sample.</p>
            )}
            <ul className="space-y-2 text-sm">
              {audit.sample_missing.map((r) => (
                <li key={r.playlist_id} className="flex flex-wrap items-center gap-2 border-b pb-2">
                  <span className="font-medium">{r.playlist_name ?? r.playlist_id}</span>
                  <Badge variant="outline">{r.platform ?? "—"}</Badge>
                  <span className="text-muted-foreground">{r.curator_name ?? "—"}</span>
                  <Badge variant="destructive">0 cats</Badge>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
};

export default AdminCategoryCoverage;
