import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, isNull, or, sql, type ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import * as schema from "../schema/postgres.js";

type ProjectMemberTransaction = NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;

export type MemberPermission = "read" | "edit";

export interface UserInvitationSummary {
  id: string;
  projectId: string;
  email: string | null;
  permission: MemberPermission;
  createdAt: string;
  recipientUsername: string | null;
  recipientDisplayName: string | null;
  projectName: string;
  ownerDisplayName: string;
  ownerUsername: string;
}

export interface ProjectInvitationSummary {
  id: string;
  email: string | null;
  permission: MemberPermission;
  createdAt: string;
  recipientUsername: string | null;
  recipientDisplayName: string | null;
}

export interface ProjectMemberSummary {
  id: string;
  username: string;
  email: string | null;
  displayName: string;
  permission: MemberPermission;
}

export interface InvitationRecord {
  id: string;
  projectId: string;
  permission: MemberPermission;
}

export interface UpsertInvitationInput {
  id: string;
  projectId: string;
  recipientUserId: string;
  email: string | null;
  permission: MemberPermission;
  invitedBy: string;
  createdAt: string;
}

/** Typed access to project membership and invitation state. */
export class PostgresProjectMemberRepository {
  private readonly invitationRecipient = alias(schema.users, "invitation_recipient");
  private readonly invitationOwner = alias(schema.users, "invitation_owner");

  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async listInvitationsForUser(userId: string, email: string | null): Promise<UserInvitationSummary[]> {
    const rows = await this.db.select({
      id: schema.projectInvitations.id,
      projectId: schema.projectInvitations.projectId,
      email: schema.projectInvitations.email,
      permission: schema.projectInvitations.permission,
      createdAt: schema.projectInvitations.createdAt,
      recipientUsername: this.invitationRecipient.username,
      recipientDisplayName: this.invitationRecipient.displayName,
      projectName: schema.projects.name,
      ownerDisplayName: this.invitationOwner.displayName,
      ownerUsername: this.invitationOwner.username
    })
      .from(schema.projectInvitations)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.projectInvitations.projectId))
      .innerJoin(this.invitationOwner, eq(this.invitationOwner.id, schema.projects.ownerId))
      .leftJoin(this.invitationRecipient, and(
        eq(this.invitationRecipient.id, schema.projectInvitations.recipientUserId),
        eq(this.invitationRecipient.disabled, 0)
      ))
      .where(and(
        eq(schema.projectInvitations.status, "pending"),
        invitationRecipientCondition(userId, email)
      ))
      .orderBy(desc(schema.projectInvitations.createdAt));

    return rows.map((row) => ({
      ...row,
      permission: asPermission(row.permission)
    }));
  }

  async findInvitationForUser(
    invitationId: string,
    userId: string,
    email: string | null
  ): Promise<InvitationRecord | null> {
    const [row] = await this.db.select({
      id: schema.projectInvitations.id,
      projectId: schema.projectInvitations.projectId,
      permission: schema.projectInvitations.permission
    })
      .from(schema.projectInvitations)
      .where(and(
        eq(schema.projectInvitations.id, invitationId),
        eq(schema.projectInvitations.status, "pending"),
        invitationRecipientCondition(userId, email)
      ))
      .limit(1);
    return row ? { ...row, permission: asPermission(row.permission) } : null;
  }

  async findProjectOwner(projectId: string): Promise<string | null> {
    const [row] = await this.db.select({ ownerId: schema.projects.ownerId })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .limit(1);
    return row?.ownerId ?? null;
  }

  async acceptInvitation(input: {
    invitationId: string;
    userId: string;
    email: string | null;
    respondedAt: string;
  }): Promise<{ projectId: string; permission: MemberPermission } | null> {
    return await this.db.transaction(async (tx) => {
      const [invitation] = await tx.select({
        id: schema.projectInvitations.id,
        projectId: schema.projectInvitations.projectId,
        permission: schema.projectInvitations.permission
      })
        .from(schema.projectInvitations)
        .where(and(
          eq(schema.projectInvitations.id, input.invitationId),
          eq(schema.projectInvitations.status, "pending"),
          invitationRecipientCondition(input.userId, input.email)
        ))
        .limit(1);
      if (!invitation) return null;

      const [project] = await tx.select({ ownerId: schema.projects.ownerId })
        .from(schema.projects)
        .where(eq(schema.projects.id, invitation.projectId))
        .limit(1);
      if (!project || project.ownerId === input.userId) return null;

      const permission = asPermission(invitation.permission);
      const updated = await tx.update(schema.projectInvitations)
        .set({ status: "accepted", respondedAt: input.respondedAt, recipientUserId: input.userId })
        .where(and(
          eq(schema.projectInvitations.id, invitation.id),
          eq(schema.projectInvitations.status, "pending")
        ))
        .returning({ id: schema.projectInvitations.id });
      if (!updated.length) return null;

      await tx.insert(schema.projectMembers).values({
        projectId: invitation.projectId,
        userId: input.userId,
        permission,
        createdAt: input.respondedAt
      }).onConflictDoUpdate({
        target: [schema.projectMembers.projectId, schema.projectMembers.userId],
        set: { permission }
      });
      await revokePendingInvitations(tx, invitation.projectId, input.userId, input.email, input.respondedAt);
      return { projectId: invitation.projectId, permission };
    });
  }

  async declineInvitation(input: {
    invitationId: string;
    userId: string;
    email: string | null;
    respondedAt: string;
  }): Promise<boolean> {
    return await this.db.transaction(async (tx) => {
      const updated = await tx.update(schema.projectInvitations)
        .set({ status: "declined", respondedAt: input.respondedAt, recipientUserId: input.userId })
        .where(and(
          eq(schema.projectInvitations.id, input.invitationId),
          eq(schema.projectInvitations.status, "pending"),
          invitationRecipientCondition(input.userId, input.email)
        ))
        .returning({ projectId: schema.projectInvitations.projectId });
      const invitation = updated[0];
      if (!invitation) return false;
      await revokePendingInvitations(tx, invitation.projectId, input.userId, input.email, input.respondedAt);
      return true;
    });
  }

  async listMembers(projectId: string): Promise<ProjectMemberSummary[]> {
    const rows = await this.db.select({
      id: schema.users.id,
      username: schema.users.username,
      email: schema.users.email,
      displayName: schema.users.displayName,
      permission: schema.projectMembers.permission
    })
      .from(schema.projectMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.projectMembers.userId))
      .where(eq(schema.projectMembers.projectId, projectId))
      .orderBy(schema.users.username);
    return rows.map((row) => ({ ...row, permission: asPermission(row.permission) }));
  }

  async listPendingInvitations(projectId: string): Promise<ProjectInvitationSummary[]> {
    const rows = await this.db.select({
      id: schema.projectInvitations.id,
      email: schema.projectInvitations.email,
      permission: schema.projectInvitations.permission,
      createdAt: schema.projectInvitations.createdAt,
      recipientUsername: this.invitationRecipient.username,
      recipientDisplayName: this.invitationRecipient.displayName
    })
      .from(schema.projectInvitations)
      .leftJoin(this.invitationRecipient, and(
        eq(this.invitationRecipient.id, schema.projectInvitations.recipientUserId),
        eq(this.invitationRecipient.disabled, 0)
      ))
      .where(and(
        eq(schema.projectInvitations.projectId, projectId),
        eq(schema.projectInvitations.status, "pending")
      ))
      .orderBy(desc(schema.projectInvitations.createdAt));
    return rows.map((row) => ({ ...row, permission: asPermission(row.permission) }));
  }

  async upsertInvitation(input: UpsertInvitationInput): Promise<string> {
    return await this.db.transaction(async (tx) => {
      const [pending] = await tx.select({ id: schema.projectInvitations.id })
        .from(schema.projectInvitations)
        .where(and(
          eq(schema.projectInvitations.projectId, input.projectId),
          eq(schema.projectInvitations.status, "pending"),
          eq(schema.projectInvitations.recipientUserId, input.recipientUserId)
        ))
        .orderBy(desc(schema.projectInvitations.createdAt), desc(schema.projectInvitations.id))
        .limit(1);
      const invitationId = pending?.id ?? input.id;
      if (pending) {
        await tx.update(schema.projectInvitations).set({
          recipientUserId: input.recipientUserId,
          email: input.email,
          permission: input.permission,
          invitedBy: input.invitedBy,
          createdAt: input.createdAt,
          respondedAt: null
        }).where(eq(schema.projectInvitations.id, invitationId));
      } else {
        await tx.insert(schema.projectInvitations).values({
          id: invitationId,
          projectId: input.projectId,
          recipientUserId: input.recipientUserId,
          email: input.email,
          permission: input.permission,
          invitedBy: input.invitedBy,
          status: "pending",
          createdAt: input.createdAt,
          respondedAt: null
        });
      }
      await revokePendingInvitations(tx, input.projectId, input.recipientUserId, input.email, input.createdAt, invitationId);
      return invitationId;
    });
  }

  async revokeInvitation(projectId: string, invitationId: string, respondedAt: string): Promise<boolean> {
    const rows = await this.db.update(schema.projectInvitations)
      .set({ status: "revoked", respondedAt })
      .where(and(
        eq(schema.projectInvitations.id, invitationId),
        eq(schema.projectInvitations.projectId, projectId),
        eq(schema.projectInvitations.status, "pending")
      ))
      .returning({ id: schema.projectInvitations.id });
    return rows.length > 0;
  }

  async setMemberPermission(input: {
    projectId: string;
    userId: string;
    permission: MemberPermission;
    email: string | null;
    changedAt: string;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(schema.projectMembers).values({
        projectId: input.projectId,
        userId: input.userId,
        permission: input.permission,
        createdAt: input.changedAt
      }).onConflictDoUpdate({
        target: [schema.projectMembers.projectId, schema.projectMembers.userId],
        set: { permission: input.permission }
      });
      await revokePendingInvitations(tx, input.projectId, input.userId, input.email, input.changedAt);
    });
  }

  async removeMember(input: {
    projectId: string;
    userId: string;
    email: string | null;
    changedAt: string;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(schema.projectMembers).where(and(
        eq(schema.projectMembers.projectId, input.projectId),
        eq(schema.projectMembers.userId, input.userId)
      ));
      await revokePendingInvitations(tx, input.projectId, input.userId, input.email, input.changedAt);
    });
  }
}

function invitationRecipientCondition(userId: string, email: string | null) {
  return email
    ? or(
      eq(schema.projectInvitations.recipientUserId, userId),
      and(
        isNull(schema.projectInvitations.recipientUserId),
        sql`lower(${schema.projectInvitations.email}) = lower(${email})`
      )
    )
    : eq(schema.projectInvitations.recipientUserId, userId);
}

function asPermission(value: string): MemberPermission {
  return value === "edit" ? "edit" : "read";
}

async function revokePendingInvitations(
  tx: ProjectMemberTransaction,
  projectId: string,
  userId: string,
  email: string | null,
  respondedAt: string,
  exceptId?: string
): Promise<void> {
  const match = email
    ? or(
      eq(schema.projectInvitations.recipientUserId, userId),
      and(
        isNull(schema.projectInvitations.recipientUserId),
        sql`lower(${schema.projectInvitations.email}) = lower(${email})`
      )
    )
    : eq(schema.projectInvitations.recipientUserId, userId);
  const conditions = [
    eq(schema.projectInvitations.projectId, projectId),
    eq(schema.projectInvitations.status, "pending"),
    match
  ];
  if (exceptId) conditions.push(sql`${schema.projectInvitations.id} <> ${exceptId}`);
  await tx.update(schema.projectInvitations)
    .set({ status: "revoked", respondedAt })
    .where(and(...conditions));
}
