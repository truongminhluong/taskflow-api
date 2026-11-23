import "dotenv/config";
import mongoose from "mongoose";
import app from "./app.js";
import connectDB from "./config/db.js";

const PORT = process.env.PORT || 3000;

const startServer = async () => {
  try {
    await connectDB();

    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`Máy chủ đang chạy tại http://localhost:${PORT}`);
      console.log("TaskFlow API đã sẵn sàng nhận yêu cầu!");
    });

    const shutdown = (signal) => {
      console.log(`\nNhận tín hiệu ${signal}. Đang tắt máy chủ...`);

      server.close(async () => {
        await mongoose.disconnect();
        console.log("Đã ngắt kết nối MongoDB.");
        process.exit(0);
      });
    };

    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  } catch (error) {
    console.error("Không thể khởi động máy chủ:", error.message);

    if (error.cause) {
      console.error("Nguyên nhân:", error.cause.message);
    }

    process.exit(1);
  }
};

startServer();