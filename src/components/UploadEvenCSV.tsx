import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Upload, CheckCircle, AlertCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import Papa from "papaparse";
import { z } from "zod";

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

    // Check file size (5MB limit)
    const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
    if (file.size > MAX_FILE_SIZE) {
      toast.error("File size exceeds 5MB limit");
      return;
    }

    setIsProcessing(true);
    setResults(null);

    try {
      const text = await file.text();
      
      // Parse CSV with proper library
      const parseResult = Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (header) => header.toLowerCase().trim()
      });

      if (parseResult.errors.length > 0) {
        console.error("CSV parsing errors:", parseResult.errors);
        toast.error("Invalid CSV format");
        setIsProcessing(false);
        return;
      }

      // Validate and extract emails
      const emailSchema = z.string().email();
      const rows = parseResult.data as Record<string, any>[];
      
      // Find email column
      const emailColumn = Object.keys(rows[0] || {}).find(key => 
        key.includes('email')
      );

      if (!emailColumn) {
        toast.error("CSV must contain an 'email' column");
        setIsProcessing(false);
        return;
      }

      // Validate and normalize emails
      const validEmails = rows
        .map(row => row[emailColumn])
        .filter(email => email)
        .map(email => {
          const normalized = String(email).trim().toLowerCase();
          const validation = emailSchema.safeParse(normalized);
          return validation.success ? validation.data : null;
        })
        .filter((email): email is string => email !== null);

      if (validEmails.length === 0) {
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
        .in("email", validEmails);

      if (fetchError) throw fetchError;

      if (!leads || leads.length === 0) {
        setResults({ matched: 0, unmatched: validEmails.length });
        toast.info("No matching emails found between EVEN and your leads");
        return;
      }

      // Prepare batch update
      const updates = leads.map(lead => ({
        id: lead.id,
        album_purchased: true,
        album_purchased_at: new Date().toISOString(),
        purchase_source: 'even'
      }));

      // Batch update using Promise.all for better performance
      const updatePromises = updates.map(update =>
        supabase
          .from("smart_link_leads")
          .update({
            album_purchased: update.album_purchased,
            album_purchased_at: update.album_purchased_at,
            purchase_source: update.purchase_source
          })
          .eq('id', update.id)
      );

      const results = await Promise.all(updatePromises);
      const errors = results.filter(r => r.error);
      
      if (errors.length > 0) {
        console.error("Update errors:", errors);
        throw new Error("Some updates failed");
      }

      const matched = updates.length;
      const unmatched = validEmails.length - matched;

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
