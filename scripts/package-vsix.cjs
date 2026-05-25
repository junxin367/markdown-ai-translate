const { mkdirSync } = require("fs");
const { spawnSync } = require("child_process");
const path = require("path");
const pkg = require("../package.json");

const releaseDir = path.resolve(__dirname, "..", "release");
const vsceEntrypoint = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "@vscode",
  "vsce",
  "vsce"
);
const outFile = path.join(
  releaseDir,
  `Markdown AI Translate By junes-${pkg.version}.vsix`
);

mkdirSync(releaseDir, { recursive: true });

const result = spawnSync(process.execPath, [vsceEntrypoint, "package", "--out", outFile], {
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
