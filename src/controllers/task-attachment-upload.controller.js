import asyncHandler from "../utils/async-handler.js";
import { uploadTaskAttachment } from "../services/task-attachment-upload.service.js";

const uploadTaskAttachmentController = asyncHandler(async (req, res) => {
  const attachment = await uploadTaskAttachment(req.user.userId, req.file, {
    performanceContext: req.taskAttachmentPerformance,
  });
  res.status(201).json({
    message: "Tải ảnh lên thành công.",
    data: attachment,
  });
});

export default uploadTaskAttachmentController;
