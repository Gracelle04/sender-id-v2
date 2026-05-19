const Minio = require('minio');

const useSSL = process.env.MINIO_USE_SSL === 'true';
const port   = parseInt(process.env.MINIO_PORT, 10) || (useSSL ? 443 : 9000);

const client = new Minio.Client({
  endPoint:  process.env.MINIO_ENDPOINT.replace(/^https?:\/\//, ''),
  port,
  useSSL,
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY,
});

const BUCKET = process.env.MINIO_BUCKET || 'sender-v2';

async function ensureBucket() {
  const exists = await client.bucketExists(BUCKET);
  if (!exists) await client.makeBucket(BUCKET);
}

// Upload a buffer or stream — returns the object URL
async function upload(objectName, stream, size, contentType) {
  await client.putObject(BUCKET, objectName, stream, size, { 'Content-Type': contentType });
  return getUrl(objectName);
}

// Generate a presigned GET URL (valid 7 days by default)
function getUrl(objectName, expirySeconds = 7 * 24 * 3600) {
  return client.presignedGetObject(BUCKET, objectName, expirySeconds);
}

// Delete an object
async function remove(objectName) {
  await client.removeObject(BUCKET, objectName);
}

module.exports = { client, BUCKET, ensureBucket, upload, getUrl, remove };
