// Resolves the "Render scale" setting to an actual pixel ratio for the
// MapLibre canvas that Three.js's custom layer shares (see game-engine.ts).
//
// The HUD is plain DOM (React over app/globals.css), so its text and icons
// are painted by the browser at the display's native resolution no matter
// what this module returns; only the 3D world underneath it, the part that
// is GPU-bound at DPR 1.25-2 on 1080p+ laptops, gets scaled.
//
// Three policies, chosen in Options > Render scale:
//  - 'crisp': render at up to the device's native pixel ratio. This is the
//    game's original, unconditional behavior, capped a little lower on
//    touch devices, whose GPUs tend to be weaker relative to their screens.
//  - 'fast': a fixed, aggressive downscale for old or integrated GPUs.
//    Independent of DPR (almost every real device reports DPR >= 1), this
//    renders at 0.75x, only sliding lower, and never below 0.6x, on a
//    device that itself reports a sub-1 pixel ratio.
//  - 'auto' (default): caps the rendered pixel *count*
//    (cssWidth * cssHeight * ratio^2) at a fixed budget instead of a fixed
//    ratio, so a modest 1080p laptop panel renders close to native while a
//    4K/5K panel at DPR 2 backs off just enough to stay affordable. Touch
//    devices get a tighter budget, since their GPUs are weaker relative to
//    their pixel counts. The result is floored at 0.75 so it never gets
//    soft enough to look blurry, and rounded to 2 decimals, which is all
//    the precision map.setPixelRatio needs and keeps repeated calls'
//    "did this actually change" comparisons stable.
export type RenderScaleSetting = 'auto' | 'crisp' | 'fast';

// Desktop (fine-pointer) and touch pixel budgets for 'auto', in device
// pixels. Chosen so a 1920x1080 desktop panel renders a little above native
// DPR 1 (there is headroom below the 2.2M budget) while a 2560x1600+ panel
// at DPR 2 backs off to the 0.75 floor.
const AUTO_BUDGET_DESKTOP = 2_200_000;
const AUTO_BUDGET_TOUCH = 1_300_000;
/** Auto favors steadier mobile frame times; Crisp remains the 1.5x override. */
const AUTO_TOUCH_CAP = 1.35;
const AUTO_FLOOR = 0.75;

const FAST_RATIO = 0.75;
const FAST_FLOOR = 0.6;

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Pure: no DOM/window access, so it is trivially unit-testable and safe to
 * call from both the initial map-creation code and a resize/settings-change
 * effect. `devicePixelRatio`, `cssWidth`, and `cssHeight` are passed in
 * rather than read here.
 */
export function resolveRenderPixelRatio(
  setting: RenderScaleSetting,
  devicePixelRatio: number,
  coarsePointer: boolean,
  cssWidth: number,
  cssHeight: number,
): number {
  const dpr =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  const crispCap = coarsePointer ? 1.5 : 2;

  if (setting === 'crisp') return round2(Math.min(dpr, crispCap));

  if (setting === 'fast') {
    return round2(Math.max(FAST_FLOOR, FAST_RATIO * Math.min(dpr, 1)));
  }

  // 'auto': sqrt(budget / area) is the ratio at which cssWidth * ratio by
  // cssHeight * ratio hits the pixel budget exactly; below the device's own
  // cap and DPR, above it, this is the tightest constraint.
  const area = cssWidth > 0 && cssHeight > 0 ? cssWidth * cssHeight : 0;
  const budget = coarsePointer ? AUTO_BUDGET_TOUCH : AUTO_BUDGET_DESKTOP;
  const budgetCap = area > 0 ? Math.sqrt(budget / area) : crispCap;
  const autoQualityCap = coarsePointer ? AUTO_TOUCH_CAP : crispCap;
  return round2(Math.max(AUTO_FLOOR, Math.min(dpr, autoQualityCap, budgetCap)));
}
