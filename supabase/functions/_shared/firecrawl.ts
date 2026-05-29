const FIRECRAWL_URL = "https://api.firecrawl.dev/v1/scrape";

export type FirecrawlScrapeResult = {
  markdown: string;
  html: string;
  extract: Record<string, unknown> | null;
};

export type FirecrawlResponse = { data: FirecrawlScrapeResult };

export async function firecrawlScrape(
  url: string,
  opts?: {
    schema?: Record<string, unknown>;
    formats?: string[];
    waitFor?: number;
  },
): Promise<FirecrawlScrapeResult> {
  const key = Deno.env.get("FIRECRAWL_API_KEY");
  if (!key) throw new Error("FIRECRAWL_API_KEY not set");

  const formats = opts?.formats ??
    (opts?.schema ? ["extract", "markdown"] : ["markdown"]);

  const body: Record<string, unknown> = {
    url,
    formats,
    onlyMainContent: false,
    waitFor: opts?.waitFor ?? 1500,
  };
  if (opts?.schema) {
    body.extract = { schema: opts.schema };
  }

  const res = await fetch(FIRECRAWL_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (json as { error?: string }).error ?? res.status;
    throw new Error(`Firecrawl ${res.status}: ${String(err).slice(0, 200)}`);
  }

  const data = (json as {
    data?: { markdown?: string; html?: string; extract?: Record<string, unknown> };
    markdown?: string;
    html?: string;
    extract?: Record<string, unknown>;
  }).data ?? json;

  return {
    markdown: data?.markdown ?? "",
    html: data?.html ?? "",
    extract: (data?.extract as Record<string, unknown>) ?? null,
  };
}

/** Alias for enrichment callers expecting `{ data: { markdown, html } }`. */
export async function firecrawl(
  url: string,
  opts?: { schema?: Record<string, unknown>; formats?: string[]; waitFor?: number },
): Promise<FirecrawlResponse> {
  const data = await firecrawlScrape(url, opts);
  return { data };
}

export async function firecrawlMarkdown(url: string, waitFor = 1500): Promise<string> {
  const { markdown } = await firecrawlScrape(url, { waitFor });
  return markdown;
}

export type FirecrawlSearchHit = {
  url: string;
  title?: string;
  description?: string;
};

/** Web search for curator contact hints (Linktree, IG) when Spotify profile is empty. */
export async function firecrawlSearch(query: string, limit = 5): Promise<FirecrawlSearchHit[]> {
  const key = Deno.env.get("FIRECRAWL_API_KEY");
  if (!key) throw new Error("FIRECRAWL_API_KEY not set");

  const res = await fetch("https://api.firecrawl.dev/v1/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (json as { error?: string }).error ?? res.status;
    throw new Error(`Firecrawl search ${res.status}: ${String(err).slice(0, 200)}`);
  }

  const raw = (json as { data?: unknown }).data ?? json;
  const list = Array.isArray(raw) ? raw : (raw as { web?: unknown })?.web;
  if (!Array.isArray(list)) return [];

  return list
    .map((item) => {
      const o = item as Record<string, unknown>;
      const url = String(o.url ?? o.link ?? "").trim();
      if (!url) return null;
      return {
        url,
        title: o.title ? String(o.title) : undefined,
        description: o.description ? String(o.description) : undefined,
      };
    })
    .filter((h): h is FirecrawlSearchHit => h !== null);
}
