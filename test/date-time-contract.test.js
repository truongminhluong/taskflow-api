import assert from "node:assert/strict";
import test from "node:test";
import Task from "../src/models/task.model.js";
import taskService from "../src/services/task.service.js";
import {
  validateCreateTask,
  validateUpdateTask,
} from "../src/validators/task.validator.js";

function runValidation(validator, body) {
  const req = { body: structuredClone(body) };
  let statusCode = 200;
  let response;
  let continued = false;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      response = value;
      return this;
    },
  };
  validator(req, res, () => {
    continued = true;
  });
  return { body: req.body, statusCode, response, continued };
}

const base = { title: "Contract task", category: "Công việc" };

test("accepts none, date, and dateTime contracts", () => {
  const none = runValidation(validateCreateTask, {
    ...base,
    dueDateType: "none",
    dueDate: null,
    dueDateDate: null,
    timeZoneId: null,
  });
  assert.equal(none.continued, true);

  const date = runValidation(validateCreateTask, {
    ...base,
    dueDateType: "date",
    dueDate: null,
    dueDateDate: "2026-11-25",
    timeZoneId: null,
  });
  assert.equal(date.continued, true);

  const dateTime = runValidation(validateCreateTask, {
    ...base,
    dueDateType: "dateTime",
    dueDate: "2026-11-25T07:30:00.000Z",
    dueDateDate: null,
    timeZoneId: "Asia/Ho_Chi_Minh",
  });
  assert.equal(dateTime.continued, true);
});

test("rejects inconsistent date/time combinations", () => {
  for (const body of [
    { dueDateType: "none", dueDate: "2026-11-25T00:00:00.000Z" },
    { dueDateType: "date", dueDateDate: "2026-02-30" },
    { dueDateType: "date", dueDateDate: "2026-11-25", dueDate: "2026-11-25T00:00:00.000Z" },
    { dueDateType: "dateTime", dueDate: "2026-11-25T07:30:00.000Z", timeZoneId: "Not/AZone" },
    { dueDateType: "unknown", dueDate: null, dueDateDate: null, timeZoneId: null },
  ]) {
    const result = runValidation(validateCreateTask, { ...base, ...body });
    assert.equal(result.statusCode, 400, result.response?.message);
    assert.equal(result.continued, false);
  }
});

test("legacy create timestamp is inferred as dateTime without midnight date conversion", () => {
  const result = runValidation(validateCreateTask, {
    ...base,
    dueDate: "2026-11-25T00:00:00.000Z",
  });
  assert.equal(result.continued, true);
  assert.equal(result.body.dueDateType, "dateTime");
  assert.equal(result.body.timeZoneId, "Asia/Ho_Chi_Minh");
});

test("legacy PATCH with only title leaves date fields untouched", () => {
  const result = runValidation(validateUpdateTask, { title: "Renamed" });
  assert.equal(result.continued, true);
  assert.equal("dueDateType" in result.body, false);
  assert.equal("dueDate" in result.body, false);
});

test("legacy PATCH dueDate null clears the date/time contract", () => {
  const result = runValidation(validateUpdateTask, { dueDate: null });
  assert.equal(result.continued, true);
  assert.deepEqual(result.body, {
    dueDate: null,
    dueDateType: "none",
    dueDateDate: null,
    timeZoneId: null,
  });
});

test("legacy PATCH timestamp is inferred as dateTime", () => {
  const result = runValidation(validateUpdateTask, {
    dueDate: "2026-11-25T07:30:00.000Z",
  });
  assert.equal(result.continued, true);
  assert.equal(result.body.dueDateType, "dateTime");
  assert.equal(result.body.timeZoneId, "Asia/Ho_Chi_Minh");
});

test("accepts strict ISO 8601 timestamps and rejects normalized dates", () => {
  for (const dueDate of [
    "2026-11-25T07:30:00.000Z",
    "2026-11-25T14:30:00+07:00",
  ]) {
    const result = runValidation(validateCreateTask, {
      ...base,
      dueDateType: "dateTime",
      dueDate,
      timeZoneId: "Asia/Ho_Chi_Minh",
      dueDateDate: null,
    });
    assert.equal(result.continued, true, dueDate);
  }

  for (const dueDate of [
    "2026-11-25T07:30:00",
    "2026/11/25 07:30:00Z",
    "2026-02-30T07:30:00.000Z",
    "2026-11-25T24:00:00.000Z",
    "2026-11-25T07:60:00.000Z",
    "2026-11-25T07:30:60.000Z",
    "2026-11-25T07:30:00+24:00",
  ]) {
    const result = runValidation(validateCreateTask, {
      ...base,
      dueDateType: "dateTime",
      dueDate,
      timeZoneId: "Asia/Ho_Chi_Minh",
      dueDateDate: null,
    });
    assert.equal(result.statusCode, 400, dueDate);
  }
});

test("task serialization infers legacy null and timestamp values safely", () => {
  const legacyNone = new Task({
    userId: "507f1f77bcf86cd799439011",
    title: "No date",
    category: "Công việc",
  }).toJSON();
  assert.equal(legacyNone.dueDateType, "none");
  assert.equal(legacyNone.dueDate, null);
  assert.equal(legacyNone.dueDateDate, null);

  const legacyDateTime = new Task({
    userId: "507f1f77bcf86cd799439011",
    title: "Legacy timestamp",
    category: "Công việc",
    dueDate: new Date("2026-11-25T00:00:00.000Z"),
  }).toJSON();
  assert.equal(legacyDateTime.dueDateType, "dateTime");
  assert.equal(legacyDateTime.dueDateDate, null);
  assert.equal(legacyDateTime.timeZoneId, "Asia/Ho_Chi_Minh");
});

test("new task schema stores explicit date-only fields", () => {
  const task = new Task({
    userId: "507f1f77bcf86cd799439011",
    title: "Date only",
    category: "Công việc",
    dueDateType: "date",
    dueDateDate: "2026-11-25",
  });
  assert.equal(task.validateSync(), undefined);
  assert.equal(task.dueDate, null);
  assert.equal(task.dueDateDate, "2026-11-25");
  assert.equal(task.toJSON().dueDateType, "date");
});

test("update service applies explicit date contract transitions without touching legacy PATCH fields", async () => {
  const originalFindOne = Task.findOne;
  const originalFindOneAndUpdate = Task.findOneAndUpdate;
  const currentTask = {
    _id: "507f1f77bcf86cd799439012",
    userId: "507f1f77bcf86cd799439011",
    dueDate: new Date("2026-11-25T07:30:00.000Z"),
    dueDateType: "dateTime",
    dueDateDate: null,
    timeZoneId: "Asia/Ho_Chi_Minh",
    isCompleted: false,
  };
  const updates = [];

  Task.findOne = async () => currentTask;
  Task.findOneAndUpdate = async (_filter, updateData) => {
    updates.push(updateData);
    return { ...currentTask, ...updateData };
  };

  try {
    await taskService.updateTask(currentTask._id, currentTask.userId, {
      dueDateType: "date",
      dueDate: null,
      dueDateDate: "2026-11-25",
      timeZoneId: null,
    });
    assert.equal(updates.at(-1).dueDate, null);
    assert.equal(updates.at(-1).dueDateDate, "2026-11-25");
    assert.equal(updates.at(-1).timeZoneId, null);

    await taskService.updateTask(currentTask._id, currentTask.userId, {
      dueDateType: "none",
      dueDate: null,
      dueDateDate: null,
      timeZoneId: null,
    });
    assert.equal(updates.at(-1).dueDateType, "none");
    assert.equal(updates.at(-1).dueDate, null);

    await taskService.updateTask(currentTask._id, currentTask.userId, {
      title: "Renamed",
    });
    assert.deepEqual(updates.at(-1), { title: "Renamed" });
  } finally {
    Task.findOne = originalFindOne;
    Task.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("repeat is rejected unless the final due date type is dateTime", async () => {
  const originalFindOne = Task.findOne;
  const currentTask = {
    _id: "507f1f77bcf86cd799439012",
    userId: "507f1f77bcf86cd799439011",
    dueDate: null,
    dueDateType: "none",
    isCompleted: false,
    recurrenceId: null,
  };
  Task.findOne = async () => currentTask;

  try {
    await assert.rejects(
      taskService.updateTask(currentTask._id, currentTask.userId, {
        repeat: {
          enabled: true,
          frequency: "daily",
          interval: 1,
          weekdays: [],
          endType: "never",
          timeZone: "Asia/Ho_Chi_Minh",
        },
      }),
      /dateTime/,
    );
  } finally {
    Task.findOne = originalFindOne;
  }
});
