const fs = require("fs");
const path = require("path");

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

const ROOT_DIR = process.cwd();
const TARGET_FILES = ["package.json", "vss-extension-ai-assistant.json"].map((relativePath) =>
  path.resolve(ROOT_DIR, relativePath)
);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseVersion(version) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid version '${version}'. Expected format: X.Y.Z`);
  }
  return version.split(".").map((part) => Number(part));
}

function bumpPatch(version) {
  const [major, minor, patch] = parseVersion(version);
  return `${major}.${minor}.${patch + 1}`;
}

function resolveNextVersion(args, currentVersion) {
  const explicitVersion = args.find((arg) => !arg.startsWith("-"));
  if (explicitVersion) {
    parseVersion(explicitVersion);
    return explicitVersion;
  }
  return bumpPatch(currentVersion);
}

function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const packageJson = readJson(TARGET_FILES[0]);
  const currentVersion = String(packageJson.version || "").trim();

  if (!currentVersion) {
    throw new Error("package.json is missing version.");
  }

  const nextVersion = resolveNextVersion(args, currentVersion);

  if (isDryRun) {
    console.log(`[dry-run] ${currentVersion} -> ${nextVersion}`);
    return;
  }

  for (const filePath of TARGET_FILES) {
    const json = readJson(filePath);
    json.version = nextVersion;
    writeJson(filePath, json);
  }

  console.log(`Version bumped: ${currentVersion} -> ${nextVersion}`);
}

main();
