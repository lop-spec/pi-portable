import { enLocale } from "./messages/en";
import { zhCNLocale } from "./messages/zh-CN";
import { zhTWLocale } from "./messages/zh-TW";
import type { LocalePlugin } from "./types";

const localePlugins: LocalePlugin[] = [enLocale, zhCNLocale, zhTWLocale];

/**
 * 根据标识获取已注册的语言包。
 * @param id 要查询的语言标识
 * @returns 已注册的语言包，不存在时返回 undefined
 */
export function getLocalePlugin(id: string): LocalePlugin | undefined {
  return localePlugins.find((plugin) => plugin.id === id);
}

/** 获取当前已注册语言的稳定顺序列表。 */
export function getSupportedLocales(): string[] {
  return localePlugins.map((plugin) => plugin.id);
}

// 浏览器语言解析与语言元数据在 ./locales（轻量，客户端首屏用它）；这里保留同步的完整注册表，
// 供服务端与测试使用。客户端不要引用本文件，否则三套文案会全部打进首屏（P30）。
export { resolveBrowserLocale } from "./locales";
