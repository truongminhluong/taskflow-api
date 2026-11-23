import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import jwt from "jsonwebtoken";
import Task from "../src/models/task.model.js";
import app from "../src/app.js";

const userA = "507f1f77bcf86cd799439011";
const userB = "507f1f77bcf86cd799439012";
const jwtSecret = "test-jwt-secret-that-is-long-enough-123";
const originalFind = Task.find;
const originalAggregate = Task.aggregate;
let server;
let baseUrl;
let documents = [];

function makeTask(index, overrides = {}) {
  return {
    _id: index.toString(16).padStart(24, "0"),
    userId: userA,
    title: `Task ${index}`,
    description: "",
    category: "Công việc",
    priority: "medium",
    isCompleted: false,
    dueDate: null,
    reminderMinutesBefore: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    ...overrides,
  };
}

function matchesFilter(document, filter) {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$and") return condition.every((part) => matchesFilter(document, part));
    if (key === "$or") return condition.some((part) => matchesFilter(document, part));
    if (key === "userId") return document.userId === condition;
    if (key === "isCompleted") return document.isCompleted === condition;
    if (key === "dueDate") {
      if (document.dueDate == null || document.dueDate < condition.$gte) {
        return false;
      }
      return condition.$lt === undefined || document.dueDate < condition.$lt;
    }
    if (key === "dueDateDate") {
      if (typeof condition === "string") return document.dueDateDate === condition;
      if (condition.$gt !== undefined) {
        return document.dueDateDate != null && document.dueDateDate > condition.$gt;
      }
    }
    return true;
  });
}

class FakeTaskQuery {
  constructor(filter) {
    this.filter = filter;
    this.limitValue = Number.MAX_SAFE_INTEGER;
    this.sortFields = {};
  }

  select() { return this; }
  sort(fields) { this.sortFields = fields; return this; }
  limit(value) { this.limitValue = value; return this; }

  then(resolve, reject) {
    try {
      const result = documents
        .filter((document) => matchesFilter(document, this.filter))
        .sort((a, b) => {
          const dateDiff = (a.dueDate?.getTime() ?? 0) - (b.dueDate?.getTime() ?? 0);
          return dateDiff || String(a._id).localeCompare(String(b._id));
        })
        .slice(0, this.limitValue);
      return Promise.resolve(result).then(resolve, reject);
    } catch (error) {
      return Promise.reject(error).then(resolve, reject);
    }
  }
}

function tokenFor(userId = userA) {
  return jwt.sign({ userId }, jwtSecret, { algorithm: "HS256" });
}

async function getOverview(query = {}, userId = userA) {
  const url = new URL(`${baseUrl}/api/tasks/overview`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return fetch(url, {
    headers: { Authorization: `Bearer ${tokenFor(userId)}` },
  });
}

before(async () => {
  process.env.JWT_SECRET = jwtSecret;
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  Task.find = (filter) => new FakeTaskQuery(filter);
  Task.aggregate = async ([stage]) => {
    const matched = documents.filter((document) => matchesFilter(document, stage.$match));
    return [
      ...new Set(matched.map((document) => document.isCompleted)),
    ].map((isCompleted) => ({
      _id: isCompleted,
      count: matched.filter((document) => document.isCompleted === isCompleted).length,
    }));
  };
});

after(async () => {
  Task.find = originalFind;
  Task.aggregate = originalAggregate;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("returns exact summary, all today tasks, and three upcoming tasks", async () => {
  documents = [
    makeTask(1, { dueDate: new Date("2026-11-03T18:00:00Z") }),
    makeTask(2, { dueDate: new Date("2026-11-04T01:00:00Z"), isCompleted: true, reminderMinutesBefore: 5 }),
    makeTask(3, { dueDate: new Date("2026-11-04T20:00:00Z") }),
    makeTask(4, { dueDate: new Date("2026-11-05T01:00:00Z") }),
    makeTask(5, { dueDate: new Date("2026-11-06T01:00:00Z") }),
    makeTask(6, { dueDate: new Date("2026-11-07T01:00:00Z") }),
    makeTask(7, { dueDate: new Date("2026-11-08T01:00:00Z") }),
    makeTask(8, { dueDate: null }),
  ];

  const response = await getOverview({ date: "2026-11-04", timeZone: "Asia/Ho_Chi_Minh" });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.data.summary, { total: 2, completed: 1, pending: 1 });
  assert.equal(body.data.todayTasks.length, 2);
  assert.deepEqual(body.data.upcomingTasks.map((task) => task._id), [
    makeTask(3)._id,
    makeTask(4)._id,
    makeTask(5)._id,
  ]);
  assert.equal(
    body.data.todayTasks.find((task) => task._id === makeTask(2)._id)
      .reminderMinutesBefore,
    5,
  );
});

test("isolates user data and validates date and timezone", async () => {
  documents = [makeTask(1, { dueDate: new Date("2026-11-04T01:00:00Z") }), makeTask(2, { userId: userB, dueDate: new Date("2026-11-04T01:00:00Z") })];

  const response = await getOverview({ date: "2026-02-30", timeZone: "Asia/Ho_Chi_Minh" });
  assert.equal(response.status, 400);

  const timezoneResponse = await getOverview({ date: "2026-11-04", timeZone: "Not/AZone" });
  assert.equal(timezoneResponse.status, 400);

  const validResponse = await getOverview({ date: "2026-11-04", timeZone: "Asia/Ho_Chi_Minh" }, userA);
  const body = await validResponse.json();
  assert.deepEqual(body.data.todayTasks.map((task) => task._id), [makeTask(1)._id]);
});

test("uses exact local-day boundaries and returns more than twenty today tasks", async () => {
  documents = [
    ...Array.from({ length: 21 }, (_, index) =>
      makeTask(index + 1, {
        dueDate: new Date(`2026-11-03T17:${String(index).padStart(2, "0")}:00Z`),
      }),
    ),
    makeTask(30, { dueDate: new Date("2026-11-04T17:00:00Z") }),
  ];

  const response = await getOverview({ date: "2026-11-04", timeZone: "Asia/Ho_Chi_Minh" });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.todayTasks.length, 21);
  assert.equal(body.data.summary.total, 21);
  assert.deepEqual(body.data.upcomingTasks.map((task) => task._id), [makeTask(30)._id]);
});

test("derives summary from all incomplete today tasks", async () => {
  documents = [
    makeTask(1, { dueDate: new Date("2026-11-04T01:00:00Z") }),
    makeTask(2, { dueDate: new Date("2026-11-04T02:00:00Z") }),
    makeTask(3, { dueDate: new Date("2026-11-04T03:00:00Z") }),
  ];

  const body = await (await getOverview({ date: "2026-11-04" })).json();
  assert.deepEqual(body.data.summary, { total: 3, completed: 0, pending: 3 });
});

test("derives summary from all completed today tasks", async () => {
  documents = [
    makeTask(1, { dueDate: new Date("2026-11-04T01:00:00Z"), isCompleted: true }),
    makeTask(2, { dueDate: new Date("2026-11-04T02:00:00Z"), isCompleted: true }),
    makeTask(3, { dueDate: new Date("2026-11-04T03:00:00Z"), isCompleted: true }),
  ];

  const body = await (await getOverview({ date: "2026-11-04" })).json();
  assert.deepEqual(body.data.summary, { total: 3, completed: 3, pending: 0 });
});

test("returns an empty summary when there are no tasks today", async () => {
  documents = [makeTask(1, { dueDate: new Date("2026-11-05T01:00:00Z") })];

  const body = await (await getOverview({ date: "2026-11-04" })).json();
  assert.deepEqual(body.data.summary, { total: 0, completed: 0, pending: 0 });
  assert.equal(body.data.todayTasks.length, 0);
});

test("classifies date-only tasks in today and upcoming without UTC conversion", async () => {
  documents = [
    makeTask(1, { dueDateType: "date", dueDateDate: "2026-11-23" }),
    makeTask(2, { dueDateType: "date", dueDateDate: "2026-11-24" }),
    makeTask(3, { dueDateType: "none", dueDate: null }),
    makeTask(4, { dueDate: new Date("2026-11-22T17:30:00Z") }),
  ];

  const body = await (await getOverview({
    date: "2026-11-23",
    timeZone: "Asia/Ho_Chi_Minh",
  })).json();
  assert.deepEqual(body.data.summary, { total: 2, completed: 0, pending: 2 });
  assert.deepEqual(body.data.todayTasks.map((task) => task._id), [
    makeTask(1)._id,
    makeTask(4)._id,
  ]);
  assert.deepEqual(body.data.upcomingTasks.map((task) => task._id), [makeTask(2)._id]);
  assert.equal(body.data.todayTasks[0].dueDateDate, "2026-11-23");
});
