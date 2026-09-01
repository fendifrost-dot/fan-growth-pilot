import React, { useEffect, useState } from "react";
import AdminCatalogue from "@/pages/admin/AdminCatalogue";
import AdminLicensing from "@/pages/admin/AdminLicensing";

/**
 * DEV-only stacked preview of the two operator registers.
 * Intercepts control-center-api so the views render without a live session.
 */
const SEED_TRACKS = [
  {
    id: "t-med",
    name: "Meditate",
    isrc: null,
    status: "active",
    default_tone: "warm_personal",
    reference_artists: [],
    updated_at: new Date().toISOString(),
    aggregator: "open",
    genre_stamp: "hip_hop_rap",
    has_sample: "no",
    sync_eligible: true,
    is_month1_sync_default: true,
    track_categories: [],
  },
  {
    id: "t-dfm",
    name: "Designed For Me (Control)",
    isrc: null,
    status: "active",
    default_tone: "warm_personal",
    reference_artists: [],
    updated_at: new Date().toISOString(),
    aggregator: "open",
    genre_stamp: "house_electronic",
    has_sample: "unknown",
    sync_eligible: false,
    is_month1_sync_default: false,
    track_categories: [],
  },
  {
    id: "t-bal",
    name: "Balenciaga (Let Me Freeze)",
    isrc: null,
    status: "active",
    default_tone: "warm_personal",
    reference_artists: [],
    updated_at: new Date().toISOString(),
    aggregator: "open",
    genre_stamp: "house_electronic",
    has_sample: "unknown",
    sync_eligible: false,
    is_month1_sync_default: false,
    track_categories: [],
  },
  {
    id: "t-el",
    name: "Electrilla",
    isrc: null,
    status: "active",
    default_tone: "warm_personal",
    reference_artists: [],
    updated_at: new Date().toISOString(),
    aggregator: "open",
    genre_stamp: "house_electronic",
    has_sample: "unknown",
    sync_eligible: false,
    is_month1_sync_default: false,
    track_categories: [],
  },
  {
    id: "t-prada",
    name: "Neva Too Much Prada",
    isrc: null,
    status: "active",
    default_tone: "warm_personal",
    reference_artists: [],
    updated_at: new Date().toISOString(),
    aggregator: "open",
    genre_stamp: "unknown",
    has_sample: "yes",
    sync_eligible: false,
    is_month1_sync_default: false,
    track_categories: [],
  },
];

function installPreviewFetch(): () => void {
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.includes("control-center-api")) return original(input, init);
    let action = "";
    try {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      action = String(body.action ?? "");
    } catch { /* ignore */ }
    const payload =
      action === "list_tracks" ? { rows: SEED_TRACKS } :
      action === "list_categories" ? { rows: [] } :
      action === "list_music_supervisors" ? { rows: [] } :
      action === "list_licensing_pitches" ? { rows: [] } :
      { ok: true };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return () => { window.fetch = original; };
}

const RegisterPreview: React.FC = () => {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const undo = installPreviewFetch();
    setReady(true);
    return undo;
  }, []);
  if (!ready) return <p className="p-8 text-sm text-muted-foreground">Preparing preview…</p>;
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="max-w-6xl mx-auto px-6 py-4 font-medium">Fendi Frost · Admin (preview)</div>
      </header>
      <main className="max-w-6xl mx-auto px-6 py-8 space-y-16">
        <AdminCatalogue />
        <AdminLicensing />
      </main>
    </div>
  );
};

export default RegisterPreview;
