import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import jwt from "jsonwebtoken";
import Task from "../src/models/task.model.js";
import app from "../src/app.js";

const userA = "507f1f77bcf86cd799439011";
const userB = "507f1f77bcf86cd799439012";
const jwtSecret = "test-jwt-secret-that-is-long-enough-123";
const originalFind = Task.find;
const originalFindOne = Task.findOne;
const originalFindOneAndUpdate = Task.findOneAndUpdate;
const originalCountDocuments = Task.countDocuments;
const originalJwtSecret = process.env.JWT_SECRET;
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
    isCompleted: false,
    completedAt: null,
    dueDate: null,
    createdAt: new Date(Date.UTC(2026, 0, 1)),
    updatedAt: new Date(Date.UTC(2026, 0, 1)),
    ...overrides,
  };
}

function matchesValue(documentValue, condition) {
  if (condition instanceof RegExp) {
    return condition.test(String(documentValue ?? ""));
  }

  if (condition && typeof condition === "object" && !(condition instanceof Date)) {
    if ("$regex" in condition) {
      return condition.$regex.test(String(documentValue ?? ""));
    }
    if ("$gte" in condition && !(documentValue >= condition.$gte)) return false;
    if ("$lt" in condition && !(documentValue < condition.$lt)) return false;
    if ("$ne" in condition && documentValue == null) return false;
    return true;
  }

  if (condition === null) return documentValue == null;
  return String(documentValue) === String(condition);
}

function matchesFilter(document, filter) {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$and") return condition.every((part) => matchesFilter(document, part));
    if (key === "$or") return condition.some((part) => matchesFilter(document, part));
    return matchesValue(document[key], condition);
  });
}

class FakeTaskQuery {
  constructor(filter) {
    this.filter = filter;
    this.sortFields = {};
    this.offset = 0;
    this.count = Number.MAX_SAFE_INTEGER;
  }

  sort(fields) {
    this.sortFields = fields;
    return this;
  }

  skip(value) {
    this.offset = value;
    return this;
  }

  limit(value) {
    this.count = value;
    return this;
  }

  then(resolve, reject) {
    try {
      const result = documents
        .filter((document) => matchesFilter(document, this.filter))
        .sort((first, second) => {
          for (const [field, direction] of Object.entries(this.sortFields)) {
            const a = first[field];
            const b = second[field];
            if (a == null && b == null) continue;
            if (a == null) return -1 * direction;
            if (b == null) return 1 * direction;
            const aValue = a instanceof Date ? a.getTime() : String(a);
            const bValue = b instanceof Date ? b.getTime() : String(b);
            if (aValue < bValue) return -1 * direction;
            if (aValue > bValue) return 1 * direction;
          }
          return 0;
        })
        .slice(this.offset, this.offset + this.count);
      return Promise.resolve(result).then(resolve, reject);
    } catch (error) {
      return Promise.reject(error).then(resolve, reject);
    }
  }
}

function tokenFor(userId = userA) {
  return jwt.sign({ userId }, jwtSecret, { algorithm: "HS256" });
}

async function getTasks(query = {}, { userId = userA, authenticated = true } = {}) {
  const url = new URL(`${baseUrl}/api/tasks`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  return fetch(url, {
    headers: authenticated ? { Authorization: `Bearer ${tokenFor(userId)}` } : {},
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
  Task.countDocuments = async (filter) =>
    documents.filter((document) => matchesFilter(document, filter)).length;
});

after(async () => {
  Task.find = originalFind;
  Task.findOne = originalFindOne;
  Task.findOneAndUpdate = originalFindOneAndUpdate;
  Task.countDocuments = originalCountDocuments;
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("defaults to page 1 and limit 20, paginates, and returns valid metadata", async () => {
  documents = Array.from({ length: 23 }, (_, index) => makeTask(index + 1));

  const firstResponse = await getTasks();
  const first = await firstResponse.json();
  assert.equal(firstResponse.status, 200);
  assert.equal(first.data.items.length, 20);
  assert.deepEqual(first.data.pagination, {
    page: 1,
    limit: 20,
    totalItems: 23,
    totalPages: 2,
    hasNextPage: true,
  });

  const lastResponse = await getTasks({ page: "2", limit: "20" });
  const last = await lastResponse.json();
  assert.equal(last.data.items.length, 3);
  assert.equal(last.data.pagination.hasNextPage, false);

  const pastEndResponse = await getTasks({ page: "3", limit: "20" });
  const pastEnd = await pastEndResponse.json();
  assert.deepEqual(pastEnd.data.items, []);
  assert.deepEqual(pastEnd.data.pagination, {
    page: 3,
    limit: 20,
    totalItems: 23,
    totalPages: 2,
    hasNextPage: false,
  });
});

test("returns empty pagination metadata when the authenticated user has no tasks", async () => {
  documents = [makeTask(1)];

  const response = await getTasks({}, { userId: userB });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.data, {
    items: [],
    pagination: {
      page: 1,
      limit: 20,
      totalItems: 0,
      totalPages: 0,
      hasNextPage: false,
    },
  });
});

test("rejects invalid pagination, limit over 50, unsupported sort, and unsafe query keys", async () => {
  for (const query of [
    { page: "0" },
    { page: "1.5" },
    { page: "999999999999999999999999" },
    { limit: "0" },
    { limit: "abc" },
    { limit: "51" },
    { sort: "random" },
    { userId: userB },
    { "page[$gt]": "0" },
  ]) {
    const response = await getTasks(query);
    assert.equal(response.status, 400, JSON.stringify(query));
  }
});

test("requires authentication for the task list", async () => {
  const response = await getTasks({}, { authenticated: false });
  assert.equal(response.status, 401);
});

test("sorts completed tasks by most recent completion time", async () => {
  documents = [
    makeTask(1, {
      isCompleted: true,
      completedAt: new Date("2026-10-01T00:00:00Z"),
    }),
    makeTask(2, {
      isCompleted: true,
      completedAt: new Date("2026-10-10T00:00:00Z"),
    }),
    makeTask(3, {
      isCompleted: true,
      completedAt: null,
      updatedAt: new Date("2026-10-05T00:00:00Z"),
    }),
  ];

  const body = await (
    await getTasks({ isCompleted: "true", sort: "completedAtDesc" })
  ).json();

  assert.deepEqual(
    body.data.items.map((task) => task._id),
    [makeTask(2)._id, makeTask(1)._id, makeTask(3)._id],
  );
});

test("records completion time on transition and preserves it when editing", async () => {
  documents = [makeTask(1)];
  Task.findOne = async (filter) => documents.find((task) => matchesFilter(task, filter)) ?? null;
  Task.findOneAndUpdate = async (filter, update) => {
    const task = documents.find((item) => matchesFilter(item, filter));
    if (!task) return null;
    Object.assign(task, update);
    return task;
  };

  const path = `/api/tasks/${makeTask(1)._id}`;
  const patch = (data) => fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${tokenFor()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });

  try {
    const completedResponse = await patch({ isCompleted: true });
    const completedBody = await completedResponse.json();
    assert.equal(completedResponse.status, 200);
    const completedAt = completedBody.data.completedAt;
    assert.ok(Number.isFinite(Date.parse(completedAt)));

    const editedResponse = await patch({ isCompleted: true, title: "Đã chỉnh sửa" });
    const editedBody = await editedResponse.json();
    assert.equal(editedBody.data.completedAt, completedAt);

    const reopenedResponse = await patch({ isCompleted: false });
    const reopenedBody = await reopenedResponse.json();
    assert.equal(reopenedBody.data.completedAt, null);
  } finally {
    Task.findOne = originalFindOne;
    Task.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("filters by isCompleted true and false", async () => {
  documents = [
    makeTask(1, { isCompleted: true }),
    makeTask(2, { isCompleted: false }),
    makeTask(3, { isCompleted: true }),
  ];

  const completed = await (await getTasks({ isCompleted: "true" })).json();
  const pending = await (await getTasks({ isCompleted: "false" })).json();

  assert.equal(completed.data.pagination.totalItems, 2);
  assert.deepEqual(completed.data.items.map((task) => task.isCompleted), [true, true]);
  assert.equal(pending.data.pagination.totalItems, 1);
  assert.equal(pending.data.items[0].isCompleted, false);
  assert.equal((await getTasks({ isCompleted: "yes" })).status, 400);
});

test("ranks title matches before description and category matches before paging", async () => {
  documents = [
    makeTask(1, {
      title: "Ôn tập Dart #2",
      description: "Đọc tài liệu",
      category: "Học tập",
      dueDate: new Date("2026-10-06T00:00:00+07:00"),
    }),
    makeTask(2, {
      title: "Kiểm thử chức năng",
      description: "Hoàn thiện công việc",
      category: "Học tập",
      dueDate: new Date("2026-10-09T00:00:00+07:00"),
    }),
    makeTask(3, {
      title: "Ôn tập Dart #102",
      description: "Đọc tài liệu",
      category: "Học tập",
      dueDate: new Date("2026-10-15T00:00:00+07:00"),
    }),
    makeTask(4, {
      title: "Việc khác",
      description: "Chi tiết khác",
      category: "Công việc",
      dueDate: new Date("2026-10-12T00:00:00+07:00"),
    }),
  ];

  const body = await (await getTasks({ search: "on", sort: "dueDateAsc" })).json();

  assert.deepEqual(
    body.data.items.map((task) => task.title),
    ["Ôn tập Dart #2", "Ôn tập Dart #102", "Kiểm thử chức năng", "Việc khác"],
  );
});

test("ranks title word matches above incidental title substrings", async () => {
  documents = [
    makeTask(1, {
      title: "Kiểm thử chức năng công việc #95",
      description: "Hoàn thiện kế hoạch",
      category: "Học tập",
      dueDate: new Date("2026-10-05T00:00:00+07:00"),
    }),
    makeTask(2, {
      title: "Ôn tập Dart #2",
      description: "Đọc tài liệu",
      category: "Học tập",
      dueDate: new Date("2026-10-06T00:00:00+07:00"),
    }),
    makeTask(3, {
      title: "Ôn tập Dart #102",
      description: "Đọc tài liệu",
      category: "Học tập",
      dueDate: new Date("2026-10-15T00:00:00+07:00"),
    }),
  ];

  const body = await (await getTasks({ search: "on", sort: "dueDateAsc" })).json();

  assert.deepEqual(
    body.data.items.map((task) => task.title),
    ["Ôn tập Dart #2", "Ôn tập Dart #102", "Kiểm thử chức năng công việc #95"],
  );
});

test("searches title, description, and category case- and Vietnamese-diacritic-insensitively", async () => {
  documents = [
    makeTask(1, { title: "Báo cáo tuần" }),
    makeTask(2, { description: "Chuẩn bị tài liệu họp" }),
    makeTask(3, { category: "Cá nhân" }),
    makeTask(4, { title: "Khác" }),
  ];

  for (const search of ["BAO CAO", "TAI LIEU", "CA NHAN"]) {
    const body = await (await getTasks({ search })).json();
    assert.equal(body.data.pagination.totalItems, 1, search);
  }

  const diacritics = await (await getTasks({ search: "báo cáo" })).json();
  assert.equal(diacritics.data.items[0].title, "Báo cáo tuần");
  const escapedSearch = await (await getTasks({ search: ".*" })).json();
  assert.equal(escapedSearch.data.pagination.totalItems, 0);
});

test("includes dueFrom, excludes dueBefore, and excludes tasks without dueDate", async () => {
  documents = [
    makeTask(1, { dueDate: new Date("2026-11-01T00:00:00+07:00") }),
    makeTask(2, { dueDate: new Date("2026-11-15T12:00:00+07:00") }),
    makeTask(3, { dueDate: new Date("2026-12-01T00:00:00+07:00") }),
    makeTask(4, { dueDate: null }),
  ];

  const response = await getTasks({
    dueFrom: "2026-11-01T00:00:00+07:00",
    dueBefore: "2026-12-01T00:00:00+07:00",
    sort: "createdAtAsc",
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.pagination.totalItems, 2);
  assert.deepEqual(body.data.items.map((task) => task._id), [makeTask(1)._id, makeTask(2)._id]);
});

test("validates ISO dates and requires dueFrom to precede dueBefore", async () => {
  assert.equal((await getTasks({ dueFrom: "2026-02-30T00:00:00+07:00" })).status, 400);
  assert.equal((await getTasks({ dueBefore: "tomorrow" })).status, 400);
  assert.equal((await getTasks({
    dueFrom: "2026-11-02T00:00:00+07:00",
    dueBefore: "2026-11-01T00:00:00+07:00",
  })).status, 400);
});

test("combines user, search, completion, and date filters before counting", async () => {
  documents = [
    makeTask(1, {
      title: "Báo cáo tuần",
      isCompleted: false,
      dueDate: new Date("2026-11-02T00:00:00+07:00"),
    }),
    makeTask(2, {
      title: "Báo cáo cũ",
      isCompleted: true,
      dueDate: new Date("2026-11-02T00:00:00+07:00"),
    }),
    makeTask(3, {
      title: "Báo cáo khác user",
      userId: userB,
      dueDate: new Date("2026-11-02T00:00:00+07:00"),
    }),
  ];

  const body = await (await getTasks({
    search: "bao cao",
    isCompleted: "false",
    dueFrom: "2026-11-01T00:00:00+07:00",
    dueBefore: "2026-11-03T00:00:00+07:00",
  })).json();

  assert.equal(body.data.pagination.totalItems, 1);
  assert.equal(body.data.items[0].title, "Báo cáo tuần");
});

test("supports stable createdAt sorting in both directions", async () => {
  const sameDate = new Date("2026-11-01T00:00:00Z");
  documents = [
    makeTask(1, { createdAt: sameDate }),
    makeTask(2, { createdAt: sameDate }),
    makeTask(3, { createdAt: new Date("2026-10-01T00:00:00Z") }),
  ];

  const descending = await (await getTasks({ sort: "createdAtDesc" })).json();
  const ascending = await (await getTasks({ sort: "createdAtAsc" })).json();

  assert.deepEqual(descending.data.items.map((task) => task._id), [makeTask(2)._id, makeTask(1)._id, makeTask(3)._id]);
  assert.deepEqual(ascending.data.items.map((task) => task._id), [makeTask(3)._id, makeTask(1)._id, makeTask(2)._id]);
});

test("sorts pending tasks by priority, due date, and recency for undated tasks", async () => {
  documents = [
    makeTask(1, {
      priority: "low",
      updatedAt: new Date("2026-11-10T00:00:00Z"),
    }),
    makeTask(2, {
      priority: "medium",
      dueDate: new Date("2026-11-04T00:00:00Z"),
    }),
    makeTask(3, {
      priority: "high",
      dueDate: new Date("2026-11-08T00:00:00Z"),
    }),
    makeTask(4, {
      priority: "high",
      dueDate: null,
      updatedAt: new Date("2026-11-12T00:00:00Z"),
    }),
    makeTask(5, {
      priority: "high",
      dueDate: new Date("2026-11-02T00:00:00Z"),
    }),
    makeTask(6, {
      priority: "medium",
      dueDate: null,
      updatedAt: new Date("2026-11-11T00:00:00Z"),
    }),
    makeTask(7, { priority: "low", dueDate: new Date("2026-11-01T00:00:00Z") }),
  ];

  const response = await (await getTasks({
    isCompleted: "false",
    sort: "priorityDueDateAsc",
  })).json();

  assert.deepEqual(
    response.data.items.map((task) => task._id),
    [makeTask(5)._id, makeTask(3)._id, makeTask(4)._id, makeTask(2)._id, makeTask(6)._id, makeTask(7)._id, makeTask(1)._id],
  );
});

test("sorts due dates stably and places null dueDate tasks last in both directions", async () => {
  const early = new Date("2026-11-01T00:00:00Z");
  const late = new Date("2026-11-10T00:00:00Z");
  documents = [
    makeTask(1, { dueDate: late }),
    makeTask(2, { dueDate: early }),
    makeTask(3, { dueDate: early }),
    makeTask(4, { dueDate: null }),
  ];

  const ascending = await (await getTasks({ sort: "dueDateAsc" })).json();
  const descending = await (await getTasks({ sort: "dueDateDesc" })).json();

  assert.deepEqual(ascending.data.items.map((task) => task._id), [makeTask(2)._id, makeTask(3)._id, makeTask(1)._id, makeTask(4)._id]);
  assert.deepEqual(descending.data.items.map((task) => task._id), [makeTask(1)._id, makeTask(2)._id, makeTask(3)._id, makeTask(4)._id]);
});
