import { NextRequest } from "next/server";
import { readProviderCredentialsFromRequest } from "@/lib/services/provider-runtime";
import type { AgentCredentials } from "./runtime";
export function agentCredentials(request: NextRequest): AgentCredentials {
  let tokens: Record<string, string> = {};
  try { const raw = JSON.parse(request.headers.get("x-mxpage-mcp-tokens") || "{}"); for (const [id, token] of Object.entries(raw)) if (typeof token === "string" && token.length < 5000) tokens[id] = token; } catch { /* Missing optional tool credentials. */ }
  return { ...readProviderCredentialsFromRequest(request), tavilyKey: request.headers.get("x-mxpage-tavily-key") || undefined, mcpTokens: tokens };
}
const LOCAL_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(?::\d+)?$/i;
export function sameOrigin(request: NextRequest) {
  const host = request.headers.get("host") || "";
  // The local server is loopback-only. Rejecting a non-loopback Host closes the
  // DNS-rebinding hole where a hostile origin resolves its own domain to 127.0.0.1,
  // making Origin and Host agree on the attacker's hostname.
  if (!LOCAL_HOST.test(host)) throw new Error("Agent: 拒绝非本机来源的请求。");
  const origin = request.headers.get("origin");
  if (origin) {
    // Next's internal request URL can use localhost behind the standalone server.
    // The browser's Origin must match the actual Host header, not that internal URL.
    let originHost: string | null = null;
    try { originHost = new URL(origin).host; } catch { originHost = null; }
    if (!originHost || originHost !== host) throw new Error("Agent: 拒绝跨站修改请求。");
  }
  if (!["same-origin", "none", null].includes(request.headers.get("sec-fetch-site"))) throw new Error("Agent: 拒绝跨站请求。");
}
