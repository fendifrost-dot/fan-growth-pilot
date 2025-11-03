-- Add background_image_url column to smart_links table
ALTER TABLE smart_links ADD COLUMN IF NOT EXISTS background_image_url TEXT;