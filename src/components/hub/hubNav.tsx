import {
  LayoutDashboard,
  Link as LinkIcon,
  Play,
  Apple,
  Youtube,
  Instagram,
  ListMusic,
  Clapperboard,
  type LucideIcon,
} from "lucide-react";

export interface HubNavItem {
  label: string;
  to: string;
  /** Exact match required for active state (used for the index route). */
  end?: boolean;
  icon: LucideIcon;
  description: string;
}

export interface HubNavGroup {
  heading: string;
  items: HubNavItem[];
}

/**
 * Single source of truth for the artist console's hamburger / sidebar
 * navigation. Kept as data so it can be unit-tested and reused by both the
 * mobile drawer and the desktop sidebar.
 */
export const HUB_NAV: HubNavGroup[] = [
  {
    heading: "Overview",
    items: [
      {
        label: "Dashboard",
        to: "/hub",
        end: true,
        icon: LayoutDashboard,
        description: "Everything at a glance",
      },
      {
        label: "Smart Links",
        to: "/hub/smart-links",
        icon: LinkIcon,
        description: "Landing pages & click tracking",
      },
    ],
  },
  {
    heading: "Channels",
    items: [
      {
        label: "Spotify",
        to: "/hub/spotify",
        icon: Play,
        description: "Listeners, followers, refresh",
      },
      {
        label: "Apple Music",
        to: "/hub/apple-music",
        icon: Apple,
        description: "Presence & radio spins",
      },
      {
        label: "YouTube",
        to: "/hub/youtube",
        icon: Youtube,
        description: "Channel stats & Native Share pilot",
      },
      {
        label: "Social",
        to: "/hub/social",
        icon: Instagram,
        description: "Instagram & Facebook",
      },
    ],
  },
  {
    heading: "Growth ops",
    items: [
      {
        label: "Playlist",
        to: "/hub/playlist",
        icon: ListMusic,
        description: "Sends · opportunities · approvals",
      },
      {
        label: "Sync",
        to: "/hub/sync",
        icon: Clapperboard,
        description: "Licensing sends · opportunities · approvals",
      },
    ],
  },
];

/** Flat list of every hub route, handy for tests and route generation. */
export const HUB_NAV_ITEMS: HubNavItem[] = HUB_NAV.flatMap((g) => g.items);
