import { v2 as cloudinary } from "cloudinary";

const requiredEnvironmentVariables = [
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
];

export function isCloudinaryConfigured() {
  return requiredEnvironmentVariables.every(
    (name) => getEnvironmentValue(name) !== null
  );
}

function getEnvironmentValue(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed === value ? trimmed : null;
}

export function cloudinaryConfigurationStatus() {
  return Object.fromEntries(
    requiredEnvironmentVariables.map((name) => [
      name,
      getEnvironmentValue(name) === null ? "MISSING" : "CONFIGURED",
    ])
  );
}

if (isCloudinaryConfigured()) {
  cloudinary.config({
    cloud_name: getEnvironmentValue("CLOUDINARY_CLOUD_NAME"),
    api_key: getEnvironmentValue("CLOUDINARY_API_KEY"),
    api_secret: getEnvironmentValue("CLOUDINARY_API_SECRET"),
    secure: true,
  });
}

console.info("Cloudinary configuration", cloudinaryConfigurationStatus());

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
