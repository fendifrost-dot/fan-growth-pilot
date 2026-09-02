import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { callHubFn } from "@/lib/hubApi";

type PressKit = {
  id: string;
  slug: string;
  title: string;
  status: string;
  one_liner: string | null;
  updated_at: string;
};

const AdminPressKit: React.FC = () => {
  const [rows, setRows] = useState<PressKit[]>([]);
  const [slug, setSlug] = useState("fendi-frost");
  const [title, setTitle] = useState("Fendi Frost — Press Kit");
  const [oneLiner, setOneLiner] = useState("");
  const [bioShort, setBioShort] = useState("");
  const [pressEmail, setPressEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await callHubFn<{ rows: PressKit[] }>("list_press_kits", {});
      setRows(data.rows ?? []);
    } catch (e) {
      toast.error((e as Error).message || "Failed to load press kits");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (status: "draft" | "published") => {
    setBusy(true);
    try {
      await callHubFn("upsert_press_kit", {
        slug,
        title,
        status,
        one_liner: oneLiner.trim() || null,
        bio_short: bioShort.trim() || null,
        press_email: pressEmail.trim() || null,
      });
      toast.success(status === "published" ? "Press kit published" : "Draft saved");
      await load();
    } catch (e) {
      toast.error((e as Error).message || "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Press / EPK</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          Operating surface for press kit metadata and asset pointers. Enter only verified copy —
          do not invent biography or contact facts.
        </p>
      </div>
      <Card className="p-5 space-y-3">
        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <Label>Slug</Label>
            <Input value={slug} onChange={(e) => setSlug(e.target.value)} />
          </div>
          <div>
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
        </div>
        <Label>One-liner</Label>
        <Input value={oneLiner} onChange={(e) => setOneLiner(e.target.value)} />
        <Label>Short bio</Label>
        <Textarea rows={4} value={bioShort} onChange={(e) => setBioShort(e.target.value)} />
        <Label>Press email</Label>
        <Input value={pressEmail} onChange={(e) => setPressEmail(e.target.value)} />
        <div className="flex gap-2">
          <Button disabled={busy} variant="outline" onClick={() => void save("draft")}>
            Save draft
          </Button>
          <Button disabled={busy} onClick={() => void save("published")}>
            Publish
          </Button>
        </div>
      </Card>
      <Card className="p-0 overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">Slug</th>
              <th className="text-left p-3">Title</th>
              <th className="text-left p-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="p-3 font-mono text-xs">{r.slug}</td>
                <td className="p-3">{r.title}</td>
                <td className="p-3">
                  <Badge variant="secondary">{r.status}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
};

export default AdminPressKit;
