import { useEffect, useState, useRef } from "react";
import { useParams, Navigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Loader2, Mail, ChevronDown } from "lucide-react";
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
  metadata?: Record<string, unknown> | null;
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
  const accordionFiredRef = useRef(false);
  const videoPlayFiredRef = useRef(false);
  const ctaDebounceRef = useRef(false);

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
        
        void Promise.resolve(supabase.rpc('increment_link_clicks', { link_id: data.id })).catch(() => {});

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
    if (!smartLink?.video_url || !videoRef?.current) return;

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

  const firePixel = (eventName: string, params?: Record<string, any>) => {
    // Generate a unique event ID for deduplication between pixel + CAPI
    const eventId = `${eventName}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    // Client-side pixel
    if (typeof window !== 'undefined' && (window as any).fbq) {
      (window as any).fbq('trackCustom', eventName, params, { eventID: eventId });
    }

    // Server-side CAPI (fire-and-forget)
    const getCookie = (name: string) => {
      const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
      return match ? match[2] : undefined;
    };

    supabase.functions.invoke('meta-conversions', {
      body: {
        event_name: eventName,
        event_id: eventId,
        event_source_url: window.location.href,
        user_data: {
          client_user_agent: navigator.userAgent,
          fbp: getCookie('_fbp'),
          fbc: getCookie('_fbc'),
        },
        custom_data: params || {},
      },
    }).catch((err) => console.warn('CAPI fire-and-forget error:', err));
  };

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

      void Promise.resolve(supabase.rpc('increment_email_submit', { link_id: smartLink!.id })).catch(() => {});
      firePixel('EmailSignup', { smart_link_id: smartLink!.id, smart_link_slug: smartLink!.slug });
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
    if (!ctaDebounceRef.current) {
      ctaDebounceRef.current = true;
      void Promise.resolve(supabase.rpc('increment_cta_click', { link_id: smartLink!.id })).catch(() => {});
      // Fire Meta Pixel custom event for retargeting CTA clickers
      if (typeof window !== 'undefined' && (window as any).fbq) {
        (window as any).fbq('trackCustom', 'CTAClick', {
          smart_link_id: smartLink!.id,
          smart_link_slug: smartLink!.slug,
          destination_url: smartLink!.destination_url,
        });
        console.log("Meta Pixel CTAClick Event Fired", { smart_link_id: smartLink!.id, slug: smartLink!.slug });
      }
      setTimeout(() => { ctaDebounceRef.current = false; }, 400);
    }
    window.location.href = smartLink!.destination_url;
  };

  const handleAccordionChange = (open: boolean) => {
    setEmailPlaqueOpen(open);
    if (open && !accordionFiredRef.current) {
      accordionFiredRef.current = true;
      void Promise.resolve(supabase.rpc('increment_accordion_open', { link_id: smartLink!.id })).catch(() => {});
      firePixel('AccordionOpen', { smart_link_id: smartLink!.id, smart_link_slug: smartLink!.slug });
    }
  };

  const handleVideoPlay = () => {
    if (!videoPlayFiredRef.current && smartLink) {
      videoPlayFiredRef.current = true;
      void Promise.resolve(supabase.rpc('increment_video_play', { link_id: smartLink.id })).catch(() => {});
      firePixel('VideoPlay', { smart_link_id: smartLink.id, smart_link_slug: smartLink.slug });
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-black">
        <Loader2 className="w-8 h-8 animate-spin text-white" />
      </div>
    );
  }

  if (notFound || !smartLink) {
    return <Navigate to="/404" replace />;
  }

  const isRunwayTheme = smartLink.theme_preset === 'runway';
  const isMusicTemplate = isRunwayTheme || smartLink.theme_preset === 'default';
  const showEmailCapture = smartLink.show_email_form !== false;
  const hasBulletPoints = smartLink.bullet_point_1 || smartLink.bullet_point_2 || smartLink.bullet_point_3;

  // Music Template v2 CTA label resolver
  const resolveCtaLabel = (raw: string | undefined | null): string => {
    const trimmed = (raw ?? "").trim();
    if (!trimmed || trimmed.toLowerCase() === "click here") return "Listen Now";
    return trimmed;
  };
  const ctaLabel = resolveCtaLabel(smartLink.button_text);

  // ─── Multi-DSP buttons (Phase 2): read DSP URLs from metadata jsonb ───
  // When metadata has any of {spotify_url, apple_music_url, youtube_url, tidal_url, even_url},
  // render a stack of direct DSP buttons that skip the rnd.fm middleman click and fire
  // platform-tagged CTAClick events for clean per-DSP attribution.
  const meta = (smartLink.metadata as Record<string, string> | null | undefined) || undefined;
  const dspLinks: Array<{ name: string; url: string; bg: string; color: string }> = [];
  if (meta) {
    if (meta.spotify_url) dspLinks.push({ name: 'Spotify', url: meta.spotify_url, bg: '#1DB954', color: '#fff' });
    if (meta.apple_music_url) dspLinks.push({ name: 'Apple Music', url: meta.apple_music_url, bg: '#FFFFFF', color: '#000' });
    if (meta.youtube_url) dspLinks.push({ name: 'YouTube', url: meta.youtube_url, bg: '#FF0000', color: '#fff' });
    if (meta.tidal_url) dspLinks.push({ name: 'Tidal', url: meta.tidal_url, bg: '#000000', color: '#fff' });
    if (meta.even_url) dspLinks.push({ name: 'EVEN', url: meta.even_url, bg: 'linear-gradient(135deg, #D4AF37, #FFD700)', color: '#000' });
  }
  const hasDspLinks = dspLinks.length > 0;

  const handleDspClick = (platform: string, destinationUrl: string) => {
    if (!ctaDebounceRef.current) {
      ctaDebounceRef.current = true;
      void Promise.resolve(supabase.rpc('increment_cta_click', { link_id: smartLink!.id })).catch(() => {});
      if (typeof window !== 'undefined' && (window as any).fbq) {
        (window as any).fbq('trackCustom', 'CTAClick', {
          smart_link_id: smartLink!.id,
          smart_link_slug: smartLink!.slug,
          destination_url: destinationUrl,
          platform,
        });
      }
      setTimeout(() => { ctaDebounceRef.current = false; }, 400);
    }
    window.location.href = destinationUrl;
  };

  const dspButtonsBlock = hasDspLinks ? (
    <div className="w-full space-y-2" data-testid="dsp-buttons">
      {dspLinks.map((dsp) => (
        <Button
          key={dsp.name}
          size="lg"
          data-testid={`dsp-${dsp.name.toLowerCase().replace(' ', '-')}`}
          className="w-full h-[50px] font-bold tracking-wide text-sm sm:text-base transition-all duration-200 shadow-lg active:scale-[0.98] hover:scale-[1.02]"
          style={{ background: dsp.bg, color: dsp.color }}
          onClick={() => handleDspClick(dsp.name.toLowerCase().replace(' ', '_'), dsp.url)}
        >
          Listen on {dsp.name}
        </Button>
      ))}
    </div>
  ) : null;


  // ─── Shared: Bullet points (rendered inside accordion only) ───
  const bulletPointsBlock = hasBulletPoints ? (
    <ul className="space-y-3 pt-3 pb-1" data-testid="bullet-points">
      {[smartLink.bullet_point_1, smartLink.bullet_point_2, smartLink.bullet_point_3].filter(Boolean).map((bp, i) => (
        <li key={i} className="flex items-start gap-3 text-sm text-white leading-relaxed">
          <span className="flex-shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full bg-zinc-500" />
          <span>{bp}</span>
        </li>
      ))}
    </ul>
  ) : null;

  // ─── Shared: Email accordion (bullets + email form inside) ───
  const emailAccordionBlock = showEmailCapture ? (
    <Collapsible open={emailPlaqueOpen} onOpenChange={handleAccordionChange}>
      <CollapsibleTrigger asChild>
        <button
          data-testid="email-plaque-trigger"
          className="w-full flex items-center justify-center gap-2 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <Mail className="w-4 h-4" />
          {hasSubmittedEmail ? "You're subscribed! ✓" : "Unlock extras & updates"}
          <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${emailPlaqueOpen ? 'rotate-180' : ''}`} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="relative z-10 mt-3 rounded-xl bg-black/95 backdrop-blur-md border border-white/10 shadow-lg p-5 lg:p-6 space-y-4">
          {bulletPointsBlock}
          {hasSubmittedEmail ? (
            <div className="text-center">
              <p className="text-white text-sm">Thanks for subscribing! You'll get exclusive drops and updates.</p>
            </div>
          ) : (
            <form onSubmit={handleEmailSubmit} data-testid="email-form">
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
                    className="pl-12 h-[44px] w-full bg-black border-[1.5px] border-zinc-400/60 text-white placeholder:text-zinc-300 focus:border-white focus:ring-2 focus:ring-white/50 text-sm"
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
                <p className="text-xs text-zinc-600 text-center">No spam, ever.</p>
              </div>
            </form>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  ) : null;

  // ─── Runway Theme: Split Video + Content ───
  if (isRunwayTheme && smartLink.video_url) {
    return (
      <div className="min-h-[100dvh] bg-black flex items-center justify-center">
        <div className="w-full min-h-[100dvh] flex flex-col lg:flex-row">
          {/* Video Section */}
          <div className="w-full lg:w-[65%] h-[40vh] lg:h-auto lg:min-h-[100dvh] relative flex-shrink-0">
            <video 
              ref={videoRef}
              autoPlay muted loop playsInline
              preload="metadata"
              poster={smartLink.image_url || undefined}
              className="w-full h-full object-cover absolute inset-0"
              onLoadedData={() => setVideoLoaded(true)}
            >
              {smartLink.video_url && !smartLink.video_url.includes('.m3u8') && (
                <source src={smartLink.video_url} type="video/mp4" />
              )}
            </video>
            <div className="absolute inset-0 bg-black/20" />
          </div>

          {/* Content Section — tight, CTA-dominant */}
          <div className="w-full lg:w-[35%] flex items-center justify-center px-5 py-6 lg:p-8 bg-black" data-testid="hero-content">
            <div className="w-full max-w-xl space-y-4 my-auto">
              {/* Headline */}
              <div className="space-y-1 text-center">
                <h1 className="text-3xl lg:text-4xl xl:text-5xl font-bold text-white font-['Playfair_Display'] leading-tight">
                  {smartLink.headline || smartLink.title}
                </h1>
                {(smartLink.subheadline || smartLink.description) && (
                  <p className="text-xl lg:text-2xl xl:text-3xl font-normal italic text-white/90">
                    {smartLink.subheadline || smartLink.description}
                  </p>
                )}
              </div>

              {/* Album Cover — compact */}
              {smartLink.image_url && (
                <div className="w-full max-w-[200px] mx-auto">
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

              {/* PRIMARY CTA — multi-DSP stack if metadata has DSP URLs, else single CTA */}
              {hasDspLinks ? dspButtonsBlock : (
                <Button
                  size="lg"
                  data-testid="album-cta"
                  className="w-full h-[50px] bg-white text-black hover:bg-white hover:brightness-110 hover:scale-[1.02] hover:shadow-[0_0_20px_rgba(255,255,255,0.5)] font-extrabold tracking-wide text-base lg:text-lg uppercase transition-all duration-200 shadow-lg active:scale-[0.98]"
                  onClick={handleAlbumClick}
                >
                  {ctaLabel}
                </Button>
              )}

              {/* SECONDARY — Collapsible email + bullets */}
              {emailAccordionBlock}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Default Theme (Template v2): Full-bleed hero ───
  return (
    <div
      className="min-h-[100dvh] relative flex flex-col items-center justify-center overflow-hidden"
      style={{ backgroundColor: smartLink.background_color || '#000000' }}
    >
      {/* Layer 1: Video background (preferred) or blurred cover art */}
      {smartLink.video_url ? (
        <video
          ref={videoRef}
          autoPlay muted loop playsInline
          preload="metadata"
          poster={smartLink.image_url || undefined}
          className="absolute inset-0 z-0 w-full h-full object-cover"
          onLoadedData={() => setVideoLoaded(true)}
          onPlay={handleVideoPlay}
          data-testid="background-video"
        >
          {!smartLink.video_url.includes('.m3u8') && (
            <source src={smartLink.video_url} type="video/mp4" />
          )}
        </video>
      ) : smartLink.image_url ? (
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{
            backgroundImage: `url(${smartLink.image_url})`,
            filter: 'blur(14px) brightness(0.55)',
            transform: 'scale(1.2)',
          }}
        />
      ) : null}
      <div className="absolute inset-0 bg-black/40" />

      {/* Hero content — vertically centered, tight spacing */}
      <div className="relative z-10 w-full max-w-sm mx-auto px-5 py-8 flex flex-col items-center text-center space-y-4" data-testid="hero-content">
        {/* Cover art */}
        {smartLink.image_url && (
          <div className="w-[200px] h-[200px] flex-shrink-0">
            <img
              src={smartLink.image_url}
              alt={smartLink.title}
              loading="eager"
              className="w-full h-full object-cover rounded-lg shadow-2xl"
            />
          </div>
        )}

        {/* Title + subheadline */}
        <div className="space-y-1">
          <h1 className="text-2xl font-bold text-white leading-tight">
            {smartLink.headline || smartLink.title}
          </h1>
          {(smartLink.subheadline || smartLink.description) && (
            <p className="text-sm text-zinc-300 leading-snug">
              {smartLink.subheadline || smartLink.description}
            </p>
          )}
        </div>

        {/* PRIMARY CTA — multi-DSP stack if metadata has DSP URLs, else single CTA */}
        {hasDspLinks ? dspButtonsBlock : (
          <Button
            size="lg"
            data-testid="album-cta"
            className="w-full h-[50px] bg-white text-black hover:bg-white hover:brightness-110 hover:scale-[1.02] hover:shadow-[0_0_20px_rgba(255,255,255,0.5)] font-extrabold tracking-wide text-base uppercase transition-all duration-200 shadow-lg active:scale-[0.98]"
            style={smartLink.button_color ? { backgroundColor: smartLink.button_color } : undefined}
            onClick={handleAlbumClick}
          >
            {ctaLabel}
          </Button>
        )}

        {/* SECONDARY — Collapsible email + bullets */}
        {emailAccordionBlock}

        {/* Trust badge */}
        {showEmailCapture && (
          <p className="text-xs text-zinc-500">
            🔒 Your information is secure and will never be shared
          </p>
        )}
      </div>

      {/* Testimonial below fold */}
      {smartLink.testimonial_text && (
        <div className="relative z-10 w-full max-w-sm mx-auto px-5 pb-8 text-center space-y-2">
          <div className="text-2xl text-white/40">"</div>
          <p className="text-sm italic text-zinc-400 leading-relaxed">
            {smartLink.testimonial_text}
          </p>
          {smartLink.testimonial_author && (
            <p className="text-xs text-zinc-500 font-semibold">
              {smartLink.testimonial_author}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
