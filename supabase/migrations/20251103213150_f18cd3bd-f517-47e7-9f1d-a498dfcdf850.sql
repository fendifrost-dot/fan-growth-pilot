-- Add conversion tracking fields to smart_link_leads table
ALTER TABLE public.smart_link_leads
ADD COLUMN converted boolean DEFAULT false,
ADD COLUMN converted_at timestamp with time zone,
ADD COLUMN conversion_value numeric,
ADD COLUMN shopify_order_id text;

-- Create index for faster email lookups when processing webhooks
CREATE INDEX idx_smart_link_leads_email ON public.smart_link_leads(email);

-- Create index for conversion queries
CREATE INDEX idx_smart_link_leads_converted ON public.smart_link_leads(converted);