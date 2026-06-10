const fs = require("fs");
const path = require("path");

const ENV_PATH = path.resolve(process.cwd(), ".env");

function parseEnvFile(contents) {
  const result = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const firstEquals = line.indexOf("=");
    if (firstEquals === -1) {
      continue;
    }

    const key = line.slice(0, firstEquals).trim();
    const value = line.slice(firstEquals + 1).trim();
    result[key] = value;
  }
  return result;
}

function serializeEnv(data) {
  const keys = Object.keys(data).sort();
  return `${keys.map((key) => `${key}=${data[key] ?? ""}`).join("\n")}\n`;
}

function loadEnvFile() {
  if (!fs.existsSync(ENV_PATH)) {
    return {};
  }
  const contents = fs.readFileSync(ENV_PATH, "utf8");
  return parseEnvFile(contents);
}

function saveEnvFile(data) {
  const serialized = serializeEnv(data);
  fs.writeFileSync(ENV_PATH, serialized, "utf8");
}

function getEffectiveConfig() {
  const fileData = loadEnvFile();
  return { ...fileData, ...process.env };
}

function updateConfigFields(fields) {
  const current = loadEnvFile();
  for (const [key, value] of Object.entries(fields)) {
    current[key] = `${value ?? ""}`;
    process.env[key] = `${value ?? ""}`;
  }
  saveEnvFile(current);
  return current;
}

module.exports = {
  ENV_PATH,
  getEffectiveConfig,
  loadEnvFile,
  updateConfigFields
};
