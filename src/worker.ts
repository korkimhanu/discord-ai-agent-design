import fs from "node:fs/promises";
import path from "node:path";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Message, TextChannel, ThreadChannel } from "discord.js";
import { AgentRouter } from "./agents.js";
import { config } from "./config.js";
import { collectRepoContext } from "./context.js";
import { createPullRequest, getGithubToken, parseRepo, waitForCiSummary } from "./github.js";
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
        if (job.kind === "analysis") {
          await this.prepareAnalysis(job);
        } else {
          await this.prepareDiff(job);
        }
      }
    } finally {
      this.running = false;
    }
  }

  async approve(jobId: string): Promise<Job> {
    const job = this.store.getJob(jobId);
    if (!job || !job.diff || !job.branch) throw new Error("Job is not awaiting approval");
    const channel = await this.getChannel(job.threadId ?? job.channelId);
    const repoDir = this.jobDir(job);
    try {
      await markSafeDirectory(repoDir);
      await this.store.updateJob(job.id, { status: "approved" });
      await this.updateProgress(job, channel, 62, job.applyMode === "worktree" ? "승인됨. worktree 변경 검증 중" : "승인됨. patch 적용 중");

      if (job.applyMode === "worktree") {
        const worktreeDiff = await this.runStep(job, channel, repoDir, 64, "worktree 변경 확인 중", "git diff --quiet", "git", ["diff", "--quiet"]);
        if (worktreeDiff.code === 0) throw new Error("Worktree contains no changes to commit");
      } else {
        await fs.writeFile(path.join(repoDir, "agent.patch"), job.diff);
        assertOk(await this.runStep(job, channel, repoDir, 64, "patch 검증 중", "git apply --check", "git", ["apply", "--check", "--whitespace=fix", "agent.patch"]), "git apply check");
        assertOk(await this.runStep(job, channel, repoDir, 66, "patch 적용 중", "git apply", "git", ["apply", "--whitespace=fix", "agent.patch"]), "git apply");
      }
      await this.updateProgress(job, channel, 70, "로컬 체크 처리 중");
      await this.runProjectChecks(repoDir, channel);
      await this.updateProgress(job, channel, 78, "커밋 생성 중");
      assertOk(await this.runStep(job, channel, repoDir, 80, "변경 파일 stage 중", "git add -A", "git", ["add", "-A"]), "git add");
      const diffCheck = await this.runStep(job, channel, repoDir, 82, "staged 변경 확인 중", "git diff --cached --quiet", "git", ["diff", "--cached", "--quiet"]);
      if (diffCheck.code === 0) throw new Error("Patch produced no changes");
      assertOk(await this.runStep(job, channel, repoDir, 84, "커밋 생성 중", "git commit", "git", ["commit", "-m", `Apply AI agent changes (${job.id})`]), "git commit");
      await this.updateProgress(job, channel, 86, "브랜치 push 중");
      assertOk(await this.runStep(job, channel, repoDir, 86, "브랜치 push 중", `git push origin ${job.branch}`, "git", ["push", "-u", "origin", job.branch], 180_000), "git push");

      await this.updateProgress(job, channel, 92, "PR 생성 중");
      const pr = await createPullRequest(
        job.repo,
        job.branch,
        `AI agent changes: ${job.prompt.slice(0, 60)}`,
        `Requested from Discord by <@${job.userId}>.\n\nPrompt:\n\n${job.prompt}`
      );
      const updated = await this.store.updateJob(job.id, { status: "pushed", prUrl: pr.url });
      await this.store.appendMessage(job.sessionKey, {
        role: "assistant",
        text: `Job ${job.id} was pushed and PR was created: ${pr.url}`
      });
      await this.updateProgress(updated, channel, 96, "PR 생성 완료. CI 확인 대기 중");
      await channel.send(`PR 생성 완료: ${pr.url}\nGitHub Actions 결과를 확인합니다. NAS에서는 LOCAL_CHECKS=${config.localChecks}로 처리했습니다.`);
      void this.reportCi(job, pr.headSha);
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await this.store.updateJob(job.id, { status: "failed", error: message });
      await this.store.appendMessage(job.sessionKey, { role: "assistant", text: `Job ${job.id} failed during approval: ${message}` });
      await this.updateProgress(failed, channel, failed.progressPercent ?? 62, `실패: ${message.slice(0, 80)}`);
      await channel.send(`승인 후 작업 실패: ${message}`);
      throw error;
    }
  }

  private async prepareDiff(job: Job): Promise<void> {
    const channel = await this.getChannel(job.threadId ?? job.channelId);
    let currentJob = job;
    try {
      await this.store.updateJob(job.id, { status: "running" });
      const progress = await channel.send(progressContent(job, 5, "큐에서 작업 시작"));
      currentJob = await this.store.updateJob(job.id, {
        status: "running",
        progressMessageId: progress.id,
        progressLabel: "큐에서 작업 시작",
        progressPercent: 5
      });
      const repoDir = this.jobDir(job);
      await this.updateProgress(currentJob, channel, 12, "workspace 준비 중");
      await fs.rm(repoDir, { recursive: true, force: true });
      await fs.mkdir(repoDir, { recursive: true });
      await this.updateProgress(currentJob, channel, 22, "GitHub repo clone 중");
      await this.trackStep(currentJob, channel, 22, "GitHub repo clone 중", `clone ${job.repo}`, () => this.cloneRepo(job.repo, repoDir));
      const branch = `ai-agent/${job.id}`;
      await this.updateProgress(currentJob, channel, 30, "작업 브랜치 생성 중");
      assertOk(await this.runStep(currentJob, channel, repoDir, 30, "작업 브랜치 생성 중", `git checkout -b ${branch}`, "git", ["checkout", "-b", branch]), "git checkout");
      await this.updateProgress(currentJob, channel, 38, "관련 파일 context 수집 중");
      const context = await this.trackStep(currentJob, channel, 38, "관련 파일 context 수집 중", "파일 트리와 관련 소스 추출", () => collectRepoContext(repoDir, job.prompt));
      await this.updateProgress(currentJob, channel, 48, `${job.agent} agent 실행 중: 코드 수정안 생성`);
      const response = await this.trackStep(currentJob, channel, 48, `${job.agent} agent 실행 중`, "코드 수정안 생성", () =>
        this.agents.generateDiff({
          agent: job.agent,
          model: job.model,
          repoDir,
          system: diffSystemPrompt(),
          prompt: `${job.memoryContext ?? ""}\n\nCURRENT USER REQUEST\n${job.prompt}`,
          repoContext: context
        })
      );
      await this.updateProgress(currentJob, channel, 56, "변경 diff 수집 중");
      const diff = response.mode === "worktree" ? await readWorktreeDiff(repoDir) : extractDiff(response.text);
      if (!diff) {
        const detail = response.text.trim().slice(0, 1200);
        throw new Error(
          response.mode === "worktree"
            ? `Agent finished but did not modify files.${detail ? `\n\nAgent output:\n${detail}` : ""}`
            : `Model did not return a unified diff.${detail ? `\n\nModel output:\n${detail}` : ""}`
        );
      }
      const applyMode = response.mode === "worktree" ? "worktree" : "patch";
      if (applyMode === "patch") {
        await validatePatch(repoDir, diff);
      }
      currentJob = await this.store.updateJob(job.id, { status: "awaiting_approval", branch, diff, applyMode });
      await this.store.appendMessage(job.sessionKey, {
        role: "assistant",
        text: `Prepared a code change for job=${job.id}. Awaiting approval. Summary: ${summarizeDiff(diff)}`
      });
      await this.updateProgress(currentJob, channel, 60, "승인 대기 중");
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
      currentJob = await this.store.updateJob(job.id, { status: "failed", error: message });
      await this.store.appendMessage(job.sessionKey, { role: "assistant", text: `Job ${job.id} failed: ${message}` });
      await this.updateProgress(currentJob, channel, currentJob.progressPercent ?? 0, `실패: ${message.slice(0, 80)}`);
      await channel.send(`작업 실패: ${message}`);
    }
  }

  private async prepareAnalysis(job: Job): Promise<void> {
    const channel = await this.getChannel(job.threadId ?? job.channelId);
    let currentJob = job;
    try {
      const progress = await channel.send(progressContent(job, 5, "repo 분석 작업 시작"));
      currentJob = await this.store.updateJob(job.id, {
        status: "running",
        progressMessageId: progress.id,
        progressLabel: "repo 분석 작업 시작",
        progressPercent: 5
      });
      const repoDir = this.jobDir(job);
      await this.updateProgress(currentJob, channel, 15, "workspace 준비 중");
      await fs.rm(repoDir, { recursive: true, force: true });
      await fs.mkdir(repoDir, { recursive: true });
      await this.updateProgress(currentJob, channel, 30, "GitHub repo clone 중");
      await this.trackStep(currentJob, channel, 30, "GitHub repo clone 중", `clone ${job.repo}`, () => this.cloneRepo(job.repo, repoDir));
      await this.updateProgress(currentJob, channel, 55, "관련 파일 context 수집 중");
      const context = await this.trackStep(currentJob, channel, 55, "관련 파일 context 수집 중", "파일 트리와 관련 소스 추출", () => collectRepoContext(repoDir, job.prompt));
      await this.updateProgress(currentJob, channel, 75, `${job.model} 모델로 분석 중`);
      const response = await this.trackStep(currentJob, channel, 75, `${job.model} 모델로 분석 중`, "repo 분석 답변 생성", () =>
        this.models.complete({
          model: job.model,
          system: "You are a senior software engineer. Answer in Korean. Analyze the repository from the provided file list and snippets. Do not propose file edits unless asked.",
          prompt: `${job.memoryContext ?? ""}\n\nUSER REQUEST\n${job.prompt}\n\nREPOSITORY CONTEXT\n${context}`
        })
      );
      currentJob = await this.store.updateJob(job.id, { status: "completed" });
      await this.store.appendMessage(job.sessionKey, { role: "assistant", text: response.text.slice(0, 4000) });
      await this.updateProgress(currentJob, channel, 100, "분석 완료");
      await channel.send(response.text.slice(0, 1900));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      currentJob = await this.store.updateJob(job.id, { status: "failed", error: message });
      await this.store.appendMessage(job.sessionKey, { role: "assistant", text: `Analysis job ${job.id} failed: ${message}` });
      await this.updateProgress(currentJob, channel, currentJob.progressPercent ?? 0, `실패: ${message.slice(0, 80)}`);
      await channel.send(`분석 실패: ${message}`);
    }
  }

  private async cloneRepo(repoName: string, target: string): Promise<void> {
    const { owner, repo } = parseRepo(repoName);
    const token = await getGithubToken();
    const remote = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
    assertOk(await run("git", ["clone", remote, "."], target, 180_000), "git clone");
    await markSafeDirectory(target);
    assertOk(await run("git", ["remote", "set-url", "origin", remote], target), "git remote set-url");
  }

  private async runProjectChecks(repoDir: string, channel: Sendable): Promise<void> {
    if (config.localChecks === "none") {
      await channel.send("로컬 체크 생략: NAS 부하를 피하기 위해 빌드/테스트는 GitHub Actions에 맡깁니다.");
      return;
    }
    const packageJson = path.join(repoDir, "package.json");
    if (await exists(packageJson)) {
      if (await exists(path.join(repoDir, "package-lock.json"))) {
        assertOk(await run("npm", ["ci"], repoDir, 240_000), "npm ci");
      }
      await run("npm", ["run", "lint", "--if-present"], repoDir, 180_000);
      await run("npm", ["run", "typecheck", "--if-present"], repoDir, 180_000);
      if (config.localChecks === "full") {
        await run("npm", ["test", "--if-present"], repoDir, 180_000);
        await run("npm", ["run", "build", "--if-present"], repoDir, 240_000);
      }
    }
  }

  private jobDir(job: Job): string {
    return path.join(config.workspaceRoot, job.id);
  }

  private async reportCi(job: Job, headSha: string): Promise<void> {
    const channel = await this.getChannel(job.threadId ?? job.channelId);
    try {
      const summary = await waitForCiSummary(job.repo, headSha, config.ciPollSeconds);
      const latest = this.store.getJob(job.id) ?? job;
      await this.updateProgress(latest, channel, summary.state === "success" ? 100 : 98, `CI 상태: ${summary.state}`);
      const checks = summary.checks.length ? summary.checks.slice(0, 10).join("\n") : "아직 check run이 없습니다.";
      const artifacts = summary.artifacts.length
        ? summary.artifacts
            .slice(0, 8)
            .map((artifact) => `- ${artifact.name}: ${artifact.url}`)
            .join("\n")
        : "artifact 없음";
      await channel.send(
        [
          `CI 상태: ${summary.state}`,
          `Checks: ${summary.checksUrl}`,
          "```text",
          checks,
          "```",
          "Artifacts/APK/screenshots:",
          artifacts
        ].join("\n")
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await channel.send(`CI 상태 확인 실패: ${message}`);
    }
  }

  private async updateProgress(job: Job, channel: Sendable, percent: number, label: string): Promise<Job> {
    const updated = await this.store.updateJob(job.id, {
      progressPercent: percent,
      progressLabel: label
    });
    if (!updated.progressMessageId) return updated;
    const message = await fetchMessage(channel, updated.progressMessageId);
    if (message) {
      await message.edit(progressContent(updated, percent, label)).catch(() => undefined);
    }
    return updated;
  }

  private async runStep(
    job: Job,
    channel: Sendable,
    cwd: string,
    percent: number,
    label: string,
    detail: string,
    command: string,
    args: string[],
    timeoutMs = 120_000
  ) {
    const started = Date.now();
    await this.updateProgress(job, channel, percent, `${label}\n현재 실행: ${detail}\n경과: 0초`);
    const heartbeat = setInterval(() => {
      const seconds = Math.floor((Date.now() - started) / 1000);
      void this.updateProgress(job, channel, percent, `${label}\n현재 실행: ${detail}\n경과: ${seconds}초`).catch(() => undefined);
    }, 10_000);
    try {
      return await run(command, args, cwd, timeoutMs);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async trackStep<T>(
    job: Job,
    channel: Sendable,
    percent: number,
    label: string,
    detail: string,
    action: () => Promise<T>
  ): Promise<T> {
    const started = Date.now();
    await this.updateProgress(job, channel, percent, `${label}\n현재 작업: ${detail}\n경과: 0초`);
    const heartbeat = setInterval(() => {
      const seconds = Math.floor((Date.now() - started) / 1000);
      void this.updateProgress(job, channel, percent, `${label}\n현재 작업: ${detail}\n경과: ${seconds}초`).catch(() => undefined);
    }, 10_000);
    try {
      return await action();
    } finally {
      clearInterval(heartbeat);
    }
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

async function readWorktreeDiff(repoDir: string): Promise<string> {
  const result = await run("git", ["diff", "--no-ext-diff", "--binary"], repoDir);
  return result.code === 0 ? result.stdout.trim() : "";
}

async function resetWorktree(repoDir: string): Promise<void> {
  await run("git", ["checkout", "--", "."], repoDir);
  await run("git", ["clean", "-fd"], repoDir);
}

async function markSafeDirectory(repoDir: string): Promise<void> {
  const normalized = path.resolve(repoDir).replaceAll("\\", "/");
  await run("git", ["config", "--global", "--add", "safe.directory", normalized], repoDir);
}

async function validatePatch(repoDir: string, diff: string): Promise<void> {
  const patchFile = path.join(repoDir, ".agent-check.patch");
  await fs.writeFile(patchFile, diff.endsWith("\n") ? diff : `${diff}\n`);
  const result = await run("git", ["apply", "--check", "--whitespace=fix", ".agent-check.patch"], repoDir);
  await fs.rm(patchFile, { force: true });
  if (result.code !== 0) {
    throw new Error(`Agent produced an invalid patch. Ask again with a smaller task.\n${result.stderr || result.stdout}`);
  }
}

async function exists(file: string): Promise<boolean> {
  return fs
    .access(file)
    .then(() => true)
    .catch(() => false);
}

function progressContent(job: Job, percent: number, label: string): string {
  const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round(safePercent / 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  return [
    `작업 진행 중 job=${job.id}`,
    `repo: \`${job.repo}\``,
    `status: \`${job.status}\``,
    `progress: [${bar}] ${safePercent}%`,
    `step: ${label}`
  ].join("\n");
}

async function fetchMessage(channel: Sendable, messageId: string): Promise<Message | undefined> {
  return channel.messages.fetch(messageId).catch(() => undefined);
}

function summarizeDiff(diff: string): string {
  const files = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => match[2]);
  const additions = diff.match(/^\+/gm)?.length ?? 0;
  const deletions = diff.match(/^-/gm)?.length ?? 0;
  return `files=${files.slice(0, 8).join(", ") || "unknown"}, +${additions}, -${deletions}`;
}
