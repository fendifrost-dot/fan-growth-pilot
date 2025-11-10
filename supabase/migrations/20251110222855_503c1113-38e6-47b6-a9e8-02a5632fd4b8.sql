-- Fix 1: Add unique constraint to prevent duplicate email submissions per smart link
ALTER TABLE smart_link_leads 
ADD CONSTRAINT unique_email_per_link 
UNIQUE (smart_link_id, email);

-- Fix 2: Update storage bucket policies to be user-scoped

-- Drop existing overly permissive policies
DROP POLICY IF EXISTS "Authenticated users can upload files" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update files" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can delete files" ON storage.objects;

-- Upload: User can only upload to their own folder
CREATE POLICY "Users can upload to own folder"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'smart-links'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Update: User can only update their own files
CREATE POLICY "Users can update own files"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'smart-links'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Delete: User can only delete their own files
CREATE POLICY "Users can delete own files"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'smart-links'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Read: Keep public read for active smart links
CREATE POLICY "Public can read files"
ON storage.objects FOR SELECT
USING (bucket_id = 'smart-links');