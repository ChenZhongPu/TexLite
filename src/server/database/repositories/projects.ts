import { alias } from "drizzle-orm/pg-core";
import { and, eq, isNotNull, isNull, or, sql, type AnyColumn } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ProjectRow, UserRow } from "../../db.js";
import type { AccessibleProject, CollaborationProjectAccess, ProjectPermission } from "../../projects.js";
import * as schema from "../schema/postgres.js";

type ProjectPermissionValue = ProjectPermission;

/** Typed project authorization queries shared by HTTP and WebSocket paths. */
export class PostgresProjectRepository {
  private readonly owner = alias(schema.users, "project_owner");
  private readonly modifier = alias(schema.users, "project_modifier");
  private readonly member = alias(schema.projectMembers, "request_project_member");
  private readonly share = alias(schema.projectShareLinks, "request_project_share");

  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async findAccessibleProject(projectId: string, user: UserRow): Promise<AccessibleProject | null> {
    const [row] = await this.db.select({
      id: schema.projects.id,
      owner_id: schema.projects.ownerId,
      last_modified_by: schema.projects.lastModifiedBy,
      name: schema.projects.name,
      main_file: schema.projects.mainFile,
      engine: schema.projects.engine,
      icon: schema.projects.icon,
      created_at: schema.projects.createdAt,
      updated_at: schema.projects.updatedAt,
      permission: projectPermissionSql(schema.projects.ownerId, this.member.userId, this.member.permission, user.id),
      share_link_only: sql<number>`CASE WHEN ${this.share.id} IS NOT NULL
        AND ${this.member.userId} IS NULL AND ${schema.projects.ownerId} <> ${user.id}
        THEN 1 ELSE 0 END`,
      owner_username: this.owner.username,
      owner_display_name: this.owner.displayName,
      last_modified_username: this.modifier.username,
      last_modified_display_name: this.modifier.displayName
    })
      .from(schema.projects)
      .innerJoin(this.owner, eq(this.owner.id, schema.projects.ownerId))
      .leftJoin(this.modifier, eq(this.modifier.id, schema.projects.lastModifiedBy))
      .leftJoin(this.share, and(
        eq(this.share.id, user.share_link_id ?? ""),
        eq(this.share.projectId, schema.projects.id),
        eq(this.share.permission, "read"),
        isNull(this.share.revokedAt)
      ))
      .leftJoin(this.member, and(
        eq(this.member.projectId, schema.projects.id),
        eq(this.member.userId, user.id)
      ))
      .where(and(
        eq(schema.projects.id, projectId),
        or(
          eq(schema.projects.ownerId, user.id),
          isNotNull(this.member.userId),
          isNotNull(this.share.id)
        )
      ))
      .limit(1);

    return row ? toAccessibleProject(row) : null;
  }

  async findCollaborationAccess(projectId: string, user: UserRow): Promise<CollaborationProjectAccess | null> {
    const [row] = await this.db.select({
      permission: projectPermissionSql(schema.projects.ownerId, this.member.userId, this.member.permission, user.id)
    })
      .from(schema.projects)
      .leftJoin(this.share, and(
        eq(this.share.id, user.share_link_id ?? ""),
        eq(this.share.projectId, schema.projects.id),
        eq(this.share.permission, "read"),
        isNull(this.share.revokedAt)
      ))
      .leftJoin(this.member, and(
        eq(this.member.projectId, schema.projects.id),
        eq(this.member.userId, user.id)
      ))
      .where(and(
        eq(schema.projects.id, projectId),
        or(
          eq(schema.projects.ownerId, user.id),
          isNotNull(this.member.userId),
          isNotNull(this.share.id)
        )
      ))
      .limit(1);
    return row ? { permission: row.permission } : null;
  }

  async hasMember(projectId: string, userId: string): Promise<boolean> {
    const [row] = await this.db.select({ projectId: schema.projectMembers.projectId })
      .from(schema.projectMembers)
      .where(and(eq(schema.projectMembers.projectId, projectId), eq(schema.projectMembers.userId, userId)))
      .limit(1);
    return Boolean(row);
  }

  async listOwnedProjectIds(ownerId: string): Promise<string[]> {
    const rows = await this.db.select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.ownerId, ownerId));
    return rows.map((row) => row.id);
  }

  async findOwnerId(projectId: string): Promise<string | null> {
    const [row] = await this.db.select({ ownerId: schema.projects.ownerId })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .limit(1);
    return row?.ownerId ?? null;
  }

  async projectExists(projectId: string): Promise<boolean> {
    const [row] = await this.db.select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .limit(1);
    return Boolean(row);
  }

  async listProjectIds(): Promise<string[]> {
    const rows = await this.db.select({ id: schema.projects.id }).from(schema.projects);
    return rows.map((row) => row.id);
  }

  async findById(projectId: string): Promise<ProjectRow | null> {
    const [row] = await this.db.select().from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .limit(1);
    return row ? {
      id: row.id,
      owner_id: row.ownerId,
      last_modified_by: row.lastModifiedBy,
      name: row.name,
      main_file: row.mainFile,
      engine: row.engine as ProjectRow["engine"],
      icon: row.icon,
      created_at: row.createdAt,
      updated_at: row.updatedAt
    } : null;
  }
}

function projectPermissionSql(ownerId: AnyColumn, memberId: AnyColumn, memberPermission: AnyColumn, userId: string) {
  return sql<ProjectPermissionValue>`CASE
    WHEN ${ownerId} = ${userId} THEN 'owner'
    WHEN ${memberId} IS NOT NULL THEN ${memberPermission}
    ELSE 'read' END`;
}

function toAccessibleProject(row: {
  id: string;
  owner_id: string;
  last_modified_by: string | null;
  name: string;
  main_file: string;
  engine: string;
  icon: string | null;
  created_at: string;
  updated_at: string;
  permission: ProjectPermissionValue;
  share_link_only: number;
  owner_username: string;
  owner_display_name: string;
  last_modified_username: string | null;
  last_modified_display_name: string | null;
}): AccessibleProject {
  return {
    ...toProjectRow(row),
    permission: row.permission,
    share_link_only: Number(row.share_link_only) || 0,
    owner_username: row.owner_username,
    owner_display_name: row.owner_display_name,
    last_modified_username: row.last_modified_username,
    last_modified_display_name: row.last_modified_display_name
  };
}

function toProjectRow(row: {
  id: string;
  owner_id: string;
  last_modified_by: string | null;
  name: string;
  main_file: string;
  engine: string;
  icon: string | null;
  created_at: string;
  updated_at: string;
}): ProjectRow {
  return {
    id: row.id,
    owner_id: row.owner_id,
    last_modified_by: row.last_modified_by,
    name: row.name,
    main_file: row.main_file,
    engine: row.engine as ProjectRow["engine"],
    icon: row.icon,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}
