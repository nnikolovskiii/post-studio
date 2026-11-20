// Phone or desktop view (Phase 8). The device decides unless he picked one; the pick is kept in
// localStorage and `?view=phone|desktop` sets it from a link.
import { chooseView, isPhoneLike, VIEW_KEY, type DeviceInfo, type ViewMode } from "../model/phone.ts";

export function currentDevice(): DeviceInfo {
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const shortSide = Math.min(screen.width || innerWidth, screen.height || innerHeight, Math.max(innerWidth, 1));
  return { coarse, shortSide };
}

export const deviceIsPhoneLike = () => isPhoneLike(currentDevice());

function stored(): string | null {
  try {
    return localStorage.getItem(VIEW_KEY);
  } catch {
    return null;
  }
}

export function remember(mode: ViewMode) {
  try {
    localStorage.setItem(VIEW_KEY, mode);
  } catch {
    /* private mode: the choice lasts for this page only */
  }
}

/** The view for this page load; drops `?view=` from the address once it is remembered. */
export function initialView(): ViewMode {
  const params = new URLSearchParams(location.search);
  const r = chooseView(params.get("view"), stored(), currentDevice());
  if (r.remember) {
    remember(r.remember);
    params.delete("view");
    const q = params.toString();
    history.replaceState(null, "", location.pathname + (q ? `?${q}` : "") + location.hash);
  }
  return r.mode;
}
