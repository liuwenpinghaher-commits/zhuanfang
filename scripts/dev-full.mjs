import { spawn } from "node:child_process";
import { EOL } from "node:os";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const apiHealthUrl = process.env.PRODUCT_API_HEALTH_URL ?? "http://127.0.0.1:3210/api/health";
const webUrl = process.env.PRODUCT_WEB_URL ?? "http://127.0.0.1:3220";
const children = [];
let shuttingDown = false;

if (await isReachable(apiHealthUrl)) {
  process.stdout.write(`[api] reusing ${apiHealthUrl}${EOL}`);
} else {
  start("api", ["run", "dev:api"]);
}

if (await isReachable(webUrl)) {
  process.stdout.write(`[web] reusing ${webUrl}${EOL}`);
} else {
  start("web", ["run", "dev", "--", "--host", "127.0.0.1"]);
}

if (children.length === 0) {
  process.stdout.write(`Product API and web app are already running. Press Ctrl+C to exit this monitor.${EOL}`);
  setInterval(() => undefined, 60_000);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

function start(label, args) {
  const child = spawn(npmCommand, args, {
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"]
  });
  children.push(child);
  pipeWithPrefix(label, child.stdout);
  pipeWithPrefix(label, child.stderr);

  child.once("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    const reason = signal ? `signal ${signal}` : `exit code ${code ?? 0}`;
    process.stderr.write(`[${label}] stopped with ${reason}${EOL}`);
    shutdown(signal ?? "SIGTERM", code ?? 1);
  });
}

async function isReachable(url) {
  try {
    const response = await fetch(url, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

function pipeWithPrefix(label, stream) {
  let buffered = "";
  stream.on("data", (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      process.stdout.write(`[${label}] ${line}${EOL}`);
    }
  });
  stream.on("end", () => {
    if (buffered) {
      process.stdout.write(`[${label}] ${buffered}${EOL}`);
    }
  });
}

function shutdown(signal, exitCode = 0) {
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
    }
  }
  setTimeout(() => process.exit(exitCode), 250).unref();
}
