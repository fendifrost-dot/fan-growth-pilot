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
    mutationFn: async (link: { 
      title: string; 
      destination_url: string; 
      slug: string;
      description?: string;
      image_url?: string;
      video_url?: string;
      background_image_url?: string;
      button_text?: string;
      button_color?: string;
      background_color?: string;
      headline?: string;
      subheadline?: string;
      video_autoplay?: boolean;
      show_email_form?: boolean;
      bullet_point_1?: string;
      bullet_point_2?: string;
      bullet_point_3?: string;
      testimonial_text?: string;
      testimonial_author?: string;
      theme_preset?: string;
    }) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      // Generate unique short code
      let shortCode = '';
      let isUnique = false;
      
      while (!isUnique) {
        // Generate 6-character random code
        const characters = 'abcdefghijklmnopqrstuvwxyz0123456789';
        shortCode = Array.from({ length: 6 }, () => 
          characters[Math.floor(Math.random() * characters.length)]
        ).join('');
        
        // Check if code already exists
        const { data: existing } = await supabase
          .from("smart_links")
          .select("id")
          .eq("short_code", shortCode)
          .maybeSingle();
        
        if (!existing) isUnique = true;
      }

      const { data, error } = await supabase
        .from("smart_links")
        .insert({
          ...link,
          user_id: user.id,
          short_code: shortCode,
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
    onError: (error: any) => {
      console.error(error);
      
      // Check for duplicate slug error
      if (error?.code === '23505' && error?.message?.includes('smart_links_slug_key')) {
        toast.error("This slug is already taken. Please choose a different one or generate a random one.");
      } else if (error?.message) {
        toast.error(`Failed to create smart link: ${error.message}`);
      } else {
        toast.error("Failed to create smart link. Please try again.");
      }
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
