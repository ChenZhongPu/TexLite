CREATE TABLE "auth_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"provider_username" text,
	"provider_email" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "citation_library_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"citation_key" text NOT NULL,
	"entry_type" text NOT NULL,
	"bibtex" text NOT NULL,
	"title" text,
	"authors" text,
	"year" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "citation_library_entry_tags" (
	"entry_id" text NOT NULL,
	"tag_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "citation_library_entry_tags_entry_id_tag_id_pk" PRIMARY KEY("entry_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "citation_library_tags" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "citation_library_tags_color_check" CHECK ("citation_library_tags"."color" IN ('red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'))
);
--> statement-breakpoint
CREATE TABLE "comment_mentions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"comment_id" text NOT NULL,
	"reply_id" text,
	"mentioned_user_id" text NOT NULL,
	"mentioned_by_user_id" text,
	"read_at" text,
	"read_reason" text,
	"created_at" text NOT NULL,
	CONSTRAINT "comment_mentions_read_reason_check" CHECK ("comment_mentions"."read_reason" IN ('opened', 'resolved', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "comment_replies" (
	"id" text PRIMARY KEY NOT NULL,
	"comment_id" text NOT NULL,
	"author_id" text,
	"content" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"edited_at" text
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"file_path" text NOT NULL,
	"author_id" text,
	"selected_text" text DEFAULT '' NOT NULL,
	"start_offset" integer DEFAULT 0 NOT NULL,
	"end_offset" integer DEFAULT 0 NOT NULL,
	"context_before" text DEFAULT '' NOT NULL,
	"context_after" text DEFAULT '' NOT NULL,
	"orphaned" integer DEFAULT 0 NOT NULL,
	"start_line" integer DEFAULT 1 NOT NULL,
	"end_line" integer DEFAULT 1 NOT NULL,
	"content" text NOT NULL,
	"resolved" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"edited_at" text,
	CONSTRAINT "comments_orphaned_check" CHECK ("comments"."orphaned" IN (0, 1)),
	CONSTRAINT "comments_resolved_check" CHECK ("comments"."resolved" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE "compile_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"requested_by" text,
	"main_file" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"log" text DEFAULT '' NOT NULL,
	"created_at" text NOT NULL,
	"finished_at" text,
	CONSTRAINT "compile_runs_status_check" CHECK ("compile_runs"."status" IN ('queued', 'running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "nuwax_oauth_tokens" (
	"user_id" text PRIMARY KEY NOT NULL,
	"access_token_ciphertext" text NOT NULL,
	"access_token_expires_at" text NOT NULL,
	"refresh_token_ciphertext" text NOT NULL,
	"scope" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"id" text PRIMARY KEY NOT NULL,
	"return_path" text DEFAULT '/' NOT NULL,
	"redirect_uri" text NOT NULL,
	"expires_at" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_dictionary_words" (
	"project_id" text NOT NULL,
	"word" text NOT NULL,
	"created_by" text,
	"created_at" text NOT NULL,
	CONSTRAINT "project_dictionary_words_project_id_word_pk" PRIMARY KEY("project_id","word")
);
--> statement-breakpoint
CREATE TABLE "project_directory_staging" (
	"project_id" text PRIMARY KEY NOT NULL,
	"trash_name" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_edit_history_boundaries" (
	"project_id" text NOT NULL,
	"file_path" text NOT NULL,
	"after_hash" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "project_edit_history_boundaries_project_id_file_path_pk" PRIMARY KEY("project_id","file_path")
);
--> statement-breakpoint
CREATE TABLE "project_edit_segments" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"file_path" text NOT NULL,
	"author_id" text,
	"kind" text NOT NULL,
	"before_hash" text NOT NULL,
	"after_hash" text NOT NULL,
	"steps_json" text NOT NULL,
	"steps_bytes" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "project_edit_segments_kind_check" CHECK ("project_edit_segments"."kind" IN ('edit', 'format'))
);
--> statement-breakpoint
CREATE TABLE "project_history_state" (
	"project_id" text PRIMARY KEY NOT NULL,
	"manifest_json" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_history_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"author_id" text,
	"reason" text NOT NULL,
	"label" text,
	"manifest_json" text NOT NULL,
	"changed_paths_json" text DEFAULT '[]' NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "project_history_versions_reason_check" CHECK ("project_history_versions"."reason" IN ('initial', 'autosave', 'file', 'settings', 'git', 'restore', 'checkpoint'))
);
--> statement-breakpoint
CREATE TABLE "project_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"recipient_user_id" text,
	"email" text,
	"permission" text NOT NULL,
	"invited_by" text,
	"status" text NOT NULL,
	"created_at" text NOT NULL,
	"responded_at" text,
	CONSTRAINT "project_invitations_permission_check" CHECK ("project_invitations"."permission" IN ('read', 'edit')),
	CONSTRAINT "project_invitations_status_check" CHECK ("project_invitations"."status" IN ('pending', 'accepted', 'declined', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"permission" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "project_members_project_id_user_id_pk" PRIMARY KEY("project_id","user_id"),
	CONSTRAINT "project_members_permission_check" CHECK ("project_members"."permission" IN ('read', 'edit'))
);
--> statement-breakpoint
CREATE TABLE "project_share_links" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_ciphertext" text NOT NULL,
	"permission" text DEFAULT 'read' NOT NULL,
	"created_by" text,
	"created_at" text NOT NULL,
	"revoked_at" text,
	CONSTRAINT "project_share_links_permission_check" CHECK ("project_share_links"."permission" = 'read')
);
--> statement-breakpoint
CREATE TABLE "project_tag_links" (
	"project_id" text NOT NULL,
	"tag_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "project_tag_links_project_id_tag_id_pk" PRIMARY KEY("project_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"last_modified_by" text,
	"name" text NOT NULL,
	"main_file" text DEFAULT 'main.tex' NOT NULL,
	"engine" text DEFAULT 'xelatex' NOT NULL,
	"icon" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "projects_engine_check" CHECK ("projects"."engine" IN ('pdflatex', 'xelatex', 'lualatex'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_by" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "tags_color_check" CHECK ("tags"."color" IN ('red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'))
);
--> statement-breakpoint
CREATE TABLE "user_deletion_staging" (
	"user_id" text PRIMARY KEY NOT NULL,
	"original_disabled" integer NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "user_deletion_staging_original_disabled_check" CHECK ("user_deletion_staging"."original_disabled" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE "user_project_archives" (
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"archived_at" text NOT NULL,
	CONSTRAINT "user_project_archives_user_id_project_id_pk" PRIMARY KEY("user_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "user_project_tag_links" (
	"project_id" text NOT NULL,
	"tag_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "user_project_tag_links_project_id_tag_id_pk" PRIMARY KEY("project_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "user_tags" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "user_tags_color_check" CHECK ("user_tags"."color" IN ('red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"email" text,
	"github_id" text,
	"nuwax_subject" text,
	"avatar_url" text,
	"role" text NOT NULL,
	"disabled" integer DEFAULT 0 NOT NULL,
	"must_change_password" integer DEFAULT 0 NOT NULL,
	"can_create_projects" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "users_role_check" CHECK ("users"."role" IN ('admin', 'user')),
	CONSTRAINT "users_disabled_check" CHECK ("users"."disabled" IN (0, 1)),
	CONSTRAINT "users_must_change_password_check" CHECK ("users"."must_change_password" IN (0, 1)),
	CONSTRAINT "users_can_create_projects_check" CHECK ("users"."can_create_projects" IN (0, 1))
);
--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation_library_entries" ADD CONSTRAINT "citation_library_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation_library_entry_tags" ADD CONSTRAINT "citation_library_entry_tags_entry_id_citation_library_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."citation_library_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation_library_entry_tags" ADD CONSTRAINT "citation_library_entry_tags_tag_id_citation_library_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."citation_library_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation_library_tags" ADD CONSTRAINT "citation_library_tags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_reply_id_comment_replies_id_fk" FOREIGN KEY ("reply_id") REFERENCES "public"."comment_replies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_mentioned_user_id_users_id_fk" FOREIGN KEY ("mentioned_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_mentioned_by_user_id_users_id_fk" FOREIGN KEY ("mentioned_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_replies" ADD CONSTRAINT "comment_replies_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_replies" ADD CONSTRAINT "comment_replies_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compile_runs" ADD CONSTRAINT "compile_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compile_runs" ADD CONSTRAINT "compile_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nuwax_oauth_tokens" ADD CONSTRAINT "nuwax_oauth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_dictionary_words" ADD CONSTRAINT "project_dictionary_words_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_dictionary_words" ADD CONSTRAINT "project_dictionary_words_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_edit_history_boundaries" ADD CONSTRAINT "project_edit_history_boundaries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_edit_segments" ADD CONSTRAINT "project_edit_segments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_edit_segments" ADD CONSTRAINT "project_edit_segments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_history_state" ADD CONSTRAINT "project_history_state_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_history_versions" ADD CONSTRAINT "project_history_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_history_versions" ADD CONSTRAINT "project_history_versions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_share_links" ADD CONSTRAINT "project_share_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_share_links" ADD CONSTRAINT "project_share_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tag_links" ADD CONSTRAINT "project_tag_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tag_links" ADD CONSTRAINT "project_tag_links_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_last_modified_by_users_id_fk" FOREIGN KEY ("last_modified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_project_archives" ADD CONSTRAINT "user_project_archives_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_project_archives" ADD CONSTRAINT "user_project_archives_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_project_tag_links" ADD CONSTRAINT "user_project_tag_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_project_tag_links" ADD CONSTRAINT "user_project_tag_links_tag_id_user_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."user_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tags" ADD CONSTRAINT "user_tags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identities_issuer_subject_unique" ON "auth_identities" USING btree ("issuer","subject");--> statement-breakpoint
CREATE INDEX "auth_identities_user_id" ON "auth_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_identities_email_ci" ON "auth_identities" USING btree (lower("provider_email"));--> statement-breakpoint
CREATE UNIQUE INDEX "citation_library_entries_user_key_ci_unique" ON "citation_library_entries" USING btree ("user_id",lower("citation_key"));--> statement-breakpoint
CREATE INDEX "citation_library_entries_user_updated" ON "citation_library_entries" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "citation_library_entry_tags_tag_id" ON "citation_library_entry_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "citation_library_tags_user_name_ci_unique" ON "citation_library_tags" USING btree ("user_id",lower("name"));--> statement-breakpoint
CREATE INDEX "comment_mentions_receiver_unread" ON "comment_mentions" USING btree ("mentioned_user_id","project_id","created_at") WHERE "comment_mentions"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "comment_mentions_comment_id" ON "comment_mentions" USING btree ("comment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "comment_mentions_source_recipient" ON "comment_mentions" USING btree ("comment_id",coalesce("reply_id", ''),"mentioned_user_id");--> statement-breakpoint
CREATE INDEX "comment_replies_comment_id" ON "comment_replies" USING btree ("comment_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_project_file" ON "comments" USING btree ("project_id","file_path");--> statement-breakpoint
CREATE INDEX "comments_project_resolved" ON "comments" USING btree ("project_id","resolved");--> statement-breakpoint
CREATE INDEX "compile_runs_project_created" ON "compile_runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "compile_runs_project_main_created" ON "compile_runs" USING btree ("project_id","main_file","created_at");--> statement-breakpoint
CREATE INDEX "oauth_states_expires_at" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "project_dictionary_words_project_id" ON "project_dictionary_words" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_directory_staging_trash_name_unique" ON "project_directory_staging" USING btree ("trash_name");--> statement-breakpoint
CREATE INDEX "project_directory_staging_created_at" ON "project_directory_staging" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "project_edit_segments_project_file_updated" ON "project_edit_segments" USING btree ("project_id","file_path","updated_at");--> statement-breakpoint
CREATE INDEX "project_history_versions_project_created" ON "project_history_versions" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "project_invitations_recipient_status" ON "project_invitations" USING btree ("recipient_user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "project_invitations_email_status" ON "project_invitations" USING btree ("email","status","created_at");--> statement-breakpoint
CREATE INDEX "project_invitations_project_status" ON "project_invitations" USING btree ("project_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_invitations_pending_recipient_unique" ON "project_invitations" USING btree ("project_id","recipient_user_id") WHERE "project_invitations"."status" = 'pending' AND "project_invitations"."recipient_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "project_invitations_pending_email_unique" ON "project_invitations" USING btree ("project_id",lower("email")) WHERE "project_invitations"."status" = 'pending' AND "project_invitations"."recipient_user_id" IS NULL AND "project_invitations"."email" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "project_share_links_token_hash_unique" ON "project_share_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "project_share_links_project_status" ON "project_share_links" USING btree ("project_id","revoked_at","created_at");--> statement-breakpoint
CREATE INDEX "project_tag_links_tag_id" ON "project_tag_links" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "projects_owner_id" ON "projects" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_name_ci_unique" ON "tags" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "user_deletion_staging_created_at" ON "user_deletion_staging" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "user_project_archives_project_id" ON "user_project_archives" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "user_project_tag_links_tag_id" ON "user_project_tag_links" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_tags_user_name_ci_unique" ON "user_tags" USING btree ("user_id",lower("name"));--> statement-breakpoint
CREATE INDEX "user_tags_user_id" ON "user_tags" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_ci_unique" ON "users" USING btree (lower("username"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_ci_unique" ON "users" USING btree (lower("email")) WHERE "users"."email" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_github_id_unique" ON "users" USING btree ("github_id") WHERE "users"."github_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_nuwax_subject_unique" ON "users" USING btree ("nuwax_subject") WHERE "users"."nuwax_subject" IS NOT NULL;