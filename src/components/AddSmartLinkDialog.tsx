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
import { toast } from "sonner";

interface AddSmartLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd?: (link: SmartLink) => void;
  editLink?: SmartLink;
  onUpdate?: (link: SmartLink) => void;
}

export interface SmartLink {
  id: string;
  title: string;
  url: string;
  clicks: number;
  conversions: number;
}

export const AddSmartLinkDialog = ({ open, onOpenChange, onAdd, editLink, onUpdate }: AddSmartLinkDialogProps) => {
  const isEditMode = !!editLink;
  const [title, setTitle] = useState(editLink?.title || "");
  const [url, setUrl] = useState(editLink?.url || "");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!title || !url) {
      toast.error("Please fill in all fields");
      return;
    }

    if (isEditMode && editLink && onUpdate) {
      const updatedLink: SmartLink = {
        ...editLink,
        title,
        url,
      };
      
      onUpdate(updatedLink);
      toast.success("Smart link updated successfully!");
    } else if (onAdd) {
      const newLink: SmartLink = {
        id: Date.now().toString(),
        title,
        url,
        clicks: 0,
        conversions: 0,
      };

      onAdd(newLink);
      toast.success("Smart link created successfully!");
    }
    
    // Reset form
    setTitle("");
    setUrl("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{isEditMode ? "Edit Smart Link" : "Create Smart Link"}</DialogTitle>
          <DialogDescription>
            {isEditMode ? "Update your smart link details" : "Create a trackable smart link for your campaigns"}
          </DialogDescription>
        </DialogHeader>
        
        <form onSubmit={handleSubmit} className="space-y-6 mt-4">
          <div className="space-y-2">
            <Label htmlFor="title">Link Title</Label>
            <Input
              id="title"
              placeholder="e.g., New Album Drop"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="url">Short URL</Label>
            <Input
              id="url"
              placeholder="go.bemoremodest.com/album"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
            <p className="text-xs text-muted-foreground">
              Enter your custom short link URL
            </p>
          </div>

          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">
              {isEditMode ? "Update Link" : "Create Link"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
