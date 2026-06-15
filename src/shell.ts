import { spawn } from "node:child_process";

export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type RunOptions = {
  input?: string;
};

export function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 120_000,
  options: RunOptions = {}
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const shell = process.platform === "win32";
    const child = spawn(shell ? commandLine(command, args) : command, shell ? [] : args, {
      cwd,
      shell,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
        GCM_MODAL_PROMPT: "false"
      }
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command timed out: ${command} ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    if (options.input) {
      child.stdin.end(options.input);
    }
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export function assertOk(result: RunResult, label: string): void {
  if (result.code !== 0) {
    throw new Error(`${label} failed\n${result.stderr || result.stdout}`);
  }
}

function commandLine(command: string, args: string[]): string {
  return [command, ...args].map(quoteForCmd).join(" ");
}

function quoteForCmd(value: string): string {
  if (!/[ \t\n\r"&|<>^]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}
