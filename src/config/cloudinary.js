import { v2 as cloudinary } from "cloudinary";

const requiredEnvironmentVariables = [
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
];

export function isCloudinaryConfigured() {
  return requiredEnvironmentVariables.every((name) =>
    Boolean(process.env[name]?.trim())
  );
}

if (isCloudinaryConfigured()) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

export function uploadImageBuffer(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    });
    stream.end(buffer);
  });
}

export function destroyImage(publicId) {
  return cloudinary.uploader.destroy(publicId, {
    invalidate: true,
    resource_type: "image",
  });
}
