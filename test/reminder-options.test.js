import assert from "node:assert/strict";
import test from "node:test";
import Task from "../src/models/task.model.js";
import {
  validateCreateTask,
  validateUpdateTask,
} from "../src/validators/task.validator.js";
import { calculateReminderDate } from "../src/utils/recurring-task.js";

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
  return { req, statusCode, response, continued };
}

const base = { title: "Reminder task", category: "Công việc" };

test("accepts every fixed reminder option and calendar month", () => {
  for (const minutes of [0, 5, 15, 30, 60, 120, 1440, 2880, 10080]) {
    const result = runValidation(validateCreateTask, {
      ...base,
      reminderMinutesBefore: minutes,
    });
    assert.equal(result.continued, true, String(minutes));
  }

  const month = runValidation(validateCreateTask, {
    ...base,
    reminderMonthsBefore: 1,
  });
  assert.equal(month.continued, true);
});

test("rejects invalid or ambiguous reminder values", () => {
  for (const body of [
    { reminderMinutesBefore: 7 },
    { reminderMinutesBefore: -1 },
    { reminderMonthsBefore: 2 },
    { reminderMinutesBefore: 60, reminderMonthsBefore: 1 },
  ]) {
    const result = runValidation(validateUpdateTask, body);
    assert.equal(result.statusCode, 400, JSON.stringify(body));
    assert.equal(result.continued, false);
  }
});

test("accepts the reported PATCH payload with attachments and disabled repeat", () => {
  const result = runValidation(validateUpdateTask, {
    reminderMinutesBefore: 0,
    reminderMonthsBefore: null,
    attachments: [
      {
        name: "photo.png",
        url: "https://res.cloudinary.com/example/image/upload/photo.png",
        publicId: "taskflow/users/user/photo",
        mimeType: "image/png",
        sizeBytes: 1234,
      },
    ],
    repeat: { enabled: false },
  });

  assert.equal(result.continued, true, JSON.stringify(result.response));
  assert.deepEqual(result.req.body.repeat, { enabled: false });
});

test("legacy tasks without reminders remain null and serializable", () => {
  const task = new Task({
    userId: "507f1f77bcf86cd799439011",
    title: "Legacy task",
    category: "Công việc",
  });
  assert.equal(task.validateSync(), undefined);
  const json = task.toJSON();
  assert.equal(json.reminderMinutesBefore, null);
  assert.equal(json.reminderMonthsBefore, null);
});

test("calendar month reminder clamps month-end in Vietnam time", () => {
  const cases = [
    ["2026-03-31T12:00:00.000Z", "2026-02-28T12:00:00.000Z"],
    ["2026-05-30T12:00:00.000Z", "2026-04-30T12:00:00.000Z"],
    ["2024-03-29T12:00:00.000Z", "2024-02-29T12:00:00.000Z"],
  ];

  for (const [dueDate, expected] of cases) {
    assert.equal(
      calculateReminderDate(dueDate, {
        reminderMonthsBefore: 1,
        timeZone: "Asia/Ho_Chi_Minh",
      }).toISOString(),
      expected,
    );
  }
});

test("fixed-minute reminder remains an instant subtraction", () => {
  assert.equal(
    calculateReminderDate("2026-11-25T07:30:00.000Z", {
      reminderMinutesBefore: 120,
    }).toISOString(),
    "2026-11-25T05:30:00.000Z",
  );
});
