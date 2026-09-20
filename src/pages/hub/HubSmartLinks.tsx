import React, { useState } from "react";
import { Plus, Link as LinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SmartLinkCard } from "@/components/SmartLinkCard";
import { SmartLinkCardSkeleton } from "@/components/skeletons/SmartLinkCardSkeleton";
import { AddSmartLinkDialog, SmartLink } from "@/components/AddSmartLinkDialog";
import { useSmartLinks } from "@/hooks/useSmartLinks";
import { PageHeader, HubEmpty } from "@/components/hub/HubPrimitives";

const HubSmartLinks: React.FC = () => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingLink, setEditingLink] = useState<SmartLink | null>(null);
  const { smartLinks, isLoading, createSmartLink, updateSmartLink, removeSmartLink } =
    useSmartLinks();

  const openCreate = () => {
    setEditingLink(null);
    setDialogOpen(true);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Smart Links"
        description="Shareable landing pages with click, CTA, and conversion tracking. Drop them anywhere you promote a release."
        actions={
          <Button onClick={openCreate} className="gap-2">
            <Plus className="w-4 h-4" />
            Create smart link
          </Button>
        }
      />

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <SmartLinkCardSkeleton />
          <SmartLinkCardSkeleton />
          <SmartLinkCardSkeleton />
        </div>
      ) : smartLinks && smartLinks.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {smartLinks.map((link) => (
            <SmartLinkCard
              key={link.id}
              title={link.title}
              url={link.destination_url}
              slug={link.slug}
              shortCode={link.short_code}
              ogImageUrl={link.og_image_url}
              clicks={link.click_count || 0}
              ctaClicks={link.cta_click_count || 0}
              conversions={link.conversion_count || 0}
              onRemove={() => removeSmartLink(link.id)}
              onEdit={() => {
                setEditingLink(link);
                setDialogOpen(true);
              }}
            />
          ))}
        </div>
      ) : (
        <HubEmpty
          icon={LinkIcon}
          title="No smart links yet"
          description="Create your first smart link to start tracking clicks and conversions."
          action={
            <Button onClick={openCreate}>
              <Plus className="w-4 h-4 mr-2" />
              Create your first smart link
            </Button>
          }
        />
      )}

      <AddSmartLinkDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditingLink(null);
        }}
        onAdd={createSmartLink}
        editLink={editingLink}
        onUpdate={(updatedLink) => {
          updateSmartLink(updatedLink);
          setEditingLink(null);
        }}
      />
    </div>
  );
};

export default HubSmartLinks;
