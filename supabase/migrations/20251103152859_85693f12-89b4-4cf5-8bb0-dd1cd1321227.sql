-- Create storage bucket for smart link media
INSERT INTO storage.buckets (id, name, public) 
VALUES ('smart-links', 'smart-links', true);

-- Create storage policies for smart link media
CREATE POLICY "Anyone can view smart link media"
ON storage.objects FOR SELECT
USING (bucket_id = 'smart-links');

CREATE POLICY "Authenticated users can upload smart link media"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'smart-links' 
  AND auth.uid() IS NOT NULL
);

CREATE POLICY "Users can update their own smart link media"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'smart-links' 
  AND auth.uid() IS NOT NULL
);

CREATE POLICY "Users can delete their own smart link media"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'smart-links' 
  AND auth.uid() IS NOT NULL
);

-- Add new columns to smart_links table for enhanced customization
ALTER TABLE smart_links 
ADD COLUMN IF NOT EXISTS description text,
ADD COLUMN IF NOT EXISTS image_url text,
ADD COLUMN IF NOT EXISTS video_url text,
ADD COLUMN IF NOT EXISTS button_text text DEFAULT 'Click Here',
ADD COLUMN IF NOT EXISTS button_color text,
ADD COLUMN IF NOT EXISTS background_color text;