import assert from "node:assert/strict";
import test from "node:test";
import {
  runTaskAssetCleanup,
} from "../src/services/task-asset-cleanup.service.js";
import {
  syncTaskAssetReferences,
} from "../src/services/task-asset.service.js";

const ownerId = "507f1f77bcf86cd799439011";
const otherOwnerId = "507f1f77bcf86cd799439012";
const uploadedAt = new Date("2026-01-01T00:00:00.000Z");
const attachment = {
  name: "photo.png",
  url: "https://res.cloudinary.com/example/photo.png",
  publicId: "taskflow/users/owner/photo",
  mimeType: "image/png",
  sizeBytes: 100,
};

function makeAsset(overrides = {}) {
  return {
    _id: "asset-id",
    ownerId,
    ...attachment,
    uploadedAt,
    uploadState: "complete",
    referenceCount: 0,
    cleanupState: "active",
    cleanupAttempts: 0,
    cleanupNextAttemptAt: uploadedAt,
    cleanupLeaseUntil: null,
    ...overrides,
  };
}

function createAssetModel(initialAssets) {
  const assets = initialAssets;
  const matches = (asset, filter) => {
    return Object.entries(filter).every(([key, condition]) => {
      if (key === "$or") {
        return condition.some((part) => matches(asset, part));
      }
      const value = asset[key];
      if (condition && typeof condition === "object" && "$in" in condition) {
        return condition.$in.includes(value);
      }
      if (condition && typeof condition === "object" && "$lte" in condition) {
        return value <= condition.$lte;
      }
      if (condition && typeof condition === "object" && "$gt" in condition) {
        return value > condition.$gt;
      }
      return value === condition;
    });
  };

  return {
    assets,
    find(filter) {
      return {
        session() {
          return this;
        },
        lean: async () => assets.filter((asset) => matches(asset, filter)),
      };
    },
    async updateOne(filter, update) {
      const asset = assets.find((item) => matches(item, filter));
      if (!asset) return { matchedCount: 0 };
      for (const [key, value] of Object.entries(update.$inc || {})) {
        asset[key] += value;
      }
      Object.assign(asset, update.$set || {});
      return { matchedCount: 1 };
    },
    async findOneAndUpdate(filter, update) {
      const asset = assets.find((item) => matches(item, filter));
      if (!asset) return null;
      Object.assign(asset, update.$set || {});
      return asset;
    },
    async deleteOne(filter) {
      const index = assets.findIndex((asset) => matches(asset, filter));
      if (index < 0) return { deletedCount: 0 };
      assets.splice(index, 1);
      return { deletedCount: 1 };
    },
  };
}

test("links only assets owned by the current user with server-matching metadata", async () => {
  const model = createAssetModel([makeAsset()]);
  await syncTaskAssetReferences({
    ownerId,
    nextAttachments: [attachment],
    AssetModel: model,
  });
  assert.equal(model.assets[0].referenceCount, 1);

  await assert.rejects(
    syncTaskAssetReferences({
      ownerId: otherOwnerId,
      nextAttachments: [attachment],
      AssetModel: model,
    }),
    { statusCode: 400 }
  );

  await assert.rejects(
    syncTaskAssetReferences({
      ownerId,
      nextAttachments: [{ ...attachment, url: "https://attacker.example/a" }],
      AssetModel: model,
    }),
    { statusCode: 400 }
  );
});

test("allows unchanged legacy metadata but rejects a newly supplied URL-only attachment", async () => {
  const legacy = {
    name: "legacy.jpg",
    url: "https://example.test/legacy.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 50,
  };
  await syncTaskAssetReferences({
    ownerId,
    previousAttachments: [legacy],
    nextAttachments: [legacy],
    AssetModel: createAssetModel([]),
  });

  await assert.rejects(
    syncTaskAssetReferences({
      ownerId,
      nextAttachments: [legacy],
      AssetModel: createAssetModel([]),
    }),
    { statusCode: 400 }
  );
});

test("cleanup deletes only expired unreferenced assets", async () => {
  const oldAsset = makeAsset();
  const recentAsset = makeAsset({
    _id: "recent",
    publicId: "recent",
    uploadedAt: new Date("2026-07-01T12:00:00.000Z"),
  });
  const referencedAsset = makeAsset({
    _id: "referenced",
    publicId: "referenced",
    referenceCount: 1,
  });
  const model = createAssetModel([oldAsset, recentAsset, referencedAsset]);
  const destroyed = [];
  const result = await runTaskAssetCleanup({
    AssetModel: model,
    destroy: async (publicId) => {
      destroyed.push(publicId);
      return { result: "ok" };
    },
    configured: () => true,
    now: () => new Date("2026-07-02T00:00:00.000Z"),
  });

  assert.equal(result.processed, 1);
  assert.deepEqual(destroyed, [attachment.publicId]);
  assert.deepEqual(
    model.assets.map((asset) => asset._id),
    ["recent", "referenced"]
  );
});

test("retries failed Cloudinary cleanup with backoff", async () => {
  const asset = makeAsset();
  const model = createAssetModel([asset]);
  let attempts = 0;
  const firstTime = new Date("2026-07-02T00:00:00.000Z");
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await runTaskAssetCleanup({
      AssetModel: model,
      destroy: async () => {
        attempts += 1;
        throw new Error("Cloudinary unavailable");
      },
      configured: () => true,
      now: () => firstTime,
    });
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(asset.cleanupState, "active");
  assert.equal(asset.cleanupAttempts, 1);
  assert.equal(
    asset.cleanupNextAttemptAt.getTime(),
    firstTime.getTime() + 60_000
  );

  await runTaskAssetCleanup({
    AssetModel: model,
    destroy: async () => {
      attempts += 1;
      return { result: "not found" };
    },
    configured: () => true,
    now: () => new Date(firstTime.getTime() + 60_000),
  });
  assert.equal(attempts, 2);
  assert.equal(model.assets.length, 0);
});

test("cleanup claim prevents linking an asset while it is being deleted", async () => {
  const asset = makeAsset();
  const model = createAssetModel([asset]);
  let markDestroyStarted;
  let finishDestroy;
  const destroyStarted = new Promise((resolve) => {
    markDestroyStarted = resolve;
  });
  const cleanup = runTaskAssetCleanup({
    AssetModel: model,
    destroy: async () => {
      markDestroyStarted();
      return new Promise((resolve) => {
        finishDestroy = resolve;
      });
    },
    configured: () => true,
    now: () => new Date("2026-07-02T00:00:00.000Z"),
    batchSize: 1,
  });
  await destroyStarted;

  assert.equal(asset.cleanupState, "deleting");
  await assert.rejects(
    syncTaskAssetReferences({
      ownerId,
      nextAttachments: [attachment],
      AssetModel: model,
    }),
    { statusCode: 400 }
  );
  finishDestroy({ result: "ok" });
  await cleanup;
});
