import type { Locale } from "./types";

/** 语言菜单需要的元数据（不含文案），首屏只带这一小份。 */
export interface LocaleOption {
  id: Locale;
  label: string;
}

/** 内置语言的稳定顺序；与 messages/*.ts 的 id、label 一致（registry.test 锁定）。 */
export const LOCALE_OPTIONS: readonly LocaleOption[] = [
  { id: "en", label: "English" },
  { id: "zh-CN", label: "简体中文" },
  { id: "zh-TW", label: "繁體中文" },
];

/** 判断任意值是否为内置语言标识。 */
export function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "zh-CN" || value === "zh-TW";
}

/**
 * 将浏览器语言列表解析为 Pi Web 内置语言。
 * @param languages 浏览器按优先级排列的语言列表
 * @returns 匹配的内置语言，无法匹配时返回英语
 */
export function resolveBrowserLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const normalized = language.toLowerCase();
    if (normalized === "en" || normalized.startsWith("en-")) return "en";
    if (normalized === "zh" || normalized === "zh-cn" || normalized.startsWith("zh-cn-")
      || normalized === "zh-sg" || normalized.startsWith("zh-sg-")
      || normalized === "zh-hans" || normalized.startsWith("zh-hans-")) return "zh-CN";
    if (normalized === "zh-tw" || normalized.startsWith("zh-tw-")
      || normalized === "zh-hk" || normalized.startsWith("zh-hk-")
      || normalized === "zh-mo" || normalized.startsWith("zh-mo-")
      || normalized === "zh-hant" || normalized.startsWith("zh-hant-")) return "zh-TW";
    if (normalized.startsWith("zh-")) return "zh-CN";
  }
  return "en";
}

/**
 * 按需加载某个语言的文案（P30）：每种语言一个独立 chunk，只在用到时下载。
 * 英语是默认语言和缺失兜底，由 useI18n 静态带上，这里也能取到（同一模块，不重复下载）。
 */
export function loadLocaleMessages(locale: Locale): Promise<Record<string, string>> {
  switch (locale) {
    case "zh-CN":
      return import("./messages/zh-CN").then((mod) => mod.zhCNLocale.messages);
    case "zh-TW":
      return import("./messages/zh-TW").then((mod) => mod.zhTWLocale.messages);
    default:
      return import("./messages/en").then((mod) => mod.enLocale.messages);
  }
}
