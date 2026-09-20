import fs from "node:fs";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { Config } from "./config.js";

export type DatabaseConnection = Database.Database;

export type UserRole = "admin" | "user";

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  email: string | null;
  github_id: string | null;
  /** Stable Nuwax subject used to link pre-provisioned and OAuth accounts. */
  nuwax_subject: string | null;
  avatar_url: string | null;
  role: UserRole;
  disabled: number;
  must_change_password: number;
  can_create_projects: number;
  created_at: string;
  /** Request-scoped access granted by an active share-link cookie. */
  share_link_id?: string | null;
  /** Internal digest of the session that authenticated this request. */
  session_id?: string | null;
  /** Expiry of the concrete browser session that authenticated this request. */
  session_expires_at?: string | null;
}

export interface AuthIdentityRow {
  id: string;
  user_id: string;
  issuer: string;
  subject: string;
  provider_username: string | null;
  provider_email: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectRow {
  id: string;
  owner_id: string;
  last_modified_by: string | null;
  name: string;
  main_file: string;
  latexmkrc: string | null;
  engine: "pdflatex" | "xelatex" | "lualatex";
  icon: string | null;
  created_at: string;
  updated_at: string;
}

interface DatabaseMigrationContext {
  /**
   * Before migrations were tracked, `project_tags` was copied into
   * `user_tags` on every startup.  Only databases from before private tags
   * existed need that one-time conversion.  An existing `user_tags` table is
   * evidence that a prior TexLite release has already performed it; importing
   * again could recreate a tag that its owner deliberately deleted.
   */
  migrateLegacyProjectTags: boolean;
  /** These backfills are safe only while introducing their missing column. */
  backfillAdminCanCreateProjects: boolean;
  backfillProjectLastModifiedBy: boolean;
  backfillCompileRunMainFile: boolean;
  backfillEditSegmentBytes: boolean;
}

interface DatabaseMigration {
  version: number;
  name: string;
  apply: (db: DatabaseConnection, context: DatabaseMigrationContext) => void;
}

const migrationsTable = "texlite_schema_migrations";

/**
 * Keep this list append-only. Existing migration bodies must never be changed
 * after release: a database records the version only after that migration's
 * transaction has committed.
 *
 * Version 1 deliberately folds the untracked historical schema setup into a
 * single baseline. It upgrades every database released before versioned
 * migrations while preserving the current schema for new installations.
 */
const databaseMigrations: readonly DatabaseMigration[] = [
  // Append future migrations below this entry. Never insert before or modify
  // the released baseline: recorded databases will intentionally skip it.
  { version: 1, name: "baseline_schema_and_legacy_upgrade", apply: applyBaselineMigration },
  { version: 2, name: "github_identity_and_project_invitations", apply: applyGithubIdentityMigration },
  { version: 3, name: "disable_legacy_project_latexmkrc", apply: applyDisableLegacyLatexmkrcMigration },
  { version: 4, name: "normalized_auth_identities", apply: applyNormalizedAuthIdentitiesMigration },
  { version: 5, name: "project_share_links", apply: applyProjectShareLinksMigration },
  { version: 6, name: "unique_user_emails_and_user_bound_invitations", apply: applyUniqueUserEmailsAndUserBoundInvitationsMigration },
  { version: 7, name: "recoverable_project_directory_staging", apply: applyRecoverableProjectDirectoryStagingMigration },
  { version: 8, name: "recoverable_user_deletion_staging", apply: applyRecoverableUserDeletionStagingMigration },
  { version: 9, name: "nuwax_oauth_accounts_and_tokens", apply: applyNuwaxOAuthAccountsAndTokensMigration }
];

export function openDatabase(config: Config): DatabaseConnection {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(config.projectsDir, { recursive: true, mode: 0o700 });
  const db = new Database(config.databasePath, { timeout: 5000 });
  // WAL allows readers to proceed while writes are committed. NORMAL avoids a
  // per-transaction WAL fsync: a sudden host failure can lose the most recent
  // acknowledged transaction, but the database remains consistent.
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  try {
    migrate(db);
  } catch (error) {
    // A failed migration must not leave an open SQLite handle holding a lock
    // while startup unwinds. Its transaction has already been rolled back.
    db.close();
    throw error;
  }
  return db;
}

function migrate(db: DatabaseConnection): void {
  const context: DatabaseMigrationContext = {
    migrateLegacyProjectTags: tableExists(db, "project_tags") && !tableExists(db, "user_tags"),
    backfillAdminCanCreateProjects: missingColumn(db, "users", "can_create_projects"),
    backfillProjectLastModifiedBy: missingColumn(db, "projects", "last_modified_by"),
    backfillCompileRunMainFile: missingColumn(db, "compile_runs", "main_file"),
    backfillEditSegmentBytes: missingColumn(db, "project_edit_segments", "steps_bytes")
  };
  db.exec(`CREATE TABLE IF NOT EXISTS ${migrationsTable} (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = (db.prepare(`SELECT version, name FROM ${migrationsTable}`).all() as Array<{ version: number; name: string }>)
    .map((migration) => ({ version: Number(migration.version), name: migration.name }));
  const knownMigrations = new Map(databaseMigrations.map((migration) => [migration.version, migration]));
  const unknownMigration = applied.find((migration) => !knownMigrations.has(migration.version));
  if (unknownMigration !== undefined) {
    const latestVersion = databaseMigrations.at(-1)?.version ?? 0;
    const direction = unknownMigration.version > latestVersion ? "newer than" : "not recognized by";
    throw new Error(`Database schema version ${unknownMigration.version} is ${direction} this TexLite release.`);
  }
  const renamedMigration = applied.find((migration) => knownMigrations.get(migration.version)?.name !== migration.name);
  if (renamedMigration) {
    throw new Error(`Database migration ${renamedMigration.version} does not match this TexLite release.`);
  }
  const appliedVersions = new Set(applied.map((migration) => migration.version));
  const missingBeforeApplied = databaseMigrations.find((migration) => !appliedVersions.has(migration.version)
    && applied.some((appliedMigration) => appliedMigration.version > migration.version));
  if (missingBeforeApplied) {
    throw new Error(`Database migration ${missingBeforeApplied.version} is missing before a later migration.`);
  }

  const record = db.prepare(`INSERT INTO ${migrationsTable} (version, name, applied_at) VALUES (?, ?, ?)`);
  for (const migration of databaseMigrations) {
    if (appliedVersions.has(migration.version)) continue;
    db.transaction(() => {
      migration.apply(db, context);
      record.run(migration.version, migration.name, new Date().toISOString());
    })();
  }
}

function tableExists(db: DatabaseConnection, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function missingColumn(db: DatabaseConnection, table: string, column: string): boolean {
  return tableExists(db, table)
    && !db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, column);
}

function applyBaselineMigration(db: DatabaseConnection, context: DatabaseMigrationContext): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      email TEXT COLLATE NOCASE,
      github_id TEXT UNIQUE,
      avatar_url TEXT,
      role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
      disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
      must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
      can_create_projects INTEGER NOT NULL DEFAULT 0 CHECK (can_create_projects IN (0, 1)),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      last_modified_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      main_file TEXT NOT NULL DEFAULT 'main.tex',
      latexmkrc TEXT,
      engine TEXT NOT NULL DEFAULT 'xelatex' CHECK (engine IN ('pdflatex', 'xelatex', 'lualatex')),
      icon TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS projects_owner_id ON projects(owner_id);

    CREATE TABLE IF NOT EXISTS project_tags (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE,
      color TEXT NOT NULL CHECK (color IN ('red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray')),
      created_at TEXT NOT NULL,
      UNIQUE (project_id, name)
    );
    CREATE INDEX IF NOT EXISTS project_tags_project_id ON project_tags(project_id);

    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      color TEXT NOT NULL CHECK (color IN ('red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray')),
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_tag_links (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS project_tag_links_tag_id ON project_tag_links(tag_id);

    CREATE TABLE IF NOT EXISTS user_tags (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE,
      color TEXT NOT NULL CHECK (color IN ('red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, name)
    );
    CREATE INDEX IF NOT EXISTS user_tags_user_id ON user_tags(user_id);

    CREATE TABLE IF NOT EXISTS user_project_tag_links (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES user_tags(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS user_project_tag_links_tag_id ON user_project_tag_links(tag_id);

    CREATE TABLE IF NOT EXISTS user_project_archives (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      archived_at TEXT NOT NULL,
      PRIMARY KEY (user_id, project_id)
    );
    CREATE INDEX IF NOT EXISTS user_project_archives_project_id ON user_project_archives(project_id);

    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission TEXT NOT NULL CHECK (permission IN ('read', 'edit')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      selected_text TEXT NOT NULL DEFAULT '',
      start_offset INTEGER NOT NULL DEFAULT 0,
      end_offset INTEGER NOT NULL DEFAULT 0,
      context_before TEXT NOT NULL DEFAULT '',
      context_after TEXT NOT NULL DEFAULT '',
      orphaned INTEGER NOT NULL DEFAULT 0 CHECK (orphaned IN (0, 1)),
      start_line INTEGER NOT NULL DEFAULT 1,
      end_line INTEGER NOT NULL DEFAULT 1,
      content TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      edited_at TEXT
    );
    CREATE INDEX IF NOT EXISTS comments_project_file ON comments(project_id, file_path);
    CREATE INDEX IF NOT EXISTS comments_project_resolved ON comments(project_id, resolved);

    CREATE TABLE IF NOT EXISTS comment_replies (
      id TEXT PRIMARY KEY,
      comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
      author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      edited_at TEXT
    );
    CREATE INDEX IF NOT EXISTS comment_replies_comment_id ON comment_replies(comment_id, created_at);

    -- Mentions are personal notification records, rather than a mutable
    -- counter on comments or projects.  This makes unread state naturally
    -- per user and lets resolving one thread clear its existing notifications.
    CREATE TABLE IF NOT EXISTS comment_mentions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
      reply_id TEXT REFERENCES comment_replies(id) ON DELETE CASCADE,
      mentioned_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mentioned_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      read_at TEXT,
      read_reason TEXT CHECK (read_reason IN ('opened', 'resolved', 'manual')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS comment_mentions_receiver_unread
      ON comment_mentions(mentioned_user_id, project_id, created_at DESC)
      WHERE read_at IS NULL;
    CREATE INDEX IF NOT EXISTS comment_mentions_comment_id ON comment_mentions(comment_id);
    CREATE UNIQUE INDEX IF NOT EXISTS comment_mentions_source_recipient
      ON comment_mentions(comment_id, IFNULL(reply_id, ''), mentioned_user_id);

    CREATE TABLE IF NOT EXISTS compile_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      main_file TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
      log TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS compile_runs_project_created ON compile_runs(project_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS project_history_versions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      reason TEXT NOT NULL CHECK (reason IN ('initial', 'autosave', 'file', 'settings', 'git', 'restore', 'checkpoint')),
      label TEXT,
      manifest_json TEXT NOT NULL,
      changed_paths_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS project_history_versions_project_created
      ON project_history_versions(project_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS project_history_state (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      manifest_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Recovery snapshots and collaborative edit records serve different
    -- purposes. Snapshots are content-addressed restore points; these rows
    -- retain the ordered, author-attributed text changes that led to the
    -- current source, so a selected range can show who changed it.
    CREATE TABLE IF NOT EXISTS project_edit_segments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      kind TEXT NOT NULL CHECK (kind IN ('edit', 'format')),
      before_hash TEXT NOT NULL,
      after_hash TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      steps_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS project_edit_segments_project_file_updated
      ON project_edit_segments(project_id, file_path, updated_at DESC);

    -- Records the newest missing delta per file after retention drops an edit
    -- segment. Selection history uses it to stop at a known boundary instead
    -- of presenting an incomplete attribution as a full edit trail.
    CREATE TABLE IF NOT EXISTS project_edit_history_boundaries (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      after_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, file_path)
    );

    CREATE TABLE IF NOT EXISTS project_dictionary_words (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      word TEXT NOT NULL COLLATE NOCASE,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, word)
    );
    CREATE INDEX IF NOT EXISTS project_dictionary_words_project_id ON project_dictionary_words(project_id);

    CREATE TABLE IF NOT EXISTS citation_library_entries (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      citation_key TEXT NOT NULL COLLATE NOCASE,
      entry_type TEXT NOT NULL,
      bibtex TEXT NOT NULL,
      title TEXT,
      authors TEXT,
      year TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, citation_key)
    );
    CREATE INDEX IF NOT EXISTS citation_library_entries_user_updated
      ON citation_library_entries(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS citation_library_tags (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE,
      color TEXT NOT NULL CHECK (color IN ('red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray')),
      created_at TEXT NOT NULL,
      UNIQUE (user_id, name)
    );
    CREATE TABLE IF NOT EXISTS citation_library_entry_tags (
      entry_id TEXT NOT NULL REFERENCES citation_library_entries(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES citation_library_tags(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (entry_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS citation_library_entry_tags_tag_id ON citation_library_entry_tags(tag_id);

    CREATE TABLE IF NOT EXISTS project_git_settings (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      token_ciphertext TEXT,
      github_login TEXT,
      remote_url TEXT,
      repository_name TEXT,
      repository_html_url TEXT,
      default_branch TEXT NOT NULL DEFAULT 'main',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      id TEXT PRIMARY KEY,
      return_path TEXT NOT NULL DEFAULT '/',
      redirect_uri TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS oauth_states_expires_at ON oauth_states(expires_at);

    CREATE TABLE IF NOT EXISTS project_invitations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      email TEXT COLLATE NOCASE,
      permission TEXT NOT NULL CHECK (permission IN ('read', 'edit')),
      invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'revoked')),
      created_at TEXT NOT NULL,
      responded_at TEXT
    );
    CREATE INDEX IF NOT EXISTS project_invitations_email_status
      ON project_invitations(email, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS project_invitations_project_status
      ON project_invitations(project_id, status, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS project_invitations_pending_unique
      ON project_invitations(project_id, email) WHERE status = 'pending';
  `);

  const editColumns = db.prepare("PRAGMA table_info(project_edit_segments)").all() as Array<{ name: string }>;
  if (!editColumns.some((column) => column.name === "steps_bytes")) {
    db.exec("ALTER TABLE project_edit_segments ADD COLUMN steps_bytes INTEGER NOT NULL DEFAULT 0");
    if (context.backfillEditSegmentBytes) {
      db.exec("UPDATE project_edit_segments SET steps_bytes = LENGTH(CAST(steps_json AS BLOB))");
    }
  }
  const projectColumns = db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
  if (!projectColumns.some((column) => column.name === "latexmkrc")) {
    db.exec("ALTER TABLE projects ADD COLUMN latexmkrc TEXT");
  }
  if (!projectColumns.some((column) => column.name === "last_modified_by")) {
    db.exec("ALTER TABLE projects ADD COLUMN last_modified_by TEXT REFERENCES users(id) ON DELETE SET NULL");
  }
  if (!projectColumns.some((column) => column.name === "icon")) {
    db.exec("ALTER TABLE projects ADD COLUMN icon TEXT");
  }
  const commentColumns = db.prepare("PRAGMA table_info(comments)").all() as Array<{ name: string }>;
  const additions = [
    ["start_offset", "INTEGER NOT NULL DEFAULT 0"],
    ["end_offset", "INTEGER NOT NULL DEFAULT 0"],
    ["context_before", "TEXT NOT NULL DEFAULT ''"],
    ["context_after", "TEXT NOT NULL DEFAULT ''"],
    ["orphaned", "INTEGER NOT NULL DEFAULT 0"],
    ["edited_at", "TEXT"]
  ] as const;
  for (const [name, definition] of additions) {
    if (!commentColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE comments ADD COLUMN ${name} ${definition}`);
    }
  }
  const replyColumns = db.prepare("PRAGMA table_info(comment_replies)").all() as Array<{ name: string }>;
  if (!replyColumns.some((column) => column.name === "edited_at")) {
    db.exec("ALTER TABLE comment_replies ADD COLUMN edited_at TEXT");
  }
  const userColumns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!userColumns.some((column) => column.name === "can_create_projects")) {
    db.exec("ALTER TABLE users ADD COLUMN can_create_projects INTEGER NOT NULL DEFAULT 0");
  }
  if (!userColumns.some((column) => column.name === "email")) {
    db.exec("ALTER TABLE users ADD COLUMN email TEXT COLLATE NOCASE");
  }
  if (!userColumns.some((column) => column.name === "github_id")) {
    db.exec("ALTER TABLE users ADD COLUMN github_id TEXT");
  }
  if (!userColumns.some((column) => column.name === "avatar_url")) {
    db.exec("ALTER TABLE users ADD COLUMN avatar_url TEXT");
  }
  const compileRunColumns = db.prepare("PRAGMA table_info(compile_runs)").all() as Array<{ name: string }>;
  if (!compileRunColumns.some((column) => column.name === "main_file")) {
    db.exec("ALTER TABLE compile_runs ADD COLUMN main_file TEXT NOT NULL DEFAULT ''");
  }
  const citationColumns = db.prepare("PRAGMA table_info(citation_library_entries)").all() as Array<{ name: string }>;
  if (!citationColumns.some((column) => column.name === "revision")) {
    db.exec("ALTER TABLE citation_library_entries ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS compile_runs_project_main_created
      ON compile_runs(project_id, main_file, created_at DESC);
  `);

  if (context.backfillProjectLastModifiedBy) {
    db.exec("UPDATE projects SET last_modified_by = owner_id WHERE last_modified_by IS NULL");
  }
  if (context.backfillAdminCanCreateProjects) {
    db.exec("UPDATE users SET can_create_projects = 1 WHERE role = 'admin'");
  }
  if (context.backfillCompileRunMainFile) {
    db.exec(`UPDATE compile_runs SET main_file = COALESCE(
      (SELECT project.main_file FROM projects project WHERE project.id = compile_runs.project_id), ''
    ) WHERE main_file = ''`);
  }

  if (!context.migrateLegacyProjectTags) return;
  db.exec(`
    INSERT OR IGNORE INTO tags (id, name, color, created_by, created_at, updated_at)
    SELECT legacy.id, legacy.name, legacy.color, p.owner_id, legacy.created_at, legacy.created_at
    FROM project_tags legacy
    JOIN projects p ON p.id = legacy.project_id
    WHERE legacy.id = (
      SELECT first_tag.id FROM project_tags first_tag
      WHERE first_tag.name = legacy.name COLLATE NOCASE
      ORDER BY first_tag.created_at, first_tag.id LIMIT 1
    );

    INSERT OR IGNORE INTO project_tag_links (project_id, tag_id, created_at)
    SELECT legacy.project_id, tag.id, legacy.created_at
    FROM project_tags legacy
    JOIN tags tag ON tag.name = legacy.name COLLATE NOCASE;

    INSERT OR IGNORE INTO user_tags (id, user_id, name, color, created_at, updated_at)
    SELECT legacy.id, project.owner_id, legacy.name, legacy.color, legacy.created_at, legacy.created_at
    FROM project_tags legacy
    JOIN projects project ON project.id = legacy.project_id
    WHERE legacy.id = (
      SELECT first_tag.id FROM project_tags first_tag
      JOIN projects first_project ON first_project.id = first_tag.project_id
      WHERE first_project.owner_id = project.owner_id
        AND first_tag.name = legacy.name COLLATE NOCASE
      ORDER BY first_tag.created_at, first_tag.id LIMIT 1
    );

    INSERT OR IGNORE INTO user_project_tag_links (project_id, tag_id, created_at)
    SELECT legacy.project_id, user_tag.id, legacy.created_at
    FROM project_tags legacy
    JOIN projects project ON project.id = legacy.project_id
    JOIN user_tags user_tag ON user_tag.user_id = project.owner_id
      AND user_tag.name = legacy.name COLLATE NOCASE;

    INSERT OR IGNORE INTO user_tags (id, user_id, name, color, created_at, updated_at)
    SELECT tag.id, tag.created_by, tag.name, tag.color, tag.created_at, tag.updated_at
    FROM tags tag WHERE tag.created_by IS NOT NULL;

    INSERT OR IGNORE INTO user_project_tag_links (project_id, tag_id, created_at)
    SELECT link.project_id, link.tag_id, link.created_at
    FROM project_tag_links link JOIN user_tags user_tag ON user_tag.id = link.tag_id;
  `);
}

function applyGithubIdentityMigration(db: DatabaseConnection): void {
  const userColumns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!userColumns.some((column) => column.name === "email")) {
    db.exec("ALTER TABLE users ADD COLUMN email TEXT COLLATE NOCASE");
  }
  if (!userColumns.some((column) => column.name === "github_id")) {
    db.exec("ALTER TABLE users ADD COLUMN github_id TEXT");
  }
  if (!userColumns.some((column) => column.name === "avatar_url")) {
    db.exec("ALTER TABLE users ADD COLUMN avatar_url TEXT");
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_github_id_unique ON users(github_id) WHERE github_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS users_email ON users(email COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS oauth_states (
      id TEXT PRIMARY KEY,
      return_path TEXT NOT NULL DEFAULT '/',
      redirect_uri TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS oauth_states_expires_at ON oauth_states(expires_at);
    CREATE TABLE IF NOT EXISTS project_invitations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      email TEXT COLLATE NOCASE,
      permission TEXT NOT NULL CHECK (permission IN ('read', 'edit')),
      invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'revoked')),
      created_at TEXT NOT NULL,
      responded_at TEXT
    );
    CREATE INDEX IF NOT EXISTS project_invitations_email_status
      ON project_invitations(email, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS project_invitations_project_status
      ON project_invitations(project_id, status, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS project_invitations_pending_unique
      ON project_invitations(project_id, email) WHERE status = 'pending';
  `);
}

function applyDisableLegacyLatexmkrcMigration(db: DatabaseConnection): void {
  // Keep the nullable column for old databases so the migration remains
  // non-destructive, but clear all values. New code never reads or writes it.
  if (tableExists(db, "projects") && missingColumn(db, "projects", "latexmkrc") === false) {
    db.exec("UPDATE projects SET latexmkrc = NULL WHERE latexmkrc IS NOT NULL");
  }
}

function applyNormalizedAuthIdentitiesMigration(db: DatabaseConnection): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_identities (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      issuer TEXT NOT NULL,
      subject TEXT NOT NULL,
      provider_username TEXT,
      provider_email TEXT COLLATE NOCASE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (issuer, subject)
    );
    CREATE INDEX IF NOT EXISTS auth_identities_user_id ON auth_identities(user_id);
    CREATE INDEX IF NOT EXISTS auth_identities_email ON auth_identities(provider_email COLLATE NOCASE);
  `);

  const legacyGithubUsers = db.prepare(`
    SELECT id, username, email, github_id, created_at
    FROM users
    WHERE github_id IS NOT NULL AND TRIM(github_id) <> ''
  `).all() as Array<{ id: string; username: string; email: string | null; github_id: string; created_at: string }>;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO auth_identities
      (id, user_id, issuer, subject, provider_username, provider_email, created_at, updated_at)
    VALUES (?, ?, 'github', ?, ?, ?, ?, ?)
  `);
  for (const user of legacyGithubUsers) {
    insert.run(randomUUID(), user.id, user.github_id, user.username, user.email, user.created_at, user.created_at);
  }
}

function applyProjectShareLinksMigration(db: DatabaseConnection): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_share_links (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      token_ciphertext TEXT NOT NULL,
      permission TEXT NOT NULL DEFAULT 'read' CHECK (permission = 'read'),
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS project_share_links_project_status
      ON project_share_links(project_id, revoked_at, created_at DESC);
  `);
}

/**
 * Email remains optional: SQLite's partial unique index permits any number of
 * accounts without one, while making every non-null mailbox unambiguous. New
 * invitations are bound to a local user ID; phone numbers are never stored.
 */
function applyUniqueUserEmailsAndUserBoundInvitationsMigration(db: DatabaseConnection): void {
  // Older releases never write blank addresses, but treating historical blank
  // values as absent keeps the optional-email invariant explicit.
  db.prepare("UPDATE users SET email = NULL WHERE email IS NOT NULL AND TRIM(email) = ''").run();
  const duplicateEmail = db.prepare(`SELECT email FROM users
    WHERE email IS NOT NULL
    GROUP BY email COLLATE NOCASE
    HAVING COUNT(*) > 1
    LIMIT 1`).get() as { email: string } | undefined;
  if (duplicateEmail) {
    // Do not silently detach an address from an account: that could change
    // both sign-in behavior and who is entitled to a pending invitation.
    throw new Error("Cannot migrate database: duplicate non-empty user email addresses must be resolved before enforcing unique emails.");
  }

  db.exec(`
    DROP INDEX IF EXISTS users_email;
    DROP INDEX IF EXISTS users_email_unique;
    CREATE UNIQUE INDEX users_email_unique
      ON users(email COLLATE NOCASE) WHERE email IS NOT NULL;

    CREATE TABLE project_invitations_new (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      recipient_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      email TEXT COLLATE NOCASE,
      permission TEXT NOT NULL CHECK (permission IN ('read', 'edit')),
      invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'revoked')),
      created_at TEXT NOT NULL,
      responded_at TEXT
    );

    INSERT INTO project_invitations_new
      (id, project_id, recipient_user_id, email, permission, invited_by, status, created_at, responded_at)
    SELECT invitation.id, invitation.project_id,
      (SELECT user.id FROM users user
        WHERE user.email = invitation.email COLLATE NOCASE
        LIMIT 1),
      invitation.email, invitation.permission, invitation.invited_by,
      invitation.status, invitation.created_at, invitation.responded_at
    FROM project_invitations invitation;

    DROP TABLE project_invitations;
    ALTER TABLE project_invitations_new RENAME TO project_invitations;

    CREATE INDEX project_invitations_recipient_status
      ON project_invitations(recipient_user_id, status, created_at DESC);
    CREATE INDEX project_invitations_email_status
      ON project_invitations(email, status, created_at DESC);
    CREATE INDEX project_invitations_project_status
      ON project_invitations(project_id, status, created_at DESC);
    CREATE UNIQUE INDEX project_invitations_pending_recipient_unique
      ON project_invitations(project_id, recipient_user_id)
      WHERE status = 'pending' AND recipient_user_id IS NOT NULL;
    CREATE UNIQUE INDEX project_invitations_pending_email_unique
      ON project_invitations(project_id, email)
      WHERE status = 'pending' AND recipient_user_id IS NULL AND email IS NOT NULL;
  `);
}

/**
 * A directory move and a SQLite transaction cannot be one atomic operation.
 * Keep a durable intent record while a live project tree sits in trash so
 * startup can restore it when its project row still exists, or finish purging
 * it after the row has been deleted.
 */
function applyRecoverableProjectDirectoryStagingMigration(db: DatabaseConnection): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_directory_staging (
      project_id TEXT PRIMARY KEY,
      trash_name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS project_directory_staging_created_at
      ON project_directory_staging(created_at);
  `);
}

/** Keep the original account state while a multi-project user deletion runs. */
function applyRecoverableUserDeletionStagingMigration(db: DatabaseConnection): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_deletion_staging (
      user_id TEXT PRIMARY KEY,
      original_disabled INTEGER NOT NULL CHECK (original_disabled IN (0, 1)),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS user_deletion_staging_created_at
      ON user_deletion_staging(created_at);
  `);
}

/** Add the Nuwax account key and encrypted-token storage used by phone lookup. */
function applyNuwaxOAuthAccountsAndTokensMigration(db: DatabaseConnection): void {
  if (missingColumn(db, "users", "nuwax_subject")) {
    db.exec("ALTER TABLE users ADD COLUMN nuwax_subject TEXT");
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_nuwax_subject_unique
      ON users(nuwax_subject) WHERE nuwax_subject IS NOT NULL;

    CREATE TABLE IF NOT EXISTS nuwax_oauth_tokens (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      access_token_ciphertext TEXT NOT NULL,
      access_token_expires_at TEXT NOT NULL,
      refresh_token_ciphertext TEXT NOT NULL,
      scope TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

/** Remove sessions that can no longer authenticate any request. */
export function pruneExpiredSessions(db: DatabaseConnection, asOf = new Date().toISOString()): number {
  return db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(asOf).changes;
}

/** Session identifiers that should be disconnected before their rows are pruned. */
export function expiredSessionIds(db: DatabaseConnection, asOf = new Date().toISOString()): string[] {
  return (db.prepare("SELECT id FROM sessions WHERE expires_at <= ?").all(asOf) as Array<{ id: string }>)
    .map((row) => row.id);
}

export function pruneExpiredOauthStates(db: DatabaseConnection, asOf = new Date().toISOString()): number {
  return db.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").run(asOf).changes;
}

export function activeAdminCount(db: DatabaseConnection): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0"
  ).get() as { count: number };
  return Number(row.count);
}

/**
 * A process can stop after suspending an account but before deleting it. Once
 * project-directory recovery has restored every live tree, return that account
 * to its prior state; a missing user means the deletion transaction committed.
 */
export function recoverInterruptedUserDeletions(db: DatabaseConnection): void {
  const rows = db.prepare("SELECT user_id, original_disabled FROM user_deletion_staging ORDER BY created_at, user_id")
    .all() as Array<{ user_id: string; original_disabled: number }>;
  const userExists = db.prepare("SELECT 1 FROM users WHERE id = ?");
  const restore = db.prepare("UPDATE users SET disabled = ? WHERE id = ?");
  const clear = db.prepare("DELETE FROM user_deletion_staging WHERE user_id = ?");
  db.transaction(() => {
    for (const row of rows) {
      if (userExists.get(row.user_id)) restore.run(row.original_disabled, row.user_id);
      clear.run(row.user_id);
    }
  })();
}
