import assert from "node:assert/strict";
import test from "node:test";

import { middleware } from "../middleware";
import { NextRequest } from "next/server";

const LOCAL = "127.0.0.1:3000";

function guard(url: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return middleware(new NextRequest(url, init as never));
}

function isPass(response: Response) {
  return response.headers.get("x-middleware-next") === "1";
}

test("拒绝非本机 Host（DNS rebinding 防护）", async () => {
  const get = guard("http://evil.com:3000/api/projects", { headers: { host: "evil.com:3000" } });
  assert.equal(get.status, 403);
  const post = guard("http://evil.com:3000/api/projects", {
    method: "POST",
    headers: { host: "evil.com:3000", origin: "http://evil.com:3000" },
  });
  assert.equal(post.status, 403);
});

test("拒绝跨站 Origin 的写请求", async () => {
  const response = guard("http://127.0.0.1:3000/api/projects", {
    method: "POST",
    headers: { host: LOCAL, origin: "http://evil.com", "sec-fetch-site": "cross-site" },
  });
  assert.equal(response.status, 403);
});

test("放行同源写请求", async () => {
  const response = guard("http://127.0.0.1:3000/api/projects", {
    method: "POST",
    headers: { host: LOCAL, origin: `http://${LOCAL}`, "sec-fetch-site": "same-origin" },
  });
  assert.ok(isPass(response), `status=${response.status}`);
});

test("放行无 Origin 的本机客户端（curl / 脚本）", async () => {
  const response = guard("http://127.0.0.1:3000/api/projects", {
    method: "POST",
    headers: { host: LOCAL },
  });
  assert.ok(isPass(response), `status=${response.status}`);
});

test("放行本机只读请求", async () => {
  const response = guard("http://127.0.0.1:3000/api/files/a.png", { headers: { host: LOCAL } });
  assert.ok(isPass(response), `status=${response.status}`);
});