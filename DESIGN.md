---
name: aemdev.org
description: The AEM Global Developer Collective — practitioner knowledge, community energy
colors:
  aem-red: "#eb1000"
  aem-red-deep: "#c50e00"
  carbon: "#0e0e0e"
  carbon-mid: "#1b1b1b"
  carbon-surface: "#272727"
  slate: "#6b7280"
  slate-dark: "#4b5563"
  surface: "#f4f4f4"
  body-text: "#1f1f1f"
  muted-text: "#6b7280"
  border-light: "#d1d5db"
  off-white: "#f9f9f9"
typography:
  display:
    fontFamily: "'Barlow Condensed', 'Automate OT', 'Arial Narrow', sans-serif"
    fontSize: "clamp(2.4rem, 5vw, 3.6rem)"
    fontWeight: 800
    lineHeight: 1.05
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "'Barlow Condensed', 'Automate OT', 'Arial Narrow', sans-serif"
    fontSize: "clamp(1.6rem, 3vw, 2.2rem)"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "-0.01em"
  title:
    fontFamily: "'Inter', system-ui, sans-serif"
    fontSize: "clamp(1.1rem, 2vw, 1.4rem)"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  body:
    fontFamily: "'Inter', system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "0"
  label:
    fontFamily: "'Space Mono', menlo, monospace"
    fontSize: "0.82rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0.05em"
rounded:
  none: "0"
  sm: "2px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "32px"
  xl: "64px"
  section-desktop: "64px"
  section-tablet: "48px"
  section-mobile: "32px"
components:
  button-primary:
    backgroundColor: "{colors.aem-red}"
    textColor: "{colors.off-white}"
    rounded: "{rounded.none}"
    padding: "12px 28px"
  button-primary-hover:
    backgroundColor: "{colors.aem-red-deep}"
    textColor: "{colors.off-white}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.aem-red}"
    rounded: "{rounded.none}"
    padding: "11px 27px"
  button-secondary-hover:
    backgroundColor: "{colors.aem-red}"
    textColor: "{colors.off-white}"
  card:
    backgroundColor: "{colors.off-white}"
    textColor: "{colors.body-text}"
    rounded: "{rounded.none}"
    padding: "{spacing.lg}"
---

# Design System: aemdev.org

## 1. Overview

**Creative North Star: "The Builder's Signal"**

aemdev.org is the signal in the noise for AEM practitioners — a community-built hub that feels like it was made by people who actually ship AEM, not by a marketing team with a style guide. The visual system carries that through: high contrast, no decoration for its own sake, and typography that announces itself without apologizing. Adobe Red earns its place as the one alert color in an otherwise disciplined palette of carbon and cool gray.

The register is **committed**: Adobe Red is not a token that appears once in a hero. It is the signal color — CTAs, active states, tags, code accents, the bar that says "this is AEM." Against near-black carbon backgrounds it reads with maximum force. Against light gray surfaces it carries the same decisiveness without shouting.

References: Linear.app's blog (clean, high-craft, dark-capable), Changelog.com (dense, community-first, content-respecting), developer.adobe.com (AEM-adjacent utility). The anti-reference is adobe.com's marketing layer: this site is by practitioners for practitioners, and every design decision reinforces that.

**Key Characteristics:**
- Carbon ground + Adobe Red accent + Inter/Bebas Neue pairing
- Sharp edges everywhere — no border-radius except `2px` on chips/tags
- Bebas Neue for display headings: condensed, all-caps, high signal-to-noise
- Inter for body and subheadings: humanist, readable at density
- Space Mono for code, labels, and eyebrows: precision, not decoration
- Dark-capable by default: hero sections and navigation sit on carbon
- Community photography is a layout element, not a background treatment

## 2. Colors: The Carbon + Signal Palette

One dominant accent against a carbon-and-gray ground. Red carries the signal; everything else defers.

### Primary
- **Adobe Red** (`#eb1000`): The signal color. CTAs, active links, tag accents, code block borders, category labels. Never decorative — only where action or identity is implied.
- **Adobe Red Deep** (`#c50e00`): Hover and pressed state for any Adobe Red surface. 1:1 swap on interaction.

### Neutral (dark)
- **Carbon** (`#0e0e0e`): Primary dark background. Header, hero sections, dark-variant sections. Near-black with no blue cast.
- **Carbon Mid** (`#1b1b1b`): Secondary dark surface. Cards on dark sections, nav dropdowns.
- **Carbon Surface** (`#272727`): Dark borders, hairlines, dividers on dark backgrounds.

### Neutral (light)
- **Surface** (`#f4f4f4`): Default page background. Clean, neutral gray — no warm cream carry-over from OpsInventor.
- **Off-White** (`#f9f9f9`): Card backgrounds on light sections. Fractionally warmer than #fff.
- **Body Text** (`#1f1f1f`): Primary text on light backgrounds. Near-black, high contrast.
- **Muted Text / Slate** (`#6b7280`): Dates, authors, secondary metadata. Low-priority signal.
- **Border Light** (`#d1d5db`): Dividers and borders on light surfaces.

### Named Rules
**The One Signal Rule.** Adobe Red appears on ≤40% of any given screen's accent surface. It signals action or identity — not atmosphere. A screen covered in red has no signal.

**The No-Cream Rule.** The OpsInventor warm-cream surface (`#f5efe7`) is prohibited. aemdev.org surfaces are cool gray (`#f4f4f4`) or near-black (`#0e0e0e`). Nothing in between reads as ambiguous.

## 3. Typography: Condensed Impact + Humanist Body

**Display / H1–H2:** Barlow Condensed (Google Fonts), fallback chain: "Automate OT", "Arial Narrow", sans-serif
**Body / H3–H6:** Inter, fallback: system-ui, "Helvetica Neue", sans-serif
**Code / Labels / Eyebrows:** Space Mono, fallback: menlo, consolas, monospace

**Character:** Barlow Condensed brings high-weight, condensed display energy — H1 at 800, H2 at 700, both mixed-case. It reads fast, lands hard, and never shouts. Inter at body size carries the practitioner voice: legible, slightly warm, trustworthy. Space Mono grounds every code block and label in precision.

### Hierarchy
- **Display** (Barlow Condensed 800, clamp(2.4rem → 3.6rem), line-height 1.05, tracking -0.01em): H1 headings, hero titles. Mixed-case; the weight and condensed form carry the impact without all-caps.
- **Headline** (Barlow Condensed 700, clamp(1.6rem → 2.2rem), line-height 1.05, tracking -0.01em): H2 section headings. One weight step lighter than Display; same condensed stack.
- **Title** (Inter 700, clamp(1.1rem → 1.4rem), line-height 1.25, tracking -0.01em): H3 subheadings, card titles. Mixed-case. This is the practitioner's voice at its most readable.
- **Body** (Inter 400, 1rem, line-height 1.6): Article text, descriptions, nav copy. 65–72ch max line length in article contexts.
- **Label / Eyebrow** (Space Mono 400, 0.82rem, tracking 0.05em, uppercase): Category tags, dates, author bylines, eyebrow labels. These are metadata — not emphasis.

### Named Rules
**The Weight Hierarchy Rule.** Barlow Condensed appears at two weights only: 800 for H1, 700 for H2. Do not use lighter weights or apply it below H2 — Inter carries everything below that level.

**The Mono Discipline Rule.** Space Mono is reserved for code, metadata labels, and `pre` blocks. It never appears in article body text or navigation. Three mono-set elements on one screen is the ceiling.

## 4. Elevation

Flat by default. Depth is signaled by color surface, not shadow. A carbon card on a carbon-mid section reads as elevated because of the surface contrast, not a drop shadow. Shadows are used only for interactive affordance (e.g. a card that is also a link gets a subtle shadow on `:hover`).

### Shadow Vocabulary
- **Hover lift** (`0 4px 16px rgba(0,0,0,0.18)`): Applied on card `:hover` and interactive tile `:hover` states only. Not present at rest.
- **No ambient shadows.** Ambient box-shadow on non-interactive containers is prohibited. If a surface needs visual separation, use a border or a background-color step.

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat at rest. Shadow appears only as interaction feedback. If you are reaching for a shadow to define a container's boundary, use a `1px solid` border instead.

## 5. Components

### Buttons
- **Shape:** Sharp-edged (border-radius: 0). No rounding on any button.
- **Primary:** Adobe Red background (`#eb1000`), off-white text, 2px solid border in same red. Uppercase text, Space Mono, 0.82rem, tracking 0.14em.
- **Primary Hover:** Background shifts to Adobe Red Deep (`#c50e00`); border follows. 0.15s ease transition.
- **Secondary / Ghost:** Transparent background, 2px solid Adobe Red border, Adobe Red text. On hover: fills to Adobe Red, text flips to off-white.
- **Dark-surface variant:** On carbon backgrounds, primary buttons remain Adobe Red. Ghost buttons use a white border and white text (no red — contrast against dark ground is handled by the border).
- **Padding:** 12–14px vertical, 22–28px horizontal. Font via mono stack.

### Cards / Feed Items
- **Corner Style:** Square (border-radius: 0).
- **Background:** Off-white (`#f9f9f9`) on light sections; Carbon Mid (`#1b1b1b`) on dark sections.
- **Border:** `1px solid #d1d5db` on light; `1px solid #272727` on dark.
- **Shadow:** None at rest; hover lift `0 4px 16px rgba(0,0,0,0.18)`.
- **Internal Padding:** 24–32px.
- **Tag/Category:** Space Mono 0.74rem, uppercase, Adobe Red, displayed above the title.
- **Title:** Inter 700 or Bebas Neue 400 (card context dependent).
- **Meta (date, author):** Space Mono, Muted Text (`#6b7280`), tracking 0.05em.

### Navigation
- **Background:** Carbon (`#0e0e0e`). Always dark regardless of page section.
- **Text:** Off-white (`#f9f9f9`) at rest; Adobe Red on active/hover.
- **Typography:** Inter 500, 0.92rem, no uppercase transform on nav links.
- **Active state:** Adobe Red text + 2px bottom border in Adobe Red.
- **Mobile:** Full-width drawer on carbon background; same type treatment.

### Article Hero (Designed, not photo-dependent)
Community events have photography. Technical articles may not. For text-only heroes:
- **Background:** Carbon (`#0e0e0e`) with a typographic treatment — large Bebas Neue headline at 5–7rem, category label in Adobe Red above it, publication date in Space Mono below.
- **No stock photography.** If there is no photo, the design earns its visual weight through type alone.
- For event recaps with photography: full-bleed image with a carbon gradient scrim from bottom. Headline overlaid at bottom-left. Never center the text on a photographic hero.

### Event / Meetup Photo Gallery
Community photos are featured, not buried. Use a masonry or 3-column grid layout. Photos maintain aspect ratio; no forced crops that cut off faces. Caption below each photo in Space Mono, Muted Text.

### Chips / Tags
- **Background:** Transparent with `1px solid #d1d5db` at rest; Adobe Red border + Adobe Red text on active/selected.
- **Shape:** 2px radius (only exception to the sharp-edge rule — pill shapes are explicitly prohibited).
- **Typography:** Space Mono, 0.74rem, uppercase.

### Code Blocks
- **Background:** `#08101a` (deep navy-black, darker than carbon).
- **Left accent stripe:** `4px solid #eb1000` (Adobe Red).
- **Text:** `#e8eef2` (cool near-white).
- **Font:** Space Mono, 0.86rem.

### Inline Code
- **Background tint:** `rgba(235, 16, 0, 0.08)` — red tint, very subtle.
- **Border:** `1px solid rgba(235, 16, 0, 0.25)`.
- **Text:** Adobe Red Deep (`#c50e00`).

## 6. Do's and Don'ts

### Do:
- **Do** use Adobe Red for CTAs, active states, and category labels — and only for those. It is the signal; use it where you need attention.
- **Do** use Carbon (`#0e0e0e`) for hero sections, the header, and any dark-surface section. The dark ground is what makes Adobe Red read.
- **Do** feature community event photography at full editorial scale — full-bleed or large-panel. These photos prove the community is real.
- **Do** design article heroes with type when photos are unavailable. A large Bebas Neue headline on carbon is a legitimate hero, not a fallback.
- **Do** keep buttons sharp-edged (border-radius: 0). Rounding is not part of this system.
- **Do** use Space Mono for dates, author bylines, category labels, code. Its precision anchors the technical register.
- **Do** write descriptive `alt` text for every community event photo — people, context, event name. Not just "photo."

### Don't:
- **Don't** use Adobe.com's marketing aesthetic — polished gradients, stock photography, hero copy that sounds like a product launch, or any "Transform your digital experience" register. This site is by practitioners for practitioners.
- **Don't** use the warm cream surface (`#f5efe7`) from OpsInventor or any warm-tinted neutral. aemdev.org surfaces are cool: carbon or light gray.
- **Don't** add border-radius greater than `2px` to any interactive element. No pill buttons, no large rounded cards.
- **Don't** use glassmorphism, frosted panels, or gradient overlays as design elements. Flat surfaces only.
- **Don't** put Adobe Red on more than 40% of any screen's accent surface. A page dominated by red has no signal.
- **Don't** apply `text-transform: uppercase` to Bebas Neue — it is already uppercase. Apply it only to Inter-set label text.
- **Don't** use Bebas Neue for body text, navigation, or H3–H6. It is a display font, not a UI font.
- **Don't** center headline text on top of a full-bleed photograph without a contrast scrim. Place text on a carbon surface or apply a gradient scrim behind it.
- **Don't** hide or minimize event photography. If you have photos from a meetup, feature them prominently — the community's face is part of the brand.
