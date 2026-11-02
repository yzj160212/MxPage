import { NextResponse, type NextRequest } from "next/server";

// MxPage's HTTP surface is a loopback-only, single-user local service. It has no
// authentication, so the only thing that keeps another web page (or a DNS-rebinding
// domain) out is a strict origin check. Enforce it once, for every API route.
const LOCAL_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(?::\d+)?$/i;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function forbidden(code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status: 403 });
}

export function middleware(request: NextRequest) {
  const host = request.headers.get("host") || "";
  // Reject non-loopback Hosts on every method. A DNS-rebinding page resolves its
  // own domain to 127.0.0.1, so Origin and Host both look "same-origin" while the
  // real origin is remote. Only a loopback Host can be the local service.
  if (!LOCAL_HOST.test(host)) return forbidden("FORBIDDEN_ORIGIN", "仅允许从本机访问本地服务。");

  if (MUTATING.has(request.method.toUpperCase())) {
    const origin = request.headers.get("origin");
    if (origin) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
      if (!originHost || originHost !== host) return forbidden("FORBIDDEN_ORIGIN", "拒绝跨站修改请求。");
    }
    const site = request.headers.get("sec-fetch-site");
    if (site && !["same-origin", "none"].includes(site)) return forbidden("FORBIDDEN_ORIGIN", "拒绝跨站请求。");
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};