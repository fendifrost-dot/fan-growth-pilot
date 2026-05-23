-- =====================================================================
-- Seed: RUNWAY MUSIC launch template + campaign
-- HTML/text adapted from artistgrowthhub-repo/campaigns/runway-music/email/*
-- with unsubscribe footer + first_name merge tag added.
-- =====================================================================

INSERT INTO public.email_templates (slug, name, subject, preheader, variables, html_body, text_body)
VALUES (
  'runway-music-launch',
  'RUNWAY MUSIC — launch email',
  'RUNWAY MUSIC',
  'Out now. Designed for me.',
  ARRAY['first_name','unsubscribe_url'],
  $HTML$<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RUNWAY MUSIC</title>
</head>
<body style="margin:0; padding:0; background:#f5f5f5; font-family:Helvetica, Arial, sans-serif;">

<!-- Preheader (hidden in body, shown in inbox preview after subject) -->
<div style="display:none; max-height:0; overflow:hidden; mso-hide:all; visibility:hidden; opacity:0; color:transparent; height:0; width:0;">
Out now. Designed for me.&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
</div>

<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5; padding:40px 15px;">
<tr>
<td align="center">

<table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; background:#ffffff;">

<tr>
<td>
<img src="https://media.fendifrost.com/runway-music/banner.jpg"
alt="Runway Music — Fendi Frost"
width="600"
style="width:100%; max-width:600px; display:block; border:0;">
</td>
</tr>

<tr>
<td style="padding:40px 35px 20px 35px; color:#111111;">

<p style="margin:0 0 25px 0; font-size:16px; line-height:1.7;">
RUNWAY MUSIC is out now.
</p>

<p style="margin:0 0 25px 0; font-size:16px; line-height:1.7;">
A project built somewhere between fashion, pressure, chaos, love, and control.
</p>

<p style="margin:0 0 35px 0; font-size:16px; line-height:1.7;">
Appreciate everybody that's been listening and living with the music already.
</p>

<table cellpadding="0" cellspacing="0" border="0">
<tr>
<td align="center" bgcolor="#111111" style="border-radius:40px;">
<a href="https://links.fendifrost.com/runway"
style="font-size:14px;
font-family:Helvetica, Arial, sans-serif;
color:#ffffff;
text-decoration:none;
padding:14px 28px;
display:inline-block;
letter-spacing:1px;">
LISTEN
</a>
</td>
</tr>
</table>

<p style="margin:50px 0 0 0; font-size:14px; color:#666666; line-height:1.6;">
Fendi Frost
</p>

</td>
</tr>

<tr>
<td style="padding:0 35px 40px 35px;">
<p style="margin:32px 0 0 0; font-size:11px; color:#999999; line-height:1.6; letter-spacing:0.04em;">
You're hearing from Fendi Frost because you opted in directly — through a smart link, an event, or a previous release.<br>
<a href="{{unsubscribe_url}}" style="color:#999999; text-decoration:underline;">Unsubscribe</a> &nbsp;·&nbsp; fendifrost.com
</p>
</td>
</tr>

</table>

</td>
</tr>
</table>

</body>
</html>$HTML$,
  $TXT$RUNWAY MUSIC is out now.

A project built somewhere between fashion, pressure, chaos, love, and control.

Listen here:
https://links.fendifrost.com/runway

Appreciate everybody that's been listening and living with the music already.

— Fendi Frost

---
You're hearing from Fendi Frost because you opted in directly.
Unsubscribe: {{unsubscribe_url}}
fendifrost.com
$TXT$
)
ON CONFLICT (slug) DO UPDATE
  SET name      = EXCLUDED.name,
      subject   = EXCLUDED.subject,
      preheader = EXCLUDED.preheader,
      html_body = EXCLUDED.html_body,
      text_body = EXCLUDED.text_body,
      variables = EXCLUDED.variables,
      updated_at = now();

-- Create or refresh the campaign row pointing at the template.
INSERT INTO public.email_campaigns (
  name, slug, template_id, from_email, from_name, reply_to, status
)
SELECT
  'RUNWAY MUSIC launch',
  'runway-music-launch',
  t.id,
  'studio@fendifrost.com',
  'Fendi Frost',
  'studio@fendifrost.com',
  'draft'
FROM public.email_templates t
WHERE t.slug = 'runway-music-launch'
ON CONFLICT (slug) DO UPDATE
  SET template_id = EXCLUDED.template_id,
      from_email  = EXCLUDED.from_email,
      from_name   = EXCLUDED.from_name,
      reply_to    = EXCLUDED.reply_to,
      updated_at  = now();
