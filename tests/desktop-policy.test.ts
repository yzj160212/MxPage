import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { validateCall } = require("../desktop/agent-policy.cjs") as {
  validateCall: (grant: unknown, name: string, args: Record<string, unknown>) => unknown;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mxpage-policy-guard-"));
const approved = path.join(tmp, "approved");
fs.mkdirSync(approved, { recursive: true });
fs.writeFileSync(path.join(approved, "inside.txt"), "ok");
fs.writeFileSync(path.join(tmp, "outside.txt"), "outside");
fs.symlinkSync(tmp, path.join(approved, "link"));

const grant = {
  stopped: false,
  plan: {
    applications: ["com.apple.TextEdit"],
    directories: [approved],
    tools: ["computer"],
  },
};

test("批准目录内的真实文件通过", () => {
  assert.doesNotThrow(() => validateCall(grant, "type", { path: path.join(approved, "inside.txt") }));
});

test("批准目录内的符号链接不能指向目录外", () => {
  assert.throws(
    () => validateCall(grant, "type", { path: path.join(approved, "link", "outside.txt") }),
    /超出批准的目录范围/,
  );
});

test("批准目录本身之外的绝对路径被拒绝", () => {
  assert.throws(
    () => validateCall(grant, "type", { path: path.join(tmp, "outside.txt") }),
    /超出批准的目录范围/,
  );
});

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});