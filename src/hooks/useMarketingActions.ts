import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface MarketingAction {
  id: string;
  action_type: string;
  status: string;
  priority: string;
  related_city: string | null;
  related_song: string | null;
  recommendation_text: string;
  created_at: string;
}

export const useMarketingActions = () => {
  const { data, isLoading } = useQuery({
    queryKey: ["marketing-actions"],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase
        .from("marketing_actions")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(20);

      if (error) throw error;
      return data as MarketingAction[];
    },
    staleTime: 60 * 1000,
    refetchOnWindowFocus: true,
  });

  return { actions: data || [], isLoading };
};
