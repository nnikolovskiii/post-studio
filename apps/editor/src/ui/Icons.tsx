// Small inline SVG icons (16 px, stroke = currentColor). The UI must not depend on emoji or
// symbol fonts being installed: the canvas and the chrome look the same on every machine.
import type { ReactNode } from "react";

const P: Record<string, ReactNode> = {
  select: <path d="M3 2l9.5 6.2-4.3.9 2.4 4.6-1.6.8-2.4-4.6L3.5 13z" fill="currentColor" stroke="none" />,
  text: <path d="M3 3.5h10M8 3.5v9.5M6 13h4" />,
  rect: <rect x="2.5" y="4" width="11" height="8" rx="0.5" />,
  ellipse: <ellipse cx="8" cy="8" rx="5.5" ry="5" />,
  line: <path d="M3 13L13 3" />,
  hand: <path d="M5.5 8.5V4a1 1 0 0 1 2 0v3.5V3a1 1 0 0 1 2 0v4.5V4a1 1 0 0 1 2 0v5.5c0 2.5-1.6 4-4 4-1.6 0-2.6-.8-3.4-2L2.8 9a1 1 0 0 1 1.6-1.1l1.1 1.1" />,
  image: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <circle cx="6" cy="6.5" r="1.2" />
      <path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3" />
    </>
  ),
  svg: <path d="M8 2.5l1.6 3.6 3.9.4-2.9 2.6.8 3.9L8 11l-3.4 2 .8-3.9L2.5 6.5l3.9-.4z" />,
  undo: <path d="M5 4L2.5 6.5 5 9M2.5 6.5h7a3.5 3.5 0 0 1 0 7H7" />,
  redo: <path d="M11 4l2.5 2.5L11 9M13.5 6.5h-7a3.5 3.5 0 0 0 0 7H9" />,
  caretDown: <path d="M4 6l4 4 4-4" />,
  caretRight: <path d="M6 4l4 4-4 4" />,
  pin: <path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5" />,
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>
  ),
  unlock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 4.8-1" />
    </>
  ),
  eye: (
    <>
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  eyeOff: <path d="M2.5 2.5l11 11M6.4 4C6.9 3.7 7.4 3.5 8 3.5c4.1 0 6.5 4.5 6.5 4.5a12 12 0 0 1-1.6 2.2M10.2 10.6A2 2 0 0 1 6.6 7.4M4.2 5.2C2.6 6.4 1.5 8 1.5 8S3.9 12.5 8 12.5c1 0 1.9-.3 2.7-.7" />,
  objLeft: <path d="M2.5 2v12M5 4.5h8v2.5H5zM5 9h5v2.5H5z" />,
  objHCenter: <path d="M8 2v12M3.5 4.5h9v2.5h-9zM5 9h6v2.5H5z" />,
  objRight: <path d="M13.5 2v12M3 4.5h8v2.5H3zM6 9h5v2.5H6z" />,
  objTop: <path d="M2 2.5h12M4.5 5v8h2.5V5zM9 5v5h2.5V5z" />,
  objVCenter: <path d="M2 8h12M4.5 3.5v9h2.5v-9zM9 5v6h2.5V5z" />,
  objBottom: <path d="M2 13.5h12M4.5 3v8h2.5V3zM9 6v5h2.5V6z" />,
  distH: <path d="M2.5 2v12M13.5 2v12M6.5 4.5h3v7h-3z" />,
  distV: <path d="M2 2.5h12M2 13.5h12M4.5 6.5v3h7v-3z" />,
  alignLeft: <path d="M2.5 3.5h11M2.5 6.5h7M2.5 9.5h11M2.5 12.5h7" />,
  alignCenter: <path d="M2.5 3.5h11M4.5 6.5h7M2.5 9.5h11M4.5 12.5h7" />,
  alignRight: <path d="M2.5 3.5h11M6.5 6.5h7M2.5 9.5h11M6.5 12.5h7" />,
  agent: (
    <>
      <rect x="3" y="5" width="10" height="8" rx="2" />
      <path d="M8 2.5V5M6 9h.01M10 9h.01M1.5 8.5v2M14.5 8.5v2" />
    </>
  ),
  logo: (
    <>
      <rect x="2" y="2" width="12" height="12" rx="1.5" />
      <path d="M2 10.5h12M6 2v8.5" />
    </>
  ),
  back: <path d="M10 3.5L5.5 8l4.5 4.5" />,
  restore: <path d="M3 8a5 5 0 1 0 1.5-3.5M3 2.5v2.5h2.5" />,
  clearStyle: <path d="M4 3.5h8M8 3.5L6.5 12.5M3 13.5l9-9" />,
  minus: <path d="M3.5 8h9" />,
  plus: <path d="M3.5 8h9M8 3.5v9" />,
  arrowRight: <path d="M3 8h9.5M9 4.5L12.5 8 9 11.5" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  point: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" />
    </>
  ),
  check: <path d="M3 8.5l3.2 3L13 4.5" />,
  revert: <path d="M6 3.5L3 6.5l3 3M3 6.5h6.5a3.5 3.5 0 0 1 0 7H8" />,
  // Motion transport (timeline strip)
  play: <path d="M5 3.5v9l7-4.5z" fill="currentColor" />,
  pause: <path d="M5.5 3.5v9M10.5 3.5v9" strokeWidth="2.2" />,
  toStart: <path d="M4 3.5v9M12 3.5v9L6 8z" fill="currentColor" />,
  frameBack: <path d="M12 3.5v9M10 3.5v9L4 8z" fill="currentColor" />,
  frameFwd: <path d="M4 3.5v9M6 3.5v9L12 8z" fill="currentColor" />,
  more: (
    <>
      <circle cx="3.5" cy="8" r="1" fill="currentColor" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1" fill="currentColor" />
    </>
  ),
  caretUp: <path d="M4 10l4-4 4 4" />,
  video: (
    <>
      <rect x="1.5" y="4" width="9" height="8" rx="1" />
      <path d="M10.5 7l4-2.5v7l-4-2.5" />
    </>
  ),
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 16, title }: { name: IconName; size?: number; title?: string }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title ? <title>{title}</title> : null}
      {P[name]}
    </svg>
  );
}
