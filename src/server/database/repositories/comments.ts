import { alias } from "drizzle-orm/pg-core";
import { and, asc, eq, isNull, or, sql, type ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import * as schema from "../schema/postgres.js";

type CommentTransaction = NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;

export interface CommentReadRecord {
  id: string;
  file_path: string;
  author_id: string | null;
  author_username: string | null;
  author_display_name: string | null;
  selected_text: string;
  start_offset: number;
  end_offset: number;
  content: string;
  resolved: number;
  orphaned: number;
  created_at: string;
  updated_at: string;
  edited_at: string | null;
}

export interface CommentReplyReadRecord {
  id: string;
  comment_id: string;
  author_id: string | null;
  author_username: string | null;
  author_display_name: string | null;
  content: string;
  created_at: string;
  updated_at: string;
  edited_at: string | null;
}

export interface CommentAnchorRecord {
  id: string;
  selected_text: string;
  start_offset: number;
  end_offset: number;
  context_before: string;
  context_after: string;
}

export interface CommentMutationRecord {
  author_id: string | null;
  resolved: number;
  content: string;
}

export interface ReplyMutationRecord {
  author_id: string | null;
  content: string;
}

export interface CommentMentionInsert {
  id: string;
  projectId: string;
  commentId: string;
  replyId: string | null;
  mentionedUserId: string;
  mentionedByUserId: string;
  createdAt: string;
}

/** Typed read queries for rendering anchored comments and replies. */
export class PostgresCommentRepository {
  private readonly commentAuthor = alias(schema.users, "comment_author");
  private readonly replyAuthor = alias(schema.users, "reply_author");

  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async listReplies(commentId: string): Promise<CommentReplyReadRecord[]> {
    const rows = await this.db.select({
      id: schema.commentReplies.id,
      comment_id: schema.commentReplies.commentId,
      author_id: schema.commentReplies.authorId,
      author_username: this.replyAuthor.username,
      author_display_name: this.replyAuthor.displayName,
      content: schema.commentReplies.content,
      created_at: schema.commentReplies.createdAt,
      updated_at: schema.commentReplies.updatedAt,
      edited_at: schema.commentReplies.editedAt
    })
      .from(schema.commentReplies)
      .leftJoin(this.replyAuthor, eq(this.replyAuthor.id, schema.commentReplies.authorId))
      .where(eq(schema.commentReplies.commentId, commentId))
      .orderBy(asc(schema.commentReplies.createdAt));
    return rows;
  }

  async listComments(projectId: string, filePath?: string): Promise<CommentReadRecord[]> {
    const rows = await this.db.select({
      id: schema.comments.id,
      file_path: schema.comments.filePath,
      author_id: schema.comments.authorId,
      author_username: this.commentAuthor.username,
      author_display_name: this.commentAuthor.displayName,
      selected_text: schema.comments.selectedText,
      start_offset: schema.comments.startOffset,
      end_offset: schema.comments.endOffset,
      content: schema.comments.content,
      resolved: schema.comments.resolved,
      orphaned: schema.comments.orphaned,
      created_at: schema.comments.createdAt,
      updated_at: schema.comments.updatedAt,
      edited_at: schema.comments.editedAt
    })
      .from(schema.comments)
      .leftJoin(this.commentAuthor, eq(this.commentAuthor.id, schema.comments.authorId))
      .where(and(
        eq(schema.comments.projectId, projectId),
        filePath !== undefined ? eq(schema.comments.filePath, filePath) : undefined
      ))
      .orderBy(
        filePath !== undefined ? asc(schema.comments.createdAt) : asc(schema.comments.filePath),
        ...(filePath !== undefined ? [] : [asc(schema.comments.startLine), asc(schema.comments.createdAt)])
      );
    return rows;
  }

  async listRepliesForProject(projectId: string, filePath?: string): Promise<CommentReplyReadRecord[]> {
    const rows = await this.db.select({
      id: schema.commentReplies.id,
      comment_id: schema.commentReplies.commentId,
      author_id: schema.commentReplies.authorId,
      author_username: this.replyAuthor.username,
      author_display_name: this.replyAuthor.displayName,
      content: schema.commentReplies.content,
      created_at: schema.commentReplies.createdAt,
      updated_at: schema.commentReplies.updatedAt,
      edited_at: schema.commentReplies.editedAt
    })
      .from(schema.commentReplies)
      .innerJoin(schema.comments, eq(schema.comments.id, schema.commentReplies.commentId))
      .leftJoin(this.replyAuthor, eq(this.replyAuthor.id, schema.commentReplies.authorId))
      .where(and(
        eq(schema.comments.projectId, projectId),
        filePath !== undefined ? eq(schema.comments.filePath, filePath) : undefined
      ))
      .orderBy(asc(schema.commentReplies.createdAt));
    return rows;
  }

  async listAnchors(projectId: string, filePath: string): Promise<CommentAnchorRecord[]> {
    return await this.db.select({
      id: schema.comments.id,
      selected_text: schema.comments.selectedText,
      start_offset: schema.comments.startOffset,
      end_offset: schema.comments.endOffset,
      context_before: schema.comments.contextBefore,
      context_after: schema.comments.contextAfter
    })
      .from(schema.comments)
      .where(and(eq(schema.comments.projectId, projectId), eq(schema.comments.filePath, filePath)));
  }

  async updateAnchor(input: {
    id: string;
    selectedText: string;
    startOffset: number;
    endOffset: number;
    contextBefore: string;
    contextAfter: string;
    orphaned: number;
    updatedAt: string;
  }): Promise<void> {
    await this.db.update(schema.comments).set({
      selectedText: input.selectedText,
      startOffset: input.startOffset,
      endOffset: input.endOffset,
      contextBefore: input.contextBefore,
      contextAfter: input.contextAfter,
      orphaned: input.orphaned,
      updatedAt: input.updatedAt
    }).where(eq(schema.comments.id, input.id));
  }

  async findComment(projectId: string, commentId: string): Promise<CommentMutationRecord | null> {
    const [row] = await this.db.select({
      author_id: schema.comments.authorId,
      resolved: schema.comments.resolved,
      content: schema.comments.content
    })
      .from(schema.comments)
      .where(and(eq(schema.comments.id, commentId), eq(schema.comments.projectId, projectId)))
      .limit(1);
    return row ?? null;
  }

  async findReply(projectId: string, commentId: string, replyId: string): Promise<ReplyMutationRecord | null> {
    const [row] = await this.db.select({
      author_id: schema.commentReplies.authorId,
      content: schema.commentReplies.content
    })
      .from(schema.commentReplies)
      .innerJoin(schema.comments, eq(schema.comments.id, schema.commentReplies.commentId))
      .where(and(
        eq(schema.commentReplies.id, replyId),
        eq(schema.commentReplies.commentId, commentId),
        eq(schema.comments.projectId, projectId)
      ))
      .limit(1);
    return row ?? null;
  }

  async deleteComment(commentId: string): Promise<void> {
    await this.db.delete(schema.comments).where(eq(schema.comments.id, commentId));
  }

  async deleteReply(replyId: string): Promise<void> {
    await this.db.delete(schema.commentReplies).where(eq(schema.commentReplies.id, replyId));
  }

  async deleteForFileTree(projectId: string, filePath: string): Promise<number> {
    const pattern = `${escapeLikePattern(filePath)}/%`;
    const rows = await this.db.delete(schema.comments).where(and(
      eq(schema.comments.projectId, projectId),
      or(
        eq(schema.comments.filePath, filePath),
        sql`${schema.comments.filePath} LIKE ${pattern} ESCAPE '\\'`
      )
    )).returning({ id: schema.comments.id });
    return rows.length;
  }

  async createComment(input: {
    id: string;
    projectId: string;
    filePath: string;
    authorId: string;
    selectedText: string;
    startOffset: number;
    endOffset: number;
    contextBefore: string;
    contextAfter: string;
    startLine: number;
    endLine: number;
    content: string;
    createdAt: string;
  }, mentions: readonly CommentMentionInsert[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(schema.comments).values({
        id: input.id,
        projectId: input.projectId,
        filePath: input.filePath,
        authorId: input.authorId,
        selectedText: input.selectedText,
        startOffset: input.startOffset,
        endOffset: input.endOffset,
        contextBefore: input.contextBefore,
        contextAfter: input.contextAfter,
        orphaned: 0,
        startLine: input.startLine,
        endLine: input.endLine,
        content: input.content,
        createdAt: input.createdAt,
        updatedAt: input.createdAt
      });
      await upsertMentions(tx, mentions);
    });
  }

  async createReply(input: {
    id: string;
    commentId: string;
    authorId: string;
    content: string;
    createdAt: string;
  }, mentions: readonly CommentMentionInsert[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(schema.commentReplies).values({
        id: input.id,
        commentId: input.commentId,
        authorId: input.authorId,
        content: input.content,
        createdAt: input.createdAt,
        updatedAt: input.createdAt
      });
      await upsertMentions(tx, mentions);
    });
  }

  async updateComment(input: {
    id: string;
    content?: string;
    resolved?: boolean;
    updatedAt: string;
    markMentionsResolved: boolean;
  }, mentions: readonly CommentMentionInsert[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      const values: {
        content?: string;
        resolved?: number;
        updatedAt: string;
        editedAt?: string;
      } = { updatedAt: input.updatedAt };
      if (input.content !== undefined) {
        values.content = input.content;
        values.editedAt = input.updatedAt;
      }
      if (input.resolved !== undefined) values.resolved = input.resolved ? 1 : 0;
      await tx.update(schema.comments).set(values).where(eq(schema.comments.id, input.id));
      await upsertMentions(tx, mentions);
      if (input.markMentionsResolved) {
        await tx.update(schema.commentMentions).set({
          readAt: input.updatedAt,
          readReason: "resolved"
        }).where(and(
          eq(schema.commentMentions.commentId, input.id),
          isNull(schema.commentMentions.readAt)
        ));
      }
    });
  }

  async updateReply(input: {
    id: string;
    content: string;
    updatedAt: string;
  }, mentions: readonly CommentMentionInsert[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(schema.commentReplies).set({
        content: input.content,
        updatedAt: input.updatedAt,
        editedAt: input.updatedAt
      }).where(eq(schema.commentReplies.id, input.id));
      await upsertMentions(tx, mentions);
    });
  }
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

async function upsertMentions(tx: CommentTransaction, mentions: readonly CommentMentionInsert[]): Promise<void> {
  for (const mention of mentions) {
    const replyCondition = mention.replyId === null
      ? isNull(schema.commentMentions.replyId)
      : eq(schema.commentMentions.replyId, mention.replyId);
    const [existing] = await tx.select({ id: schema.commentMentions.id })
      .from(schema.commentMentions)
      .where(and(
        eq(schema.commentMentions.commentId, mention.commentId),
        replyCondition,
        eq(schema.commentMentions.mentionedUserId, mention.mentionedUserId)
      ))
      .limit(1);
    if (existing) {
      await tx.update(schema.commentMentions).set({
        mentionedByUserId: mention.mentionedByUserId,
        createdAt: mention.createdAt,
        readAt: null,
        readReason: null
      }).where(eq(schema.commentMentions.id, existing.id));
    } else {
      await tx.insert(schema.commentMentions).values(mention);
    }
  }
}
