# Integrate Inner Circle CTA on SmartLinkPage

**Target file (fan-growth-pilot / Lovable):** `src/pages/SmartLinkPage.tsx`

**New files (already in this repo for GitHub → Lovable sync):**

- `src/lib/innerCircle.ts`
- `src/components/InnerCircleSubscribeButton.tsx`

## 1. Import

Add near the top of `SmartLinkPage.tsx`:

```tsx
import { InnerCircleSubscribeButton } from "@/components/InnerCircleSubscribeButton";
import { shouldShowInnerCircleCta } from "@/lib/innerCircle";
```

## 2. Flag (after `const meta = ...`)

```tsx
const showInnerCircle = shouldShowInnerCircleCta(slug, meta);
```

## 3. Shared block (after `emailAccordionBlock` definition)

```tsx
const innerCircleBlock = showInnerCircle ? (
  <InnerCircleSubscribeButton
    slug={smartLink.slug}
    email={hasSubmittedEmail ? email : undefined}
  />
) : null;
```

## 4. Insert in both layouts

**Runway theme** — inside the hero `space-y-4` column, after primary CTA / `dspButtonsBlock`, before `{emailAccordionBlock}`:

```tsx
{hasDspLinks ? dspButtonsBlock : ( /* album button */ )}
{innerCircleBlock}
{emailAccordionBlock}
```

**Default theme** — same order in the bottom hero `space-y-4` stack:

```tsx
{hasDspLinks ? dspButtonsBlock : ( /* album button */ )}
{innerCircleBlock}
{emailAccordionBlock}
```

## 5. Enable on a smart link

**Option A — slug:** use slug `inner-circle` (always shows CTA).

**Option B — any slug:** set metadata in DB:

```json
{ "inner_circle_enabled": true }
```

## 6. Optional Meta pixel on click

Inside `InnerCircleSubscribeButton`, pass `onClick` from SmartLinkPage if you want tracking:

```tsx
onClick={() => firePixel('InnerCircleClick', { smart_link_slug: smartLink.slug })}
```

(Only if `firePixel` is in scope in that file.)
