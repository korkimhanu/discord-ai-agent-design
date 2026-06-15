import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { Job, SessionMessage, SessionState } from "./types.js";

type Db = {
  sessions: Record<string, SessionState>;
  jobs: Record<string, Job>;
};

const dbPath = path.join(config.dataDir, "state.json");

export class Store {
  private db: Db = { sessions: {}, jobs: {} };

  async load(): Promise<void> {
    await fs.mkdir(config.dataDir, { recursive: true });
    try {
      this.db = JSON.parse(await fs.readFile(dbPath, "utf8")) as Db;
    } catch {
      await this.save();
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(config.dataDir, { recursive: true });
    await fs.writeFile(dbPath, JSON.stringify(this.db, null, 2));
  }

  getSession(key: string): SessionState {
    const existing = this.db.sessions[key];
    if (existing) return existing;
    const session: SessionState = {
      key,
      model: config.defaultModel,
      agent: config.defaultAgent,
      summary: "",
      messages: [],
      updatedAt: new Date().toISOString()
    };
    this.db.sessions[key] = session;
    return session;
  }

  async updateSession(key: string, patch: Partial<SessionState>): Promise<SessionState> {
    const session = this.getSession(key);
    const next = { ...session, ...patch, updatedAt: new Date().toISOString() };
    this.db.sessions[key] = next;
    await this.save();
    return next;
  }

  async appendMessage(key: string, message: Omit<SessionMessage, "at">): Promise<SessionState> {
    const session = this.getSession(key);
    const messages = [...(session.messages ?? []), { ...message, at: new Date().toISOString() }];
    const compressed = compressMemory(session.summary, messages);
    const next: SessionState = {
      ...session,
      summary: compressed.summary,
      messages: compressed.messages,
      updatedAt: new Date().toISOString()
    };
    this.db.sessions[key] = next;
    await this.save();
    return next;
  }

  buildMemoryContext(key: string): string {
    const session = this.getSession(key);
    const recent = (session.messages ?? [])
      .slice(-12)
      .map((message) => `${message.role}: ${message.text}`)
      .join("\n");
    return [
      "SESSION MEMORY",
      session.summary ? `Summary:\n${session.summary}` : "Summary: none",
      recent ? `Recent messages:\n${recent}` : "Recent messages: none",
      `Current repo: ${session.repo ?? "unset"}`,
      `Current model: ${session.model}`,
      `Current agent: ${session.agent}`
    ].join("\n");
  }

  async createJob(job: Job): Promise<Job> {
    this.db.jobs[job.id] = job;
    await this.save();
    return job;
  }

  getJob(id: string): Job | undefined {
    return this.db.jobs[id];
  }

  async updateJob(id: string, patch: Partial<Job>): Promise<Job> {
    const job = this.db.jobs[id];
    if (!job) throw new Error(`Unknown job: ${id}`);
    const next = { ...job, ...patch, updatedAt: new Date().toISOString() };
    this.db.jobs[id] = next;
    await this.save();
    return next;
  }
}

function compressMemory(summary: string, messages: SessionMessage[]): { summary: string; messages: SessionMessage[] } {
  if (messages.length <= 24) return { summary, messages };
  const older = messages.slice(0, messages.length - 12);
  const recent = messages.slice(-12);
  const newSummary = [
    summary,
    "Compressed older conversation:",
    ...older.slice(-20).map((message) => `- ${message.role}: ${message.text.slice(0, 240)}`)
  ]
    .filter(Boolean)
    .join("\n")
    .slice(-6000);
  return { summary: newSummary, messages: recent };
}
