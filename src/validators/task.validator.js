
import {
  formatLocalDate,
  validateRepeatConfig,
} from "../utils/recurring-task.js";

const priorities = ["low", "medium", "high"];

const allowedFields = [
  "title",
  "description",
  "dueDate",
  "dueDateType",
  "dueDateDate",
  "timeZoneId",
  "priority",
  "category",
  "isCompleted",
  "isUrgent",
  "reminderMinutesBefore",
  "attachments",
  "repeat",
];

const allowedReminderMinutes = [0, 5, 10, 15, 30, 60, 1440];
const allowedAttachmentMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
]);

const dueDateTypes = ["none", "date", "dateTime"];
const legacyDateTimeZone = "Asia/Ho_Chi_Minh";

function isValidContractCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth;
}

function isValidContractTimeZone(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

const contractIsoDateTimePattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](\d{2}):(\d{2}))$/;

function isValidIsoDateTime(value) {
  if (typeof value !== "string") return false;
  const match = contractIsoDateTimePattern.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return false;
  }

  return !Number.isNaN(new Date(value).getTime());
}

function normalizeLegacyDueDateFields(body) {
  if ("dueDateType" in body) return;

  if ("dueDate" in body && body.dueDate === null) {
    body.dueDateType = "none";
    body.dueDateDate = null;
    body.timeZoneId = null;
  } else if ("dueDate" in body && body.dueDate !== null) {
    body.dueDateType = "dateTime";
    body.timeZoneId ??= legacyDateTimeZone;
  }
}

function validateDueDateFields(body, { isCreate }) {
  normalizeLegacyDueDateFields(body);

  if (!("dueDateType" in body)) return null;

  const type = body.dueDateType;
  if (!dueDateTypes.includes(type)) {
    return "dueDateType phải là none, date hoặc dateTime.";
  }

  if (type === "none") {
    if (
      ("dueDate" in body && body.dueDate !== null) ||
      ("dueDateDate" in body && body.dueDateDate !== null) ||
      ("timeZoneId" in body && body.timeZoneId !== null)
    ) {
      return "dueDateType none phải có dueDate, dueDateDate và timeZoneId bằng null.";
    }
    body.dueDate = null;
    body.dueDateDate = null;
    body.timeZoneId = null;
    return null;
  }

  if (type === "date") {
    if (!isValidContractCalendarDate(body.dueDateDate)) {
      return "dueDateDate phải có định dạng YYYY-MM-DD và là ngày hợp lệ.";
    }
    if (
      ("dueDate" in body && body.dueDate !== null) ||
      ("timeZoneId" in body && body.timeZoneId !== null)
    ) {
      return "dueDateType date chỉ được có dueDateDate; dueDate và timeZoneId phải null.";
    }
    body.dueDate = null;
    body.timeZoneId = null;
    return null;
  }

  if (!isValidIsoDateTime(body.dueDate)) {
    return "dueDate phải là timestamp ISO hợp lệ khi dueDateType là dateTime.";
  }
  if (!isValidContractTimeZone(body.timeZoneId)) {
    return "timeZoneId phải là IANA timezone hợp lệ khi dueDateType là dateTime.";
  }
  if (
    ("dueDateDate" in body && body.dueDateDate !== null)
  ) {
    return "dueDateType dateTime phải có dueDateDate bằng null.";
  }
  body.dueDateDate = null;
  return null;
}

// Kiểm tra dữ liệu khi tạo công việc
export const validateCreateTask = (req, res, next) => {
  const { title, category } = req.body;

  if (typeof title !== "string" || !title.trim()) {
    return res.status(400).json({
      message: "Vui lòng nhập tên công việc.",
    });
  }

  if (typeof category !== "string" || !category.trim()) {
    return res.status(400).json({
      message: "Vui lòng nhập danh mục công việc.",
    });
  }

  const dueDateError = validateDueDateFields(req.body, { isCreate: true });
  if (dueDateError) return res.status(400).json({ message: dueDateError });

  if (req.body.repeat?.enabled && req.body.dueDateType !== "dateTime") {
    return res.status(400).json({
      message: "Task lặp chỉ hỗ trợ dueDateType dateTime.",
    });
  }

  if (req.body.repeat?.enabled && req.body.isCompleted === true) {
    return res.status(400).json({
      message: "Tạo Task lặp phải bắt đầu ở trạng thái chưa hoàn thành.",
    });
  }

  return validateTaskFields(req, res, next);
};

// Kiểm tra dữ liệu khi cập nhật công việc
export const validateUpdateTask = (req, res, next) => {
  const keys = Object.keys(req.body);

  if (keys.length === 0) {
    return res.status(400).json({
      message: "Vui lòng cung cấp ít nhất một trường cần cập nhật.",
    });
  }

  return validateTaskFields(req, res, next);
};

// Kiểm tra tính hợp lệ của các trường dữ liệu
const validateTaskFields = (req, res, next) => {
  const body = req.body;

  const dueDateError = validateDueDateFields(body, { isCreate: false });
  if (dueDateError) return res.status(400).json({ message: dueDateError });

  const unknownFields = Object.keys(body).filter(
    (key) => !allowedFields.includes(key),
  );

  if (unknownFields.length > 0) {
    return res.status(400).json({
      message: "Yêu cầu chứa trường dữ liệu không được hỗ trợ.",
      fields: unknownFields,
    });
  }

  if (
    "title" in body &&
    (typeof body.title !== "string" || !body.title.trim())
  ) {
    return res.status(400).json({
      message: "Tên công việc phải là chuỗi ký tự không được để trống.",
    });
  }

  if (
    "category" in body &&
    (typeof body.category !== "string" || !body.category.trim())
  ) {
    return res.status(400).json({
      message: "Danh mục công việc phải là chuỗi ký tự không được để trống.",
    });
  }

  if (
    "description" in body &&
    typeof body.description !== "string"
  ) {
    return res.status(400).json({
      message: "Mô tả công việc phải là chuỗi ký tự.",
    });
  }

  if (
    "priority" in body &&
    !priorities.includes(body.priority)
  ) {
    return res.status(400).json({
      message: "Mức độ ưu tiên chỉ được là low, medium hoặc high.",
    });
  }

  if (
    "isCompleted" in body &&
    typeof body.isCompleted !== "boolean"
  ) {
    return res.status(400).json({
      message: "Trạng thái hoàn thành phải là true hoặc false.",
    });
  }

  if ("isUrgent" in body && typeof body.isUrgent !== "boolean") {
    return res.status(400).json({
      message: "Trạng thái khẩn cấp phải là true hoặc false.",
    });
  }

  if (
    "reminderMinutesBefore" in body &&
    body.reminderMinutesBefore !== null &&
    !allowedReminderMinutes.includes(body.reminderMinutesBefore)
  ) {
    return res.status(400).json({
      message: "Thời gian nhắc không hợp lệ.",
      allowedValues: allowedReminderMinutes,
    });
  }

  if ("attachments" in body) {
    if (!Array.isArray(body.attachments) || body.attachments.length > 5) {
      return res.status(400).json({
        message: "attachments phải là danh sách tối đa 5 tệp.",
      });
    }

    const invalidAttachment = body.attachments.some((attachment) =>
      !attachment ||
      typeof attachment !== "object" ||
      Array.isArray(attachment) ||
      typeof attachment.name !== "string" ||
      !attachment.name.trim() ||
      attachment.name.length > 255 ||
      typeof attachment.url !== "string" ||
      !attachment.url.trim() ||
      attachment.url.length > 2048 ||
      typeof attachment.mimeType !== "string" ||
      !allowedAttachmentMimeTypes.has(attachment.mimeType) ||
      ("publicId" in attachment &&
        (typeof attachment.publicId !== "string" ||
          !attachment.publicId.trim() ||
          attachment.publicId.length > 512)) ||
      (attachment.sizeBytes !== undefined &&
        (!Number.isInteger(attachment.sizeBytes) || attachment.sizeBytes < 0)) ||
      Object.keys(attachment).some(
        (key) =>
          !["name", "url", "publicId", "mimeType", "sizeBytes"].includes(key),
      ),
    );

    if (invalidAttachment) {
      return res.status(400).json({
        message:
          "Mỗi tệp cần có name, url, mimeType ảnh hợp lệ và sizeBytes tùy chọn.",
      });
    }

    const publicIds = body.attachments
      .map((attachment) => attachment.publicId)
      .filter(Boolean);
    if (new Set(publicIds).size !== publicIds.length) {
      return res.status(400).json({
        message: "Không thể đính kèm cùng một ảnh nhiều lần.",
      });
    }
  }

  if ("repeat" in body) {
    const result = validateRepeatConfig(body.repeat);
    if (!result.valid) {
      return res.status(400).json({ message: result.message });
    }
    body.repeat = result.value;
  }

  if (body.repeat?.enabled && body.isCompleted === true) {
    return res.status(400).json({
      message: "Task lặp phải ở trạng thái chưa hoàn thành.",
    });
  }

  if ("dueDate" in body && body.dueDate !== null) {
    const isValidDate =
      typeof body.dueDate === "string" &&
      body.dueDate.trim() !== "" &&
      !Number.isNaN(Date.parse(body.dueDate));

    if (!isValidDate) {
      return res.status(400).json({
        message:
          "Ngày đến hạn phải là ngày hợp lệ theo định dạng chuỗi ISO hoặc null.",
      });
    }
  }

  if (
    body.repeat?.enabled &&
    body.repeat.endType === "onDate" &&
    body.dueDate &&
    formatLocalDate(
      new Date(body.dueDate),
      body.repeat.timeZone
    ) > body.repeat.endDate
  ) {
    return res.status(400).json({
      message: "dueDate không được nằm sau repeat.endDate.",
    });
  }

  if ("title" in body) {
    body.title = body.title.trim();
  }

  if ("category" in body) {
    body.category = body.category.trim();
  }

  return next();
};


const taskListQueryFields = new Set([
  "page",
  "limit",
  "search",
  "isCompleted",
  "priority",
  "dueFrom",
  "dueBefore",
  "sort",
]);

const overviewQueryFields = new Set(["date", "timeZone"]);

const isoDateTimePattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/;

function parseIsoDateTime(value) {
  if (typeof value !== "string") return null;

  const match = isoDateTimePattern.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const date = new Date(value);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59 ||
    Number.isNaN(date.getTime())
  ) {
    return null;
  }

  return date;
}

function isValidCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth;
}

function isValidTimeZone(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export const validateTaskOverviewQuery = (req, res, next) => {
  const query = req.query;
  const unknownFields = Object.keys(query).filter(
    (key) => !overviewQueryFields.has(key),
  );

  if (unknownFields.length > 0) {
    return res.status(400).json({
      message: "Query chứa tham số không được hỗ trợ.",
      fields: unknownFields,
    });
  }

  if (Object.values(query).some((value) => typeof value !== "string")) {
    return res.status(400).json({
      message: "Mỗi tham số query phải có đúng một giá trị dạng chuỗi.",
    });
  }

  const date = query.date ?? new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(new Date());
  const timeZone = query.timeZone ?? "Asia/Ho_Chi_Minh";

  if (!isValidCalendarDate(date)) {
    return res.status(400).json({
      message: "date phải có định dạng YYYY-MM-DD và là ngày hợp lệ.",
    });
  }

  if (!isValidTimeZone(timeZone)) {
    return res.status(400).json({
      message: "timeZone phải là tên IANA timezone hợp lệ.",
    });
  }

  req.taskOverviewQuery = { date, timeZone };
  return next();
};

export const validateTaskListQuery = (req, res, next) => {
  const query = req.query;
  const unknownFields = Object.keys(query).filter(
    (key) => !taskListQueryFields.has(key),
  );

  if (unknownFields.length > 0) {
    return res.status(400).json({
      message: "Query chứa tham số không được hỗ trợ.",
      fields: unknownFields,
    });
  }

  if (Object.values(query).some((value) => typeof value !== "string")) {
    return res.status(400).json({
      message: "Mỗi tham số query phải có đúng một giá trị dạng chuỗi.",
    });
  }

  const pageText = query.page ?? "1";
  const limitText = query.limit ?? "20";

  if (!/^\d+$/.test(pageText) || !/^\d+$/.test(limitText)) {
    return res.status(400).json({
      message: "page và limit phải là số nguyên dương.",
    });
  }

  const page = Number(pageText);
  const limit = Number(limitText);

  if (!Number.isSafeInteger(page) || page < 1) {
    return res.status(400).json({
      message: "page phải là số nguyên lớn hơn hoặc bằng 1.",
    });
  }

  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    return res.status(400).json({
      message: "limit phải là số nguyên từ 1 đến 50.",
    });
  }

  if (!Number.isSafeInteger((page - 1) * limit)) {
    return res.status(400).json({
      message: "page vượt quá phạm vi hỗ trợ.",
    });
  }

  let isCompleted;
  if (query.isCompleted !== undefined) {
    if (query.isCompleted !== "true" && query.isCompleted !== "false") {
      return res.status(400).json({
        message: "isCompleted chỉ nhận true hoặc false.",
      });
    }
    isCompleted = query.isCompleted === "true";
  }

  const priorities = ["low", "medium", "high"];
  if (query.priority !== undefined && !priorities.includes(query.priority)) {
    return res.status(400).json({
      message: "priority chỉ nhận low, medium hoặc high.",
    });
  }

  const search = query.search?.trim();
  if (search !== undefined && search.length > 100) {
    return res.status(400).json({
      message: "search không được vượt quá 100 ký tự.",
    });
  }

  const dueFrom = query.dueFrom === undefined
    ? undefined
    : parseIsoDateTime(query.dueFrom);
  const dueBefore = query.dueBefore === undefined
    ? undefined
    : parseIsoDateTime(query.dueBefore);

  if (query.dueFrom !== undefined && dueFrom === null) {
    return res.status(400).json({
      message: "dueFrom phải là ngày giờ ISO 8601 hợp lệ kèm timezone.",
    });
  }

  if (query.dueBefore !== undefined && dueBefore === null) {
    return res.status(400).json({
      message: "dueBefore phải là ngày giờ ISO 8601 hợp lệ kèm timezone.",
    });
  }

  if (dueFrom && dueBefore && dueFrom >= dueBefore) {
    return res.status(400).json({
      message: "dueFrom phải nhỏ hơn dueBefore.",
    });
  }

  const sort = query.sort ?? "createdAtDesc";
  const allowedSorts = [
    "createdAtDesc",
    "createdAtAsc",
    "dueDateAsc",
    "dueDateDesc",
    "priorityDueDateAsc",
    "completedAtDesc",
  ];
  if (!allowedSorts.includes(sort)) {
    return res.status(400).json({
      message: "sort không được hỗ trợ.",
    });
  }

  req.taskListQuery = {
    page,
    limit,
    search: search || undefined,
    isCompleted,
    priority: query.priority,
    dueFrom: dueFrom ?? undefined,
    dueBefore: dueBefore ?? undefined,
    sort,
  };

  return next();
};
