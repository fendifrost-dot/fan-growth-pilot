-- Create table for smart link leads
CREATE TABLE public.smart_link_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  smart_link_id UUID NOT NULL REFERENCES public.smart_links(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Enable RLS
ALTER TABLE public.smart_link_leads ENABLE ROW LEVEL SECURITY;

-- Allow anyone to insert leads (for public smart links)
CREATE POLICY "Anyone can submit leads"
ON public.smart_link_leads
FOR INSERT
TO anon, authenticated
WITH CHECK (true);

-- Users can view leads for their own smart links
CREATE POLICY "Users can view leads for their smart links"
ON public.smart_link_leads
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.smart_links
    WHERE smart_links.id = smart_link_leads.smart_link_id
    AND smart_links.user_id = auth.uid()
  )
);

-- Create index for better query performance
CREATE INDEX idx_smart_link_leads_link_id ON public.smart_link_leads(smart_link_id);
CREATE INDEX idx_smart_link_leads_created_at ON public.smart_link_leads(created_at DESC);