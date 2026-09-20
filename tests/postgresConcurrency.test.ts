import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/server/config.js";
import { openApplicationDatabase, type DatabaseConnection, type ProjectRow, type UserRow } from "../src/server/db.js";
import { postgresConflictCode } from "../src/server/http.js";

const testDatabaseUrl = process.env.TEXLITE_TEST_DATABASE_URL;
let testDatabase: DatabaseConnection | null = null;

/**
 * The configured URL is a control connection: each test creates and drops a
 * separate database, so integration tests never write to the configured
 * application database. The role therefore needs CREATEDB permission.
 */
describe.skipIf(!testDatabaseUrl)("PostgreSQL concurrency safeguards", () => {
  let root = "";
  let databaseName = "";
  let controlPool: Pool | null = null;
  let closeDatabase: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-postgres-concurrency-"));
    databaseName = `texlite_test_${randomUUID().replaceAll("-", "")}`;
    controlPool = new Pool({ connectionString: testDatabaseUrl });
    await controlPool.query(`CREATE DATABASE "${databaseName}"`);
    const database = await openApplicationDatabase(configFor(root, databaseUrlForDatabase(testDatabaseUrl!, databaseName)));
    testDatabase = database.db;
    closeDatabase = database.close;
  });

  afterEach(async () => {
    await closeDatabase?.();
    closeDatabase = null;
    testDatabase = null;
    if (controlPool && databaseName) await controlPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await controlPool?.end();
    controlPool = null;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = "";
    databaseName = "";
  });

  it("keeps one active administrator and preserves concurrent field updates", async () => {
    const first = await createUser("admin", "First administrator");
    const second = await createUser("admin", "Second administrator");
    const removals = await Promise.all([
      database().administrators.patchUser({ id: first.id, disabled: 1 }),
      database().administrators.patchUser({ id: second.id, disabled: 1 })
    ]);
    expect(removals.filter((result) => result.status === "updated")).toHaveLength(1);
    expect(removals.filter((result) => result.status === "last_admin")).toHaveLength(1);
    expect(await database().administrators.activeAdminCount()).toBe(1);

    const member = await createUser("user", "Concurrent update");
    await Promise.all([
      database().administrators.patchUser({ id: member.id, passwordHash: "new-password-hash", mustChangePassword: 1 }),
      database().administrators.patchUser({ id: member.id, canCreateProjects: 0 })
    ]);
    const saved = await database().identity.findUserById(member.id);
    expect(saved).toMatchObject({ password_hash: "new-password-hash", must_change_password: 1, can_create_projects: 0 });
  });

  it("serializes invitation changes and never adds an unaccepted member", async () => {
    const owner = await createUser("user", "Project owner");
    const recipient = await createUser("user", "Recipient");
    const project = projectFor(owner.id);
    await database().projectCatalog.createProject(project);

    const invitation = await database().projectMembers.upsertInvitation(invitationFor(project.id, recipient.id, owner.id, "edit"));
    expect(invitation.status).toBe("pending");
    expect(await database().projectMembers.setMemberPermission({
      projectId: project.id, userId: recipient.id, permission: "read", email: null, changedAt: timestamp()
    })).toBe(false);

    const [accepted, refreshed] = await Promise.all([
      database().projectMembers.acceptInvitation({
        invitationId: invitation.status === "pending" ? invitation.invitationId : "",
        userId: recipient.id,
        email: null,
        respondedAt: timestamp()
      }),
      database().projectMembers.upsertInvitation(invitationFor(project.id, recipient.id, owner.id, "read"))
    ]);
    expect(accepted).not.toBeNull();
    const member = (await database().projectMembers.listMembers(project.id)).find((row) => row.id === recipient.id);
    expect(member).toBeDefined();
    expect(member?.permission).toBe(refreshed.status === "pending" ? "read" : "edit");
    expect(await database().projectMembers.upsertInvitation(invitationFor(project.id, recipient.id, owner.id, "read")))
      .toEqual({ status: "member_exists" });
  });

  it("maps Drizzle-wrapped PostgreSQL unique violations to a safe API conflict", async () => {
    const existing = await createUser("user", "Existing user");
    let duplicateError: unknown = null;
    try {
      await database().administrators.createUser({
        id: randomUUID(),
        username: existing.username,
        displayName: "Duplicate user",
        passwordHash: "test-password-hash",
        role: "user",
        canCreateProjects: 1,
        createdAt: timestamp()
      });
    } catch (error) {
      duplicateError = error;
    }
    expect(postgresConflictCode(duplicateError)).toBe("USERNAME_ALREADY_IN_USE");
  });

  async function createUser(role: "admin" | "user", displayName: string): Promise<UserRow> {
    const id = randomUUID();
    return await database().administrators.createUser({
      id,
      username: `user-${id.slice(0, 8)}`,
      displayName,
      passwordHash: "test-password-hash",
      role,
      canCreateProjects: 1,
      createdAt: timestamp()
    });
  }
});

function database(): DatabaseConnection {
  if (!testDatabase) throw new Error("PostgreSQL test database is not open");
  return testDatabase;
}

function configFor(root: string, url: string): Config {
  return {
    configPath: path.join(root, "texlite.config.json"), siteName: "Test", adminEmail: "",
    host: "127.0.0.1", port: 3000, basePath: "/", dataDir: root,
    database: { driver: "postgresql", url, sslMode: "disable" },
    projectsDir: path.join(root, "projects"), clientDir: path.join(root, "client"), sessionDays: 1,
    compileTimeoutMs: 30_000, maxCompileJobs: 1, latexmk: "latexmk", defaultEngine: "xelatex",
    allowedEngines: ["pdflatex", "xelatex", "lualatex"], extraArgs: [], maxUploadBytes: 50 * 1024 * 1024,
    pdfLoadingStrategy: "auto", pdfRangeThresholdBytes: 5 * 1024 * 1024,
    historyMaxVersions: 0, historyMaxStorageBytes: 64 * 1024 * 1024, editHistoryMaxStorageBytes: 32 * 1024 * 1024
  };
}

function databaseUrlForDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  // Generated migrations target PostgreSQL's default public schema. Do not
  // carry a caller's search_path override into the isolated test database.
  parsed.searchParams.delete("options");
  return parsed.toString();
}

function projectFor(ownerId: string): ProjectRow {
  const createdAt = timestamp();
  return {
    id: randomUUID(), owner_id: ownerId, last_modified_by: ownerId,
    name: "Concurrency project", main_file: "main.tex", engine: "xelatex", icon: null,
    created_at: createdAt, updated_at: createdAt
  };
}

function invitationFor(projectId: string, recipientUserId: string, invitedBy: string, permission: "read" | "edit") {
  return {
    id: randomUUID(), projectId, recipientUserId, email: null, permission,
    invitedBy, createdAt: timestamp()
  };
}

function timestamp(): string {
  return new Date().toISOString();
}
