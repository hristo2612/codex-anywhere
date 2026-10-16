// LaunchAgent entry point. launchd cannot open files on an external volume and
// macOS blocks /bin/bash there too, so node starts the server directly.
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
process.chdir(root);
process.env.PATH = [
  path.dirname(process.execPath),
  "/opt/homebrew/bin",
  "/usr/bin",
  "/bin",
  process.env.PATH || "",
].join(":");
// Codex CLI for the app-server: CODEX_CLI_PATH, else a CLI unpacked into
// bin/codex-cli, else `codex` on PATH.
const isExecutable = (file) => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};
const bundledCli = path.join(root, "bin/codex-cli/bin/codex");
process.env.CODEX_CLI_PATH ||=
  [bundledCli, ...process.env.PATH.split(":").filter(Boolean).map((dir) => path.join(dir, "codex"))].find(isExecutable) ?? "";
if (!process.env.CODEX_CLI_PATH) delete process.env.CODEX_CLI_PATH;

// launchd appends stdout/stderr to one file forever (opened O_APPEND), so cap
// it here: past the limit, the log is copied to server.log.1 (one generation)
// and truncated in place; later writes land at the new end.
const logPath = process.env.CODEX_ANYWHERE_LOG || path.join(os.homedir(), "Library/Logs/codex-anywhere/server.log");
const logMaxBytes = Number(process.env.CODEX_ANYWHERE_LOG_MAX_BYTES) || 20 * 1024 * 1024;
function rotateLog() {
  try {
    const out = fs.fstatSync(1);
    const log = fs.statSync(logPath);
    if (out.ino !== log.ino || out.dev !== log.dev || log.size < logMaxBytes) return;
    fs.copyFileSync(logPath, `${logPath}.1`);
    fs.ftruncateSync(1, 0);
  } catch {}
}
rotateLog();
setInterval(rotateLog, 5 * 60 * 1000).unref();

// Some app log lines are huge (a ~68 KB runtime config dump, repeated); keep
// the first 8 KB of any line.
const lineMax = 8 * 1024;
const cutLongLines = (text) =>
  text.length <= lineMax
    ? text
    : text
        .split("\n")
        .map((line) => (line.length > lineMax ? `${line.slice(0, lineMax)} [${line.length - lineMax} chars cut]` : line))
        .join("\n");
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => write(typeof chunk === "string" ? cutLongLines(chunk) : chunk, ...rest);
}

const main = path.join(root, "src/server/main.js");
process.argv = [process.argv[0], main, "--host", "127.0.0.1", "--port", process.env.PORT || "8200"];
require(main);
