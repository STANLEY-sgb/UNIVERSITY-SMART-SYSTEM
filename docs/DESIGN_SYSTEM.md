# KIU-USCAS — UI Design System

**Update 2026-11-16:** the page background is now the supplied geometric artwork (violet, magenta, plum, teal, aqua, cyan, lime, sun yellow; colours sampled from the image) drawn as two vector SVGs (`packages/ui/src/backdrop-portrait.svg` and `backdrop-landscape.svg`, chosen by aspect ratio). Content sits on a frosted near-white panel (88 % white, blurred) so body text never lies on the vivid colours; contrast is unit-tested against the panel over every artwork colour. Sidebar is plum with a sun-yellow active item, primary buttons are teal, tiles and avatars aqua, the student ID card a violet-to-plum gradient. Yellow is now an accent only, no longer a page background.

Visual direction (original): the supplied yellow / black / pink / purple / green neo-brutalist mobile interface (**the screenshot itself is not in the repository** — tokens below come from the master prompts; re-validate against it and against any approved KIU branding when supplied). Colours are *proposed*, not official KIU brand colours.

Translate the grammar into a serious university SaaS: bold outlines and hard shadows for chrome and cards; calm, dense, readable tables for data. No cartoon treatment of access logs.

## Tokens (`packages/design-tokens`, Phase 5)

```css
:root {
  --violet:#A700E8; --magenta:#CF00D2; --plum:#5B0079; --teal:#07C8C7; --aqua:#24E6CB; --cyan:#07E6F7; --lime:#B9F641; --sun:#F4E101;
  --yellow:#F4E101; --ink:#111111; --pink:#CF00D2; --purple:#A700E8; --green:#54D84A;
  --canvas:#FFFDF8; --surface:#FFFFFF; --muted:#F4F2EC; --text:#111111; --text-2:#626262;
  --grant:#1E8E3E; --deny:#D92D20; --warn:#B7791F; --info:#6D4AE0;      /* AA on white; never colour alone */
  --border:2px solid var(--ink);
  --radius-card:16px; --radius-btn:12px; --radius-input:10px;
  --shadow:5px 6px 0 var(--ink); --shadow-lg:8px 8px 0 var(--ink);
}
```

Decorative pink/green are accents only. **Status colours are separate** (a distinct accessible red for DENY; green for GRANT; amber pending/offline; purple informational) and always paired with an icon + word.

## Typography
Headings: Plus Jakarta Sans (bold, tight, deliberate line-height). Body/data: Inter. Table text ≥ 14px, 1.5 line-height.

## Components
| Component | Spec |
|---|---|
| Card | white/cream, 2px ink border, 12–20px radius, 4–6px hard offset shadow, hover lifts 1–2px, focus ring |
| Button | primary teal, secondary white, utility/destructive ink; hover, pressed (shadow collapses), disabled, visible 3px focus ring; ≥44×44px target |
| Status chip | icon + text: GRANT ✓ green · DENY ✕ red · PENDING/OFFLINE ◷ amber · INFO purple |
| Table | sticky header, sortable, filter bar, pagination; <640px → stacked row cards |
| Result panel (reader) | full-bleed GRANT/DENY, reason text, photo only as permitted, beep, 3 s door animation; never shows biometric scores |
| Icons | Lucide, one stroke weight; custom line illustrations for services |
| Motion | 120–240 ms, restrained spring on cards, `prefers-reduced-motion` fallback; never delay a decision for decoration |

## Responsive contract

| Viewport | Behaviour |
|---|---|
| <640 | bottom nav (wallet), drawer (admin), single column, full-width QR, camera-first scanner, stacked panels |
| 640–1023 | two-column cards, collapsible sidebar, tables scroll or compact rows |
| 1024–1439 | persistent collapsible sidebar, 12-col grid, reader split view |
| ≥1440 | constrained max-width, 3–4 col overview, wider live panels, no stretched text |

Verify at 360, 390, 768, 1024, 1280, 1440. Safe-area insets, landscape, 200% zoom, keyboard navigation, semantic headings, screen-reader labels, WCAG AA contrast. Playwright visual + axe checks in Phase 9.

## Reader face-scan UI (BIO §22)
Segmented control **SCAN QR | VIRTUAL TAP | SCAN FACE**. Face screen: responsive live camera, elliptical guide, lighting/liveness hints, privacy notice, permission state, progress, retry, “use another method”. No scores or other students' identities on screen.

## 3D / illustration language
Isometric 2.5D SVG scenes with layered cards, ambient shadows and animated connector lines (see ARCHITECTURE §10). Optional React Three Fiber map with static fallback. Dark and light backgrounds.
