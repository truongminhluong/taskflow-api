const userId = ObjectId("6ae46048383874bc68b6aaee");

const titles = [
  "Học Flutter cơ bản",
  "Ôn tập Dart",
  "Hoàn thành bài tập lập trình",
  "Kiểm tra tiến độ dự án",
  "Đọc tài liệu API",
  "Thiết kế giao diện ứng dụng",
  "Sửa lỗi chức năng đăng nhập",
  "Kiểm tra dữ liệu MongoDB",
  "Viết tài liệu dự án",
  "Chuẩn bị báo cáo tuần",
  "Học Riverpod",
  "Tìm hiểu Clean Architecture",
  "Kiểm tra giao diện màn hình",
  "Tối ưu hiệu năng ứng dụng",
  "Kiểm thử chức năng công việc",
  "Cập nhật tiến độ học tập",
  "Sắp xếp góc làm việc",
  "Đọc sách chuyên ngành",
  "Luyện tập tiếng Anh",
  "Chuẩn bị phỏng vấn Flutter",
];

const descriptions = [
  "Hoàn thành nội dung và kiểm tra lại kết quả.",
  "Đọc tài liệu, thực hành và ghi chú kiến thức.",
  "Kiểm tra các trường hợp hoạt động của chức năng.",
  "Cập nhật tiến độ và xử lý những phần còn thiếu.",
  "Hoàn thiện công việc theo kế hoạch đã đề ra.",
];

const categories = ["Công việc", "Học tập"];
const priorities = ["low", "medium", "high"];
const reminders = [null, 0, 5, 10, 15, 30];

const now = new Date();
const tasks = [];

for (let i = 0; i < 200; i++) {
  // Phân bố ngày từ 30 ngày trước đến 60 ngày sau.
  const dayOffset = (i % 91) - 30;
  const dueDate = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);

  dueDate.setUTCHours(i % 24, (i * 7) % 60, 0, 0);

  // Một số task không có ngày đến hạn.
  const finalDueDate = i % 17 === 0 ? null : dueDate;

  tasks.push({
    userId,
    title: `${titles[i % titles.length]} #${i + 1}`,
    description: descriptions[i % descriptions.length],
    dueDate: finalDueDate,
    priority: priorities[i % priorities.length],
    category: categories[i % categories.length],
    isCompleted: i % 3 === 0,
    reminderMinutesBefore: reminders[i % reminders.length],
    createdAt: new Date(now.getTime() - i * 60 * 1000),
    updatedAt: now,
  });
}

const result = db.tasks.insertMany(tasks);

print("Đã tạo thành công: " + Object.keys(result.insertedIds).length);
print("Tổng số task của user: " + db.tasks.countDocuments({ userId }));
