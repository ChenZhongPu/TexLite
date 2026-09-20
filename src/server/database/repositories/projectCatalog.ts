import { alias } from "drizzle-orm/pg-core";
import { and, asc, count, countDistinct, desc, eq, inArray, isNull, isNotNull, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ProjectRow } from "../../db.js";
import * as schema from "../schema/postgres.js";

export type ProjectTagColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray";

export interface ProjectTagRecord {
  id: string;
  name: string;
  color: ProjectTagColor;
}

export interface ManagedProjectTagRecord extends ProjectTagRecord {
  projectCount: number;
}

export interface ProjectCatalogRow extends ProjectRow {
  permission: string;
  owner_username: string;
  owner_display_name: string;
  last_modified_username: string | null;
  last_modified_display_name: string | null;
}

/** Typed project metadata mutations and personal catalogs. */
export class PostgresProjectCatalogRepository {
  private readonly owner = alias(schema.users, "catalog_owner");
  private readonly modifier = alias(schema.users, "catalog_modifier");
  private readonly member = alias(schema.projectMembers, "catalog_member");
  private readonly archiveRecord = alias(schema.userProjectArchives, "catalog_archive");

  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async listAccessibleProjects(input: {
    userId: string;
    archivedOnly: boolean;
    search: string;
    tagId: string;
    sort: "created" | "updated";
    page: number;
    pageSize: number;
  }): Promise<{ rows: ProjectCatalogRow[]; total: number }> {
    const tagProjectIds = input.tagId
      ? (await this.db.select({ projectId: schema.userProjectTagLinks.projectId })
        .from(schema.userProjectTagLinks)
        .innerJoin(schema.userTags, eq(schema.userTags.id, schema.userProjectTagLinks.tagId))
        .where(and(
          eq(schema.userProjectTagLinks.tagId, input.tagId),
          eq(schema.userTags.userId, input.userId)
        ))).map((row) => row.projectId)
      : null;
    if (tagProjectIds && tagProjectIds.length === 0) return { rows: [], total: 0 };

    const pattern = `%${escapeLikePattern(input.search)}%`;
    const conditions = [
      or(eq(schema.projects.ownerId, input.userId), isNotNull(this.member.userId)),
      input.archivedOnly ? isNotNull(this.archiveRecord.projectId) : isNull(this.archiveRecord.projectId),
      input.search ? or(
        sql`${schema.projects.name} ILIKE ${pattern} ESCAPE '\\'`,
        sql`${this.owner.username} ILIKE ${pattern} ESCAPE '\\'`,
        sql`${this.owner.displayName} ILIKE ${pattern} ESCAPE '\\'`
      ) : undefined,
      tagProjectIds ? inArray(schema.projects.id, tagProjectIds) : undefined
    ];
    const [countRow] = await this.db.select({ total: countDistinct(schema.projects.id) })
      .from(schema.projects)
      .innerJoin(this.owner, eq(this.owner.id, schema.projects.ownerId))
      .leftJoin(this.member, and(
        eq(this.member.projectId, schema.projects.id),
        eq(this.member.userId, input.userId)
      ))
      .leftJoin(this.archiveRecord, and(
        eq(this.archiveRecord.projectId, schema.projects.id),
        eq(this.archiveRecord.userId, input.userId)
      ))
      .where(and(...conditions));
    const rows = await this.db.select({
      project: schema.projects,
      permission: sql<string>`CASE
        WHEN ${schema.projects.ownerId} = ${input.userId} THEN 'owner'
        WHEN ${this.member.userId} IS NOT NULL THEN ${this.member.permission}
        ELSE 'read' END`,
      owner_username: this.owner.username,
      owner_display_name: this.owner.displayName,
      last_modified_username: this.modifier.username,
      last_modified_display_name: this.modifier.displayName
    })
      .from(schema.projects)
      .innerJoin(this.owner, eq(this.owner.id, schema.projects.ownerId))
      .leftJoin(this.modifier, eq(this.modifier.id, schema.projects.lastModifiedBy))
      .leftJoin(this.member, and(
        eq(this.member.projectId, schema.projects.id),
        eq(this.member.userId, input.userId)
      ))
      .leftJoin(this.archiveRecord, and(
        eq(this.archiveRecord.projectId, schema.projects.id),
        eq(this.archiveRecord.userId, input.userId)
      ))
      .where(and(...conditions))
      .orderBy(
        input.sort === "created" ? desc(schema.projects.createdAt) : desc(schema.projects.updatedAt),
        asc(sql`lower(${schema.projects.name})`)
      )
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize);
    return {
      rows: rows.map((row) => ({
        ...toProjectRow(row.project),
        permission: row.permission,
        owner_username: row.owner_username,
        owner_display_name: row.owner_display_name,
        last_modified_username: row.last_modified_username,
        last_modified_display_name: row.last_modified_display_name
      })),
      total: Number(countRow?.total ?? 0)
    };
  }

  async listTags(userId: string): Promise<ProjectTagRecord[]> {
    const rows = await this.db.select({
      id: schema.userTags.id,
      name: schema.userTags.name,
      color: schema.userTags.color
    })
      .from(schema.userTags)
      .where(eq(schema.userTags.userId, userId))
      .orderBy(sql`lower(${schema.userTags.name})`);
    return rows.map(toTag);
  }

  async listTagsManagement(userId: string): Promise<ManagedProjectTagRecord[]> {
    const rows = await this.db.select({
      id: schema.userTags.id,
      name: schema.userTags.name,
      color: schema.userTags.color,
      projectCount: count(schema.userProjectTagLinks.projectId)
    })
      .from(schema.userTags)
      .leftJoin(schema.userProjectTagLinks, eq(schema.userProjectTagLinks.tagId, schema.userTags.id))
      .where(eq(schema.userTags.userId, userId))
      .groupBy(schema.userTags.id)
      .orderBy(sql`lower(${schema.userTags.name})`);
    return rows.map((row) => ({ ...toTag(row), projectCount: Number(row.projectCount) || 0 }));
  }

  async tagNameTaken(userId: string, name: string, exceptTagId?: string): Promise<boolean> {
    const [row] = await this.db.select({ id: schema.userTags.id })
      .from(schema.userTags)
      .where(and(
        eq(schema.userTags.userId, userId),
        sql`lower(${schema.userTags.name}) = lower(${name})`,
        exceptTagId ? sql`${schema.userTags.id} <> ${exceptTagId}` : undefined
      ))
      .limit(1);
    return Boolean(row);
  }

  async createTag(input: { id: string; userId: string; name: string; color: ProjectTagColor; createdAt: string }): Promise<void> {
    await this.db.insert(schema.userTags).values({
      id: input.id,
      userId: input.userId,
      name: input.name,
      color: input.color,
      createdAt: input.createdAt,
      updatedAt: input.createdAt
    });
  }

  async findTag(userId: string, tagId: string): Promise<{ id: string; projectCount: number } | null> {
    const [row] = await this.db.select({
      id: schema.userTags.id,
      projectCount: count(schema.userProjectTagLinks.projectId)
    })
      .from(schema.userTags)
      .leftJoin(schema.userProjectTagLinks, eq(schema.userProjectTagLinks.tagId, schema.userTags.id))
      .where(and(eq(schema.userTags.id, tagId), eq(schema.userTags.userId, userId)))
      .groupBy(schema.userTags.id)
      .limit(1);
    return row ? { id: row.id, projectCount: Number(row.projectCount) || 0 } : null;
  }

  async updateTag(input: { id: string; userId: string; name: string; color: ProjectTagColor; updatedAt: string }): Promise<boolean> {
    const rows = await this.db.update(schema.userTags).set({
      name: input.name,
      color: input.color,
      updatedAt: input.updatedAt
    }).where(and(eq(schema.userTags.id, input.id), eq(schema.userTags.userId, input.userId)))
      .returning({ id: schema.userTags.id });
    return rows.length > 0;
  }

  async deleteTag(userId: string, tagId: string): Promise<{ id: string; projectCount: number } | null> {
    const tag = await this.findTag(userId, tagId);
    if (!tag) return null;
    await this.db.delete(schema.userTags)
      .where(and(eq(schema.userTags.id, tagId), eq(schema.userTags.userId, userId)));
    return tag;
  }

  async createProject(project: ProjectRow): Promise<void> {
    await this.db.insert(schema.projects).values({
      id: project.id,
      ownerId: project.owner_id,
      lastModifiedBy: project.last_modified_by,
      name: project.name,
      mainFile: project.main_file,
      engine: project.engine,
      icon: project.icon,
      createdAt: project.created_at,
      updatedAt: project.updated_at
    });
  }

  async updateSettings(input: {
    id: string;
    name: string;
    mainFile: string;
    engine: ProjectRow["engine"];
    updatedAt: string;
    lastModifiedBy: string;
  }): Promise<boolean> {
    const rows = await this.db.update(schema.projects).set({
      name: input.name,
      mainFile: input.mainFile,
      engine: input.engine,
      updatedAt: input.updatedAt,
      lastModifiedBy: input.lastModifiedBy
    }).where(eq(schema.projects.id, input.id)).returning({ id: schema.projects.id });
    return rows.length > 0;
  }

  async moveProjectPath(input: {
    id: string;
    mainFile: string;
    source: string;
    destination: string;
    changedAt: string;
    lastModifiedBy: string;
  }): Promise<boolean> {
    return await this.db.transaction(async (tx) => {
      await tx.update(schema.projects).set({
        mainFile: input.mainFile,
        updatedAt: input.changedAt,
        lastModifiedBy: input.lastModifiedBy
      }).where(eq(schema.projects.id, input.id));
      const comments = await tx.select({
        id: schema.comments.id,
        filePath: schema.comments.filePath
      }).from(schema.comments).where(eq(schema.comments.projectId, input.id));
      let changed = false;
      for (const comment of comments) {
        const nextPath = movePath(comment.filePath, input.source, input.destination);
        if (nextPath === comment.filePath) continue;
        changed = true;
        await tx.update(schema.comments).set({ filePath: nextPath, updatedAt: input.changedAt })
          .where(eq(schema.comments.id, comment.id));
      }
      return changed;
    });
  }

  async setIcon(input: { id: string; ownerId: string; icon: string | null; updatedAt: string; lastModifiedBy: string }): Promise<boolean> {
    const rows = await this.db.update(schema.projects).set({
      icon: input.icon,
      updatedAt: input.updatedAt,
      lastModifiedBy: input.lastModifiedBy
    }).where(and(eq(schema.projects.id, input.id), eq(schema.projects.ownerId, input.ownerId)))
      .returning({ id: schema.projects.id });
    return rows.length > 0;
  }

  async deleteProject(projectId: string): Promise<boolean> {
    const rows = await this.db.delete(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .returning({ id: schema.projects.id });
    return rows.length > 0;
  }

  async archive(userId: string, projectId: string, archivedAt: string): Promise<void> {
    await this.db.insert(schema.userProjectArchives).values({ userId, projectId, archivedAt })
      .onConflictDoNothing({ target: [schema.userProjectArchives.userId, schema.userProjectArchives.projectId] });
  }

  async unarchive(userId: string, projectId: string): Promise<void> {
    await this.db.delete(schema.userProjectArchives).where(and(
      eq(schema.userProjectArchives.userId, userId),
      eq(schema.userProjectArchives.projectId, projectId)
    ));
  }

  async listDictionaryWords(projectId: string): Promise<string[]> {
    const rows = await this.db.select({ word: schema.projectDictionaryWords.word })
      .from(schema.projectDictionaryWords)
      .where(eq(schema.projectDictionaryWords.projectId, projectId))
      .orderBy(sql`lower(${schema.projectDictionaryWords.word})`);
    return rows.map((row) => row.word);
  }

  async addDictionaryWord(input: { projectId: string; word: string; createdBy: string; createdAt: string }): Promise<void> {
    await this.db.insert(schema.projectDictionaryWords).values({
      projectId: input.projectId,
      word: input.word,
      createdBy: input.createdBy,
      createdAt: input.createdAt
    }).onConflictDoNothing();
  }

  async removeDictionaryWord(projectId: string, word: string): Promise<void> {
    await this.db.delete(schema.projectDictionaryWords).where(and(
      eq(schema.projectDictionaryWords.projectId, projectId),
      sql`lower(${schema.projectDictionaryWords.word}) = lower(${word})`
    ));
  }

  async userOwnsTag(userId: string, tagId: string): Promise<boolean> {
    const [row] = await this.db.select({ id: schema.userTags.id }).from(schema.userTags)
      .where(and(eq(schema.userTags.id, tagId), eq(schema.userTags.userId, userId))).limit(1);
    return Boolean(row);
  }

  async linkTag(projectId: string, tagId: string, createdAt: string): Promise<void> {
    await this.db.insert(schema.userProjectTagLinks).values({ projectId, tagId, createdAt }).onConflictDoNothing();
  }

  async unlinkTag(userId: string, projectId: string, tagId: string): Promise<void> {
    const owned = await this.userOwnsTag(userId, tagId);
    if (!owned) return;
    await this.db.delete(schema.userProjectTagLinks).where(and(
      eq(schema.userProjectTagLinks.projectId, projectId),
      eq(schema.userProjectTagLinks.tagId, tagId)
    ));
  }
}

function toTag(row: { id: string; name: string; color: string }): ProjectTagRecord {
  return { id: row.id, name: row.name, color: asTagColor(row.color) };
}

function movePath(value: string, source: string, destination: string): string {
  if (value === source) return destination;
  return value.startsWith(`${source}/`) ? `${destination}${value.slice(source.length)}` : value;
}

function asTagColor(value: string): ProjectTagColor {
  return ["red", "orange", "yellow", "green", "blue", "purple", "gray"].includes(value)
    ? value as ProjectTagColor
    : "gray";
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function toProjectRow(row: typeof schema.projects.$inferSelect): ProjectRow {
  return {
    id: row.id,
    owner_id: row.ownerId,
    last_modified_by: row.lastModifiedBy,
    name: row.name,
    main_file: row.mainFile,
    engine: row.engine as ProjectRow["engine"],
    icon: row.icon,
    created_at: row.createdAt,
    updated_at: row.updatedAt
  };
}
