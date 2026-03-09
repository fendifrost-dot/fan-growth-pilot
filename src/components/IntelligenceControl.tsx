import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Brain, Clock, CheckCircle, AlertCircle } from "lucide-react";
import { useFanIntelligence } from "@/hooks/useFanIntelligence";

export const IntelligenceControl = () => {
  const { runIntelligence, isRunning, lastRun } = useFanIntelligence();

  const lastRunTime = lastRun?.created_at
    ? new Date(lastRun.created_at).toLocaleString()
    : 'Never';

  const lastRunStatus = lastRun?.status || 'unknown';
  const StatusIcon = lastRunStatus === 'success' ? CheckCircle : lastRunStatus === 'error' ? AlertCircle : Clock;
  const statusColor = lastRunStatus === 'success' ? 'text-success' : lastRunStatus === 'error' ? 'text-destructive' : 'text-muted-foreground';

  return (
    <Card className="p-6 bg-card/50 backdrop-blur-sm border-border">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <Brain className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h4 className="font-semibold">Fan Intelligence Engine</h4>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <StatusIcon className={`w-3 h-3 ${statusColor}`} />
              <span>Last run: {lastRunTime}</span>
              {lastRun?.duration_ms && <span>• {lastRun.duration_ms}ms</span>}
              {lastRun?.status && (
                <Badge variant="outline" className="text-xs">
                  {lastRun.status}
                </Badge>
              )}
            </div>
          </div>
        </div>
        <Button
          onClick={() => runIntelligence()}
          disabled={isRunning}
          variant="outline"
          size="sm"
        >
          {isRunning ? "Running…" : "Run Intelligence"}
        </Button>
      </div>
    </Card>
  );
};
