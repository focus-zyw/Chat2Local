/**
 * Mock 聊天页服务器 —— 服务 scripts/mock-chat.html，供端到端自测使用。
 * 默认尝试 127.0.0.1:8642；端口被占用时自动回退到系统分配端口。
 */

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 8642;
const PAGE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "mock-chat.html");

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

export async function startMockServer({ port = PORT } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const html = await readFile(PAGE_PATH, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });
  try {
    await listen(server, port);
  } catch (err) {
    if (err?.code !== "EADDRINUSE" || port === 0) throw err;
    await listen(server, 0);
  }
  return server;
}

export function mockServerUrl(server) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock 服务器尚未监听");
  }
  return `http://127.0.0.1:${address.port}/`;
}

export const MOCK_PORT = PORT;
export const MOCK_URL = `http://127.0.0.1:${PORT}/`;
