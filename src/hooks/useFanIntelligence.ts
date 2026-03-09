import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const useFanIntelligence = () => {
  const queryClient = useQueryClient();

  const runMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("fan-intelligence");
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["fan-profiles"] });
      queryClient.invalidateQueries({ queryKey: ["momentum-events"] });
      queryClient.invalidateQueries({ queryKey: ["marketing-actions"] });
      queryClient.invalidateQueries({ queryKey: ["system-logs"] });
      toast.success(`Intelligence run complete: ${data.fans_synced} fans synced, ${data.momentum_events_created} momentum events`);
    },
    onError: (error: Error) => {
      toast.error(`Intelligence run failed: ${error.message}`);
    },
  });

  // Get last run info from system_logs
  const { data: lastRun } = useQuery({
    queryKey: ["system-logs", "fan-intelligence"],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return null;

      const { data } = await supabase
        .from("system_logs")
        .select("*")
        .eq("user_id", user.id)
        .eq("process_name", "fan-intelligence")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      return data;
    },
    staleTime: 30 * 1000,
  });

  return {
    runIntelligence: runMutation.mutate,
    isRunning: runMutation.isPending,
    lastRun,
  };
};
