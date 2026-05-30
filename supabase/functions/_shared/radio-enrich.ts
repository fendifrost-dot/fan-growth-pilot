import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  extractEmails,
  extractIgHandle,
  extractLinktreeUrls,
  extractSubmissionLinkFromMarkdown,
  scoreHunterEmail,
} from "./contact-extract.ts";
import { firecrawl, firecrawlSearch } from "./firecrawl.ts";

const RATE_MS = 2200;
const DEFAULT_LIMIT = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function scoreRadioEmail(email: string): number {
  const local = email.split("@")[0].toLowerCase();
  let s = scoreHunterEmail({ value: email });
  if (/^(music|programming|pd|md|radio|studio|onair|requests|demos?|submissions?|pitch)/.test(local)) s += 40;
  if (/^(info|contact|hello|admin|webmaster|sales|ads|advertising)/.test(local)) s -= 15;
  if (/noreply|no-reply|donotreply/.test(local)) s -= 100;
  return s;
}

function pickBestEmail(hits: { value: string }[]): string | null {
  if (!hits.length) return null;
  const ranked = [...hits].sort((a, b) => scoreRadioEmail(b.value) - scoreRadioEmail(a.value));
  return ranked[0]?.value ?? null;
}

function isLikelyStationPage(url: string, callSign: string): boolean {
  const u = url.toLowerCase();
  const cs = callSign.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (cs.length >= 4 && u.includes(cs.slice(0, Math.min(cs.length, 8)))) return true;
  return /\.(com|org|net|fm|radio)/.test(u) && /radio|fm|am\b|station/.test(u);
}

export type RadioEnrichResult = {
  enriched: number;
  skipped: Record<string, number>;
  stations: { station_id: string; contact_email?: string; submission_method?: string }[];
  done: boolean;
  next_offset: number | null;
};

export async function enrichRadioContacts(
  sb: SupabaseClient,
  body: Record<string, unknown>,
): Promise<RadioEnrichResult> {
  if (!Deno.env.get("FIRECRAWL_API_KEY")) {
    throw new Error("FIRECRAWL_API_KEY not configured");
  }

  const limit = Math.min(15, Math.max(1, Number(body.limit) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(body.offset) || 0);
  const stationIds = Array.isArray(body.station_ids)
    ? body.station_ids.map(String).filter(Boolean)
    : [];
  const skipExisting = body.skip_with_email !== false;

  let q = sb.from("radio_targets")
    .select("*")
    .order("total_spins", { ascending: false, nullsFirst: false });

  if (stationIds.length) {
    q = q.in("station_id", stationIds.slice(0, 30));
  } else if (skipExisting) {
    q = q.is("contact_email", null);
  }

  const { data: rows, error } = await q.range(offset, offset + limit - 1);
  if (error) throw new Error(error.message);

  const skipped: Record<string, number> = {
    already_has_email: 0,
    no_contact_found: 0,
    search_empty: 0,
    scrape_failed: 0,
  };
  const patched: RadioEnrichResult["stations"] = [];
  let enriched = 0;

  for (const row of rows ?? []) {
    if (skipExisting && (row.contact_email as string | null)?.trim()) {
      skipped.already_has_email++;
      continue;
    }

    const callSign = String(row.station_call_sign ?? row.station_id).trim();
    const city = [row.city, row.area_name].filter(Boolean).join(" ");
    const query = `"${callSign}" radio ${city} music director submissions contact email`.trim();

    let bestEmail: string | null = null;
    let contactUrl: string | null = (row.contact_url as string | null)?.trim() || null;
    let submissionMethod: string | null = (row.submission_method as string | null) || null;
    let contactName: string | null = (row.contact_name as string | null) || null;

    try {
      const hits = await firecrawlSearch(query, 6);
      const candidates = hits.filter((h) =>
        isLikelyStationPage(h.url, callSign) ||
        /contact|about|music|submission|program/i.test(h.url) ||
        /contact|about|music|submission|program/i.test(`${h.title ?? ""} ${h.description ?? ""}`),
      );
      const toScrape = (candidates.length ? candidates : hits).slice(0, 3);

      if (!toScrape.length) {
        skipped.search_empty++;
        await sleep(RATE_MS);
        continue;
      }

      for (const hit of toScrape) {
        try {
          const scraped = await firecrawl(hit.url, { formats: ["markdown", "html"], waitFor: 2000 });
          const md = scraped.data.markdown ?? "";
          const html = scraped.data.html ?? "";
          const blob = `${md}\n${html}`;

          const emails = extractEmails(blob, html);
          const picked = pickBestEmail(emails);
          if (picked && (!bestEmail || scoreRadioEmail(picked) > scoreRadioEmail(bestEmail))) {
            bestEmail = picked;
          }

          const subLink = extractSubmissionLinkFromMarkdown(md);
          if (subLink && !contactUrl) {
            contactUrl = subLink;
            submissionMethod = "web_form";
          }

          const ig = extractIgHandle(blob);
          if (ig && !contactUrl) {
            contactUrl = `https://www.instagram.com/${ig}/`;
            if (!bestEmail) submissionMethod = "dm";
          }

          for (const lt of extractLinktreeUrls(blob).slice(0, 1)) {
            if (!contactUrl) contactUrl = lt;
          }

          if (bestEmail) break;
          await sleep(800);
        } catch {
          skipped.scrape_failed++;
        }
      }

      if (bestEmail) {
        submissionMethod = "email";
        const patch: Record<string, unknown> = {
          contact_email: bestEmail,
          contact_url: contactUrl,
          submission_method: submissionMethod,
          updated_at: new Date().toISOString(),
        };
        if (contactName) patch.contact_name = contactName;
        const { error: upErr } = await sb.from("radio_targets").update(patch).eq("station_id", row.station_id);
        if (!upErr) {
          enriched++;
          patched.push({
            station_id: row.station_id,
            contact_email: bestEmail,
            submission_method: submissionMethod ?? undefined,
          });
        }
      } else if (contactUrl && submissionMethod) {
        const { error: upErr } = await sb.from("radio_targets").update({
          contact_url: contactUrl,
          submission_method: submissionMethod,
          updated_at: new Date().toISOString(),
        }).eq("station_id", row.station_id);
        if (!upErr) {
          enriched++;
          patched.push({ station_id: row.station_id, submission_method: submissionMethod });
        }
      } else {
        skipped.no_contact_found++;
      }
    } catch {
      skipped.search_empty++;
    }

    await sleep(RATE_MS);
  }

  const batchLen = rows?.length ?? 0;
  const done = batchLen < limit;

  return {
    enriched,
    skipped,
    stations: patched,
    done,
    next_offset: done ? null : offset + batchLen,
  };
}
