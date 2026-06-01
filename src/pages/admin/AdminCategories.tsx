import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Tag, Plus, Pencil, Trash2 } from "lucide-react";
import { callHubFn } from "@/lib/hubApi";

type Category = {
  id: string;
  slug: string;
  label: string;
  family: string;
  description: string | null;
};

const emptyCat = (): Partial<Category> => ({
  slug: "",
  label: "",
  family: "genre",
  description: "",
});

const AdminCategories: React.FC = () => {
  const [rows, setRows] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<Partial<Category>>(emptyCat());
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await callHubFn<{ rows: Category[] }>("list_categories");
      setRows(data.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openNew = () => {
    setForm(emptyCat());
    setDialogOpen(true);
  };

  const openEdit = (c: Category) => {
    setForm({ ...c });
    setDialogOpen(true);
  };

  const save = async () => {
    if (!form.slug?.trim() || !form.label?.trim()) {
      toast.error("Slug and label are required");
      return;
    }
    setSaving(true);
    try {
      await callHubFn("upsert_category", {
        slug: form.slug.trim(),
        label: form.label.trim(),
        family: form.family ?? "genre",
        description: form.description || null,
      });
      toast.success("Category saved");
      setDialogOpen(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c: Category) => {
    if (!confirm(`Delete category "${c.label}"?`)) return;
    try {
      await callHubFn("delete_category", { id: c.id });
      toast.success("Deleted");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Tag className="h-6 w-6" /> Categories
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Shared genre/vibe/mood tags for tracks and playlists.</p>
        </div>
        <Button onClick={openNew}>
          <Plus className="h-4 w-4 mr-1" /> Add Category
        </Button>
      </div>

      <Card className="overflow-hidden">
        {loading ? (
          <p className="p-6 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Family</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.label}</TableCell>
                  <TableCell className="font-mono text-xs">{c.slug}</TableCell>
                  <TableCell><Badge variant="secondary">{c.family}</Badge></TableCell>
                  <TableCell className="text-sm text-muted-foreground max-w-xs truncate">{c.description ?? "—"}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" onClick={() => openEdit(c)}><Pencil className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon" onClick={() => remove(c)}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{form.id ? "Edit category" : "Add category"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Slug</Label>
              <Input value={form.slug ?? ""} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="melodic_rap" />
            </div>
            <div>
              <Label>Label</Label>
              <Input value={form.label ?? ""} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Melodic Rap" />
            </div>
            <div>
              <Label>Family</Label>
              <Select value={form.family ?? "genre"} onValueChange={(v) => setForm({ ...form, family: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="genre">Genre</SelectItem>
                  <SelectItem value="vibe">Vibe</SelectItem>
                  <SelectItem value="mood">Mood</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Description</Label>
              <Textarea value={form.description ?? ""} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} />
            </div>
            <Button onClick={save} disabled={saving} className="w-full">{saving ? "Saving…" : "Save"}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AdminCategories;
