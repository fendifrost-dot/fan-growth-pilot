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
  const [videoLoaded, setVideoLoaded] = useState(false);

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

        // Generate signed URLs for storage paths in parallel for faster loading
        const processedLink = { ...data };
        const urlPromises: Promise<void>[] = [];
        
        // Process all URLs in parallel for faster loading
        if (data.image_url && !data.image_url.startsWith('http')) {
          urlPromises.push(
            supabase.storage
              .from("smart-links")
              .createSignedUrl(data.image_url, 86400)
              .then(({ data: signedUrl, error: imageError }) => {
                if (imageError) {
                  console.error("Error creating signed URL for image:", imageError);
                } else if (signedUrl?.signedUrl) {
                  processedLink.image_url = signedUrl.signedUrl;
                }
              })
          );
        }

        // Process video URL with priority and longer expiry
        if (data.video_url && !data.video_url.startsWith('http')) {
          urlPromises.push(
            supabase.storage
              .from("smart-links")
              .createSignedUrl(data.video_url, 86400)
              .then(({ data: signedUrl, error: videoError }) => {
                if (videoError) {
                  console.error("Error creating signed URL for video:", videoError);
                } else if (signedUrl?.signedUrl) {
                  processedLink.video_url = signedUrl.signedUrl;
                }
              })
          );
        }

        // Process background image URL
        if (data.background_image_url && !data.background_image_url.startsWith('http')) {
          urlPromises.push(
            supabase.storage
              .from("smart-links")
              .createSignedUrl(data.background_image_url, 86400)
              .then(({ data: signedUrl, error: bgError }) => {
                if (bgError) {
                  console.error("Error creating signed URL for background:", bgError);
                } else if (signedUrl?.signedUrl) {
                  processedLink.background_image_url = signedUrl.signedUrl;
                }
              })
          );
        }

        // Wait for all URLs to be processed in parallel
        await Promise.all(urlPromises);

        setSmartLink(processedLink);
        
        // Track the page view/click using secure RPC function (non-blocking for performance)
        supabase.rpc('increment_link_clicks', { link_id: data.id });

      } catch (error) {
        console.error("Error fetching smart link:", error);
        setNotFound(true);
      } finally {
        setIsLoading(false);
      }
    };

    fetchSmartLink();
  }, [slug]);

  // Update Open Graph meta tags when smart link loads
  useEffect(() => {
    if (!smartLink) return;

    const currentUrl = window.location.href;
    const title = smartLink.headline || smartLink.title;
    const description = smartLink.subheadline || smartLink.description || "Check out this link";
    // Use Runway Music album artwork as fallback for consistent branding
    const image = smartLink.image_url || smartLink.background_image_url || `${window.location.origin}/og-runway-music.png`;

    // Update or create meta tags
    const updateMetaTag = (property: string, content: string) => {
      let tag = document.querySelector(`meta[property="${property}"]`) as HTMLMetaElement;
      if (!tag) {
        tag = document.createElement('meta');
        tag.setAttribute('property', property);
        document.head.appendChild(tag);
      }
      tag.content = content;
    };

    const updateNameTag = (name: string, content: string) => {
      let tag = document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement;
      if (!tag) {
        tag = document.createElement('meta');
        tag.setAttribute('name', name);
        document.head.appendChild(tag);
      }
      tag.content = content;
    };

    // Open Graph tags
    updateMetaTag('og:title', title);
    updateMetaTag('og:description', description);
    updateMetaTag('og:url', currentUrl);
    updateMetaTag('og:type', 'website');
    if (image) {
      updateMetaTag('og:image', image);
      updateMetaTag('og:image:width', '1200');
      updateMetaTag('og:image:height', '630');
    }

    // Twitter Card tags
    updateNameTag('twitter:card', 'summary_large_image');
    updateNameTag('twitter:title', title);
    updateNameTag('twitter:description', description);
    if (image) {
      updateNameTag('twitter:image', image);
    }

    // Update page title
    document.title = title;

  }, [smartLink]);

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const validation = emailSchema.safeParse({ email });
    if (!validation.success) {
      toast.error(validation.error.errors[0].message);
      return;
    }

    setIsSubmitting(true);
    try {
      // Check for duplicate email submission
      const { data: existing } = await supabase
        .from("smart_link_leads")
        .select("id")
        .eq("smart_link_id", smartLink!.id)
        .eq("email", validation.data.email)
        .maybeSingle();

      if (existing) {
        toast.success("You're already subscribed!");
        setIsSubmitting(false);
        return;
      }

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

  // Conversion-optimized single-screen hero layout
  if (isRunwayTheme && smartLink.video_url) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        {/* Split layout: Video left, Content right on desktop; Stacked on mobile */}
        <div className="w-full h-screen flex flex-col lg:flex-row">
          {/* Video Section - 60-65% width on desktop, full-width top on mobile */}
          <div className="w-full lg:w-[65%] h-[45vh] lg:h-full relative">
            <video 
              src={smartLink.video_url}
              autoPlay
              muted
              loop
              playsInline
              preload="auto"
              poster={smartLink.image_url || undefined}
              className="w-full h-full object-cover"
              onLoadedData={() => setVideoLoaded(true)}
              onCanPlay={(e) => {
                const video = e.currentTarget;
                video.play().catch(err => console.log('Video autoplay prevented:', err));
              }}
            >
              <source src={smartLink.video_url} type="video/mp4" />
            </video>
            <div className="absolute inset-0 bg-black/20" />
          </div>

          {/* Content Section - 35-40% width on desktop, below video on mobile */}
          <div className="w-full lg:w-[35%] flex items-center justify-center p-6 lg:p-10 bg-black overflow-y-auto">
            <div className="w-full max-w-xl space-y-5 lg:space-y-6 my-auto">
              {/* Headline */}
              <div className="space-y-2 lg:space-y-3 text-center">
                <h1 className="text-3xl lg:text-4xl xl:text-5xl font-bold text-white font-['Playfair_Display'] leading-tight">
                  <div className="mb-2">Runway Music</div>
                  <div className="text-2xl lg:text-3xl xl:text-4xl font-normal italic opacity-90">The Sound of Style</div>
                </h1>
                {smartLink.subheadline && (
                  <p className="text-sm lg:text-base text-zinc-300 leading-relaxed">
                    {smartLink.subheadline}
                  </p>
                )}
              </div>

              {/* Album Cover */}
              {smartLink.image_url && (
                <div className="w-full max-w-sm mx-auto animate-fade-in">
                  <div className="relative overflow-hidden rounded-lg shadow-2xl">
                    <img 
                      src={smartLink.image_url} 
                      alt={smartLink.title}
                      loading="eager"
                      className="w-full h-auto object-cover"
                    />
                  </div>
                </div>
              )}

              {/* Value Props - Enhanced spacing between bullets */}
              {hasBulletPoints && (
                <ul className="space-y-3 lg:space-y-4">
                  {smartLink.bullet_point_1 && (
                    <li className="flex items-start gap-2.5 text-sm lg:text-base text-zinc-200 leading-relaxed">
                      <Sparkles className="w-4 h-4 lg:w-5 lg:h-5 flex-shrink-0 mt-0.5 text-white" />
                      <span>{smartLink.bullet_point_1}</span>
                    </li>
                  )}
                  {smartLink.bullet_point_2 && (
                    <li className="flex items-start gap-2.5 text-sm lg:text-base text-zinc-200 leading-relaxed">
                      <Sparkles className="w-4 h-4 lg:w-5 lg:h-5 flex-shrink-0 mt-0.5 text-white" />
                      <span>{smartLink.bullet_point_2}</span>
                    </li>
                  )}
                  {smartLink.bullet_point_3 && (
                    <li className="flex items-start gap-2.5 text-sm lg:text-base text-zinc-200 leading-relaxed">
                      <Sparkles className="w-4 h-4 lg:w-5 lg:h-5 flex-shrink-0 mt-0.5 text-white" />
                      <span>{smartLink.bullet_point_3}</span>
                    </li>
                  )}
                </ul>
              )}

              {/* Email Form + CTA - Stacked Vertically, Prominent */}
              {showEmailCapture && !hasSubmittedEmail ? (
                <form onSubmit={handleEmailSubmit} className="space-y-4">
                  {/* Elevated form card with enhanced shadow */}
                  <Card className="bg-zinc-900/90 border-zinc-800 shadow-2xl p-5 lg:p-6">
                    <div className="space-y-3.5 lg:space-y-4">
                      {/* Email input - Enhanced contrast and accessibility */}
                      <div className="relative w-full">
                        <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-300 pointer-events-none z-10" />
                        <Input
                          id="email"
                          type="email"
                          placeholder="Enter your email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          required
                          disabled={isSubmitting}
                          className="pl-12 h-[50px] w-full bg-zinc-900/60 border-[1.5px] border-zinc-400/60 text-white placeholder:text-zinc-300 focus:border-white focus:ring-2 focus:ring-white/50 text-base shadow-[0_2px_8px_rgba(255,255,255,0.2)] hover:border-zinc-300 hover:bg-zinc-900/80 transition-all"
                        />
                      </div>
                      
                      {/* CTA Button - Premium hover with glow and scale */}
                      <Button
                        type="submit"
                        size="lg"
                        className="h-[50px] w-full bg-white text-black hover:bg-white hover:brightness-110 hover:scale-[1.02] hover:shadow-[0_0_20px_rgba(255,255,255,0.5)] font-bold focus:ring-4 focus:ring-white/50 focus:ring-offset-2 focus:ring-offset-black text-base lg:text-lg transition-all duration-200 shadow-lg active:scale-[0.98]"
                        disabled={isSubmitting}
                      >
                        {isSubmitting ? (
                          <Loader2 className="w-5 h-5 animate-spin" />
                        ) : (
                          <>🎧 Get Early Access</>
                        )}
                      </Button>
                      
                      {/* Trust line - refined copy */}
                      <p className="text-xs text-zinc-500 text-center pt-1">
                        🔒 Your info stays private. No spam, ever.
                      </p>
                    </div>
                  </Card>
                </form>
              ) : (
                <div className="space-y-4">
                  <Button
                    size="lg"
                    className="w-full h-12 bg-white text-black hover:bg-zinc-200 font-semibold"
                    onClick={handleButtonClick}
                  >
                    {smartLink.button_text || "🎧 Get Early Access"}
                  </Button>
                  <p className="text-xs text-zinc-500 text-center">
                    🔒 Your information is secure
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Fallback: Original scrolling layout for non-runway themes
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
