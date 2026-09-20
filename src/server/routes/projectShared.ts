import fs from "node:fs";
import type { Config } from "../config.js";
import type { DatabaseConnection, ProjectRow, UserRow } from "../db.js";
import { reanchorFileComments, offsetToLine } from "../anchors.js";
import { isCollaborativeTextFile, maxCollaborativeFileBytes } from "../collaboration.js";
import { listProjectFiles, resolveSourcePath } from "../files.js";
import { httpError, ValidationError } from "../http.js";
import { accessibleProject, canEdit } from "../projects.js";

export const now = (): string => new Date().toISOString();
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
export function escapeGlobPattern(value: string): string {
  return value.replace(/[*?[]/g, "[$&]");
}
export function text(value: unknown, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new ValidationError();
  }
  return value.trim();
}

export function dictionaryWord(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError();
  const word = value.trim();
  if (!word || word.length > 64 || /[\s\\{}$%]/u.test(word)) throw new ValidationError();
  return word;
}

export interface ProjectTag {
  id: string;
  name: string;
  color: "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray";
}

export const tagColors = ["red", "orange", "yellow", "green", "blue", "purple", "gray"] as const;

export async function tagsForProject(db: DatabaseConnection, projectId: string, userId: string): Promise<ProjectTag[]> {
  return await db.projectData.tagsForProject(projectId, userId);
}

export async function tagsForProjects(db: DatabaseConnection, projectIds: string[], userId: string): Promise<Map<string, ProjectTag[]>> {
  return await db.projectData.tagsForProjects(projectIds, userId);
}

export async function commentsSummaryForProjects(db: DatabaseConnection, projectIds: string[]): Promise<Map<string, { totalCount: number; unresolvedCount: number }>> {
  return await db.projectData.commentsSummaryForProjects(projectIds);
}

export async function commentsSummaryForProject(db: DatabaseConnection, projectId: string): Promise<{ totalCount: number; unresolvedCount: number }> {
  return await db.projectData.commentsSummaryForProject(projectId);
}

export function projectJson(project: ProjectRow & {
  permission?: string;
  share_link_only?: number;
  owner_username?: string;
  owner_display_name?: string;
  last_modified_username?: string | null;
  last_modified_display_name?: string | null;
  archived?: boolean | number;
}, tags: ProjectTag[] = [], commentsSummary?: { totalCount: number; unresolvedCount: number }, unreadMentionCount = 0) {
  return {
    id: project.id,
    ownerId: project.owner_id,
    ownerUsername: project.owner_username,
    ownerDisplayName: project.owner_display_name,
    lastModifiedBy: project.last_modified_by,
    lastModifiedUsername: project.last_modified_username,
    lastModifiedDisplayName: project.last_modified_display_name,
    name: project.name,
    mainFile: project.main_file,
    engine: project.engine,
    icon: project.icon,
    permission: project.permission,
    shareLinkOnly: Boolean(project.share_link_only),
    tags,
    unresolvedCommentCount: commentsSummary?.unresolvedCount ?? 0,
    commentCount: commentsSummary?.totalCount ?? 0,
    unreadMentionCount,
    archived: Boolean(project.archived),
    createdAt: project.created_at,
    updatedAt: project.updated_at
  };
}

export async function touchProject(db: DatabaseConnection, projectId: string, userId: string): Promise<void> {
  await db.projectData.touchProject(projectId, userId, now());
}

export async function requireActiveUser(db: DatabaseConnection, user: UserRow): Promise<void> {
  const current = await db.identity.findUserById(user.id);
  if (!current || current.disabled) {
    throw httpError(401, "AUTH_REQUIRED");
  }
}

/**
 * Authorization must be checked again after a queued mutation acquires its
 * project lock.  A member can be revoked, or ownership can be transferred,
 * while the request is waiting behind another filesystem operation.
 */
export async function requireEditableProject(db: DatabaseConnection, projectId: string, user: UserRow) {
  await requireActiveUser(db, user);
  const project = await accessibleProject(db, projectId, user);
  if (!project) throw httpError(404, "PROJECT_NOT_FOUND");
  if (!canEdit(project)) throw httpError(403, "PROJECT_EDIT_FORBIDDEN");
  return project;
}

/** Owner permission is granted only to the stored project owner. */
export async function requireProjectOwnerPermission(db: DatabaseConnection, projectId: string, user: UserRow) {
  await requireActiveUser(db, user);
  const project = await accessibleProject(db, projectId, user);
  if (!project) throw httpError(404, "PROJECT_NOT_FOUND");
  if (project.permission !== "owner") {
    throw httpError(403, "PROJECT_OWNER_ONLY");
  }
  return project;
}

/** Operations such as ownership transfer require the actual stored owner. */
export async function requireActualProjectOwner(db: DatabaseConnection, projectId: string, user: UserRow) {
  await requireActiveUser(db, user);
  const project = await accessibleProject(db, projectId, user);
  if (!project) throw httpError(404, "PROJECT_NOT_FOUND");
  if (project.owner_id !== user.id) {
    throw httpError(403, "PROJECT_OWNER_ONLY");
  }
  return project;
}

export function projectTextSnapshot(config: Config, projectId: string): Map<string, string> {
  return new Map(listProjectFiles(config, projectId).filter((entry) => entry.type === "file" && isCollaborativeTextFile(entry.path)).map((entry) => {
    const absolute = resolveSourcePath(config, projectId, entry.path);
    return [entry.path, fs.statSync(absolute).size <= maxCollaborativeFileBytes(config) ? fs.readFileSync(absolute, "utf8") : ""] as const;
  }));
}

export async function reanchorProjectSnapshot(db: DatabaseConnection, projectId: string, before: Map<string, string>, after: Map<string, string>): Promise<void> {
  for (const filePath of new Set([...before.keys(), ...after.keys()])) {
    await reanchorFileComments(db, projectId, filePath, before.get(filePath) ?? "", after.get(filePath) ?? "");
  }
}

export function movedProjectPath(value: string | null, source: string, destination: string): string | null {
  if (value === null) return null;
  if (value === source) return destination;
  return value.startsWith(`${source}/`) ? `${destination}${value.slice(source.length)}` : value;
}

interface CommentRow {
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

export async function repliesForComment(db: DatabaseConnection, commentId: string) {
  const rows = await db.comments.listReplies(commentId);
  return rows.map((reply) => ({
    id: reply.id,
    authorId: reply.author_id,
    authorUsername: reply.author_username,
    authorDisplayName: reply.author_display_name,
    content: reply.content,
    createdAt: reply.created_at,
    updatedAt: reply.updated_at,
    editedAt: reply.edited_at
  }));
}

async function commentsForScope(db: DatabaseConnection, config: Config, projectId: string, filePath?: string) {
  // File-scoped reads retain chronological order for backwards compatibility.
  // A project review is grouped by file and source position so next/previous
  // follows the manuscript rather than arbitrary database insertion order.
  const rows = await db.comments.listComments(projectId, filePath);
  if (!rows.length) return [];

  const sourceByPath = new Map<string, string>();
  for (const row of rows) {
    if (sourceByPath.has(row.file_path)) continue;
    const absolute = resolveSourcePath(config, projectId, row.file_path);
    sourceByPath.set(row.file_path, fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : "");
  }

  const replies = await db.comments.listRepliesForProject(projectId, filePath);

  const replyMap = new Map<string, Array<{
    id: string;
    authorId: string | null;
    authorUsername: string | null;
    authorDisplayName: string | null;
    content: string;
    createdAt: string;
    updatedAt: string;
    editedAt: string | null;
  }>>();

  for (const reply of replies) {
    const list = replyMap.get(reply.comment_id) ?? [];
    list.push({
      id: reply.id,
      authorId: reply.author_id,
      authorUsername: reply.author_username,
      authorDisplayName: reply.author_display_name,
      content: reply.content,
      createdAt: reply.created_at,
      updatedAt: reply.updated_at,
      editedAt: reply.edited_at
    });
    replyMap.set(reply.comment_id, list);
  }

  return rows.map((comment) => ({
    id: comment.id,
    filePath: comment.file_path,
    authorId: comment.author_id,
    authorUsername: comment.author_username,
    authorDisplayName: comment.author_display_name,
    selectedText: comment.selected_text,
    startOffset: comment.start_offset,
    endOffset: comment.end_offset,
    startLine: offsetToLine(sourceByPath.get(comment.file_path) ?? "", comment.start_offset),
    endLine: offsetToLine(sourceByPath.get(comment.file_path) ?? "", comment.end_offset),
    content: comment.content,
    resolved: Boolean(comment.resolved),
    orphaned: Boolean(comment.orphaned),
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    editedAt: comment.edited_at,
    replies: replyMap.get(comment.id) ?? []
  }));
}

/** Comments anchored in one source file, used for editor decorations. */
export async function commentsForFile(db: DatabaseConnection, config: Config, projectId: string, filePath: string) {
  return await commentsForScope(db, config, projectId, filePath);
}

/** All project comments, grouped in manuscript order for the review drawer. */
export async function commentsForProject(db: DatabaseConnection, config: Config, projectId: string) {
  return await commentsForScope(db, config, projectId);
}
