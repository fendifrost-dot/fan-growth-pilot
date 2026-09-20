import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface AppleStationPlay {
  station_call_sign: string | null;
  city: string | null;
  country_code: string | null;
  song_name: string | null;
  spins_total: number;
  snapshot_week: string;
}

export interface AppleCitySpin {
  city: string | null;
  area_name: string | null;
  country_code: string | null;
  spins_total: number | null;
  snapshot_week: string;
}

export interface AppleMusicData {
  latestWeek: string | null;
  stations: AppleStationPlay[];
  cities: AppleCitySpin[];
  totalSpins: number;
  profileUrl: string | null;
}

/**
 * Reads Apple Music radio-spin snapshots (AMFA-sourced) and the connected Apple
 * Music profile link. Apple does not expose streaming stats the way Spotify
 * does, so this surfaces radio airplay (stations + cities) instead. If the
 * tables are empty or RLS-restricted the queries resolve to empty arrays and
 * the page renders a clean empty state.
 */
export const useAppleMusic = () => {
  return useQuery<AppleMusicData>({
    queryKey: ["apple-music"],
    queryFn: async () => {
      const [stationsRes, citiesRes, connRes] = await Promise.all([
        supabase
          .from("apple_station_plays")
          .select(
            "station_call_sign, city, country_code, song_name, spins_total, snapshot_week",
          )
          .order("snapshot_week", { ascending: false })
          .order("spins_total", { ascending: false })
          .limit(200),
        supabase
          .from("apple_city_spins")
          .select("city, area_name, country_code, spins_total, snapshot_week")
          .order("snapshot_week", { ascending: false })
          .order("spins_total", { ascending: false })
          .limit(200),
        supabase
          .from("platform_connections")
          .select("platform, profile_url")
          .ilike("platform", "%apple%")
          .maybeSingle(),
      ]);

      const allStations = (stationsRes.data ?? []) as AppleStationPlay[];
      const allCities = (citiesRes.data ?? []) as AppleCitySpin[];

      // Restrict to the most recent snapshot week we have.
      const latestWeek =
        allStations[0]?.snapshot_week ?? allCities[0]?.snapshot_week ?? null;

      const stations = latestWeek
        ? allStations.filter((s) => s.snapshot_week === latestWeek).slice(0, 15)
        : [];
      const cities = latestWeek
        ? allCities.filter((c) => c.snapshot_week === latestWeek).slice(0, 15)
        : [];

      const totalSpins = stations.reduce((sum, s) => sum + (s.spins_total || 0), 0);

      return {
        latestWeek,
        stations,
        cities,
        totalSpins,
        profileUrl: connRes.data?.profile_url ?? null,
      };
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
};
