import { useEffect, useState } from "react";
import { useParams, Navigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Mail, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";

interface SmartLinkData {
  id: string;
  title: string;
  slug: string;
  destination_url: string;
  description?: string;
  image_url?: string;
  video_url?: string;
  button_text?: string;
  button_color?: string;
  background_color?: string;
  background_image_url?: string;
  user_id: string;
}

const emailSchema = z.object({
  email: z.string().email("Please enter a valid email").trim().toLowerCase()
});

export default function SmartLinkPage() {
  const { slug } = useParams<{ slug: string }>();
  const [smartLink, setSmartLink] = useState<SmartLinkData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [email, setEmail] = useState("");
  const [hasSubmittedEmail, setHasSubmittedEmail] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const fetchSmartLink = async () => {
      if (!slug) {
        setNotFound(true);
        setIsLoading(false);
        return;
      }

      try {
        const { data, error } = await supabase
          .from("smart_links")
          .select("*")
          .eq("slug", slug)
          .eq("is_active", true)
          .single();

        if (error || !data) {
          setNotFound(true);
          setIsLoading(false);
          return;
        }

        setSmartLink(data);
        
        // Track the page view/click (non-blocking for performance)
        supabase.from("smart_links").update({
          click_count: (data.click_count || 0) + 1
        }).eq("id", data.id);

      } catch (error) {
        console.error("Error fetching smart link:", error);
        setNotFound(true);
      } finally {
        setIsLoading(false);
      }
    };

    fetchSmartLink();
  }, [slug]);

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const validation = emailSchema.safeParse({ email });
    if (!validation.success) {
      toast.error(validation.error.errors[0].message);
      return;
    }

    setIsSubmitting(true);
    try {
      const { error } = await supabase
        .from("smart_link_leads")
        .insert({
          smart_link_id: smartLink!.id,
          email: validation.data.email,
        });

      if (error) throw error;

      toast.success("Thanks! Redirecting...");
      // Auto-redirect to destination after brief delay
      setTimeout(() => {
        window.location.href = smartLink!.destination_url;
      }, 1000);
    } catch (error) {
      console.error("Error submitting email:", error);
      toast.error("Failed to submit. Please try again");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleButtonClick = () => {
    window.location.href = smartLink!.destination_url;
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (notFound || !smartLink) {
    return <Navigate to="/404" replace />;
  }

  const backgroundStyle: React.CSSProperties = {
    backgroundColor: smartLink.background_color || '#000000',
    backgroundImage: smartLink.background_image_url 
      ? `url(${smartLink.background_image_url})` 
      : undefined,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
  };

  return (
    <div className="min-h-screen relative flex items-center justify-center p-4 overflow-hidden" style={backgroundStyle}>
      {/* Animated background gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-br from-black/60 via-black/40 to-black/60 animate-fade-in" />
      
      {/* Floating particles effect */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-64 h-64 bg-primary/10 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-accent/10 rounded-full blur-3xl animate-pulse delay-1000" />
      </div>

      <Card className="max-w-2xl w-full p-8 md:p-12 bg-card/95 backdrop-blur-lg border-border/50 shadow-2xl animate-scale-in relative z-10">
        <div className="space-y-8 text-center">
          {/* Image with hover effect */}
          {smartLink.image_url && (
            <div className="w-full group animate-fade-in">
              <div className="relative overflow-hidden rounded-xl">
                <img 
                  src={smartLink.image_url} 
                  alt={smartLink.title}
                  loading="lazy"
                  className="w-full h-auto object-cover max-h-96 transition-transform duration-500 group-hover:scale-105"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
              </div>
            </div>
          )}

          {/* Title with gradient effect */}
          <div className="space-y-2 animate-fade-in" style={{ animationDelay: '0.1s' }}>
            <h1 className="text-5xl md:text-6xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-foreground via-primary to-foreground animate-fade-in">
              {smartLink.title}
            </h1>
            <div className="h-1 w-24 mx-auto bg-gradient-to-r from-transparent via-primary to-transparent" />
          </div>

          {/* Description with fade in */}
          {smartLink.description && (
            <p className="text-lg md:text-xl text-muted-foreground leading-relaxed max-w-xl mx-auto animate-fade-in" style={{ animationDelay: '0.2s' }}>
              {smartLink.description}
            </p>
          )}

          {/* Video with modern styling */}
          {smartLink.video_url && (
            <div className="w-full aspect-video animate-fade-in" style={{ animationDelay: '0.3s' }}>
              <video 
                src={smartLink.video_url}
                controls
                preload="metadata"
                className="w-full h-full rounded-xl shadow-lg ring-1 ring-border/50"
              />
            </div>
          )}

          {/* Email Capture Form or CTA Button */}
          <div className="animate-fade-in pt-4" style={{ animationDelay: '0.4s' }}>
            {!hasSubmittedEmail ? (
              <form onSubmit={handleEmailSubmit} className="space-y-6">
                <div className="space-y-3">
                  <div className="flex items-center justify-center gap-2">
                    <Sparkles className="w-5 h-5 text-primary" />
                    <Label htmlFor="email" className="text-lg font-semibold">
                      Get Exclusive Access
                    </Label>
                    <Sparkles className="w-5 h-5 text-primary" />
                  </div>
                  <div className="relative">
                    <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground pointer-events-none" />
                    <Input
                      id="email"
                      type="email"
                      placeholder="Enter your email address"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      disabled={isSubmitting}
                      className="text-base pl-12 h-14 rounded-xl border-2 border-border/50 focus:border-primary/50 transition-colors bg-background/50"
                    />
                  </div>
                </div>
                <Button
                  type="submit"
                  size="lg"
                  className="w-full text-lg py-7 rounded-xl font-semibold shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-105"
                  disabled={isSubmitting}
                  style={{ 
                    backgroundColor: smartLink.button_color || undefined,
                  }}
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                      Submitting...
                    </>
                  ) : (
                    <>
                      Continue
                      <Sparkles className="w-5 h-5 ml-2" />
                    </>
                  )}
                </Button>
              </form>
            ) : (
              <Button
                size="lg"
                className="w-full text-lg py-7 rounded-xl font-semibold shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-105"
                style={{ 
                  backgroundColor: smartLink.button_color || undefined,
                }}
                onClick={handleButtonClick}
              >
                {smartLink.button_text || "Click Here"}
                <Sparkles className="w-5 h-5 ml-2" />
              </Button>
            )}
          </div>

          {/* Trust badge */}
          <p className="text-xs text-muted-foreground/60 animate-fade-in" style={{ animationDelay: '0.5s' }}>
            🔒 Your information is secure and will never be shared
          </p>
        </div>
      </Card>
    </div>
  );
}