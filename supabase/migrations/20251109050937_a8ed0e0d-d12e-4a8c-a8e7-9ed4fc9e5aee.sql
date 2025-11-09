-- Add new fields to smart_links table for enhanced landing pages
ALTER TABLE smart_links
ADD COLUMN IF NOT EXISTS headline text,
ADD COLUMN IF NOT EXISTS subheadline text,
ADD COLUMN IF NOT EXISTS video_autoplay boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS show_email_form boolean DEFAULT true,
ADD COLUMN IF NOT EXISTS bullet_point_1 text,
ADD COLUMN IF NOT EXISTS bullet_point_2 text,
ADD COLUMN IF NOT EXISTS bullet_point_3 text,
ADD COLUMN IF NOT EXISTS testimonial_text text,
ADD COLUMN IF NOT EXISTS testimonial_author text,
ADD COLUMN IF NOT EXISTS theme_preset text DEFAULT 'default';