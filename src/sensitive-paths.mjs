/**
 * Host 动作的保守敏感路径规则。只判断项目内路径，不代替 Host Root 沙箱；
 * 依赖/构建目录是搜索噪声，不属于这里的敏感文件拒绝规则。
 */

const SENSITIVE_DIRS = new Set([".ssh", ".aws", ".azure", ".gnupg"]);
const SENSITIVE_FILES = new Set([
  ".npmrc", ".pypirc", ".netrc", "credentials.json",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
]);
const SAMPLE_SUFFIXES = new Set(["example", "sample", "template", "dist"]);

function sensitiveName(name) {
  const lower = name.toLowerCase();
  if (SENSITIVE_DIRS.has(lower) || SENSITIVE_FILES.has(lower)) return true;
  if (lower === ".env") return true;
  if (lower.startsWith(".env.")) {
    const suffix = lower.slice(5).split(".").at(-1);
    return !SAMPLE_SUFFIXES.has(suffix);
  }
  return lower.endsWith(".key") || lower.endsWith(".pem") ||
    lower.endsWith(".p12") || lower.endsWith(".pfx");
}

/** 路径任一层为敏感目录，或最终文件名为敏感项，就拒绝对网页暴露。 */
export function isSensitivePath(relativePath) {
  return String(relativePath ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== ".")
    .some(sensitiveName);
}
