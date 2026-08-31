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
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { Music2, Plus } from "lucide-react";
import { callHubFn } from "@/lib/hubApi";
import {
  AGGREGATOR_LABEL,
  AGGREGATORS,
  GENRE_STAMP_LABEL,
  GENRE_STAMPS,
  SAMPLE_FLAG_LABEL,
  SAMPLE_FLAGS,
  type Aggregator,
  type GenreStamp,
  type SampleFlag,
} from "@/lib/syncRegisters";

type Category = { id: string; slug: string; label: string; family: string };
type TrackRow = {
  id: string;
  name: string;
  isrc: string | null;
  spotify_url: string | null;
  apple_music_url: string | null;
  soundcloud_url: string | null;
  status: string;
  release_date: string | null;
  default_tone: string;
  short_pitch: string | null;
  pitch_angle: string | null;
  reference_artists: string[];
  notes: string | null;
  updated_at: string;
  aggregator?: Aggregator | string | null;
  genre_stamp?: GenreStamp | string | null;
  has_sample?: SampleFlag | string | null;
  sync_eligible?: boolean | null;
  is_month1_sync_default?: boolean | null;
  track_categories?: { category_id: string; categories: Category | null }[];
};

const TONE_OPTIONS = [
  { value: "warm_personal", label: "Warm & Personal" },
  { value: "casual_friendly", label: "Casual & Friendly" },
  { value: "business_formal", label: "Business Formal" },
  { value: "hyped_energetic", label: "Hyped & Energetic" },
];

const toneLabel = (v: string) => TONE_OPTIONS.find((t) => t.value === v)?.label ?? v;

const emptyForm = (): Partial<TrackRow> & { category_ids: string[] } => ({
  name: "",
  isrc: "",
  spotify_url: "",
  apple_music_url: "",
  soundcloud_url: "",
  status: "active",
  release_date: "",
  default_tone: "warm_personal",
  short_pitch: "",
  pitch_angle: "",
  reference_artists: [],
  notes: "",
  aggregator: "open",
  genre_stamp: "unknown",
  has_sample: "unknown",
  is_month1_sync_default: false,
  category_ids: [],
});

const AdminCatalogue: React.FC = () => {
  const [tracks, setTracks] = useState<TrackRow[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [refInput, setRefInput] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [t, c] = await Promise.all([
        callHubFn<{ rows: TrackRow[] }>("list_tracks"),
        callHubFn<{ rows: Category[] }>("list_categories"),
      ]);
      setTracks(t.rows ?? []);
      setCategories(c.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openNew = () => {
    setForm(emptyForm());
    setRefInput("");
    setSheetOpen(true);
  };

  const openEdit = (row: TrackRow) => {
    const catIds = (row.track_categories ?? [])
      .map((tc) => tc.categories?.id)
      .filter(Boolean) as string[];
    setForm({
      ...row,
      category_ids: catIds,
    });
    setRefInput("");
    setSheetOpen(true);
  };

  const toggleCategory = (id: string) => {
    setForm((f) => {
      const ids = f.category_ids ?? [];
      if (ids.includes(id)) return { ...f, category_ids: ids.filter((x) => x !== id) };
      if (ids.length >= 5) {
        toast.error("Maximum 5 categories per track");
        return f;
      }
      return { ...f, category_ids: [...ids, id] };
    });
  };

  const addRef = () => {
    const v = refInput.trim();
    if (!v) return;
    setForm((f) => ({
      ...f,
      reference_artists: [...(f.reference_artists ?? []), v],
    }));
    setRefInput("");
  };

  const save = async () => {
    if (!form.name?.trim()) {
      toast.error("Track name is required");
      return;
    }
    setSaving(true);
    try {
      await callHubFn("upsert_track", {
        id: form.id,
        name: form.name.trim(),
        isrc: form.isrc || null,
        spotify_url: form.spotify_url || null,
        apple_music_url: form.apple_music_url || null,
        soundcloud_url: form.soundcloud_url || null,
        status: form.status,
        release_date: form.release_date || null,
        default_tone: form.default_tone,
        short_pitch: form.short_pitch || null,
        pitch_angle: form.pitch_angle || null,
        reference_artists: form.reference_artists ?? [],
        notes: form.notes || null,
        aggregator: form.aggregator || "open",
        genre_stamp: form.genre_stamp || "unknown",
        has_sample: form.has_sample || "unknown",
        is_month1_sync_default: Boolean(form.is_month1_sync_default),
        category_ids: form.category_ids ?? [],
      });
      toast.success(form.id ? "Track updated" : "Track added");
      setSheetOpen(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Music2 className="h-6 w-6" /> Song register
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Operator-only catalog: titles, optional ISRC, aggregator, genre stamp, and sample flag.
            Sync-eligible is automatic (no sample only). A DistroKid miss is not unreleased — leave
            aggregator OPEN when the distributor is unknown. Month-1 sync default is Meditate (Hip-Hop/Rap).
          </p>
        </div>
        <Button onClick={openNew}>
          <Plus className="h-4 w-4 mr-1" /> Add Track
        </Button>
      </div>

      <Card className="overflow-hidden" data-testid="song-register">
        {loading ? (
          <p className="p-6 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Aggregator</TableHead>
                <TableHead>Genre</TableHead>
                <TableHead>Sample</TableHead>
                <TableHead>Sync</TableHead>
                <TableHead>ISRC</TableHead>
                <TableHead>Categories</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tracks.map((row) => (
                <TableRow key={row.id} className="cursor-pointer" onClick={() => openEdit(row)}>
                  <TableCell className="font-medium">
                    {row.name}
                    {row.is_month1_sync_default ? (
                      <Badge className="ml-2 text-[10px]" variant="default">Month-1 sync</Badge>
                    ) : null}
                  </TableCell>
                  <TableCell><Badge variant="secondary">{row.status}</Badge></TableCell>
                  <TableCell className="text-xs">
                    {AGGREGATOR_LABEL[(row.aggregator as Aggregator) || "open"] ?? row.aggregator ?? "OPEN"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {GENRE_STAMP_LABEL[(row.genre_stamp as GenreStamp) || "unknown"] ?? row.genre_stamp ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {SAMPLE_FLAG_LABEL[(row.has_sample as SampleFlag) || "unknown"] ?? row.has_sample ?? "—"}
                  </TableCell>
                  <TableCell>
                    {row.sync_eligible ? (
                      <Badge variant="default" className="text-[10px]">Eligible</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px]">No</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {row.isrc?.trim() ? "on file" : "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1 max-w-[200px]">
                      {(row.track_categories ?? []).map((tc) =>
                        tc.categories ? (
                          <Badge key={tc.category_id} variant="outline" className="text-[10px]">
                            {tc.categories.label}
                          </Badge>
                        ) : null,
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(row.updated_at).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))}
              {!tracks.length && (
                <TableRow>
                    <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                    No tracks yet — add titles (ISRC optional). Do not invent TBD singles.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </Card>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{form.id ? "Edit track" : "Add track"}</SheetTitle>
          </SheetHeader>
          <div className="space-y-4 mt-6">
            <div>
              <Label>Name *</Label>
              <Input value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <Label>ISRC (operator only — never shown on public pages)</Label>
              <Input value={form.isrc ?? ""} onChange={(e) => setForm({ ...form, isrc: e.target.value })} placeholder="Optional — do not mint" />
            </div>
            <div>
              <Label>Aggregator</Label>
              <Select value={form.aggregator ?? "open"} onValueChange={(v) => setForm({ ...form, aggregator: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {AGGREGATORS.map((a) => (
                    <SelectItem key={a} value={a}>{AGGREGATOR_LABEL[a]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground mt-1">Catalog is split. OPEN is not unreleased.</p>
            </div>
            <div>
              <Label>Genre stamp</Label>
              <Select value={form.genre_stamp ?? "unknown"} onValueChange={(v) => setForm({ ...form, genre_stamp: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {GENRE_STAMPS.map((g) => (
                    <SelectItem key={g} value={g}>{GENRE_STAMP_LABEL[g]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground mt-1">
                Meditate is Hip-Hop/Rap only. House/electronic pool is Balenciaga (Let Me Freeze), Electrilla, Designed For Me (Control).
              </p>
            </div>
            <div>
              <Label>Has sample</Label>
              <Select value={form.has_sample ?? "unknown"} onValueChange={(v) => setForm({ ...form, has_sample: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SAMPLE_FLAGS.map((s) => (
                    <SelectItem key={s} value={s}>{SAMPLE_FLAG_LABEL[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground mt-1">Sync-eligible only when this is “no sample”.</p>
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={Boolean(form.is_month1_sync_default)}
                onCheckedChange={(v) => setForm({ ...form, is_month1_sync_default: Boolean(v) })}
              />
              Month-1 sync default (Meditate)
            </label>
            <div>
              <Label>Spotify URL</Label>
              <Input value={form.spotify_url ?? ""} onChange={(e) => setForm({ ...form, spotify_url: e.target.value })} />
            </div>
            <div>
              <Label>Apple Music URL</Label>
              <Input value={form.apple_music_url ?? ""} onChange={(e) => setForm({ ...form, apple_music_url: e.target.value })} />
            </div>
            <div>
              <Label>SoundCloud URL</Label>
              <Input value={form.soundcloud_url ?? ""} onChange={(e) => setForm({ ...form, soundcloud_url: e.target.value })} />
            </div>
            <div>
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                  <SelectItem value="unreleased">Unreleased</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Release date</Label>
              <Input type="date" value={form.release_date ?? ""} onChange={(e) => setForm({ ...form, release_date: e.target.value })} />
            </div>
            <div>
              <Label>Default tone</Label>
              <Select value={form.default_tone} onValueChange={(v) => setForm({ ...form, default_tone: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TONE_OPTIONS.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Short pitch (1–2 sentences)</Label>
              <Textarea value={form.short_pitch ?? ""} onChange={(e) => setForm({ ...form, short_pitch: e.target.value })} rows={2} />
            </div>
            <div>
              <Label>Pitch angle (longer)</Label>
              <Textarea value={form.pitch_angle ?? ""} onChange={(e) => setForm({ ...form, pitch_angle: e.target.value })} rows={3} />
            </div>
            <div>
              <Label>Reference artists</Label>
              <div className="flex gap-2">
                <Input value={refInput} onChange={(e) => setRefInput(e.target.value)} placeholder="Add artist…" onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addRef())} />
                <Button type="button" variant="outline" size="sm" onClick={addRef}>Add</Button>
              </div>
              <div className="flex flex-wrap gap-1 mt-2">
                {(form.reference_artists ?? []).map((a) => (
                  <Badge key={a} variant="secondary" className="cursor-pointer" onClick={() => setForm({ ...form, reference_artists: (form.reference_artists ?? []).filter((x) => x !== a) })}>
                    {a} ×
                  </Badge>
                ))}
              </div>
            </div>
            <div>
              <Label>Categories (max 5)</Label>
              <div className="border rounded-md p-3 max-h-40 overflow-y-auto space-y-2 mt-1">
                {categories.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox
                      checked={(form.category_ids ?? []).includes(c.id)}
                      onCheckedChange={() => toggleCategory(c.id)}
                    />
                    <span>{c.label}</span>
                    <span className="text-muted-foreground text-xs">({c.family})</span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea value={form.notes ?? ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />
            </div>
            <Button onClick={save} disabled={saving} className="w-full">
              {saving ? "Saving…" : "Save track"}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
};

export default AdminCatalogue;
