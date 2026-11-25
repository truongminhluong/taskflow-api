import express from "express";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import {
  requireTaskAttachmentFile,
  taskAttachmentUpload,
  taskAttachmentUploadError,
} from "../middlewares/task-attachment-upload.middleware.js";
import taskAttachmentUploadController from "../controllers/task-attachment-upload.controller.js";

const router = express.Router();

router.post(
  "/task-attachments",
  authMiddleware,
  taskAttachmentUpload.single("file"),
  requireTaskAttachmentFile,
  taskAttachmentUploadController
);

router.use(taskAttachmentUploadError);

export default router;
