import multer from "multer";

const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

export const taskAttachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
    fields: 0,
    parts: 1,
  },
  fileFilter(req, file, callback) {
    if (!allowedMimeTypes.has(file.mimetype)) {
      const error = new Error("Chỉ chấp nhận ảnh JPEG, PNG hoặc WebP.");
      error.statusCode = 400;
      callback(error);
      return;
    }
    callback(null, true);
  },
});

export function requireTaskAttachmentFile(req, res, next) {
  if (!req.file) {
    return res.status(400).json({
      message: "Cần gửi một tệp ảnh trong trường file.",
    });
  }
  return next();
}

export function taskAttachmentUploadError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    const statusCode = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(statusCode).json({
      message:
        statusCode === 413
          ? "Kích thước ảnh không được vượt quá 5 MB."
          : "Yêu cầu tải ảnh không hợp lệ.",
    });
  }
  if (err.statusCode === 400 && err.message) {
    return res.status(400).json({ message: err.message });
  }
  return next(err);
}
