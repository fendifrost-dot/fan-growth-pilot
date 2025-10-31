import { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";

interface MetricCardProps {
  title: string;
  value: string;
  change: string;
  icon: LucideIcon;
  trend: "up" | "down";
}

export const MetricCard = ({ title, value, change, icon: Icon, trend }: MetricCardProps) => {
  return (
    <Card className="p-6 bg-card/50 backdrop-blur-sm border-border hover:shadow-glow transition-all duration-300">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-sm text-muted-foreground mb-1">{title}</p>
          <h3 className="text-3xl font-bold mb-2">{value}</h3>
          <p className={`text-sm flex items-center gap-1 ${trend === "up" ? "text-success" : "text-destructive"}`}>
            <span>{trend === "up" ? "↑" : "↓"}</span>
            {change}
          </p>
        </div>
        <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center">
          <Icon className="w-6 h-6 text-primary" />
        </div>
      </div>
    </Card>
  );
};
