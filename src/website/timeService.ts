/**
 * Time service — returns the current time.
 * Currently uses the system clock; can be swapped for a public API later.
 */

export interface TimeResponse {
  timezone: string;
  datetime: string;
  unix_timestamp: number;
  utc_offset: string;
  label: string;
}

export function getCurrentTime(): TimeResponse {
  const now = new Date();
  const offsetMinutes = now.getTimezoneOffset();
  const sign = offsetMinutes <= 0 ? "+" : "-";
  const absHours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, "0");
  const absMins = String(Math.abs(offsetMinutes) % 60).padStart(2, "0");
  const utcOffset = `${sign}${absHours}:${absMins}`;

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return {
    timezone,
    datetime: now.toISOString(),
    unix_timestamp: Math.floor(now.getTime() / 1000),
    utc_offset: utcOffset,
    label: "TIME",
  };
}
