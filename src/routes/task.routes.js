import express from "express";
import taskController from "../controllers/task.controller.js";
import { authMiddleware } from "../middlewares/auth.middleware.js";

import {
  validateCreateTask,
  validateUpdateTask,
  validateTaskListQuery,
  validateTaskOverviewQuery,
} from "../validators/task.validator.js";

const router = express.Router();

router.get("/", authMiddleware, validateTaskListQuery, taskController.getAllTasks);

router.get(
  "/recurring-series",
  authMiddleware,
  taskController.getRecurringSeries,
);

router.get(
  "/recurring-series/:id",
  authMiddleware,
  taskController.getRecurringSeriesById,
);

router.patch(
  "/recurring-series/:id",
  authMiddleware,
  taskController.updateRecurringSeries,
);

router.delete(
  "/recurring-series/:id",
  authMiddleware,
  taskController.deleteRecurringSeries,
);

router.patch(
  "/:id/complete",
  authMiddleware,
  taskController.completeTask,
);

router.get(
  "/overview",
  authMiddleware,
  validateTaskOverviewQuery,
  taskController.getTaskOverview,
);

router.get("/:id", authMiddleware, taskController.getTaskById);

router.post(
  "/",
  authMiddleware,
  validateCreateTask,
  taskController.createTask,
);

router.patch(
  "/:id",
  authMiddleware,
  validateUpdateTask,
  taskController.updateTask,
);

router.delete(
  "/:id",
  authMiddleware,
  taskController.deleteTask,
);

export default router;
