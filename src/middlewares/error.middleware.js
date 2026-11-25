function safeErrorMessage(value) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]")
    .replace(/(api[_-]?key|secret|token|password)=\S+/gi, "$1=[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 500);
}

function safeErrorDetails(error) {
  const cause = error.cause;
  const nestedCause = cause?.cause;
  const cleanupError = error.cleanupError;

  return {
    operation: error.operation || "http-request",
    errorName: error.name,
    errorMessage: safeErrorMessage(error.message),
    errorCode: error.code,
    httpStatus: error.statusCode || error.status || error.http_code,
    causeName: cause?.name,
    causeMessage: safeErrorMessage(cause?.message),
    causeCode: cause?.code,
    nestedCauseName: nestedCause?.name,
    nestedCauseMessage: safeErrorMessage(nestedCause?.message),
    nestedCauseCode: nestedCause?.code,
    upstreamErrorName: error.upstreamErrorName,
    upstreamErrorMessage: safeErrorMessage(error.upstreamErrorMessage),
    upstreamErrorStatusCode: error.upstreamErrorStatusCode,
    upstreamErrorCode: error.upstreamErrorCode,
    cleanupErrorName: cleanupError?.name,
    cleanupErrorCode: cleanupError?.code,
  };
}

function developmentStack(error) {
  const stack = error.stack?.split("\n").slice(1).join("\n");
  if (!stack) {
    return undefined;
  }

  return [
    process.env.MAIL_PASSWORD,
    process.env.JWT_SECRET,
    process.env.CLOUDINARY_API_SECRET,
    process.env.CLOUDINARY_API_KEY,
  ]
    .filter((secret) => typeof secret === "string" && secret.length > 0)
    .reduce(
      (redactedStack, secret) => redactedStack.split(secret).join("[REDACTED]"),
      stack
    );
}

function shouldLogStack() {
    return process.env.NODE_ENV === "development" || !process.env.NODE_ENV;
}

export function notFoundHandler(req, res, next) {
  res.status(404).json({
    message: `Không tìm thấy API: ${req.method} ${req.originalUrl}`,
  });
}

export function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  if (err.type === "entity.parse.failed") {
    return res.status(400).json({
      message: "JSON request không hợp lệ.",
    });
  }

  if (err.name === "ValidationError") {
    return res.status(400).json({
      message: "Dữ liệu không hợp lệ.",
    });
  }

  if (err.name === "CastError") {
    return res.status(400).json({
      message: "ID hoặc dữ liệu không hợp lệ.",
    });
  }

  if (err.code === 11000) {
    return res.status(409).json({
      message: "Dữ liệu đã tồn tại.",
    });
  }

  const statusCode = err.statusCode || 500;

  if (statusCode >= 500) {
    const details = safeErrorDetails(err);
    const includeStack = shouldLogStack();
    const stack = includeStack ? developmentStack(err) : undefined;
    const causeStack =
      includeStack && err.cause ? developmentStack(err.cause) : undefined;

    console.error("Request failed", {
      ...details,
      ...(stack ? { stack } : {}),
      ...(causeStack ? { causeStack } : {}),
    });

    if (err.cleanupError) {
      const cleanupStack = includeStack
        ? developmentStack(err.cleanupError)
        : undefined;
      console.error("Reset-token cleanup failed", {
        ...safeErrorDetails(err.cleanupError),
        ...(cleanupStack ? { stack: cleanupStack } : {}),
      });
    }
  }

  return res.status(statusCode).json({
    message:
      statusCode >= 500
        ? "Lỗi máy chủ."
        : err.message,
  });
}
