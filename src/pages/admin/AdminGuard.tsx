import React, { useEffect, useState } from "react";
import { useNavigate, Link, Outlet, useLocation } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";

const ARTIST_USER_ID = (import.meta.env.VITE_ARTIST_USER_ID as string | undefined)?.trim();

const AdminGuard: React.FC = () => {
  const [checking, setChecking] = useState(true);
  const [authed, setAuthed] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return;
      if (!session) {
        navigate("/auth", { replace: true, state: { from: location.pathname } });
        return;
      }
      if (ARTIST_USER_ID && session.user.id !== ARTIST_USER_ID) {
        navigate("/auth", { replace: true, state: { from: location.pathname } });
        return;
      }
      setAuthed(true);
      setChecking(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!session) {
        navigate("/auth", { replace: true });
        return;
      }
      if (ARTIST_USER_ID && session.user.id !== ARTIST_USER_ID) {
        navigate("/auth", { replace: true });
      }
    });
    return () => { mounted = false; subscription.unsubscribe(); };
  }, [navigate, location.pathname]);

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
        Checking session…
      </div>
    );
  }
  if (!authed) return null;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-8">
            <Link to="/admin/campaigns" className="font-medium tracking-tight">Fendi Frost · Admin</Link>
            <nav className="flex items-center gap-6 text-sm">
              <Link to="/admin/campaigns" className="hover:underline">Campaigns</Link>
              <Link to="/admin/contacts" className="hover:underline">Contacts</Link>
              <Link to="/admin/playlists" className="hover:underline">Playlists</Link>
              <Link to="/admin/outreach" className="hover:underline">Outreach</Link>
            </nav>
          </div>
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={async () => { await supabase.auth.signOut(); navigate("/auth"); }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
};

export default AdminGuard;
