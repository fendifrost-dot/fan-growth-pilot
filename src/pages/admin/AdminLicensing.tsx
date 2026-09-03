import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
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
import { toast } from "sonner";
import { callHubFn } from "@/lib/hubApi";
import {
  LICENSING_RESPONSES,
  licensingResponseFromRow,
  type LicensingResponse,
} from "@/lib/syncRegisters";

type Supervisor = {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  notes: string | null;
  source: string | null;
  updated_at: string;
};

type TrackOpt = { id: string; name: string; is_month1_sync_default?: boolean | null };

type PitchRow = {
  id: string;
  supervisor_id: string | null;
  contact_name: string;
  contact_email: string | null;
  company: string | null;
  track_id: string | null;
  track_name: string;
  pitched_at: string;
  status: string;
  reply_received: boolean;
  placed: boolean;
  response_status: string;
  response_notes: string | null;
};

const RESPONSE_LABEL: Record<LicensingResponse, string> = {
  awaiting: "Awaiting",
  replied: "Replied",
  licensed: "Licensed",
  declined: "Declined",
};

const emptySupervisor = { name: "", company: "", email: "", notes: "", source: "" };

const AdminLicensing: React.FC = () => {
  const [supervisors, setSupervisors] = useState<Supervisor[]>([]);
  const [tracks, setTracks] = useState<TrackOpt[]>([]);
  const [pitches, setPitches] = useState<PitchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  const [supForm, setSupForm] = useState(emptySupervisor);
  const [pitchForm, setPitchForm] = useState({
    supervisor_id: "",
    contact_name: "",
    contact_email: "",
    company: "",
    track_id: "",
    pitched_at: new Date().toISOString().slice(0, 10),
    response_status: "awaiting" as LicensingResponse,
    response_notes: "",
  });
  const [onlyPending, setOnlyPending] = useState(false);
  const [trackFilter, setTrackFilter] = useState("");
  const [editingNotesId, setEditingNotesId] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState("");

  const defaultTrackId = useMemo(() => {
    return tracks.find((t) => t.is_month1_sync_default)?.id ?? tracks[0]?.id ?? "";
  }, [tracks]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sup, tr, lg] = await Promise.all([
        callHubFn<{ rows: Supervisor[] }>("list_music_supervisors", {}),
        callHubFn<{ rows: TrackOpt[] }>("list_tracks", {}),
        callHubFn<{ rows: PitchRow[] }>("list_licensing_pitches", {
          track_name: trackFilter.trim() || undefined,
          only_pending_response: onlyPending,
          limit: 200,
        }),
      ]);
      setSupervisors(sup.rows ?? []);
      setTracks((tr.rows ?? []).map((r) => ({ id: r.id, name: r.name, is_month1_sync_default: r.is_month1_sync_default })));
      setPitches(lg.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load licensing register");
    } finally {
      setLoading(false);
    }
  }, [trackFilter, onlyPending]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!pitchForm.track_id && defaultTrackId) {
      setPitchForm((f) => ({ ...f, track_id: defaultTrackId }));
    }
  }, [defaultTrackId, pitchForm.track_id]);

  const saveSupervisor = async () => {
    if (!supForm.name.trim()) {
      toast.error("Name is required");
      return;
    }
    setSaving("supervisor");
    try {
      await callHubFn("upsert_music_supervisor", {
        name: supForm.name.trim(),
        company: supForm.company.trim() || null,
        email: supForm.email.trim() || null,
        notes: supForm.notes.trim() || null,
        source: supForm.source.trim() || null,
      });
      toast.success("Supervisor saved");
      setSupForm(emptySupervisor);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(null);
    }
  };

  const logPitch = async () => {
    const supervisorId = pitchForm.supervisor_id || undefined;
    const contactName = pitchForm.contact_name.trim();
    if (!supervisorId && !contactName) {
      toast.error("Pick a roster contact or type a name");
      return;
    }
    if (!pitchForm.track_id) {
      toast.error("Pick a song");
      return;
    }
    setSaving("pitch");
    try {
      await callHubFn("log_licensing_pitch", {
        supervisor_id: supervisorId || null,
        contact_name: contactName || undefined,
        contact_email: pitchForm.contact_email.trim() || null,
        company: pitchForm.company.trim() || null,
        track_id: pitchForm.track_id,
        pitched_at: pitchForm.pitched_at ? new Date(pitchForm.pitched_at + "T12:00:00").toISOString() : undefined,
        response_status: pitchForm.response_status,
        response_notes: pitchForm.response_notes.trim() || null,
      });
      toast.success("Licensing pitch recorded");
      setPitchForm((f) => ({
        ...f,
        supervisor_id: "",
        contact_name: "",
        contact_email: "",
        company: "",
        response_status: "awaiting",
        response_notes: "",
        pitched_at: new Date().toISOString().slice(0, 10),
      }));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Log failed");
    } finally {
      setSaving(null);
    }
  };

  const updateResponse = async (row: PitchRow, choice: LicensingResponse) => {
    setSaving(row.id);
    try {
      await callHubFn("mark_licensing_response", { licensing_pitch_id: row.id, response_status: choice });
      toast.success(`Marked ${RESPONSE_LABEL[choice].toLowerCase()}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setSaving(null);
    }
  };

  const saveNotes = async (rowId: string) => {
    setSaving(rowId);
    try {
      await callHubFn("mark_licensing_response", { licensing_pitch_id: rowId, response_notes: notesDraft });
      toast.success("Notes saved");
      setEditingNotesId(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save notes");
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-8" data-testid="licensing-register">
      <div>
        <Link to="/admin" className="text-xs text-muted-foreground hover:underline">← Command center</Link>
        <h1 className="text-2xl font-semibold tracking-tight mt-1">Licensing register</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          Same bookkeeping as playlist submissions: who was pitched, which song, when, whether they responded.
          No licenses exist today — this log starts empty. Month-1 default song is Meditate.
        </p>
      </div>

      <Card className="p-5 space-y-4" data-testid="supervisor-roster">
        <div>
          <h2 className="font-medium">Music supervisor / manager roster</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Daily input: name, company, email, notes, source. Do not import the historical email dump.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <Label>Name *</Label>
            <Input value={supForm.name} onChange={(e) => setSupForm({ ...supForm, name: e.target.value })} />
          </div>
          <div>
            <Label>Company</Label>
            <Input value={supForm.company} onChange={(e) => setSupForm({ ...supForm, company: e.target.value })} />
          </div>
          <div>
            <Label>Email</Label>
            <Input type="email" value={supForm.email} onChange={(e) => setSupForm({ ...supForm, email: e.target.value })} />
          </div>
          <div>
            <Label>Source</Label>
            <Input value={supForm.source} onChange={(e) => setSupForm({ ...supForm, source: e.target.value })} placeholder="e.g. IMDb, LinkedIn, referral" />
          </div>
          <div className="md:col-span-2">
            <Label>Notes</Label>
            <Textarea value={supForm.notes} onChange={(e) => setSupForm({ ...supForm, notes: e.target.value })} rows={2} />
          </div>
        </div>
        <Button onClick={saveSupervisor} disabled={saving === "supervisor"}>
          {saving === "supervisor" ? "Saving…" : "Add to roster"}
        </Button>

        <div className="overflow-x-auto border rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3">Name</th>
                <th className="text-left p-3">Company</th>
                <th className="text-left p-3">Email</th>
                <th className="text-left p-3">Source</th>
                <th className="text-left p-3">Notes</th>
              </tr>
            </thead>
            <tbody>
              {supervisors.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-muted-foreground">
                    Roster is empty — add contacts as you find them.
                  </td>
                </tr>
              ) : (
                supervisors.map((s) => (
                  <tr key={s.id} className="border-t">
                    <td className="p-3 font-medium">{s.name}</td>
                    <td className="p-3 text-xs">{s.company ?? "—"}</td>
                    <td className="p-3 text-xs">{s.email ?? "—"}</td>
                    <td className="p-3 text-xs">{s.source ?? "—"}</td>
                    <td className="p-3 text-xs text-muted-foreground max-w-xs truncate">{s.notes ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-5 space-y-4" data-testid="licensing-pitch-form">
        <div>
          <h2 className="font-medium">Record a licensing pitch</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Contact + song + date + response — the same four facts as a playlist pitch.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <Label>Roster contact</Label>
            <Select
              value={pitchForm.supervisor_id || "none"}
              onValueChange={(v) => {
                const id = v === "none" ? "" : v;
                const s = supervisors.find((x) => x.id === id);
                setPitchForm((f) => ({
                  ...f,
                  supervisor_id: id,
                  contact_name: s?.name ?? f.contact_name,
                  contact_email: s?.email ?? f.contact_email,
                  company: s?.company ?? f.company,
                }));
              }}
            >
              <SelectTrigger><SelectValue placeholder="Optional — pick from roster" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— freeform —</SelectItem>
                {supervisors.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}{s.company ? ` · ${s.company}` : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Contact name</Label>
            <Input value={pitchForm.contact_name} onChange={(e) => setPitchForm({ ...pitchForm, contact_name: e.target.value })} />
          </div>
          <div>
            <Label>Email</Label>
            <Input type="email" value={pitchForm.contact_email} onChange={(e) => setPitchForm({ ...pitchForm, contact_email: e.target.value })} />
          </div>
          <div>
            <Label>Company</Label>
            <Input value={pitchForm.company} onChange={(e) => setPitchForm({ ...pitchForm, company: e.target.value })} />
          </div>
          <div>
            <Label>Song</Label>
            <Select value={pitchForm.track_id} onValueChange={(v) => setPitchForm({ ...pitchForm, track_id: v })}>
              <SelectTrigger><SelectValue placeholder="Select song" /></SelectTrigger>
              <SelectContent>
                {tracks.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}{t.is_month1_sync_default ? " (month-1 default)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Date pitched</Label>
            <Input type="date" value={pitchForm.pitched_at} onChange={(e) => setPitchForm({ ...pitchForm, pitched_at: e.target.value })} />
          </div>
          <div>
            <Label>Response</Label>
            <Select value={pitchForm.response_status} onValueChange={(v) => setPitchForm({ ...pitchForm, response_status: v as LicensingResponse })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {LICENSING_RESPONSES.map((r) => (
                  <SelectItem key={r} value={r}>{RESPONSE_LABEL[r]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Notes</Label>
            <Input value={pitchForm.response_notes} onChange={(e) => setPitchForm({ ...pitchForm, response_notes: e.target.value })} />
          </div>
        </div>
        <Button onClick={logPitch} disabled={saving === "pitch"}>
          {saving === "pitch" ? "Saving…" : "Log pitch"}
        </Button>
      </Card>

      <Card className="p-4 flex flex-wrap gap-4 items-end">
        <div>
          <label className="text-xs text-muted-foreground">Filter by track</label>
          <Input className="mt-1 w-72" value={trackFilter} onChange={(e) => setTrackFilter(e.target.value)} />
        </div>
        <div className="flex items-center gap-2 pb-1">
          <input
            id="lic-only-pending"
            type="checkbox"
            checked={onlyPending}
            onChange={(e) => setOnlyPending(e.target.checked)}
          />
          <label htmlFor="lic-only-pending" className="text-sm">Only awaiting response</label>
        </div>
        <Button variant="outline" onClick={load} disabled={loading}>Refresh</Button>
      </Card>

      <div className="overflow-x-auto border rounded-lg" data-testid="licensing-pitch-log">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">Pitched</th>
              <th className="text-left p-3">Contact</th>
              <th className="text-left p-3">Song</th>
              <th className="text-left p-3">Response</th>
              <th className="text-left p-3">Notes</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="p-4 text-muted-foreground">Loading…</td></tr>
            ) : pitches.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-6 text-muted-foreground text-center">
                  No licensing pitches yet. None are in the pipeline — log the first one above.
                </td>
              </tr>
            ) : (
              pitches.map((r) => {
                const choice = licensingResponseFromRow(r);
                return (
                  <tr key={r.id} className="border-t align-top">
                    <td className="p-3 text-xs whitespace-nowrap">
                      {r.pitched_at ? new Date(r.pitched_at).toLocaleDateString() : "—"}
                    </td>
                    <td className="p-3">
                      <div className="font-medium">{r.contact_name}</div>
                      <div className="text-xs text-muted-foreground">{r.company || r.contact_email || "—"}</div>
                    </td>
                    <td className="p-3 text-xs">{r.track_name}</td>
                    <td className="p-3">
                      <Select
                        value={choice}
                        onValueChange={(v) => updateResponse(r, v as LicensingResponse)}
                        disabled={saving === r.id}
                      >
                        <SelectTrigger className="w-40 h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {LICENSING_RESPONSES.map((opt) => (
                            <SelectItem key={opt} value={opt}>{RESPONSE_LABEL[opt]}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="p-3 max-w-md">
                      {editingNotesId === r.id ? (
                        <div className="space-y-1">
                          <Textarea value={notesDraft} onChange={(e) => setNotesDraft(e.target.value)} className="text-xs" rows={3} />
                          <div className="flex gap-1">
                            <Button size="sm" onClick={() => saveNotes(r.id)} disabled={saving === r.id}>Save</Button>
                            <Button size="sm" variant="ghost" onClick={() => { setEditingNotesId(null); setNotesDraft(""); }}>Cancel</Button>
                          </div>
                        </div>
                      ) : (
                        <div
                          className="text-xs text-muted-foreground cursor-pointer hover:text-foreground"
                          onClick={() => { setEditingNotesId(r.id); setNotesDraft(r.response_notes ?? ""); }}
                        >
                          {r.response_notes || <span className="italic">click to add notes</span>}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default AdminLicensing;
