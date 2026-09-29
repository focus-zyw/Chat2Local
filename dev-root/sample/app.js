// dev-root 固定样例：工具测试的 search / read 目标（行号稳定，改动需同步测试预期）
const GREETING = "hello";

function greet(name) {
  return GREETING + ", " + name + "!";
}

function formatName(first, last) {
  return last + " " + first;
}

module.exports = { greet, formatName };
