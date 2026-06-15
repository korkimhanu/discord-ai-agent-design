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

export async function createPullRequest(repoName: string, branch: string, title: string, body: string): Promise<string> {
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
  return pr.data.html_url;
}
