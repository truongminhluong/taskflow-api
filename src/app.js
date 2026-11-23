import express from "express";
import authRoutes from "./routes/auth.routes.js";
import taskRoutes from "./routes/task.routes.js";
import { authMiddleware } from "./middlewares/auth.middleware.js";
import {
  notFoundHandler,
  errorHandler,
} from "./middlewares/error.middleware.js";

const app = express();

if (process.env.RENDER === "true") {
  app.set("trust proxy", 1);
}

app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (req, res) => {
  res.status(200).json({
    message: "Máy chủ TaskFlow đang hoạt động bình thường",
  });
});

// Đăng ký và đăng nhập không cần JWT.
app.use("/api/auth", authRoutes);

// Tất cả API task đều yêu cầu JWT hợp lệ.
app.use("/api/tasks", authMiddleware, taskRoutes);

// Giữ middleware lỗi ở cuối.
app.use(notFoundHandler);
app.use(errorHandler);

export default app;