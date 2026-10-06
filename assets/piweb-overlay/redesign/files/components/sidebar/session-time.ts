// 会话列表的日期分组与时间显示（方向 A spec §2.4）。纯函数，按本地时区计算。

export type DayGroupKey = "today" | "yesterday" | "week" | "older";

export const DAY_GROUP_LABELS: Record<DayGroupKey, string> = {
  today: "今天",
  yesterday: "昨天",
  week: "近 7 天",
  older: "更早",
};

const DAY_GROUP_ORDER: DayGroupKey[] = ["today", "yesterday", "week", "older"];

/** 本地日期的稳定键（YYYY-M-D）；跨午夜、改系统时间后会变。 */
export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** 距下一个本地午夜还有多久（毫秒，多留 250ms 余量，至少 1 秒，避免定时器略早触发时空转）。夏令时按本地日历算。 */
export function msUntilNextLocalMidnight(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  return Math.max(1000, next - now.getTime() + 250);
}

function localDayStart(date: Date, offsetDays = 0): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offsetDays).getTime();
}

function parse(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 今天 / 昨天 / 近 7 天（含今天往前 6 天）/ 更早；未来时间算今天，无效时间算更早。 */
export function dayGroupOf(iso: string, now: Date): DayGroupKey {
  const date = parse(iso);
  if (!date) return "older";
  const time = date.getTime();
  if (time >= localDayStart(now)) return "today";
  if (time >= localDayStart(now, -1)) return "yesterday";
  if (time >= localDayStart(now, -6)) return "week";
  return "older";
}

export interface DayGroup<T> {
  key: DayGroupKey;
  label: string;
  items: T[];
}

/** 按日期分组，组顺序固定、空组不返回；组内保持输入顺序。 */
export function groupSessionsByDay<T>(items: readonly T[], getModified: (item: T) => string, now: Date): DayGroup<T>[] {
  const buckets = new Map<DayGroupKey, T[]>();
  for (const item of items) {
    const key = dayGroupOf(getModified(item), now);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  return DAY_GROUP_ORDER
    .filter((key) => buckets.has(key))
    .map((key) => ({ key, label: DAY_GROUP_LABELS[key], items: buckets.get(key)! }));
}

const pad2 = (value: number) => String(value).padStart(2, "0");

/** 行尾时间：今天/昨天 HH:mm；更早 M月D日；跨年 YYYY/M/D。 */
export function formatSessionTime(iso: string, now: Date): string {
  const date = parse(iso);
  if (!date) return "";
  const group = dayGroupOf(iso, now);
  if (group === "today" || group === "yesterday") return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (date.getFullYear() !== now.getFullYear()) return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 悬停提示与菜单头部用的本地完整时间：10月2日 18:00（跨年带年份）。 */
export function formatSessionDateTime(iso: string, now: Date): string {
  const date = parse(iso);
  if (!date) return "";
  const day = `${date.getMonth() + 1}月${date.getDate()}日`;
  const prefix = date.getFullYear() !== now.getFullYear() ? `${date.getFullYear()}年` : "";
  return `${prefix}${day} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 菜单头部的短日期：M月D日（跨年 YYYY/M/D）。 */
export function formatSessionDate(iso: string, now: Date): string {
  const date = parse(iso);
  if (!date) return "";
  if (date.getFullYear() !== now.getFullYear()) return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}
