import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export function safeTaskAttachmentErrorType(error, fallback = "Error") {
  const name = error?.name;
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name)
    ? name
    : fallback;
}

export function createTaskAttachmentPerformanceContext() {
  return {
    requestId: randomUUID(),
    startedAt: performance.now(),
    stage: "request_received",
  };
}

export function startTaskAttachmentPerformance(req, res, next) {
  const context = createTaskAttachmentPerformanceContext();
  req.taskAttachmentPerformance = context;
  logTaskAttachmentPerformance(context, "request_received");

  res.once("finish", () => {
    if (res.statusCode >= 400) {
      logTaskAttachmentPerformance(context, "request_failed", {
        stage: context.stage,
        error_type: "HttpError",
      });
    }
    logTaskAttachmentPerformance(context, "request_completed", {
      request_total_ms: durationMs(context.startedAt),
      status: res.statusCode,
    });
  });

  next();
}

export function logTaskAttachmentPerformance(context, event, fields = {}) {
  if (!context) return;
  try {
    console.info(
      `[ATTACH_PERF] ${JSON.stringify({
        request_id: context.requestId,
        event,
        ...fields,
      })}`
    );
  } catch {
    // Diagnostics must never affect upload results or mask an upload error.
  }
}

export function startTaskAttachmentTimer() {
  return performance.now();
}

export function durationMs(startedAt) {
  return Number((performance.now() - startedAt).toFixed(2));
}

export function measureTaskAttachmentMultipart(uploadMiddleware) {
  return (req, res, next) => {
    const startedAt = performance.now();
    const context = req.taskAttachmentPerformance;
    if (context) context.stage = "multipart";

    uploadMiddleware(req, res, (error) => {
      if (context) {
        logTaskAttachmentPerformance(context, "multipart_received", {
          multipart_ms: durationMs(startedAt),
          success: !error,
          ...(error ? { error_type: safeTaskAttachmentErrorType(error) } : {}),
        });
      }
      if (error) {
        next(error);
        return;
      }
      next();
    });
  };
}
