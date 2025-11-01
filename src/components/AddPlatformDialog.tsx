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

interface AddPlatformDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd?: (platform: PlatformAccount) => void;
  editAccount?: PlatformAccount;
  onUpdate?: (platform: PlatformAccount) => void;
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
  { value: "spotify", label: "Spotify", icon: Music, placeholder: "https://open.spotify.com/artist/..." },
  { value: "instagram", label: "Instagram", icon: Instagram, placeholder: "https://instagram.com/username" },
  { value: "youtube", label: "YouTube", icon: Youtube, placeholder: "https://youtube.com/@username" },
  { value: "facebook", label: "Facebook", icon: Facebook, placeholder: "https://facebook.com/username" },
  { value: "soundcloud", label: "SoundCloud", icon: Music2, placeholder: "https://soundcloud.com/username" },
  { value: "applemusic", label: "Apple Music", icon: Apple, placeholder: "https://music.apple.com/us/artist/..." },
];

export const AddPlatformDialog = ({ open, onOpenChange, onAdd, editAccount, onUpdate }: AddPlatformDialogProps) => {
  const isEditMode = !!editAccount;
  const [selectedPlatform, setSelectedPlatform] = useState(editAccount ? platformOptions.find(p => p.label === editAccount.platform)?.value || "" : "");
  const [url, setUrl] = useState(editAccount?.url || "");
  const [username, setUsername] = useState(editAccount?.username || "");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!selectedPlatform || !url || !username) {
      toast.error("Please fill in all fields");
      return;
    }

    const platformOption = platformOptions.find(p => p.value === selectedPlatform);
    if (!platformOption) return;

    if (isEditMode && editAccount && onUpdate) {
      const updatedAccount: PlatformAccount = {
        ...editAccount,
        platform: platformOption.label,
        username,
        url,
        icon: platformOption.icon,
        lastSync: "Just now"
      };
      
      onUpdate(updatedAccount);
      toast.success(`${platformOption.label} account updated successfully!`);
    } else if (onAdd) {
      const newAccount: PlatformAccount = {
        id: Date.now().toString(),
        platform: platformOption.label,
        username,
        url,
        icon: platformOption.icon,
        status: "connected",
        lastSync: "Just now"
      };

      onAdd(newAccount);
      toast.success(`${platformOption.label} account connected successfully!`);
    }
    
    // Reset form
    setSelectedPlatform("");
    setUrl("");
    setUsername("");
    onOpenChange(false);
  };

  const selectedOption = platformOptions.find(p => p.value === selectedPlatform);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{isEditMode ? "Edit Platform" : "Connect Platform"}</DialogTitle>
          <DialogDescription>
            {isEditMode ? "Update your platform connection details" : "Add your platform URL to start aggregating fan data and analytics"}
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
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

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
              {isEditMode ? "Update Account" : "Connect Account"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
