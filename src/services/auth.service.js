import bcrypt from "bcryptjs";
import { createHash, randomBytes, randomInt } from "node:crypto";
import jwt from "jsonwebtoken";
import User from "../models/user.model.js";
import { sendPasswordResetOtpEmail } from "../config/mail.js";

const OTP_LIFETIME_MS = 5 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const RESET_TOKEN_LIFETIME_MS = 10 * 60 * 1000;
const MAX_RESET_OTP_ATTEMPTS = 5;

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function addOperationContext(error, operation) {
  const contextualError =
    error instanceof Error ? error : new Error("Authentication operation failed");

  contextualError.operation = operation;
  return contextualError;
}

function hashResetValue(value) {
  return createHash("sha256").update(value).digest("hex");
}

function createToken(userId) {
  const secret = process.env.JWT_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET chưa được cấu hình an toàn");
  }

  return jwt.sign(
    { userId: userId.toString() },
    secret,
    {
      algorithm: "HS256",
      expiresIn: "7d",
    }
  );
}

function toPublicUser(user) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
  };
}

export async function register({ name, email, password }) {
  const normalizedEmail = email.trim().toLowerCase();

  const existingUser = await User.findOne({
    email: normalizedEmail,
  });

  if (existingUser) {
    throw createHttpError("Email đã được sử dụng", 409);
  }

  const hashedPassword = await bcrypt.hash(password, 12);

  try {
    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      password: hashedPassword,
    });

    return {
      user: toPublicUser(user),
    };
  } catch (error) {
    if (error.code === 11000) {
      throw createHttpError("Email đã được sử dụng", 409);
    }

    throw error;
  }
}

export async function login({ email, password }) {
  const user = await User.findOne({
    email: email.trim().toLowerCase(),
  }).select("+password");

  if (!user || !(await bcrypt.compare(password, user.password))) {
    throw createHttpError(
      "Email hoặc mật khẩu không chính xác",
      401
    );
  }

  return {
    token: createToken(user._id),
    user: toPublicUser(user),
  };
}

export async function getCurrentUser(userId) {
  const user = await User.findById(userId);

  if (!user) {
    throw createHttpError("Không tìm thấy tài khoản", 404);
  }

  return {
    user: toPublicUser(user),
  };
}

export async function updateCurrentUser(userId, { name }) {
  const user = await User.findByIdAndUpdate(
    userId,
    { $set: { name } },
    { new: true, runValidators: true }
  );

  if (!user) {
    throw createHttpError("Không tìm thấy tài khoản", 404);
  }

  return {
    user: toPublicUser(user),
  };
}

export async function forgotPassword(email) {
  const normalizedEmail = email.trim().toLowerCase();
  let user;

  try {
    user = await User.findOne({ email: normalizedEmail });
  } catch (error) {
    throw addOperationContext(error, "forgot-password.lookup-user");
  }

  if (!user) {
    return;
  }

  const otp = randomInt(0, 1_000_000).toString().padStart(6, "0");
  const otpHash = hashResetValue(otp);
  const now = new Date();
  const resendAllowedBefore = new Date(now.getTime() - OTP_RESEND_COOLDOWN_MS);

  try {
    const result = await User.updateOne(
      {
        _id: user._id,
        $or: [
          { resetOtpSentAt: null },
          { resetOtpSentAt: { $lte: resendAllowedBefore } },
        ],
      },
      {
        $set: {
          resetOtpHash: otpHash,
          resetOtpExpires: new Date(now.getTime() + OTP_LIFETIME_MS),
          resetOtpAttempts: 0,
          resetOtpSentAt: now,
        },
        $unset: {
          resetTokenHash: 1,
          resetTokenExpires: 1,
        },
      }
    );

    if (result.matchedCount !== 1) {
      return;
    }
  } catch (error) {
    throw addOperationContext(error, "forgot-password.save-otp");
  }

  try {
    await sendPasswordResetOtpEmail(normalizedEmail, otp);
  } catch (mailError) {
    try {
      const cleanupResult = await User.updateOne(
        { _id: user._id, resetOtpHash: otpHash },
        {
          $unset: {
            resetOtpHash: 1,
            resetOtpExpires: 1,
            resetOtpSentAt: 1,
          },
          $set: { resetOtpAttempts: 0 },
        }
      );

      if (cleanupResult.matchedCount !== 1) {
        throw new Error("Reset token cleanup did not match the saved token");
      }
    } catch (cleanupError) {
      console.error("Forgot-password OTP cleanup failed", {
        operation: "forgot-password.cleanup-token",
        errorName: cleanupError?.name,
        errorCode: cleanupError?.code,
      });
    }

    console.error("Forgot-password email delivery failed", {
      operation: "forgot-password.send-email",
      errorName: mailError?.name,
      errorCode: mailError?.code,
    });
  }
}

export async function verifyResetOtp(email, otp) {
  const normalizedEmail = email.trim().toLowerCase();
  const otpHash = hashResetValue(otp);
  const now = new Date();
  const resetToken = randomBytes(32).toString("hex");
  const resetTokenHash = hashResetValue(resetToken);

  try {
    const verification = await User.updateOne(
      {
        email: normalizedEmail,
        resetOtpHash: otpHash,
        resetOtpExpires: { $gt: now },
        resetOtpAttempts: { $lt: MAX_RESET_OTP_ATTEMPTS },
      },
      {
        $set: {
          resetTokenHash,
          resetTokenExpires: new Date(now.getTime() + RESET_TOKEN_LIFETIME_MS),
          resetOtpAttempts: 0,
        },
        $unset: {
          resetOtpHash: 1,
          resetOtpExpires: 1,
        },
      }
    );

    if (verification.matchedCount === 1) {
      return { resetToken };
    }
  } catch (error) {
    throw addOperationContext(error, "verify-reset-otp.consume-otp");
  }

  try {
    await User.updateOne(
      {
        email: normalizedEmail,
        resetOtpHash: { $ne: otpHash },
        resetOtpExpires: { $gt: new Date() },
        resetOtpAttempts: { $lt: MAX_RESET_OTP_ATTEMPTS },
      },
      { $inc: { resetOtpAttempts: 1 } }
    );
  } catch (error) {
    throw addOperationContext(error, "verify-reset-otp.record-attempt");
  }

  throw createHttpError("Mã OTP không hợp lệ hoặc đã hết hạn.", 400);
}

export async function resetPassword(email, resetToken, newPassword) {
  const normalizedEmail = email.trim().toLowerCase();
  const resetTokenHash = hashResetValue(resetToken);
  let result;

  try {
    const hashedPassword = await bcrypt.hash(newPassword, 12);
    result = await User.updateOne(
      {
        email: normalizedEmail,
        resetTokenHash,
        resetTokenExpires: { $gt: new Date() },
      },
      {
        $set: { password: hashedPassword },
        $unset: {
          resetOtpHash: 1,
          resetOtpExpires: 1,
          resetOtpAttempts: 1,
          resetOtpSentAt: 1,
          resetTokenHash: 1,
          resetTokenExpires: 1,
        },
      }
    );
  } catch (error) {
    throw addOperationContext(error, "reset-password.consume-token");
  }

  if (result.matchedCount !== 1) {
    throw createHttpError("Reset token không hợp lệ hoặc đã hết hạn.", 400);
  }
}