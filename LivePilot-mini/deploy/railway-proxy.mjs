import http from "node:http";
import https from "node:https";
import { timingSafeEqual } from "node:crypto";

const username = process.env.BASIC_AUTH_USER;
const password = process.env.BASIC_AUTH_PASSWORD;
if (!username || !password) throw new Error("Set BASIC_AUTH_USER and BASIC_AUTH_PASSWORD before starting the public app.");

const publicPort = Number(process.env.PORT || 3000);
const appPort = Number(process.env.INTERNAL_APP_PORT || 3001);
const app = http.createServer();

function same(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(request) {
  const value = request.headers.authorization || "";
  if (!value.startsWith("Basic ")) return false;
  let decoded;
  try { decoded = Buffer.from(value.slice(6), "base64").toString("utf8"); } catch { return false; }
  const separator = decoded.indexOf(":");
  return separator >= 0 && same(decoded.slice(0, separator), username) && same(decoded.slice(separator + 1), password);
}

function sameOrigin(request) {
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host.toLowerCase() === (request.headers.host || "").toLowerCase(); }
  catch { return false; }
}

function replyUnauthorized(response) {
  response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Streamlabs Rounds", charset="UTF-8"', "Cache-Control": "no-store" });
  response.end("Authentication required.");
}

function proxyRequest(request, response, targetPort, targetPath = request.url) {
  const headers = { ...request.headers };
  const transport = request.socket.encrypted ? https : http;
  const upstream = transport.request({ hostname: "127.0.0.1", port: targetPort, path: targetPath, method: request.method, headers }, (result) => {
    response.writeHead(result.statusCode || 502, result.headers);
    result.pipe(response);
  });
  upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end("Upstream service is not ready."); });
  request.pipe(upstream);
}

app.on("request", (request, response) => {
  if (request.url === "/healthz" && (request.method === "GET" || request.method === "HEAD")) {
    proxyRequest(request, response, appPort, "/");
    return;
  }
  if (!authorized(request)) { replyUnauthorized(response); return; }
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method || "") && !sameOrigin(request)) {
    response.writeHead(403, { "Cache-Control": "no-store" });
    response.end("Cross-site requests are not allowed.");
    return;
  }
  if (request.url?.startsWith("/browser/")) {
    proxyRequest(request, response, 6080, request.url.slice("/browser".length));
    return;
  }
  proxyRequest(request, response, appPort);
});

app.on("upgrade", (request, socket, head) => {
  // Browser WebSocket APIs cannot set Authorization headers. The noVNC page is
  // already Basic-Auth protected; require its same-origin Origin on this socket
  // to prevent cross-site WebSocket hijacking while allowing the browser handshake.
  if (!request.headers.origin || !sameOrigin(request) || !request.url?.startsWith("/browser/")) { socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
  const upstream = http.request({ hostname: "127.0.0.1", port: 6080, path: request.url.slice("/browser".length), method: request.method, headers: { ...request.headers, host: "127.0.0.1:6080" } });
  upstream.on("response", response => {
    const status = response.statusCode || 502;
    const message = response.statusMessage || "Upstream rejected WebSocket";
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
    response.resume();
    socket.destroy();
  });
  upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
    socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`);
    for (const [key, value] of Object.entries(response.headers)) {
      if (Array.isArray(value)) for (const item of value) socket.write(`${key}: ${item}\r\n`);
      else if (value !== undefined) socket.write(`${key}: ${value}\r\n`);
    }
    socket.write("\r\n");
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
  });
  upstream.on("error", () => socket.destroy());
  upstream.end();
});

app.listen(publicPort, "0.0.0.0");
