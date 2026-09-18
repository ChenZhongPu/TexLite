import { useEffect, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AtSign, Check, CheckCircle2, Copy, Eye, Link2, Pencil, Reply, RotateCcw, Save, Send, Trash2, UserPlus, Users } from "lucide-react";
import { api } from "../api";
import { ConfirmDialog, Modal } from "../Dialog";
import { errorMessage } from "../errors";
import i18n from "../i18n";
import type { Comment, Project, ProjectInvitation, ProjectShareLink } from "../types";
import { MentionTextarea } from "./MentionTextarea";

function submitOnShortcut(event: ReactKeyboardEvent<HTMLTextAreaElement>, submit: () => Promise<void>): void {
  if (!(event.ctrlKey || event.metaKey) || event.key !== "Enter" || event.nativeEvent.isComposing) return;
  event.preventDefault();
  event.stopPropagation();
  void submit();
}

/**
 * Comment display intentionally treats a whitespace-delimited `@username`
 * token as a visual mention without checking whether that user exists.  This
 * keeps the display rule obvious and preserves ordinary e-mail addresses.
 */
function renderCommentContent(content: string): ReactNode {
  const pattern = /(^|\s)(@[\p{L}\p{N}_.-]+)/gu;
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const match of content.matchAll(pattern)) {
    const start = match.index ?? 0;
    const boundary = match[1];
    const mention = match[2];
    const mentionStart = start + boundary.length;
    if (mentionStart > cursor) nodes.push(content.slice(cursor, mentionStart));
    nodes.push(<span className="comment-inline-mention" key={`${mentionStart}:${mention}`}>{mention}</span>);
    cursor = mentionStart + mention.length;
  }

  if (!nodes.length) return content;
  if (cursor < content.length) nodes.push(content.slice(cursor));
  return nodes;
}

export function CommentThread({
  projectId, comment, currentUserId, unreadCommentMentionId, unreadReplyMentionIds,
  highlightedComment, highlightedReplyId, currentComment, showFilePath, readOnly, onMarkMentionRead, onFocus, onToggle,
  onReply, onEdit, onDelete, onEditReply, onDeleteReply
}: {
  projectId: string;
  comment: Comment;
  currentUserId: string;
  unreadCommentMentionId?: string;
  unreadReplyMentionIds?: ReadonlyMap<string, string>;
  highlightedComment?: boolean;
  highlightedReplyId?: string | null;
  currentComment?: boolean;
  showFilePath?: boolean;
  readOnly?: boolean;
  onMarkMentionRead: (mentionId: string) => Promise<boolean>;
  onFocus: () => void;
  onToggle: () => void;
  onReply: (content: string) => Promise<boolean>;
  onEdit: (content: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  onEditReply: (replyId: string, content: string) => Promise<boolean>;
  onDeleteReply: (replyId: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [replying, setReplying] = useState(false);
  const [replyContent, setReplyContent] = useState("");
  const [editingComment, setEditingComment] = useState(false);
  const [commentContent, setCommentContent] = useState(comment.content);
  const [deleteCommentOpen, setDeleteCommentOpen] = useState(false);
  const [editingReplyId, setEditingReplyId] = useState<string | null>(null);
  const [replyEditContent, setReplyEditContent] = useState("");
  const [deleteReplyId, setDeleteReplyId] = useState<string | null>(null);
  const submitReply = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!replyContent.trim()) return;
    if (await onReply(replyContent)) { setReplyContent(""); setReplying(false); }
  };
  const submitCommentEdit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!commentContent.trim()) return;
    if (await onEdit(commentContent)) setEditingComment(false);
  };
  const submitReplyEdit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!editingReplyId || !replyEditContent.trim()) return;
    if (await onEditReply(editingReplyId, replyEditContent)) setEditingReplyId(null);
  };
  const username = comment.authorUsername;
  const formatTime = (value: string) => new Date(value).toLocaleString(i18n.resolvedLanguage);
  const markRead = async (mentionId: string, event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    await onMarkMentionRead(mentionId);
  };
  return <><article data-comment-id={comment.id} className={`comment-thread${comment.resolved ? " resolved" : ""}${comment.orphaned ? " orphaned" : ""}${highlightedComment ? " mention-target" : ""}${currentComment ? " review-current" : ""}`} onClick={() => { if (!window.getSelection()?.toString()) onFocus(); }}>
    <header className="comment-header"><span className="comment-author"><strong>{comment.authorDisplayName ?? username ?? t("editor.deletedUser")}</strong>{username && <small>@{username}</small>}</span><span className="comment-times"><time dateTime={comment.createdAt} title={new Date(comment.createdAt).toISOString()}>{formatTime(comment.createdAt)}</time>{comment.editedAt && <small>{t("editor.editedAt", { time: formatTime(comment.editedAt) })}</small>}</span></header>
    <div className="comment-location">{comment.orphaned ? t("editor.orphaned") : showFilePath ? t("editor.commentLocation", { path: comment.filePath, line: comment.startLine }) : t("editor.line", { line: comment.startLine })}</div>
    {comment.selectedText && <blockquote className="comment-selected-text">{comment.selectedText}</blockquote>}
    {!readOnly && editingComment ? <form className="comment-reply-form comment-edit-form" onSubmit={(event) => void submitCommentEdit(event)} onClick={(event) => event.stopPropagation()}><MentionTextarea projectId={projectId} autoFocus rows={4} value={commentContent} onChange={setCommentContent} onKeyDown={(event) => submitOnShortcut(event, submitCommentEdit)} /><div><button type="button" onClick={() => setEditingComment(false)}>{t("common.cancel")}</button><button className="primary" type="submit" disabled={!commentContent.trim()}><Save size={13} />{t("editor.saveChanges")}</button></div></form> : <p className="comment-content">{renderCommentContent(comment.content)}</p>}
    {unreadCommentMentionId && <div className="comment-mention"><span><AtSign aria-hidden size={12} />{t("editor.mentionedYou")}</span><button type="button" onClick={(event) => void markRead(unreadCommentMentionId, event)}>{t("editor.markMentionRead")}</button></div>}
    {comment.replies.length > 0 && <div className="comment-replies">{comment.replies.map((reply) => {
      const unreadMentionId = unreadReplyMentionIds?.get(reply.id);
      return <div data-comment-reply-id={reply.id} className={`comment-reply${highlightedReplyId === reply.id ? " mention-target" : ""}`} key={reply.id}><header><span className="comment-author"><strong>{reply.authorDisplayName ?? reply.authorUsername ?? t("editor.deletedUser")}</strong>{reply.authorUsername && <small>@{reply.authorUsername}</small>}</span><span className="comment-times"><time dateTime={reply.createdAt} title={new Date(reply.createdAt).toISOString()}>{formatTime(reply.createdAt)}</time>{reply.editedAt && <small>{t("editor.editedAt", { time: formatTime(reply.editedAt) })}</small>}</span></header>{!readOnly && editingReplyId === reply.id ? <form className="comment-reply-form comment-edit-form" onSubmit={(event) => void submitReplyEdit(event)} onClick={(event) => event.stopPropagation()}><MentionTextarea projectId={projectId} autoFocus rows={3} value={replyEditContent} onChange={setReplyEditContent} onKeyDown={(event) => submitOnShortcut(event, submitReplyEdit)} /><div><button type="button" onClick={() => setEditingReplyId(null)}>{t("common.cancel")}</button><button className="primary" type="submit" disabled={!replyEditContent.trim()}><Save size={13} />{t("editor.saveChanges")}</button></div></form> : <p className="comment-content">{renderCommentContent(reply.content)}</p>}{unreadMentionId && <div className="comment-mention"><span><AtSign aria-hidden size={12} />{t("editor.mentionedYou")}</span><button type="button" onClick={(event) => void markRead(unreadMentionId, event)}>{t("editor.markMentionRead")}</button></div>}{!readOnly && reply.authorId === currentUserId && editingReplyId !== reply.id && <div className="comment-owner-actions"><button title={t("editor.editReply")} aria-label={t("editor.editReply")} onClick={(event) => { event.stopPropagation(); setEditingReplyId(reply.id); setReplyEditContent(reply.content); }}><Pencil size={12} /></button><button className="danger-text" title={t("editor.deleteReply")} aria-label={t("editor.deleteReply")} onClick={(event) => { event.stopPropagation(); setDeleteReplyId(reply.id); }}><Trash2 size={12} /></button></div>}</div>;
    })}</div>}
    {!readOnly && <><div className="comment-actions"><button className="resolve" onClick={(event) => { event.stopPropagation(); onToggle(); }}>{comment.resolved ? <RotateCcw size={13} /> : <CheckCircle2 size={13} />}{comment.resolved ? t("editor.reopen") : t("editor.resolve")}</button><button className="reply-action" onClick={(event) => { event.stopPropagation(); setReplying((current) => !current); }}><Reply size={13} />{t("editor.reply")}</button>{comment.authorId === currentUserId && !editingComment && <span className="comment-owner-actions"><button title={t("editor.editComment")} aria-label={t("editor.editComment")} onClick={(event) => { event.stopPropagation(); setCommentContent(comment.content); setEditingComment(true); }}><Pencil size={13} /></button><button className="danger-text" title={t("editor.deleteComment")} aria-label={t("editor.deleteComment")} onClick={(event) => { event.stopPropagation(); setDeleteCommentOpen(true); }}><Trash2 size={13} /></button></span>}</div>{replying && <form className="comment-reply-form" onSubmit={(event) => void submitReply(event)} onClick={(event) => event.stopPropagation()}><MentionTextarea projectId={projectId} autoFocus rows={3} value={replyContent} placeholder={t("editor.replyPlaceholder")} onChange={setReplyContent} onKeyDown={(event) => submitOnShortcut(event, submitReply)} /><div><button type="button" onClick={() => { setReplying(false); setReplyContent(""); }}>{t("common.cancel")}</button><button className="primary" type="submit" disabled={!replyContent.trim()}><Send size={13} />{t("editor.sendReply")}</button></div></form>}</>}
  </article><ConfirmDialog open={deleteCommentOpen} title={t("editor.deleteCommentTitle")} description={t("editor.deleteCommentDescription", { count: comment.replies.length })} confirmLabel={t("common.delete")} danger onCancel={() => setDeleteCommentOpen(false)} onConfirm={() => void onDelete().then((deleted) => { if (deleted) setDeleteCommentOpen(false); })} /><ConfirmDialog open={Boolean(deleteReplyId)} title={t("editor.deleteReplyTitle")} description={t("editor.deleteReplyDescription")} confirmLabel={t("common.delete")} danger onCancel={() => setDeleteReplyId(null)} onConfirm={() => { if (deleteReplyId) void onDeleteReply(deleteReplyId).then((deleted) => { if (deleted) setDeleteReplyId(null); }); }} /></>;
}

interface ShareMember { id: string; username: string; email: string | null; displayName?: string; permission: "read" | "edit" }

function validInviteEmail(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function ShareDialog({ open, onOpenChange, project, projectId }: {
  open: boolean; onOpenChange: (open: boolean) => void; project: Project; projectId: string;
}) {
  const { t } = useTranslation();
  const [members, setMembers] = useState<ShareMember[]>([]);
  const [invitations, setInvitations] = useState<ProjectInvitation[]>([]);
  const [shareLinks, setShareLinks] = useState<ProjectShareLink[]>([]);
  const [email, setEmail] = useState("");
  const [permission, setPermission] = useState<"read" | "edit">("read");
  const [recipientPreview, setRecipientPreview] = useState<{ username: string; displayName: string; email: string | null } | null>(null);
  const [recipientLookup, setRecipientLookup] = useState(false);
  const [recipientLookupDone, setRecipientLookupDone] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<ShareMember | null>(null);
  const [revokeLinkTarget, setRevokeLinkTarget] = useState<ProjectShareLink | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const canManage = project.permission === "owner";
  const load = async () => {
    try {
      const memberResult = await api<{ members: ShareMember[] }>(`/api/projects/${projectId}/members`);
      setMembers(memberResult.members);
      if (canManage) {
        const [invitationResult, linkResult] = await Promise.all([
          api<{ invitations: ProjectInvitation[] }>(`/api/projects/${projectId}/invitations`),
          api<{ links: ProjectShareLink[] }>(`/api/projects/${projectId}/share-links`)
        ]);
        setInvitations(invitationResult.invitations);
        setShareLinks(linkResult.links);
      } else {
        setInvitations([]);
        setShareLinks([]);
      }
    } catch (error) { setError(errorMessage(error)); }
  };
  useEffect(() => { if (open) void load(); }, [open, projectId, canManage]);
  useEffect(() => {
    const normalizedEmail = email.trim();
    setRecipientPreview(null);
    setRecipientLookupDone(false);
    if (!open || !canManage || !validInviteEmail(normalizedEmail)) {
      setRecipientLookup(false);
      return;
    }
    setRecipientLookup(true);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api<{ user: { username: string; displayName: string; email: string | null } | null }>(
        `/api/projects/${projectId}/invitation-recipient?email=${encodeURIComponent(normalizedEmail)}`,
        { signal: controller.signal }
      ).then((result) => {
        if (controller.signal.aborted) return;
        setRecipientPreview(result.user);
        setRecipientLookupDone(true);
      }).catch((lookupError) => {
        if (!controller.signal.aborted) setError(errorMessage(lookupError));
      }).finally(() => {
        if (!controller.signal.aborted) setRecipientLookup(false);
      });
    }, 280);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [canManage, email, open, projectId]);
  const addInvitation = async () => {
    if (!email.trim()) return;
    try {
      await api(`/api/projects/${projectId}/invitations`, { method: "POST", body: JSON.stringify({ email, permission }) });
      setEmail(""); setPermission("read"); await load();
    } catch (error) { setError(errorMessage(error)); }
  };
  const changePermission = async (member: ShareMember, next: "read" | "edit") => {
    try {
      await api(`/api/projects/${projectId}/members/${member.id}`, { method: "PUT", body: JSON.stringify({ permission: next }) });
      await load();
    } catch (error) { setError(errorMessage(error)); }
  };
  const removeMember = async () => {
    if (!removeTarget) return;
    try {
      await api(`/api/projects/${projectId}/members/${removeTarget.id}`, { method: "DELETE" });
      setRemoveTarget(null); await load();
    } catch (error) { setError(errorMessage(error)); }
  };
  const revokeInvitation = async (invitation: ProjectInvitation) => {
    try {
      await api(`/api/projects/${projectId}/invitations/${invitation.id}`, { method: "DELETE" });
      await load();
    } catch (error) { setError(errorMessage(error)); }
  };
  const createShareLink = async () => {
    setLinkBusy(true);
    setError("");
    try {
      const result = await api<{ link: ProjectShareLink }>(`/api/projects/${projectId}/share-links`, {
        method: "POST", body: JSON.stringify({ permission: "read" })
      });
      setShareLinks((current) => [result.link, ...current.filter((link) => link.id !== result.link.id)]);
    } catch (error) { setError(errorMessage(error)); }
    finally { setLinkBusy(false); }
  };
  const copyShareLink = async (link: ProjectShareLink) => {
    try {
      await navigator.clipboard.writeText(new URL(link.url, window.location.origin).toString());
      setCopiedLinkId(link.id);
      window.setTimeout(() => setCopiedLinkId((current) => current === link.id ? null : current), 1800);
    } catch (copyError) { setError(errorMessage(copyError)); }
  };
  const revokeShareLink = async () => {
    if (!revokeLinkTarget) return;
    try {
      await api(`/api/projects/${projectId}/share-links/${revokeLinkTarget.id}`, { method: "DELETE" });
      setShareLinks((current) => current.filter((link) => link.id !== revokeLinkTarget.id));
      setRevokeLinkTarget(null);
    } catch (error) { setError(errorMessage(error)); }
  };
  return <><Modal open={open} wide title={t("projectSettings.share")} description={t("projectSettings.shareDescription")} onOpenChange={onOpenChange} footer={<button onClick={() => onOpenChange(false)}>{t("common.close")}</button>}>
    <div className="share-dialog">
      {error && <p className="error">{error}</p>}
      <div className="share-owner"><Users size={17} /><span><small>{t("projects.owner")}</small><strong>{project.ownerDisplayName ?? project.ownerUsername}</strong></span></div>
      {canManage && <div className="share-add"><div className="share-invite-email"><label className="form-field">{t("projectSettings.inviteEmail")}<input type="email" value={email} placeholder={t("projectSettings.inviteEmailPlaceholder")} onChange={(event) => setEmail(event.target.value)} /></label>{recipientLookup && <small className="field-hint">{t("projectSettings.recipientLookup")}</small>}{recipientPreview && <span className="share-recipient-preview"><span className="member-avatar">{recipientPreview.displayName.slice(0, 1).toLocaleUpperCase()}</span><span><strong>{recipientPreview.displayName}</strong><small>@{recipientPreview.username} · {recipientPreview.email ?? email.trim()}</small></span></span>}{recipientLookupDone && !recipientLookup && !recipientPreview && <small className="field-hint">{t("projectSettings.recipientNotFound")}</small>}</div><label className="form-field">{t("common.permission")}<select value={permission} onChange={(event) => setPermission(event.target.value as "read" | "edit")}><option value="read">{t("common.readOnly")}</option><option value="edit">{t("common.readWrite")}</option></select></label><button className="primary icon-button" disabled={!email.trim()} onClick={() => void addInvitation()}><UserPlus size={15} />{t("projectSettings.addMember")}</button><small className="field-hint">{t("projectSettings.inviteHint")}</small></div>}
      {canManage && <><div className="shared-members-heading"><strong>{t("projectSettings.pendingInvitations")}</strong><span>{invitations.length}</span></div><div className="shared-members pending-invitations">{invitations.map((invitation) => <div className="shared-member" key={invitation.id}><span className="member-identity"><span className="member-avatar">@</span><span><strong>{invitation.recipientDisplayName ?? invitation.recipientUsername ?? invitation.email}</strong><small>{invitation.recipientUsername ? `@${invitation.recipientUsername} · ${invitation.email}` : invitation.email} · {invitation.permission === "edit" ? t("common.readWrite") : t("common.readOnly")}</small></span></span><button className="icon-only danger-text" title={t("common.remove")} aria-label={t("common.remove")} onClick={() => void revokeInvitation(invitation)}><Trash2 size={15} /></button></div>)}{invitations.length === 0 && <div className="share-empty"><span>{t("projectSettings.noPendingInvitations")}</span></div>}</div></>}
      {canManage && <section className="share-links-section"><div className="share-links-heading"><div><strong><Link2 size={15} />{t("projectSettings.shareLinks")}</strong><p>{t("projectSettings.shareLinksDescription")}</p></div></div><button type="button" className="share-link-create" disabled={linkBusy} onClick={() => void createShareLink()}><Eye size={14} />{linkBusy ? t("common.loading") : t("projectSettings.createReadLink")}</button><small className="share-link-note">{t("projectSettings.revokeLinkDescription")}</small><div className="share-links-list">{shareLinks.map((link) => <div className="share-link-row" key={link.id}><span className="share-link-icon"><Eye size={14} /></span><span className="share-link-details"><strong>{t("projectSettings.linkRead")}</strong><input className="share-link-url" aria-label={t("projectSettings.linkRead")} readOnly value={new URL(link.url, window.location.origin).toString()} onFocus={(event) => event.currentTarget.select()} /><small>{new Date(link.createdAt).toLocaleString(i18n.resolvedLanguage)}</small></span><span className="share-link-actions"><button type="button" className="icon-only" title={copiedLinkId === link.id ? t("projectSettings.copiedLink") : t("projectSettings.copyLink")} aria-label={copiedLinkId === link.id ? t("projectSettings.copiedLink") : t("projectSettings.copyLink")} onClick={() => void copyShareLink(link)}>{copiedLinkId === link.id ? <Check size={15} /> : <Copy size={15} />}</button><button type="button" className="icon-only danger-text" title={t("projectSettings.revokeLink")} aria-label={t("projectSettings.revokeLink")} onClick={() => setRevokeLinkTarget(link)}><Trash2 size={15} /></button></span></div>)}{shareLinks.length === 0 && <div className="share-empty"><Link2 size={22} /><span>{t("projectSettings.noShareLinks")}</span></div>}</div></section>}
      <div className="shared-members-heading"><strong>{t("projectSettings.members")}</strong><span>{members.length}</span></div>
      <div className="shared-members">{members.map((member) => <div className="shared-member" key={member.id}><span className="member-identity"><span className="member-avatar">{(member.displayName ?? member.username).slice(0, 1).toLocaleUpperCase()}</span><span><strong>{member.displayName ?? member.username}</strong><small>{member.email ?? `@${member.username}`}</small></span></span><span className="member-controls"><select aria-label={t("common.permission")} disabled={!canManage} value={member.permission} onChange={(event) => void changePermission(member, event.target.value as "read" | "edit")}><option value="read">{t("common.readOnly")}</option><option value="edit">{t("common.readWrite")}</option></select>{canManage && <button className="icon-only danger-text" title={t("common.remove")} aria-label={t("common.remove")} onClick={() => setRemoveTarget(member)}><Trash2 size={15} /></button>}</span></div>)}{members.length === 0 && <div className="share-empty"><Users size={24} /><span>{t("projectSettings.noMembers")}</span></div>}</div>
    </div>
  </Modal><ConfirmDialog open={Boolean(removeTarget)} title={t("projectSettings.removeTitle")} description={t("projectSettings.removeDescription", { username: removeTarget?.username ?? "" })} confirmLabel={t("common.remove")} danger onCancel={() => setRemoveTarget(null)} onConfirm={() => void removeMember()} /><ConfirmDialog open={Boolean(revokeLinkTarget)} title={t("projectSettings.revokeLinkTitle")} description={t("projectSettings.revokeLinkDescription")} confirmLabel={t("projectSettings.revokeLink")} danger onCancel={() => setRevokeLinkTarget(null)} onConfirm={() => void revokeShareLink()} /></>;
}
