// 左栏线性图标（Lucide 风格 1.7 描边，取自方向 A mockup 的图标表）。颜色走 currentColor。
import type { ReactNode } from "react";

const PATHS = {
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  newChat: <><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z" /></>,
  archive: <><rect x="2.5" y="3.5" width="19" height="5" rx="1" /><path d="M4.5 8.5V19a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8.5" /><path d="M10 12.5h4" /></>,
  restore: <><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5" /><path d="M3.5 3.5v5h5" /></>,
  updown: <><path d="m7 15 5 5 5-5" /><path d="m7 9 5-5 5 5" /></>,
  down: <path d="m6 9 6 6 6-6" />,
  up: <path d="m18 15-6-6-6 6" />,
  right: <path d="m9 18 6-6-6-6" />,
  branch: <><circle cx="6" cy="5.5" r="2.2" /><circle cx="18" cy="6.5" r="2.2" /><circle cx="6" cy="18.5" r="2.2" /><path d="M6 7.7v8.6" /><path d="M18 8.7c0 4.5-6 4.3-11 6.6" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  folderOpen: <><path d="M3 18V6a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v2" /><path d="M3 18l2.4-6.5A2 2 0 0 1 7.3 10H21l-2.6 8.6a2 2 0 0 1-1.9 1.4H5a2 2 0 0 1-2-2Z" /></>,
  file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5" /></>,
  terminal: <><path d="m5 7 5 5-5 5" /><path d="M12 18h7" /></>,
  upload: <><path d="M12 15V4" /><path d="m7 9 5-5 5 5" /><path d="M5 20h14" /></>,
  download: <><path d="M12 4v11" /><path d="m7 10 5 5 5-5" /><path d="M5 20h14" /></>,
  refresh: <><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4.5V11h-6.5" /></>,
  more: <><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></>,
  check: <path d="M20 6 9 17l-5-5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  pencil: <path d="M16.9 3.1a2.8 2.8 0 1 1 4 4L7.5 20.5 3 21.5l1-4.5Z" />,
  trash: <><path d="M3.5 6h17" /><path d="M8.5 6V4h7v2" /><path d="m18.5 6-.8 13.2a2 2 0 0 1-2 1.8H8.3a2 2 0 0 1-2-1.8L5.5 6" /></>,
  move: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M8.5 13h7M12.5 10l3 3-3 3" /></>,
  eyeOff: <><path d="m3 3 18 18" /><path d="M10.6 5.1A10 10 0 0 1 12 5c7 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A17 17 0 0 0 2 12s3 7 10 7a10 10 0 0 0 5.4-1.6" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>,
  eye: <><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
  sub: <><path d="M5 4v6a4 4 0 0 0 4 4h11" /><path d="m16 10 4 4-4 4" /></>,
  close: <path d="M18 6 6 18M6 6l12 12" />,
  chat: <path d="M20 14.5a2 2 0 0 1-2 2H8l-4 3.5V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2Z" />,
  changes: <><circle cx="12" cy="12" r="3" /><path d="M3 12h6M15 12h6" /></>,
  at: <><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /></>,
  drive: <><rect x="2.5" y="4" width="19" height="16" rx="2" /><path d="M2.5 14h19" /><path d="M17 17h.01" /></>,
  home: <><path d="m3 10.5 9-7 9 7" /><path d="M5 9v11h14V9" /></>,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 8v4.5M12 16h.01" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `pw-i ${className}` : "pw-i"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

