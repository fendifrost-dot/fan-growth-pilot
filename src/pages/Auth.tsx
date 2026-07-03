import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";

const Auth: React.FC = () => {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session && !session.user.is_anonymous) {
        navigate("/", { replace: true });
      }
    });
  }, [navigate]);

  const applyRememberPreference = () => {
    // When "remember this device" is off, downgrade persistence to sessionStorage
    // by copying the token there and clearing localStorage after auth.
    try {
      if (!remember) {
        const keys = Object.keys(localStorage).filter((k) => k.startsWith("sb-"));
        for (const k of keys) {
          const v = localStorage.getItem(k);
          if (v) sessionStorage.setItem(k, v);
          localStorage.removeItem(k);
        }
      }
    } catch {
      /* ignore storage errors */
    }
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    await supabase.auth.signOut();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    applyRememberPreference();
    toast.success("Signed in");
    navigate("/", { replace: true });
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    await supabase.auth.signOut();
    const { error, data } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/` },
    });
    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    if (data.session) {
      applyRememberPreference();
      toast.success("Account created");
      navigate("/", { replace: true });
    } else {
      toast.success("Check your email to confirm your account.");
    }
  };

  const handleGoogle = async () => {
    setLoading(true);
    await supabase.auth.signOut();
    const result = await lovable.auth.signInWithOAuth("google", {
      redirect_uri: window.location.origin,
    });
    if (result.error) {
      setLoading(false);
      toast.error(result.error.message ?? "Google sign-in failed");
      return;
    }
    if (result.redirected) return;
    applyRememberPreference();
    navigate("/", { replace: true });
  };

  return (
    <div className="min-h-screen bg-gradient-dark flex items-center justify-center px-4">
      <Card className="w-full max-w-sm p-6 bg-card/60 backdrop-blur-sm border-border">
        <h1 className="text-2xl font-semibold mb-1">Fendi Frost</h1>
        <p className="text-sm text-muted-foreground mb-6">Access your growth hub.</p>

        <Button
          type="button"
          variant="outline"
          className="w-full mb-4"
          onClick={handleGoogle}
          disabled={loading}
        >
          Continue with Google
        </Button>

        <div className="relative my-4">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-border" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-card px-2 text-muted-foreground">or</span>
          </div>
        </div>

        <Tabs defaultValue="signin" className="w-full">
          <TabsList className="grid w-full grid-cols-2 mb-4">
            <TabsTrigger value="signin">Sign in</TabsTrigger>
            <TabsTrigger value="signup">Create account</TabsTrigger>
          </TabsList>

          <TabsContent value="signin">
            <form onSubmit={handleSignIn} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input id="password" type="password" value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password" required />
              </div>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox
                  checked={remember}
                  onCheckedChange={(v) => setRemember(v === true)}
                />
                Remember this device
              </label>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          </TabsContent>

          <TabsContent value="signup">
            <form onSubmit={handleSignUp} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email-up">Email</Label>
                <Input id="email-up" type="email" value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password-up">Password</Label>
                <Input id="password-up" type="password" value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password" minLength={8} required />
                <p className="text-xs text-muted-foreground">At least 8 characters.</p>
              </div>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox
                  checked={remember}
                  onCheckedChange={(v) => setRemember(v === true)}
                />
                Remember this device
              </label>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Creating…" : "Create account"}
              </Button>
            </form>
          </TabsContent>
        </Tabs>
      </Card>
    </div>
  );
};

export default Auth;