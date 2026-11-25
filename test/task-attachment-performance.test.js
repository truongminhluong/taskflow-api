import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  measureTaskAttachmentMultipart,
  startTaskAttachmentPerformance,
} from "../src/utils/task-attachment-performance.js";
import { uploadTaskAttachment } from "../src/services/task-attachment-upload.service.js";

const userId = "507f1f77bcf86cd799439011";
const imageBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

async function captureLogs(action) {
  const originalInfo = console.info;
  const logs = [];
  console.info = (...args) => logs.push(args.join(" "));
  try {
    const result = await action();
    return { result, logs };
  } finally {
    console.info = originalInfo;
  }
}

function beginFakeRequest() {
  const req = {};
  const res = new EventEmitter();
  res.statusCode = 201;
  startTaskAttachmentPerformance(req, res, () => {});
  return { req, res };
}

function eventsFrom(logs) {
  return logs.map((line) => JSON.parse(line.slice(line.indexOf("{")).trim()));
}

function assertSafeConsistentLogs(logs, forbiddenValues) {
  const events = eventsFrom(logs);
  const requestIds = new Set(events.map((entry) => entry.request_id));
  assert.equal(requestIds.size, 1);
  assert.match([...requestIds][0], /^[0-9a-f-]{36}$/i);
  const serialized = JSON.stringify(events);
  for (const value of forbiddenValues) {
    assert.equal(serialized.includes(value), false);
  }
  return events;
}

test("logs all upload stages with stable request ID and unchanged response metadata", async () => {
  const { result: captured, logs } = await captureLogs(async () => {
    const { req, res } = beginFakeRequest();
    const attachment = await uploadTaskAttachment(
      userId,
      {
        buffer: imageBytes,
        size: imageBytes.length,
        mimetype: "image/png",
        originalname: "private-original-name.png",
      },
      {
        performanceContext: req.taskAttachmentPerformance,
        configured: () => true,
        makePublicId: () => "private-cloudinary-public-id",
        AssetModel: {
          create: async () => {},
          updateOne: async () => ({ matchedCount: 1 }),
        },
        upload: async () => ({
          secure_url: "https://private.example.test/private-image.png",
          public_id: `taskflow/users/${userId}/private-cloudinary-public-id`,
        }),
      }
    );
    res.statusCode = 201;
    res.emit("finish");
    return { attachment, request: req.taskAttachmentPerformance };
  });

  assert.deepEqual(captured.attachment, {
    name: "private-original-name.png",
    url: "https://private.example.test/private-image.png",
    publicId: "taskflow/users/507f1f77bcf86cd799439011/private-cloudinary-public-id",
    mimeType: "image/png",
    sizeBytes: imageBytes.length,
  });
  const events = assertSafeConsistentLogs(logs, [
    "private-original-name.png",
    "private-cloudinary-public-id",
    "https://private.example.test/private-image.png",
    userId,
  ]);
  assert.deepEqual(
    events.map(({ event }) => event),
    [
      "request_received",
      "file_validated",
      "asset_pending_created",
      "cloudinary_upload_started",
      "cloudinary_upload_finished",
      "asset_finalized",
      "request_completed",
    ]
  );
  assert.equal(events[1].file_size_bytes, imageBytes.length);
  assert.equal(events[1].mime_type, "image/png");
  assert.equal(events[4].success, true);
  assert.equal(events.at(-1).status, 201);
  assert.ok(Number.isFinite(events.at(-1).request_total_ms));
  assert.equal(captured.request.requestId, events[0].request_id);
});

test("Cloudinary errors are logged without replacing the original cause", async () => {
  const { logs } = await captureLogs(async () => {
    const { req, res } = beginFakeRequest();
    const upstreamError = new Error("sensitive upstream text must not be logged");
    upstreamError.name = "CloudinaryError";
    await assert.rejects(
      uploadTaskAttachment(
        userId,
        {
          buffer: imageBytes,
          size: imageBytes.length,
          mimetype: "image/png",
          originalname: "private.png",
        },
        {
          performanceContext: req.taskAttachmentPerformance,
          configured: () => true,
          makePublicId: () => "private-id",
          AssetModel: { create: async () => {} },
          upload: async () => {
            throw upstreamError;
          },
        }
      ),
      (error) => {
        assert.equal(error.statusCode, 502);
        assert.equal(error.cause, upstreamError);
        return true;
      }
    );
    res.statusCode = 502;
    res.emit("finish");
  });

  const events = assertSafeConsistentLogs(logs, [
    "sensitive upstream text",
    "private.png",
    "private-id",
  ]);
  assert.ok(
    events.some(
      (event) =>
        event.event === "cloudinary_upload_finished" &&
        event.success === false &&
        event.error_type === "CloudinaryError" &&
        Number.isFinite(event.cloudinary_upload_ms)
    )
  );
  assert.ok(events.some((event) => event.event === "request_completed"));
});

test("MongoDB pending and finalize failures retain existing outcomes and log stage", async () => {
  for (const failingStage of ["mongo_pending", "mongo_finalize"]) {
    const { logs } = await captureLogs(async () => {
      const { req, res } = beginFakeRequest();
      let uploadCalls = 0;
      await assert.rejects(
        uploadTaskAttachment(
          userId,
          {
            buffer: imageBytes,
            size: imageBytes.length,
            mimetype: "image/png",
            originalname: "private.png",
          },
          {
            performanceContext: req.taskAttachmentPerformance,
            configured: () => true,
            makePublicId: () => "private-id",
            AssetModel: {
              create: async () => {
                if (failingStage === "mongo_pending") {
                  throw new Error("private mongo details");
                }
              },
              updateOne: async () => {
                if (failingStage === "mongo_finalize") {
                  throw new Error("private finalize details");
                }
                return { matchedCount: 1 };
              },
            },
            upload: async () => {
              uploadCalls++;
              return {
                secure_url: "https://private.example.test/image.png",
                public_id: `taskflow/users/${userId}/private-id`,
              };
            },
          }
        ),
        { statusCode: 500 }
      );
      assert.equal(uploadCalls, failingStage === "mongo_pending" ? 0 : 1);
      res.statusCode = 500;
      res.emit("finish");
    });

    const events = assertSafeConsistentLogs(logs, [
      "private.png",
      "private-id",
      "private mongo details",
      "private finalize details",
      "https://private.example.test/image.png",
    ]);
    assert.ok(
      events.some(
        (event) =>
          event.event === "request_failed" && event.stage === failingStage
      )
    );
    assert.ok(events.some((event) => event.event === "request_completed"));
  }
});

test("multipart parser instrumentation logs safe failure without replacing its error", async () => {
  const { logs } = await captureLogs(async () => {
    const { req, res } = beginFakeRequest();
    req.taskAttachmentPerformance.stage = "multipart";
    const originalError = new Error("private filename must stay out of logs");
    originalError.name = "MulterError";
    originalError.name += " private-name.png";
    let receivedError;

    measureTaskAttachmentMultipart((_req, _res, callback) => {
      callback(originalError);
    })(req, res, (error) => {
      receivedError = error;
    });

    assert.equal(receivedError, originalError);
    res.statusCode = 413;
    res.emit("finish");
  });

  const events = assertSafeConsistentLogs(logs, [
    "private filename",
    "private-name.png",
  ]);
  assert.ok(
    events.some(
      (event) =>
        event.event === "multipart_received" &&
        event.success === false &&
        event.error_type === "Error"
    )
  );
  assert.ok(events.some((event) => event.event === "request_completed"));
});
