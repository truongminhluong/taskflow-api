import mongoose from "mongoose";
import TaskAsset from "../models/task-asset.model.js";

const assetError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

function attachmentKey(attachment) {
  return JSON.stringify([
    attachment.name,
    attachment.url,
    attachment.mimeType,
    attachment.sizeBytes ?? null,
  ]);
}

function getPublicIds(attachments = []) {
  return attachments
    .map((attachment) => attachment.publicId)
    .filter((publicId) => typeof publicId === "string" && publicId.length > 0);
}

function queryWithSession(query, session) {
  return session ? query.session(session) : query;
}

export async function withAssetTransaction(operation) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await operation(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

export async function syncTaskAssetReferences({
  ownerId,
  previousAttachments = [],
  nextAttachments = [],
  session,
  AssetModel = TaskAsset,
}) {
  const previousById = new Map(
    previousAttachments
      .filter((attachment) => attachment.publicId)
      .map((attachment) => [attachment.publicId, attachment])
  );
  const nextById = new Map(
    nextAttachments
      .filter((attachment) => attachment.publicId)
      .map((attachment) => [attachment.publicId, attachment])
  );

  if (nextById.size !== getPublicIds(nextAttachments).length) {
    throw assetError("Không thể đính kèm cùng một ảnh nhiều lần.");
  }

  const previousLegacy = new Set(
    previousAttachments
      .filter((attachment) => !attachment.publicId)
      .map(attachmentKey)
  );
  for (const attachment of nextAttachments) {
    if (!attachment.publicId && !previousLegacy.has(attachmentKey(attachment))) {
      throw assetError("Ảnh đính kèm không hợp lệ hoặc không thuộc tài khoản.");
    }
  }

  const nextIds = [...nextById.keys()];
  let assets = [];
  if (nextIds.length > 0) {
    const query = AssetModel.find({
      ownerId,
      publicId: { $in: nextIds },
      cleanupState: "active",
      uploadState: "complete",
    });
    assets = await queryWithSession(query, session).lean();
  }

  const assetsById = new Map(assets.map((asset) => [asset.publicId, asset]));
  for (const [publicId, attachment] of nextById) {
    const asset = assetsById.get(publicId);
    if (
      !asset ||
      asset.name !== attachment.name ||
      asset.url !== attachment.url ||
      asset.mimeType !== attachment.mimeType ||
      asset.sizeBytes !== attachment.sizeBytes
    ) {
      throw assetError("Ảnh đính kèm không hợp lệ hoặc không thuộc tài khoản.");
    }
  }

  for (const [publicId, attachment] of nextById) {
    if (previousById.has(publicId)) continue;
    const result = await AssetModel.updateOne(
      {
        publicId,
        ownerId,
        cleanupState: "active",
        uploadState: "complete",
      },
      { $inc: { referenceCount: 1 } },
      session ? { session } : undefined
    );
    if (result.matchedCount !== 1) {
      throw assetError("Ảnh đính kèm không còn khả dụng.", 409);
    }
  }

  for (const publicId of previousById.keys()) {
    if (nextById.has(publicId)) continue;
    const result = await AssetModel.updateOne(
      {
        publicId,
        ownerId,
        cleanupState: "active",
        referenceCount: { $gt: 0 },
      },
      { $inc: { referenceCount: -1 } },
      session ? { session } : undefined
    );
    if (result.matchedCount !== 1) {
      throw assetError("Không thể cập nhật tham chiếu ảnh.", 409);
    }
  }
}

export function getTaskAssetPublicIds(attachments = []) {
  return getPublicIds(attachments);
}
