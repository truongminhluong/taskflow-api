import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import net from "node:net";
import { after, before, beforeEach, test } from "node:test";
import bcrypt from "bcryptjs";
import User from "../src/models/user.model.js";
import app from "../src/app.js";
import { sendPasswordResetOtpEmail } from "../src/config/mail.js";
import * as authService from "../src/services/auth.service.js";

const userId = "507f1f77bcf86cd799439011";
const SMTP_ENVIRONMENT_KEYS = [
  "MAIL_HOST",
  "MAIL_PORT",
  "MAIL_USER",
  "MAIL_PASSWORD",
  "MAIL_FROM",
];
const originalEnvironment = Object.fromEntries(
  SMTP_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]])
);
const originalJwtSecret = process.env.JWT_SECRET;
const originalFindOne = User.findOne;
const originalFindById = User.findById;
const originalUpdateOne = User.updateOne;
const originalTrustProxy = app.get("trust proxy");

let state;
let server;
let baseUrl;
let requestId = 0;

function makeQuery(result) {
  const query = Promise.resolve(result);
  query.select = () => query;
  return query;
}

function setSmtpEnvironment(port, rejectAuthentication = false) {
  process.env.MAIL_HOST = "127.0.0.1";
  process.env.MAIL_PORT = String(port);
  process.env.MAIL_USER = "test-user";
  process.env.MAIL_PASSWORD = rejectAuthentication
    ? "incorrect-password"
    : "test-password";
  process.env.MAIL_FROM = "TaskFlow Test <taskflow@example.test>";
}

function decodeMessage(message) {
  return message
    .split(/--[^\r\n]+/)
    .map((part) => {
      const separator = part.indexOf("\r\n\r\n");
      if (separator < 0) return "";

      const headers = part.slice(0, separator);
      const body = part.slice(separator + 4).replace(/=\r\n/g, "");
      if (/content-transfer-encoding:\s*base64/i.test(headers)) {
        return Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8");
      }

      if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
        const bytes = [];
        for (let index = 0; index < body.length; index += 1) {
          if (
            body[index] === "=" &&
            /^[a-f\d]{2}$/i.test(body.slice(index + 1, index + 3))
          ) {
            bytes.push(Number.parseInt(body.slice(index + 1, index + 3), 16));
            index += 2;
          } else {
            bytes.push(body.charCodeAt(index));
          }
        }
        return new TextDecoder().decode(new Uint8Array(bytes));
      }

      return body;
    })
    .join("\n");
}

function extractOtp(message) {
  return decodeMessage(message).match(/\b\d{6}\b/)?.[0];
}

async function startFakeSmtpServer({ rejectAuthentication = false } = {}) {
  const messages = [];
  const smtpServer = net.createServer((socket) => {
    let buffered = "";
    let inData = false;
    let dataLines = [];
    let authStep = 0;
    socket.write("220 localhost ESMTP\r\n");

    socket.on("data", (chunk) => {
      buffered += chunk.toString();

      while (buffered.includes("\r\n")) {
        const lineEnd = buffered.indexOf("\r\n");
        const line = buffered.slice(0, lineEnd);
        buffered = buffered.slice(lineEnd + 2);

        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push(dataLines.join("\r\n"));
            dataLines = [];
            socket.write("250 2.0.0 Message accepted\r\n");
          } else {
            dataLines.push(line.startsWith("..") ? line.slice(1) : line);
          }
          continue;
        }

        const command = line.toUpperCase();
        if (command.startsWith("EHLO ") || command.startsWith("HELO ")) {
          socket.write("250-localhost\r\n250 AUTH LOGIN\r\n");
        } else if (command.startsWith("AUTH LOGIN")) {
          authStep = line.trim().split(/\s+/).length > 2 ? 2 : 1;
          socket.write(
            authStep === 1
              ? "334 VXNlcm5hbWU6\r\n"
              : "334 UGFzc3dvcmQ6\r\n"
          );
        } else if (authStep === 1) {
          authStep = 2;
          socket.write("334 UGFzc3dvcmQ6\r\n");
        } else if (authStep === 2) {
          authStep = 0;
          socket.write(
            rejectAuthentication
              ? "535 5.7.8 Authentication credentials invalid\r\n"
              : "235 2.7.0 Authentication successful\r\n"
          );
        } else if (command.startsWith("MAIL FROM:")) {
          socket.write("250 2.1.0 Sender accepted\r\n");
        } else if (command.startsWith("RCPT TO:")) {
          socket.write("250 2.1.5 Recipient accepted\r\n");
        } else if (command === "DATA") {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (command === "QUIT") {
          socket.write("221 2.0.0 Bye\r\n");
          socket.end();
        } else {
          socket.write("250 2.0.0 OK\r\n");
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    smtpServer.once("error", reject);
    smtpServer.listen(0, "127.0.0.1", resolve);
  });

  return {
    port: smtpServer.address().port,
    messages,
    close: () =>
      new Promise((resolve, reject) => {
        smtpServer.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function request(path, { method = "POST", body, headers = {} } = {}) {
  requestId += 1;
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "X-Forwarded-For": `192.0.2.${(requestId % 250) + 1}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

before(async () => {
  for (const key of SMTP_ENVIRONMENT_KEYS) delete process.env[key];
  process.env.JWT_SECRET = "test-jwt-secret-that-is-long-enough-123";
  app.set("trust proxy", 1);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  state = {
    userExists: false,
    resetOtpHash: null,
    resetOtpExpires: null,
    resetOtpAttempts: 0,
    resetOtpSentAt: null,
    resetTokenHash: null,
    resetTokenExpires: null,
    passwordHash: null,
    writes: [],
  };

  User.findOne = (filter) => {
    const user =
      filter.email && state.userExists
        ? {
            _id: userId,
            name: "Test User",
            email: "tester@example.test",
            password: state.passwordHash,
          }
        : null;
    return makeQuery(user);
  };

  User.findById = async (id) =>
    id === userId && state.userExists
      ? { _id: userId, name: "Test User", email: "tester@example.test" }
      : null;

  User.updateOne = async (filter, update) => {
    state.writes.push({ filter, update });

    if (filter._id === userId && filter.$or) {
      const [, cooldownEnded] = filter.$or;
      const allowed =
        state.resetOtpSentAt === null ||
        state.resetOtpSentAt <= cooldownEnded.resetOtpSentAt.$lte;
      if (!state.userExists || !allowed) return { matchedCount: 0 };

      state.resetOtpHash = update.$set.resetOtpHash;
      state.resetOtpExpires = update.$set.resetOtpExpires;
      state.resetOtpAttempts = update.$set.resetOtpAttempts;
      state.resetOtpSentAt = update.$set.resetOtpSentAt;
      state.resetTokenHash = null;
      state.resetTokenExpires = null;
      return { matchedCount: 1 };
    }

    if (
      filter._id === userId &&
      filter.resetOtpHash === state.resetOtpHash &&
      update.$unset?.resetOtpHash
    ) {
      state.resetOtpHash = null;
      state.resetOtpExpires = null;
      state.resetOtpSentAt = null;
      state.resetOtpAttempts = 0;
      return { matchedCount: 1 };
    }

    if (
      filter.email === "tester@example.test" &&
      typeof filter.resetOtpHash === "string" &&
      filter.resetOtpHash === state.resetOtpHash &&
      state.resetOtpExpires > filter.resetOtpExpires?.$gt &&
      state.resetOtpAttempts < filter.resetOtpAttempts?.$lt
    ) {
      state.resetTokenHash = update.$set.resetTokenHash;
      state.resetTokenExpires = update.$set.resetTokenExpires;
      state.resetOtpHash = null;
      state.resetOtpExpires = null;
      state.resetOtpAttempts = 0;
      return { matchedCount: 1 };
    }

    if (
      filter.email === "tester@example.test" &&
      filter.resetOtpHash?.$ne &&
      filter.resetOtpHash.$ne !== state.resetOtpHash &&
      state.resetOtpExpires > filter.resetOtpExpires?.$gt &&
      state.resetOtpAttempts < filter.resetOtpAttempts?.$lt
    ) {
      state.resetOtpAttempts += update.$inc.resetOtpAttempts;
      return { matchedCount: 1 };
    }

    if (
      filter.email === "tester@example.test" &&
      filter.resetTokenHash === state.resetTokenHash &&
      state.resetTokenExpires > filter.resetTokenExpires?.$gt &&
      state.userExists
    ) {
      state.passwordHash = update.$set.password;
      state.resetOtpHash = null;
      state.resetOtpExpires = null;
      state.resetOtpAttempts = 0;
      state.resetOtpSentAt = null;
      state.resetTokenHash = null;
      state.resetTokenExpires = null;
      return { matchedCount: 1 };
    }

    return { matchedCount: 0 };
  };
});

after(async () => {
  User.findOne = originalFindOne;
  User.findById = originalFindById;
  User.updateOne = originalUpdateOne;
  app.set("trust proxy", originalTrustProxy);

  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;

  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("forgot-password sends a 6-digit OTP and stores only its SHA-256 hash", async () => {
  const smtp = await startFakeSmtpServer();
  setSmtpEnvironment(smtp.port);
  state.userExists = true;

  try {
    const response = await request("/api/auth/forgot-password", {
      body: { email: " TESTER@EXAMPLE.TEST " },
    });
    assert.equal(response.status, 200);
    const responseBody = await response.json();
    assert.deepEqual(responseBody, {
      message: "Nếu email tồn tại, mã xác thực sẽ được gửi.",
    });

    const message = smtp.messages[0];
    const otp = extractOtp(message);
    assert.match(otp, /^\d{6}$/);
    assert.match(decodeMessage(message), /Mã xác thực đặt lại mật khẩu TaskFlow/);
    assert.match(decodeMessage(message), /5 phút/);
    assert.match(decodeMessage(message), /Không chia sẻ mã OTP/);
    assert.match(message, /text\/plain/i);
    assert.match(message, /text\/html/i);
    assert.equal(state.resetOtpHash, createHash("sha256").update(otp).digest("hex"));
    assert.notEqual(state.resetOtpHash, otp);
    assert.equal(state.resetOtpAttempts, 0);
    assert.ok(
      Math.abs(state.resetOtpExpires.getTime() - (Date.now() + 5 * 60_000)) <
        2_000
    );
    assert.equal(JSON.stringify(responseBody).includes(otp), false);
    assert.equal(decodeMessage(message).includes("reset-password?token="), false);
  } finally {
    await smtp.close();
  }
});

test("unknown email gets the same generic response and no email is sent", async () => {
  const smtp = await startFakeSmtpServer();
  setSmtpEnvironment(smtp.port);

  try {
    const response = await request("/api/auth/forgot-password", {
      body: { email: "unknown@example.test" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      message: "Nếu email tồn tại, mã xác thực sẽ được gửi.",
    });
    assert.equal(smtp.messages.length, 0);
  } finally {
    await smtp.close();
  }
});

test("forgot-password applies an atomic resend cooldown and allows resend after cooldown", async () => {
  const smtp = await startFakeSmtpServer();
  setSmtpEnvironment(smtp.port);
  state.userExists = true;

  try {
    const first = await request("/api/auth/forgot-password", {
      body: { email: "tester@example.test" },
    });
    assert.equal(first.status, 200);
    const firstOtp = extractOtp(smtp.messages[0]);
    const firstHash = state.resetOtpHash;

    const throttled = await request("/api/auth/forgot-password", {
      body: { email: "tester@example.test" },
    });
    assert.equal(throttled.status, 200);
    assert.equal(smtp.messages.length, 1);
    assert.equal(state.resetOtpHash, firstHash);

    state.resetOtpSentAt = new Date(Date.now() - 61_000);
    const resent = await request("/api/auth/forgot-password", {
      body: { email: "tester@example.test" },
    });
    assert.equal(resent.status, 200);
    assert.equal(smtp.messages.length, 2);
    const secondOtp = extractOtp(smtp.messages[1]);
    assert.notEqual(secondOtp, firstOtp);
    assert.notEqual(state.resetOtpHash, firstHash);
    assert.equal(state.resetOtpAttempts, 0);

    const oldOtpResponse = await request("/api/auth/verify-reset-otp", {
      body: { email: "tester@example.test", otp: firstOtp },
    });
    assert.equal(oldOtpResponse.status, 400);
    const currentOtpResponse = await request("/api/auth/verify-reset-otp", {
      body: { email: "tester@example.test", otp: secondOtp },
    });
    assert.equal(currentOtpResponse.status, 200);
  } finally {
    await smtp.close();
  }
});

test("verify-reset-otp consumes a valid OTP and returns a short-lived reset token once", async () => {
  const smtp = await startFakeSmtpServer();
  setSmtpEnvironment(smtp.port);
  state.userExists = true;

  try {
    await request("/api/auth/forgot-password", {
      body: { email: "tester@example.test" },
    });
    const otp = extractOtp(smtp.messages[0]);
    const response = await request("/api/auth/verify-reset-otp", {
      body: { email: " TESTER@example.test ", otp },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    const { resetToken } = body.data;
    assert.match(resetToken, /^[a-f\d]{64}$/);
    assert.equal(JSON.stringify(body).includes(otp), false);
    assert.equal(state.resetTokenHash, createHash("sha256").update(resetToken).digest("hex"));
    assert.notEqual(state.resetTokenHash, resetToken);
    assert.ok(
      Math.abs(state.resetTokenExpires.getTime() - (Date.now() + 10 * 60_000)) <
        2_000
    );
    assert.equal(state.resetOtpHash, null);

    const reused = await request("/api/auth/verify-reset-otp", {
      body: { email: "tester@example.test", otp },
    });
    assert.equal(reused.status, 400);
  } finally {
    await smtp.close();
  }
});

test("concurrent OTP verification consumes the OTP only once", async () => {
  const otp = "654321";
  state.userExists = true;
  state.resetOtpHash = createHash("sha256").update(otp).digest("hex");
  state.resetOtpExpires = new Date(Date.now() + 60_000);
  state.resetOtpSentAt = new Date();
  const results = await Promise.allSettled([
    authService.verifyResetOtp("tester@example.test", otp),
    authService.verifyResetOtp("tester@example.test", otp),
  ]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  assert.equal(state.resetOtpHash, null);
});

test("invalid OTP increments attempt count and blocks after five failures", async () => {
  const smtp = await startFakeSmtpServer();
  setSmtpEnvironment(smtp.port);
  state.userExists = true;

  try {
    await request("/api/auth/forgot-password", {
      body: { email: "tester@example.test" },
    });
    const wrongOtp = extractOtp(smtp.messages[0]) === "000000" ? "000001" : "000000";

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await request("/api/auth/verify-reset-otp", {
        body: { email: "tester@example.test", otp: wrongOtp },
      });
      assert.equal(response.status, 400);
      assert.equal(state.resetOtpAttempts, attempt);
    }

    const correctOtpAfterLimit = await request("/api/auth/verify-reset-otp", {
      body: { email: "tester@example.test", otp: extractOtp(smtp.messages[0]) },
    });
    assert.equal(correctOtpAfterLimit.status, 400);
    assert.equal(state.resetOtpAttempts, 5);
  } finally {
    await smtp.close();
  }
});

test("expired OTP and invalid request bodies are rejected", async () => {
  state.userExists = true;
  state.resetOtpHash = createHash("sha256").update("123456").digest("hex");
  state.resetOtpExpires = new Date(Date.now() - 1_000);
  state.resetOtpAttempts = 0;

  const expired = await request("/api/auth/verify-reset-otp", {
    body: { email: "tester@example.test", otp: "123456" },
  });
  assert.equal(expired.status, 400);

  for (const body of [
    {},
    { email: null, otp: "123456" },
    { email: "bad", otp: "123456" },
    { email: "tester@example.test", otp: "12345" },
    { email: "tester@example.test", otp: 123456 },
  ]) {
    const response = await request("/api/auth/verify-reset-otp", { body });
    assert.equal(response.status, 400);
  }
});

test("SMTP failure removes the saved OTP and matches the public generic response", async () => {
  const smtp = await startFakeSmtpServer({ rejectAuthentication: true });
  setSmtpEnvironment(smtp.port, true);
  state.userExists = true;
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);

  try {
    const response = await request("/api/auth/forgot-password", {
      body: { email: "tester@example.test" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      message: "Nếu email tồn tại, mã xác thực sẽ được gửi.",
    });
    assert.equal(state.resetOtpHash, null);
    assert.equal(state.resetOtpExpires, null);
    assert.equal(state.resetOtpSentAt, null);
    assert.equal(state.resetTokenHash, null);
    assert.equal(state.resetTokenExpires, null);

    const unknownEmailResponse = await request("/api/auth/forgot-password", {
      body: { email: "missing@example.test" },
    });
    assert.equal(unknownEmailResponse.status, response.status);
    assert.deepEqual(await unknownEmailResponse.json(), {
      message: "Nếu email tồn tại, mã xác thực sẽ được gửi.",
    });

    const logOutput = JSON.stringify(logs);
    assert.match(logOutput, /forgot-password\.send-email/);
    for (const sensitiveValue of [
      "incorrect-password",
      "test-password",
      "test-user",
      "tester@example.test",
      "MAIL_PASSWORD",
    ]) {
      assert.equal(logOutput.includes(sensitiveValue), false);
    }
  } finally {
    console.error = originalConsoleError;
    await smtp.close();
  }
});

test("SMTP and cleanup failures are logged safely without changing the public response", async () => {
  const smtp = await startFakeSmtpServer({ rejectAuthentication: true });
  setSmtpEnvironment(smtp.port, true);
  state.userExists = true;
  const originalUpdateOne = User.updateOne;
  const originalConsoleError = console.error;
  const logs = [];
  User.updateOne = async (filter, update) => {
    if (update.$unset?.resetOtpHash) {
      throw Object.assign(new Error("private cleanup detail"), {
        code: "DB_CLEANUP_TEST",
      });
    }
    return originalUpdateOne(filter, update);
  };
  console.error = (...args) => logs.push(args);

  try {
    const response = await request("/api/auth/forgot-password", {
      body: { email: "tester@example.test" },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      message: "Nếu email tồn tại, mã xác thực sẽ được gửi.",
    });
    assert.ok(state.resetOtpHash);
    assert.ok(state.resetOtpExpires > new Date());

    const logOutput = JSON.stringify(logs);
    assert.match(logOutput, /forgot-password\.cleanup-token/);
    assert.match(logOutput, /forgot-password\.send-email/);
    for (const sensitiveValue of [
      "private cleanup detail",
      "incorrect-password",
      "test-password",
      "test-user",
      "tester@example.test",
      "MAIL_PASSWORD",
    ]) {
      assert.equal(logOutput.includes(sensitiveValue), false);
    }
  } finally {
    User.updateOne = originalUpdateOne;
    console.error = originalConsoleError;
    await smtp.close();
  }
});

test("MongoDB lookup and write errors are surfaced with operation context", async () => {
  const original = User.findOne;
  User.findOne = () => {
    throw Object.assign(new Error("database failure"), { code: "DB_TEST" });
  };
  await assert.rejects(
    authService.forgotPassword("tester@example.test"),
    (error) =>
      error.operation === "forgot-password.lookup-user" &&
      error.code === "DB_TEST"
  );
  User.findOne = original;

  state.userExists = true;
  User.updateOne = async () => {
    throw Object.assign(new Error("database failure"), { code: "DB_WRITE_TEST" });
  };
  await assert.rejects(
    authService.forgotPassword("tester@example.test"),
    (error) =>
      error.operation === "forgot-password.save-otp" &&
      error.code === "DB_WRITE_TEST"
  );
});

test("reset-password hashes the new password, clears reset fields, and rejects reuse", async () => {
  const resetToken = "a".repeat(64);
  state.userExists = true;
  state.resetTokenHash = createHash("sha256").update(resetToken).digest("hex");
  state.resetTokenExpires = new Date(Date.now() + 60_000);

  const response = await request("/api/auth/reset-password", {
    body: {
      email: "tester@example.test",
      resetToken,
      newPassword: "NewPassword123",
    },
  });
  assert.equal(response.status, 200);
  assert.equal(await bcrypt.compare("NewPassword123", state.passwordHash), true);
  assert.equal(state.resetTokenHash, null);
  assert.equal(state.resetTokenExpires, null);
  assert.equal(state.resetOtpHash, null);

  const reused = await request("/api/auth/reset-password", {
    body: {
      email: "tester@example.test",
      resetToken,
      newPassword: "AnotherPassword123",
    },
  });
  assert.equal(reused.status, 400);
});

test("expired reset token is rejected", async () => {
  const resetToken = "b".repeat(64);
  state.userExists = true;
  state.resetTokenHash = createHash("sha256").update(resetToken).digest("hex");
  state.resetTokenExpires = new Date(Date.now() - 1_000);

  const response = await request("/api/auth/reset-password", {
    body: {
      email: "tester@example.test",
      resetToken,
      newPassword: "NewPassword123",
    },
  });
  assert.equal(response.status, 400);
});

test("concurrent reset requests can consume a reset token only once", async () => {
  const resetToken = "c".repeat(64);
  state.userExists = true;
  state.resetTokenHash = createHash("sha256").update(resetToken).digest("hex");
  state.resetTokenExpires = new Date(Date.now() + 60_000);

  const responses = await Promise.all([
    request("/api/auth/reset-password", {
      body: {
        email: "tester@example.test",
        resetToken,
        newPassword: "NewPassword123",
      },
    }),
    request("/api/auth/reset-password", {
      body: {
        email: "tester@example.test",
        resetToken,
        newPassword: "AnotherPassword123",
      },
    }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400]);
});

test("reset-password validates required fields and bcrypt byte length", async () => {
  const resetToken = "d".repeat(64);
  const invalidBodies = [
    {},
    { email: "tester@example.test", resetToken, newPassword: "1234567" },
    { email: "tester@example.test", resetToken, newPassword: "é".repeat(37) },
    { email: "tester@example.test", resetToken, newPassword: 12345678 },
    { email: "bad", resetToken, newPassword: "Password123" },
  ];

  for (const body of invalidBodies) {
    const response = await request("/api/auth/reset-password", { body });
    assert.equal(response.status, 400);
  }
});

test("reset-related fields are excluded from default Mongoose selections", () => {
  for (const field of [
    "resetOtpHash",
    "resetOtpExpires",
    "resetOtpAttempts",
    "resetOtpSentAt",
    "resetTokenHash",
    "resetTokenExpires",
  ]) {
    assert.equal(User.schema.path(field).options.select, false, field);
  }
});

test("forgot-password rate limiter still allows five requests and blocks the sixth", async () => {
  const ip = `198.51.100.${(Date.now() % 200) + 1}`;
  const responses = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    responses.push(
      await request("/api/auth/forgot-password", {
        headers: { "X-Forwarded-For": ip },
        body: { email: `nobody${attempt}@example.test` },
      })
    );
  }
  assert.deepEqual(responses.map((response) => response.status), [
    200, 200, 200, 200, 200, 429,
  ]);
  assert.equal(responses[5].headers.get("retry-after"), "900");
});

test("Express trusts one proxy hop only when Render marks the runtime", async () => {
  const originalRender = process.env.RENDER;

  try {
    delete process.env.RENDER;
    const localApp = (
      await import(`../src/app.js?local-proxy-test=${Date.now()}`)
    ).default;
    assert.equal(localApp.get("trust proxy"), false);

    process.env.RENDER = "true";
    const renderApp = (
      await import(`../src/app.js?render-proxy-test=${Date.now()}`)
    ).default;
    assert.equal(renderApp.get("trust proxy"), 1);
  } finally {
    if (originalRender === undefined) delete process.env.RENDER;
    else process.env.RENDER = originalRender;
  }
});

test("rate limiter separates client IPs supplied by the trusted proxy", async () => {
  const firstIp = `198.51.100.${(Date.now() % 100) + 1}`;
  const secondIp = `203.0.113.${(Date.now() % 100) + 101}`;
  const responses = [];

  for (let attempt = 0; attempt < 5; attempt += 1) {
    responses.push(
      await request("/api/auth/forgot-password", {
        headers: { "X-Forwarded-For": `192.0.2.9, ${firstIp}` },
        body: { email: `ip-one-${attempt}@example.test` },
      })
    );
    responses.push(
      await request("/api/auth/forgot-password", {
        headers: { "X-Forwarded-For": `192.0.2.9, ${secondIp}` },
        body: { email: `ip-two-${attempt}@example.test` },
      })
    );
  }

  assert.equal(responses.every((response) => response.status === 200), true);
});

test("rate limiter ignores client-supplied X-Forwarded-For prefixes", async () => {
  const proxyIp = `203.0.113.${(Date.now() % 100) + 1}`;
  const responses = [];

  for (let attempt = 0; attempt < 6; attempt += 1) {
    responses.push(
      await request("/api/auth/forgot-password", {
        headers: {
          "X-Forwarded-For": `198.51.100.${attempt + 1}, ${proxyIp}`,
        },
        body: { email: `spoof-${attempt}@example.test` },
      })
    );
  }

  assert.deepEqual(responses.map((response) => response.status), [
    200, 200, 200, 200, 200, 429,
  ]);
});

test("local mode ignores forged forwarded IPs and still enforces the limit", async () => {
  const trustedProxySetting = app.get("trust proxy");
  app.set("trust proxy", false);

  try {
    const responses = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      responses.push(
        await request("/api/auth/forgot-password", {
          headers: {
            "X-Forwarded-For": `198.51.100.${attempt + 1}`,
          },
          body: { email: `local-spoof-${attempt}@example.test` },
        })
      );
    }

    assert.deepEqual(responses.map((response) => response.status), [
      200, 200, 200, 200, 200, 429,
    ]);
  } finally {
    app.set("trust proxy", trustedProxySetting);
  }
});

test("existing register, login, and me routes retain their current validation and auth", async (t) => {
  await t.test("register rejects invalid input", async () => {
    const response = await request("/api/auth/register", {
      body: { name: "", email: "bad", password: "short" },
    });
    assert.equal(response.status, 400);
  });
  await t.test("login rejects invalid input", async () => {
    const response = await request("/api/auth/login", {
      body: { email: "", password: "" },
    });
    assert.equal(response.status, 400);
  });
  await t.test("me still requires JWT", async () => {
    const response = await request("/api/auth/me", { method: "GET" });
    assert.equal(response.status, 401);
  });
});
