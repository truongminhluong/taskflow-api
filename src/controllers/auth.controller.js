import * as authService from "../services/auth.service.js";

export async function register(req, res, next) {
  try {
    const { name, email, password } = req.body ?? {};

    const validEmail =
      typeof email === "string" &&
      email.trim().length <= 254 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.trim().length > 100 ||
      !validEmail ||
      typeof password !== "string" ||
      password.length < 8 ||
      Buffer.byteLength(password, "utf8") > 72
    ) {
      return res.status(400).json({
        message:
          "Vui lòng nhập tên, email hợp lệ và mật khẩu từ 8 ký tự, tối đa 72 byte.",
      });
    }

    const data = await authService.register({
      name,
      email,
      password,
    });

    return res.status(201).json({
      message: "Đăng ký thành công",
      data,
    });
  } catch (error) {
    next(error);
  }
}

export async function login(req, res, next) {
  try {
    const { email, password } = req.body ?? {};

    if (
      typeof email !== "string" ||
      !email.trim() ||
      typeof password !== "string" ||
      !password ||
      Buffer.byteLength(password, "utf8") > 72
    ) {
      return res.status(400).json({
        message: "Vui lòng nhập email và mật khẩu hợp lệ.",
      });
    }

    const data = await authService.login({
      email,
      password,
    });

    return res.status(200).json({
      message: "Đăng nhập thành công",
      data,
    });
  } catch (error) {
    next(error);
  }
}

export async function me(req, res, next) {
  try {
    const data = await authService.getCurrentUser(
      req.user.userId
    );

    return res.status(200).json({
      message: "Lấy thông tin tài khoản thành công",
      data,
    });
  } catch (error) {
    next(error);
  }
}

export async function updateCurrentUser(req, res, next) {
  try {
    const body = req.body;
    const keys = body && typeof body === "object" && !Array.isArray(body)
      ? Object.keys(body)
      : [];
    const name = body?.name;

    if (
      keys.length !== 1 ||
      keys[0] !== "name" ||
      typeof name !== "string" ||
      !name.trim() ||
      name.trim().length > 100
    ) {
      return res.status(400).json({
        message: "Tên phải có từ 1 đến 100 ký tự.",
      });
    }

    const data = await authService.updateCurrentUser(req.user.userId, {
      name: name.trim(),
    });

    return res.status(200).json({
      message: "Cập nhật thông tin cá nhân thành công.",
      data,
    });
  } catch (error) {
    next(error);
  }
}

export async function forgotPassword(req, res, next) {
  try {
    const { email } = req.body ?? {};
    const validEmail =
      typeof email === "string" &&
      email.trim().length <= 254 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

    if (!validEmail) {
      return res.status(400).json({
        message: "Vui lòng nhập email hợp lệ.",
      });
    }

    await authService.forgotPassword(email);

    return res.status(200).json({
      message: "Nếu email tồn tại, mã xác thực sẽ được gửi.",
    });
  } catch (error) {
    next(error);
  }
}

export async function verifyResetOtp(req, res, next) {
  try {
    const { email, otp } = req.body ?? {};
    const validEmail =
      typeof email === "string" &&
      email.trim().length <= 254 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

    if (!validEmail || typeof otp !== "string" || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({
        message: "Vui lòng nhập email hợp lệ và OTP gồm 6 chữ số.",
      });
    }

    const data = await authService.verifyResetOtp(email, otp);

    return res.status(200).json({
      message: "Xác thực OTP thành công.",
      data,
    });
  } catch (error) {
    next(error);
  }
}

export async function resetPassword(req, res, next) {
  try {
    const { email, resetToken, newPassword } = req.body ?? {};
    const validEmail =
      typeof email === "string" &&
      email.trim().length <= 254 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

    if (
      !validEmail ||
      typeof resetToken !== "string" ||
      !/^[a-f\d]{64}$/i.test(resetToken) ||
      typeof newPassword !== "string" ||
      newPassword.length < 8 ||
      Buffer.byteLength(newPassword, "utf8") > 72
    ) {
      return res.status(400).json({
        message:
          "Vui lòng nhập email, reset token hợp lệ và mật khẩu từ 8 ký tự, tối đa 72 byte.",
      });
    }

    await authService.resetPassword(email, resetToken, newPassword);

    return res.status(200).json({
      message: "Đặt lại mật khẩu thành công.",
    });
  } catch (error) {
    next(error);
  }
}