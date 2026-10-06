// Line icons for the conversation timeline (Lucide geometry, 24 grid, currentColor).
// Size comes from CSS (.pw-i / parent rules); every icon is decorative (aria-hidden).
import type { ReactNode } from "react";

function Icon({ children, className, strokeWidth = 1.8 }: { children: ReactNode; className?: string; strokeWidth?: number }) {
  return (
    <svg className={["pw-i", className].filter(Boolean).join(" ")} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const ChevronRightIcon = ({ className }: { className?: string }) => <Icon className={className} strokeWidth={2}><path d="m9 6 6 6-6 6" /></Icon>;
export const ChevronDownIcon = ({ className }: { className?: string }) => <Icon className={className} strokeWidth={2}><path d="m6 9 6 6 6-6" /></Icon>;
export const AlertTriangleIcon = ({ className }: { className?: string }) => <Icon className={className}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></Icon>;
export const AlertCircleIcon = ({ className }: { className?: string }) => <Icon className={className}><circle cx="12" cy="12" r="9" /><path d="M12 8v4" /><path d="M12 16h.01" /></Icon>;
export const CheckCircleIcon = ({ className }: { className?: string }) => <Icon className={className}><circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.5 2.5 4.5-5" /></Icon>;
export const XCircleIcon = ({ className }: { className?: string }) => <Icon className={className}><circle cx="12" cy="12" r="9" /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></Icon>;
export const StopCircleIcon = ({ className }: { className?: string }) => <Icon className={className}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5h5v5h-5z" /></Icon>;
export const CopyIcon = ({ className }: { className?: string }) => <Icon className={className}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></Icon>;
export const CheckIcon = ({ className }: { className?: string }) => <Icon className={className} strokeWidth={2}><path d="M20 6 9 17l-5-5" /></Icon>;
export const PencilIcon = ({ className }: { className?: string }) => <Icon className={className}><path d="M17 3a2.85 2.85 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /><path d="m15 5 4 4" /></Icon>;
export const ForkIcon = ({ className }: { className?: string }) => <Icon className={className}><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="12" cy="18" r="2.5" /><path d="M6 8.5v1a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-1" /><path d="M12 12.5v3" /></Icon>;
export const SwapIcon = ({ className }: { className?: string }) => <Icon className={className}><path d="m16 3 4 4-4 4" /><path d="M20 7H4" /><path d="m8 21-4-4 4-4" /><path d="M4 17h16" /></Icon>;
export const CompressIcon = ({ className }: { className?: string }) => <Icon className={className}><path d="m4 14 6 0 0 6" /><path d="m20 10-6 0 0-6" /><path d="m14 10 7-7" /><path d="m3 21 7-7" /></Icon>;
export const ListIcon = ({ className }: { className?: string }) => <Icon className={className}><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" /></Icon>;
export const ArrowDownIcon = ({ className }: { className?: string }) => <Icon className={className} strokeWidth={2}><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></Icon>;
export const FilePenIcon = ({ className }: { className?: string }) => <Icon className={className}><path d="M12.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v9.5" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M13.4 12.6a2 2 0 1 1 3 3L11 21l-4 1 1-4Z" /></Icon>;
