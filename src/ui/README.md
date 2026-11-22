# ui/

The design system: how the app looks, in one place, so every page stays consistent. Nothing here knows about
the budget's rules (it can use `core/` helpers for dates, money and colours).

## Files
- `components.tsx`: the shared building blocks: `PageHead` (page header), things that open (`Disclosure`, `Section`, `Collapse`, `DetailsToggle`, `FlatDetails`), `Modal` (Escape closes the top one only), `Dot` and `AccIcon` (colour marks), `Chevron`, `ColorPicker`, Reorder (`ReorderToggle`, `MoveButtons`, `useFlip`), `CardColumns`, `ShortList`, and `ago` ("5 min ago").
- `Icon.tsx`: `Icon`, the app's line icons by name.
- `Donut.tsx`: charts: `Donut`, `Legend` (largest first), `BarList`.
- `PartsBar.tsx`: `PartsBar`, one bar split into parts (paid, to come, put aside, spare); hover or tap a part to see its name and amount underneath. Use it for any bar of amounts, so every part can be looked at.
- `LogoMark.tsx`: the Paydays logo.
- `ErrorBoundary.tsx`: shows a message instead of a blank screen when a page fails (`isStaleBuild` spots an old cached build and offers a reload).
- `toast.ts`: `showToast`, a short note at the bottom of the screen that goes by itself.
- `theme.ts`: light, dark or follow the device, kept in this browser only (`readTheme`, `saveTheme`, `applyTheme` sets `data-theme` on `<html>`).
- `styles/`: the stylesheet: tokens, base, shared component classes and page classes (its own README).

## Watch out for
- Use the classes and tokens in `styles/` and the pieces here; don't add one-off colours, sizes or spacing in a page.
- Brand colour is for the sidebar, primary buttons and payday only. Green and red only ever mean "fine" and "short". An account's colour is only a small mark beside its name, never a whole card.
- Each screen shows the figures you came for, with the working one click away (a `Disclosure` or a pop-up).
- Page headers (`.page-head`): title (`.page-title`), then the page's buttons (`.page-actions`) or view switch, then the pay arrows (`.pay-nav-steps`), always last at the right edge so ‹ › sit in the same place on every page. On a phone the buttons get their own row, in one line. The "Today" / "Next pay" button beside the arrows is always shown, dimmed when you're already there, so nothing moves. Check by screenshotting each page's header: `npm run screenshot -- '#/debts' --width 400 --dark --only '.page-head'`.
- Figure tiles (`.trio`) are about 100px wide on a phone: keep each note under ~15 characters ("next 23 Nov", "after bills"); the full sentence goes behind Details.
- A bank `SyncPill` that's current is just its icon on a phone, so card names aren't cut off.
- A card's summary must fit a phone screen with room to spare (the owner checks on an iPhone, in dark mode):
  figures and one line per item, plus anything that needs doing. Explanations ("how this works") go behind
  Details. Put `DetailsToggle` directly above the `Collapse` it opens, so Hide details stays where it was tapped.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
