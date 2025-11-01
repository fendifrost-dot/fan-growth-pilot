import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const useSmartLinks = () => {
  const queryClient = useQueryClient();

  const { data: smartLinks, isLoading } = useQuery({
    queryKey: ["smart-links"],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase
        .from("smart_links")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      if (error) throw error;
      return data;
    },
  });

  const createMutation = useMutation({
    mutationFn: async (link: { title: string; destination_url: string; slug: string }) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase
        .from("smart_links")
        .insert({
          ...link,
          user_id: user.id,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["smart-links"] });
      toast.success("Smart link created");
    },
    onError: (error) => {
      toast.error("Failed to create smart link");
      console.error(error);
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("smart_links")
        .delete()
        .eq("id", id);
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["smart-links"] });
      toast.success("Smart link deleted");
    },
    onError: (error) => {
      toast.error("Failed to delete smart link");
      console.error(error);
    },
  });

  return {
    smartLinks: smartLinks || [],
    isLoading,
    createSmartLink: createMutation.mutate,
    removeSmartLink: removeMutation.mutate,
  };
};
