import assert from "node:assert/strict";
import test from "node:test";
import Task from "../src/models/task.model.js";
import taskService from "../src/services/task.service.js";
import {
  calculateNextDueDate,
  formatLocalDate,
  validateRepeatConfig,
} from "../src/utils/recurring-task.js";

test("validates recurring task configuration", () => {
  assert.equal(
    validateRepeatConfig({
      enabled: true,
      frequency: "weekly",
      interval: 1,
      weekdays: [1, 3, 5],
      endType: "never",
      timeZone: "Asia/Ho_Chi_Minh",
    }).valid,
    true
  );

  assert.equal(validateRepeatConfig({ enabled: false }).valid, true);
  assert.equal(
    validateRepeatConfig({
      enabled: true,
      frequency: "weekly",
      interval: 1,
      weekdays: [],
      endType: "never",
    }).valid,
    false
  );
  assert.equal(
    validateRepeatConfig({
      enabled: true,
      frequency: "monthly",
      interval: 1,
      weekdays: [],
      endType: "onDate",
      endDate: "2026-02-30",
    }).valid,
    false
  );
});

test("calculates daily recurrence in Asia/Ho_Chi_Minh without DST drift", () => {
  const repeat = {
    enabled: true,
    frequency: "daily",
    interval: 2,
    weekdays: [],
    endType: "never",
    timeZone: "Asia/Ho_Chi_Minh",
  };
  const next = calculateNextDueDate(
    new Date("2026-11-01T00:30:00Z"),
    repeat
  );
  assert.equal(formatLocalDate(next, "Asia/Ho_Chi_Minh"), "2026-11-03");
});

test("calculates weekly recurrence for selected weekdays", () => {
  const repeat = {
    enabled: true,
    frequency: "weekly",
    interval: 1,
    weekdays: [1, 3, 5],
    endType: "never",
    timeZone: "Asia/Ho_Chi_Minh",
  };
  const monday = new Date("2026-11-02T01:00:00Z");
  const next = calculateNextDueDate(monday, repeat);
  assert.equal(formatLocalDate(next, "Asia/Ho_Chi_Minh"), "2026-11-04");
});

test("weekly interval is anchored to the series start week", () => {
  const repeat = {
    enabled: true,
    frequency: "weekly",
    interval: 2,
    weekdays: [3, 5],
    anchorDate: "2026-11-02",
    endType: "never",
    timeZone: "Asia/Ho_Chi_Minh",
  };
  const tuesday = new Date("2026-11-02T17:00:00Z");
  const first = calculateNextDueDate(tuesday, repeat);
  assert.equal(formatLocalDate(first, repeat.timeZone), "2026-11-04");

  const friday = new Date("2026-11-06T02:00:00Z");
  const nextActiveWeek = calculateNextDueDate(friday, repeat);
  assert.equal(formatLocalDate(nextActiveWeek, repeat.timeZone), "2026-11-18");
});

test("weekly recurrence advances when completion is not on a selected weekday", () => {
  const repeat = {
    enabled: true,
    frequency: "weekly",
    interval: 2,
    weekdays: [3, 5],
    anchorDate: "2026-11-02",
    endType: "never",
    timeZone: "Asia/Ho_Chi_Minh",
  };
  const tuesday = new Date("2026-11-03T02:00:00Z");
  const next = calculateNextDueDate(tuesday, repeat);
  assert.equal(formatLocalDate(next, repeat.timeZone), "2026-11-04");
});

test("monthly recurrence clamps 31 and preserves the anchor day", () => {
  const repeat = {
    enabled: true,
    frequency: "monthly",
    interval: 1,
    weekdays: [],
    endType: "never",
    timeZone: "Asia/Ho_Chi_Minh",
    anchorDay: 31,
  };
  const january = new Date("2026-01-30T17:00:00Z");
  const february = calculateNextDueDate(january, repeat);
  assert.equal(formatLocalDate(february, "Asia/Ho_Chi_Minh"), "2026-02-28");
  const march = calculateNextDueDate(february, repeat);
  assert.equal(formatLocalDate(march, "Asia/Ho_Chi_Minh"), "2026-03-31");
});

test("monthly recurrence preserves anchors 29 and 30 across February", () => {
  for (const anchorDay of [29, 30]) {
    const repeat = {
      enabled: true,
      frequency: "monthly",
      interval: 1,
      endType: "never",
      timeZone: "Asia/Ho_Chi_Minh",
      anchorDay,
    };
    const january = new Date(`2026-01-${anchorDay}T03:00:00Z`);
    const february = calculateNextDueDate(january, repeat);
    assert.equal(
      formatLocalDate(february, repeat.timeZone),
      "2026-02-28"
    );
    const march = calculateNextDueDate(february, repeat);
    assert.equal(
      formatLocalDate(march, repeat.timeZone),
      `2026-03-${anchorDay}`
    );
  }
});

test("daily recurrence preserves local time in a timezone west of UTC", () => {
  const repeat = {
    enabled: true,
    frequency: "daily",
    interval: 1,
    endType: "never",
    timeZone: "America/Los_Angeles",
  };
  const current = new Date("2026-01-02T03:00:00Z");
  const next = calculateNextDueDate(current, repeat);
  assert.equal(formatLocalDate(next, repeat.timeZone), "2026-01-02");
  assert.equal(next.toISOString(), "2026-01-03T03:00:00.000Z");
});

test("recurring task fields and unique compound index are declared", () => {
  assert.equal(Task.schema.path("recurrenceId").options.index, true);
  assert.equal(Task.schema.path("occurrenceIndex").options.min, 1);
  assert.equal(Task.schema.path("repeat.enabled").defaultValue, false);
  assert.equal(Task.schema.path("repeat.anchorDate").defaultValue, null);
  assert.equal(
    Task.schema.path("repeat.timeZone").defaultValue,
    "Asia/Ho_Chi_Minh"
  );

  const indexes = Task.schema.indexes();
  assert.equal(
    indexes.some(
      ([fields, options]) =>
        fields.recurrenceId === 1 &&
        fields.occurrenceIndex === 1 &&
        options.unique === true
    ),
    true
  );
});

test("concurrent completion creates exactly one next occurrence", async () => {
  const originalFindOneAndUpdate = Task.findOneAndUpdate;
  const originalFindOne = Task.findOne;
  const originalCreate = Task.create;
  const originalUpdateOne = Task.updateOne;

  const recurrenceId = "507f1f77bcf86cd799439099";
  let completed = false;
  const occurrences = new Map();
  let createAttempts = 0;
  const completedTask = {
    _id: "507f1f77bcf86cd799439098",
    userId: "507f1f77bcf86cd799439011",
    title: "Recurring task",
    description: "",
    category: "Công việc",
    priority: "medium",
    dueDate: new Date("2026-11-01T17:00:00Z"),
    reminderMinutesBefore: 15,
    isCompleted: true,
    completedAt: new Date(),
    recurrenceId,
    occurrenceIndex: 1,
    repeat: {
      enabled: true,
      frequency: "daily",
      interval: 1,
      weekdays: [],
      anchorDate: "2026-11-02",
      endType: "afterOccurrences",
      endDate: null,
      maxOccurrences: 3,
      timeZone: "Asia/Ho_Chi_Minh",
      toObject() {
        return {
          enabled: true,
          frequency: "daily",
          interval: 1,
          weekdays: [],
          anchorDate: "2026-11-02",
          endType: "afterOccurrences",
          endDate: null,
          maxOccurrences: 3,
          timeZone: "Asia/Ho_Chi_Minh",
        };
      },
    },
  };

  Task.findOneAndUpdate = async (filter) => {
    if (filter.isCompleted === false && !completed) {
      completed = true;
      return { ...completedTask, repeat: { ...completedTask.repeat } };
    }
    return null;
  };
  Task.findOne = async (filter) => {
    if (filter.recurrenceId) {
      return occurrences.get(`${filter.recurrenceId}:${filter.occurrenceIndex}`) ?? null;
    }
    return completed
      ? { ...completedTask, repeat: { ...completedTask.repeat } }
      : null;
  };
  Task.create = async (data) => {
    createAttempts += 1;
    const key = `${data.recurrenceId}:${data.occurrenceIndex}`;
    if (occurrences.has(key)) {
      const error = new Error("duplicate key");
      error.code = 11000;
      throw error;
    }
    occurrences.set(key, data);
    return { _id: "507f1f77bcf86cd799439097", ...data };
  };
  Task.updateOne = async () => ({ modifiedCount: 1 });

  try {
    const results = await Promise.all([
      taskService.completeTask(
        "507f1f77bcf86cd799439098",
        "507f1f77bcf86cd799439011"
      ),
      taskService.completeTask(
        "507f1f77bcf86cd799439098",
        "507f1f77bcf86cd799439011"
      ),
    ]);
    assert.equal(results.every((result) => result.isCompleted), true);
    assert.equal(createAttempts, 2);
    assert.equal(occurrences.size, 1);
    const nextOccurrence = [...occurrences.values()][0];
    assert.equal(nextOccurrence.occurrenceIndex, 2);
    assert.equal(nextOccurrence.recurrenceId, recurrenceId);
    assert.equal(nextOccurrence.reminderMinutesBefore, 15);
  } finally {
    Task.findOneAndUpdate = originalFindOneAndUpdate;
    Task.findOne = originalFindOne;
    Task.create = originalCreate;
    Task.updateOne = originalUpdateOne;
  }
});

test("completion respects maxOccurrences and endDate", async () => {
  const originalFindOneAndUpdate = Task.findOneAndUpdate;
  const originalFindOne = Task.findOne;
  const originalCreate = Task.create;
  const originalUpdateOne = Task.updateOne;
  const baseTask = {
    _id: "507f1f77bcf86cd799439098",
    userId: "507f1f77bcf86cd799439011",
    dueDate: new Date("2026-11-02T03:00:00Z"),
    isCompleted: true,
    recurrenceId: "507f1f77bcf86cd799439099",
    repeat: {
      enabled: true,
      frequency: "daily",
      interval: 1,
      weekdays: [],
      endType: "afterOccurrences",
      maxOccurrences: 1,
      timeZone: "Asia/Ho_Chi_Minh",
    },
  };
  let task = { ...baseTask };
  let createAttempts = 0;
  Task.findOneAndUpdate = async () => task;
  Task.findOne = async () => task;
  Task.create = async () => {
    createAttempts += 1;
    return {};
  };
  Task.updateOne = async () => ({ modifiedCount: 1 });

  try {
    await taskService.completeTask(task._id, task.userId);
    assert.equal(createAttempts, 0);

    task = {
      ...baseTask,
      recurrenceId: "507f1f77bcf86cd799439088",
      occurrenceIndex: 1,
      dueDate: new Date("2026-11-02T03:00:00Z"),
      recurrenceAdvancedAt: null,
      repeat: {
        ...baseTask.repeat,
        endType: "onDate",
        endDate: "2026-11-02",
        maxOccurrences: null,
      },
    };
    await taskService.completeTask(task._id, task.userId);
    assert.equal(createAttempts, 0);
  } finally {
    Task.findOneAndUpdate = originalFindOneAndUpdate;
    Task.findOne = originalFindOne;
    Task.create = originalCreate;
    Task.updateOne = originalUpdateOne;
  }
});

test("completion can be retried after next occurrence persistence fails", async () => {
  const originalFindOneAndUpdate = Task.findOneAndUpdate;
  const originalFindOne = Task.findOne;
  const originalCreate = Task.create;
  const originalUpdateOne = Task.updateOne;
  const recurrenceId = "507f1f77bcf86cd799439099";
  const task = {
    _id: "507f1f77bcf86cd799439098",
    userId: "507f1f77bcf86cd799439011",
    dueDate: new Date("2026-11-01T17:00:00Z"),
    isCompleted: true,
    recurrenceId,
    occurrenceIndex: 1,
    repeat: {
      enabled: true,
      frequency: "daily",
      interval: 1,
      weekdays: [],
      anchorDate: "2026-11-02",
      endType: "never",
      timeZone: "Asia/Ho_Chi_Minh",
    },
  };
  let completed = false;
  let attempts = 0;

  Task.findOneAndUpdate = async () => {
    if (completed) return null;
    completed = true;
    return task;
  };
  Task.findOne = async () => task;
  Task.updateOne = async () => ({ modifiedCount: 1 });
  Task.create = async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("database unavailable");
      error.code = "ECONNRESET";
      throw error;
    }
    return {};
  };

  try {
    await assert.rejects(
      taskService.completeTask(task._id, task.userId),
      (error) => error.code === "ECONNRESET"
    );
    const retried = await taskService.completeTask(task._id, task.userId);
    assert.equal(retried, task);
    assert.equal(attempts, 2);
  } finally {
    Task.findOneAndUpdate = originalFindOneAndUpdate;
    Task.findOne = originalFindOne;
    Task.create = originalCreate;
    Task.updateOne = originalUpdateOne;
  }
});

test("completion does not regenerate an occurrence after the series is stopped", async () => {
  const originalFindOneAndUpdate = Task.findOneAndUpdate;
  const originalFindOne = Task.findOne;
  const originalCreate = Task.create;
  const task = {
    _id: "507f1f77bcf86cd799439098",
    userId: "507f1f77bcf86cd799439011",
    dueDate: new Date("2026-11-02T03:00:00Z"),
    isCompleted: true,
    recurrenceId: "507f1f77bcf86cd799439099",
    occurrenceIndex: 1,
    repeat: {
      enabled: true,
      frequency: "daily",
      interval: 1,
      endType: "never",
      timeZone: "Asia/Ho_Chi_Minh",
    },
  };
  let createAttempts = 0;
  Task.findOneAndUpdate = async () => task;
  Task.findOne = async () => ({
    ...task,
    recurrenceStoppedAt: new Date(),
    repeat: { ...task.repeat },
  });
  Task.create = async () => {
    createAttempts += 1;
    return {};
  };

  try {
    await taskService.completeTask(task._id, task.userId);
    assert.equal(createAttempts, 0);
  } finally {
    Task.findOneAndUpdate = originalFindOneAndUpdate;
    Task.findOne = originalFindOne;
    Task.create = originalCreate;
  }
});

test("series edits affect pending occurrences but preserve completed task history", async () => {
  const originalFind = Task.find;
  const originalUpdateMany = Task.updateMany;
  const recurrenceId = "507f1f77bcf86cd799439099";
  const userId = "507f1f77bcf86cd799439011";
  const completed = {
    recurrenceId,
    userId,
    occurrenceIndex: 1,
    isCompleted: true,
    dueDate: new Date("2026-11-02T03:00:00Z"),
    repeat: { enabled: true, frequency: "daily", interval: 1 },
  };
  const pending = {
    recurrenceId,
    userId,
    occurrenceIndex: 2,
    isCompleted: false,
    dueDate: new Date("2026-11-03T03:00:00Z"),
    repeat: { enabled: true, frequency: "daily", interval: 1 },
  };
  const occurrences = [completed, pending];
  Task.find = () => ({
    sort: async () => occurrences,
  });
  Task.updateMany = async (filter, update) => {
    const matched = occurrences.filter(
      (occurrence) =>
        occurrence.recurrenceId === filter.recurrenceId &&
        occurrence.userId === filter.userId &&
        (filter.isCompleted === undefined ||
          occurrence.isCompleted === filter.isCompleted)
    );
    for (const occurrence of matched) {
      if (update.$set.repeat) occurrence.repeat = update.$set.repeat;
      if ("repeat.enabled" in update.$set) {
        occurrence.repeat.enabled = update.$set["repeat.enabled"];
      }
    }
    return { matchedCount: matched.length };
  };

  try {
    const result = await taskService.updateRecurringSeries(
      recurrenceId,
      userId,
      {
        enabled: true,
        frequency: "weekly",
        weekdays: [1, 3],
        interval: 2,
        endType: "never",
        timeZone: "Asia/Ho_Chi_Minh",
      }
    );
    assert.equal(result.active, true);
    assert.equal(completed.repeat.frequency, "daily");
    assert.equal(pending.repeat.frequency, "weekly");
    assert.equal(pending.repeat.anchorDate, "2026-11-02");
    assert.equal(pending.dueDate.toISOString(), "2026-11-03T03:00:00.000Z");
  } finally {
    Task.find = originalFind;
    Task.updateMany = originalUpdateMany;
  }
});

test("stopping a series preserves occurrence lineage and task history", async () => {
  const originalFind = Task.find;
  const originalUpdateMany = Task.updateMany;
  const recurrenceId = "507f1f77bcf86cd799439099";
  const userId = "507f1f77bcf86cd799439011";
  const completed = {
    recurrenceId,
    userId,
    occurrenceIndex: 1,
    isCompleted: true,
    repeat: { enabled: true, frequency: "daily" },
  };
  const pending = {
    recurrenceId,
    userId,
    occurrenceIndex: 2,
    isCompleted: false,
    repeat: { enabled: true, frequency: "daily" },
  };
  const occurrences = [completed, pending];
  Task.find = () => ({
    sort: async () => occurrences,
  });
  Task.updateMany = async (filter, update) => {
    const matched = occurrences.filter(
      (occurrence) =>
        occurrence.recurrenceId === filter.recurrenceId &&
        occurrence.userId === filter.userId &&
        (filter.isCompleted === undefined ||
          occurrence.isCompleted === filter.isCompleted)
    );
    for (const occurrence of matched) {
      if ("repeat.enabled" in update.$set) {
        occurrence.repeat.enabled = update.$set["repeat.enabled"];
      }
      if ("recurrenceStoppedAt" in update.$set) {
        occurrence.recurrenceStoppedAt = update.$set.recurrenceStoppedAt;
      }
    }
    return { matchedCount: matched.length };
  };

  try {
    const result = await taskService.deleteRecurringSeries(recurrenceId, userId);
    assert.equal(result.stopped, true);
    assert.equal(completed.repeat.enabled, true);
    assert.ok(completed.recurrenceStoppedAt instanceof Date);
    assert.equal(pending.repeat.enabled, false);
    assert.equal(completed.recurrenceId, recurrenceId);
    assert.equal(pending.recurrenceId, recurrenceId);
  } finally {
    Task.find = originalFind;
    Task.updateMany = originalUpdateMany;
  }
});
