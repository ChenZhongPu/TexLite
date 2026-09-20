import { randomUUID } from "node:crypto";
import type { DatabaseConnection } from "./db.js";
import type { MentionRecord } from "./database/repositories/commentMentions.js";
import type { CommentMentionInsert } from "./database/repositories/comments.js";

/** A project participant available to complete an `@username` mention. */
export interface MentionableUser {
  id: string;
  username: string;
  displayName: string;
}

export interface CommentMention {
  id: string;
  projectId: string;
  commentId: string;
  replyId: string | null;
  filePath: string;
  content: string;
  resolved: boolean;
  createdAt: string;
  readAt: string | null;
  readReason: "opened" | "resolved" | "manual" | null;
}

type MentionRow = MentionRecord;

/**
 * List active users who can access a project.  The owner is included even
 * though they have no project_members row.  Callers can exclude the author
 * when presenting a mention picker.
 */
export async function mentionableUsersForProject(db: DatabaseConnection, projectId: string, excludeUserId?: string): Promise<MentionableUser[]> {
  return await db.commentMentions.listMentionableUsers(projectId, excludeUserId);
}

/**
 * Extract mention tokens without taking ownership of ordinary `@` text.
 * The surrounding-character rule intentionally excludes e-mail addresses;
 * the candidate lookup below then makes a token a mention only when it is an
 * exact, currently accessible username.
 */
export function mentionedUsernames(content: string, candidates: readonly MentionableUser[]): string[] {
  const available = new Map(candidates.map((candidate) => [candidate.username.toLocaleLowerCase(), candidate.username]));
  const usernames = new Set<string>();
  const pattern = /(^|[^\p{L}\p{N}_.-])@([\p{L}\p{N}_.-]+)/gu;
  for (const match of content.matchAll(pattern)) {
    let token = match[2];
    let username = available.get(token.toLocaleLowerCase());
    // A sentence-ending period or comma is not part of the mention, even
    // though a username itself is allowed to contain dots and hyphens.
    while (!username && /[.,;:!?)}\]\u201d\u2019]$/u.test(token)) {
      token = token.slice(0, -1);
      username = available.get(token.toLocaleLowerCase());
    }
    if (username) usernames.add(username);
  }
  return [...usernames];
}

/** Resolve exact mention recipients before the comment transaction starts. */
export async function commentMentionInserts(db: DatabaseConnection, input: {
  projectId: string;
  commentId: string;
  replyId?: string | null;
  authorId: string;
  content: string;
  /** On edits, only newly added @users should generate a fresh notification. */
  previousContent?: string;
  createdAt: string;
}): Promise<CommentMentionInsert[]> {
  const candidates = await mentionableUsersForProject(db, input.projectId);
  const previousUsernames = new Set(input.previousContent ? mentionedUsernames(input.previousContent, candidates) : []);
  const recipients = mentionedUsernames(input.content, candidates)
    .map((username) => candidates.find((candidate) => candidate.username === username))
    .filter((candidate): candidate is MentionableUser => Boolean(candidate && candidate.id !== input.authorId && !previousUsernames.has(candidate.username)));
  return recipients.map((recipient) => ({
    id: randomUUID(),
    projectId: input.projectId,
    commentId: input.commentId,
    replyId: input.replyId ?? null,
    mentionedUserId: recipient.id,
    mentionedByUserId: input.authorId,
    createdAt: input.createdAt
  }));
}

/** Return unread mention counts scoped to one receiving user. */
export async function unreadMentionCountsForProjects(db: DatabaseConnection, projectIds: readonly string[], userId: string): Promise<Map<string, number>> {
  return await db.commentMentions.unreadCountsForProjects(projectIds, userId);
}

function mentionFromRow(row: MentionRow): CommentMention {
  return {
    id: row.id,
    projectId: row.project_id,
    commentId: row.comment_id,
    replyId: row.reply_id,
    filePath: row.file_path,
    content: row.reply_id ? row.reply_content ?? "" : row.comment_content,
    resolved: Boolean(row.resolved),
    createdAt: row.created_at,
    readAt: row.read_at,
    readReason: row.read_reason
  };
}

export async function listCommentMentions(db: DatabaseConnection, projectId: string, userId: string, options: { unreadOnly?: boolean; limit?: number; filePath?: string } = {}): Promise<CommentMention[]> {
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const rows = await db.commentMentions.listMentions(projectId, userId, {
    unreadOnly: options.unreadOnly,
    filePath: options.filePath,
    limit
  });
  return rows.map(mentionFromRow);
}

export async function commentMentionForUser(db: DatabaseConnection, mentionId: string, projectId: string, userId: string): Promise<CommentMention | null> {
  const row = await db.commentMentions.findMention(mentionId, projectId, userId);
  return row ? mentionFromRow(row) : null;
}

/** Mark an item read after the UI has opened and located its target thread. */
export async function markCommentMentionRead(db: DatabaseConnection, mentionId: string, userId: string, readAt: string, reason: "opened" | "manual" = "opened"): Promise<boolean> {
  return await db.commentMentions.markRead(mentionId, userId, readAt, reason);
}

/** Explicitly clear every unread notification in a project for one recipient. */
export async function markAllCommentMentionsRead(db: DatabaseConnection, projectId: string, userId: string, readAt: string): Promise<number> {
  return await db.commentMentions.markAllRead(projectId, userId, readAt);
}

/** Resolving a thread makes all existing unread mentions in it non-actionable. */
