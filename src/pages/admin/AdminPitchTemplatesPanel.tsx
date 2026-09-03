import React, { useCallback, useEffect, useMemo, useState } from "react";
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
import { Pencil } from "lucide-react";
import { callHubFn } from "@/lib/hubApi";

type TemplateRow = {
  id: string;
  tone: string;
  channel: string;
  is_warm: boolean;
  subject_template: string;
  body_template: string;
  is_active: boolean;
  updated_at: string;
};

const TONES = [
  { value: "warm_personal", label: "Warm & Personal" },
  { value: "casual_friendly", label: "Casual & Friendly" },
  { value: "business_formal", label: "Business Formal" },
  { value: "hyped_energetic", label: "Hyped & Energetic" },
];

const PLACEHOLDERS = [
  "{{curator_name}}",
  "{{playlist_name}}",
  "{{track_name}}",
  "{{pitch}}",
  "{{stream_link}}",
  "{{artist_name}}",
  "{{prior_track}}",
];

const SAMPLE_VARS = {
  curator_name: "Alex",
  playlist_name: "Sample Playlist",
  track_name: "Sample Track",
  pitch: "(track short pitch)",
  stream_link: "Stream: https://example.com/track",
  artist_name: "Artist",
  prior_track: "Prior Track",
};

const AdminPitchTemplatesPanel: React.FC = () => {
  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<Partial<TemplateRow>>({});
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await callHubFn<{ rows: TemplateRow[] }>("list_pitch_templates");
      setRows(data.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openEdit = (row: TemplateRow) => {
    setForm({ ...row });
    setPreview(null);
    setDialogOpen(true);
  };

  const toneLabel = (v: string) => TONES.find((t) => t.value === v)?.label ?? v;

  const runPreview = async () => {
    if (!form.subject_template?.trim() || !form.body_template?.trim()) {
      toast.error("Subject and body are required to preview");
      return;
    }
    setPreviewing(true);
    try {
      const data = await callHubFn<{ subject: string; body: string }>("preview_pitch_template", {
        subject_template: form.subject_template,
        body_template: form.body_template,
        ...SAMPLE_VARS,
      });
      setPreview({ subject: data.subject, body: data.body });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewing(false);
    }
  };

  const save = async () => {
    if (!form.subject_template?.trim() || !form.body_template?.trim()) {
      toast.error("Subject and body are required");
      return;
    }
    setSaving(true);
    try {
      await callHubFn("upsert_pitch_template", {
        id: form.id,
        tone: form.tone,
        channel: form.channel ?? "email",
        is_warm: Boolean(form.is_warm),
        subject_template: form.subject_template,
        body_template: form.body_template,
        is_active: form.is_active !== false,
      });
      toast.success("Template saved");
      setDialogOpen(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const sorted = useMemo(
    () => [...rows].sort((a, b) =>
      a.channel.localeCompare(b.channel) || a.tone.localeCompare(b.tone) || Number(a.is_warm) - Number(b.is_warm)
    ),
    [rows],
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Envelope only — greeting, scaffolding, sign-off. Song copy is <code>{"{{pitch}}"}</code> from the track record.
      </p>
      <Card className="overflow-hidden">
        {loading ? (
          <p className="p-6 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tone</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Warm?</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Active</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{toneLabel(row.tone)}</TableCell>
                  <TableCell className="font-mono text-xs">{row.channel}</TableCell>
                  <TableCell>{row.is_warm ? "Follow-up" : "Cold"}</TableCell>
                  <TableCell className="text-sm text-muted-foreground max-w-xs truncate">{row.subject_template}</TableCell>
                  <TableCell>
                    <Badge variant={row.is_active ? "secondary" : "outline"}>{row.is_active ? "on" : "off"}</Badge>
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" onClick={() => openEdit(row)}><Pencil className="h-4 w-4" /></Button>
                  </TableCell>
                </TableRow>
              ))}
              {!sorted.length && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    No templates yet — apply the pitch_templates migration.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit template</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Tone</Label>
                <Select value={form.tone} onValueChange={(v) => setForm({ ...form, tone: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TONES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Channel</Label>
                <Input value={form.channel ?? "email"} onChange={(e) => setForm({ ...form, channel: e.target.value })} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={Boolean(form.is_warm)}
                onChange={(e) => setForm({ ...form, is_warm: e.target.checked })}
              />
              Warm / follow-up (prior placement)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.is_active !== false}
                onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
              />
              Active
            </label>
            <div>
              <Label>Subject template</Label>
              <Input
                value={form.subject_template ?? ""}
                onChange={(e) => setForm({ ...form, subject_template: e.target.value })}
              />
            </div>
            <div>
              <Label>Body template</Label>
              <Textarea
                value={form.body_template ?? ""}
                onChange={(e) => setForm({ ...form, body_template: e.target.value })}
                rows={12}
                className="font-mono text-xs"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Placeholders: {PLACEHOLDERS.join(" ")}
              </p>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={runPreview} disabled={previewing}>
                {previewing ? "Previewing…" : "Live preview"}
              </Button>
              <Button onClick={save} disabled={saving} className="flex-1">{saving ? "Saving…" : "Save"}</Button>
            </div>
            {preview && (
              <Card className="p-4 bg-muted/40 space-y-2">
                <div className="text-xs text-muted-foreground uppercase">Subject</div>
                <div className="text-sm font-medium">{preview.subject}</div>
                <div className="text-xs text-muted-foreground uppercase pt-2">Body</div>
                <pre className="text-xs whitespace-pre-wrap font-sans">{preview.body}</pre>
              </Card>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AdminPitchTemplatesPanel;
