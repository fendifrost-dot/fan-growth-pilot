// Tiny CSV parser tailored to contact-list imports.
// Handles quoted fields with commas/newlines, escaped quotes ("").
// Returns array of { email, first_name, last_name, phone, source, tags }
// — any extra columns are ignored. Column matching is case-insensitive
// and tolerant of common aliases (e.g. "Email Address", "First Name").

export interface ContactRow {
  email: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  source?: string;
  tags?: string[];
}

const ALIASES: Record<string, keyof Omit<ContactRow, "tags"> | "tags"> = {
  email: "email",
  "email address": "email",
  "e-mail": "email",
  "first name": "first_name",
  firstname: "first_name",
  first_name: "first_name",
  fname: "first_name",
  "last name": "last_name",
  lastname: "last_name",
  last_name: "last_name",
  lname: "last_name",
  phone: "phone",
  "phone number": "phone",
  mobile: "phone",
  source: "source",
  list: "source",
  tags: "tags",
  groups: "tags",
};

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* swallow */ }
      else { field += c; }
    }
  }
  // Flush
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

export function parseContactsCsv(text: string): { rows: ContactRow[]; warnings: string[] } {
  const warnings: string[] = [];
  const matrix = parseCSV(text);
  if (matrix.length === 0) return { rows: [], warnings: ["Empty file"] };

  const headerRaw = matrix[0].map((h) => h.trim().toLowerCase());
  const colMap: (keyof ContactRow | null)[] = headerRaw.map((h) => (ALIASES[h] ?? null) as keyof ContactRow | null);

  if (!colMap.includes("email")) {
    warnings.push("No 'email' column found in header. Looked for: email, email address, e-mail");
    return { rows: [], warnings };
  }

  const rows: ContactRow[] = [];
  for (let r = 1; r < matrix.length; r++) {
    const cells = matrix[r];
    const row: ContactRow = { email: "" };
    for (let c = 0; c < cells.length; c++) {
      const key = colMap[c];
      if (!key) continue;
      const val = cells[c].trim();
      if (!val) continue;
      if (key === "tags") {
        row.tags = val.split(/[,;|]/).map((t) => t.trim()).filter(Boolean);
      } else {
        row[key] = val;
      }
    }
    if (!row.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) {
      // skip silently — we only warn in aggregate
      continue;
    }
    row.email = row.email.toLowerCase();
    rows.push(row);
  }

  // Dedupe by email within the file
  const seen = new Set<string>();
  const deduped = rows.filter((r) => {
    if (seen.has(r.email)) return false;
    seen.add(r.email);
    return true;
  });

  if (deduped.length !== rows.length) {
    warnings.push(`Removed ${rows.length - deduped.length} duplicate rows within the CSV.`);
  }

  return { rows: deduped, warnings };
}
