import React from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Index from "./pages/Index";
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
import AdminCategories from "./pages/admin/AdminCategories";
import AdminPitchComposer from "./pages/admin/AdminPitchComposer";

const queryClient = new QueryClient();

const RootRoute = () => {
  if (window.location.hostname.startsWith('links.')) {
    return <NotFound />;
  }
  return (
    <RequireAuth>
      <Index />
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
          {/* Public unsubscribe endpoint — receives links from emails */}
          <Route path="/unsubscribe" element={<Unsubscribe />} />

          {/* Public Meta-required pages — must be above the /:slug catch-all */}
          <Route path="/privacy" element={<PrivacyPolicy />} />
          <Route path="/data-deletion" element={<DataDeletion />} />

          {/* Admin (single-operator internal) */}
          <Route path="/admin" element={<RequireAuth><AdminGuard /></RequireAuth>}>
            <Route index element={<AdminHub />} />
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
            <Route path="categories" element={<AdminCategories />} />
            <Route path="pitch-composer" element={<AdminPitchComposer />} />
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
