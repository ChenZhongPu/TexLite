import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../schema/postgres.js";

export type CompileRunStatus = "queued" | "running" | "succeeded" | "failed";

export interface LatestCompileRunRecord {
  id: string;
  status: string;
  log: string;
  created_at: string;
  finished_at: string | null;
  requested_by: string | null;
  requested_by_username: string | null;
  requested_by_name: string | null;
}

export interface CompileRunRecord {
  id: string;
  project_id: string;
  requested_by: string | null;
  main_file: string;
  status: string;
  log: string;
  created_at: string;
  finished_at: string | null;
}

export interface CompileRunStatusRecord {
  id: string;
  status: string;
  log?: string;
  finished_at?: string | null;
}

export interface ActiveCompileRunRecord {
  id: string;
  main_file: string;
  status: "queued" | "running";
  requested_by: string | null;
  created_at: string;
  requested_by_username: string | null;
  requested_by_name: string | null;
}

/** Typed PostgreSQL access for compile queue and durable run state. */
export class PostgresCompileRunRepository {
  private readonly requester = alias(schema.users, "compile_requester");

  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async latest(projectId: string, mainFile: string): Promise<LatestCompileRunRecord | null> {
    const [row] = await this.db.select({
      id: schema.compileRuns.id,
      status: schema.compileRuns.status,
      log: schema.compileRuns.log,
      created_at: schema.compileRuns.createdAt,
      finished_at: schema.compileRuns.finishedAt,
      requested_by: schema.compileRuns.requestedBy,
      requested_by_username: this.requester.username,
      requested_by_name: this.requester.displayName
    })
      .from(schema.compileRuns)
      .leftJoin(this.requester, eq(this.requester.id, schema.compileRuns.requestedBy))
      .where(and(
        eq(schema.compileRuns.projectId, projectId),
        eq(schema.compileRuns.mainFile, mainFile)
      ))
      .orderBy(sql`CASE ${schema.compileRuns.status} WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END`, desc(schema.compileRuns.createdAt))
      .limit(1);
    return row ?? null;
  }

  async latestSucceeded(projectId: string, mainFile: string): Promise<{ id: string; finished_at: string | null } | null> {
    const [row] = await this.db.select({
      id: schema.compileRuns.id,
      finished_at: schema.compileRuns.finishedAt
    })
      .from(schema.compileRuns)
      .where(and(
        eq(schema.compileRuns.projectId, projectId),
        eq(schema.compileRuns.mainFile, mainFile),
        eq(schema.compileRuns.status, "succeeded")
      ))
      .orderBy(desc(schema.compileRuns.createdAt))
      .limit(1);
    return row ?? null;
  }

  async findSucceeded(runId: string, projectId: string): Promise<{ id: string; status: string; log: string; finished_at: string | null } | null> {
    const [row] = await this.db.select({
      id: schema.compileRuns.id,
      status: schema.compileRuns.status,
      log: schema.compileRuns.log,
      finished_at: schema.compileRuns.finishedAt
    })
      .from(schema.compileRuns)
      .where(and(
        eq(schema.compileRuns.id, runId),
        eq(schema.compileRuns.projectId, projectId),
        eq(schema.compileRuns.status, "succeeded")
      ))
      .limit(1);
    return row ?? null;
  }

  async hasActive(projectId: string, mainFile: string, excludeRunId?: string): Promise<boolean> {
    const [row] = await this.db.select({ id: schema.compileRuns.id })
      .from(schema.compileRuns)
      .where(and(
        eq(schema.compileRuns.projectId, projectId),
        eq(schema.compileRuns.mainFile, mainFile),
        inArray(schema.compileRuns.status, ["queued", "running"]),
        excludeRunId ? sql`${schema.compileRuns.id} <> ${excludeRunId}` : undefined
      ))
      .limit(1);
    return Boolean(row);
  }

  async activeRuns(projectId: string): Promise<ActiveCompileRunRecord[]> {
    const rows = await this.db.select({
      id: schema.compileRuns.id,
      main_file: schema.compileRuns.mainFile,
      status: schema.compileRuns.status,
      requested_by: schema.compileRuns.requestedBy,
      created_at: schema.compileRuns.createdAt,
      requested_by_username: this.requester.username,
      requested_by_name: this.requester.displayName
    })
      .from(schema.compileRuns)
      .leftJoin(this.requester, eq(this.requester.id, schema.compileRuns.requestedBy))
      .where(and(
        eq(schema.compileRuns.projectId, projectId),
        inArray(schema.compileRuns.status, ["queued", "running"])
      ))
      .orderBy(sql`CASE ${schema.compileRuns.status} WHEN 'running' THEN 0 ELSE 1 END`, desc(schema.compileRuns.createdAt));
    return rows.map((row) => ({ ...row, status: row.status === "running" ? "running" : "queued" }));
  }

  async finishedRunIds(projectId: string, mainFile: string): Promise<string[]> {
    const rows = await this.db.select({ id: schema.compileRuns.id })
      .from(schema.compileRuns)
      .where(and(
        eq(schema.compileRuns.projectId, projectId),
        eq(schema.compileRuns.mainFile, mainFile),
        notInArray(schema.compileRuns.status, ["queued", "running"])
      ));
    return rows.map((row) => row.id);
  }

  async deleteFinished(projectId: string, mainFile: string): Promise<number> {
    const rows = await this.db.delete(schema.compileRuns)
      .where(and(
        eq(schema.compileRuns.projectId, projectId),
        eq(schema.compileRuns.mainFile, mainFile),
        notInArray(schema.compileRuns.status, ["queued", "running"])
      ))
      .returning({ id: schema.compileRuns.id });
    return rows.length;
  }

  async createQueued(input: { id: string; projectId: string; requestedBy: string; mainFile: string; createdAt: string }): Promise<void> {
    await this.db.insert(schema.compileRuns).values({
      id: input.id,
      projectId: input.projectId,
      requestedBy: input.requestedBy,
      mainFile: input.mainFile,
      status: "queued",
      createdAt: input.createdAt
    });
  }

  async deleteQueued(runId: string): Promise<boolean> {
    const rows = await this.db.delete(schema.compileRuns)
      .where(and(eq(schema.compileRuns.id, runId), eq(schema.compileRuns.status, "queued")))
      .returning({ id: schema.compileRuns.id });
    return rows.length > 0;
  }

  async markCancelled(runId: string, log: string, finishedAt: string): Promise<boolean> {
    const rows = await this.db.update(schema.compileRuns).set({
      status: "failed",
      log,
      finishedAt
    }).where(and(
      eq(schema.compileRuns.id, runId),
      inArray(schema.compileRuns.status, ["queued", "running"])
    )).returning({ id: schema.compileRuns.id });
    return rows.length > 0;
  }

  async markRunning(runId: string): Promise<boolean> {
    const rows = await this.db.update(schema.compileRuns).set({ status: "running" })
      .where(eq(schema.compileRuns.id, runId))
      .returning({ id: schema.compileRuns.id });
    return rows.length > 0;
  }

  async finish(runId: string, status: "succeeded" | "failed", log: string, finishedAt: string): Promise<boolean> {
    const rows = await this.db.update(schema.compileRuns).set({ status, log, finishedAt })
      .where(eq(schema.compileRuns.id, runId))
      .returning({ id: schema.compileRuns.id });
    return rows.length > 0;
  }

  async status(runId: string, projectId?: string): Promise<{ status: string } | null> {
    const [row] = await this.db.select({ status: schema.compileRuns.status })
      .from(schema.compileRuns)
      .where(and(
        eq(schema.compileRuns.id, runId),
        projectId ? eq(schema.compileRuns.projectId, projectId) : undefined
      ))
      .limit(1);
    return row ?? null;
  }

  async findRun(runId: string, projectId?: string): Promise<CompileRunRecord | null> {
    const [row] = await this.db.select({
      id: schema.compileRuns.id,
      project_id: schema.compileRuns.projectId,
      requested_by: schema.compileRuns.requestedBy,
      main_file: schema.compileRuns.mainFile,
      status: schema.compileRuns.status,
      log: schema.compileRuns.log,
      created_at: schema.compileRuns.createdAt,
      finished_at: schema.compileRuns.finishedAt
    })
      .from(schema.compileRuns)
      .where(and(
        eq(schema.compileRuns.id, runId),
        projectId ? eq(schema.compileRuns.projectId, projectId) : undefined
      ))
      .limit(1);
    return row ?? null;
  }

  async latestExcept(runId: string, projectId: string, mainFile: string): Promise<{ id: string; status: string } | null> {
    const [row] = await this.db.select({
      id: schema.compileRuns.id,
      status: schema.compileRuns.status
    })
      .from(schema.compileRuns)
      .where(and(
        eq(schema.compileRuns.projectId, projectId),
        eq(schema.compileRuns.mainFile, mainFile),
        sql`${schema.compileRuns.id} <> ${runId}`
      ))
      .orderBy(desc(schema.compileRuns.createdAt))
      .limit(1);
    return row ?? null;
  }

  async latestCreated(projectId: string, mainFile: string): Promise<{ id: string; status: string } | null> {
    const [row] = await this.db.select({
      id: schema.compileRuns.id,
      status: schema.compileRuns.status
    })
      .from(schema.compileRuns)
      .where(and(
        eq(schema.compileRuns.projectId, projectId),
        eq(schema.compileRuns.mainFile, mainFile)
      ))
      .orderBy(desc(schema.compileRuns.createdAt))
      .limit(1);
    return row ?? null;
  }

  async projectExists(projectId: string): Promise<boolean> {
    const [row] = await this.db.select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .limit(1);
    return Boolean(row);
  }

  async finishedAt(runId: string): Promise<string | null> {
    const [row] = await this.db.select({ finishedAt: schema.compileRuns.finishedAt })
      .from(schema.compileRuns)
      .where(eq(schema.compileRuns.id, runId))
      .limit(1);
    return row?.finishedAt ?? null;
  }

  async failActiveRuns(finishedAt: string, message: string): Promise<number> {
    const rows = await this.db.update(schema.compileRuns).set({
      status: "failed",
      log: sql`CASE WHEN ${schema.compileRuns.log} = '' THEN ${message} ELSE ${schema.compileRuns.log} END`,
      finishedAt
    }).where(inArray(schema.compileRuns.status, ["queued", "running"]))
      .returning({ id: schema.compileRuns.id });
    return rows.length;
  }

  async completedForPrune(projectId: string): Promise<Array<{ id: string; main_file: string }>> {
    return await this.db.select({
      id: schema.compileRuns.id,
      main_file: schema.compileRuns.mainFile
    })
      .from(schema.compileRuns)
      .where(and(
        eq(schema.compileRuns.projectId, projectId),
        notInArray(schema.compileRuns.status, ["queued", "running"])
      ))
      .orderBy(desc(schema.compileRuns.createdAt), desc(schema.compileRuns.id));
  }

  async deleteRun(runId: string): Promise<void> {
    await this.db.delete(schema.compileRuns).where(eq(schema.compileRuns.id, runId));
  }

  async recoverPublishedRun(input: {
    runId: string;
    projectId: string;
    mainFile: string;
    message: string;
    finishedAt: string;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx.select({
        status: schema.compileRuns.status,
        log: schema.compileRuns.log
      }).from(schema.compileRuns).where(and(
        eq(schema.compileRuns.id, input.runId),
        eq(schema.compileRuns.projectId, input.projectId)
      )).limit(1);
      if (!existing) {
        await tx.insert(schema.compileRuns).values({
          id: input.runId,
          projectId: input.projectId,
          requestedBy: null,
          mainFile: input.mainFile,
          status: "succeeded",
          log: input.message,
          createdAt: input.finishedAt,
          finishedAt: input.finishedAt
        });
      } else if (existing.status !== "succeeded") {
        await tx.update(schema.compileRuns).set({
          status: "succeeded",
          log: existing.log === "" ? input.message : existing.log,
          finishedAt: input.finishedAt
        }).where(eq(schema.compileRuns.id, input.runId));
      }
    });
  }
}
