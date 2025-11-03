import { useEffect, useState } from "react";
import { useParams, Navigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Loader2 } from "lucide-react";

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

export default function SmartLinkPage() {
  const { slug } = useParams<{ slug: string }>();
  const [smartLink, setSmartLink] = useState<SmartLinkData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

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
        
        // Track the page view/click
        await supabase.from("smart_links").update({
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

  const handleButtonClick = () => {
    window.location.href = smartLink.destination_url;
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={backgroundStyle}>
      <Card className="max-w-2xl w-full p-8 bg-card/95 backdrop-blur-sm">
        <div className="space-y-6 text-center">
          {/* Image */}
          {smartLink.image_url && (
            <div className="w-full">
              <img 
                src={smartLink.image_url} 
                alt={smartLink.title}
                className="w-full h-auto rounded-lg object-cover max-h-96"
              />
            </div>
          )}

          {/* Title */}
          <h1 className="text-4xl font-bold">{smartLink.title}</h1>

          {/* Description */}
          {smartLink.description && (
            <p className="text-lg text-muted-foreground">
              {smartLink.description}
            </p>
          )}

          {/* Video */}
          {smartLink.video_url && (
            <div className="w-full aspect-video">
              <video 
                src={smartLink.video_url}
                controls
                className="w-full h-full rounded-lg"
              />
            </div>
          )}

          {/* CTA Button */}
          <Button
            size="lg"
            className="w-full text-lg py-6"
            style={{ 
              backgroundColor: smartLink.button_color || undefined,
            }}
            onClick={handleButtonClick}
          >
            {smartLink.button_text || "Click Here"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
