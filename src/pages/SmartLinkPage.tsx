import { useEffect, useState, useRef } from "react";
import { useParams, Navigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Loader2, Mail, Sparkles, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import Hls from "hls.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

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
  const [emailPlaqueOpen, setEmailPlaqueOpen] = useState(false);
  const [videoLoaded, setVideoLoaded] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const fetchSmartLink = async () => {
      if (!slug) {
        setNotFound(true);
        setIsLoading(false);
        return;
      }

      try {
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

        const processedLink = { ...data };
        const urlPromises: Promise<void>[] = [];
        
        if (data.image_url && !data.image_url.startsWith('http')) {
          urlPromises.push(
            supabase.storage
              .from("smart-links")
              .createSignedUrl(data.image_url, 86400)
              .then(({ data: signedUrl, error: imageError }) => {
                if (!imageError && signedUrl?.signedUrl) {
                  processedLink.image_url = signedUrl.signedUrl;
                }
              })
          );
        }

        if (data.video_url && !data.video_url.startsWith('http')) {
          urlPromises.push(
            supabase.storage
              .from("smart-links")
              .createSignedUrl(data.video_url, 86400)
              .then(({ data: signedUrl, error: videoError }) => {
                if (!videoError && signedUrl?.signedUrl) {
                  processedLink.video_url = signedUrl.signedUrl;
                }
              })
          );
        }

        if (data.background_image_url && !data.background_image_url.startsWith('http')) {
          urlPromises.push(
            supabase.storage
              .from("smart-links")
              .createSignedUrl(data.background_image_url, 86400)
              .then(({ data: signedUrl, error: bgError }) => {
                if (!bgError && signedUrl?.signedUrl) {
                  processedLink.background_image_url = signedUrl.signedUrl;
                }
              })
          );
        }

        await Promise.all(urlPromises);
        setSmartLink(processedLink);
        
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

  useEffect(() => {
    if (!smartLink) return;
    document.title = smartLink.headline || smartLink.title;
  }, [smartLink]);

  // Initialize HLS.js for adaptive streaming
  useEffect(() => {
    if (!smartLink?.video_url || !videoRef.current) return;

    const video = videoRef.current;
    const videoUrl = smartLink.video_url;
    const isHLS = videoUrl.includes('.m3u8');

    if (isHLS && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 30,
        maxBufferLength: 10,
        maxMaxBufferLength: 30,
        startLevel: 0,
        startFragPrefetch: true,
        testBandwidth: false,
      });

      hls.loadSource(videoUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(err => console.log('Autoplay prevented:', err));
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              hls.destroy();
              break;
          }
        }
      });

      return () => { hls.destroy(); };
    } else if (isHLS && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = videoUrl;
      video.addEventListener('loadedmetadata', () => {
        video.play().catch(err => console.log('Autoplay prevented:', err));
      });
    }
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
      const { data: existing } = await supabase
        .from("smart_link_leads")
        .select("id")
        .eq("smart_link_id", smartLink!.id)
        .eq("email", validation.data.email)
        .maybeSingle();

      if (existing) {
        toast.success("You're already subscribed! 🎶");
        setHasSubmittedEmail(true);
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

      toast.success("You're in! Check your email for exclusives 🎉");
      setHasSubmittedEmail(true);
    } catch (error) {
      console.error("Error submitting email:", error);
      toast.error("Failed to submit. Please try again");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAlbumClick = () => {
    window.location.href = smartLink!.destination_url;
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black">
        <Loader2 className="w-8 h-8 animate-spin text-white" />
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
  const isMusicTemplate = isRunwayTheme || smartLink.theme_preset === 'default';
  const showEmailCapture = smartLink.show_email_form !== false;
  const hasBulletPoints = smartLink.bullet_point_1 || smartLink.bullet_point_2 || smartLink.bullet_point_3;

  // Music Template v2 CTA label resolver:
  // If button_text is null/empty OR equals "Click Here" (case-insensitive) → "Listen Now"
  const resolveCtaLabel = (raw: string | undefined | null): string => {
    const trimmed = (raw ?? "").trim();
    if (!trimmed || trimmed.toLowerCase() === "click here") return "Listen Now";
    return trimmed;
  };
  const ctaLabel = resolveCtaLabel(smartLink.button_text);

  // ─── Runway Theme: Split Video + Content ───
  if (isRunwayTheme && smartLink.video_url) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="w-full h-screen flex flex-col lg:flex-row">
          {/* Video Section */}
          <div className="w-full lg:w-[65%] h-[45vh] lg:h-full relative">
            <video 
              ref={videoRef}
              autoPlay muted loop playsInline
              preload="metadata"
              poster={smartLink.image_url || undefined}
              className="w-full h-full object-cover"
              onLoadedData={() => setVideoLoaded(true)}
            >
              {smartLink.video_url && !smartLink.video_url.includes('.m3u8') && (
                <source src={smartLink.video_url} type="video/mp4" />
              )}
            </video>
            <div className="absolute inset-0 bg-black/20" />
          </div>

          {/* Content Section */}
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

              {/* Value Props */}
              {hasBulletPoints && (
                <ul className="space-y-3 lg:space-y-4">
                  {[smartLink.bullet_point_1, smartLink.bullet_point_2, smartLink.bullet_point_3].filter(Boolean).map((bp, i) => (
                    <li key={i} className="flex items-start gap-2.5 text-sm lg:text-base text-zinc-200 leading-relaxed">
                      <Sparkles className="w-4 h-4 lg:w-5 lg:h-5 flex-shrink-0 mt-0.5 text-white" />
                      <span>{bp}</span>
                    </li>
                  ))}
                </ul>
              )}

              {/* PRIMARY CTA — Always visible album button */}
              <Button
                size="lg"
                data-testid="album-cta"
                className="w-full h-[50px] bg-white text-black hover:bg-white hover:brightness-110 hover:scale-[1.02] hover:shadow-[0_0_20px_rgba(255,255,255,0.5)] font-bold text-base lg:text-lg transition-all duration-200 shadow-lg active:scale-[0.98]"
                onClick={handleAlbumClick}
              >
                🎧 {ctaLabel}
              </Button>

              {/* SECONDARY — Collapsible email capture plaque */}
              {showEmailCapture && (
                <Collapsible open={emailPlaqueOpen} onOpenChange={setEmailPlaqueOpen}>
                  <CollapsibleTrigger asChild>
                    <button
                      data-testid="email-plaque-trigger"
                      className="w-full flex items-center justify-center gap-2 py-3 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
                    >
                      <Mail className="w-4 h-4" />
                      {hasSubmittedEmail ? "You're subscribed! ✓" : "Unlock extras & updates"}
                      <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${emailPlaqueOpen ? 'rotate-180' : ''}`} />
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    {hasSubmittedEmail ? (
                      <Card className="bg-zinc-900/90 border-zinc-800 p-4 text-center">
                        <p className="text-zinc-300 text-sm">Thanks for subscribing! You'll get exclusive drops and updates. 🎶</p>
                      </Card>
                    ) : (
                      <form onSubmit={handleEmailSubmit} data-testid="email-form">
                        <Card className="bg-zinc-900/90 border-zinc-800 shadow-2xl p-5">
                          <div className="space-y-3">
                            <p className="text-xs text-zinc-400 text-center">Get exclusive drops, early access & behind-the-scenes content.</p>
                            <div className="relative w-full">
                              <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-300 pointer-events-none z-10" />
                              <Input
                                type="email"
                                placeholder="Enter your email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                required
                                disabled={isSubmitting}
                                className="pl-12 h-[44px] w-full bg-zinc-900/60 border-[1.5px] border-zinc-400/60 text-white placeholder:text-zinc-300 focus:border-white focus:ring-2 focus:ring-white/50 text-sm"
                              />
                            </div>
                            <Button
                              type="submit"
                              size="sm"
                              className="w-full bg-zinc-700 text-white hover:bg-zinc-600 font-semibold"
                              disabled={isSubmitting}
                            >
                              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Subscribe"}
                            </Button>
                            <p className="text-xs text-zinc-600 text-center">🔒 No spam, ever.</p>
                          </div>
                        </Card>
                      </form>
                    )}
                  </CollapsibleContent>
                </Collapsible>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Default / Fallback Theme ───
  return (
    <div className="min-h-screen relative" style={backgroundStyle}>
      <div className={`fixed inset-0 bg-gradient-to-br from-black/40 via-black/30 to-black/40 pointer-events-none`} />
      
      {!isRunwayTheme && (
        <div className="fixed inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-1/4 left-1/4 w-64 h-64 bg-primary/10 rounded-full blur-3xl animate-pulse" />
          <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-accent/10 rounded-full blur-3xl animate-pulse delay-1000" />
        </div>
      )}

      <div className="relative z-10">
        <div className="space-y-0">
          {/* Hero Video Section */}
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
              {(smartLink.headline || smartLink.subheadline) && (
                <div className="absolute inset-0 bg-gradient-to-t from-black via-black/50 to-transparent flex flex-col items-center justify-end p-8 text-center">
                  {smartLink.headline && (
                    <h1 className="text-4xl md:text-6xl lg:text-7xl font-bold text-white mb-4">
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
            <Card className="bg-card/95 backdrop-blur-lg shadow-2xl p-8 md:p-12 space-y-8">
              {/* Headline/Subheadline if no video */}
              {!smartLink.video_url && (smartLink.headline || smartLink.subheadline) && (
                <div className="text-center space-y-4 animate-fade-in">
                  {smartLink.headline && (
                    <h1 className="text-4xl md:text-6xl lg:text-7xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-foreground via-primary to-foreground">
                      {smartLink.headline}
                    </h1>
                  )}
                  {smartLink.subheadline && (
                    <p className="text-lg md:text-xl max-w-3xl mx-auto leading-relaxed text-muted-foreground">
                      {smartLink.subheadline}
                    </p>
                  )}
                  <div className="h-1 w-24 mx-auto bg-gradient-to-r from-transparent via-primary to-transparent" />
                </div>
              )}

              {/* Image */}
              {smartLink.image_url && (
                <div className="w-full group animate-fade-in">
                  <div className="relative overflow-hidden rounded-xl">
                    <img 
                      src={smartLink.image_url} 
                      alt={smartLink.title}
                      loading="lazy"
                      className="w-full h-auto object-cover max-h-96 transition-transform duration-500 group-hover:scale-105"
                    />
                  </div>
                </div>
              )}

              {/* Title (if no headline) */}
              {!smartLink.headline && (
                <div className="space-y-2 animate-fade-in text-center">
                  <h1 className="text-5xl md:text-6xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-foreground via-primary to-foreground">
                    {smartLink.title}
                  </h1>
                  <div className="h-1 w-24 mx-auto bg-gradient-to-r from-transparent via-primary to-transparent" />
                </div>
              )}

              {/* Description */}
              {smartLink.description && !smartLink.subheadline && (
                <p className="text-lg md:text-xl leading-relaxed max-w-xl mx-auto animate-fade-in text-center text-muted-foreground">
                  {smartLink.description}
                </p>
              )}

              {/* What You Get */}
              {hasBulletPoints && (
                <div className="max-w-2xl mx-auto space-y-6 p-8 rounded-xl animate-fade-in bg-muted/30">
                  <h2 className="text-2xl md:text-3xl font-bold text-center">What You Get</h2>
                  <ul className="space-y-4">
                    {[smartLink.bullet_point_1, smartLink.bullet_point_2, smartLink.bullet_point_3].filter(Boolean).map((bp, i) => (
                      <li key={i} className="flex items-start gap-3 text-lg text-foreground">
                        <Sparkles className="w-6 h-6 flex-shrink-0 mt-1 text-primary" />
                        <span>{bp}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Testimonial */}
              {smartLink.testimonial_text && (
                <div className="max-w-2xl mx-auto text-center space-y-4 p-8 rounded-xl animate-fade-in bg-muted/30">
                  <div className="text-4xl text-primary">"</div>
                  <p className="text-lg md:text-xl italic leading-relaxed text-foreground">
                    {smartLink.testimonial_text}
                  </p>
                  {smartLink.testimonial_author && (
                    <p className="text-sm font-semibold text-muted-foreground">
                      {smartLink.testimonial_author}
                    </p>
                  )}
                </div>
              )}

              {/* PRIMARY CTA — always visible album/destination button */}
              <div className="animate-fade-in pt-4 text-center space-y-4">
                <Button
                  size="lg"
                  data-testid="album-cta"
                  className="w-full max-w-md text-lg py-7 rounded-xl font-semibold shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-105"
                  style={smartLink.button_color ? { backgroundColor: smartLink.button_color } : undefined}
                  onClick={handleAlbumClick}
                >
                  {ctaLabel}
                  <Sparkles className="w-5 h-5 ml-2" />
                </Button>

                {/* SECONDARY — Collapsible email plaque */}
                {showEmailCapture && (
                  <Collapsible open={emailPlaqueOpen} onOpenChange={setEmailPlaqueOpen}>
                    <CollapsibleTrigger asChild>
                      <button
                        data-testid="email-plaque-trigger"
                        className="mx-auto flex items-center justify-center gap-2 py-3 text-sm text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <Mail className="w-4 h-4" />
                        {hasSubmittedEmail ? "You're subscribed! ✓" : "Unlock extras & updates"}
                        <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${emailPlaqueOpen ? 'rotate-180' : ''}`} />
                      </button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      {hasSubmittedEmail ? (
                        <Card className="max-w-md mx-auto bg-muted/50 border-border p-4 text-center">
                          <p className="text-muted-foreground text-sm">Thanks for subscribing! You'll get exclusive drops and updates. 🎶</p>
                        </Card>
                      ) : (
                        <form onSubmit={handleEmailSubmit} className="max-w-md mx-auto" data-testid="email-form">
                          <Card className="bg-muted/50 border-border p-5">
                            <div className="space-y-3">
                              <p className="text-xs text-muted-foreground text-center">Get exclusive drops, early access & behind-the-scenes content.</p>
                              <div className="relative w-full">
                                <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground pointer-events-none" />
                                <Input
                                  type="email"
                                  placeholder="Enter your email address"
                                  value={email}
                                  onChange={(e) => setEmail(e.target.value)}
                                  required
                                  disabled={isSubmitting}
                                  className="text-base pl-12 h-14 rounded-xl border-2 border-border/50 focus:border-primary/50 bg-background/50"
                                />
                              </div>
                              <Button
                                type="submit"
                                className="w-full font-semibold"
                                disabled={isSubmitting}
                              >
                                {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Subscribe"}
                              </Button>
                              <p className="text-xs text-muted-foreground/60 text-center">🔒 No spam, ever.</p>
                            </div>
                          </Card>
                        </form>
                      )}
                    </CollapsibleContent>
                  </Collapsible>
                )}
              </div>

              {/* Trust badge */}
              {showEmailCapture && (
                <p className="text-xs text-center animate-fade-in text-muted-foreground/60">
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
