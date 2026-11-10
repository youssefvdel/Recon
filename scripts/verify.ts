#!/usr/bin/env bun
/**
 * bun run verify — every check the project owns, in one place.
 *
 * Stages, fail fast, one line each:
 *   1. build:ui       tsc -b + vite build
 *   2. lint           oxlint
 *   3. check scripts  scripts/*-check.ts, all of them, in name order
 *   4. pure rust      cargo test --manifest-path src-tauri/pure/Cargo.toml
 *   5. bun tests      `bun run test`, only once package.json defines it
 *
 * The tauri crate's `cargo test --lib` is deliberately not here: tauri-build
 * validates bundle.resources, so it needs the Windows WebView2 runtime present.
 * release.yml runs this command, then the tauri lib tests after the runtime
 * fetch, then the bundle.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TAIL_LINES = 20;

const env = { ...process.env };
// cargo lives in ~/.cargo/bin on this box, which a non-login PATH misses.
env.PATH = [env.PATH, join(homedir(), ".cargo/bin"), "/usr/local/cargo/bin"]
  .filter(Boolean)
  .join(":");

// Windows CreateProcess does not apply PATHEXT: spawning "bun"/"cargo" fails
// when only bun.exe/cargo.exe exist. Use the running Bun binary and resolve
// cargo to a real path up front.
const BUN = process.execPath;
const CARGO = Bun.which("cargo") ?? "cargo";

interface StageResult {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
  output?: string;
}

function run(name: string, cmd: string[], detail: string, cwd = ROOT): Promise<StageResult> {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(cmd[0], cmd.slice(1), { cwd, env });
    let output = "";
    child.stdout.on("data", (b) => (output += b.toString()));
    child.stderr.on("data", (b) => (output += b.toString()));
    child.on("error", (e) => {
      resolve({
        name,
        ok: false,
        ms: performance.now() - started,
        detail,
        output: `${output}\n${cmd[0]} failed to start: ${e.message}`,
      });
    });
    child.on("close", (code) => {
      resolve({
        name,
        ok: code === 0,
        ms: performance.now() - started,
        detail,
        output: code === 0 ? undefined : output,
      });
    });
  });
}

function tail(output: string | undefined): string {
  if (!output) return "";
  const lines = output.trimEnd().split("\n");
  return lines
    .slice(-TAIL_LINES)
    .map((l) => `    ${l}`)
    .join("\n");
}

function line(r: StageResult): string {
  const status = r.ok ? "[ok]  " : "[fail]";
  return `${status} ${r.name.padEnd(24)} ${(r.ms / 1000).toFixed(1)}s  ${r.detail}`;
}

function print(r: StageResult): void {
  console.log(line(r));
  if (!r.ok) {
    console.log(tail(r.output));
  }
}

function checkScripts(): string[] {
  const dir = join(ROOT, "scripts");
  return readdirSync(dir)
    .filter((f) => f.endsWith("-check.ts"))
    .sort()
    .map((f) => `scripts/${f}`);
}

function hasBunTests(): boolean {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  return typeof pkg.scripts?.test === "string";
}

async function checksStage(): Promise<StageResult> {
  const scripts = checkScripts();
  const started = performance.now();
  let ran = 0;
  for (const script of scripts) {
    ran += 1;
    const r = await run(script, [BUN, script], "", ROOT);
    if (!r.ok) {
      return {
        name: "check scripts",
        ok: false,
        ms: performance.now() - started,
        detail: `${ran}/${scripts.length} passed, ${script} failed`,
        output: r.output,
      };
    }
  }
  return {
    name: "check scripts",
    ok: true,
    ms: performance.now() - started,
    detail: `${scripts.length}/${scripts.length} passed`,
  };
}

async function main(): Promise<void> {
  const started = performance.now();
  const stages: Array<() => Promise<StageResult>> = [
    () => run("build:ui", [BUN, "run", "build:ui"], "tsc -b + vite"),
    () => run("lint", [BUN, "run", "lint"], "oxlint"),
    checksStage,
    () => run("pure rust", [CARGO, "test", "--manifest-path", "src-tauri/pure/Cargo.toml"], "recon-pure"),
  ];
  if (hasBunTests()) {
    stages.push(() => run("bun tests", [BUN, "run", "test"], "bun test"));
  } else {
    console.log("[skip] bun tests                —        no \"test\" script yet");
  }

  for (const stage of stages) {
    const result = await stage();
    print(result);
    if (!result.ok) {
      const total = (performance.now() - started) / 1000;
      console.log(`verify: FAIL after ${total.toFixed(1)}s at stage "${result.name}"`);
      process.exit(1);
    }
  }

  const total = (performance.now() - started) / 1000;
  console.log(`verify: PASS in ${total.toFixed(1)}s`);
}

if (!existsSync(join(ROOT, "package.json"))) {
  console.error(`verify: ${ROOT} does not look like the repo root`);
  process.exit(1);
}

await main();
