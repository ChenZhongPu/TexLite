import { alias } from "drizzle-orm/pg-core";
import { and, asc, count, desc, eq, inArray, or, sql, type ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import * as schema from "../schema/postgres.js";

type CitationTransaction = NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;
export type CitationTagColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray";

export interface CitationLibraryRow {
  id: string;
  user_id: string;
  citation_key: string;
  entry_type: string;
  bibtex: string;
  title: string | null;
  authors: string | null;
  year: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  owner_username?: string | null;
  owner_display_name?: string | null;
}

export interface CitationLibraryTagRow {
  id: string;
  name: string;
  color: CitationTagColor;
  user_id: string;
}

/** Typed access to each user's private citation library. */
export class PostgresCitationRepository {
  private readonly owner = alias(schema.users, "citation_owner");

  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async listEntries(input: {
    userId: string;
    search: string;
    tagId: string;
    page: number;
    pageSize: number;
  }): Promise<{ rows: CitationLibraryRow[]; total: number }> {
    const tagEntryIds = input.tagId ? await this.entryIdsForTag(input.userId, input.tagId) : null;
    if (tagEntryIds && tagEntryIds.length === 0) return { rows: [], total: 0 };
    const conditions = this.entryConditions(input, tagEntryIds);
    const [countRow] = await this.db.select({ count: count() })
      .from(schema.citationLibraryEntries)
      .where(and(...conditions));
    const rows = await this.db.select({
      id: schema.citationLibraryEntries.id,
      user_id: schema.citationLibraryEntries.userId,
      citation_key: schema.citationLibraryEntries.citationKey,
      entry_type: schema.citationLibraryEntries.entryType,
      bibtex: schema.citationLibraryEntries.bibtex,
      title: schema.citationLibraryEntries.title,
      authors: schema.citationLibraryEntries.authors,
      year: schema.citationLibraryEntries.year,
      revision: schema.citationLibraryEntries.revision,
      created_at: schema.citationLibraryEntries.createdAt,
      updated_at: schema.citationLibraryEntries.updatedAt,
      owner_username: this.owner.username,
      owner_display_name: this.owner.displayName
    })
      .from(schema.citationLibraryEntries)
      .innerJoin(this.owner, eq(this.owner.id, schema.citationLibraryEntries.userId))
      .where(and(...conditions))
      .orderBy(desc(schema.citationLibraryEntries.updatedAt), asc(sql`lower(${schema.citationLibraryEntries.citationKey})`))
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize);
    return { rows, total: Number(countRow?.count ?? 0) };
  }

  async listTags(userId: string): Promise<CitationLibraryTagRow[]> {
    const rows = await this.db.select({
      id: schema.citationLibraryTags.id,
      name: schema.citationLibraryTags.name,
      color: schema.citationLibraryTags.color,
      user_id: schema.citationLibraryTags.userId
    })
      .from(schema.citationLibraryTags)
      .where(eq(schema.citationLibraryTags.userId, userId))
      .orderBy(asc(sql`lower(${schema.citationLibraryTags.name})`));
    return rows.map(toTagRow);
  }

  async ensureTag(input: {
    id: string;
    userId: string;
    name: string;
    color: CitationTagColor;
    createdAt: string;
  }): Promise<{ tag: CitationLibraryTagRow; created: boolean }> {
    return await this.db.transaction(async (tx) => {
      const existing = await findTagByName(tx, input.userId, input.name);
      if (existing) return { tag: existing, created: false };
      await tx.insert(schema.citationLibraryTags).values({
        id: input.id,
        userId: input.userId,
        name: input.name,
        color: input.color,
        createdAt: input.createdAt
      }).onConflictDoNothing();
      const tag = await findTagByName(tx, input.userId, input.name);
      if (!tag) throw new Error("Citation tag disappeared after insert");
      return { tag, created: tag.id === input.id };
    });
  }

  async deleteTag(userId: string, tagId: string): Promise<boolean> {
    const rows = await this.db.delete(schema.citationLibraryTags)
      .where(and(eq(schema.citationLibraryTags.id, tagId), eq(schema.citationLibraryTags.userId, userId)))
      .returning({ id: schema.citationLibraryTags.id });
    return rows.length > 0;
  }

  async tagIdsForUser(userId: string, ids: readonly string[]): Promise<string[]> {
    if (!ids.length) return [];
    const rows = await this.db.select({ id: schema.citationLibraryTags.id })
      .from(schema.citationLibraryTags)
      .where(and(eq(schema.citationLibraryTags.userId, userId), inArray(schema.citationLibraryTags.id, [...ids])));
    return rows.map((row) => row.id);
  }

  async tagsForEntries(entryIds: readonly string[]): Promise<Map<string, CitationLibraryTagRow[]>> {
    const result = new Map(entryIds.map((entryId) => [entryId, [] as CitationLibraryTagRow[]]));
    if (!entryIds.length) return result;
    const rows = await this.db.select({
      entry_id: schema.citationLibraryEntryTags.entryId,
      id: schema.citationLibraryTags.id,
      name: schema.citationLibraryTags.name,
      color: schema.citationLibraryTags.color,
      user_id: schema.citationLibraryTags.userId
    })
      .from(schema.citationLibraryEntryTags)
      .innerJoin(schema.citationLibraryTags, eq(schema.citationLibraryTags.id, schema.citationLibraryEntryTags.tagId))
      .innerJoin(schema.citationLibraryEntries, and(
        eq(schema.citationLibraryEntries.id, schema.citationLibraryEntryTags.entryId),
        eq(schema.citationLibraryEntries.userId, schema.citationLibraryTags.userId)
      ))
      .where(inArray(schema.citationLibraryEntryTags.entryId, [...entryIds]))
      .orderBy(asc(sql`lower(${schema.citationLibraryTags.name})`));
    for (const row of rows) result.get(row.entry_id)?.push(toTagRow(row));
    return result;
  }

  async lookup(userId: string, keys: readonly string[]): Promise<Array<{ id: string; citation_key: string; revision: number }>> {
    if (!keys.length) return [];
    const rows = await this.db.select({
      id: schema.citationLibraryEntries.id,
      citation_key: schema.citationLibraryEntries.citationKey,
      revision: schema.citationLibraryEntries.revision
    })
      .from(schema.citationLibraryEntries)
      .where(and(
        eq(schema.citationLibraryEntries.userId, userId),
        inArray(sql`lower(${schema.citationLibraryEntries.citationKey})`, keys.map((key) => key.toLowerCase()))
      ));
    return rows;
  }

  async findById(id: string, userId: string): Promise<CitationLibraryRow | null> {
    const [row] = await this.db.select({
      id: schema.citationLibraryEntries.id,
      user_id: schema.citationLibraryEntries.userId,
      citation_key: schema.citationLibraryEntries.citationKey,
      entry_type: schema.citationLibraryEntries.entryType,
      bibtex: schema.citationLibraryEntries.bibtex,
      title: schema.citationLibraryEntries.title,
      authors: schema.citationLibraryEntries.authors,
      year: schema.citationLibraryEntries.year,
      revision: schema.citationLibraryEntries.revision,
      created_at: schema.citationLibraryEntries.createdAt,
      updated_at: schema.citationLibraryEntries.updatedAt
    })
      .from(schema.citationLibraryEntries)
      .where(and(eq(schema.citationLibraryEntries.id, id), eq(schema.citationLibraryEntries.userId, userId)))
      .limit(1);
    return row ?? null;
  }

  async findByKey(userId: string, citationKey: string): Promise<{ id: string; revision: number } | null> {
    const [row] = await this.db.select({
      id: schema.citationLibraryEntries.id,
      revision: schema.citationLibraryEntries.revision
    })
      .from(schema.citationLibraryEntries)
      .where(and(
        eq(schema.citationLibraryEntries.userId, userId),
        sql`lower(${schema.citationLibraryEntries.citationKey}) = lower(${citationKey})`
      ))
      .limit(1);
    return row ?? null;
  }

  async saveEntry(input: {
    id: string;
    userId: string;
    existingId?: string;
    expectedRevision?: number;
    citationKey: string;
    entryType: string;
    bibtex: string;
    title: string | null;
    authors: string | null;
    year: string | null;
    tagIds: readonly string[] | null;
    timestamp: string;
  }): Promise<boolean> {
    return await this.db.transaction(async (tx) => {
      if (input.existingId) {
        const updated = await tx.update(schema.citationLibraryEntries).set({
          citationKey: input.citationKey,
          entryType: input.entryType,
          bibtex: input.bibtex,
          title: input.title,
          authors: input.authors,
          year: input.year,
          revision: sql`${schema.citationLibraryEntries.revision} + 1`,
          updatedAt: input.timestamp
        }).where(and(
          eq(schema.citationLibraryEntries.id, input.existingId),
          eq(schema.citationLibraryEntries.userId, input.userId),
          eq(schema.citationLibraryEntries.revision, input.expectedRevision ?? -1)
        )).returning({ id: schema.citationLibraryEntries.id });
        if (!updated.length) return false;
      } else {
        await tx.insert(schema.citationLibraryEntries).values({
          id: input.id,
          userId: input.userId,
          citationKey: input.citationKey,
          entryType: input.entryType,
          bibtex: input.bibtex,
          title: input.title,
          authors: input.authors,
          year: input.year,
          revision: 1,
          createdAt: input.timestamp,
          updatedAt: input.timestamp
        });
      }
      if (input.tagIds !== null) await replaceTags(tx, input.existingId ?? input.id, input.tagIds, input.timestamp);
      return true;
    });
  }

  async updateTags(input: {
    id: string;
    userId: string;
    expectedRevision: number;
    tagIds: readonly string[];
    timestamp: string;
  }): Promise<"updated" | "not_found" | "conflict"> {
    return await this.db.transaction(async (tx) => {
      const updated = await tx.update(schema.citationLibraryEntries).set({
        revision: sql`${schema.citationLibraryEntries.revision} + 1`,
        updatedAt: input.timestamp
      }).where(and(
        eq(schema.citationLibraryEntries.id, input.id),
        eq(schema.citationLibraryEntries.userId, input.userId),
        eq(schema.citationLibraryEntries.revision, input.expectedRevision)
      )).returning({ id: schema.citationLibraryEntries.id });
      if (!updated.length) {
        const [exists] = await tx.select({ id: schema.citationLibraryEntries.id })
          .from(schema.citationLibraryEntries)
          .where(and(eq(schema.citationLibraryEntries.id, input.id), eq(schema.citationLibraryEntries.userId, input.userId)))
          .limit(1);
        return exists ? "conflict" : "not_found";
      }
      await replaceTags(tx, input.id, input.tagIds, input.timestamp);
      return "updated";
    });
  }

  async deleteEntry(id: string, userId: string): Promise<boolean> {
    const rows = await this.db.delete(schema.citationLibraryEntries)
      .where(and(eq(schema.citationLibraryEntries.id, id), eq(schema.citationLibraryEntries.userId, userId)))
      .returning({ id: schema.citationLibraryEntries.id });
    return rows.length > 0;
  }

  private entryConditions(input: { userId: string; search: string }, tagEntryIds: string[] | null) {
    const pattern = `%${escapeLikePattern(input.search)}%`;
    return [
      eq(schema.citationLibraryEntries.userId, input.userId),
      input.search ? or(
        sql`${schema.citationLibraryEntries.citationKey} ILIKE ${pattern} ESCAPE '\\'`,
        sql`${schema.citationLibraryEntries.entryType} ILIKE ${pattern} ESCAPE '\\'`,
        sql`coalesce(${schema.citationLibraryEntries.title}, '') ILIKE ${pattern} ESCAPE '\\'`,
        sql`coalesce(${schema.citationLibraryEntries.authors}, '') ILIKE ${pattern} ESCAPE '\\'`,
        sql`coalesce(${schema.citationLibraryEntries.year}, '') ILIKE ${pattern} ESCAPE '\\'`
      ) : undefined,
      tagEntryIds ? inArray(schema.citationLibraryEntries.id, tagEntryIds) : undefined
    ];
  }

  private async entryIdsForTag(userId: string, tagId: string): Promise<string[]> {
    const rows = await this.db.select({ entryId: schema.citationLibraryEntryTags.entryId })
      .from(schema.citationLibraryEntryTags)
      .innerJoin(schema.citationLibraryTags, eq(schema.citationLibraryTags.id, schema.citationLibraryEntryTags.tagId))
      .where(and(eq(schema.citationLibraryEntryTags.tagId, tagId), eq(schema.citationLibraryTags.userId, userId)));
    return rows.map((row) => row.entryId);
  }
}

async function findTagByName(
  db: NodePgDatabase<typeof schema> | CitationTransaction,
  userId: string,
  name: string
): Promise<CitationLibraryTagRow | null> {
  const [row] = await db.select({
    id: schema.citationLibraryTags.id,
    name: schema.citationLibraryTags.name,
    color: schema.citationLibraryTags.color,
    user_id: schema.citationLibraryTags.userId
  })
    .from(schema.citationLibraryTags)
    .where(and(eq(schema.citationLibraryTags.userId, userId), sql`lower(${schema.citationLibraryTags.name}) = lower(${name})`))
    .limit(1);
  return row ? toTagRow(row) : null;
}

async function replaceTags(
  tx: CitationTransaction,
  entryId: string,
  tagIds: readonly string[],
  createdAt: string
): Promise<void> {
  await tx.delete(schema.citationLibraryEntryTags).where(eq(schema.citationLibraryEntryTags.entryId, entryId));
  if (!tagIds.length) return;
  await tx.insert(schema.citationLibraryEntryTags).values(tagIds.map((tagId) => ({ entryId, tagId, createdAt })));
}

function toTagRow(row: { id: string; name: string; color: string; user_id: string }): CitationLibraryTagRow {
  return {
    id: row.id,
    name: row.name,
    color: ["red", "orange", "yellow", "green", "blue", "purple", "gray"].includes(row.color)
      ? row.color as CitationTagColor : "gray",
    user_id: row.user_id
  };
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
