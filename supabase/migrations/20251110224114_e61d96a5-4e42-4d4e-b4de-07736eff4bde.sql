-- Add UPDATE policy for smart_link_leads to enable CSV upload feature
-- Users can only update leads associated with their own smart links

CREATE POLICY "Users can update leads for own smart links"
ON smart_link_leads FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM smart_links
    WHERE smart_links.id = smart_link_leads.smart_link_id
    AND smart_links.user_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM smart_links
    WHERE smart_links.id = smart_link_leads.smart_link_id
    AND smart_links.user_id = auth.uid()
  )
);