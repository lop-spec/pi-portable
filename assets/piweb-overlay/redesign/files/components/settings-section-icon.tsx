// 设置分区图标：侧栏底栏（AppShell，首屏）和设置面板（懒加载 chunk）共用。
// 单独成文件，AppShell 引用它时不会把整个 SettingsPanel 拖回首屏 chunk（P27）。
import type { SettingsSection } from "@/lib/settings-navigation";

// .settings-section-icon 的规则在 settings.css（随设置面板懒加载），首屏的侧栏底栏用不到那份样式，
// 所以不收缩 / 子代理放大这两条直接写在元素上。
const ICON_STYLE = { flexShrink: 0 } as const;
const AGENT_ICON_STYLE = { flexShrink: 0, transform: "scale(1.25)" } as const;

export function SettingsSectionIcon({ section, size = 16, strokeWidth = 1.8 }: { section: SettingsSection; size?: number; strokeWidth?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className: "settings-section-icon",
    style: ICON_STYLE,
  };

  if (section === "general") return <svg {...common}><path d="M20 7h-9M14 17H5" /><circle cx="7" cy="7" r="3" /><circle cx="17" cy="17" r="3" /></svg>;
  if (section === "models") return <svg {...common}><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 15h3M1 9h3M1 15h3" /></svg>;
  if (section === "skills") return <svg {...common}><path d="m12 2-10 5 10 5 10-5-10-5Z" /><path d="m2 12 10 5 10-5M2 17l10 5 10-5" /></svg>;
  if (section === "agents") return <svg {...common} className="settings-section-icon is-agent" style={AGENT_ICON_STYLE}><rect x="5" y="7" width="14" height="11" rx="2" /><path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" /></svg>;
  return <svg {...common}><path d="M9 7V2M15 7V2M6 13V8a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v5a6 6 0 0 1-12 0ZM12 19v3" /></svg>;
}
