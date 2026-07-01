import React, { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";

type AuthState = "loading" | "authed" | "anon";

export const RequireAuth: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<AuthState>("loading");
  const location = useLocation();

  useEffect(() => {
    let mounted = true;

    const evaluate = (session: any) => {
      if (!mounted) return;
      if (session && !session.user?.is_anonymous) setState("authed");
      else setState("anon");
    };

    supabase.auth.getSession().then(({ data: { session } }) => evaluate(session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => evaluate(session));

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  if (state === "loading") {
    return (
      <div className="min-h-screen bg-gradient-dark flex items-center justify-center">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </div>
    );
  }

  if (state === "anon") {
    return <Navigate to="/auth" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
};

export default RequireAuth;