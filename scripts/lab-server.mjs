/**
 * Lab 服务器 —— 会话状态验证用：服务 mock-lab.html，接收页面内存状态的
 * beacon 取证，供验证驱动脚本事后核对（单会话、标记不变、展开态迁移）。
 * 用法：node scripts/lab-server.mjs [port]（默认 8765，被占用时回退随机端口，
 * 并向 stdout 打印 LAB-SERVER <实际端口>）。
 */

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.argv[2]) || 8765;
const PAGE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "mock-lab.html");
const beacons = [];

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("error", onError);
      reject(err);
    };
    const onListening = () => {
      server.off("listening", onListening);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/beacon") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        try {
          beacons.push(JSON.parse(body));
        } catch {
          /* 非 JSON beacon 忽略 */
        }
        res.writeHead(204);
        res.end();
      });
      return;
    }
    if (req.method === "GET" && req.url === "/beacons") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(beacons));
      return;
    }
    if (req.method === "GET") {
      const html = await readFile(PAGE_PATH, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    res.writeHead(405);
    res.end();
  } catch (err) {
    res.writeHead(500);
    res.end(String(err));
  }
});

let port = PORT;
try {
  await listen(server, port);
} catch (err) {
  if (err?.code !== "EADDRINUSE") throw err;
  await listen(server, 0);
  port = server.address().port;
}
process.stdout.write(`LAB-SERVER ${port}\n`);
