/** Bounds and default for the assistant response font size preference (px). */
export const RESPONSE_FONT_SIZE_MIN = 12;
export const RESPONSE_FONT_SIZE_MAX = 20;
export const RESPONSE_FONT_SIZE_DEFAULT = 14;

/**
 * Clamp any stored/user-entered value to a whole-pixel size in the supported
 * range. Non-numeric or non-finite input falls back to the default so a
 * corrupted settings payload can never break rendering.
 */
export function normalizeResponseFontSize(value) {
  const size = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : RESPONSE_FONT_SIZE_DEFAULT;
  return Math.min(RESPONSE_FONT_SIZE_MAX, Math.max(RESPONSE_FONT_SIZE_MIN, size));
}
