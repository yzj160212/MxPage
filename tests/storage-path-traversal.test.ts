import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mxpage-storage-guard-"));
const storage = path.join(tmp, "storage");
fs.mkdirSync(path.join(storage, "uploads"), { recursive: true });
fs.writeFileSync(path.join(storage, "ok.txt"), "hello");
fs.writeFileSync(path.join(tmp, "secret.txt"), "SECRET-OUTSIDE-ROOT");

type FileRoute = {
  GET: (request: Request, context: unknown) => Promise<Response>;
};
type StorageModule = {
  readStorageFile: (relativePath: string) => Promise<Buffer>;
};

let route: FileRoute;
let storageModule: StorageModule;

before(async () => {
  process.env.STORAGE_ROOT = storage;
  process.env.APP_SECRET = process.env.APP_SECRET || "local-build-secret-value";
  process.env.DATABASE_URL = process.env.DATABASE_URL || "file:./dev.db";
  route = (await import("../app/api/files/[...path]/route")) as FileRoute;
  storageModule = (await import("../lib/storage/asset-manager")) as StorageModule;
});

const call = (segments: string[]) =>
  route.GET(new Request("http://127.0.0.1/api/files/x", { method: "GET" }), {
    params: { path: segments },
  });

test("文件路由拒绝穿越路径段", async () => {
  for (const segments of [
    ["..", "secret.txt"],
    ["..", "..", "secret.txt"],
    ["..\\secret.txt"],
    ["..\/secret.txt"],
    ["/etc/passwd"],
  ]) {
    const response = await call(segments);
    assert.equal(response.status, 400, `segments=${segments.join("|")}`);
  }
});

test("越过存储根的读请求以 400 拒绝，不泄露内容", async () => {
  const response = await call(["..", "..", "secret.txt"]);
  assert.equal(response.status, 400);
  assert.ok(!(await response.text()).includes("SECRET-OUTSIDE-ROOT"));
});

test("readStorageFile 阻止越出 STORAGE_ROOT", async () => {
  await assert.rejects(() => storageModule.readStorageFile("../../secret.txt"));
});

test("readStorageFile 阻止符号链接逃逸", async () => {
  fs.symlinkSync(tmp, path.join(storage, "link"));
  await assert.rejects(() => storageModule.readStorageFile("link/secret.txt"));
});

test("正常文件仍可读取", async () => {
  const response = await call(["ok.txt"]);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "hello");
});

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});