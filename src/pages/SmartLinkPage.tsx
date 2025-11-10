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
  headline?: string;
  subheadline?: string;
  video_autoplay?: boolean;
  show_email_form?: boolean;
  bullet_point_1?: string;
  bullet_point_2?: string;
  bullet_point_3?: string;
  testimonial_text?: string;
  testimonial_author?: string;
  theme_preset?: string;
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
        // Try to fetch by short_code first (6 chars or less), then by slug
        const isShortCode = slug.length <= 6;
        
        const { data, error } = await supabase
          .from("smart_links")
          .select("*")
          .or(isShortCode ? `short_code.eq.${slug},slug.eq.${slug}` : `slug.eq.${slug}`)
          .eq("is_active", true)
          .maybeSingle();

        if (error || !data) {
          setNotFound(true);
          setIsLoading(false);
          return;
        }

        // Generate signed URLs for storage paths
        const processedLink = { ...data };
        
        // Process image URL
        if (data.image_url && !data.image_url.startsWith('http')) {
          const { data: signedUrl, error: imageError } = await supabase.storage
            .from("smart-links")
            .createSignedUrl(data.image_url, 3600); // 1 hour expiry

          if (imageError) {
            console.error("Error creating signed URL for image:", imageError);
          } else if (signedUrl?.signedUrl) {
            processedLink.image_url = signedUrl.signedUrl;
          }
        }

        // Process video URL
        if (data.video_url && !data.video_url.startsWith('http')) {
          const { data: signedUrl, error: videoError } = await supabase.storage
            .from("smart-links")
            .createSignedUrl(data.video_url, 3600); // 1 hour expiry

          if (videoError) {
            console.error("Error creating signed URL for video:", videoError);
          } else if (signedUrl?.signedUrl) {
            processedLink.video_url = signedUrl.signedUrl;
          }
        }

        // Process background image URL
        if (data.background_image_url && !data.background_image_url.startsWith('http')) {
          const { data: signedUrl, error: bgError } = await supabase.storage
            .from("smart-links")
            .createSignedUrl(data.background_image_url, 3600); // 1 hour expiry

          if (bgError) {
            console.error("Error creating signed URL for background:", bgError);
          } else if (signedUrl?.signedUrl) {
            processedLink.background_image_url = signedUrl.signedUrl;
          }
        }

        setSmartLink(processedLink);
        
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
    backgroundAttachment: 'fixed',
  };

  const isRunwayTheme = smartLink.theme_preset === 'runway';
  const showEmailCapture = smartLink.show_email_form !== false;
  const hasBulletPoints = smartLink.bullet_point_1 || smartLink.bullet_point_2 || smartLink.bullet_point_3;

  return (
    <div 
      className="min-h-screen relative"
      style={backgroundStyle}
    >
      {/* Background overlay */}
      <div className={`fixed inset-0 ${isRunwayTheme ? 'bg-gradient-to-br from-black/80 via-zinc-900/80 to-black/80' : 'bg-gradient-to-br from-black/40 via-black/30 to-black/40'} pointer-events-none`} />
      
      {/* Floating particles effect */}
      {!isRunwayTheme && (
        <div className="fixed inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-1/4 left-1/4 w-64 h-64 bg-primary/10 rounded-full blur-3xl animate-pulse" />
          <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-accent/10 rounded-full blur-3xl animate-pulse delay-1000" />
        </div>
      )}

      <div className="relative z-10">
        <div className="space-y-0">
          {/* Hero Video Section with Parallax */}
          {smartLink.video_url && (
            <div className="w-full relative h-[70vh] overflow-hidden">
              <video 
                src={smartLink.video_url}
                autoPlay={smartLink.video_autoplay}
                muted={smartLink.video_autoplay}
                loop={smartLink.video_autoplay}
                controls={!smartLink.video_autoplay}
                preload="metadata"
                className="w-full h-full object-cover"
              />
              {/* Headline overlay on video */}
              {(smartLink.headline || smartLink.subheadline) && (
                <div className="absolute inset-0 bg-gradient-to-t from-black via-black/50 to-transparent flex flex-col items-center justify-end p-8 text-center">
                  {smartLink.headline && (
                    <h1 className={`text-4xl md:text-6xl lg:text-7xl font-bold text-white mb-4 ${isRunwayTheme ? 'font-["Playfair_Display"]' : ''}`}>
                      {smartLink.headline}
                    </h1>
                  )}
                  {smartLink.subheadline && (
                    <p className="text-lg md:text-xl text-white/90 max-w-3xl leading-relaxed">
                      {smartLink.subheadline}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Content Card */}
          <div className={`relative z-10 max-w-4xl mx-auto p-4 ${smartLink.video_url ? '-mt-20' : 'mt-8'}`}>
            <Card className={`${isRunwayTheme ? 'bg-black/90 border-zinc-800' : 'bg-card/95'} backdrop-blur-lg shadow-2xl p-8 md:p-12 space-y-8`}>
              {/* Headline/Subheadline if no video */}
              {!smartLink.video_url && (smartLink.headline || smartLink.subheadline) && (
                <div className="text-center space-y-4 animate-fade-in">
                  {smartLink.headline && (
                    <h1 className={`text-4xl md:text-6xl lg:text-7xl font-bold ${isRunwayTheme ? 'text-white font-["Playfair_Display"]' : 'bg-clip-text text-transparent bg-gradient-to-r from-foreground via-primary to-foreground'}`}>
                      {smartLink.headline}
                    </h1>
                  )}
                  {smartLink.subheadline && (
                    <p className={`text-lg md:text-xl max-w-3xl mx-auto leading-relaxed ${isRunwayTheme ? 'text-zinc-300' : 'text-muted-foreground'}`}>
                      {smartLink.subheadline}
                    </p>
                  )}
                  <div className={`h-1 w-24 mx-auto ${isRunwayTheme ? 'bg-white' : 'bg-gradient-to-r from-transparent via-primary to-transparent'}`} />
                </div>
              )}

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

              {/* Title (if no headline) */}
              {!smartLink.headline && (
                <div className="space-y-2 animate-fade-in text-center">
                  <h1 className={`text-5xl md:text-6xl font-bold ${isRunwayTheme ? 'text-white font-["Playfair_Display"]' : 'bg-clip-text text-transparent bg-gradient-to-r from-foreground via-primary to-foreground'}`}>
                    {smartLink.title}
                  </h1>
                  <div className={`h-1 w-24 mx-auto ${isRunwayTheme ? 'bg-white' : 'bg-gradient-to-r from-transparent via-primary to-transparent'}`} />
                </div>
              )}

              {/* Description */}
              {smartLink.description && !smartLink.subheadline && (
                <p className={`text-lg md:text-xl leading-relaxed max-w-xl mx-auto animate-fade-in text-center ${isRunwayTheme ? 'text-zinc-300' : 'text-muted-foreground'}`}>
                  {smartLink.description}
                </p>
              )}

              {/* What You Get Section */}
              {hasBulletPoints && (
                <div className={`max-w-2xl mx-auto space-y-6 p-8 rounded-xl animate-fade-in ${isRunwayTheme ? 'bg-zinc-900/50 border border-zinc-800' : 'bg-muted/30'}`}>
                  <h2 className={`text-2xl md:text-3xl font-bold text-center ${isRunwayTheme ? 'text-white font-["Playfair_Display"]' : ''}`}>
                    What You Get
                  </h2>
                  <ul className="space-y-4">
                    {smartLink.bullet_point_1 && (
                      <li className={`flex items-start gap-3 text-lg ${isRunwayTheme ? 'text-zinc-200' : 'text-foreground'}`}>
                        <Sparkles className={`w-6 h-6 flex-shrink-0 mt-1 ${isRunwayTheme ? 'text-white' : 'text-primary'}`} />
                        <span>{smartLink.bullet_point_1}</span>
                      </li>
                    )}
                    {smartLink.bullet_point_2 && (
                      <li className={`flex items-start gap-3 text-lg ${isRunwayTheme ? 'text-zinc-200' : 'text-foreground'}`}>
                        <Sparkles className={`w-6 h-6 flex-shrink-0 mt-1 ${isRunwayTheme ? 'text-white' : 'text-primary'}`} />
                        <span>{smartLink.bullet_point_2}</span>
                      </li>
                    )}
                    {smartLink.bullet_point_3 && (
                      <li className={`flex items-start gap-3 text-lg ${isRunwayTheme ? 'text-zinc-200' : 'text-foreground'}`}>
                        <Sparkles className={`w-6 h-6 flex-shrink-0 mt-1 ${isRunwayTheme ? 'text-white' : 'text-primary'}`} />
                        <span>{smartLink.bullet_point_3}</span>
                      </li>
                    )}
                  </ul>
                </div>
              )}

              {/* Testimonial Section */}
              {smartLink.testimonial_text && (
                <div className={`max-w-2xl mx-auto text-center space-y-4 p-8 rounded-xl animate-fade-in ${isRunwayTheme ? 'bg-zinc-900/50 border border-zinc-800' : 'bg-muted/30'}`}>
                  <div className={`text-4xl ${isRunwayTheme ? 'text-white' : 'text-primary'}`}>"</div>
                  <p className={`text-lg md:text-xl italic leading-relaxed ${isRunwayTheme ? 'text-zinc-200 font-["Playfair_Display"]' : 'text-foreground'}`}>
                    {smartLink.testimonial_text}
                  </p>
                  {smartLink.testimonial_author && (
                    <p className={`text-sm font-semibold ${isRunwayTheme ? 'text-zinc-400' : 'text-muted-foreground'}`}>
                      {smartLink.testimonial_author}
                    </p>
                  )}
                </div>
              )}

              {/* Email Capture Form or Direct CTA */}
              <div className="animate-fade-in pt-4 text-center">
                {showEmailCapture && !hasSubmittedEmail ? (
                  <form onSubmit={handleEmailSubmit} className="space-y-6 max-w-md mx-auto">
                    <div className="space-y-3">
                      <div className="flex items-center justify-center gap-2">
                        <Sparkles className={`w-5 h-5 ${isRunwayTheme ? 'text-white' : 'text-primary'}`} />
                        <Label htmlFor="email" className={`text-lg font-semibold ${isRunwayTheme ? 'text-white' : ''}`}>
                          Get Exclusive Access
                        </Label>
                        <Sparkles className={`w-5 h-5 ${isRunwayTheme ? 'text-white' : 'text-primary'}`} />
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
                          className={`text-base pl-12 h-14 rounded-xl border-2 transition-colors ${isRunwayTheme ? 'bg-zinc-900 border-zinc-700 text-white placeholder:text-zinc-500 focus:border-white' : 'border-border/50 focus:border-primary/50 bg-background/50'}`}
                        />
                      </div>
                    </div>
                    <Button
                      type="submit"
                      size="lg"
                      className={`w-full text-lg py-7 rounded-xl font-semibold shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-105 ${isRunwayTheme ? 'bg-white text-black hover:bg-zinc-200' : ''}`}
                      disabled={isSubmitting}
                      style={!isRunwayTheme && smartLink.button_color ? { 
                        backgroundColor: smartLink.button_color,
                      } : undefined}
                    >
                      {isSubmitting ? (
                        <>
                          <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                          Submitting...
                        </>
                      ) : (
                        <>
                          {smartLink.button_text || "Get Access Now"}
                          <Sparkles className="w-5 h-5 ml-2" />
                        </>
                      )}
                    </Button>
                  </form>
                ) : (
                  <Button
                    size="lg"
                    className={`w-full max-w-md text-lg py-7 rounded-xl font-semibold shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-105 ${isRunwayTheme ? 'bg-white text-black hover:bg-zinc-200' : ''}`}
                    style={!isRunwayTheme && smartLink.button_color ? { 
                      backgroundColor: smartLink.button_color,
                    } : undefined}
                    onClick={handleButtonClick}
                  >
                    {smartLink.button_text || "Click Here"}
                    <Sparkles className="w-5 h-5 ml-2" />
                  </Button>
                )}
              </div>

              {/* Trust badge */}
              {showEmailCapture && (
                <p className={`text-xs text-center animate-fade-in ${isRunwayTheme ? 'text-zinc-500' : 'text-muted-foreground/60'}`}>
                  🔒 Your information is secure and will never be shared
                </p>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
