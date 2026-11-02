import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";

import type { AssetType, ProductAsset } from "@prisma/client";
import { nanoid } from "nanoid";

import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/utils/env";
import { extFromMime, relativeStorageUrl, sanitizeFileName } from "@/lib/utils/files";

function rootDir() {
  return path.resolve(process.cwd(), env.STORAGE_ROOT);
}

async function ensureDir(dirPath: string) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function ensureStorageScaffold() {
  await Promise.all([
    ensureDir(path.join(rootDir(), "uploads")),
    ensureDir(path.join(rootDir(), "generated")),
    ensureDir(path.join(rootDir(), "exports")),
  ]);
}

function projectDir(projectId: string, kind: "uploads" | "generated" | "exports", sectionId?: string) {
  const base = path.join(rootDir(), kind, projectId);
  return sectionId ? path.join(base, sectionId) : base;
}

export async function saveUploadAsset(params: {
  projectId: string;
  type: AssetType;
  fileName: string;
  mimeType?: string | null;
  fileBuffer: Buffer;
  sortOrder: number;
  isMain?: boolean;
  purpose?: "product_identity" | "style_reference";
  uploadKey?: string;
  maxExistingBytes?: number;
  maxTotalBytes?: number;
}) {
  const id = params.uploadKey ? `upload-${createHash("sha256").update(`${params.projectId}:${params.uploadKey}`).digest("hex")}` : undefined;
  const uploadFingerprint = id ? createHash("sha256").update(JSON.stringify([params.fileName, params.mimeType, params.type, params.purpose])).update(params.fileBuffer).digest("hex") : undefined;
  if (id) {
    const existing = await prisma.productAsset.findUnique({ where: { id } });
    if (existing) {
      if ((existing.metadata as { uploadFingerprint?: string })?.uploadFingerprint !== uploadFingerprint) throw new Error("同一上传标识不能用于不同图片。");
      return existing;
    }
  }
  if (params.maxTotalBytes && (params.maxExistingBytes || 0) + params.fileBuffer.length > params.maxTotalBytes) throw new Error("每套原图总量不能超过 300MB，请分批上传。");
  await ensureStorageScaffold();
  const safeName = `${id || `${Date.now()}-${nanoid(6)}`}-${sanitizeFileName(params.fileName)}`;
  const dir = projectDir(params.projectId, "uploads");
  await ensureDir(dir);
  const relativePath = path.join("uploads", params.projectId, safeName);
  await fs.writeFile(path.join(rootDir(), relativePath), params.fileBuffer);

  return prisma.productAsset.create({
    data: {
      ...(id ? { id } : {}),
      projectId: params.projectId,
      type: params.type,
      filePath: relativePath,
      fileName: params.fileName,
      mimeType: params.mimeType,
      sortOrder: params.sortOrder,
      isMain: params.isMain ?? false,
      metadata: {
        bytes: params.fileBuffer.byteLength,
        ...(uploadFingerprint ? { uploadFingerprint } : {}),
        ...(params.purpose ? { purpose: params.purpose } : {}),
      },
    },
  });
}

export async function saveGeneratedImage(params: {
  projectId: string;
  sectionId: string | null;
  prompt: string;
  source: {
    url?: string | null;
    b64Json?: string | null;
    svgText?: string | null;
    mimeType?: string | null;
  };
  metadata?: Record<string, unknown>;
}) {
  await ensureStorageScaffold();
  const dir = projectDir(params.projectId, "generated", params.sectionId ?? "standalone");
  await ensureDir(dir);

  const mimeType =
    params.source.svgText ? "image/svg+xml" : params.source.mimeType ?? "image/png";
  const ext = extFromMime(mimeType);
  const fileName = `${Date.now()}-${nanoid(6)}.${ext}`;
  const relativePath = path.join("generated", params.projectId, params.sectionId ?? "standalone", fileName);
  const absolutePath = path.join(rootDir(), relativePath);

  if (params.source.svgText) {
    await fs.writeFile(absolutePath, params.source.svgText, "utf8");
  } else if (params.source.b64Json) {
    await fs.writeFile(absolutePath, Buffer.from(params.source.b64Json, "base64"));
  } else if (params.source.url) {
    let bytes: Buffer;
    try {
      const response = await fetch(params.source.url, { signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw new Error(`Image download HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (cause) {
      throw Object.assign(new Error("图片已生成，但下载失败。请使用“仅恢复已有图片”重新下载，不需要重新生图。", { cause }), { code: "IMAGE_DOWNLOAD_FAILED" });
    }
    await fs.writeFile(absolutePath, bytes);
  } else {
    throw new Error("Image generation produced no usable image output.");
  }

  return prisma.productAsset.create({
    data: {
      projectId: params.projectId,
      sectionId: params.sectionId,
      type: "GENERATED",
      filePath: relativePath,
      fileName,
      mimeType,
      sortOrder: 0,
      metadata: {
        prompt: params.prompt,
        ...(params.metadata ?? {}),
      },
    },
  });
}

export async function duplicateExportFile(params: {
  projectId: string;
  fileName: string;
  sourceBuffer: Buffer;
  mimeType: string;
}) {
  await ensureStorageScaffold();
  const ext = extFromMime(params.mimeType);
  const safeName = sanitizeFileName(`${params.fileName}.${ext}`);
  const relativePath = path.join("exports", params.projectId, safeName);
  await ensureDir(projectDir(params.projectId, "exports"));
  await fs.writeFile(path.join(rootDir(), relativePath), params.sourceBuffer);

  return prisma.productAsset.create({
    data: {
      projectId: params.projectId,
      type: "EXPORTED",
      filePath: relativePath,
      fileName: safeName,
      mimeType: params.mimeType,
      sortOrder: 0,
    },
  });
}

export async function deleteAssetRecord(assetId: string) {
  const asset = await prisma.productAsset.findUnique({ where: { id: assetId } });
  if (!asset) {
    return null;
  }

  const absolutePath = path.join(rootDir(), asset.filePath);
  await fs.rm(absolutePath, { force: true });
  await prisma.productAsset.delete({ where: { id: assetId } });
  return asset;
}

export function assetPublicUrl(asset: Pick<ProductAsset, "filePath"> | null | undefined) {
  if (!asset) {
    return null;
  }

  return relativeStorageUrl(asset.filePath);
}

// Resolve a storage-relative path and prove it stays inside STORAGE_ROOT.
// Both the lexical path and its realpath (after resolving symlinks) must stay
// within the root, so neither `../` segments nor symlinks can escape the store.
async function resolveStorageFile(relativePath: string) {
  const root = await fs.realpath(rootDir()).catch(() => path.resolve(rootDir()));
  const target = path.resolve(root, String(relativePath ?? ""));
  if (target !== root && !target.startsWith(root + path.sep)) throw Object.assign(new Error("文件路径越界。"), { code: "INVALID_PATH" });
  const real = await fs.realpath(target);
  if (real !== root && !real.startsWith(root + path.sep)) throw Object.assign(new Error("文件路径越界。"), { code: "INVALID_PATH" });
  return real;
}

export async function readStorageFile(relativePath: string) {
  return fs.readFile(await resolveStorageFile(relativePath));
}

export async function statStorageFile(relativePath: string) {
  return fs.stat(await resolveStorageFile(relativePath));
}
