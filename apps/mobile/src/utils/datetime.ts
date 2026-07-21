const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

const pad = (value: number) => String(value).padStart(2, "0");

const getBeijingParts = (value: string | Date) => {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    return undefined;
  }

  const shifted = new Date(timestamp + BEIJING_OFFSET_MS);

  return {
    year: shifted.getUTCFullYear(),
    month: pad(shifted.getUTCMonth() + 1),
    day: pad(shifted.getUTCDate()),
    hour: pad(shifted.getUTCHours()),
    minute: pad(shifted.getUTCMinutes())
  };
};

export const formatBeijingDate = (value?: string | Date, fallback = "-") => {
  if (!value) {
    return fallback;
  }

  const parts = getBeijingParts(value);
  return parts ? `${parts.year}-${parts.month}-${parts.day}` : fallback;
};

export const formatBeijingDateTime = (value?: string | Date, fallback = "-") => {
  if (!value) {
    return fallback;
  }

  const parts = getBeijingParts(value);
  return parts
    ? `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
    : fallback;
};

export const formatBeijingShortDateTime = (value?: string | Date, fallback = "-") => {
  if (!value) {
    return fallback;
  }

  const parts = getBeijingParts(value);
  return parts ? `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}` : fallback;
};

export const formatBeijingMonthDay = (value?: string | Date, fallback = "-") => {
  if (!value) {
    return fallback;
  }

  const parts = getBeijingParts(value);
  return parts ? `${parts.month}-${parts.day}` : fallback;
};

export const formatBeijingTime = (value?: string | Date, fallback = "-") => {
  if (!value) {
    return fallback;
  }

  const parts = getBeijingParts(value);
  return parts ? `${parts.hour}:${parts.minute}` : fallback;
};
