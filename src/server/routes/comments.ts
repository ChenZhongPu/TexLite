import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.js";
import { createSourceAnchor, offsetToLine } from "../anchors.js";
import type { CollaborationService } from "../collaboration.js";
import type { Config } from "../config.js";
import type { DatabaseConnection } from "../db.js";
import { resolveSourcePath, safeRelativePath } from "../files.js";
import { apiError, httpError } from "../http.js";
import type { ProjectMutationCoordinator } from "../projectMutations.js";
import { accessibleProject, canComment } from "../projects.js";
import {
  commentMentionForUser,
  commentMentionInserts,
  listCommentMentions,
  markAllCommentMentionsRead,
  markCommentMentionRead,
  mentionableUsersForProject
} from "../commentMentions.js";
import { commentsForFile, commentsForProject, now, repliesForComment, text } from "./projectShared.js";

interface CommentRouteContext {
  config: Config;
  db: DatabaseConnection;
  collaboration: CollaborationService;
  projectMutations: ProjectMutationCoordinator;
}

/** Register source-anchored comments and reply routes. */
export function registerCommentRoutes(app: FastifyInstance, context: CommentRouteContext): void {
  const { config, db, collaboration, projectMutations } = context;

  app.get("/api/projects/:id/mention-candidates", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!(await accessibleProject(db, id, user))) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    // Mentions are intended to notify another participant. Excluding the
    // author avoids offering a no-op self notification in every composer.
    return { users: await mentionableUsersForProject(db, id, user.id) };
  });

  app.get("/api/projects/:id/mentions", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!(await accessibleProject(db, id, user))) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const query = request.query as { unread?: string; limit?: string; path?: string };
    const requestedLimit = Number.parseInt(query.limit ?? "50", 10);
    return {
      mentions: await listCommentMentions(db, id, user.id, {
        unreadOnly: query.unread === "1" || query.unread === "true",
        limit: Number.isFinite(requestedLimit) ? requestedLimit : 50,
        filePath: typeof query.path === "string" && query.path ? safeRelativePath(query.path) : undefined
      })
    };
  });

  app.get("/api/projects/:id/mentions/:mentionId", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id, mentionId } = request.params as { id: string; mentionId: string };
    if (!(await accessibleProject(db, id, user))) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const mention = await commentMentionForUser(db, mentionId, id, user.id);
    if (!mention) return apiError(reply, 404, "MENTION_NOT_FOUND");
    return { mention };
  });

  app.post("/api/projects/:id/mentions/:mentionId/read", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id, mentionId } = request.params as { id: string; mentionId: string };
    if (!(await accessibleProject(db, id, user))) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    if (!(await commentMentionForUser(db, mentionId, id, user.id))) return apiError(reply, 404, "MENTION_NOT_FOUND");
    return { ok: true, changed: await markCommentMentionRead(db, mentionId, user.id, now(), "manual") };
  });

  app.post("/api/projects/:id/mentions/read-all", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!(await accessibleProject(db, id, user))) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    return { ok: true, changed: await markAllCommentMentionsRead(db, id, user.id, now()) };
  });

  app.get("/api/projects/:id/comments", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const { path: filePath, scope } = request.query as { path?: string; scope?: string };
    if (!(await accessibleProject(db, id, user))) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    if (scope !== undefined && scope !== "project") return apiError(reply, 400, "REQUEST_INVALID");
    if (scope === "project" && filePath !== undefined) return apiError(reply, 400, "REQUEST_INVALID");
    const load = scope === "project"
      ? async () => commentsForProject(db, config, id)
      : async () => commentsForFile(db, config, id, safeRelativePath(filePath ?? ""));
    return {
      comments: await projectMutations.runConsistentRead(id, load, {
        preflight: async () => {
          if (!(await accessibleProject(db, id, user))) throw httpError(404, "PROJECT_NOT_FOUND");
        }
      })
    };
  });

  app.post("/api/projects/:id/comments", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = await accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    if (!(await canComment(db, project, user))) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN");
    const body = request.body as Record<string, unknown>;
    const createdAt = now();
    const filePath = safeRelativePath(typeof body.path === "string" ? body.path : "");
    return await projectMutations.runWrite(id, async () => {
      const absolute = resolveSourcePath(config, id, filePath);
      if (!fs.existsSync(absolute)) return apiError(reply, 404, "COMMENT_FILE_NOT_FOUND");
      const source = fs.readFileSync(absolute, "utf8");
      if (!Number.isInteger(body.startOffset) || !Number.isInteger(body.endOffset)) {
        return apiError(reply, 400, "COMMENT_RANGE_INVALID");
      }
      // The browser supplies the exact source revision the user selected.
      // Keep this optional for an already-open client during an upgrade;
      // current clients never bind an annotation to offsets from a different
      // revision.
      if (body.sourceHash !== undefined) {
        if (typeof body.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(body.sourceHash)) {
          return apiError(reply, 400, "REQUEST_INVALID");
        }
        const currentHash = createHash("sha256").update(source, "utf8").digest("hex");
        if (currentHash !== body.sourceHash) return apiError(reply, 409, "COMMENT_SOURCE_CHANGED");
      }
      const anchor = createSourceAnchor(source, Number(body.startOffset), Number(body.endOffset));
      const comment = {
        id: randomUUID(), filePath,
        content: text(body.content, 5000)
      };
      const mentions = await commentMentionInserts(db, {
        projectId: id, commentId: comment.id, authorId: user.id,
        content: comment.content, createdAt
      });
      await db.comments.createComment({
        id: comment.id,
        projectId: id,
        filePath: comment.filePath,
        authorId: user.id,
        selectedText: anchor.selectedText,
        startOffset: anchor.startOffset,
        endOffset: anchor.endOffset,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
        startLine: offsetToLine(source, anchor.startOffset),
        endLine: offsetToLine(source, anchor.endOffset),
        content: comment.content,
        createdAt
      }, mentions);
      const created = (await commentsForFile(db, config, id, filePath)).find((item) => item.id === comment.id);
      collaboration.signalComments(id);
      return reply.code(201).send({ comment: created });
    }, { preflight: async () => {
      const currentProject = await accessibleProject(db, id, user);
      if (!currentProject) throw httpError(404, "PROJECT_NOT_FOUND");
      if (!(await canComment(db, currentProject, user))) throw httpError(403, "PROJECT_EDIT_FORBIDDEN");
    } });
  });

  app.post("/api/projects/:id/comments/:commentId/replies", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id, commentId } = request.params as { id: string; commentId: string };
    const project = await accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    if (!(await canComment(db, project, user))) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN");
    if (!(await db.comments.findComment(id, commentId))) {
      return apiError(reply, 404, "COMMENT_NOT_FOUND");
    }
    const body = request.body as { content?: unknown };
    const createdAt = now();
    const replyId = randomUUID();
    const content = text(body.content, 5000);
    const mentions = await commentMentionInserts(db, {
      projectId: id, commentId, replyId, authorId: user.id, content, createdAt
    });
    await db.comments.createReply({
      id: replyId,
      commentId,
      authorId: user.id,
      content,
      createdAt
    }, mentions);
    const created = (await repliesForComment(db, commentId)).find((item) => item.id === replyId);
    collaboration.signalComments(id);
    return reply.code(201).send({ reply: created });
  });

  app.patch("/api/projects/:id/comments/:commentId", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id, commentId } = request.params as { id: string; commentId: string };
    const project = await accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    if (!(await canComment(db, project, user))) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN");
    const comment = await db.comments.findComment(id, commentId);
    if (!comment) return apiError(reply, 404, "COMMENT_NOT_FOUND");
    const body = request.body as { resolved?: unknown; content?: unknown };
    const changedAt = now();
    let changed = false;
    const content = typeof body.content === "string" ? text(body.content, 5000) : null;
    if (typeof body.content === "string") {
      if (comment.author_id !== user.id) return apiError(reply, 403, "COMMENT_EDIT_FORBIDDEN");
      changed = true;
    }
    if (typeof body.resolved === "boolean") {
      changed = true;
    }
    if (!changed) return apiError(reply, 400, "COMMENT_UPDATE_EMPTY");
    const mentions = content !== null
      ? await commentMentionInserts(db, {
        projectId: id,
        commentId,
        authorId: user.id,
        content,
        previousContent: comment.content,
        createdAt: changedAt
      })
      : [];
    await db.comments.updateComment({
      id: commentId,
      content: content ?? undefined,
      resolved: typeof body.resolved === "boolean" ? body.resolved : undefined,
      updatedAt: changedAt,
      markMentionsResolved: body.resolved === true && !comment.resolved
    }, mentions);
    collaboration.signalComments(id);
    return { ok: true };
  });

  app.delete("/api/projects/:id/comments/:commentId", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id, commentId } = request.params as { id: string; commentId: string };
    const project = await accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    if (!(await canComment(db, project, user))) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN");
    const comment = await db.comments.findComment(id, commentId);
    if (!comment) return apiError(reply, 404, "COMMENT_NOT_FOUND");
    if (comment.author_id !== user.id) return apiError(reply, 403, "COMMENT_DELETE_FORBIDDEN");
    await db.comments.deleteComment(commentId);
    collaboration.signalComments(id);
    return { ok: true };
  });

  app.patch("/api/projects/:id/comments/:commentId/replies/:replyId", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id, commentId, replyId } = request.params as { id: string; commentId: string; replyId: string };
    const project = await accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    if (!(await canComment(db, project, user))) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN");
    const commentReply = await db.comments.findReply(id, commentId, replyId);
    if (!commentReply) return apiError(reply, 404, "REPLY_NOT_FOUND");
    if (commentReply.author_id !== user.id) return apiError(reply, 403, "REPLY_EDIT_FORBIDDEN");
    const body = request.body as { content?: unknown };
    const changedAt = now();
    const content = text(body.content, 5000);
    const mentions = await commentMentionInserts(db, {
      projectId: id, commentId, replyId, authorId: user.id, content, previousContent: commentReply.content, createdAt: changedAt
    });
    await db.comments.updateReply({ id: replyId, content, updatedAt: changedAt }, mentions);
    const updated = (await repliesForComment(db, commentId)).find((item) => item.id === replyId);
    collaboration.signalComments(id);
    return { reply: updated };
  });

  app.delete("/api/projects/:id/comments/:commentId/replies/:replyId", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id, commentId, replyId } = request.params as { id: string; commentId: string; replyId: string };
    const project = await accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    if (!(await canComment(db, project, user))) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN");
    const commentReply = await db.comments.findReply(id, commentId, replyId);
    if (!commentReply) return apiError(reply, 404, "REPLY_NOT_FOUND");
    if (commentReply.author_id !== user.id) return apiError(reply, 403, "REPLY_DELETE_FORBIDDEN");
    await db.comments.deleteReply(replyId);
    collaboration.signalComments(id);
    return { ok: true };
  });
}
