import { config } from "./config.js";
import { commandExists } from "./commands.js";
import { ModelRouter } from "./models.js";
import { run } from "./shell.js";

export type AgentRequest = {
  agent: string;
  model: string;
  repoDir: string;
  prompt: string;
  repoContext: string;
  system: string;
};

export type AgentResponse = {
  text: string;
  source: string;
  mode: "diff" | "worktree";
};

export class AgentRouter {
  constructor(private readonly models: ModelRouter) {}

  async generateDiff(request: AgentRequest): Promise<AgentResponse> {
    const agent = request.agent === "auto" ? await this.resolveAutoAgent() : request.agent;
    if (agent === "claude-code") return this.runClaudeCode(request);
    if (agent === "codex") return this.runCodex(request);
    return this.runApi(request);
  }

  private async runApi(request: AgentRequest): Promise<AgentResponse> {
    const response = await this.models.complete({
      model: request.model,
      system: request.system,
      prompt: `USER REQUEST\n${request.prompt}\n\nREPOSITORY CONTEXT\n${request.repoContext}`
    });
    return { text: response.text, source: `${response.provider}:${response.model}`, mode: "diff" };
  }

  private async runClaudeCode(request: AgentRequest): Promise<AgentResponse> {
    const prompt = makeCliPrompt(request);
    const result = await run(config.claudeCodeCommand, ["-p"], request.repoDir, 600_000, { input: prompt });
    if (result.code !== 0) throw new Error(`claude-code failed\n${result.stderr || result.stdout}`);
    return { text: result.stdout, source: "claude-code", mode: "worktree" };
  }

  private async runCodex(request: AgentRequest): Promise<AgentResponse> {
    const prompt = makeCliPrompt(request);
    const result = await run(
      config.codexCommand,
      ["exec", "--sandbox", config.codexSandbox, "-"],
      request.repoDir,
      600_000,
      { input: prompt }
    );
    if (result.code !== 0) throw new Error(`codex failed\n${result.stderr || result.stdout}`);
    return { text: result.stdout, source: "codex", mode: "worktree" };
  }

  private async resolveAutoAgent(): Promise<"codex" | "claude-code" | "api"> {
    if (await commandExists(config.codexCommand)) return "codex";
    if (await commandExists(config.claudeCodeCommand)) return "claude-code";
    return "api";
  }
}

function makeCliPrompt(request: AgentRequest): string {
  return [
    "You are a coding agent working in a temporary git checkout.",
    "Edit files directly to satisfy the user request.",
    "Keep changes minimal and related to the request.",
    "Do not commit, push, install dependencies, or run destructive commands.",
    "When done, briefly summarize what changed.",
    "",
    request.system,
    "",
    "USER REQUEST",
    request.prompt,
    "",
    "REPOSITORY CONTEXT",
    request.repoContext
  ].join("\n");
}
