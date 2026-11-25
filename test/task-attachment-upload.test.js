import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";
import app from "../src/app.js";
import {
  detectImageMimeType,
  uploadTaskAttachment,
} from "../src/services/task-attachment-upload.service.js";
import { validateUpdateTask } from "../src/validators/task.validator.js";

const userId = "507f1f77bcf86cd799439011";
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const webp = Buffer.from("RIFF0000WEBP", "ascii");

function makeFile(buffer, mimetype, originalname = "photo.png") {
  return {
    buffer,
    size: buffer.length,
    mimetype,
    originalname,
  };
}

test("detects JPEG, PNG, and WebP from file signatures", () => {
  assert.equal(detectImageMimeType(jpeg), "image/jpeg");
  assert.equal(detectImageMimeType(png), "image/png");
  assert.equal(detectImageMimeType(webp), "image/webp");
  assert.equal(detectImageMimeType(Buffer.from("not an image")), null);
});

test("uploads verified image to a per-user folder and persists response metadata", async () => {
  let savedAsset;
  let uploadOptions;
  const response = await uploadTaskAttachment(
    userId,
    makeFile(png, "image/png", "folder\\sample.png"),
    {
      configured: () => true,
      makePublicId: () => "generated-id",
      upload: async (_buffer, options) => {
        uploadOptions = options;
        return {
          secure_url:
            "https://res.cloudinary.com/example/image/upload/taskflow/users/507f1f77bcf86cd799439011/generated-id.png",
          public_id:
            "taskflow/users/507f1f77bcf86cd799439011/generated-id",
        };
      },
      AssetModel: {
        create: async (asset) => {
          savedAsset = asset;
        },
        updateOne: async (_filter, update) => {
          Object.assign(savedAsset, update.$set);
          return { matchedCount: 1 };
        },
      },
    }
  );

  assert.equal(uploadOptions.asset_folder, `taskflow/users/${userId}`);
  assert.equal(
    uploadOptions.public_id,
    `taskflow/users/${userId}/generated-id`
  );
  assert.equal(uploadOptions.overwrite, false);
  assert.deepEqual(response, {
    name: "sample.png",
    url:
      "https://res.cloudinary.com/example/image/upload/taskflow/users/507f1f77bcf86cd799439011/generated-id.png",
    publicId:
      "taskflow/users/507f1f77bcf86cd799439011/generated-id",
    mimeType: "image/png",
    sizeBytes: png.length,
  });
  assert.equal(savedAsset.ownerId, userId);
  assert.equal(savedAsset.referenceCount, 0);
  assert.equal(savedAsset.uploadState, "complete");
});

test("rejects mismatched and unsupported image signatures before Cloudinary", async () => {
  let uploadCalls = 0;
  const options = {
    configured: () => true,
    upload: async () => {
      uploadCalls += 1;
    },
  };

  await assert.rejects(
    uploadTaskAttachment(userId, makeFile(png, "image/jpeg"), options),
    { statusCode: 400 }
  );
  await assert.rejects(
    uploadTaskAttachment(
      userId,
      makeFile(Buffer.from("not an image"), "image/png"),
      options
    ),
    { statusCode: 400 }
  );
  assert.equal(uploadCalls, 0);
});

test("rejects images larger than 5 MB", async () => {
  await assert.rejects(
    uploadTaskAttachment(
      userId,
      makeFile(Buffer.alloc(5 * 1024 * 1024 + 1), "image/png"),
      { configured: () => true }
    ),
    { statusCode: 413 }
  );
});

test("does not call Cloudinary when credentials are not configured", async () => {
  let uploadCalls = 0;
  await assert.rejects(
    uploadTaskAttachment(userId, makeFile(png, "image/png"), {
      configured: () => false,
      upload: async () => {
        uploadCalls += 1;
      },
    }),
    { statusCode: 503 }
  );
  assert.equal(uploadCalls, 0);
});

test("records cleanup metadata before uploading and retains it after finalization failure", async () => {
  let savedAsset;
  let uploadCalls = 0;
  await assert.rejects(
    uploadTaskAttachment(userId, makeFile(png, "image/png"), {
      configured: () => true,
      makePublicId: () => "generated-id",
      upload: async () => {
        uploadCalls += 1;
        return {
          secure_url:
            "https://res.cloudinary.com/example/image/upload/taskflow/users/507f1f77bcf86cd799439011/generated-id.png",
          public_id:
            "taskflow/users/507f1f77bcf86cd799439011/generated-id",
        };
      },
      AssetModel: {
        create: async (asset) => {
          savedAsset = asset;
        },
        updateOne: async () => {
          throw new Error("database failure");
        },
      },
    }),
    { statusCode: 500 }
  );
  assert.equal(uploadCalls, 1);
  assert.equal(savedAsset.uploadState, "pending");
  assert.equal(
    savedAsset.publicId,
    "taskflow/users/507f1f77bcf86cd799439011/generated-id"
  );
});

test("does not upload when cleanup metadata cannot be registered", async () => {
  let uploadCalls = 0;
  await assert.rejects(
    uploadTaskAttachment(userId, makeFile(png, "image/png"), {
      configured: () => true,
      upload: async () => {
        uploadCalls += 1;
      },
      AssetModel: {
        create: async () => {
          throw new Error("database failure");
        },
      },
    }),
    { statusCode: 500 }
  );
  assert.equal(uploadCalls, 0);
});

test("Task update validation accepts persisted publicId metadata", () => {
  const req = {
    body: {
      attachments: [
        {
          name: "photo.png",
          url: "https://res.cloudinary.com/example/photo.png",
          publicId: "taskflow/users/user/photo",
          mimeType: "image/png",
          sizeBytes: 100,
        },
      ],
    },
  };
  let continued = false;
  let responseStatus;
  validateUpdateTask(
    req,
    {
      status(statusCode) {
        responseStatus = statusCode;
        return this;
      },
      json() {},
    },
    () => {
      continued = true;
    }
  );
  assert.equal(continued, true);
  assert.equal(responseStatus, undefined);
});

test("task attachment upload route requires JWT and rejects unsupported MIME types", async (t) => {
  const previousJwtSecret = process.env.JWT_SECRET;
  const testSecret = "task-attachment-test-secret-long-enough-123";
  process.env.JWT_SECRET = testSecret;
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (previousJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = previousJwtSecret;
    }
  });

  const endpoint = `http://127.0.0.1:${server.address().port}/api/uploads/task-attachments`;
  const unauthenticated = await fetch(endpoint, { method: "POST" });
  assert.equal(unauthenticated.status, 401);

  const formData = new FormData();
  formData.append("file", new Blob(["not an image"], { type: "image/gif" }), "x.gif");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt.sign({ userId }, testSecret)}`,
    },
    body: formData,
  });
  assert.equal(response.status, 400);

  const oversizedBytes = Buffer.alloc(5 * 1024 * 1024 + 1);
  oversizedBytes.set([0xff, 0xd8, 0xff]);
  const oversizedForm = new FormData();
  oversizedForm.append(
    "file",
    new Blob([oversizedBytes], { type: "image/jpeg" }),
    "large.jpg"
  );
  const oversizedResponse = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt.sign({ userId }, testSecret)}`,
    },
    body: oversizedForm,
  });
  assert.equal(oversizedResponse.status, 413);
});
