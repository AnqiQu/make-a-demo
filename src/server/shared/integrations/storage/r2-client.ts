import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { R2ObjectStorage } from "./r2-supporting-document-loader";
import type {
  GetPresignerInput,
  PutObjectInput,
  PutPresignerInput,
  R2UploadStorage,
} from "./r2-upload-presigner";

export function createR2UploadPresignerFromEnv(): R2UploadStorage &
  R2ObjectStorage {
  const accountId = readRequiredEnv("R2_ACCOUNT_ID");
  const accessKeyId = readRequiredEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = readRequiredEnv("R2_SECRET_ACCESS_KEY");
  const bucket = readRequiredEnv("R2_BUCKET");
  const client = new S3Client({
    credentials: { accessKeyId, secretAccessKey },
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    region: "auto",
  });

  return {
    bucket,
    async putObject(input: PutObjectInput) {
      await client.send(
        new PutObjectCommand({
          Body: input.body,
          Bucket: input.bucket,
          ContentType: input.contentType,
          Key: input.key,
        }),
      );
    },
    async getObject(input) {
      const response = await client.send(
        new GetObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
        }),
      );
      if (!response.Body) {
        throw new Error(`R2 object ${input.key} was empty`);
      }

      return response.Body.transformToByteArray();
    },
    async presignGet(input: GetPresignerInput) {
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
        }),
        { expiresIn: 60 * 10 },
      );
    },
    async presignPut(input: PutPresignerInput) {
      return getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: input.bucket,
          ContentType: input.contentType,
          Key: input.key,
        }),
        { expiresIn: 60 * 10 },
      );
    },
  };
}

function readRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}
