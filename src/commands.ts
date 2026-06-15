import { run } from "./shell.js";

export async function commandExists(command: string): Promise<boolean> {
  const checker = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  const result = await run(checker, args, process.cwd(), 10_000).catch(() => ({ code: 1 }));
  return result.code === 0;
}
