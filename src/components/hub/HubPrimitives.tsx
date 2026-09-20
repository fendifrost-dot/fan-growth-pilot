import React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertCircle, Inbox, Loader2, type LucideIcon } from "lucide-react";

/** Page title + optional description and right-aligned actions. */
export const PageHeader: React.FC<{
  title: string;
  description?: string;
  actions?: React.ReactNode;
}> = ({ title, description, actions }) => (
  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-6">
    <div>
      <h2 className="text-2xl sm:text-3xl font-bold">{title}</h2>
      {description && (
        <p className="text-muted-foreground mt-1 max-w-2xl">{description}</p>
      )}
    </div>
    {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
  </div>
);

/** Compact KPI tile. */
export const StatTile: React.FC<{
  label: string;
  value: React.ReactNode;
  sub?: string;
  icon?: LucideIcon;
}> = ({ label, value, sub, icon: Icon }) => (
  <Card className="p-5 bg-card/50 backdrop-blur-sm border-border">
    <div className="flex items-start justify-between">
      <div className="min-w-0">
        <p className="text-sm text-muted-foreground mb-1">{label}</p>
        <p className="text-2xl font-bold truncate">{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </div>
      {Icon && (
        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <Icon className="w-5 h-5 text-primary" />
        </div>
      )}
    </div>
  </Card>
);

export const HubLoading: React.FC<{ label?: string }> = ({
  label = "Loading…",
}) => (
  <Card className="p-10 flex flex-col items-center justify-center text-center bg-card/50 border-border">
    <Loader2 className="w-6 h-6 animate-spin text-primary mb-3" />
    <p className="text-sm text-muted-foreground">{label}</p>
  </Card>
);

export const HubError: React.FC<{
  message?: string;
  onRetry?: () => void;
}> = ({ message = "Something went wrong loading this section.", onRetry }) => (
  <Card className="p-10 flex flex-col items-center justify-center text-center bg-card/50 border-destructive/30">
    <AlertCircle className="w-6 h-6 text-destructive mb-3" />
    <p className="text-sm text-muted-foreground max-w-md">{message}</p>
    {onRetry && (
      <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
        Try again
      </Button>
    )}
  </Card>
);

export const HubEmpty: React.FC<{
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
}> = ({ title, description, icon: Icon = Inbox, action }) => (
  <Card className="p-10 flex flex-col items-center justify-center text-center bg-card/50 border-dashed border-border">
    <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4">
      <Icon className="w-6 h-6 text-muted-foreground" />
    </div>
    <p className="font-medium">{title}</p>
    {description && (
      <p className="text-sm text-muted-foreground mt-1 max-w-md">{description}</p>
    )}
    {action && <div className="mt-4">{action}</div>}
  </Card>
);

/** Renders a human-friendly "updated 5m ago" from an ISO timestamp. */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const diffMs = Date.now() - then;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

export const LastUpdated: React.FC<{ iso: string | null | undefined }> = ({
  iso,
}) => (
  <span className="text-xs text-muted-foreground">
    Last updated {formatRelative(iso)}
  </span>
);

/** Formats a number compactly (1.2K, 3.4M). */
export function compactNumber(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}
