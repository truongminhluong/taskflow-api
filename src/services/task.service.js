import mongoose from "mongoose";
import Task from "../models/task.model.js";
import {
  calculateNextDueDate,
  formatLocalDate,
  validateRepeatConfig,
} from "../utils/recurring-task.js";

const searchableFieldVariants = {
  a: "aáàảãạăắằẳẵặâấầẩẫậ",
  e: "eéèẻẽẹêếềểễệ",
  i: "iíìỉĩị",
  o: "oóòỏõọôốồổỗộơớờởỡợ",
  u: "uúùủũụưứừửữự",
  y: "yýỳỷỹỵ",
  d: "dđ",
};

function createAccentInsensitiveSearch(search) {
  const normalized = search
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d");
  const pattern = Array.from(normalized, (character) => {
    const variants = searchableFieldVariants[character];
    if (variants) return `[${variants}]`;
    return character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("");

  return new RegExp(pattern, "i");
}

function addFilter(baseFilter, additionalFilter) {
  return { $and: [baseFilter, additionalFilter] };
}

function createTaskFilter(userId, { isCompleted, priority, dueFrom, dueBefore }) {
  const filters = [{ userId }];

  if (isCompleted !== undefined) {
    filters.push({ isCompleted });
  }

  if (priority !== undefined) {
    filters.push({ priority });
  }

  if (dueFrom || dueBefore) {
    const dueDate = {};
    if (dueFrom) dueDate.$gte = dueFrom;
    if (dueBefore) dueDate.$lt = dueBefore;
    filters.push({ dueDate });
  }

  return filters.length === 1 ? filters[0] : { $and: filters };
}

function createNonMatchingRegex(expression) {
  return new RegExp(
    `^(?![\\s\\S]*${expression.source})[\\s\\S]*$`,
    expression.flags,
  );
}

function createWordPrefixSearch(expression) {
  return new RegExp(
    `(^|[^a-zA-Z0-9À-ỹ])${expression.source}`,
    expression.flags,
  );
}

function createSearchFilters(baseFilter, expression) {
  const wordPrefixExpression = createWordPrefixSearch(expression);
  const notMatchingExpression = createNonMatchingRegex(expression);
  const notWordPrefixExpression = createNonMatchingRegex(wordPrefixExpression);

  return [
    addFilter(baseFilter, { title: { $regex: wordPrefixExpression } }),
    addFilter(baseFilter, {
      $and: [
        { title: { $regex: expression } },
        { title: { $regex: notWordPrefixExpression } },
      ],
    }),
    addFilter(baseFilter, {
      $and: [
        { description: { $regex: wordPrefixExpression } },
        { title: { $regex: notMatchingExpression } },
      ],
    }),
    addFilter(baseFilter, {
      $and: [
        { description: { $regex: expression } },
        { title: { $regex: notMatchingExpression } },
        { description: { $regex: notWordPrefixExpression } },
      ],
    }),
    addFilter(baseFilter, {
      $and: [
        { category: { $regex: wordPrefixExpression } },
        { title: { $regex: notMatchingExpression } },
        { description: { $regex: notMatchingExpression } },
      ],
    }),
    addFilter(baseFilter, {
      $and: [
        { category: { $regex: expression } },
        { title: { $regex: notMatchingExpression } },
        { description: { $regex: notMatchingExpression } },
        { category: { $regex: notWordPrefixExpression } },
      ],
    }),
  ];
}

function createPagination(page, limit, totalItems, items) {
  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / limit);
  return {
    items,
    pagination: {
      page,
      limit,
      totalItems,
      totalPages,
      hasNextPage: page < totalPages,
    },
  };
}

async function getDueDateSortedPage(
  filter,
  skip,
  limit,
  sort,
  tieBreakers = { _id: 1 },
) {
  const nonNullFilter = addFilter(filter, { dueDate: { $ne: null } });
  const nullFilter = addFilter(filter, { dueDate: null });
  const sortDirection = sort === "dueDateAsc" ? 1 : -1;
  const nonNullTotal = await Task.countDocuments(nonNullFilter);
  const nonNullSkip = Math.min(skip, nonNullTotal);
  const nonNullLimit = Math.max(0, Math.min(limit, nonNullTotal - skip));
  let items = [];

  if (nonNullLimit > 0) {
    items = await Task.find(nonNullFilter)
      .sort({ dueDate: sortDirection, ...tieBreakers })
      .skip(nonNullSkip)
      .limit(nonNullLimit);
  }

  const nullLimit = limit - items.length;
  if (nullLimit > 0) {
    const nullSkip = Math.max(0, skip - nonNullTotal);
    const nullItems = await Task.find(nullFilter)
      .sort(tieBreakers)
      .skip(nullSkip)
      .limit(nullLimit);
    items = [...items, ...nullItems];
  }

  return items;
}

async function getPriorityDueDateSortedPage(filter, skip, limit) {
  const priorities = ["high", "medium", "low"];
  const counts = await Promise.all(
    priorities.map((priority) =>
      Task.countDocuments(addFilter(filter, { priority })),
    ),
  );
  let remainingSkip = skip;
  const items = [];

  for (let index = 0; index < priorities.length && items.length < limit; index++) {
    const count = counts[index];
    if (remainingSkip >= count) {
      remainingSkip -= count;
      continue;
    }

    const bucketLimit = Math.min(limit - items.length, count - remainingSkip);
    const priorityFilter = addFilter(filter, { priority: priorities[index] });
    const priorityItems = await getDueDateSortedPage(
      priorityFilter,
      remainingSkip,
      bucketLimit,
      "dueDateAsc",
      { updatedAt: -1, createdAt: -1, _id: -1 },
    );
    items.push(...priorityItems);
    remainingSkip = 0;
  }

  return items;
}

async function getRankedSearchPage({ baseFilter, expression, page, limit, sort }) {
  const filtersByRank = createSearchFilters(baseFilter, expression);
  const countsByRank = await Promise.all(
    filtersByRank.map((filter) => Task.countDocuments(filter)),
  );
  const totalItems = countsByRank.reduce((total, count) => total + count, 0);
  let remainingSkip = (page - 1) * limit;
  const items = [];

  for (
    let index = 0;
    index < filtersByRank.length && items.length < limit;
    index++
  ) {
    const count = countsByRank[index];
    if (remainingSkip >= count) {
      remainingSkip -= count;
      continue;
    }

    const bucketLimit = Math.min(limit - items.length, count - remainingSkip);
    const filter = filtersByRank[index];
    const sortBy = {
      completedAtDesc: { completedAt: -1, updatedAt: -1, _id: -1 },
      priorityDueDateAsc: null,
      createdAtAsc: { createdAt: 1, _id: 1 },
      createdAtDesc: { createdAt: -1, _id: -1 },
    }[sort];
    const bucketItems =
      sort === "priorityDueDateAsc"
        ? await getPriorityDueDateSortedPage(filter, remainingSkip, bucketLimit)
        : sort === "dueDateAsc" || sort === "dueDateDesc"
        ? await getDueDateSortedPage(filter, remainingSkip, bucketLimit, sort)
        : await Task.find(filter)
            .sort(sortBy)
            .skip(remainingSkip)
            .limit(bucketLimit);

    items.push(...bucketItems);
    remainingSkip = 0;
  }

  return createPagination(page, limit, totalItems, items);
}

// Lấy task theo user, áp dụng cùng bộ lọc cho danh sách và tổng số.
const getAllTasks = async (userId, options) => {
  const {
    page,
    limit,
    search,
    isCompleted,
    priority,
    dueFrom,
    dueBefore,
    sort,
  } = options;
  const skip = (page - 1) * limit;
  const filter = createTaskFilter(userId, {
    isCompleted,
    priority,
    dueFrom,
    dueBefore,
  });

  if (search) {
    return getRankedSearchPage({
      baseFilter: filter,
      expression: createAccentInsensitiveSearch(search),
      page,
      limit,
      sort,
    });
  }

  if (sort === "priorityDueDateAsc") {
    const [items, totalItems] = await Promise.all([
      getPriorityDueDateSortedPage(filter, skip, limit),
      Task.countDocuments(filter),
    ]);
    return createPagination(page, limit, totalItems, items);
  }

  if (sort === "dueDateAsc" || sort === "dueDateDesc") {
    const nonNullFilter = addFilter(filter, { dueDate: { $ne: null } });
    const nullFilter = addFilter(filter, { dueDate: null });
    const sortDirection = sort === "dueDateAsc" ? 1 : -1;
    const [totalItems, nonNullTotal] = await Promise.all([
      Task.countDocuments(filter),
      Task.countDocuments(nonNullFilter),
    ]);
    const nonNullSkip = Math.min(skip, nonNullTotal);
    const nonNullLimit = Math.max(0, Math.min(limit, nonNullTotal - skip));
    let items = [];

    if (nonNullLimit > 0) {
      items = await Task.find(nonNullFilter)
        .sort({ dueDate: sortDirection, _id: 1 })
        .skip(nonNullSkip)
        .limit(nonNullLimit);
    }

    const nullLimit = limit - items.length;
    if (nullLimit > 0) {
      const nullSkip = Math.max(0, skip - nonNullTotal);
      const nullItems = await Task.find(nullFilter)
        .sort({ _id: 1 })
        .skip(nullSkip)
        .limit(nullLimit);
      items = [...items, ...nullItems];
    }

    return createPagination(page, limit, totalItems, items);
  }

  const sortBy = {
    completedAtDesc: { completedAt: -1, updatedAt: -1, _id: -1 },
    createdAtDesc: { createdAt: -1, _id: -1 },
    createdAtAsc: { createdAt: 1, _id: 1 },
  }[sort];
  const [items, totalItems] = await Promise.all([
    Task.find(filter).sort(sortBy).skip(skip).limit(limit),
    Task.countDocuments(filter),
  ]);

  return createPagination(page, limit, totalItems, items);
};

// Lấy chi tiết công việc của user
const getTaskById = async (id, userId) => {
  return Task.findOne({
    _id: id,
    userId,
  });
};

function zonedMidnightUtc(date, timeZone) {
  const [year, month, day] = date.split("-").map(Number);
  let candidate = new Date(Date.UTC(year, month - 1, day));

  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(candidate);
    const values = Object.fromEntries(
      parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]),
    );
    const localAsUtc = Date.UTC(
      values.year,
      values.month - 1,
      values.day,
      values.hour,
      values.minute,
      values.second,
    );
    const desiredAsUtc = Date.UTC(year, month - 1, day);
    candidate = new Date(candidate.getTime() + desiredAsUtc - localAsUtc);
  }

  return candidate;
}

const getTaskOverview = async (userId, { date, timeZone }) => {
  const startOfDay = zonedMidnightUtc(date, timeZone);
  const [year, month, day] = date.split("-").map(Number);
  const nextLocalDate = new Date(Date.UTC(year, month - 1, day + 1))
    .toISOString()
    .slice(0, 10);
  const nextDate = zonedMidnightUtc(nextLocalDate, timeZone);
  const dayFilter = {
    userId,
    $or: [
      { dueDateDate: date },
      { dueDate: { $gte: startOfDay, $lt: nextDate } },
    ],
  };
  const projection = {
    _id: 1,
    title: 1,
    description: 1,
    dueDate: 1,
    priority: 1,
    category: 1,
    isCompleted: 1,
    isUrgent: 1,
    reminderMinutesBefore: 1,
    attachments: 1,
    createdAt: 1,
    updatedAt: 1,
    dueDateType: 1,
    dueDateDate: 1,
    timeZoneId: 1,
  };

  const [todayTasks, upcomingTasks] = await Promise.all([
    Task.find(dayFilter).select(projection).sort({ dueDate: 1, _id: 1 }),
    Task.find({
      userId,
      isCompleted: false,
      $or: [
        { dueDateDate: { $gt: date } },
        { dueDate: { $gte: nextDate } },
      ],
    })
      .select(projection)
      .sort({ dueDate: 1, _id: 1 })
      .limit(3),
  ]);

  const completed = todayTasks.filter((task) => task.isCompleted === true).length;
  const pending = todayTasks.filter((task) => task.isCompleted === false).length;

  return {
    date,
    summary: { total: completed + pending, completed, pending },
    todayTasks,
    upcomingTasks,
  };
};

// Tạo công việc
const createTask = async (data) => {
  const taskData = { ...data };
  if (taskData.isCompleted) taskData.completedAt = new Date();

  if (taskData.repeat?.enabled) {
    taskData.recurrenceId = new mongoose.Types.ObjectId();
    taskData.occurrenceIndex = 1;
    if (taskData.dueDate) {
      const dueDate = new Date(taskData.dueDate);
      taskData.repeat.anchorDate = formatLocalDate(
        dueDate,
        taskData.repeat.timeZone || "Asia/Ho_Chi_Minh"
      );
      taskData.repeat.anchorDay = Number(taskData.repeat.anchorDate.slice(-2));
    }
  } else {
    taskData.recurrenceId = null;
    taskData.occurrenceIndex = null;
  }

  return Task.create(taskData);
};

// Cập nhật công việc của user
const updateTask = async (id, userId, data) => {
  const filter = { _id: id, userId };
  const currentTask = await Task.findOne(filter);
  if (!currentTask) return null;

  if (data.repeat && currentTask.recurrenceId) {
    const error = new Error(
      "Hãy cập nhật repeat qua API recurring-series."
    );
    error.statusCode = 400;
    throw error;
  }

  const currentDueDateType =
    currentTask.dueDateType ?? (currentTask.dueDate == null ? "none" : "dateTime");
  const effectiveDueDateType = data.dueDateType ?? currentDueDateType;

  if (data.repeat?.enabled && effectiveDueDateType !== "dateTime") {
    const error = new Error("Task lặp chỉ hỗ trợ dueDateType dateTime.");
    error.statusCode = 400;
    throw error;
  }

  if (
    currentTask.recurrenceId &&
    "dueDateType" in data &&
    data.dueDateType !== "dateTime"
  ) {
    const error = new Error(
      "Không thể chuyển task đang lặp sang date hoặc none trong phase này."
    );
    error.statusCode = 400;
    throw error;
  }

  if (
    data.repeat?.enabled &&
    data.repeat.endType === "onDate" &&
    (data.dueDate || currentTask.dueDate) &&
    formatLocalDate(
      new Date(data.dueDate || currentTask.dueDate),
      data.repeat.timeZone
    ) > data.repeat.endDate
  ) {
    const error = new Error("dueDate không được nằm sau repeat.endDate.");
    error.statusCode = 400;
    throw error;
  }

  if (data.isCompleted === true && !currentTask.isCompleted) {
    return completeTask(id, userId);
  }

  if (
    data.isCompleted === true &&
    currentTask.isCompleted &&
    Object.keys(data).length === 1
  ) {
    return completeTask(id, userId);
  }

  const updateData = { ...data };
  if (updateData.isCompleted === true && !currentTask.isCompleted) {
    updateData.completedAt = new Date();
  } else if (updateData.isCompleted === false) {
    updateData.completedAt = null;
  } else {
    delete updateData.completedAt;
  }

  if (updateData.repeat) {
    if (!updateData.repeat.enabled) {
      updateData.recurrenceId = null;
      updateData.occurrenceIndex = null;
    } else if (!currentTask.recurrenceId) {
      if (!currentTask.dueDate && !updateData.dueDate) {
        const error = new Error("Task lặp phải có dueDate.");
        error.statusCode = 400;
        throw error;
      }
      updateData.recurrenceId = new mongoose.Types.ObjectId();
      updateData.occurrenceIndex = 1;
      const dueDate = new Date(updateData.dueDate || currentTask.dueDate);
      updateData.repeat.anchorDate = formatLocalDate(
        dueDate,
        updateData.repeat.timeZone || "Asia/Ho_Chi_Minh"
      );
      updateData.repeat.anchorDay = Number(
        updateData.repeat.anchorDate.slice(-2)
      );
    }
  }

  return Task.findOneAndUpdate(filter, updateData, {
    returnDocument: "after",
    runValidators: true,
  });
};

const createFollowingOccurrence = async (sourceTask, userId) => {
  sourceTask = await Task.findOne({ _id: sourceTask._id, userId });
  if (!sourceTask) return;

  const repeat = sourceTask.repeat?.toObject
    ? sourceTask.repeat.toObject()
    : { ...sourceTask.repeat };
  if (
    !sourceTask.recurrenceId ||
    !repeat?.enabled ||
    sourceTask.recurrenceAdvancedAt ||
    sourceTask.recurrenceStoppedAt
  ) {
    return;
  }

  if (
    (repeat.frequency === "weekly" && !repeat.anchorDate) ||
    (repeat.frequency === "monthly" && !repeat.anchorDay)
  ) {
    const firstOccurrence = await Task.findOne({
      recurrenceId: sourceTask.recurrenceId,
      userId,
    }).sort({ occurrenceIndex: 1 });
    const anchorSource = firstOccurrence?.dueDate || sourceTask.dueDate;
    if (anchorSource) {
      repeat.anchorDate = formatLocalDate(anchorSource, repeat.timeZone);
      repeat.anchorDay = Number(repeat.anchorDate.slice(-2));
    }
  }

  const markAdvanced = async () => {
    const recurrenceAdvancedAt = new Date();
    await Task.updateOne(
      { _id: sourceTask._id, userId, recurrenceAdvancedAt: null },
      { $set: { recurrenceAdvancedAt } }
    );
    sourceTask.recurrenceAdvancedAt = recurrenceAdvancedAt;
  };

  const occurrenceIndex = sourceTask.occurrenceIndex || 1;
  if (
    repeat.endType === "afterOccurrences" &&
    occurrenceIndex >= repeat.maxOccurrences
  ) {
    await markAdvanced();
    return;
  }

  const nextDueDate = calculateNextDueDate(sourceTask.dueDate, repeat);
  if (
    !nextDueDate ||
    (repeat.endType === "onDate" &&
      formatLocalDate(nextDueDate, repeat.timeZone) > repeat.endDate)
  ) {
    await markAdvanced();
    return;
  }

  try {
    await Task.create({
      userId,
      title: sourceTask.title,
      description: sourceTask.description,
      dueDate: nextDueDate,
      priority: sourceTask.priority,
      category: sourceTask.category,
      reminderMinutesBefore: sourceTask.reminderMinutesBefore,
      isUrgent: sourceTask.isUrgent,
      attachments: sourceTask.attachments,
      repeat,
      recurrenceId: sourceTask.recurrenceId,
      occurrenceIndex: occurrenceIndex + 1,
      isCompleted: false,
      completedAt: null,
    });
  } catch (error) {
    if (error.code === 11000) {
      const existing = await Task.findOne({
        recurrenceId: sourceTask.recurrenceId,
        occurrenceIndex: occurrenceIndex + 1,
        userId,
      });
      if (existing) {
        await markAdvanced();
        return;
      }
    }
    error.operation = "create-next-recurring-occurrence";
    throw error;
  }
  await markAdvanced();

  const currentSource = await Task.findOne({ _id: sourceTask._id, userId });
  if (
    !currentSource?.repeat?.enabled ||
    currentSource.recurrenceStoppedAt
  ) {
    await Task.updateOne(
      {
        recurrenceId: sourceTask.recurrenceId,
        occurrenceIndex: occurrenceIndex + 1,
        userId,
        isCompleted: false,
      },
      { $set: { "repeat.enabled": false } }
    );
  }
};

const completeTask = async (id, userId) => {
  const filter = { _id: id, userId };
  const completedTask = await Task.findOneAndUpdate(
    { ...filter, isCompleted: false },
    { isCompleted: true, completedAt: new Date() },
    { returnDocument: "after", runValidators: true }
  );

  if (!completedTask) {
    const existing = await Task.findOne(filter);
    if (!existing) return null;

    if (!existing.isCompleted) {
      const conflict = new Error("Công việc đã được cập nhật đồng thời.");
      conflict.statusCode = 409;
      throw conflict;
    }

    await createFollowingOccurrence(existing, userId);
    return existing;
  }

  await createFollowingOccurrence(completedTask, userId);

  return completedTask;
};

const getRecurringSeries = async (userId) => {
  const occurrences = await Task.find({
    userId,
    recurrenceId: { $ne: null },
  }).sort({ recurrenceId: 1, occurrenceIndex: 1 });

  const grouped = new Map();
  for (const occurrence of occurrences) {
    const recurrenceId = occurrence.recurrenceId.toString();
    if (!grouped.has(recurrenceId)) {
      grouped.set(recurrenceId, []);
    }
    grouped.get(recurrenceId).push(occurrence);
  }

  return [...grouped.entries()].map(([id, items]) => {
    const latest = items.reduce((best, item) =>
      item.occurrenceIndex >= best.occurrenceIndex ? item : best
    );
    return {
      id,
      title: latest.title,
      repeat: latest.repeat,
      occurrenceCount: items.length,
      completedCount: items.filter((item) => item.isCompleted).length,
      active: items.some(
        (item) => !item.isCompleted && item.repeat?.enabled === true
      ),
    };
  });
};

const getRecurringSeriesById = async (id, userId) => {
  if (!mongoose.isValidObjectId(id)) return null;

  const occurrences = await Task.find({
    recurrenceId: id,
    userId,
  }).sort({ occurrenceIndex: 1, dueDate: 1, _id: 1 });

  if (occurrences.length === 0) return null;

  const latest = occurrences[occurrences.length - 1];
  return {
    id,
    title: latest.title,
    repeat: latest.repeat,
    active: occurrences.some(
      (occurrence) =>
        !occurrence.isCompleted && occurrence.repeat?.enabled === true
    ),
    occurrences,
  };
};

const updateRecurringSeries = async (id, userId, repeat) => {
  if (!mongoose.isValidObjectId(id)) return null;

  const result = validateRepeatConfig(repeat);
  if (!result.valid) {
    const error = new Error(result.message);
    error.statusCode = 400;
    throw error;
  }

  const occurrences = await Task.find({
    recurrenceId: id,
    userId,
  }).sort({ occurrenceIndex: 1 });
  if (occurrences.length === 0) return null;

  const first = occurrences[0];
  if (result.value.enabled && first?.dueDate) {
    const storedAnchor = occurrences.find(
      (occurrence) => occurrence.repeat?.anchorDate
    )?.repeat.anchorDate;
    result.value.anchorDate =
      storedAnchor ||
      formatLocalDate(first.dueDate, result.value.timeZone);
    result.value.anchorDay =
      occurrences.find((occurrence) => occurrence.repeat?.anchorDay)
        ?.repeat.anchorDay || Number(result.value.anchorDate.slice(-2));
  }

  if (result.value.enabled) {
    if (!occurrences.some((occurrence) => !occurrence.isCompleted)) {
      const error = new Error(
        "Chuỗi không còn occurrence chưa hoàn thành; hãy tạo một chuỗi mới."
      );
      error.statusCode = 409;
      throw error;
    }

    const highestOccurrence = Math.max(
      ...occurrences.map((occurrence) => occurrence.occurrenceIndex || 1)
    );
    if (
      result.value.endType === "afterOccurrences" &&
      result.value.maxOccurrences < highestOccurrence
    ) {
      const error = new Error(
        "maxOccurrences không thể nhỏ hơn occurrence đã được tạo."
      );
      error.statusCode = 400;
      throw error;
    }

    if (result.value.endType === "onDate") {
      const pendingAfterEndDate = occurrences.some(
        (occurrence) =>
          !occurrence.isCompleted &&
          occurrence.dueDate &&
          formatLocalDate(occurrence.dueDate, result.value.timeZone) >
            result.value.endDate
      );
      if (pendingAfterEndDate) {
        const error = new Error(
          "endDate không thể sớm hơn dueDate của occurrence chưa hoàn thành."
        );
        error.statusCode = 400;
        throw error;
      }
    }
  }

  if (result.value.enabled) {
    const updated = await Task.updateMany(
      {
        recurrenceId: id,
        userId,
        isCompleted: false,
      },
      { $set: { repeat: result.value } }
    );
    if (updated.matchedCount === 0) {
      const error = new Error(
        "Chuỗi đã thay đổi đồng thời; hãy tải lại rồi thử lại."
      );
      error.statusCode = 409;
      throw error;
    }
  } else {
    await Task.updateMany(
      {
        recurrenceId: id,
        userId,
        isCompleted: false,
      },
      { $set: { "repeat.enabled": false } }
    );
    await Task.updateMany(
      {
        recurrenceId: id,
        userId,
        isCompleted: true,
      },
        { $set: { recurrenceStoppedAt: new Date() } }
    );
  }
  return getRecurringSeriesById(id, userId);
};

const deleteRecurringSeries = async (id, userId) => {
  if (!mongoose.isValidObjectId(id)) return null;

  const occurrences = await Task.find({
    recurrenceId: id,
    userId,
  }).sort({ occurrenceIndex: 1 });
  if (occurrences.length === 0) return null;

  await Task.updateMany(
    {
      recurrenceId: id,
      userId,
      isCompleted: false,
    },
    {
      $set: { "repeat.enabled": false },
    }
  );
  await Task.updateMany(
    {
      recurrenceId: id,
      userId,
      isCompleted: true,
    },
    {
      $set: { recurrenceStoppedAt: new Date() },
    }
  );

  return {
    id,
    stopped: true,
    occurrenceCount: occurrences.length,
  };
};

// Xóa công việc của user
const deleteTask = async (id, userId) => {
  return Task.findOneAndDelete({ _id: id, userId });
};

const taskService = {
  getAllTasks,
  getTaskOverview,
  getTaskById,
  createTask,
  updateTask,
  completeTask,
  getRecurringSeries,
  getRecurringSeriesById,
  updateRecurringSeries,
  deleteRecurringSeries,
  deleteTask,
};

export default taskService;
