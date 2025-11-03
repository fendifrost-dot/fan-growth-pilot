import { useQuery } from "@tanstack/react-query";
import { checkShopifyConnection } from "@/lib/shopify";

export const useShopifyConnection = () => {
  const { data: isConnected, isLoading } = useQuery({
    queryKey: ["shopify-connection"],
    queryFn: checkShopifyConnection,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
    retry: 1,
  });

  return {
    isConnected: isConnected || false,
    isLoading,
  };
};
