import { config } from "./config.js";
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
};

export class AgentRouter {
  constructor(private readonly models: ModelRouter) {}

  async generateDiff(request: AgentRequest): Promise<AgentResponse> {
    if (request.agent === "claude-code") return this.runClaudeCode(request);
    if (request.agent === "codex") return this.runCodex(request);
    return this.runApi(request);
  }

  private async runApi(request: AgentRequest): Promise<AgentResponse> {
    const response = await this.models.complete({
      model: request.model,
      system: request.system,
      prompt: `USER REQUEST\n${request.prompt}\n\nREPOSITORY CONTEXT\n${request.repoContext}`
    });
    return { text: response.text, source: `${response.provider}:${response.model}` };
  }

  private async runClaudeCode(request: AgentRequest): Promise<AgentResponse> {
    const prompt = makeCliPrompt(request);
    const result = await run(config.claudeCodeCommand, ["-p"], request.repoDir, 600_000, { input: prompt });
    if (result.code !== 0) throw new Error(`claude-code failed\n${result.stderr || result.stdout}`);
    return { text: result.stdout, source: "claude-code" };
  }

  private async runCodex(request: AgentRequest): Promise<AgentResponse> {
    const prompt = makeCliPrompt(request);
    const result = await run(config.codexCommand, ["exec", "-"], request.repoDir, 600_000, { input: prompt });
    if (result.code !== 0) throw new Error(`codex failed\n${result.stderr || result.stdout}`);
    return { text: result.stdout, source: "codex" };
  }
}

function makeCliPrompt(request: AgentRequest): string {
  return [
    request.system,
    "",
    "Return only a unified git diff. Do not edit files directly.",
    "",
    "USER REQUEST",
    request.prompt,
    "",
    "REPOSITORY CONTEXT",
    request.repoContext
  ].join("\n");
}
