import jwt from "jsonwebtoken";

export function authMiddleware(req, res, next) {
  const authorization = req.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    return res.status(401).json({
      message: "Bạn cần đăng nhập để thực hiện thao tác này.",
    });
  }

  const token = authorization.slice(7).trim();

  if (!token) {
    return res.status(401).json({
      message: "Token không hợp lệ.",
    });
  }

  const secret = process.env.JWT_SECRET;

  if (!secret || secret.length < 32) {
    return res.status(500).json({
      message: "Máy chủ chưa cấu hình xác thực.",
    });
  }

  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ["HS256"],
    });

    if (
      typeof payload === "string" ||
      typeof payload.userId !== "string" ||
      !/^[a-fA-F0-9]{24}$/.test(payload.userId)
    ) {
      return res.status(401).json({
        message: "Token không hợp lệ.",
      });
    }

    req.user = {
      userId: payload.userId,
    };

    return next();
  } catch (error) {
    if (
      error.name === "TokenExpiredError" ||
      error.name === "JsonWebTokenError" ||
      error.name === "NotBeforeError"
    ) {
      return res.status(401).json({
        message: "Token không hợp lệ hoặc đã hết hạn.",
      });
    }

    return next(error);
  }
}