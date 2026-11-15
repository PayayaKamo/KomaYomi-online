/**
 * Tiny i18n runtime.
 *
 * Design notes:
 * - The current locale lives in module state so plain modules (`api.ts`, `pngExport.ts`,
 *   `lib/geometry.ts`) can translate without a React hook.
 * - React components subscribe through `useI18n()`, which re-renders on locale changes.
 * - Messages are flat `area.key` maps; `MessageKey` is derived from the English file.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { en } from './en';
import { zh } from './zh';
import { ja } from './ja';

export type Locale = 'en' | 'zh' | 'ja';
export type MessageKey = keyof typeof en;

/** BCP 47 tags handed to `Intl` and `document.documentElement.lang`. */
const INTL_LOCALE: Record<Locale, string> = {
  en: 'en-US',
  zh: 'zh-CN',
  ja: 'ja-JP',
};

const LOCALE_STORAGE_KEY = 'komayomi.locale';

const RESOURCES: Record<Locale, Record<MessageKey, string>> = { en, zh, ja };

function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'zh' || value === 'ja';
}

/** Persisted choice wins; otherwise follow the browser language. */
function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    /* storage may be unavailable in hardened contexts */
  }
  const nav = typeof navigator === 'undefined' ? '' : navigator.language.toLowerCase();
  if (nav.startsWith('zh')) return 'zh';
  if (nav.startsWith('ja')) return 'ja';
  return 'en';
}

let currentLocale: Locale = detectLocale();

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getLocaleSnapshot(): Locale {
  return currentLocale;
}

/** Reflect the locale on <html> so fonts, `:lang` rules and screen readers follow it. */
function applyDocumentLang(locale: Locale): void {
  if (typeof document !== 'undefined') document.documentElement.lang = INTL_LOCALE[locale];
}

applyDocumentLang(currentLocale);

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(next: Locale): void {
  if (!isLocale(next) || next === currentLocale) return;
  currentLocale = next;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, next);
  } catch {
    /* ignore quota/privacy errors */
  }
  applyDocumentLang(next);
  emit();
}

const warnedKeys = new Set<string>();

/**
 * Translate a message key. Missing keys warn once and render as `⟦key⟧` so the gap is
 * impossible to miss during development instead of silently showing the raw key.
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template: string | undefined = RESOURCES[currentLocale]?.[key] ?? en[key];
  if (template === undefined) {
    if (!warnedKeys.has(key)) {
      warnedKeys.add(key);
      console.warn(`[i18n] Missing message key: ${key}`);
    }
    return `⟦${key}⟧`;
  }
  if (!params) return template;
  // Unknown placeholders are left untouched on purpose (e.g. the template hint that
  // documents `{volume}`); only supplied parameters are substituted.
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

const dateFormats = new Map<Locale, Intl.DateTimeFormat>();
const numberFormats = new Map<Locale, Intl.NumberFormat>();

function dateFormatter(): Intl.DateTimeFormat {
  let formatter = dateFormats.get(currentLocale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(INTL_LOCALE[currentLocale], {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    dateFormats.set(currentLocale, formatter);
  }
  return formatter;
}

function numberFormatter(): Intl.NumberFormat {
  let formatter = numberFormats.get(currentLocale);
  if (!formatter) {
    formatter = new Intl.NumberFormat(INTL_LOCALE[currentLocale]);
    numberFormats.set(currentLocale, formatter);
  }
  return formatter;
}

/** Locale-aware date + time, used for note timestamps. Invalid input renders empty. */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return dateFormatter().format(date);
}

export function formatNumber(n: number): string {
  return numberFormatter().format(n);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, n);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const formatted = new Intl.NumberFormat(INTL_LOCALE[currentLocale], {
    maximumFractionDigits: unit === 0 ? 0 : value < 10 ? 1 : 0,
  }).format(value);
  return `${formatted} ${units[unit]}`;
}

const LANG_KEYS: Record<string, MessageKey> = {
  ja: 'lang.ja',
  zh: 'lang.zh',
  en: 'lang.en',
};

const READING_KEYS: Record<string, MessageKey> = {
  rtl: 'reading.rtl',
  ltr: 'reading.ltr',
  ttb: 'reading.ttb',
  'horizontal-rl': 'reading.horizontalRl',
  'horizontal-lr': 'reading.horizontalLr',
  'vertical-rl': 'reading.verticalRl',
  'vertical-lr': 'reading.verticalLr',
};

/** Localized language name; unknown values pass through unchanged. */
export function langLabel(lang: string): string {
  const key = LANG_KEYS[lang];
  return key ? t(key) : lang;
}

/** Localized reading-direction label; unknown values pass through unchanged. */
export function readingLabel(direction: string): string {
  const key = READING_KEYS[direction];
  return key ? t(key) : direction;
}

export function useI18n() {
  const locale = useSyncExternalStore(subscribe, getLocaleSnapshot, getLocaleSnapshot);
  return useMemo(() => ({ t, locale, setLocale, formatDate, formatNumber, formatBytes }), [locale]);
}
