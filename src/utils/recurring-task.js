const DEFAULT_TIME_ZONE = "Asia/Ho_Chi_Minh";

function getLocalParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
}

function zonedDateTimeToUtc(
  { year, month, day, hour = 0, minute = 0, second = 0 },
  timeZone
) {
  let candidate = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second)
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = getLocalParts(candidate, timeZone);
    const localAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );
    const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    candidate = new Date(candidate.getTime() + desiredAsUtc - localAsUtc);
  }

  return candidate;
}

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function dateOnlyParts(timestamp) {
  const date = new Date(timestamp);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

export function validateRepeatConfig(repeat) {
  if (repeat == null) {
    return { valid: true, value: null };
  }

  if (typeof repeat !== "object" || Array.isArray(repeat)) {
    return { valid: false, message: "repeat phải là một object." };
  }

  const enabled = repeat.enabled;
  if (typeof enabled !== "boolean") {
    return { valid: false, message: "repeat.enabled phải là true hoặc false." };
  }

  if (!enabled) {
    return { valid: true, value: { enabled: false } };
  }

  const frequency = repeat.frequency;
  if (!["daily", "weekly", "monthly"].includes(frequency)) {
    return {
      valid: false,
      message: "repeat.frequency phải là daily, weekly hoặc monthly.",
    };
  }

  const interval =
    repeat.interval === undefined ? 1 : repeat.interval;
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) {
    return {
      valid: false,
      message: "repeat.interval phải là số nguyên từ 1 đến 365.",
    };
  }

  let weekdays = repeat.weekdays ?? [];
  if (
    frequency === "weekly" &&
    (!Array.isArray(weekdays) ||
      weekdays.length === 0 ||
      weekdays.length > 7 ||
      weekdays.some(
        (weekday) => !Number.isInteger(weekday) || weekday < 0 || weekday > 6
      ) ||
      new Set(weekdays).size !== weekdays.length)
  ) {
    return {
      valid: false,
      message: "repeat.weekdays phải chứa các thứ duy nhất từ 0 đến 6.",
    };
  }

  if (frequency !== "weekly") weekdays = [];
  weekdays = [...weekdays].sort((a, b) => a - b);

  const endType =
    repeat.endType === undefined ? "never" : repeat.endType;
  if (!["never", "onDate", "afterOccurrences"].includes(endType)) {
    return {
      valid: false,
      message:
        "repeat.endType phải là never, onDate hoặc afterOccurrences.",
    };
  }

  let endDate = null;
  if (endType === "onDate") {
    if (
      typeof repeat.endDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(repeat.endDate)
    ) {
      return {
        valid: false,
        message: "repeat.endDate phải có định dạng YYYY-MM-DD.",
      };
    }
    const [year, month, day] = repeat.endDate.split("-").map(Number);
    if (
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > daysInMonth(year, month - 1)
    ) {
      return { valid: false, message: "repeat.endDate không hợp lệ." };
    }
    endDate = repeat.endDate;
  }

  let maxOccurrences = null;
  if (endType === "afterOccurrences") {
    maxOccurrences =
      repeat.maxOccurrences === undefined ? null : repeat.maxOccurrences;
    if (
      !Number.isInteger(maxOccurrences) ||
      maxOccurrences < 1 ||
      maxOccurrences > 3650
    ) {
      return {
        valid: false,
        message:
          "repeat.maxOccurrences phải là số nguyên từ 1 đến 3650.",
      };
    }
  }

  const timeZone =
    repeat.timeZone === undefined ? DEFAULT_TIME_ZONE : repeat.timeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    return { valid: false, message: "repeat.timeZone không hợp lệ." };
  }

  return {
    valid: true,
    value: {
      enabled: true,
      frequency,
      interval,
      weekdays,
      anchorDate:
        typeof repeat.anchorDate === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(repeat.anchorDate)
          ? repeat.anchorDate
          : null,
      anchorDay:
        Number.isInteger(repeat.anchorDay) &&
        repeat.anchorDay >= 1 &&
        repeat.anchorDay <= 31
          ? repeat.anchorDay
          : null,
      endType,
      endDate,
      maxOccurrences,
      timeZone,
    },
  };
}

export function calculateNextDueDate(currentDueDate, repeat) {
  if (!currentDueDate || !repeat?.enabled) return null;

  const timeZone = repeat.timeZone || DEFAULT_TIME_ZONE;
  const current = getLocalParts(new Date(currentDueDate), timeZone);
  const currentDate = Date.UTC(current.year, current.month - 1, current.day);
  let nextDate;

  if (repeat.frequency === "daily") {
    nextDate = Date.UTC(
      current.year,
      current.month - 1,
      current.day + repeat.interval
    );
  } else if (repeat.frequency === "weekly") {
    const selected = [...repeat.weekdays].sort((a, b) => a - b);
    const [anchorYear, anchorMonth, anchorDay] = (
      repeat.anchorDate || formatLocalDate(currentDueDate, timeZone)
    )
      .split("-")
      .map(Number);
    const anchorDate = Date.UTC(anchorYear, anchorMonth - 1, anchorDay);
    const anchorWeekStart =
      anchorDate - new Date(anchorDate).getUTCDay() * 86_400_000;

    for (let distance = 1; distance <= repeat.interval * 7 + 7; distance += 1) {
      const candidateDate = currentDate + distance * 86_400_000;
      const candidateWeekday = new Date(candidateDate).getUTCDay();
      const weekIndex = Math.floor(
        (candidateDate - anchorWeekStart) / (7 * 86_400_000)
      );

      if (
        selected.includes(candidateWeekday) &&
        weekIndex >= 0 &&
        weekIndex % repeat.interval === 0
      ) {
        nextDate = candidateDate;
        break;
      }
    }
  } else if (repeat.frequency === "monthly") {
    let year = current.year;
    let monthIndex = current.month - 1 + repeat.interval;
    year += Math.floor(monthIndex / 12);
    monthIndex = ((monthIndex % 12) + 12) % 12;
    const day = Math.min(
      repeat.anchorDay || current.day,
      daysInMonth(year, monthIndex)
    );
    nextDate = Date.UTC(year, monthIndex, day);
  } else {
    return null;
  }

  if (!Number.isFinite(nextDate)) return null;

  const next = dateOnlyParts(nextDate);
  return zonedDateTimeToUtc(
    {
      ...next,
      hour: current.hour,
      minute: current.minute,
      second: current.second,
    },
    timeZone
  );
}

export function formatLocalDate(date, timeZone) {
  const parts = getLocalParts(new Date(date), timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(
    parts.day
  ).padStart(2, "0")}`;
}

/**
 * Calculates a reminder instant in the task timezone. Month reminders use
 * calendar subtraction and clamp to the last valid day of the target month.
 * This is currently a pure utility: this backend has no notification worker.
 */
export function calculateReminderDate(
  dueDate,
  { reminderMinutesBefore = null, reminderMonthsBefore = null, timeZone = DEFAULT_TIME_ZONE } = {},
) {
  if (!dueDate || (reminderMinutesBefore == null && reminderMonthsBefore == null)) {
    return null;
  }

  const local = getLocalParts(new Date(dueDate), timeZone);
  if (reminderMonthsBefore != null) {
    const targetMonthIndex = local.month - 1 - reminderMonthsBefore;
    const targetYear = local.year + Math.floor(targetMonthIndex / 12);
    const normalizedMonth = ((targetMonthIndex % 12) + 12) % 12;
    const targetDay = Math.min(
      local.day,
      daysInMonth(targetYear, normalizedMonth),
    );
    return zonedDateTimeToUtc(
      {
        year: targetYear,
        month: normalizedMonth + 1,
        day: targetDay,
        hour: local.hour,
        minute: local.minute,
        second: local.second,
      },
      timeZone,
    );
  }

  return new Date(new Date(dueDate).getTime() - reminderMinutesBefore * 60_000);
}
