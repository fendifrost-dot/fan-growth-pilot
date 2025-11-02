import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const usePlatformConnections = () => {
  const queryClient = useQueryClient();

  const { data: connections, isLoading } = useQuery({
    queryKey: ["platform-connections"],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase
        .from("platform_connections")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      if (error) throw error;
      return data;
    },
  });

  const createMutation = useMutation({
    mutationFn: async (connection: { 
      platform: string; 
      username: string; 
      profile_url: string;
      access_token?: string;
      pixel_id?: string;
    }) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase
        .from("platform_connections")
        .insert({
          user_id: user.id,
          platform: connection.platform,
          username: connection.username,
          profile_url: connection.profile_url,
          access_token: connection.access_token,
          pixel_id: connection.pixel_id,
          is_connected: true,
          last_synced_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["platform-connections"] });
      toast.success("Platform connected successfully");
    },
    onError: (error: any) => {
      toast.error(error.message || "Failed to connect platform");
      console.error(error);
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("platform_connections")
        .delete()
        .eq("id", id);
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["platform-connections"] });
      toast.success("Account disconnected");
    },
    onError: (error) => {
      toast.error("Failed to disconnect account");
      console.error(error);
    },
  });

  return {
    connections: connections || [],
    isLoading,
    createConnection: createMutation.mutate,
    removeConnection: removeMutation.mutate,
  };
};
