// Re-export shim. Single source of truth lives in
// supabase/functions/_shared/opportunities/conversations.ts so the opportunities-api Edge
// Function imports it IN-TREE (guaranteed to bundle on deploy). Vite/vitest reach
// the same physical module through this shim — no divergent logic.
export * from "../../../supabase/functions/_shared/opportunities/conversations.ts";
