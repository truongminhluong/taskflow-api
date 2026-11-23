const WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS = 5;
const requestsByIp = new Map();

const cleanupTimer = setInterval(() => {
  const now = Date.now();

  for (const [ip, entry] of requestsByIp) {
    if (entry.resetAt <= now) {
      requestsByIp.delete(ip);
    }
  }
}, WINDOW_MS);

cleanupTimer.unref();

export function forgotPasswordRateLimit(req, res, next) {
  const email = req.body?.email;

  if (
    typeof email !== "string" ||
    email.trim().length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  ) {
    return next();
  }

  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let entry = requestsByIp.get(ip);

  if (!entry || entry.resetAt <= now) {
    entry = {
      count: 0,
      resetAt: now + WINDOW_MS,
    };
  }

  if (entry.count >= MAX_REQUESTS) {
    res.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));

    return res.status(429).json({
      message: "Tạm thời có quá nhiều yêu cầu. Vui lòng thử lại sau.",
    });
  }

  entry.count += 1;
  requestsByIp.set(ip, entry);

  return next();
}
