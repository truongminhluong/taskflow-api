import TaskAsset from "../models/task-asset.model.js";
import { destroyImage, isCloudinaryConfigured } from "../config/cloudinary.js";

const retentionMs = 24 * 60 * 60 * 1000;
const leaseMs = 5 * 60 * 1000;
const retryBaseMs = 60 * 1000;
const retryMaxMs = 24 * 60 * 60 * 1000;

function safeCleanupLog(error) {
  console.error("Task attachment cleanup failed", {
    errorName: error?.name,
    errorCode: error?.code,
  });
}

export async function runTaskAssetCleanup({
  AssetModel = TaskAsset,
  destroy = destroyImage,
  now = () => new Date(),
  configured = isCloudinaryConfigured,
  batchSize = 25,
} = {}) {
  if (!configured()) return { processed: 0, skipped: true };

  const currentTime = now();
  const expiredBefore = new Date(currentTime.getTime() - retentionMs);
  let processed = 0;

  for (let index = 0; index < batchSize; index += 1) {
    const leaseUntil = new Date(currentTime.getTime() + leaseMs);
    const asset = await AssetModel.findOneAndUpdate(
      {
        referenceCount: 0,
        $or: [
          {
            cleanupState: "active",
            uploadedAt: { $lte: expiredBefore },
            cleanupNextAttemptAt: { $lte: currentTime },
          },
          {
            cleanupState: "deleting",
            cleanupLeaseUntil: { $lte: currentTime },
          },
        ],
      },
      {
        $set: {
          cleanupState: "deleting",
          cleanupLeaseUntil: leaseUntil,
        },
      },
      {
        new: true,
        sort: { uploadedAt: 1 },
      }
    );

    if (!asset) break;

    try {
      const result = await destroy(asset.publicId);
      if (result?.result !== "ok" && result?.result !== "not found") {
        const error = new Error("Cloudinary did not confirm asset deletion.");
        error.code = "CLOUDINARY_DELETE_UNCONFIRMED";
        throw error;
      }

      const deletion = await AssetModel.deleteOne({
        _id: asset._id,
        cleanupState: "deleting",
        referenceCount: 0,
        cleanupLeaseUntil: leaseUntil,
      });
      if (deletion.deletedCount !== 1) {
        const error = new Error("Asset cleanup claim was no longer valid.");
        error.code = "ASSET_CLEANUP_CLAIM_LOST";
        throw error;
      }
    } catch (error) {
      const retryDelay = Math.min(
        retryBaseMs * 2 ** Math.min(asset.cleanupAttempts || 0, 10),
        retryMaxMs
      );
      await AssetModel.updateOne(
        {
          _id: asset._id,
          cleanupState: "deleting",
          cleanupLeaseUntil: leaseUntil,
        },
        {
          $set: {
            cleanupState: "active",
            cleanupLeaseUntil: null,
            cleanupNextAttemptAt: new Date(currentTime.getTime() + retryDelay),
          },
          $inc: { cleanupAttempts: 1 },
        }
      );
      safeCleanupLog(error);
    }

    processed += 1;
  }

  return { processed, skipped: false };
}

export function startTaskAssetCleanup({
  intervalMs = 15 * 60 * 1000,
  run = runTaskAssetCleanup,
} = {}) {
  let running = false;
  const execute = async () => {
    if (running) return;
    running = true;
    try {
      await run();
    } catch (error) {
      safeCleanupLog(error);
    } finally {
      running = false;
    }
  };

  void execute();
  const timer = setInterval(execute, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
