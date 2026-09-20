import { and, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { UserRow } from "../../db.js";
import * as schema from "../schema/postgres.js";
import { toUserRow } from "./identity.js";

export interface InitialAdministrator {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  email: string | null;
  createdAt: string;
}

export interface AdminUserPage {
  users: Array<UserRow & { owned_projects: number }>;
  total: number;
}

export interface CreateManagedUser {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  role: "admin" | "user";
  canCreateProjects: number;
  createdAt: string;
}

export type UserDeletionSuspension =
  | { status: "not_found" }
  | { status: "last_admin" }
  | { status: "suspended"; originalDisabled: number };

/**
 * Small, PostgreSQL-only repository used before the HTTP data-access
 * migration is complete. Keeping bootstrap operations here prevents the CLI
 * from ever falling back to a stray SQLite file when PostgreSQL is selected.
 */
export class PostgresAdministratorRepository {
  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async activeAdminCount(): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<string>`count(*)` })
      .from(schema.users)
      .where(and(eq(schema.users.role, "admin"), eq(schema.users.disabled, 0)));
    return Number(row?.count ?? 0);
  }

  /**
   * Create the first administrator exactly once. The advisory transaction
   * lock avoids two concurrent `texlite init` invocations both observing an
   * empty table and creating duplicate bootstrap administrators.
   */
  async createInitialAdministrator(input: InitialAdministrator): Promise<boolean> {
    return await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('texlite:initial-administrator'))`);
      const [existing] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(and(eq(schema.users.role, "admin"), eq(schema.users.disabled, 0)))
        .limit(1);
      if (existing) return false;
      await tx.insert(schema.users).values({
        id: input.id,
        username: input.username,
        displayName: input.displayName,
        passwordHash: input.passwordHash,
        email: input.email,
        role: "admin",
        disabled: 0,
        mustChangePassword: 0,
        canCreateProjects: 1,
        createdAt: input.createdAt
      });
      return true;
    });
  }

  async listUsers(page: number, pageSize: number, search: string): Promise<AdminUserPage> {
    const condition = search ? or(
      ilike(schema.users.username, `%${escapeLikePattern(search)}%`),
      ilike(schema.users.displayName, `%${escapeLikePattern(search)}%`),
      sql`coalesce(${schema.users.email}, '') ILIKE ${`%${escapeLikePattern(search)}%`} ESCAPE '\\'`
    ) : undefined;
    const [totalRow] = await this.db.select({ count: count() }).from(schema.users).where(condition);
    const rows = await this.db.select({
      user: schema.users,
      ownedProjects: count(schema.projects.id)
    })
      .from(schema.users)
      .leftJoin(schema.projects, eq(schema.projects.ownerId, schema.users.id))
      .where(condition)
      .groupBy(schema.users.id)
      .orderBy(desc(schema.users.createdAt), desc(schema.users.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return {
      users: rows.map((row) => ({ ...toUserRow(row.user), owned_projects: Number(row.ownedProjects) || 0 })),
      total: Number(totalRow?.count ?? 0)
    };
  }

  async createUser(input: CreateManagedUser): Promise<UserRow> {
    const [row] = await this.db.insert(schema.users).values({
      id: input.id,
      username: input.username,
      displayName: input.displayName,
      passwordHash: input.passwordHash,
      email: null,
      nuwaxSubject: null,
      avatarUrl: null,
      role: input.role,
      disabled: 0,
      mustChangePassword: 0,
      canCreateProjects: input.canCreateProjects,
      createdAt: input.createdAt
    }).returning();
    return toUserRow(row!);
  }

  async updateUser(input: {
    id: string;
    displayName: string;
    role: "admin" | "user";
    disabled: number;
    passwordHash: string;
    mustChangePassword: number;
    canCreateProjects: number;
  }): Promise<UserRow | null> {
    const [row] = await this.db.update(schema.users).set({
      displayName: input.displayName,
      role: input.role,
      disabled: input.disabled,
      passwordHash: input.passwordHash,
      mustChangePassword: input.mustChangePassword,
      canCreateProjects: input.canCreateProjects
    }).where(eq(schema.users.id, input.id)).returning();
    return row ? toUserRow(row) : null;
  }

  async suspendUserForDeletion(userId: string, createdAt: string): Promise<UserDeletionSuspension> {
    return await this.db.transaction(async (tx) => {
      const [target] = await tx.select({
        id: schema.users.id,
        role: schema.users.role,
        disabled: schema.users.disabled
      }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
      if (!target) return { status: "not_found" };
      if (target.role === "admin") {
        const [countRow] = await tx.select({ count: sql<string>`count(*)` })
          .from(schema.users)
          .where(and(eq(schema.users.role, "admin"), eq(schema.users.disabled, 0)));
        if (Number(countRow?.count ?? 0) <= 1) return { status: "last_admin" };
      }
      await tx.insert(schema.userDeletionStaging).values({
        userId,
        originalDisabled: target.disabled,
        createdAt
      }).onConflictDoUpdate({
        target: schema.userDeletionStaging.userId,
        set: { originalDisabled: target.disabled, createdAt }
      });
      await tx.update(schema.users).set({ disabled: 1 }).where(eq(schema.users.id, userId));
      return { status: "suspended", originalDisabled: target.disabled };
    });
  }

  async finalizeUserDeletion(userId: string): Promise<boolean> {
    return await this.db.transaction(async (tx) => {
      await tx.delete(schema.projects).where(eq(schema.projects.ownerId, userId));
      const deleted = await tx.delete(schema.users).where(eq(schema.users.id, userId)).returning({ id: schema.users.id });
      await tx.delete(schema.userDeletionStaging).where(eq(schema.userDeletionStaging.userId, userId));
      return deleted.length > 0;
    });
  }

  async restoreStagedUserDeletion(userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [staged] = await tx.select({ originalDisabled: schema.userDeletionStaging.originalDisabled })
        .from(schema.userDeletionStaging)
        .where(eq(schema.userDeletionStaging.userId, userId))
        .limit(1);
      if (staged) {
        await tx.update(schema.users).set({ disabled: staged.originalDisabled }).where(eq(schema.users.id, userId));
      }
      await tx.delete(schema.userDeletionStaging).where(eq(schema.userDeletionStaging.userId, userId));
    });
  }

  async recoverInterruptedUserDeletions(): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await tx.select({
        userId: schema.userDeletionStaging.userId,
        originalDisabled: schema.userDeletionStaging.originalDisabled
      }).from(schema.userDeletionStaging)
        .orderBy(schema.userDeletionStaging.createdAt, schema.userDeletionStaging.userId);
      for (const row of rows) {
        await tx.update(schema.users).set({ disabled: row.originalDisabled })
          .where(eq(schema.users.id, row.userId));
        await tx.delete(schema.userDeletionStaging).where(eq(schema.userDeletionStaging.userId, row.userId));
      }
    });
  }
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
