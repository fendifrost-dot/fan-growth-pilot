import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { callHubFn } from "@/lib/hubApi";

export type LaneRow = {
  key: string;
  label: string;
  pitch_angle: string;
  references: string[];
  regex_boost: string;
};

const emptyLane = (): LaneRow => ({
  key: "",
  label: "",
  pitch_angle: "",
  references: [],
  regex_boost: "",
});

const AdminLanesPanel: React.FC = () => {
  const [rows, setRows] = useState<LaneRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<LaneRow>(emptyLane());
  const [refInput, setRefInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await callHubFn<{ rows: LaneRow[] }>("list_lanes");
      setRows(data.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openNew = () => {
    setForm(emptyLane());
    setRefInput("");
    setEditingKey(null);
    setDialogOpen(true);
  };

  const openEdit = (row: LaneRow) => {
    setForm({ ...row, references: [...(row.references ?? [])] });
    setRefInput("");
    setEditingKey(row.key);
    setDialogOpen(true);
  };

  const addRef = () => {
    const v = refInput.trim();
    if (!v) return;
    if (form.references.includes(v)) {
      setRefInput("");
      return;
    }
    setForm({ ...form, references: [...form.references, v] });
    setRefInput("");
  };

  const save = async () => {
    const key = form.key.trim();
    if (!key || !form.label.trim()) {
      toast.error("Key and label are required");
      return;
    }
    setSaving(true);
    try {
      await callHubFn("upsert_lane", {
        key,
        label: form.label.trim(),
        pitch_angle: form.pitch_angle.trim() || "",
        references: form.references,
        regex_boost: form.regex_boost.trim() || "",
      });
      toast.success("Lane saved");
      setDialogOpen(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: LaneRow) => {
    if (!confirm(`Delete lane "${row.key}"? Playlists stamped with this lane are not reassigned.`)) return;
    try {
      await callHubFn("delete_lane", { key: row.key });
      toast.success("Deleted");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Playlist lanes (destination buckets). Pitch angle here is a fallback only — a track&apos;s own short pitch always wins.
        </p>
        <Button onClick={openNew} size="sm">
          <Plus className="h-4 w-4 mr-1" /> Add lane
        </Button>
      </div>
      <Card className="overflow-hidden">
        {loading ? (
          <p className="p-6 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Label</TableHead>
                <TableHead>Pitch angle</TableHead>
                <TableHead>References</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell className="font-mono text-xs">{row.key}</TableCell>
                  <TableCell className="font-medium">{row.label}</TableCell>
                  <TableCell className="text-sm text-muted-foreground max-w-xs truncate">{row.pitch_angle || "—"}</TableCell>
                  <TableCell className="text-xs max-w-xs truncate">{(row.references ?? []).join(", ") || "—"}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" onClick={() => openEdit(row)}><Pencil className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon" onClick={() => remove(row)}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {!rows.length && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    No lanes yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingKey ? "Edit lane" : "Add lane"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Key</Label>
              <Input
                value={form.key}
                onChange={(e) => setForm({ ...form, key: e.target.value })}
                placeholder="rap_general"
                disabled={Boolean(editingKey)}
              />
            </div>
            <div>
              <Label>Label</Label>
              <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Rap — general" />
            </div>
            <div>
              <Label>Pitch angle (fallback copy)</Label>
              <Textarea
                value={form.pitch_angle}
                onChange={(e) => setForm({ ...form, pitch_angle: e.target.value })}
                rows={3}
                placeholder="Used only when the track has no short pitch"
              />
            </div>
            <div>
              <Label>Reference artists</Label>
              <div className="flex gap-2">
                <Input
                  value={refInput}
                  onChange={(e) => setRefInput(e.target.value)}
                  placeholder="Add artist…"
                  onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addRef())}
                />
                <Button type="button" variant="outline" size="sm" onClick={addRef}>Add</Button>
              </div>
              <div className="flex flex-wrap gap-1 mt-2">
                {form.references.map((a) => (
                  <Badge
                    key={a}
                    variant="secondary"
                    className="cursor-pointer"
                    onClick={() => setForm({ ...form, references: form.references.filter((x) => x !== a) })}
                  >
                    {a} ×
                  </Badge>
                ))}
              </div>
            </div>
            <div>
              <Label>Regex boost</Label>
              <Input
                value={form.regex_boost}
                onChange={(e) => setForm({ ...form, regex_boost: e.target.value })}
                placeholder="rap|hip ?hop|trap"
                className="font-mono text-xs"
              />
            </div>
            <Button onClick={save} disabled={saving} className="w-full">{saving ? "Saving…" : "Save"}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AdminLanesPanel;
