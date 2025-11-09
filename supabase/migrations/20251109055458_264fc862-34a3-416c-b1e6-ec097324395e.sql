-- Make smart-links storage bucket private for security
UPDATE storage.buckets 
SET public = false 
WHERE id = 'smart-links';