import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Upload, CheckCircle, AlertCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const UploadEvenCSV = () => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [results, setResults] = useState<{ matched: number; unmatched: number } | null>(null);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.csv')) {
      toast.error("Please upload a CSV file");
      return;
    }

    setIsProcessing(true);
    setResults(null);

    try {
      const text = await file.text();
      const lines = text.split('\n').filter(line => line.trim());
      const headers = lines[0].toLowerCase().split(',').map(h => h.trim());
      
      // Find email column
      const emailIndex = headers.findIndex(h => h.includes('email'));
      if (emailIndex === -1) {
        toast.error("CSV must contain an 'email' column");
        setIsProcessing(false);
        return;
      }

      // Extract emails from CSV
      const emails = lines.slice(1).map(line => {
        const cols = line.split(',').map(c => c.trim());
        return cols[emailIndex]?.toLowerCase().replace(/"/g, '');
      }).filter(email => email && email.includes('@'));

      if (emails.length === 0) {
        toast.error("No valid emails found in CSV");
        setIsProcessing(false);
        return;
      }

      // Fetch current leads
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data: leads, error: fetchError } = await supabase
        .from("smart_link_leads")
        .select("id, email")
        .ilike("email", `%@%`); // Get all leads with emails

      if (fetchError) throw fetchError;

      // Match emails and update
      let matched = 0;
      let unmatched = 0;

      for (const email of emails) {
        const matchedLead = leads?.find(lead => 
          lead.email.toLowerCase() === email.toLowerCase()
        );

        if (matchedLead) {
          const { error: updateError } = await supabase
            .from("smart_link_leads")
            .update({
              album_purchased: true,
              album_purchased_at: new Date().toISOString(),
              purchase_source: 'even'
            })
            .eq('id', matchedLead.id);

          if (!updateError) matched++;
        } else {
          unmatched++;
        }
      }

      setResults({ matched, unmatched });
      
      if (matched > 0) {
        toast.success(`Successfully matched ${matched} EVEN purchases with your leads`);
      } else {
        toast.info("No matching emails found between EVEN and your leads");
      }

    } catch (error) {
      console.error("Error processing CSV:", error);
      toast.error("Failed to process CSV file");
    } finally {
      setIsProcessing(false);
      event.target.value = ''; // Reset input
    }
  };

  return (
    <Card className="p-6 bg-card/50 backdrop-blur-sm border-border">
      <div className="space-y-4">
        <div>
          <h4 className="font-semibold mb-2">Upload EVEN Album Purchases</h4>
          <p className="text-sm text-muted-foreground mb-4">
            Upload your EVEN purchase CSV to cross-reference with smart link leads. 
            The CSV must contain an "email" column.
          </p>
        </div>

        <div className="flex items-center gap-4">
          <Button
            disabled={isProcessing}
            onClick={() => document.getElementById('even-csv-upload')?.click()}
            className="relative"
          >
            <Upload className="w-4 h-4 mr-2" />
            {isProcessing ? "Processing..." : "Upload EVEN CSV"}
          </Button>
          <input
            id="even-csv-upload"
            type="file"
            accept=".csv"
            onChange={handleFileUpload}
            className="hidden"
          />
        </div>

        {results && (
          <div className="space-y-2 pt-4 border-t border-border">
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle className="w-4 h-4 text-success" />
              <span><strong>{results.matched}</strong> emails matched and updated</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <AlertCircle className="w-4 h-4 text-muted-foreground" />
              <span><strong>{results.unmatched}</strong> emails from EVEN not found in leads</span>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
};
