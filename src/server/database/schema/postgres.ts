import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex
} from "drizzle-orm/pg-core";

/**
 * PostgreSQL schema for the current TexLite data model.
 *
 * IDs and timestamps intentionally remain text: ISO-8601 timestamps sort
 * correctly, while several security-sensitive identifiers (such as session
 * digests) are not UUIDs. Boolean-like fields use checked 0/1 integers so the
 * repository layer can expose one stable domain model to HTTP handlers.
 */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  email: text("email"),
  nuwaxSubject: text("nuwax_subject"),
  avatarUrl: text("avatar_url"),
  role: text("role").notNull(),
  disabled: integer("disabled").notNull().default(0),
  mustChangePassword: integer("must_change_password").notNull().default(0),
  canCreateProjects: integer("can_create_projects").notNull().default(0),
  createdAt: text("created_at").notNull()
}, (table) => [
  uniqueIndex("users_username_ci_unique").on(sql`lower(${table.username})`),
  uniqueIndex("users_email_ci_unique").on(sql`lower(${table.email})`).where(sql`${table.email} IS NOT NULL`),
  uniqueIndex("users_nuwax_subject_unique").on(table.nuwaxSubject).where(sql`${table.nuwaxSubject} IS NOT NULL`),
  check("users_role_check", sql`${table.role} IN ('admin', 'user')`),
  check("users_disabled_check", sql`${table.disabled} IN (0, 1)`),
  check("users_must_change_password_check", sql`${table.mustChangePassword} IN (0, 1)`),
  check("users_can_create_projects_check", sql`${table.canCreateProjects} IN (0, 1)`)
]);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [
  index("sessions_user_id").on(table.userId),
  index("sessions_expires_at").on(table.expiresAt)
]);

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  lastModifiedBy: text("last_modified_by").references(() => users.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  mainFile: text("main_file").notNull().default("main.tex"),
  engine: text("engine").notNull().default("xelatex"),
  icon: text("icon"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [
  index("projects_owner_id").on(table.ownerId),
  check("projects_engine_check", sql`${table.engine} IN ('pdflatex', 'xelatex', 'lualatex')`)
]);

export const tags = pgTable("tags", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  color: text("color").notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [
  uniqueIndex("tags_name_ci_unique").on(sql`lower(${table.name})`),
  check("tags_color_check", sql`${table.color} IN ('red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray')`)
]);

export const projectTagLinks = pgTable("project_tag_links", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  tagId: text("tag_id").notNull().references(() => tags.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull()
}, (table) => [
  primaryKey({ columns: [table.projectId, table.tagId] }),
  index("project_tag_links_tag_id").on(table.tagId)
]);

export const userTags = pgTable("user_tags", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [
  uniqueIndex("user_tags_user_name_ci_unique").on(table.userId, sql`lower(${table.name})`),
  index("user_tags_user_id").on(table.userId),
  check("user_tags_color_check", sql`${table.color} IN ('red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray')`)
]);

export const userProjectTagLinks = pgTable("user_project_tag_links", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  tagId: text("tag_id").notNull().references(() => userTags.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull()
}, (table) => [
  primaryKey({ columns: [table.projectId, table.tagId] }),
  index("user_project_tag_links_tag_id").on(table.tagId)
]);

export const userProjectArchives = pgTable("user_project_archives", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  archivedAt: text("archived_at").notNull()
}, (table) => [
  primaryKey({ columns: [table.userId, table.projectId] }),
  index("user_project_archives_project_id").on(table.projectId)
]);

export const projectMembers = pgTable("project_members", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  permission: text("permission").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [
  primaryKey({ columns: [table.projectId, table.userId] }),
  check("project_members_permission_check", sql`${table.permission} IN ('read', 'edit')`)
]);

export const comments = pgTable("comments", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  filePath: text("file_path").notNull(),
  authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
  selectedText: text("selected_text").notNull().default(""),
  startOffset: integer("start_offset").notNull().default(0),
  endOffset: integer("end_offset").notNull().default(0),
  contextBefore: text("context_before").notNull().default(""),
  contextAfter: text("context_after").notNull().default(""),
  orphaned: integer("orphaned").notNull().default(0),
  startLine: integer("start_line").notNull().default(1),
  endLine: integer("end_line").notNull().default(1),
  content: text("content").notNull(),
  resolved: integer("resolved").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  editedAt: text("edited_at")
}, (table) => [
  index("comments_project_file").on(table.projectId, table.filePath),
  index("comments_project_resolved").on(table.projectId, table.resolved),
  check("comments_orphaned_check", sql`${table.orphaned} IN (0, 1)`),
  check("comments_resolved_check", sql`${table.resolved} IN (0, 1)`)
]);

export const commentReplies = pgTable("comment_replies", {
  id: text("id").primaryKey(),
  commentId: text("comment_id").notNull().references(() => comments.id, { onDelete: "cascade" }),
  authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  editedAt: text("edited_at")
}, (table) => [
  index("comment_replies_comment_id").on(table.commentId, table.createdAt)
]);

export const commentMentions = pgTable("comment_mentions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  commentId: text("comment_id").notNull().references(() => comments.id, { onDelete: "cascade" }),
  replyId: text("reply_id").references(() => commentReplies.id, { onDelete: "cascade" }),
  mentionedUserId: text("mentioned_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  mentionedByUserId: text("mentioned_by_user_id").references(() => users.id, { onDelete: "set null" }),
  readAt: text("read_at"),
  readReason: text("read_reason"),
  createdAt: text("created_at").notNull()
}, (table) => [
  index("comment_mentions_receiver_unread").on(table.mentionedUserId, table.projectId, table.createdAt).where(sql`${table.readAt} IS NULL`),
  index("comment_mentions_comment_id").on(table.commentId),
  uniqueIndex("comment_mentions_source_recipient").on(table.commentId, sql`coalesce(${table.replyId}, '')`, table.mentionedUserId),
  check("comment_mentions_read_reason_check", sql`${table.readReason} IN ('opened', 'resolved', 'manual')`)
]);

export const compileRuns = pgTable("compile_runs", {
  /** Explicit identity used for stable tie-breaking in ordered results. */
  rowid: integer("rowid").generatedAlwaysAsIdentity(),
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  requestedBy: text("requested_by").references(() => users.id, { onDelete: "set null" }),
  mainFile: text("main_file").notNull().default(""),
  status: text("status").notNull(),
  log: text("log").notNull().default(""),
  createdAt: text("created_at").notNull(),
  finishedAt: text("finished_at")
}, (table) => [
  index("compile_runs_project_created").on(table.projectId, table.createdAt),
  index("compile_runs_project_main_created").on(table.projectId, table.mainFile, table.createdAt),
  check("compile_runs_status_check", sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed')`)
]);

export const projectHistoryVersions = pgTable("project_history_versions", {
  /** Explicit identity used for stable cursor ordering. */
  rowid: integer("rowid").generatedAlwaysAsIdentity(),
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
  reason: text("reason").notNull(),
  label: text("label"),
  manifestJson: text("manifest_json").notNull(),
  changedPathsJson: text("changed_paths_json").notNull().default("[]"),
  createdAt: text("created_at").notNull()
}, (table) => [
  index("project_history_versions_project_created").on(table.projectId, table.createdAt),
  check("project_history_versions_reason_check", sql`${table.reason} IN ('initial', 'autosave', 'file', 'settings', 'restore', 'checkpoint')`)
]);

export const projectHistoryState = pgTable("project_history_state", {
  projectId: text("project_id").primaryKey().references(() => projects.id, { onDelete: "cascade" }),
  manifestJson: text("manifest_json").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const projectEditSegments = pgTable("project_edit_segments", {
  /** Explicit identity used for stable retention ordering. */
  rowid: integer("rowid").generatedAlwaysAsIdentity(),
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  filePath: text("file_path").notNull(),
  authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
  kind: text("kind").notNull(),
  beforeHash: text("before_hash").notNull(),
  afterHash: text("after_hash").notNull(),
  stepsJson: text("steps_json").notNull(),
  stepsBytes: integer("steps_bytes").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [
  index("project_edit_segments_project_file_updated").on(table.projectId, table.filePath, table.updatedAt),
  check("project_edit_segments_kind_check", sql`${table.kind} IN ('edit', 'format')`)
]);

export const projectEditHistoryBoundaries = pgTable("project_edit_history_boundaries", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  filePath: text("file_path").notNull(),
  afterHash: text("after_hash").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [
  primaryKey({ columns: [table.projectId, table.filePath] })
]);

export const projectDictionaryWords = pgTable("project_dictionary_words", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  word: text("word").notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull()
}, (table) => [
  primaryKey({ columns: [table.projectId, table.word] }),
  uniqueIndex("project_dictionary_words_project_word_ci_unique").on(table.projectId, sql`lower(${table.word})`),
  index("project_dictionary_words_project_id").on(table.projectId)
]);

export const citationLibraryEntries = pgTable("citation_library_entries", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  citationKey: text("citation_key").notNull(),
  entryType: text("entry_type").notNull(),
  bibtex: text("bibtex").notNull(),
  title: text("title"),
  authors: text("authors"),
  year: text("year"),
  revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [
  uniqueIndex("citation_library_entries_user_key_ci_unique").on(table.userId, sql`lower(${table.citationKey})`),
  index("citation_library_entries_user_updated").on(table.userId, table.updatedAt)
]);

export const citationLibraryTags = pgTable("citation_library_tags", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [
  uniqueIndex("citation_library_tags_user_name_ci_unique").on(table.userId, sql`lower(${table.name})`),
  check("citation_library_tags_color_check", sql`${table.color} IN ('red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray')`)
]);

export const citationLibraryEntryTags = pgTable("citation_library_entry_tags", {
  entryId: text("entry_id").notNull().references(() => citationLibraryEntries.id, { onDelete: "cascade" }),
  tagId: text("tag_id").notNull().references(() => citationLibraryTags.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull()
}, (table) => [
  primaryKey({ columns: [table.entryId, table.tagId] }),
  index("citation_library_entry_tags_tag_id").on(table.tagId)
]);

export const oauthStates = pgTable("oauth_states", {
  id: text("id").primaryKey(),
  returnPath: text("return_path").notNull().default("/"),
  redirectUri: text("redirect_uri").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [index("oauth_states_expires_at").on(table.expiresAt)]);

export const projectInvitations = pgTable("project_invitations", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  recipientUserId: text("recipient_user_id").references(() => users.id, { onDelete: "set null" }),
  email: text("email"),
  permission: text("permission").notNull(),
  invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  respondedAt: text("responded_at")
}, (table) => [
  index("project_invitations_recipient_status").on(table.recipientUserId, table.status, table.createdAt),
  index("project_invitations_email_status").on(table.email, table.status, table.createdAt),
  index("project_invitations_project_status").on(table.projectId, table.status, table.createdAt),
  uniqueIndex("project_invitations_pending_recipient_unique")
    .on(table.projectId, table.recipientUserId)
    .where(sql`${table.status} = 'pending' AND ${table.recipientUserId} IS NOT NULL`),
  uniqueIndex("project_invitations_pending_email_unique")
    .on(table.projectId, sql`lower(${table.email})`)
    .where(sql`${table.status} = 'pending' AND ${table.recipientUserId} IS NULL AND ${table.email} IS NOT NULL`),
  check("project_invitations_permission_check", sql`${table.permission} IN ('read', 'edit')`),
  check("project_invitations_status_check", sql`${table.status} IN ('pending', 'accepted', 'declined', 'revoked')`)
]);

export const authIdentities = pgTable("auth_identities", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  issuer: text("issuer").notNull(),
  subject: text("subject").notNull(),
  providerUsername: text("provider_username"),
  providerEmail: text("provider_email"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [
  uniqueIndex("auth_identities_issuer_subject_unique").on(table.issuer, table.subject),
  index("auth_identities_user_id").on(table.userId),
  index("auth_identities_email_ci").on(sql`lower(${table.providerEmail})`)
]);

export const projectShareLinks = pgTable("project_share_links", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  tokenCiphertext: text("token_ciphertext").notNull(),
  permission: text("permission").notNull().default("read"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull(),
  revokedAt: text("revoked_at")
}, (table) => [
  uniqueIndex("project_share_links_token_hash_unique").on(table.tokenHash),
  index("project_share_links_project_status").on(table.projectId, table.revokedAt, table.createdAt),
  check("project_share_links_permission_check", sql`${table.permission} = 'read'`)
]);

export const projectDirectoryStaging = pgTable("project_directory_staging", {
  projectId: text("project_id").primaryKey(),
  trashName: text("trash_name").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [
  uniqueIndex("project_directory_staging_trash_name_unique").on(table.trashName),
  index("project_directory_staging_created_at").on(table.createdAt)
]);

export const userDeletionStaging = pgTable("user_deletion_staging", {
  userId: text("user_id").primaryKey(),
  originalDisabled: integer("original_disabled").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [
  index("user_deletion_staging_created_at").on(table.createdAt),
  check("user_deletion_staging_original_disabled_check", sql`${table.originalDisabled} IN (0, 1)`)
]);

export const nuwaxOauthTokens = pgTable("nuwax_oauth_tokens", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  accessTokenCiphertext: text("access_token_ciphertext").notNull(),
  accessTokenExpiresAt: text("access_token_expires_at").notNull(),
  refreshTokenCiphertext: text("refresh_token_ciphertext").notNull(),
  scope: text("scope").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});
