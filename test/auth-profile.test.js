import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";
import User from "../src/models/user.model.js";
import app from "../src/app.js";

const userId = "507f1f77bcf86cd799439011";
const jwtSecret = "test-jwt-secret-that-is-long-enough-123";
const originalFindByIdAndUpdate = User.findByIdAndUpdate;
let server;
let baseUrl;
let savedUpdate;

function tokenForUser() {
  return jwt.sign({ userId }, jwtSecret, { algorithm: "HS256" });
}

async function request(body, { authenticated = true } = {}) {
  return fetch(`${baseUrl}/api/auth/me`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(authenticated
        ? { Authorization: `Bearer ${tokenForUser()}` }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

after(async () => {
  User.findByIdAndUpdate = originalFindByIdAndUpdate;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("PATCH /api/auth/me updates name for the authenticated user", async () => {
  User.findByIdAndUpdate = async (id, update, options) => {
    savedUpdate = { id, update, options };
    return {
      _id: id,
      name: update.$set.name,
      email: "tester@example.test",
    };
  };

  const response = await request({ name: "  Nguyễn An  " });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(savedUpdate.id, userId);
  assert.deepEqual(savedUpdate.update, { $set: { name: "Nguyễn An" } });
  assert.equal(savedUpdate.options.runValidators, true);
  assert.deepEqual(body.data.user, {
    id: userId,
    name: "Nguyễn An",
    email: "tester@example.test",
  });
});

test("PATCH /api/auth/me requires a valid JWT", async () => {
  const response = await request({ name: "Nguyễn An" }, { authenticated: false });

  assert.equal(response.status, 401);
});

test("PATCH /api/auth/me rejects invalid names and unsupported fields", async () => {
  for (const invalidBody of [
    { name: "   " },
    { name: "a".repeat(101) },
    { name: "Nguyễn An", email: "new@example.test" },
  ]) {
    const response = await request(invalidBody);
    assert.equal(response.status, 400);
  }
});
