import nodemailer from "nodemailer";

function getMailConfiguration() {
  const { MAIL_HOST, MAIL_PORT, MAIL_USER, MAIL_PASSWORD, MAIL_FROM } =
    process.env;

  if (!MAIL_HOST || !MAIL_PORT || !MAIL_USER || !MAIL_PASSWORD || !MAIL_FROM) {
    throw new Error("Chưa cấu hình đầy đủ thông tin SMTP.");
  }

  const port = Number(MAIL_PORT);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Cấu hình MAIL_PORT không hợp lệ.");
  }

  return {
    host: MAIL_HOST,
    port,
    secure: false,
    auth: {
      user: MAIL_USER,
      pass: MAIL_PASSWORD,
    },
    from: MAIL_FROM,
  };
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };

    return entities[character];
  });
}

export async function sendPasswordResetOtpEmail(email, otp) {
  const configuration = getMailConfiguration();
  const transport = nodemailer.createTransport({
    host: configuration.host,
    port: configuration.port,
    secure: configuration.secure,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    auth: {
      user: configuration.auth.user,
      pass: configuration.auth.pass,
    },
  });

  try {
    await transport.sendMail({
      from: configuration.from,
      to: email,
      subject: "Mã xác thực đặt lại mật khẩu TaskFlow",
      text: `Mã xác thực đặt lại mật khẩu TaskFlow của bạn là: ${otp}\n\nMã này sẽ hết hạn sau 5 phút. Không chia sẻ mã OTP này với bất kỳ ai.\n\nNếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này.`,
      html: `<p>Mã xác thực đặt lại mật khẩu TaskFlow của bạn là:</p><p style="font-size: 28px; font-weight: bold; letter-spacing: 6px;">${escapeHtml(otp)}</p><p>Mã này sẽ hết hạn sau 5 phút.</p><p><strong>Không chia sẻ mã OTP này với bất kỳ ai.</strong></p><p>Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này.</p>`,
    });
  } finally {
    transport.close();
  }
}

export async function verifyMailConnection() {
  const configuration = getMailConfiguration();
  const transport = nodemailer.createTransport({
    host: configuration.host,
    port: configuration.port,
    secure: configuration.secure,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    auth: {
      user: configuration.auth.user,
      pass: configuration.auth.pass,
    },
  });

  try {
    return await transport.verify();
  } finally {
    transport.close();
  }
}
