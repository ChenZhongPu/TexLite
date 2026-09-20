import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../schema/postgres.js";

export interface ProjectTagRecord {
  id: string;
  name: string;
  color: "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray";
}

export interface CommentSummaryRecord {
  projectId: string;
  totalCount: number;
  unresolvedCount: number;
}

/** Small typed queries used by project-list and shared project helpers. */
export class PostgresProjectDataRepository {
  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async tagsForProject(projectId: string, userId: string): Promise<ProjectTagRecord[]> {
    const rows = await this.db.select({
      id: schema.userTags.id,
      name: schema.userTags.name,
      color: schema.userTags.color
    })
      .from(schema.userProjectTagLinks)
      .innerJoin(schema.userTags, eq(schema.userTags.id, schema.userProjectTagLinks.tagId))
      .where(and(
        eq(schema.userProjectTagLinks.projectId, projectId),
        eq(schema.userTags.userId, userId)
      ))
      .orderBy(sql`lower(${schema.userTags.name})`);
    return rows.map((row) => ({ ...row, color: asTagColor(row.color) }));
  }

  async tagsForProjects(projectIds: string[], userId: string): Promise<Map<string, ProjectTagRecord[]>> {
    const result = new Map(projectIds.map((projectId) => [projectId, [] as ProjectTagRecord[]]));
    for (let offset = 0; offset < projectIds.length; offset += 500) {
      const chunk = projectIds.slice(offset, offset + 500);
      if (!chunk.length) continue;
      const rows = await this.db.select({
        projectId: schema.userProjectTagLinks.projectId,
        id: schema.userTags.id,
        name: schema.userTags.name,
        color: schema.userTags.color
      })
        .from(schema.userProjectTagLinks)
        .innerJoin(schema.userTags, eq(schema.userTags.id, schema.userProjectTagLinks.tagId))
        .where(and(
          eq(schema.userTags.userId, userId),
          inArray(schema.userProjectTagLinks.projectId, chunk)
        ))
        .orderBy(schema.userTags.name);
      for (const row of rows) {
        result.get(row.projectId)?.push({ id: row.id, name: row.name, color: asTagColor(row.color) });
      }
    }
    return result;
  }

  async commentsSummaryForProjects(projectIds: string[]): Promise<Map<string, { totalCount: number; unresolvedCount: number }>> {
    const result = new Map<string, { totalCount: number; unresolvedCount: number }>();
    for (let offset = 0; offset < projectIds.length; offset += 100) {
      const chunk = projectIds.slice(offset, offset + 100);
      if (!chunk.length) continue;
      const rows = await this.db.select({
        projectId: schema.comments.projectId,
        totalCount: count(schema.comments.id),
        unresolvedCount: sql<string>`count(*) FILTER (WHERE ${schema.comments.resolved} = 0)`
      })
        .from(schema.comments)
        .where(inArray(schema.comments.projectId, chunk))
        .groupBy(schema.comments.projectId);
      for (const row of rows) {
        result.set(row.projectId, {
          totalCount: Number(row.totalCount) || 0,
          unresolvedCount: Number(row.unresolvedCount) || 0
        });
      }
    }
    return result;
  }

  async commentsSummaryForProject(projectId: string): Promise<{ totalCount: number; unresolvedCount: number }> {
    const [row] = await this.db.select({
      totalCount: count(schema.comments.id),
      unresolvedCount: sql<string>`count(*) FILTER (WHERE ${schema.comments.resolved} = 0)`
    })
      .from(schema.comments)
      .where(eq(schema.comments.projectId, projectId));
    return {
      totalCount: Number(row?.totalCount) || 0,
      unresolvedCount: Number(row?.unresolvedCount) || 0
    };
  }

  async touchProject(projectId: string, userId: string, updatedAt: string): Promise<void> {
    await this.db.update(schema.projects)
      .set({ updatedAt, lastModifiedBy: userId })
      .where(eq(schema.projects.id, projectId));
  }
}

function asTagColor(value: string): ProjectTagRecord["color"] {
  return ["red", "orange", "yellow", "green", "blue", "purple", "gray"].includes(value)
    ? value as ProjectTagRecord["color"]
    : "gray";
}
