import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, inArray, lt, or, type ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import * as schema from "../schema/postgres.js";

type HistoryTransaction = NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;

export type HistoryReasonValue = "initial" | "autosave" | "file" | "settings" | "restore" | "checkpoint";

export interface HistoryStorageRow {
  id: string;
  project_id: string;
  author_id: string | null;
  reason: HistoryReasonValue;
  label: string | null;
  manifest_json: string;
  changed_paths_json: string;
  created_at: string;
  rowid: number;
}

export interface HistoryListRow extends HistoryStorageRow {
  author_username: string | null;
  author_name: string | null;
}

export interface HistoryPageRow extends HistoryListRow {
  history_rowid: number;
}

interface HistoryVersionWrite {
  id: string;
  projectId: string;
  authorId: string | null;
  reason: HistoryReasonValue;
  manifestJson: string;
  changedPathsJson: string;
  createdAt: string;
}

/** Typed access to immutable project snapshots and their baseline. */
export class PostgresHistoryRepository {
  private readonly author = alias(schema.users, "history_author");
  private readonly older = alias(schema.projectHistoryVersions, "history_older");
  private readonly selected = alias(schema.projectHistoryVersions, "history_selected");

  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async latest(projectId: string): Promise<HistoryStorageRow | null> {
    const [row] = await this.db.select({
      id: schema.projectHistoryVersions.id,
      project_id: schema.projectHistoryVersions.projectId,
      author_id: schema.projectHistoryVersions.authorId,
      reason: schema.projectHistoryVersions.reason,
      label: schema.projectHistoryVersions.label,
      manifest_json: schema.projectHistoryVersions.manifestJson,
      changed_paths_json: schema.projectHistoryVersions.changedPathsJson,
      created_at: schema.projectHistoryVersions.createdAt,
      rowid: schema.projectHistoryVersions.rowid
    })
      .from(schema.projectHistoryVersions)
      .where(eq(schema.projectHistoryVersions.projectId, projectId))
      .orderBy(desc(schema.projectHistoryVersions.createdAt), desc(schema.projectHistoryVersions.rowid))
      .limit(1);
    return row ? toStorageRow(row) : null;
  }

  async all(projectId: string): Promise<HistoryStorageRow[]> {
    const rows = await this.db.select({
      id: schema.projectHistoryVersions.id,
      project_id: schema.projectHistoryVersions.projectId,
      author_id: schema.projectHistoryVersions.authorId,
      reason: schema.projectHistoryVersions.reason,
      label: schema.projectHistoryVersions.label,
      manifest_json: schema.projectHistoryVersions.manifestJson,
      changed_paths_json: schema.projectHistoryVersions.changedPathsJson,
      created_at: schema.projectHistoryVersions.createdAt,
      rowid: schema.projectHistoryVersions.rowid
    })
      .from(schema.projectHistoryVersions)
      .where(eq(schema.projectHistoryVersions.projectId, projectId))
      .orderBy(desc(schema.projectHistoryVersions.createdAt), desc(schema.projectHistoryVersions.rowid));
    return rows.map(toStorageRow);
  }

  async baseline(projectId: string): Promise<string | null> {
    const [row] = await this.db.select({ manifestJson: schema.projectHistoryState.manifestJson })
      .from(schema.projectHistoryState)
      .where(eq(schema.projectHistoryState.projectId, projectId))
      .limit(1);
    return row?.manifestJson ?? null;
  }

  async saveBaseline(projectId: string, manifestJson: string, updatedAt: string): Promise<void> {
    await upsertBaseline(this.db, { projectId, manifestJson, updatedAt });
  }

  async insertVersionAndBaseline(input: HistoryVersionWrite, baselineJson: string, baselineUpdatedAt: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await insertVersion(tx, input);
      await upsertBaseline(tx, { projectId: input.projectId, manifestJson: baselineJson, updatedAt: baselineUpdatedAt });
    });
  }

  async coalesceVersionAndBaseline(input: {
    versionId: string;
    projectId: string;
    manifestJson: string;
    changedPathsJson: string;
    authorId: string | null;
    baselineJson: string;
    baselineUpdatedAt: string;
  }): Promise<boolean> {
    return await this.db.transaction(async (tx) => {
      const rows = await tx.update(schema.projectHistoryVersions).set({
        manifestJson: input.manifestJson,
        changedPathsJson: input.changedPathsJson,
        authorId: input.authorId
      }).where(and(
        eq(schema.projectHistoryVersions.id, input.versionId),
        eq(schema.projectHistoryVersions.projectId, input.projectId)
      )).returning({ id: schema.projectHistoryVersions.id });
      if (!rows.length) return false;
      await upsertBaseline(tx, {
        projectId: input.projectId,
        manifestJson: input.baselineJson,
        updatedAt: input.baselineUpdatedAt
      });
      return true;
    });
  }

  async list(projectId: string, limit: number): Promise<HistoryListRow[]> {
    const rows = await this.selectWithAuthor()
      .where(eq(schema.projectHistoryVersions.projectId, projectId))
      .orderBy(desc(schema.projectHistoryVersions.createdAt), desc(schema.projectHistoryVersions.rowid))
      .limit(limit);
    return rows.map(toListRow);
  }

  async listPage(projectId: string, limit: number, cursor: { createdAt: string; rowId: number } | null): Promise<HistoryPageRow[]> {
    const rows = await this.selectWithAuthor()
      .where(and(
        eq(schema.projectHistoryVersions.projectId, projectId),
        cursor ? or(
          lt(schema.projectHistoryVersions.createdAt, cursor.createdAt),
          and(
            eq(schema.projectHistoryVersions.createdAt, cursor.createdAt),
            lt(schema.projectHistoryVersions.rowid, cursor.rowId)
          )
        ) : undefined
      ))
      .orderBy(desc(schema.projectHistoryVersions.createdAt), desc(schema.projectHistoryVersions.rowid))
      .limit(limit);
    return rows.map(toPageRow);
  }

  async find(id: string, projectId?: string): Promise<HistoryListRow | null> {
    const [row] = await this.selectWithAuthor()
      .where(and(
        eq(schema.projectHistoryVersions.id, id),
        projectId ? eq(schema.projectHistoryVersions.projectId, projectId) : undefined
      ))
      .limit(1);
    return row ? toListRow(row) : null;
  }

  async manifest(projectId: string, versionId: string): Promise<string | null> {
    const [row] = await this.db.select({ manifestJson: schema.projectHistoryVersions.manifestJson })
      .from(schema.projectHistoryVersions)
      .where(and(
        eq(schema.projectHistoryVersions.id, versionId),
        eq(schema.projectHistoryVersions.projectId, projectId)
      ))
      .limit(1);
    return row?.manifestJson ?? null;
  }

  async previousId(projectId: string, versionId: string): Promise<string | null> {
    const [row] = await this.db.select({ id: this.older.id })
      .from(this.older)
      .innerJoin(this.selected, and(
        eq(this.selected.id, versionId),
        eq(this.selected.projectId, this.older.projectId)
      ))
      .where(and(
        eq(this.older.projectId, projectId),
        or(
          lt(this.older.createdAt, this.selected.createdAt),
          and(
            eq(this.older.createdAt, this.selected.createdAt),
            lt(this.older.rowid, this.selected.rowid)
          )
        )
      ))
      .orderBy(desc(this.older.createdAt), desc(this.older.rowid))
      .limit(1);
    return row?.id ?? null;
  }

  async setLabel(projectId: string, versionId: string, label: string | null): Promise<boolean> {
    const rows = await this.db.update(schema.projectHistoryVersions).set({ label })
      .where(and(
        eq(schema.projectHistoryVersions.id, versionId),
        eq(schema.projectHistoryVersions.projectId, projectId)
      ))
      .returning({ id: schema.projectHistoryVersions.id });
    return rows.length > 0;
  }

  async deleteStateAndVersions(projectId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(schema.projectHistoryState).where(eq(schema.projectHistoryState.projectId, projectId));
      await tx.delete(schema.projectHistoryVersions).where(eq(schema.projectHistoryVersions.projectId, projectId));
    });
  }

  async deleteVersions(projectId: string, versionIds: readonly string[]): Promise<void> {
    if (!versionIds.length) return;
    await this.db.delete(schema.projectHistoryVersions).where(and(
      eq(schema.projectHistoryVersions.projectId, projectId),
      inArray(schema.projectHistoryVersions.id, [...versionIds])
    ));
  }

  async updateProjectSettings(projectId: string, mainFile: string, engine: "pdflatex" | "xelatex" | "lualatex"): Promise<boolean> {
    const rows = await this.db.update(schema.projects).set({ mainFile, engine })
      .where(eq(schema.projects.id, projectId))
      .returning({ id: schema.projects.id });
    return rows.length > 0;
  }

  private selectWithAuthor() {
    return this.db.select({
      id: schema.projectHistoryVersions.id,
      project_id: schema.projectHistoryVersions.projectId,
      author_id: schema.projectHistoryVersions.authorId,
      reason: schema.projectHistoryVersions.reason,
      label: schema.projectHistoryVersions.label,
      manifest_json: schema.projectHistoryVersions.manifestJson,
      changed_paths_json: schema.projectHistoryVersions.changedPathsJson,
      created_at: schema.projectHistoryVersions.createdAt,
      rowid: schema.projectHistoryVersions.rowid,
      history_rowid: schema.projectHistoryVersions.rowid,
      author_username: this.author.username,
      author_name: this.author.displayName
    })
      .from(schema.projectHistoryVersions)
      .leftJoin(this.author, eq(this.author.id, schema.projectHistoryVersions.authorId));
  }
}

async function insertVersion(tx: HistoryTransaction, input: HistoryVersionWrite): Promise<void> {
  await tx.insert(schema.projectHistoryVersions).values({
    id: input.id,
    projectId: input.projectId,
    authorId: input.authorId,
    reason: input.reason,
    manifestJson: input.manifestJson,
    changedPathsJson: input.changedPathsJson,
    createdAt: input.createdAt
  });
}

async function upsertBaseline(
  tx: HistoryTransaction | NodePgDatabase<typeof schema>,
  input: { projectId: string; manifestJson: string; updatedAt: string }
): Promise<void> {
  await tx.insert(schema.projectHistoryState).values(input).onConflictDoUpdate({
    target: schema.projectHistoryState.projectId,
    set: { manifestJson: input.manifestJson, updatedAt: input.updatedAt }
  });
}

function toStorageRow(row: {
  id: string;
  project_id: string;
  author_id: string | null;
  reason: string;
  label: string | null;
  manifest_json: string;
  changed_paths_json: string;
  created_at: string;
  rowid: number;
}): HistoryStorageRow {
  return { ...row, reason: asHistoryReason(row.reason) };
}

function toListRow(row: {
  id: string;
  project_id: string;
  author_id: string | null;
  reason: string;
  label: string | null;
  manifest_json: string;
  changed_paths_json: string;
  created_at: string;
  rowid: number;
  author_username: string | null;
  author_name: string | null;
}): HistoryListRow {
  return { ...toStorageRow(row), author_username: row.author_username, author_name: row.author_name };
}

function toPageRow(row: {
  id: string;
  project_id: string;
  author_id: string | null;
  reason: string;
  label: string | null;
  manifest_json: string;
  changed_paths_json: string;
  created_at: string;
  rowid: number;
  history_rowid: number;
  author_username: string | null;
  author_name: string | null;
}): HistoryPageRow {
  return { ...toListRow(row), history_rowid: row.history_rowid };
}

function asHistoryReason(value: string): HistoryReasonValue {
  return ["initial", "autosave", "file", "settings", "restore", "checkpoint"].includes(value)
    ? value as HistoryReasonValue
    : "checkpoint";
}
