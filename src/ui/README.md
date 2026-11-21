# ui/

The design system: how the app looks, in one place, so every page stays consistent. Nothing here knows about
the budget's rules (it can use `core/` helpers for dates, money and colours).

## Files
- `components.tsx`: the shared building blocks: `PageHead` (page header), things that open (`Disclosure`, `Section`, `Collapse`, `DetailsToggle`, `FlatDetails`), `Modal` (Escape closes the top one only), `Dot` and `AccIcon` (colour marks), `Chevron`, `ColorPicker`, Reorder (`ReorderToggle`, `MoveButtons`, `useFlip`), `CardColumns`, `ShortList`, and `ago` ("5 min ago").
- `Icon.tsx`: `Icon`, the app's line icons by name.
- `Donut.tsx`: charts: `Donut`, `Legend` (largest first), `BarList`.
- `LogoMark.tsx`: the Paydays logo.
- `ErrorBoundary.tsx`: shows a message instead of a blank screen when a page fails (`isStaleBuild` spots an old cached build and offers a reload).
- `toast.ts`: `showToast`, a short note at the bottom of the screen that goes by itself.
- `theme.ts`: light, dark or follow the device, kept in this browser only (`readTheme`, `saveTheme`, `applyTheme` sets `data-theme` on `<html>`).
- `styles/`: the stylesheet: tokens, base, shared component classes and page classes (its own README).

## Watch out for
- Use the classes and tokens in `styles/` and the pieces here; don't add one-off colours, sizes or spacing in a page.
- Brand colour is for the sidebar, primary buttons and payday only. Green and red only ever mean "fine" and "short". An account's colour is only a small mark beside its name, never a whole card.
- Each screen shows the figures you came for, with the working one click away (a `Disclosure` or a pop-up).

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
