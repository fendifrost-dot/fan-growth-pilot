const DEFAULT_SUPABASE_URL = "https://vsemrziqxrrfcquxfnwd.supabase.co";

/**
 * Public redirect edge function — issues token + 302 to t.me bot.
 * @see supabase/functions/telegram-signup-redirect/index.ts
 */
export function buildInnerCircleRedirectUrl(
  slug: string,
  options?: {
    email?: string | null;
    supabaseUrl?: string;
    searchParams?: URLSearchParams;
  },
): string {
  const base =
    (options?.supabaseUrl || import.meta.env.VITE_SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(
      /\/$/,
      "",
    );
  const url = new URL(`${base}/functions/v1/telegram-signup-redirect`);
  url.searchParams.set("slug", slug || "inner-circle");

  const email = options?.email?.trim().toLowerCase();
  if (email) url.searchParams.set("email", email);

  if (options?.searchParams) {
    for (const [key, value] of options.searchParams.entries()) {
      if (value && !url.searchParams.has(key)) {
        url.searchParams.set(key, value);
      }
    }
  }

  return url.toString();
}

/** Show Inner Circle CTA when metadata flag is set or slug is the canonical inner-circle link. */
export function shouldShowInnerCircleCta(
  slug: string | undefined,
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  if (slug === "inner-circle") return true;
  const flag = metadata?.inner_circle_enabled;
  return flag === true || flag === "true";
}
