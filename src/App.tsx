import React from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Index from "./pages/Index";
import ArtistLayout from "@/components/hub/ArtistLayout";
import HubDashboard from "./pages/hub/HubDashboard";
import HubSmartLinks from "./pages/hub/HubSmartLinks";
import HubSpotify from "./pages/hub/HubSpotify";
import HubAppleMusic from "./pages/hub/HubAppleMusic";
import HubYouTube from "./pages/hub/HubYouTube";
import HubSocial from "./pages/hub/HubSocial";
import HubPlaylist from "./pages/hub/HubPlaylist";
import HubSync from "./pages/hub/HubSync";
import NotFound from "./pages/NotFound";
import SmartLinkPage from "./pages/SmartLinkPage";
import Unsubscribe from "./pages/Unsubscribe";
import PrivacyPolicy from "./pages/PrivacyPolicy";
import DataDeletion from "./pages/DataDeletion";
import Auth from "./pages/Auth";
import RequireAuth from "@/components/RequireAuth";
import AdminGuard from "./pages/admin/AdminGuard";
import AdminHub from "./pages/admin/AdminHub";
import AdminSendCenter from "./pages/admin/AdminSendCenter";
import AdminCampaigns from "./pages/admin/AdminCampaigns";
import AdminPitchLog from "./pages/admin/AdminPitchLog";
import AdminCampaignDetail from "./pages/admin/AdminCampaignDetail";
import AdminContacts from "./pages/admin/AdminContacts";
import AdminPlaylistTargets from "./pages/admin/AdminPlaylistTargets";
import AdminPlaylistReview from "./pages/admin/AdminPlaylistReview";
import AdminOutreachDrafts from "./pages/admin/AdminOutreachDrafts";
import AdminSocialQueue from "./pages/admin/AdminSocialQueue";
import AdminFanIgQueue from "./pages/admin/AdminFanIgQueue";
import AdminIgRoster from "./pages/admin/AdminIgRoster";
import AdminRadioTargets from "./pages/admin/AdminRadioTargets";
import AdminCatalogue from "./pages/admin/AdminCatalogue";
import AdminLicensing from "./pages/admin/AdminLicensing";
import AdminCategories from "./pages/admin/AdminCategories";
import AdminPitchComposer from "./pages/admin/AdminPitchComposer";
import AdminPitchPortal from "./pages/admin/AdminPitchPortal";
import AdminSongDna from "./pages/admin/AdminSongDna";
import AdminSplitSheets from "./pages/admin/AdminSplitSheets";
import AdminDiscoveryProfiles from "./pages/admin/AdminDiscoveryProfiles";
import AdminDailyOps from "./pages/admin/AdminDailyOps";
import AdminOpportunities from "./pages/admin/AdminOpportunities";
import AdminMcpPlaylistAuthorize from "./pages/admin/AdminMcpPlaylistAuthorize";
import AdminMcpSyncAuthorize from "./pages/admin/AdminMcpSyncAuthorize";
import AdminYouTubeShares from "./pages/admin/AdminYouTubeShares";
import RegisterPreview from "./pages/dev/RegisterPreview";

const queryClient = new QueryClient();

const RootRoute = () => {
  if (window.location.hostname.startsWith('links.')) {
    return <NotFound />;
  }
  // The artist console (hamburger nav + routed sections) is now the home
  // experience. The legacy single-page dashboard remains reachable at /legacy.
  return (
    <RequireAuth>
      <Navigate to="/hub" replace />
    </RequireAuth>
  );
};

const App = () => {
  return (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<RootRoute />} />
          <Route path="/auth" element={<Auth />} />

          {/* Legacy single-page dashboard (kept for reference / fallback) */}
          <Route path="/legacy" element={<RequireAuth><Index /></RequireAuth>} />

          {/* Artist console — hamburger nav + routed section pages */}
          <Route path="/hub" element={<RequireAuth><ArtistLayout /></RequireAuth>}>
            <Route index element={<HubDashboard />} />
            <Route path="smart-links" element={<HubSmartLinks />} />
            <Route path="spotify" element={<HubSpotify />} />
            <Route path="apple-music" element={<HubAppleMusic />} />
            <Route path="youtube" element={<HubYouTube />} />
            <Route path="youtube/native-share" element={<AdminYouTubeShares />} />
            <Route path="social" element={<HubSocial />} />
            <Route path="playlist" element={<HubPlaylist />} />
            <Route path="sync" element={<HubSync />} />
          </Route>

          {/* Public unsubscribe endpoint — receives links from emails */}
          <Route path="/unsubscribe" element={<Unsubscribe />} />

          {/* Public Meta-required pages — must be above the /:slug catch-all */}
          <Route path="/privacy" element={<PrivacyPolicy />} />
          <Route path="/data-deletion" element={<DataDeletion />} />
          {import.meta.env.DEV && (
            <Route path="/dev/registers" element={<RegisterPreview />} />
          )}

          {/* Admin (single-operator internal) */}
          <Route path="/admin" element={<RequireAuth><AdminGuard /></RequireAuth>}>
            <Route index element={<AdminHub />} />
            <Route path="opportunities" element={<AdminOpportunities />} />
            <Route path="campaigns" element={<AdminCampaigns />} />
            <Route path="campaigns/:slug" element={<AdminCampaignDetail />} />
            <Route path="contacts" element={<AdminContacts />} />
            <Route path="playlists" element={<AdminPlaylistTargets />} />
            <Route path="playlists/review" element={<AdminPlaylistReview />} />
            <Route path="outreach" element={<AdminOutreachDrafts />} />
            <Route path="ig-queue" element={<AdminSocialQueue />} />
            <Route path="fan-ig-queue" element={<AdminFanIgQueue />} />
            <Route path="ig-roster" element={<AdminIgRoster />} />
            <Route path="send" element={<AdminSendCenter />} />
            <Route path="radio" element={<AdminRadioTargets />} />
            <Route path="pitch-log" element={<AdminPitchLog />} />
            <Route path="catalogue" element={<AdminCatalogue />} />
            <Route path="songs" element={<AdminCatalogue />} />
            <Route path="licensing" element={<AdminLicensing />} />
            <Route path="categories" element={<AdminCategories />} />
            <Route path="pitch-composer" element={<AdminPitchComposer />} />
            <Route path="pitch-portal" element={<AdminPitchPortal />} />
            <Route path="song-dna" element={<AdminSongDna />} />
            <Route path="split-sheets" element={<AdminSplitSheets />} />
            <Route path="discovery-profiles" element={<AdminDiscoveryProfiles />} />
            <Route path="daily-ops" element={<AdminDailyOps />} />
            <Route path="youtube-shares" element={<AdminYouTubeShares />} />
            <Route path="mcp-playlist-authorize" element={<AdminMcpPlaylistAuthorize />} />
            <Route path="mcp-sync-authorize" element={<AdminMcpSyncAuthorize />} />
          </Route>

          {/* Public smart link pages (CATCH-ALL — must stay last among meaningful routes) */}
          <Route path="/:slug" element={<SmartLinkPage />} />
          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
  );
};

export default App;
