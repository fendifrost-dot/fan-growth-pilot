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
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Upload, Image as ImageIcon, Video } from "lucide-react";
import { z } from "zod";

// Validation schema for smart link inputs
const smartLinkSchema = z.object({
  title: z.string().min(1, "Title is required").max(200, "Title must be less than 200 characters"),
  slug: z.string()
    .min(1, "Slug is required")
    .max(100, "Slug must be less than 100 characters")
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must contain only lowercase letters, numbers, and hyphens"),
  destination_url: z.string()
    .url("Must be a valid URL")
    .refine(url => !url.toLowerCase().startsWith('javascript:') && !url.toLowerCase().startsWith('data:'), 
      "Invalid URL scheme - javascript: and data: URLs are not allowed"),
  description: z.string().max(1000, "Description must be less than 1000 characters").optional(),
  button_text: z.string().max(50, "Button text must be less than 50 characters").optional(),
});

interface AddSmartLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd?: (link: any) => void;
  editLink?: any;
  onUpdate?: (link: any) => void;
}

export interface SmartLink {
  id: string;
  title: string;
  slug: string;
  destination_url: string;
  description?: string;
  image_url?: string;
  video_url?: string;
  background_image_url?: string;
  button_text?: string;
  button_color?: string;
  background_color?: string;
  click_count: number;
  conversion_count: number;
}

export const AddSmartLinkDialog = ({ open, onOpenChange, onAdd, editLink, onUpdate }: AddSmartLinkDialogProps) => {
  const isEditMode = !!editLink;
  const [title, setTitle] = useState(editLink?.title || "");
  const [slug, setSlug] = useState(editLink?.slug || "");
  const [destinationUrl, setDestinationUrl] = useState(editLink?.destination_url || "");
  const [description, setDescription] = useState(editLink?.description || "");
  const [buttonText, setButtonText] = useState(editLink?.button_text || "Click Here");
  const [buttonColor, setButtonColor] = useState(editLink?.button_color || "");
  const [backgroundColor, setBackgroundColor] = useState(editLink?.background_color || "");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [backgroundImageFile, setBackgroundImageFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState(editLink?.image_url || "");
  const [videoUrl, setVideoUrl] = useState(editLink?.video_url || "");
  const [backgroundImageUrl, setBackgroundImageUrl] = useState(editLink?.background_image_url || "");
  const [isUploading, setIsUploading] = useState(false);

  const uploadFile = async (file: File, type: 'image' | 'video'): Promise<string> => {
    const fileExt = file.name.split('.').pop();
    const fileName = `${Math.random()}.${fileExt}`;
    const filePath = `${type}s/${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from('smart-links')
      .upload(filePath, file);

    if (uploadError) throw uploadError;

    const { data } = supabase.storage
      .from('smart-links')
      .getPublicUrl(filePath);

    return data.publicUrl;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Validate inputs using Zod schema
    try {
      smartLinkSchema.parse({
        title,
        slug,
        destination_url: destinationUrl,
        description,
        button_text: buttonText,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        error.errors.forEach((err) => {
          toast.error(err.message);
        });
        return;
      }
    }

    setIsUploading(true);

    try {
      let finalImageUrl = imageUrl;
      let finalVideoUrl = videoUrl;
      let finalBackgroundImageUrl = backgroundImageUrl;

      // Upload image if new file selected
      if (imageFile) {
        finalImageUrl = await uploadFile(imageFile, 'image');
      }

      // Upload video if new file selected
      if (videoFile) {
        finalVideoUrl = await uploadFile(videoFile, 'video');
      }

      // Upload background image if new file selected
      if (backgroundImageFile) {
        finalBackgroundImageUrl = await uploadFile(backgroundImageFile, 'image');
      }

      const linkData = {
        title,
        slug,
        destination_url: destinationUrl,
        description,
        image_url: finalImageUrl,
        video_url: finalVideoUrl,
        background_image_url: finalBackgroundImageUrl,
        button_text: buttonText,
        button_color: buttonColor,
        background_color: backgroundColor,
      };

      if (isEditMode && editLink && onUpdate) {
        onUpdate({ ...editLink, ...linkData });
        toast.success("Smart link updated successfully!");
      } else if (onAdd) {
        onAdd(linkData);
        toast.success("Smart link created successfully!");
      }
      
      // Reset form
      setTitle("");
      setSlug("");
      setDestinationUrl("");
      setDescription("");
      setButtonText("Click Here");
      setButtonColor("");
      setBackgroundColor("");
      setImageFile(null);
      setVideoFile(null);
      setBackgroundImageFile(null);
      setImageUrl("");
      setVideoUrl("");
      setBackgroundImageUrl("");
      onOpenChange(false);
    } catch (error: any) {
      toast.error("Failed to upload files: " + error.message);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditMode ? "Edit Smart Link" : "Create Smart Link"}</DialogTitle>
          <DialogDescription>
            {isEditMode ? "Update your smart link details" : "Create a customizable smart link with images, videos, and more"}
          </DialogDescription>
        </DialogHeader>
        
        <form onSubmit={handleSubmit} className="space-y-4 mt-4">
          <div className="space-y-2">
            <Label htmlFor="title">Link Title *</Label>
            <Input
              id="title"
              placeholder="e.g., New Album Drop"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="slug">Slug *</Label>
            <div className="flex gap-2">
              <Input
                id="slug"
                placeholder="album-drop"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                required
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => setSlug(Math.random().toString(36).substring(2, 8))}
              >
                Generate Short
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Use a custom slug or generate a short random one
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="destination">Destination URL *</Label>
            <Input
              id="destination"
              type="url"
              placeholder="https://example.com"
              value={destinationUrl}
              onChange={(e) => setDestinationUrl(e.target.value)}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              placeholder="Add a description for your smart link..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="image">Upload Image</Label>
            <div className="flex items-center gap-2">
              <Input
                id="image"
                type="file"
                accept="image/*"
                onChange={(e) => setImageFile(e.target.files?.[0] || null)}
                className="flex-1"
              />
              <ImageIcon className="w-5 h-5 text-muted-foreground" />
            </div>
            {(imageUrl || imageFile) && (
              <p className="text-xs text-muted-foreground">
                {imageFile ? `New: ${imageFile.name}` : "Image uploaded"}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="video">Upload Video</Label>
            <div className="flex items-center gap-2">
              <Input
                id="video"
                type="file"
                accept="video/*"
                onChange={(e) => setVideoFile(e.target.files?.[0] || null)}
                className="flex-1"
              />
              <Video className="w-5 h-5 text-muted-foreground" />
            </div>
            {(videoUrl || videoFile) && (
              <p className="text-xs text-muted-foreground">
                {videoFile ? `New: ${videoFile.name}` : "Video uploaded"}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="buttonText">Button Text</Label>
              <Input
                id="buttonText"
                placeholder="Click Here"
                value={buttonText}
                onChange={(e) => setButtonText(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="buttonColor">Button Color</Label>
              <Input
                id="buttonColor"
                type="color"
                value={buttonColor}
                onChange={(e) => setButtonColor(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="backgroundColor">Background Color</Label>
              <Input
                id="backgroundColor"
                type="color"
                value={backgroundColor}
                onChange={(e) => setBackgroundColor(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="backgroundImage">Background Image</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="backgroundImage"
                  type="file"
                  accept="image/*"
                  onChange={(e) => setBackgroundImageFile(e.target.files?.[0] || null)}
                  className="flex-1"
                />
                <ImageIcon className="w-5 h-5 text-muted-foreground" />
              </div>
              {(backgroundImageUrl || backgroundImageFile) && (
                <p className="text-xs text-muted-foreground">
                  {backgroundImageFile ? `New: ${backgroundImageFile.name}` : "Image uploaded"}
                </p>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isUploading}>
              {isUploading ? (
                <>
                  <Upload className="w-4 h-4 mr-2 animate-spin" />
                  Uploading...
                </>
              ) : (
                isEditMode ? "Update Link" : "Create Link"
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
