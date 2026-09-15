import { describe, expect, it } from "vitest";
import {
  adjacentReviewComment,
  buildVisibleReviewQueue,
  commentsForEditorFile,
  commentReviewPosition,
  filterCommentsForReview,
  focusCommentForEditorFile,
  resolvePendingCommentFocus,
  shouldRevealAfterCommentToggle
} from "../src/client/workspace/commentNavigation.js";
import type { Comment, CommentMention } from "../src/client/types.js";

function comment(id: string, filePath: string, resolved = false): Comment {
  return {
    id, filePath, authorId: "author", authorUsername: "author", authorDisplayName: "Author",
    selectedText: id, startOffset: 0, endOffset: id.length, startLine: 1, endLine: 1,
    content: id, resolved, orphaned: false, createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z", editedAt: null, replies: []
  };
}

function mention(commentId: string, replyId: string | null = null): CommentMention {
  return {
    id: `mention-${commentId}-${replyId ?? "root"}`, projectId: "project", commentId, replyId,
    filePath: "main.tex", content: "@reader", resolved: false,
    createdAt: "2026-01-01T00:00:00.000Z", readAt: null, readReason: null
  };
}

describe("comment review navigation", () => {
  const comments = [
    comment("main-open", "main.tex"),
    comment("chapter-open", "chapters/intro.tex"),
    comment("chapter-resolved", "chapters/intro.tex", true)
  ];

  it("filters file and project review queues by status", () => {
    expect(filterCommentsForReview(comments, {
      activeFile: "main.tex", scope: "file", filter: "unresolved", unreadMentions: []
    }).map((item) => item.id)).toEqual(["main-open"]);
    expect(filterCommentsForReview(comments, {
      activeFile: "main.tex", scope: "project", filter: "unresolved", unreadMentions: []
    }).map((item) => item.id)).toEqual(["main-open", "chapter-open"]);
    expect(filterCommentsForReview(comments, {
      activeFile: "main.tex", scope: "project", filter: "resolved", unreadMentions: []
    }).map((item) => item.id)).toEqual(["chapter-resolved"]);
  });

  it("treats root and reply notifications as one unread @-me thread", () => {
    expect(filterCommentsForReview(comments, {
      activeFile: "main.tex", scope: "project", filter: "mentions",
      unreadMentions: [mention("chapter-open", "reply-1"), mention("main-open")]
    }).map((item) => item.id)).toEqual(["main-open", "chapter-open"]);
    expect(filterCommentsForReview(comments, {
      activeFile: "main.tex", scope: "project", filter: "mentions", unreadMentions: []
    })).toEqual([]);
  });

  it("moves through the visible queue without wrapping", () => {
    const visible = comments.slice(0, 2);
    expect(commentReviewPosition(visible, "chapter-open")).toBe(2);
    expect(commentReviewPosition(visible, "removed")).toBe(0);
    expect(adjacentReviewComment(visible, "main-open", 1)?.id).toBe("chapter-open");
    expect(adjacentReviewComment(visible, "chapter-open", 1)).toBeNull();
    expect(adjacentReviewComment(visible, "main-open", -1)).toBeNull();
    expect(adjacentReviewComment(visible, "removed", 1)?.id).toBe("main-open");
    expect(adjacentReviewComment(visible, "removed", -1)).toBeNull();
  });

  it("keeps an explicitly opened thread visible without weakening ordinary filters", () => {
    const unresolvedOptions = {
      activeFile: "main.tex", scope: "project" as const, filter: "unresolved" as const, unreadMentions: []
    };
    expect(buildVisibleReviewQueue(comments, unresolvedOptions).map((item) => item.id))
      .toEqual(["main-open", "chapter-open"]);
    expect(buildVisibleReviewQueue(comments, unresolvedOptions, ["chapter-resolved"]).map((item) => item.id))
      .toEqual(["main-open", "chapter-open", "chapter-resolved"]);
    expect(buildVisibleReviewQueue(comments, {
      ...unresolvedOptions, scope: "file"
    }, ["chapter-resolved"]).map((item) => item.id)).toEqual(["main-open"]);
  });

  it("reveals a resolved thread with a fresh @ reply and retains a resolved current item until navigation", () => {
    const options = {
      activeFile: "main.tex", scope: "project" as const, filter: "unresolved" as const,
      unreadMentions: [mention("chapter-resolved", "new-reply")]
    };
    expect(buildVisibleReviewQueue(comments, options, ["chapter-resolved"]).map((item) => item.id))
      .toEqual(["main-open", "chapter-open", "chapter-resolved"]);

    const resolvedCurrent = { ...comments[1], resolved: true };
    const later = comment("later-open", "chapters/intro.tex");
    const queue = buildVisibleReviewQueue([comments[0], resolvedCurrent, later], options, [resolvedCurrent.id]);
    expect(shouldRevealAfterCommentToggle(comments[1], "unresolved", [])).toBe(true);
    expect(commentReviewPosition(queue, resolvedCurrent.id)).toBe(2);
    expect(adjacentReviewComment(queue, resolvedCurrent.id, 1)?.id).toBe("later-open");
  });

  it("does not give a newly mounted editor offsets from another file", () => {
    const target = comments[1];
    expect(commentsForEditorFile(comments, "main.tex").map((item) => item.id)).toEqual(["main-open"]);
    expect(focusCommentForEditorFile(target, "main.tex", "main.tex")).toBeNull();
    expect(focusCommentForEditorFile(target, "chapters/intro.tex", "main.tex")).toBeNull();
    expect(focusCommentForEditorFile(target, "chapters/intro.tex", "chapters/intro.tex")).toBe(target);
    expect(resolvePendingCommentFocus(target, "chapters/intro.tex", "chapters/intro.tex", "chapters/intro.tex", true, [target])).toBe(target);
    expect(resolvePendingCommentFocus(target, "chapters/intro.tex", "main.tex", "chapters/intro.tex", true, [target])).toBeNull();
    expect(resolvePendingCommentFocus(target, "chapters/intro.tex", "chapters/intro.tex", "chapters/intro.tex", false, [target])).toBeNull();
  });
});
