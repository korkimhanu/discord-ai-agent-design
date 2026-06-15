import "dotenv/config";
import path from "node:path";

export const config = {
  discordToken: required("DISCORD_TOKEN"),
  discordClientId: required("DISCORD_CLIENT_ID"),
  discordGuildId: process.env.DISCORD_GUILD_ID,
  autoReplyChannels: csv(process.env.DISCORD_AUTOREPLY_CHANNELS),
  githubToken: process.env.GITHUB_TOKEN,
  githubAppId: process.env.GITHUB_APP_ID,
  githubInstallationId: process.env.GITHUB_INSTALLATION_ID,
  githubPrivateKeyBase64: process.env.GITHUB_PRIVATE_KEY_BASE64,
  openaiApiKey: process.env.OPENAI_API_KEY,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  defaultModel: process.env.DEFAULT_MODEL ?? "auto",
  defaultAgent: process.env.DEFAULT_AGENT ?? "api",
  claudeCodeCommand: process.env.CLAUDE_CODE_COMMAND ?? "claude",
  codexCommand: process.env.CODEX_COMMAND ?? "codex",
  localChecks: process.env.LOCAL_CHECKS ?? "none",
  ciPollSeconds: Number(process.env.CI_POLL_SECONDS ?? "180"),
  workspaceRoot: path.resolve(process.env.WORKSPACE_ROOT ?? "./workspaces"),
  dataDir: path.resolve(process.env.DATA_DIR ?? "./.data"),
  publicBaseUrl: process.env.PUBLIC_BASE_URL
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function csv(value?: string): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}
