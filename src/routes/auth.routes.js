import { Router } from "express";
import {
  register,
  login,
  me,
  updateCurrentUser,
  forgotPassword,
  verifyResetOtp,
  resetPassword,
} from "../controllers/auth.controller.js";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import { forgotPasswordRateLimit } from "../middlewares/forgot-password-rate-limit.middleware.js";

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.post("/forgot-password", forgotPasswordRateLimit, forgotPassword);
router.post("/verify-reset-otp", verifyResetOtp);
router.post("/reset-password", resetPassword);
router.get("/me", authMiddleware, me);
router.patch("/me", authMiddleware, updateCurrentUser);

export default router;