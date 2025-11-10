import { useQuery } from "@tanstack/react-query";
import { checkShopifyConnection } from "@/lib/shopify";

export const useShopifyConnection = () => {
  const { data: isConnected, isLoading } = useQuery({
    queryKey: ["shopify-connection"],
    queryFn: checkShopifyConnection,
    staleTime: 0, // Always consider data stale
    retry: 1,
    refetchInterval: 30 * 1000, // Refetch every 30 seconds
    refetchOnWindowFocus: true,
    refetchOnMount: true,
  });

  return {
    isConnected: isConnected || false,
    isLoading,
  };
};
