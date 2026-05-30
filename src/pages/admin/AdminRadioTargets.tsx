import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { callHubFn } from "@/lib/hubApi";

type PlayedSong = { song_id?: string; song_name?: string | null; spins?: number };

type RadioTarget = {
  station_id: string;
  station_call_sign: string;
  city: string | null;
  area_name: string | null;
  total_spins: number | null;
  warmth: string | null;
  contact_email: string | null;
  contact_name: string | null;
  pitch_status: string | null;
  songs_played: PlayedSong[] | string | null;
};

function topSong(row: RadioTarget): string {
  const raw = row.songs_played;
  const songs: PlayedSong[] = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? (() => {
          try {
            const p = JSON.parse(raw);
            return Array.isArray(p) ? p : [];
          } catch {
            return [];
          }
        })()
      : [];
  if (!songs.length) return "—";
  const best = [...songs].sort((a, b) => (Number(b.spins) || 0) - (Number(a.spins) || 0))[0];
  const name = best.song_name?.trim();
  const spins = Number(best.spins) || 0;
  return name ? `${name} (${spins})` : `— (${spins})`;
}

const TRACK_DEFAULT = "Designed For Me (Control)";

const AdminRadioTargets: React.FC = () => {
  const [targets, setTargets] = useState<RadioTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [trackName, setTrackName] = useState(TRACK_DEFAULT);
  const [hasEmailOnly, setHasEmailOnly] = useState(false);
  const [notPitchedOnly, setNotPitchedOnly] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  const [emailEdits, setEmailEdits] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await callHubFn<{ targets: RadioTarget[] }>("get_radio_targets", {});
      setTargets(res.targets ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load radio targets");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    return targets.filter((t) => {
      if (hasEmailOnly && !(t.contact_email || "").trim()) return false;
      if (notPitchedOnly && (t.pitch_status || "") === "pitched") return false;
      return true;
    });
  }, [targets, hasEmailOnly, notPitchedOnly]);

  const patchEmail = async (stationId: string) => {
    const email = (emailEdits[stationId] ?? "").trim();
    setBusyId(stationId);
    try {
      await callHubFn("patch_radio_target", { station_id: stationId, contact_email: email });
      toast.success("Email saved");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Patch failed");
    } finally {
      setBusyId(null);
    }
  };

  const draftPitch = async (stationId: string) => {
    setBusyId(stationId);
    try {
      const res = await callHubFn<{
        pitch_id: string;
        subject: string;
        body: string;
        spun_song: string | null;
      }>("draft_radio_pitch", { station_id: stationId, track_name: trackName });
      await navigator.clipboard.writeText(
        `Subject: ${res.subject}\n\n${res.body}`,
      ).catch(() => undefined);
      toast.success(
        res.spun_song
          ? `Draft saved (thanks for spinning "${res.spun_song}") — copied to clipboard`
          : "Draft saved — copied to clipboard",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Draft failed");
    } finally {
      setBusyId(null);
    }
  };

  const sendPitch = async (stationId: string) => {
    if (!confirm("Send radio pitch email now?")) return;
    setBusyId(stationId);
    try {
      const res = await callHubFn<{ sent: boolean; pitch_id: string; to: string }>("send_radio_pitch", {
        station_id: stationId,
        track_name: trackName,
      });
      toast.success(`Sent to ${res.to}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusyId(null);
    }
  };

  const backfillBaseline = async () => {
    if (!confirm("Upsert apple_station_plays from radio_targets.songs_played (2026-05-30 week baseline)?")) return;
    setBackfilling(true);
    try {
      const res = await callHubFn<{
        plays_upserted: number;
        stations: number;
        spins_total: number;
        snapshot_week: string;
      }>("backfill_apple_station_baseline", {
        snapshot_week: "2026-05-26",
        snapshot_date: "2026-05-30",
      });
      toast.success(
        `Baseline: ${res.plays_upserted} rows, ${res.stations} stations, ${res.spins_total} spins (week ${res.snapshot_week})`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Backfill failed — set AMFA_ARTIST_ID or pass artist_id");
    } finally {
      setBackfilling(false);
    }
  };

  const withEmail = targets.filter((t) => (t.contact_email || "").trim()).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Radio / DJ outreach</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {targets.length} warm stations (already spinning you) · {withEmail} with email
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={load} disabled={loading}>
            Refresh
          </Button>
          <Button variant="secondary" onClick={backfillBaseline} disabled={backfilling}>
            {backfilling ? "Backfilling…" : "Backfill play-log baseline"}
          </Button>
        </div>
      </div>

      <Card className="p-4 flex flex-wrap gap-4 items-center">
        <label className="text-sm">
          New track to pitch
          <Input
            className="mt-1 w-64"
            value={trackName}
            onChange={(e) => setTrackName(e.target.value)}
          />
        </label>
        <label className="text-sm flex items-center gap-2 mt-5">
          <input
            type="checkbox"
            checked={hasEmailOnly}
            onChange={(e) => setHasEmailOnly(e.target.checked)}
          />
          Has email only
        </label>
        <label className="text-sm flex items-center gap-2 mt-5">
          <input
            type="checkbox"
            checked={notPitchedOnly}
            onChange={(e) => setNotPitchedOnly(e.target.checked)}
          />
          Not pitched yet
        </label>
      </Card>

      {loading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <div className="overflow-x-auto border rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3">Station</th>
                <th className="text-left p-3">City</th>
                <th className="text-right p-3">Spins</th>
                <th className="text-left p-3">Top spun</th>
                <th className="text-left p-3">Email</th>
                <th className="text-left p-3">Status</th>
                <th className="text-right p-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const busy = busyId === row.station_id;
                const emailVal = emailEdits[row.station_id] ?? row.contact_email ?? "";
                return (
                  <tr key={row.station_id} className="border-t">
                    <td className="p-3 font-medium">{row.station_call_sign}</td>
                    <td className="p-3 text-muted-foreground">
                      {[row.city, row.area_name].filter(Boolean).join(", ") || "—"}
                    </td>
                    <td className="p-3 text-right">{row.total_spins ?? 0}</td>
                    <td className="p-3 max-w-[200px] truncate" title={topSong(row)}>
                      {topSong(row)}
                    </td>
                    <td className="p-3">
                      <Input
                        className="h-8 w-48"
                        placeholder="curator@station.com"
                        value={emailVal}
                        onChange={(e) =>
                          setEmailEdits((prev) => ({ ...prev, [row.station_id]: e.target.value }))
                        }
                      />
                    </td>
                    <td className="p-3">{row.pitch_status ?? "not_pitched"}</td>
                    <td className="p-3 text-right space-x-1">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => patchEmail(row.station_id)}
                      >
                        Save email
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || !emailVal.trim()}
                        onClick={() => draftPitch(row.station_id)}
                      >
                        Draft
                      </Button>
                      <Button
                        size="sm"
                        disabled={busy || !emailVal.trim()}
                        onClick={() => sendPitch(row.station_id)}
                      >
                        Send
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!filtered.length && (
            <p className="p-6 text-muted-foreground text-center">No stations match filters.</p>
          )}
        </div>
      )}
    </div>
  );
};

export default AdminRadioTargets;
