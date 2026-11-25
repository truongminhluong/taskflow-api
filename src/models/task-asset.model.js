import mongoose from "mongoose";

const taskAssetSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    publicId: {
      type: String,
      required: true,
      unique: true,
    },
    name: {
      type: String,
      required: true,
      maxlength: 255,
    },
    url: {
      type: String,
      default: null,
      maxlength: 2048,
    },
    mimeType: {
      type: String,
      required: true,
      enum: ["image/jpeg", "image/png", "image/webp"],
    },
    sizeBytes: {
      type: Number,
      required: true,
      min: 1,
      max: 5 * 1024 * 1024,
    },
    uploadedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    uploadState: {
      type: String,
      enum: ["pending", "complete"],
      default: "pending",
      required: true,
    },
    referenceCount: {
      type: Number,
      default: 0,
      min: 0,
      required: true,
    },
    cleanupState: {
      type: String,
      enum: ["active", "deleting"],
      default: "active",
      required: true,
    },
    cleanupAttempts: {
      type: Number,
      default: 0,
      min: 0,
      required: true,
    },
    cleanupNextAttemptAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    cleanupLeaseUntil: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

taskAssetSchema.index({
  cleanupState: 1,
  referenceCount: 1,
  uploadedAt: 1,
  cleanupNextAttemptAt: 1,
  cleanupLeaseUntil: 1,
});

const TaskAsset =
  mongoose.models.TaskAsset ||
  mongoose.model("TaskAsset", taskAssetSchema);

export default TaskAsset;
