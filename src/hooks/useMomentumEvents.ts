import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface MomentumEvent {
  id: string;
  metric_name: string;
  metric_source: string;
  previous_value: number | null;
  current_value: number | null;
  absolute_change: number | null;
  percent_change: number | null;
  related_city: string | null;
  related_song: string | null;
  severity: string;
  status: string;
  detected_at: string;
  metadata: Record<string, unknown> | null;
}

export const useMomentumEvents = () => {
  const { data, isLoading } = useQuery({
    queryKey: ["momentum-events"],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase
        .from("momentum_events")
        .select("*")
        .eq("user_id", user.id)
        .order("detected_at", { ascending: false })
        .limit(50);

      if (error) throw error;
      return data as MomentumEvent[];
    },
    staleTime: 60 * 1000,
    refetchOnWindowFocus: true,
  });

  return { events: data || [], isLoading };
};
