import { randomUUID } from "node:crypto";
import path from "node:path";
import TaskAsset from "../models/task-asset.model.js";
import {
  isCloudinaryConfigured,
  uploadImageBuffer,
} from "../config/cloudinary.js";

const maxFileSize = 5 * 1024 * 1024;
const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

export function detectImageMimeType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
  ) {
    return "image/png";
  }

  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
}

function attachmentName(originalName) {
  const baseName = path.basename((originalName || "image").replaceAll("\\", "/"));
  const safeName = baseName.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return safeName.slice(0, 255) || "image";
}

function uploadError(statusCode, message, cause) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.operation = "cloudinary-upload";
  if (cause) {
    error.upstreamErrorName =
      typeof cause.name === "string" &&
      /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(cause.name)
        ? cause.name
        : undefined;
    error.upstreamErrorCode =
      typeof cause.code === "number"
        ? cause.code
        : typeof cause.code === "string" &&
            /^[A-Za-z0-9_.-]{1,64}$/.test(cause.code)
          ? cause.code
          : undefined;
  }
  return error;
}

export async function uploadTaskAttachment(
  userId,
  file,
  {
    AssetModel = TaskAsset,
    configured = isCloudinaryConfigured,
    upload = uploadImageBuffer,
    makePublicId = randomUUID,
    now = () => new Date(),
  } = {}
) {
  if (!file?.buffer || !Number.isInteger(file.size) || file.size < 1) {
    throw uploadError(400, "Cần chọn một ảnh hợp lệ.");
  }
  if (file.size > maxFileSize || file.buffer.length !== file.size) {
    throw uploadError(413, "Kích thước ảnh không được vượt quá 5 MB.");
  }

  const detectedMimeType = detectImageMimeType(file.buffer);
  if (
    !detectedMimeType ||
    !allowedMimeTypes.has(detectedMimeType) ||
    file.mimetype !== detectedMimeType
  ) {
    throw uploadError(400, "Chỉ chấp nhận ảnh JPEG, PNG hoặc WebP hợp lệ.");
  }
  if (!configured()) {
    throw uploadError(503, "Dịch vụ lưu trữ ảnh chưa được cấu hình.");
  }

  const publicId = makePublicId();
  const folder = `taskflow/users/${userId}`;
  const expectedPublicId = `${folder}/${publicId}`;
  const asset = {
    ownerId: userId,
    publicId: expectedPublicId,
    name: attachmentName(file.originalname),
    url: null,
    mimeType: detectedMimeType,
    sizeBytes: file.size,
    uploadedAt: now(),
    uploadState: "pending",
    referenceCount: 0,
  };

  try {
    await AssetModel.create(asset);
  } catch (error) {
    throw uploadError(
      500,
      "Không thể chuẩn bị thông tin ảnh tải lên.",
      error
    );
  }

  let result;
  try {
    result = await upload(file.buffer, {
      asset_folder: folder,
      public_id: expectedPublicId,
      overwrite: false,
      resource_type: "image",
      allowed_formats: ["jpg", "jpeg", "png", "webp"],
    });
  } catch (error) {
    throw uploadError(
      502,
      "Không thể tải ảnh lên dịch vụ lưu trữ.",
      error
    );
  }

  if (
    typeof result?.secure_url !== "string" ||
    !result.secure_url.startsWith("https://") ||
    result.public_id !== expectedPublicId
  ) {
    throw uploadError(502, "Dịch vụ lưu trữ trả về kết quả ảnh không hợp lệ.");
  }

  try {
    const updated = await AssetModel.updateOne(
      {
        ownerId: userId,
        publicId: expectedPublicId,
        cleanupState: "active",
        uploadState: "pending",
      },
      {
        $set: {
          url: result.secure_url,
          uploadedAt: now(),
          uploadState: "complete",
        },
      }
    );
    if (updated.matchedCount !== 1) {
      throw new Error("Uploaded asset record is unavailable.");
    }
  } catch (error) {
    throw uploadError(
      500,
      "Không thể lưu thông tin ảnh đã tải lên.",
      error
    );
  }

  return {
    name: asset.name,
    url: result.secure_url,
    publicId: expectedPublicId,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
  };
}
