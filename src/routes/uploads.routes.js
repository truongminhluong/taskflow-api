import express from "express";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import {
  requireTaskAttachmentFile,
  taskAttachmentUpload,
  taskAttachmentUploadError,
} from "../middlewares/task-attachment-upload.middleware.js";
import taskAttachmentUploadController from "../controllers/task-attachment-upload.controller.js";
import {
  measureTaskAttachmentMultipart,
  startTaskAttachmentPerformance,
} from "../utils/task-attachment-performance.js";

const router = express.Router();

router.post(
  "/task-attachments",
  startTaskAttachmentPerformance,
  authMiddleware,
  measureTaskAttachmentMultipart(taskAttachmentUpload.single("file")),
  requireTaskAttachmentFile,
  taskAttachmentUploadController
);

router.use(taskAttachmentUploadError);

export default router;
