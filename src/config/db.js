import mongoose from "mongoose";

const connectDB = async () => {
  const mongoUri = process.env.MONGO_URI;

  if (!mongoUri) {
    throw new Error("Chưa cấu hình MONGO_URI trong file .env");
  }

  try {
    console.log("Đang kết nối đến cơ sở dữ liệu MongoDB...");

    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 10_000,
    });

    console.log("Kết nối MongoDB thành công!");
  } catch (error) {
    throw new Error("Kết nối MongoDB thất bại", {
      cause: error,
    });
  }
};

export default connectDB;