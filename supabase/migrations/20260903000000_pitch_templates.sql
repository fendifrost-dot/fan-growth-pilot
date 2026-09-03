-- Pitch email templates: wording lives in the database so operators can edit
-- subject/body without a code change or edge-function redeploy.
-- Seeded with the existing per-tone envelopes from pitch-templates.ts so
-- behaviour is unchanged on deploy. Do not invent new copy here.

create table if not exists public.pitch_templates (
  id uuid primary key default gen_random_uuid(),
  tone text not null check (tone in ('warm_personal', 'casual_friendly', 'business_formal', 'hyped_energetic')),
  channel text not null default 'email',
  is_warm boolean not null default false,
  subject_template text not null,
  body_template text not null,
  is_active boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (tone, channel, is_warm)
);

create index if not exists pitch_templates_active_idx
  on public.pitch_templates (tone, channel, is_warm)
  where is_active;

comment on table public.pitch_templates is
  'Editable curator-pitch envelopes. Placeholders: {{curator_name}}, {{playlist_name}}, {{track_name}}, {{pitch}}, {{stream_link}}, {{artist_name}}, {{prior_track}}.';

alter table public.pitch_templates enable row level security;

drop policy if exists "Authenticated read pitch_templates" on public.pitch_templates;
create policy "Authenticated read pitch_templates"
  on public.pitch_templates for select to authenticated using (true);

-- Existing wording, moved out of source. is_warm distinguishes cold vs follow-up.
insert into public.pitch_templates (tone, channel, is_warm, subject_template, body_template)
values
  (
    'warm_personal', 'email', false,
    'Submission for {{playlist_name}}: {{artist_name}} — {{track_name}}',
    $body$Hi {{curator_name}},

I'd love to submit **{{track_name}}** for *{{playlist_name}}*.

{{pitch}}

{{stream_link}}
Happy to share extra context or a different mix if useful.
Thank you for your time.

— {{artist_name}}$body$
  ),
  (
    'warm_personal', 'email', true,
    'Thanks for the {{prior_track}} add — new release for {{playlist_name}}',
    $body$Hi {{curator_name}},

Thank you for adding **{{prior_track}}** to *{{playlist_name}}* — meant a lot.

I just released **{{track_name}}** — {{pitch}} Feels like it lives in the same lane as what landed last time.

{{stream_link}}

No pressure if it's not the right fit. Wanted to share it with you first either way.

— {{artist_name}}$body$
  ),
  (
    'casual_friendly', 'email', false,
    '{{track_name}} for {{playlist_name}} — would love your ear',
    $body$Hey {{curator_name}},

Hope your week's been good. Wanted to share my new song — **{{track_name}}** — for *{{playlist_name}}*.

{{pitch}}

{{stream_link}}

Appreciate you taking a listen.

— {{artist_name}}$body$
  ),
  (
    'casual_friendly', 'email', true,
    'Round 2 — new song for {{playlist_name}}',
    $body$Hey {{curator_name}},

Quick note — thanks again for the **{{prior_track}}** add on *{{playlist_name}}*. Really appreciated.

Just dropped **{{track_name}}** — {{pitch}} Wanted to put it in front of you before anyone else.

{{stream_link}}

Hope you dig it.

— {{artist_name}}$body$
  ),
  (
    'business_formal', 'email', false,
    'Pitch: {{artist_name}} — {{track_name}} for {{playlist_name}}',
    $body$Hello {{curator_name}},

I'd like to submit **{{track_name}}** by {{artist_name}} for consideration in *{{playlist_name}}*.

{{pitch}}

{{stream_link}}

Thank you for your time and consideration.

Regards,
{{artist_name}}$body$
  ),
  (
    'business_formal', 'email', true,
    'Follow-up: new release from {{artist_name}} for {{playlist_name}}',
    $body$Hello {{curator_name}},

Following up on **{{prior_track}}**, which you added to *{{playlist_name}}* — thank you again for that placement.

I'd like to share my latest release, **{{track_name}}**, for your consideration. {{pitch}}

{{stream_link}}

Thank you for your continued support.

Regards,
{{artist_name}}$body$
  ),
  (
    'hyped_energetic', 'email', false,
    'New heat: {{artist_name}} — {{track_name}}',
    $body$Yo {{curator_name}},

Got something I think is perfect for *{{playlist_name}}*: **{{track_name}}**.

{{pitch}}

{{stream_link}}

Run it back, let me know what you think.

— {{artist_name}}$body$
  ),
  (
    'hyped_energetic', 'email', true,
    'Back with another one for {{playlist_name}}',
    $body$Yo {{curator_name}},

Massive thanks for the **{{prior_track}}** add — that played a real part in the wave.

Got the next one: **{{track_name}}**. {{pitch}} Honestly think it might hit even harder for *{{playlist_name}}*.

{{stream_link}}

Lemme know.

— {{artist_name}}$body$
  )
on conflict (tone, channel, is_warm) do nothing;
