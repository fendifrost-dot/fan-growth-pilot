-- Add short_code column to smart_links table for ultra-short URLs
ALTER TABLE smart_links 
ADD COLUMN short_code text UNIQUE;

-- Add index for faster lookups
CREATE INDEX idx_smart_links_short_code ON smart_links(short_code);

-- Function to generate random short code
CREATE OR REPLACE FUNCTION generate_short_code()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  characters text := 'abcdefghijklmnopqrstuvwxyz0123456789';
  result text := '';
  i integer;
BEGIN
  FOR i IN 1..6 LOOP
    result := result || substr(characters, floor(random() * length(characters) + 1)::integer, 1);
  END LOOP;
  RETURN result;
END;
$$;