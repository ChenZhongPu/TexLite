import { alias } from "drizzle-orm/pg-core";
import { and, count, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../schema/postgres.js";

export interface MentionableUserRecord {
  id: string;
  username: string;
  displayName: string;
}

export interface MentionRecord {
  id: string;
  project_id: string;
  comment_id: string;
  reply_id: string | null;
  file_path: string;
  comment_content: string;
  reply_content: string | null;
  resolved: number;
  created_at: string;
  read_at: string | null;
  read_reason: "opened" | "resolved" | "manual" | null;
}

/** Typed notification queries for explicit project mentions. */
export class PostgresCommentMentionRepository {
  private readonly member = alias(schema.projectMembers, "mention_project_member");
  private readonly reply = alias(schema.commentReplies, "mention_reply");

  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async listMentionableUsers(projectId: string, excludeUserId?: string): Promise<MentionableUserRecord[]> {
    const rows = await this.db.select({
      id: schema.users.id,
      username: schema.users.username,
      displayName: schema.users.displayName
    })
      .from(schema.users)
      .innerJoin(schema.projects, eq(schema.projects.id, projectId))
      .leftJoin(this.member, and(
        eq(this.member.projectId, schema.projects.id),
        eq(this.member.userId, schema.users.id)
      ))
      .where(and(
        eq(schema.users.disabled, 0),
        or(eq(schema.users.id, schema.projects.ownerId), isNotNull(this.member.userId)),
        excludeUserId ? sql`${schema.users.id} <> ${excludeUserId}` : undefined
      ))
      .orderBy(schema.users.displayName, schema.users.username);
    return rows;
  }

  async unreadCountsForProjects(projectIds: readonly string[], userId: string): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (let offset = 0; offset < projectIds.length; offset += 200) {
      const chunk = projectIds.slice(offset, offset + 200);
      if (!chunk.length) continue;
      const rows = await this.db.select({
        projectId: schema.commentMentions.projectId,
        count: count(schema.commentMentions.id)
      })
        .from(schema.commentMentions)
        .where(and(
          eq(schema.commentMentions.mentionedUserId, userId),
          isNull(schema.commentMentions.readAt),
          inArray(schema.commentMentions.projectId, chunk)
        ))
        .groupBy(schema.commentMentions.projectId);
      for (const row of rows) counts.set(row.projectId, Number(row.count) || 0);
    }
    return counts;
  }

  async listMentions(projectId: string, userId: string, options: {
    unreadOnly?: boolean;
    limit: number;
    filePath?: string;
  }): Promise<MentionRecord[]> {
    const rows = await this.db.select({
      id: schema.commentMentions.id,
      project_id: schema.commentMentions.projectId,
      comment_id: schema.commentMentions.commentId,
      reply_id: schema.commentMentions.replyId,
      file_path: schema.comments.filePath,
      comment_content: schema.comments.content,
      reply_content: this.reply.content,
      resolved: schema.comments.resolved,
      created_at: schema.commentMentions.createdAt,
      read_at: schema.commentMentions.readAt,
      read_reason: schema.commentMentions.readReason
    })
      .from(schema.commentMentions)
      .innerJoin(schema.comments, eq(schema.comments.id, schema.commentMentions.commentId))
      .leftJoin(this.reply, eq(this.reply.id, schema.commentMentions.replyId))
      .where(and(
        eq(schema.commentMentions.projectId, projectId),
        eq(schema.commentMentions.mentionedUserId, userId),
        options.unreadOnly ? isNull(schema.commentMentions.readAt) : undefined,
        options.filePath ? eq(schema.comments.filePath, options.filePath) : undefined
      ))
      .orderBy(desc(schema.commentMentions.createdAt))
      .limit(options.limit);
    return rows.map((row) => ({ ...row, read_reason: asReadReason(row.read_reason) }));
  }

  async findMention(mentionId: string, projectId: string, userId: string): Promise<MentionRecord | null> {
    const [row] = await this.db.select({
      id: schema.commentMentions.id,
      project_id: schema.commentMentions.projectId,
      comment_id: schema.commentMentions.commentId,
      reply_id: schema.commentMentions.replyId,
      file_path: schema.comments.filePath,
      comment_content: schema.comments.content,
      reply_content: this.reply.content,
      resolved: schema.comments.resolved,
      created_at: schema.commentMentions.createdAt,
      read_at: schema.commentMentions.readAt,
      read_reason: schema.commentMentions.readReason
    })
      .from(schema.commentMentions)
      .innerJoin(schema.comments, eq(schema.comments.id, schema.commentMentions.commentId))
      .leftJoin(this.reply, eq(this.reply.id, schema.commentMentions.replyId))
      .where(and(
        eq(schema.commentMentions.id, mentionId),
        eq(schema.commentMentions.projectId, projectId),
        eq(schema.commentMentions.mentionedUserId, userId)
      ))
      .limit(1);
    return row ? { ...row, read_reason: asReadReason(row.read_reason) } : null;
  }

  async markRead(mentionId: string, userId: string, readAt: string, reason: "opened" | "manual"): Promise<boolean> {
    const rows = await this.db.update(schema.commentMentions)
      .set({ readAt, readReason: reason })
      .where(and(
        eq(schema.commentMentions.id, mentionId),
        eq(schema.commentMentions.mentionedUserId, userId),
        isNull(schema.commentMentions.readAt)
      ))
      .returning({ id: schema.commentMentions.id });
    return rows.length > 0;
  }

  async markAllRead(projectId: string, userId: string, readAt: string): Promise<number> {
    const rows = await this.db.update(schema.commentMentions)
      .set({ readAt, readReason: "manual" })
      .where(and(
        eq(schema.commentMentions.projectId, projectId),
        eq(schema.commentMentions.mentionedUserId, userId),
        isNull(schema.commentMentions.readAt)
      ))
      .returning({ id: schema.commentMentions.id });
    return rows.length;
  }

  async markResolved(commentId: string, resolvedAt: string): Promise<number> {
    const rows = await this.db.update(schema.commentMentions)
      .set({ readAt: resolvedAt, readReason: "resolved" })
      .where(and(eq(schema.commentMentions.commentId, commentId), isNull(schema.commentMentions.readAt)))
      .returning({ id: schema.commentMentions.id });
    return rows.length;
  }
}

function asReadReason(value: string | null): MentionRecord["read_reason"] {
  return value === "opened" || value === "resolved" || value === "manual" ? value : null;
}
