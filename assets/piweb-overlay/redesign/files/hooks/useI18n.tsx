"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { isLocale, LOCALE_OPTIONS, loadLocaleMessages, resolveBrowserLocale, type LocaleOption } from "@/lib/i18n/locales";
import { enLocale } from "@/lib/i18n/messages/en";
import { translateMessage } from "@/lib/i18n/format";
import type { Locale, TranslationParams } from "@/lib/i18n/types";

const LOCALE_STORAGE_KEY = "pi-locale";
const defaultLocale: Locale = "en";

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: TranslationParams) => string;
  supportedLocales: readonly LocaleOption[];
}

const I18nContext = createContext<I18nContextValue | null>(null);

type MessagesByLocale = Partial<Record<Locale, Record<string, string>>>;

// 语言包按需加载（P30）：首屏只静态带英语（默认语言与缺失兜底），其余语言各自一个 chunk，
// 同一语言整页只下载一次。
const loadedMessages: MessagesByLocale = { en: enLocale.messages };
const pendingMessages = new Map<Locale, Promise<Record<string, string>>>();

function ensureMessages(locale: Locale): Promise<Record<string, string>> {
  const ready = loadedMessages[locale];
  if (ready) return Promise.resolve(ready);
  let pending = pendingMessages.get(locale);
  if (!pending) {
    pending = loadLocaleMessages(locale).then((messages) => {
      loadedMessages[locale] = messages;
      return messages;
    });
    pending.catch(() => pendingMessages.delete(locale));
    pendingMessages.set(locale, pending);
  }
  return pending;
}

function readInitialLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // 隐私模式或存储不可用时继续使用浏览器语言。
  }
  return resolveBrowserLocale(window.navigator.languages.length ? window.navigator.languages : [window.navigator.language]);
}

// 水合期间就开始拉当前语言的文案，从英文 SSR 切到用户语言的时间尽量短。
if (typeof window !== "undefined") {
  try {
    const initial = readInitialLocale();
    if (initial !== defaultLocale) void ensureMessages(initial).catch(() => undefined);
  } catch {
    // 预取失败不影响首屏；Provider 挂载后会再试一次并记录原因。
  }
}

/**
 * 提供 Pi Web 的界面语言状态和翻译能力。
 * @param props React 子节点
 * @returns 包含语言上下文的 React 节点
 */
export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(defaultLocale);
  const [hydrated, setHydrated] = useState(false);
  const [messages, setMessages] = useState<MessagesByLocale>(() => ({ en: enLocale.messages }));
  // 最后一次请求的语言：快速连续切换时，先发出的慢请求回来也不会把界面切回去。
  const requestedRef = useRef<Locale>(defaultLocale);

  const switchTo = useCallback((next: Locale) => {
    requestedRef.current = next;
    const commit = (loaded: Record<string, string>) => {
      if (requestedRef.current !== next) return;
      setMessages((current) => (current[next] === loaded ? current : { ...current, [next]: loaded }));
      setLocaleState(next);
      document.documentElement.lang = next;
    };
    const ready = loadedMessages[next];
    if (ready) {
      commit(ready);
      return;
    }
    ensureMessages(next).then(commit, (error: unknown) => {
      // 降级：语言包下载失败时保持英文，记录原因（可观察性）。
      console.warn(`[i18n] failed to load locale ${next}, staying on ${defaultLocale}:`, error);
    });
  }, []);

  useEffect(() => {
    switchTo(readInitialLocale());
    setHydrated(true);
  }, [switchTo]);

  const setLocale = useCallback((next: Locale) => {
    if (!isLocale(next)) return;
    switchTo(next);
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // 存储失败不影响当前页面内的语言切换。
    }
  }, [switchTo]);

  const t = useCallback((key: string, params?: TranslationParams) => translateMessage(locale, key, messages as Record<string, Record<string, string>>, params), [locale, messages]);
  const value = useMemo(() => ({ locale: hydrated ? locale : defaultLocale, setLocale, t, supportedLocales: LOCALE_OPTIONS }), [hydrated, locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * 获取当前组件树中的国际化能力。
 * @returns 当前 locale、翻译函数、语言切换函数和支持的语言列表
 * @throws 当组件不在 I18nProvider 内时抛出异常
 */
export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider");
  return context;
}
