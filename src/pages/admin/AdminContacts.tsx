import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { parseContactsCsv, ContactRow } from "@/lib/parseContactsCsv";

interface ContactRecord {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  source: string | null;
  tags: string[] | null;
  subscribed: boolean;
  created_at: string;
  last_sent_at: string | null;
}

const AdminContacts: React.FC = () => {
  const [contacts, setContacts] = useState<ContactRecord[]>([]);
  const [counts, setCounts] = useState<{ total: number; subscribed: number; unsubscribed: number }>({
    total: 0, subscribed: 0, unsubscribed: 0,
  });
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  const [previewRows, setPreviewRows] = useState<ContactRow[] | null>(null);
  const [previewWarnings, setPreviewWarnings] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const fetchContacts = async () => {
    setLoading(true);
    const { data } = await supabase
      .from("email_contacts")
      .select("id, email, first_name, last_name, source, tags, subscribed, created_at, last_sent_at")
      .order("created_at", { ascending: false })
      .limit(500);
    setContacts((data ?? []) as ContactRecord[]);

    const [{ count: total }, { count: subscribed }] = await Promise.all([
      supabase.from("email_contacts").select("*", { count: "exact", head: true }),
      supabase.from("email_contacts").select("*", { count: "exact", head: true }).eq("subscribed", true),
    ]);
    setCounts({
      total: total ?? 0,
      subscribed: subscribed ?? 0,
      unsubscribed: (total ?? 0) - (subscribed ?? 0),
    });
    setLoading(false);
  };

  useEffect(() => { fetchContacts(); }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      (c) =>
        c.email.includes(q) ||
        (c.first_name ?? "").toLowerCase().includes(q) ||
        (c.last_name ?? "").toLowerCase().includes(q) ||
        (c.source ?? "").toLowerCase().includes(q) ||
        (c.tags ?? []).some((t) => t.toLowerCase().includes(q)),
    );
  }, [query, contacts]);

  const onFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      const { rows, warnings } = parseContactsCsv(text);
      setPreviewRows(rows);
      setPreviewWarnings(warnings);
    };
    reader.readAsText(file);
  };

  const performImport = async () => {
    if (!previewRows?.length) return;
    setImporting(true);
    try {
      // Chunk to avoid request payload limits
      let inserted = 0, updated = 0, skipped = 0;
      const chunkSize = 250;
      for (let i = 0; i < previewRows.length; i += chunkSize) {
        const chunk = previewRows.slice(i, i + chunkSize);
        const { data, error } = await supabase.rpc("upsert_email_contacts", { p_rows: chunk as unknown as never });
        if (error) { toast.error(error.message); break; }
        const row = (Array.isArray(data) ? data[0] : data) as any;
        inserted += row?.inserted_count ?? 0;
        updated  += row?.updated_count  ?? 0;
        skipped  += row?.skipped_count  ?? 0;
      }
      toast.success(`Imported: ${inserted} new, ${updated} updated, ${skipped} skipped`);
      setPreviewRows(null);
      setPreviewWarnings([]);
      if (fileRef.current) fileRef.current.value = "";
      await fetchContacts();
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-medium tracking-tight">Contacts</h1>
        <p className="text-sm text-muted-foreground mt-1">First-party supporter list — lowercase email is canonical.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-5"><div className="text-xs uppercase tracking-wide text-muted-foreground">Total</div><div className="text-2xl font-medium mt-1">{counts.total}</div></Card>
        <Card className="p-5"><div className="text-xs uppercase tracking-wide text-muted-foreground">Subscribed</div><div className="text-2xl font-medium mt-1">{counts.subscribed}</div></Card>
        <Card className="p-5"><div className="text-xs uppercase tracking-wide text-muted-foreground">Unsubscribed</div><div className="text-2xl font-medium mt-1">{counts.unsubscribed}</div></Card>
      </div>

      <Card className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-medium">Import CSV</h2>
            <p className="text-xs text-muted-foreground mt-1">Required column: <code>email</code>. Optional: first_name, last_name, phone, source, tags.</p>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
            className="text-sm"
          />
        </div>

        {previewWarnings.length > 0 && (
          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-3">
            {previewWarnings.map((w, i) => <div key={i}>{w}</div>)}
          </div>
        )}

        {previewRows && (
          <div className="space-y-3">
            <div className="text-sm">
              Ready to import <span className="font-medium">{previewRows.length}</span> contacts.
              Existing emails will be updated (additive only), new emails inserted.
            </div>
            <div className="rounded border max-h-64 overflow-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 sticky top-0">
                  <tr><th className="text-left p-2">Email</th><th className="text-left p-2">First name</th><th className="text-left p-2">Source</th><th className="text-left p-2">Tags</th></tr>
                </thead>
                <tbody>
                  {previewRows.slice(0, 25).map((r, i) => (
                    <tr key={i} className="border-t">
                      <td className="p-2">{r.email}</td>
                      <td className="p-2">{r.first_name ?? ""}</td>
                      <td className="p-2">{r.source ?? ""}</td>
                      <td className="p-2">{(r.tags ?? []).join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {previewRows.length > 25 && <div className="text-xs text-muted-foreground p-2">… and {previewRows.length - 25} more</div>}
            </div>
            <div className="flex gap-2">
              <Button onClick={performImport} disabled={importing}>{importing ? "Importing…" : `Import ${previewRows.length} contacts`}</Button>
              <Button variant="ghost" onClick={() => { setPreviewRows(null); setPreviewWarnings([]); if (fileRef.current) fileRef.current.value = ""; }}>Cancel</Button>
            </div>
          </div>
        )}
      </Card>

      <Card className="p-5 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-medium">All contacts</h2>
          <Input
            placeholder="Search email, name, source, tag…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="max-w-xs"
          />
        </div>
        <div className="rounded border overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-2">Email</th>
                <th className="text-left p-2">Name</th>
                <th className="text-left p-2">Source</th>
                <th className="text-left p-2">Tags</th>
                <th className="text-left p-2">Status</th>
                <th className="text-left p-2">Last sent</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={6} className="p-3 text-muted-foreground">Loading…</td></tr>}
              {!loading && filtered.length === 0 && <tr><td colSpan={6} className="p-3 text-muted-foreground">No contacts</td></tr>}
              {filtered.map((c) => (
                <tr key={c.id} className="border-t">
                  <td className="p-2 font-mono text-xs">{c.email}</td>
                  <td className="p-2">{[c.first_name, c.last_name].filter(Boolean).join(" ")}</td>
                  <td className="p-2 text-xs text-muted-foreground">{c.source ?? ""}</td>
                  <td className="p-2 text-xs">{(c.tags ?? []).join(", ")}</td>
                  <td className="p-2 text-xs">
                    {c.subscribed ? <span className="text-emerald-700">subscribed</span> : <span className="text-muted-foreground">unsubscribed</span>}
                  </td>
                  <td className="p-2 text-xs text-muted-foreground">{c.last_sent_at ? new Date(c.last_sent_at).toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
};

export default AdminContacts;
