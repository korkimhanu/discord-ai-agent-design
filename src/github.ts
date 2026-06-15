import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { config } from "./config.js";

export type RepoParts = {
  owner: string;
  repo: string;
};

export function parseRepo(input: string): RepoParts {
  const cleaned = input.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  const [owner, repo] = cleaned.split("/");
  if (!owner || !repo) throw new Error("Repo must look like owner/name");
  return { owner, repo };
}

export async function getGithubToken(): Promise<string> {
  if (config.githubToken) return config.githubToken;
  if (!config.githubAppId || !config.githubInstallationId || !config.githubPrivateKeyBase64) {
    throw new Error("Set GITHUB_TOKEN or GitHub App env vars");
  }
  const auth = createAppAuth({
    appId: config.githubAppId,
    privateKey: Buffer.from(config.githubPrivateKeyBase64, "base64").toString("utf8"),
    installationId: config.githubInstallationId
  });
  const installation = await auth({ type: "installation" });
  return installation.token;
}

export async function createOctokit(): Promise<Octokit> {
  return new Octokit({ auth: await getGithubToken() });
}

export type PullRequestResult = {
  url: string;
  number: number;
  headSha: string;
};

export type CiSummary = {
  state: "pending" | "success" | "failure" | "error";
  checksUrl: string;
  checks: string[];
  artifacts: { name: string; url: string }[];
};

export async function createPullRequest(
  repoName: string,
  branch: string,
  title: string,
  body: string
): Promise<PullRequestResult> {
  const { owner, repo } = parseRepo(repoName);
  const octokit = await createOctokit();
  const defaultBranch = await octokit.repos.get({ owner, repo }).then((res) => res.data.default_branch);
  const pr = await octokit.pulls.create({
    owner,
    repo,
    head: branch,
    base: defaultBranch,
    title,
    body
  });
  return {
    url: pr.data.html_url,
    number: pr.data.number,
    headSha: pr.data.head.sha
  };
}

export async function waitForCiSummary(
  repoName: string,
  headSha: string,
  timeoutSeconds: number
): Promise<CiSummary> {
  const started = Date.now();
  const timeoutMs = timeoutSeconds * 1000;
  let latest: CiSummary | undefined;
  while (Date.now() - started < timeoutMs) {
    latest = await getCiSummary(repoName, headSha);
    if (latest.state !== "pending") return latest;
    await sleep(10_000);
  }
  return latest ?? getCiSummary(repoName, headSha);
}

async function getCiSummary(repoName: string, headSha: string): Promise<CiSummary> {
  const { owner, repo } = parseRepo(repoName);
  const octokit = await createOctokit();
  const checks = await octokit.checks.listForRef({ owner, repo, ref: headSha, per_page: 50 });
  const runs = await octokit.actions.listWorkflowRunsForRepo({ owner, repo, head_sha: headSha, per_page: 20 });

  const checkItems = checks.data.check_runs.map((check) => `${check.name}: ${check.status}/${check.conclusion ?? "pending"}`);
  const runItems = runs.data.workflow_runs.map((run) => `${run.name ?? "workflow"}: ${run.status}/${run.conclusion ?? "pending"}`);
  const allItems = [...checkItems, ...runItems];
  const pending =
    checks.data.check_runs.some((check) => check.status !== "completed") ||
    runs.data.workflow_runs.some((run) => run.status !== "completed");
  const failed =
    checks.data.check_runs.some((check) => check.conclusion && !["success", "skipped", "neutral"].includes(check.conclusion)) ||
    runs.data.workflow_runs.some((run) => run.conclusion && !["success", "skipped", "neutral"].includes(run.conclusion));
  const artifacts = await collectArtifacts(octokit, owner, repo, runs.data.workflow_runs.map((run) => run.id));

  return {
    state: pending ? "pending" : failed ? "failure" : allItems.length === 0 ? "pending" : "success",
    checksUrl: `https://github.com/${owner}/${repo}/commit/${headSha}/checks`,
    checks: allItems,
    artifacts
  };
}

async function collectArtifacts(
  octokit: Awaited<ReturnType<typeof createOctokit>>,
  owner: string,
  repo: string,
  runIds: number[]
): Promise<{ name: string; url: string }[]> {
  const artifacts: { name: string; url: string }[] = [];
  for (const run_id of runIds.slice(0, 5)) {
    const response = await octokit.actions.listWorkflowRunArtifacts({ owner, repo, run_id, per_page: 20 });
    for (const artifact of response.data.artifacts) {
      artifacts.push({ name: artifact.name, url: artifact.archive_download_url });
    }
  }
  return artifacts;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
