import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, inArray, type ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import * as schema from "../schema/postgres.js";

type EditHistoryTransaction = NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;

export interface EditHistorySegmentRecord {
  id: string;
  projectId: string;
  filePath: string;
  authorId: string;
  kind: "edit" | "format";
  beforeHash: string;
  afterHash: string;
  stepsJson: string;
  stepsBytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface EditHistoryBoundaryRecord {
  projectId: string;
  filePath: string;
  afterHash: string;
  updatedAt: string;
}

export interface EditHistoryStorageRow {
  id: string;
  file_path: string;
  after_hash: string;
  updated_at: string;
  steps_bytes: number;
}

export interface EditHistorySelectionRow {
  id: string;
  project_id: string;
  file_path: string;
  author_id: string | null;
  kind: "edit" | "format";
  before_hash: string;
  after_hash: string;
  steps_json: string;
  created_at: string;
  updated_at: string;
  author_username: string | null;
  author_name: string | null;
}

/** Typed access to the bounded collaboration edit stream. */
export class PostgresEditHistoryRepository {
  private readonly author = alias(schema.users, "edit_history_author");

  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async record(
    segments: readonly EditHistorySegmentRecord[],
    boundaries: readonly EditHistoryBoundaryRecord[],
    maxStorageBytes: number
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (segments.length) {
        await tx.insert(schema.projectEditSegments).values(segments.map((segment) => ({
          id: segment.id,
          projectId: segment.projectId,
          filePath: segment.filePath,
          authorId: segment.authorId,
          kind: segment.kind,
          beforeHash: segment.beforeHash,
          afterHash: segment.afterHash,
          stepsJson: segment.stepsJson,
          stepsBytes: segment.stepsBytes,
          createdAt: segment.createdAt,
          updatedAt: segment.updatedAt
        })));
      }
      for (const boundary of boundaries) await this.upsertBoundary(tx, boundary);
      await this.pruneOn(tx, boundaries[0]?.projectId ?? segments[0]?.projectId ?? "", maxStorageBytes);
    });
  }

  async stats(projectId: string): Promise<{ segmentCount: number; payloadBytes: number }> {
    const rows = await this.db.select({
      stepsBytes: schema.projectEditSegments.stepsBytes
    })
      .from(schema.projectEditSegments)
      .where(eq(schema.projectEditSegments.projectId, projectId));
    return {
      segmentCount: rows.length,
      payloadBytes: rows.reduce((sum, row) => sum + Math.max(0, Number(row.stepsBytes) || 0), 0)
    };
  }

  async clear(projectId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(schema.projectEditSegments).where(eq(schema.projectEditSegments.projectId, projectId));
      await tx.delete(schema.projectEditHistoryBoundaries).where(eq(schema.projectEditHistoryBoundaries.projectId, projectId));
    });
  }

  async prune(projectId: string, maxStorageBytes: number): Promise<void> {
    await this.db.transaction(async (tx) => this.pruneOn(tx, projectId, maxStorageBytes));
  }

  async selectionRows(projectId: string, filePath: string, limit: number): Promise<EditHistorySelectionRow[]> {
    const rows = await this.db.select({
      id: schema.projectEditSegments.id,
      project_id: schema.projectEditSegments.projectId,
      file_path: schema.projectEditSegments.filePath,
      author_id: schema.projectEditSegments.authorId,
      kind: schema.projectEditSegments.kind,
      before_hash: schema.projectEditSegments.beforeHash,
      after_hash: schema.projectEditSegments.afterHash,
      steps_json: schema.projectEditSegments.stepsJson,
      created_at: schema.projectEditSegments.createdAt,
      updated_at: schema.projectEditSegments.updatedAt,
      author_username: this.author.username,
      author_name: this.author.displayName
    })
      .from(schema.projectEditSegments)
      .leftJoin(this.author, eq(this.author.id, schema.projectEditSegments.authorId))
      .where(and(
        eq(schema.projectEditSegments.projectId, projectId),
        eq(schema.projectEditSegments.filePath, filePath)
      ))
      .orderBy(desc(schema.projectEditSegments.updatedAt), desc(schema.projectEditSegments.rowid))
      .limit(limit);
    return rows.map((row) => ({ ...row, kind: row.kind === "format" ? "format" : "edit" }));
  }

  async retentionBoundary(projectId: string, filePath: string): Promise<string | null> {
    const [row] = await this.db.select({ afterHash: schema.projectEditHistoryBoundaries.afterHash })
      .from(schema.projectEditHistoryBoundaries)
      .where(and(
        eq(schema.projectEditHistoryBoundaries.projectId, projectId),
        eq(schema.projectEditHistoryBoundaries.filePath, filePath)
      ))
      .limit(1);
    return row?.afterHash ?? null;
  }

  private async pruneOn(tx: EditHistoryTransaction, projectId: string, maxStorageBytes: number): Promise<void> {
    if (!projectId) return;
    const rows = await tx.select({
      id: schema.projectEditSegments.id,
      file_path: schema.projectEditSegments.filePath,
      after_hash: schema.projectEditSegments.afterHash,
      updated_at: schema.projectEditSegments.updatedAt,
      steps_bytes: schema.projectEditSegments.stepsBytes
    })
      .from(schema.projectEditSegments)
      .where(eq(schema.projectEditSegments.projectId, projectId))
      .orderBy(desc(schema.projectEditSegments.updatedAt), desc(schema.projectEditSegments.rowid));

    let retainedBytes = 0;
    let retainedCount = 0;
    let firstDiscard = rows.length;
    for (let index = 0; index < rows.length; index += 1) {
      const size = Math.max(0, Number(rows[index]!.steps_bytes) || 0);
      if (retainedCount >= 5_000 || retainedBytes + size > maxStorageBytes) {
        firstDiscard = index;
        break;
      }
      retainedBytes += size;
      retainedCount += 1;
    }
    if (firstDiscard === rows.length) return;

    const discarded = rows.slice(firstDiscard);
    const boundaryFiles = new Set<string>();
    for (const row of discarded) {
      if (boundaryFiles.has(row.file_path)) continue;
      boundaryFiles.add(row.file_path);
      await this.upsertBoundary(tx, {
        projectId,
        filePath: row.file_path,
        afterHash: row.after_hash,
        updatedAt: row.updated_at
      });
    }
    await tx.delete(schema.projectEditSegments)
      .where(inArray(schema.projectEditSegments.id, discarded.map((row) => row.id)));
  }

  private async upsertBoundary(tx: EditHistoryTransaction, boundary: EditHistoryBoundaryRecord): Promise<void> {
    await tx.insert(schema.projectEditHistoryBoundaries).values({
      projectId: boundary.projectId,
      filePath: boundary.filePath,
      afterHash: boundary.afterHash,
      updatedAt: boundary.updatedAt
    }).onConflictDoUpdate({
      target: [schema.projectEditHistoryBoundaries.projectId, schema.projectEditHistoryBoundaries.filePath],
      set: { afterHash: boundary.afterHash, updatedAt: boundary.updatedAt }
    });
  }
}
