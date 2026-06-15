import fs from "node:fs/promises";
import path from "node:path";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, TextChannel, ThreadChannel } from "discord.js";
import { AgentRouter } from "./agents.js";
import { config } from "./config.js";
import { collectRepoContext } from "./context.js";
import { createPullRequest, getGithubToken, parseRepo } from "./github.js";
import { ModelRouter } from "./models.js";
import { assertOk, run } from "./shell.js";
import type { Job } from "./types.js";
import type { Store } from "./store.js";

type Sendable = TextChannel | ThreadChannel;

export class Worker {
  private running = false;
  private queue: string[] = [];
  private agents: AgentRouter;

  constructor(
    private readonly store: Store,
    private readonly models: ModelRouter,
    private readonly getChannel: (id: string) => Promise<Sendable>
  ) {
    this.agents = new AgentRouter(models);
  }

  async enqueue(job: Job): Promise<void> {
    await this.store.createJob(job);
    this.queue.push(job.id);
    void this.drain();
  }

  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const jobId = this.queue.shift();
        if (!jobId) continue;
        const job = this.store.getJob(jobId);
        if (!job) continue;
        await this.prepareDiff(job);
      }
    } finally {
      this.running = false;
    }
  }

  async approve(jobId: string): Promise<Job> {
    const job = this.store.getJob(jobId);
    if (!job || !job.diff || !job.branch) throw new Error("Job is not awaiting approval");
    const repoDir = this.jobDir(job);
    await this.store.updateJob(job.id, { status: "approved" });

    await fs.writeFile(path.join(repoDir, "agent.patch"), job.diff);
    assertOk(await run("git", ["apply", "--whitespace=fix", "agent.patch"], repoDir), "git apply");
    await this.runProjectChecks(repoDir);
    assertOk(await run("git", ["add", "-A"], repoDir), "git add");
    const diffCheck = await run("git", ["diff", "--cached", "--quiet"], repoDir);
    if (diffCheck.code === 0) throw new Error("Patch produced no changes");
    assertOk(await run("git", ["commit", "-m", `Apply AI agent changes (${job.id})`], repoDir), "git commit");
    assertOk(await run("git", ["push", "-u", "origin", job.branch], repoDir, 180_000), "git push");

    const prUrl = await createPullRequest(
      job.repo,
      job.branch,
      `AI agent changes: ${job.prompt.slice(0, 60)}`,
      `Requested from Discord by <@${job.userId}>.\n\nPrompt:\n\n${job.prompt}`
    );
    return this.store.updateJob(job.id, { status: "pushed", prUrl });
  }

  private async prepareDiff(job: Job): Promise<void> {
    const channel = await this.getChannel(job.threadId ?? job.channelId);
    try {
      await this.store.updateJob(job.id, { status: "running" });
      await channel.send(`작업 시작: \`${job.repo}\`를 가져와서 관련 파일을 확인합니다. job=${job.id}`);
      const repoDir = this.jobDir(job);
      await fs.rm(repoDir, { recursive: true, force: true });
      await fs.mkdir(repoDir, { recursive: true });
      await this.cloneRepo(job.repo, repoDir);
      const branch = `ai-agent/${job.id}`;
      assertOk(await run("git", ["checkout", "-b", branch], repoDir), "git checkout");
      const context = await collectRepoContext(repoDir, job.prompt);
      const response = await this.agents.generateDiff({
        agent: job.agent,
        model: job.model,
        repoDir,
        system: diffSystemPrompt(),
        prompt: job.prompt,
        repoContext: context
      });
      const diff = extractDiff(response.text);
      if (!diff) throw new Error("Model did not return a unified diff");
      await this.store.updateJob(job.id, { status: "awaiting_approval", branch, diff });
      await channel.send({
        content: [
          `수정 diff를 만들었습니다. source=${response.source}, job=${job.id}`,
          "적용 후 테스트/커밋/push/PR 생성을 진행하려면 승인하세요.",
          "```diff",
          diff.slice(0, 1800),
          diff.length > 1800 ? "\n...diff truncated..." : "",
          "```"
        ].join("\n"),
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`approve:${job.id}`).setLabel("Apply and PR").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`reject:${job.id}`).setLabel("Reject").setStyle(ButtonStyle.Secondary)
          )
        ]
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.updateJob(job.id, { status: "failed", error: message });
      await channel.send(`작업 실패: ${message}`);
    }
  }

  private async cloneRepo(repoName: string, target: string): Promise<void> {
    const { owner, repo } = parseRepo(repoName);
    const token = await getGithubToken();
    const remote = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
    assertOk(await run("git", ["clone", remote, "."], target, 180_000), "git clone");
    assertOk(await run("git", ["remote", "set-url", "origin", remote], target), "git remote set-url");
  }

  private async runProjectChecks(repoDir: string): Promise<void> {
    const packageJson = path.join(repoDir, "package.json");
    if (await exists(packageJson)) {
      if (await exists(path.join(repoDir, "package-lock.json"))) {
        assertOk(await run("npm", ["ci"], repoDir, 240_000), "npm ci");
      }
      await run("npm", ["run", "lint", "--if-present"], repoDir, 180_000);
      await run("npm", ["run", "typecheck", "--if-present"], repoDir, 180_000);
      await run("npm", ["test", "--if-present"], repoDir, 180_000);
      await run("npm", ["run", "build", "--if-present"], repoDir, 240_000);
    }
  }

  private jobDir(job: Job): string {
    return path.join(config.workspaceRoot, job.id);
  }
}

function diffSystemPrompt(): string {
  return [
    "You are a senior coding agent.",
    "Return only a unified git diff that can be applied with git apply.",
    "Do not include markdown fences, prose, explanations, or commands.",
    "Keep the change minimal and directly related to the user's request.",
    "If no safe code change is possible, return an empty response."
  ].join("\n");
}

function extractDiff(text: string): string {
  const fenced = text.match(/```(?:diff|patch)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  const start = raw.search(/^diff --git |^--- /m);
  return start >= 0 ? raw.slice(start).trim() : "";
}

async function exists(file: string): Promise<boolean> {
  return fs
    .access(file)
    .then(() => true)
    .catch(() => false);
}
