import mongoose from "mongoose";
import taskService from "../services/task.service.js";
import asyncHandler from "../utils/async-handler.js";

// Lấy danh sách công việc của user hiện tại
const getAllTasks = asyncHandler(async (req, res) => {
  const result = await taskService.getAllTasks(
    req.user.userId,
    req.taskListQuery,
  );

  res.status(200).json({
    message: "Lấy danh sách công việc thành công.",
    data: result,
  });
});

const getTaskOverview = asyncHandler(async (req, res) => {
  const data = await taskService.getTaskOverview(
    req.user.userId,
    req.taskOverviewQuery,
  );

  res.status(200).json({
    message: "Lấy dữ liệu tổng quan thành công.",
    data,
  });
});

// Lấy chi tiết công việc thuộc user hiện tại
const getTaskById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({
      message: "ID công việc không hợp lệ.",
    });
  }

  const task = await taskService.getTaskById(
    id,
    req.user.userId,
  );

  if (!task) {
    return res.status(404).json({
      message: "Không tìm thấy công việc.",
    });
  }

  res.status(200).json({
    message: "Lấy thông tin công việc thành công.",
    data: task,
  });
});

// Tạo công việc cho user hiện tại
const createTask = asyncHandler(async (req, res) => {
  const task = await taskService.createTask({
    ...req.body,
    userId: req.user.userId,
  });

  res.status(201).json({
    message: "Tạo công việc thành công.",
    data: task,
  });
});

// Cập nhật công việc thuộc user hiện tại
const updateTask = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({
      message: "ID công việc không hợp lệ.",
    });
  }

  // Không cho phép thay đổi chủ sở hữu công việc
  const { userId, ...updateData } = req.body;

  const task = await taskService.updateTask(
    id,
    req.user.userId,
    updateData,
  );

  if (!task) {
    return res.status(404).json({
      message: "Không tìm thấy công việc cần cập nhật.",
    });
  }

  res.status(200).json({
    message: "Cập nhật công việc thành công.",
    data: task,
  });
});

// Xóa công việc thuộc user hiện tại
const deleteTask = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({
      message: "ID công việc không hợp lệ.",
    });
  }

  const task = await taskService.deleteTask(
    id,
    req.user.userId,
  );

  if (!task) {
    return res.status(404).json({
      message: "Không tìm thấy công việc cần xóa.",
    });
  }

  res.status(200).json({
    message: "Xóa công việc thành công.",
    data: task,
  });
});

const completeTask = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({
      message: "ID công việc không hợp lệ.",
    });
  }

  const task = await taskService.completeTask(id, req.user.userId);

  if (!task) {
    return res.status(404).json({
      message: "Không tìm thấy công việc.",
    });
  }

  res.status(200).json({
    message: "Hoàn thành công việc thành công.",
    data: task,
  });
});

const getRecurringSeries = asyncHandler(async (req, res) => {
  const data = await taskService.getRecurringSeries(req.user.userId);
  res.status(200).json({
    message: "Lấy danh sách chuỗi lặp thành công.",
    data,
  });
});

const getRecurringSeriesById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const data = await taskService.getRecurringSeriesById(id, req.user.userId);

  if (!data) {
    return res.status(404).json({
      message: "Không tìm thấy chuỗi lặp.",
    });
  }

  res.status(200).json({
    message: "Lấy chuỗi lặp thành công.",
    data,
  });
});

const updateRecurringSeries = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!req.body || typeof req.body !== "object" || !("repeat" in req.body)) {
    return res.status(400).json({
      message: "Vui lòng cung cấp repeat để cập nhật chuỗi lặp.",
    });
  }

  const data = await taskService.updateRecurringSeries(
    id,
    req.user.userId,
    req.body.repeat
  );

  if (!data) {
    return res.status(404).json({
      message: "Không tìm thấy chuỗi lặp.",
    });
  }

  res.status(200).json({
    message: "Cập nhật chuỗi lặp thành công.",
    data,
  });
});

const deleteRecurringSeries = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const data = await taskService.deleteRecurringSeries(
    id,
    req.user.userId
  );

  if (!data) {
    return res.status(404).json({
      message: "Không tìm thấy chuỗi lặp.",
    });
  }

  res.status(200).json({
    message: "Dừng chuỗi lặp thành công.",
    data,
  });
});

export default {
  getAllTasks,
  getTaskOverview,
  getTaskById,
  createTask,
  updateTask,
  completeTask,
  getRecurringSeries,
  getRecurringSeriesById,
  updateRecurringSeries,
  deleteRecurringSeries,
  deleteTask,
};
