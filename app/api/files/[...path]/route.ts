import path from "node:path";

import { readStorageFile } from "@/lib/storage/asset-manager";
import { fail, handleRouteError } from "@/lib/utils/route";

function getContentType(pathname: string) {
  const normalized = pathname.toLowerCase();
  if (normalized.endsWith(".png")) return "image/png";
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) return "image/jpeg";
  if (normalized.endsWith(".webp")) return "image/webp";
  if (normalized.endsWith(".gif")) return "image/gif";
  if (normalized.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  if (normalized.endsWith(".json")) return "application/json; charset=utf-8";
  if (normalized.endsWith(".zip")) return "application/zip";
  return "application/octet-stream";
}

export async function GET(
  _request: Request,
  context: { params: { path: string[] } },
) {
  try {
    const segments = context.params.path;
    const unsafe = segments.some(
      segment =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        // A single URL segment must never carry a path separator, even when the
        // client encodes it (%2f / %5c) so the router cannot split it for us.
        /[\/\\\0]/.test(segment) ||
        path.isAbsolute(segment),
    );
    if (unsafe) return fail("INVALID_PATH", "文件路径无效。", null, 400);

    const relativePath = segments.join("/");
    const buffer = await readStorageFile(relativePath);
    const contentType = getContentType(relativePath);

    return new Response(buffer, {
      headers: {
        "Content-Type": String(contentType),
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
