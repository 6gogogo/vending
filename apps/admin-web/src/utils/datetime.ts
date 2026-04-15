const BEIJING_TIMEZONE = "Asia/Shanghai";

const createFormatter = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: BEIJING_TIMEZONE,
    ...options
  });

const dateFormatter = createFormatter({
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

const dateTimeFormatter = createFormatter({
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

const dateTimeSecondsFormatter = createFormatter({
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
});

const formatParts = (
  value: string | Date,
  formatter: Intl.DateTimeFormat
) => {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const parts = formatter.formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";

  if (formatter === dateFormatter) {
    return `${read("year")}-${read("month")}-${read("day")}`;
  }

  const withSeconds = formatter === dateTimeSecondsFormatter;
  const time = withSeconds
    ? `${read("hour")}:${read("minute")}:${read("second")}`
    : `${read("hour")}:${read("minute")}`;

  return `${read("year")}-${read("month")}-${read("day")} ${time}`;
};

export const formatDate = (value?: string | Date) =>
  value ? formatParts(value, dateFormatter) || "-" : "-";

export const formatDateTime = (value?: string | Date) =>
  value ? formatParts(value, dateTimeFormatter) || "-" : "-";

export const formatDateTimeSeconds = (value?: string | Date) =>
  value ? formatParts(value, dateTimeSecondsFormatter) || "-" : "-";

export const getTodayDateKeyInBeijing = () => formatDate(new Date());

export const formatNowInBeijing = () => formatDateTimeSeconds(new Date());
