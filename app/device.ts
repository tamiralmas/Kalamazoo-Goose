// Phones and tablets have a coarse *primary* pointer with no hover. Touchscreen
// laptops and desktops with a precision touchpad match `(any-pointer: coarse)`
// as well, so that query must never be used to decide the touch layout or the
// reduced mobile rendering budgets: it hid the desktop HUD and halved the
// physics tick on ordinary Windows laptops.
export const TOUCH_DEVICE_QUERY = '(pointer: coarse)';

export const isTouchDevice = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia(TOUCH_DEVICE_QUERY).matches;
