import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { Job, SessionState } from "./types.js";

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
