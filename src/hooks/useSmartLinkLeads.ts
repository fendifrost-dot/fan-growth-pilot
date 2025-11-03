import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export const useSmartLinkLeads = () => {
  const { data: leads, isLoading } = useQuery({
    queryKey: ["smart-link-leads"],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase
        .from("smart_link_leads")
        .select(`
          *,
          smart_links (
            title,
            slug
          )
        `)
        .order("created_at", { ascending: false })
        .limit(100);

      if (error) throw error;
      return data;
    },
  });

  return {
    leads: leads || [],
    isLoading,
  };
};
