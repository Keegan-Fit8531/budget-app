# ui/styles/

The whole stylesheet, imported once by `src/main.tsx` through `index.css`. Plain CSS, no framework.

## Files
- `index.css`: imports the four files below, in order. Order matters: later files build on earlier ones.
- `tokens.css`: the design tokens: colours (light, dark from the device, and dark chosen in Settings), the palette (`--pal-*`), type sizes, spacing, corner radii, shadows. The design system's rules are written at its top.
- `base.css`: element defaults, text styles, layout helpers (`.row`, `.stack`, `.between`, gaps), and the app shell (sidebar, phone top and bottom bars).
- `components.css`: shared classes: page header and pay nav, cards and card grids, buttons, the segmented control, figures and stats, dots and pills, messages, lists, bars, forms, pop-ups, tooltips, charts, things that open, toasts.
- `pages.css`: classes used by one page: account cards (Accounts and the Planner's split), the bill check pop-up, the Planner, Savings, Insights, the Add menu.

## Watch out for
- New colours or sizes go in `tokens.css` as tokens (with a dark value too), never as raw values in a class.
- A class used by one page goes in `pages.css` under that page's heading; once two pages use it, move it to `components.css`.
- Each file is split into sections by `/* ---------- Name ---------- */` headings. Add new rules to the right section.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
