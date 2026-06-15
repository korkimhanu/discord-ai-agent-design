import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { config } from "./config.js";
import { run } from "./shell.js";
import type { ModelRequest, ModelResponse } from "./types.js";

type Provider = "openai" | "anthropic" | "codex-cli" | "claude-code";

const modelProfiles: Record<string, { provider: Provider; model: string }> = {
  auto: { provider: "openai", model: "gpt-5.1" },
  strong: { provider: "openai", model: "gpt-5.1" },
  balanced: { provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
  cheap: { provider: "openai", model: "gpt-5.1-mini" },
  codex: { provider: "codex-cli", model: "codex" },
  "claude-code": { provider: "claude-code", model: "claude-code" },
  "claude-cli": { provider: "claude-code", model: "claude-code" }
};

export class ModelRouter {
  private openai?: OpenAI;
  private anthropic?: Anthropic;

  constructor() {
    if (config.openaiApiKey) this.openai = new OpenAI({ apiKey: config.openaiApiKey });
    if (config.anthropicApiKey) this.anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const resolved = modelProfiles[request.model] ?? inferProvider(request.model);
    if (resolved.provider === "codex-cli") return this.completeCodexCli(request);
    if (resolved.provider === "claude-code") return this.completeClaudeCode(request);
    if (resolved.provider === "anthropic") return this.completeAnthropic(resolved.model, request);
    return this.completeOpenAI(resolved.model, request);
  }

  private async completeOpenAI(model: string, request: ModelRequest): Promise<ModelResponse> {
    if (!this.openai) throw new Error("OPENAI_API_KEY is required for this model");
    const response = await this.openai.responses.create({
      model,
      input: [
        { role: "system", content: request.system },
        { role: "user", content: request.prompt }
      ]
    });
    return { text: response.output_text, provider: "openai", model };
  }

  private async completeAnthropic(model: string, request: ModelRequest): Promise<ModelResponse> {
    if (!this.anthropic) throw new Error("ANTHROPIC_API_KEY is required for this model");
    const response = await this.anthropic.messages.create({
      model,
      max_tokens: 4096,
      system: request.system,
      messages: [{ role: "user", content: request.prompt }]
    });
    const text = response.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
      .trim();
    return { text, provider: "anthropic", model };
  }

  private async completeCodexCli(request: ModelRequest): Promise<ModelResponse> {
    const result = await run(config.codexCommand, ["exec", `${request.system}\n\n${request.prompt}`], process.cwd(), 600_000);
    if (result.code !== 0) throw new Error(`codex cli failed\n${result.stderr || result.stdout}`);
    return { text: result.stdout.trim(), provider: "codex-cli", model: "codex" };
  }

  private async completeClaudeCode(request: ModelRequest): Promise<ModelResponse> {
    const result = await run(config.claudeCodeCommand, ["-p", `${request.system}\n\n${request.prompt}`], process.cwd(), 600_000);
    if (result.code !== 0) throw new Error(`claude-code failed\n${result.stderr || result.stdout}`);
    return { text: result.stdout.trim(), provider: "claude-code", model: "claude-code" };
  }
}

function inferProvider(model: string): { provider: Provider; model: string } {
  if (model === "codex" || model.includes("codex-cli")) return { provider: "codex-cli", model };
  if (model === "claude-code" || model === "claude-cli") return { provider: "claude-code", model };
  if (model.includes("claude")) return { provider: "anthropic", model };
  return { provider: "openai", model };
}
