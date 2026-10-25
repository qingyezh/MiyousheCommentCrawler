/**
 * 解析时区偏移配置。
 * 合法值：UTC / utc / UTC+0 ~ UTC+23（也接受 +8 / 8 / utc+08）
 * 非法值一律回落为 UTC（0 小时）。
 * 返回小时数，范围 0..23。
 */
export function parseTimezoneOffset(raw: unknown): { hours: number; label: string; valid: boolean } {
  if (raw == null || raw === '') {
    return { hours: 0, label: 'UTC', valid: true };
  }

  const s = String(raw).trim();
  if (!s) return { hours: 0, label: 'UTC', valid: true };

  const lower = s.toLowerCase().replace(/\s+/g, '');

  // UTC / utc
  if (lower === 'utc' || lower === 'gmt') {
    return { hours: 0, label: 'UTC', valid: true };
  }

  // UTC+8 / utc+08 / +8 / 8
  const m = lower.match(/^(?:utc|gmt)?([+-]?)(\d{1,2})$/);
  if (m) {
    const sign = m[1] === '-' ? -1 : 1;
    const n = Number(m[2]);
    // 仅允许 UTC / UTC+0..23；负号视为非法 → UTC
    if (m[1] === '-') {
      return { hours: 0, label: 'UTC', valid: false };
    }
    if (Number.isInteger(n) && n >= 0 && n <= 23) {
      const label = n === 0 ? 'UTC' : `UTC+${n}`;
      return { hours: n, label, valid: true };
    }
  }

  return { hours: 0, label: 'UTC', valid: false };
}

export function formatDateInOffset(date: Date, offsetHours: number): string {
  const shifted = new Date(date.getTime() + offsetHours * 3_600_000);
  // 用 UTC 字段拼本地墙钟，避免系统时区干扰
  const y = shifted.getUTCFullYear();
  const mo = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

export function formatTimeInOffset(date: Date, offsetHours: number, withMs = true): string {
  const shifted = new Date(date.getTime() + offsetHours * 3_600_000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const hm = `${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}`;
  if (!withMs) return hm;
  return `${hm}.${p(shifted.getUTCMilliseconds(), 3)}`;
}

export function offsetLabel(hours: number): string {
  if (hours === 0) return 'UTC';
  return `UTC+${hours}`;
}
