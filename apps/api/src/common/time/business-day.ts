const pad = (value: number) => String(value).padStart(2, "0");

const readNumberEnv = (name: string, fallback: number, validate: (value: number) => boolean) => {
  const configured = Number(process.env[name] ?? fallback);
  return Number.isFinite(configured) && validate(configured) ? configured : fallback;
};

export const getBusinessTimezoneOffsetHours = () =>
  readNumberEnv("BUSINESS_TIMEZONE_OFFSET_HOURS", 8, (value) => value >= -12 && value <= 14);

export const getBusinessDayStartHour = () =>
  readNumberEnv("BUSINESS_DAY_START_HOUR", 4, (value) => Number.isInteger(value) && value >= 0 && value <= 23);

export const getLocalDateParts = (value: string | Date) => {
  const date = value instanceof Date ? value : new Date(value);
  const timezoneOffsetHours = getBusinessTimezoneOffsetHours();
  const shifted = new Date(date.getTime() + timezoneOffsetHours * 60 * 60_000);

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay()
  };
};

export const toDateKey = (value: string | Date) => {
  const parts = getLocalDateParts(value);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
};

export const addDaysToDateKey = (dateKey: string, amount: number) => {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return date.toISOString().slice(0, 10);
};

export const getWeekdayForDateKey = (dateKey: string) => {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
};

export const getBusinessDayKey = (value: string | Date = new Date()) => {
  const date = value instanceof Date ? value : new Date(value);
  const timezoneOffsetHours = getBusinessTimezoneOffsetHours();
  const businessDayStartHour = getBusinessDayStartHour();
  const shifted = new Date(
    date.getTime() + timezoneOffsetHours * 60 * 60_000 - businessDayStartHour * 60 * 60_000
  );
  return shifted.toISOString().slice(0, 10);
};

export const isSameBusinessDay = (left: string | Date, right: string | Date) =>
  getBusinessDayKey(left) === getBusinessDayKey(right);
