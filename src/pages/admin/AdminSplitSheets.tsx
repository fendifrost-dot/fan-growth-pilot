import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { callHubFn } from "@/lib/hubApi";

type TrackOpt = { id: string; name: string };
type SheetRow = {
  id: string;
  track_id: string;
  track_name?: string | null;
  version_number: number;
  status: string;
  title: string | null;
  action_items: string[];
};

type Contributor = {
  legal_name: string;
  role: string;
  split_percent: string;
  pro_affiliation: string;
  ipi_number: string;
};

const emptyContributor = (): Contributor => ({
  legal_name: "",
  role: "writer",
  split_percent: "",
  pro_affiliation: "",
  ipi_number: "",
});

const AdminSplitSheets: React.FC = () => {
  const [tracks, setTracks] = useState<TrackOpt[]>([]);
  const [rows, setRows] = useState<SheetRow[]>([]);
  const [trackId, setTrackId] = useState("");
  const [contributors, setContributors] = useState<Contributor[]>([emptyContributor()]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, s] = await Promise.all([
        callHubFn<{ rows: TrackOpt[] }>("list_tracks"),
        callHubFn<{ rows: SheetRow[] }>("list_split_sheets", {}),
      ]);
      setTracks(t.rows ?? []);
      setRows(s.rows ?? []);
    } catch (e) {
      toast.error((e as Error).message || "Failed to load split sheets");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (!trackId) {
      toast.error("Pick a track");
      return;
    }
    setBusy(true);
    try {
      const res = await callHubFn<{
        action_items?: string[];
        sheet?: { id: string };
      }>("create_split_sheet", {
        track_id: trackId,
        contributors: contributors.map((c) => ({
          legal_name: c.legal_name.trim() || null,
          role: c.role,
          split_percent: c.split_percent === "" ? null : Number(c.split_percent),
          pro_affiliation: c.pro_affiliation.trim() || null,
          ipi_number: c.ipi_number.trim() || null,
        })),
      });
      const items = res.action_items ?? [];
      toast.success(
        items.length
          ? `Split sheet created incomplete (${items.length} action items)`
          : "Split sheet ready for signatures",
      );
      await load();
      if (res.sheet?.id) {
        const doc = await callHubFn<{ html?: string }>("regenerate_split_sheet_document", {
          split_sheet_id: res.sheet.id,
        });
        setPreviewHtml(doc.html ?? null);
      }
    } catch (e) {
      toast.error((e as Error).message || "Create failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Split sheets</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          Generator works without complete contributor data. Missing legal names, roles, or
          percentages become action items — never invent ownership facts.
        </p>
      </div>

      <Card className="p-5 space-y-4">
        <h2 className="font-medium">Generate</h2>
        <div className="space-y-1.5 max-w-md">
          <Label>Track</Label>
          <Select value={trackId || undefined} onValueChange={setTrackId}>
            <SelectTrigger>
              <SelectValue placeholder="Select track" />
            </SelectTrigger>
            <SelectContent>
              {tracks.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {contributors.map((c, idx) => (
          <div key={idx} className="grid gap-2 md:grid-cols-5 border-t pt-3">
            <Input
              placeholder="Legal name"
              value={c.legal_name}
              onChange={(e) =>
                setContributors((rows) =>
                  rows.map((r, i) => (i === idx ? { ...r, legal_name: e.target.value } : r)),
                )
              }
            />
            <Input
              placeholder="Role"
              value={c.role}
              onChange={(e) =>
                setContributors((rows) =>
                  rows.map((r, i) => (i === idx ? { ...r, role: e.target.value } : r)),
                )
              }
            />
            <Input
              placeholder="Split %"
              value={c.split_percent}
              onChange={(e) =>
                setContributors((rows) =>
                  rows.map((r, i) => (i === idx ? { ...r, split_percent: e.target.value } : r)),
                )
              }
            />
            <Input
              placeholder="PRO"
              value={c.pro_affiliation}
              onChange={(e) =>
                setContributors((rows) =>
                  rows.map((r, i) => (i === idx ? { ...r, pro_affiliation: e.target.value } : r)),
                )
              }
            />
            <Input
              placeholder="IPI"
              value={c.ipi_number}
              onChange={(e) =>
                setContributors((rows) =>
                  rows.map((r, i) => (i === idx ? { ...r, ipi_number: e.target.value } : r)),
                )
              }
            />
          </div>
        ))}
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => setContributors((rows) => [...rows, emptyContributor()])}
          >
            Add contributor
          </Button>
          <Button disabled={busy || !trackId} onClick={() => void create()}>
            Generate split sheet
          </Button>
        </div>
      </Card>

      {previewHtml && (
        <Card className="p-5">
          <h2 className="font-medium mb-3">Document preview</h2>
          <iframe title="Split sheet preview" className="w-full h-96 border rounded bg-white" srcDoc={previewHtml} />
        </Card>
      )}

      <Card className="p-0 overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">Track</th>
              <th className="text-left p-3">Ver</th>
              <th className="text-left p-3">Status</th>
              <th className="text-left p-3">Action items</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={4} className="p-3 text-muted-foreground">
                  Loading…
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="p-3">{r.track_name ?? r.track_id.slice(0, 8)}</td>
                <td className="p-3 font-mono text-xs">v{r.version_number}</td>
                <td className="p-3">
                  <Badge variant="secondary">{r.status}</Badge>
                </td>
                <td className="p-3 text-xs text-muted-foreground">
                  {(r.action_items ?? []).length
                    ? (r.action_items ?? []).join("; ")
                    : "None"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
};

export default AdminSplitSheets;
