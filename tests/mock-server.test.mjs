import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startMockServer, mockServerUrl } from "../scripts/mock-server.mjs";

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("mock 端口被占用时自动回退到空闲端口", async (t) => {
  const blocker = http.createServer((_req, res) => res.end("occupied"));
  await listen(blocker);
  t.after(() => close(blocker));
  const occupiedPort = blocker.address().port;

  const server = await startMockServer({ port: occupiedPort });
  t.after(() => close(server));
  const url = mockServerUrl(server);

  assert.notEqual(server.address().port, occupiedPort);
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Mock Chat（file-tool 自测）/);
});
