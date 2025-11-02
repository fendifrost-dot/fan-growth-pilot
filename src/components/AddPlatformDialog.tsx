import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Music, Instagram, Youtube, Facebook, Music2, Apple } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

interface AddPlatformDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnect: (connection: {
    platform: string;
    username: string;
    profile_url: string;
    access_token?: string;
    pixel_id?: string;
  }) => void;
}

export interface PlatformAccount {
  id: string;
  platform: string;
  username: string;
  url: string;
  icon: typeof Music;
  status: "connected" | "syncing" | "error";
  lastSync?: string;
}

const platformOptions = [
  { value: "spotify", label: "Spotify", icon: Music, placeholder: "https://open.spotify.com/artist/...", needsOAuth: true },
  { value: "instagram", label: "Instagram", icon: Instagram, placeholder: "https://instagram.com/username", needsOAuth: false },
  { value: "youtube", label: "YouTube", icon: Youtube, placeholder: "https://youtube.com/@username", needsOAuth: false },
  { value: "facebook", label: "Facebook", icon: Facebook, placeholder: "https://facebook.com/username", needsPixelId: true },
  { value: "soundcloud", label: "SoundCloud", icon: Music2, placeholder: "https://soundcloud.com/username", needsOAuth: false },
  { value: "applemusic", label: "Apple Music", icon: Apple, placeholder: "https://music.apple.com/us/artist/...", needsOAuth: false },
];

export const AddPlatformDialog = ({ open, onOpenChange, onConnect }: AddPlatformDialogProps) => {
  const [selectedPlatform, setSelectedPlatform] = useState("");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [pixelId, setPixelId] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const platformOption = platformOptions.find(p => p.value === selectedPlatform);
    if (!platformOption) {
      toast.error("Please select a platform");
      return;
    }

    // For Spotify, initiate OAuth flow
    if (platformOption.needsOAuth && selectedPlatform === "spotify") {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
          toast.error("Please log in to connect Spotify");
          return;
        }
        
        console.log('Calling spotify-auth function with user_id:', user.id);
        
        // Call the edge function to get the authorization URL
        const { data, error } = await supabase.functions.invoke('spotify-auth', {
          body: { user_id: user.id }
        });

        console.log('spotify-auth response:', { data, error });

        if (error) {
          console.error('Spotify auth error:', error);
          toast.error(`Failed to initiate Spotify connection: ${error.message}`);
          return;
        }

        if (data?.authUrl) {
          console.log('Redirecting to:', data.authUrl);
          // Open Spotify's authorization page in a new window
          const width = 600;
          const height = 700;
          const left = (window.screen.width - width) / 2;
          const top = (window.screen.height - height) / 2;
          
          window.open(
            data.authUrl,
            'spotify-auth',
            `width=${width},height=${height},left=${left},top=${top},popup=yes`
          );
          
          toast.success("Opening Spotify authorization...");
          onOpenChange(false);
        } else {
          console.error('No authUrl in response:', data);
          toast.error("Failed to get authorization URL");
        }
        return;
      } catch (error) {
        console.error('Spotify OAuth exception:', error);
        toast.error("Failed to initiate Spotify connection");
        return;
      }
    }

    // Validate required fields
    if (!username) {
      toast.error("Please enter your username");
      return;
    }

    // For Facebook, require Pixel ID
    if (platformOption.needsPixelId && !pixelId) {
      toast.error("Please enter your Facebook Pixel ID");
      return;
    }

    if (!url) {
      toast.error("Please enter your profile URL");
      return;
    }

    // Create the connection
    onConnect({
      platform: platformOption.label,
      username,
      profile_url: url,
      pixel_id: platformOption.needsPixelId ? pixelId : undefined,
    });
    
    // Reset form
    setSelectedPlatform("");
    setUrl("");
    setUsername("");
    setPixelId("");
    onOpenChange(false);
  };

  const selectedOption = platformOptions.find(p => p.value === selectedPlatform);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Connect Platform</DialogTitle>
          <DialogDescription>
            Connect your platform to aggregate fan data, track engagement, and analyze conversions
          </DialogDescription>
        </DialogHeader>
        
        <form onSubmit={handleSubmit} className="space-y-6 mt-4">
          <div className="space-y-2">
            <Label htmlFor="platform">Platform</Label>
            <Select value={selectedPlatform} onValueChange={setSelectedPlatform}>
              <SelectTrigger id="platform">
                <SelectValue placeholder="Select a platform" />
              </SelectTrigger>
              <SelectContent>
                {platformOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <div className="flex items-center gap-2">
                      <option.icon className="w-4 h-4" />
                      {option.label}
                      {option.needsOAuth && <span className="text-xs text-muted-foreground">(OAuth)</span>}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedOption?.needsOAuth && selectedPlatform === "spotify" && (
            <div className="p-3 bg-info/10 border border-info/20 rounded-md">
              <p className="text-sm text-info">
                Spotify requires OAuth authentication for full data access including streams, followers, and engagement metrics. Click Connect to authorize.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="username">Username/Artist Name</Label>
            <Input
              id="username"
              placeholder="yourusername"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>

          {selectedOption?.needsPixelId && (
            <div className="space-y-2">
              <Label htmlFor="pixelId">Facebook Pixel ID</Label>
              <Input
                id="pixelId"
                placeholder="123456789012345"
                value={pixelId}
                onChange={(e) => setPixelId(e.target.value)}
                required
              />
              <p className="text-xs text-muted-foreground">
                Find your Pixel ID in Facebook Events Manager for conversion tracking
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="url">Profile URL</Label>
            <Input
              id="url"
              type="url"
              placeholder={selectedOption?.placeholder || "https://..."}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
            <p className="text-xs text-muted-foreground">
              Enter the full URL to your {selectedOption?.label || "platform"} profile
            </p>
          </div>

          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">
              {selectedOption?.needsOAuth ? "Authorize & Connect" : "Connect Account"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
