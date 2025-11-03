-- Add album_purchased field to track EVEN album purchases
ALTER TABLE smart_link_leads 
ADD COLUMN IF NOT EXISTS album_purchased boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS album_purchased_at timestamp with time zone,
ADD COLUMN IF NOT EXISTS purchase_source text; -- 'shopify', 'even', or null

-- Add index for faster filtering (only if not exists)
CREATE INDEX IF NOT EXISTS idx_smart_link_leads_album_purchased ON smart_link_leads(album_purchased);

-- Comment for clarity
COMMENT ON COLUMN smart_link_leads.album_purchased IS 'Track if user purchased album on EVEN';
COMMENT ON COLUMN smart_link_leads.purchase_source IS 'Source of purchase: shopify, even, or null';