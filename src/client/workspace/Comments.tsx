import { useEffect, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, AtSign, Check, CheckCircle2, Copy, Eye, Link2, LoaderCircle, LockKeyhole, Pencil, Phone, Reply, RotateCcw, Save, Search, Send, Trash2, UserPlus, Users, X } from "lucide-react";
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
type RecipientProjectStatus = "member" | "pending" | null;

interface RecipientPreview {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string | null;
  projectStatus: RecipientProjectStatus;
}

function normalizeInvitePhone(value: string): string {
  const compact = value.trim().replace(/[\s()-]/g, "");
  const local = compact.startsWith("+86") ? compact.slice(3) : compact;
  return local.replace(/\D/g, "").slice(0, 11);
}

function validInvitePhone(value: string): boolean {
  return /^[0-9]{11}$/.test(normalizeInvitePhone(value));
}

function maskInvitePhone(value: string): string {
  const normalized = normalizeInvitePhone(value);
  const countryCode = normalized.startsWith("+86") ? "+86 " : "";
  const local = countryCode ? normalized.slice(3) : normalized;
  if (local.length < 7) return normalized;
  return `${countryCode}${local.slice(0, 3)}****${local.slice(-4)}`;
}

export function ShareDialog({ open, onOpenChange, project, projectId }: {
  open: boolean; onOpenChange: (open: boolean) => void; project: Project; projectId: string;
}) {
  const { t } = useTranslation();
  const [members, setMembers] = useState<ShareMember[]>([]);
  const [invitations, setInvitations] = useState<ProjectInvitation[]>([]);
  const [shareLinks, setShareLinks] = useState<ProjectShareLink[]>([]);
  const [phone, setPhone] = useState("");
  const [permission, setPermission] = useState<"read" | "edit">("read");
  const [recipientPreview, setRecipientPreview] = useState<RecipientPreview | null>(null);
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
  const lookupRecipient = async () => {
    const normalizedPhone = normalizeInvitePhone(phone);
    if (!validInvitePhone(normalizedPhone) || recipientLookup) return;
    setRecipientLookup(true);
    setRecipientLookupDone(false);
    setRecipientPreview(null);
    setError("");
    try {
      const result = await api<{ user: Omit<RecipientPreview, "projectStatus"> & { projectStatus?: RecipientProjectStatus } | null }>(
        `/api/projects/${projectId}/invitation-recipient`,
        { method: "POST", body: JSON.stringify({ phone: normalizedPhone }) }
      );
      setRecipientPreview(result.user ? { ...result.user, projectStatus: result.user.projectStatus ?? null } : null);
      setRecipientLookupDone(true);
    } catch (lookupError) {
      setError(errorMessage(lookupError));
    } finally {
      setRecipientLookup(false);
    }
  };
  const clearPhone = () => {
    setPhone("");
    setRecipientPreview(null);
    setRecipientLookupDone(false);
    setError("");
  };
  const addInvitation = async () => {
    const normalizedPhone = normalizeInvitePhone(phone);
    if (!recipientPreview || recipientPreview.projectStatus || !validInvitePhone(normalizedPhone)) return;
    try {
      await api(`/api/projects/${projectId}/invitations`, { method: "POST", body: JSON.stringify({ phone: normalizedPhone, permission }) });
      setPhone(""); setRecipientPreview(null); setRecipientLookupDone(false); setPermission("read"); await load();
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
  const phoneInvalid = Boolean(phone.trim()) && !validInvitePhone(phone);
  const canSendInvitation = Boolean(recipientPreview && recipientPreview.projectStatus === null);
  return <><Modal open={open} wide title={t("projectSettings.share")} description={t("projectSettings.shareDescription")} onOpenChange={onOpenChange} footer={<button onClick={() => onOpenChange(false)}>{t("common.close")}</button>}>
    <div className="share-dialog">
      {error && <p className="error">{error}</p>}
      <div className="share-owner"><Users size={17} /><span><small>{t("projects.owner")}</small><strong>{project.ownerDisplayName ?? project.ownerUsername}</strong></span></div>
      {canManage && <section className="share-invite-section">
        <div className="share-section-heading"><div><strong><UserPlus size={16} />{t("projectSettings.inviteSectionTitle")}</strong><p>{t("projectSettings.inviteSectionDescription")}</p></div></div>
        <div className="share-invite-form">
          <div className="form-field share-phone-field"><label htmlFor="share-invite-phone">{t("projectSettings.invitePhone")}</label><div className="share-phone-control-row"><span className={`share-phone-input${phoneInvalid ? " invalid" : ""}`}><Phone size={15} aria-hidden /><span className="share-phone-country">+86</span><input id="share-invite-phone" type="tel" value={phone} placeholder={t("projectSettings.invitePhonePlaceholder")} inputMode="numeric" autoComplete="tel" maxLength={11} pattern="[0-9]{11}" aria-invalid={phoneInvalid} aria-describedby={phoneInvalid ? "share-phone-hint share-phone-invalid" : "share-phone-hint"} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void lookupRecipient(); } }} onChange={(event) => { setPhone(normalizeInvitePhone(event.target.value)); setRecipientPreview(null); setRecipientLookupDone(false); }} />{phone && <button type="button" className="share-phone-clear" title={t("projectSettings.clearPhone")} aria-label={t("projectSettings.clearPhone")} onClick={clearPhone}><X size={14} /></button>}</span><button type="button" className={`share-lookup-button${recipientLookup ? " is-loading" : ""}`} aria-busy={recipientLookup} disabled={phoneInvalid || phone.length !== 11 || recipientLookup} onClick={() => void lookupRecipient()}>{recipientLookup ? <LoaderCircle className="spin" size={15} /> : <Search size={15} />}{recipientLookup ? t("common.loading") : t("projectSettings.findRecipient")}</button></div><small id="share-phone-hint" className="share-invite-hint"><LockKeyhole size={12} aria-hidden /><span>{t("projectSettings.invitePhoneHint")}</span></small>{phoneInvalid && <small id="share-phone-invalid" className="share-phone-validation" role="alert">{t("projectSettings.invitePhoneInvalid")}</small>}</div>
        </div>
        {recipientLookup && <div className="share-lookup-status" role="status" aria-live="polite"><LoaderCircle className="spin" size={14} />{t("common.loading")}</div>}
        {recipientLookupDone && !recipientLookup && !recipientPreview && <div className="share-lookup-empty" role="status"><AlertCircle size={15} aria-hidden /><span>{t("projectSettings.recipientNotFound")}</span></div>}
        {recipientPreview && <section className={`share-recipient-card${recipientPreview.projectStatus ? ` is-${recipientPreview.projectStatus}` : ""}`} role="status" aria-live="polite">
          <div className="share-recipient-summary"><span className="member-avatar share-recipient-avatar">{recipientPreview.avatarUrl ? <img src={recipientPreview.avatarUrl} alt="" /> : recipientPreview.displayName.slice(0, 1).toLocaleUpperCase()}</span><span className="share-recipient-details"><strong>{recipientPreview.displayName}</strong><small>@{recipientPreview.username}</small><small>{maskInvitePhone(phone)}</small></span><span className="share-recipient-found">{recipientPreview.projectStatus === "pending" ? <Send size={14} /> : <CheckCircle2 size={14} />}{recipientPreview.projectStatus === "member" ? t("projectSettings.recipientAlreadyMember") : recipientPreview.projectStatus === "pending" ? t("projectSettings.recipientInvitationPending") : t("projectSettings.recipientFound")}</span></div>
          {recipientPreview.projectStatus === "member" && <div className="share-recipient-message"><CheckCircle2 size={15} /><span>{t("projectSettings.recipientAlreadyMemberHint")}</span></div>}
          {recipientPreview.projectStatus === "pending" && <div className="share-recipient-message"><Send size={15} /><span>{t("projectSettings.recipientInvitationPendingHint")}</span></div>}
          {canSendInvitation && <>
            <div className="share-invite-options"><div className="share-permission-field"><span>{t("projectSettings.permissionAfterAccept")}</span><small>{t("projectSettings.permissionAfterAcceptHint")}</small></div><div className="share-permission-options" role="radiogroup" aria-label={t("common.permission")}><button type="button" role="radio" aria-checked={permission === "read"} className={permission === "read" ? "active" : ""} onClick={() => setPermission("read")}><Eye size={14} /><span><strong>{t("common.readOnly")}</strong><small>{t("projectSettings.readPermissionHint")}</small></span></button><button type="button" role="radio" aria-checked={permission === "edit"} className={permission === "edit" ? "active" : ""} onClick={() => setPermission("edit")}><Pencil size={14} /><span><strong>{t("common.readWrite")}</strong><small>{t("projectSettings.editPermissionHint")}</small></span></button></div></div>
            <div className="share-recipient-card-footer"><button className="primary share-invite-submit" onClick={() => void addInvitation()}><Send size={14} />{t("projectSettings.addMember")}</button></div>
          </>}
        </section>}
      </section>}
      <div className="shared-members-heading"><strong>{t("projectSettings.members")}</strong><span>{members.length}</span></div>
      <div className="shared-members">{members.map((member) => <div className="shared-member" key={member.id}><span className="member-identity"><span className="member-avatar">{(member.displayName ?? member.username).slice(0, 1).toLocaleUpperCase()}</span><span><strong>{member.displayName ?? member.username}</strong><small>{member.email ?? `@${member.username}`}</small></span></span><span className="member-controls"><select aria-label={t("common.permission")} disabled={!canManage} value={member.permission} onChange={(event) => void changePermission(member, event.target.value as "read" | "edit")}><option value="read">{t("common.readOnly")}</option><option value="edit">{t("common.readWrite")}</option></select>{canManage && <button className="icon-only danger-text" title={t("common.remove")} aria-label={t("common.remove")} onClick={() => setRemoveTarget(member)}><Trash2 size={15} /></button>}</span></div>)}{members.length === 0 && <div className="share-empty"><Users size={24} /><span>{t("projectSettings.noMembers")}</span></div>}</div>
      {canManage && <section className="share-links-section"><div className="share-links-heading"><div><strong><Link2 size={15} />{t("projectSettings.shareLinks")}</strong><p>{t("projectSettings.shareLinksDescription")}</p></div></div><button type="button" className="share-link-create" disabled={linkBusy} onClick={() => void createShareLink()}><Eye size={14} />{linkBusy ? t("common.loading") : t("projectSettings.createReadLink")}</button><small className="share-link-note">{t("projectSettings.revokeLinkDescription")}</small><div className="share-links-list">{shareLinks.map((link) => <div className="share-link-row" key={link.id}><span className="share-link-icon"><Eye size={14} /></span><span className="share-link-details"><strong>{t("projectSettings.linkRead")}</strong><input className="share-link-url" aria-label={t("projectSettings.linkRead")} readOnly value={new URL(link.url, window.location.origin).toString()} onFocus={(event) => event.currentTarget.select()} /><small>{new Date(link.createdAt).toLocaleString(i18n.resolvedLanguage)}</small></span><span className="share-link-actions"><button type="button" className="icon-only" title={copiedLinkId === link.id ? t("projectSettings.copiedLink") : t("projectSettings.copyLink")} aria-label={copiedLinkId === link.id ? t("projectSettings.copiedLink") : t("projectSettings.copyLink")} onClick={() => void copyShareLink(link)}>{copiedLinkId === link.id ? <Check size={15} /> : <Copy size={15} />}</button><button type="button" className="icon-only danger-text" title={t("projectSettings.revokeLink")} aria-label={t("projectSettings.revokeLink")} onClick={() => setRevokeLinkTarget(link)}><Trash2 size={15} /></button></span></div>)}{shareLinks.length === 0 && <div className="share-empty"><Link2 size={22} /><span>{t("projectSettings.noShareLinks")}</span></div>}</div></section>}
      {canManage && <><div className="shared-members-heading"><strong>{t("projectSettings.pendingInvitations")}</strong><span>{invitations.length}</span></div><div className="shared-members pending-invitations">{invitations.map((invitation) => <div className="shared-member" key={invitation.id}><span className="member-identity"><span className="member-avatar">@</span><span><strong>{invitation.recipientDisplayName ?? invitation.recipientUsername ?? t("projectSettings.pendingRecipient")}</strong><small>{invitation.recipientUsername ? `@${invitation.recipientUsername}` : t("projectSettings.pendingRecipient")} · {invitation.permission === "edit" ? t("common.readWrite") : t("common.readOnly")}</small></span></span><button className="icon-only danger-text" title={t("common.remove")} aria-label={t("common.remove")} onClick={() => void revokeInvitation(invitation)}><Trash2 size={15} /></button></div>)}{invitations.length === 0 && <div className="share-empty"><span>{t("projectSettings.noPendingInvitations")}</span></div>}</div></>}
    </div>
  </Modal><ConfirmDialog open={Boolean(removeTarget)} title={t("projectSettings.removeTitle")} description={t("projectSettings.removeDescription", { username: removeTarget?.username ?? "" })} confirmLabel={t("common.remove")} danger onCancel={() => setRemoveTarget(null)} onConfirm={() => void removeMember()} /><ConfirmDialog open={Boolean(revokeLinkTarget)} title={t("projectSettings.revokeLinkTitle")} description={t("projectSettings.revokeLinkDescription")} confirmLabel={t("projectSettings.revokeLink")} danger onCancel={() => setRevokeLinkTarget(null)} onConfirm={() => void revokeShareLink()} /></>;
}
