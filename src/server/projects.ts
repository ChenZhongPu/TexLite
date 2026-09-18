import type Database from "better-sqlite3";
import type { DatabaseConnection, UserRow, ProjectRow } from "./db.js";

export type ProjectPermission = "read" | "edit" | "owner";

/** The minimum authorization result needed by a project operation. */
export interface ProjectAccess {
  permission: ProjectPermission;
}

export interface AccessibleProject extends ProjectRow, ProjectAccess {
  share_link_only?: number;
  owner_username?: string;
  owner_display_name?: string;
  last_modified_username?: string | null;
  last_modified_display_name?: string | null;
}

/**
 * WebSocket messages need only the effective permission. Keeping this result
 * separate from AccessibleProject avoids loading project/list metadata for
 * every Yjs update or awareness cursor message.
 */
export interface CollaborationProjectAccess extends ProjectAccess {}

export type AccessibleProjectStatement = Database.Statement<
  [userIdForPermission: string, shareLinkOwnerUserId: string, shareLinkId: string, memberUserId: string, projectId: string, ownerUserId: string],
  AccessibleProject
>;

export type CollaborationProjectAccessStatement = Database.Statement<
  [ownerUserId: string, shareLinkId: string, memberUserId: string, projectId: string, accessUserId: string],
  CollaborationProjectAccess
>;

const ACCESSIBLE_PROJECT_SQL = `
  SELECT p.*,
    CASE WHEN p.owner_id = ? THEN 'owner'
      WHEN pm.user_id IS NOT NULL THEN pm.permission
      ELSE 'read' END AS permission,
    CASE WHEN share.id IS NOT NULL AND pm.user_id IS NULL AND p.owner_id <> ? THEN 1 ELSE 0 END AS share_link_only,
    owner.username AS owner_username, owner.display_name AS owner_display_name,
    modifier.username AS last_modified_username, modifier.display_name AS last_modified_display_name
  FROM projects p
  JOIN users owner ON owner.id = p.owner_id
  LEFT JOIN users modifier ON modifier.id = p.last_modified_by
  LEFT JOIN project_share_links share
    ON share.id = ? AND share.project_id = p.id AND share.permission = 'read' AND share.revoked_at IS NULL
  LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
  WHERE p.id = ? AND (p.owner_id = ? OR pm.user_id IS NOT NULL OR share.id IS NOT NULL)
`;

// This deliberately keeps the same access predicate as ACCESSIBLE_PROJECT_SQL
// while avoiding the owner/modifier display-name joins and the complete project
// row on the collaboration hot path.
const COLLABORATION_PROJECT_ACCESS_SQL = `
  SELECT CASE WHEN p.owner_id = ? THEN 'owner'
    WHEN pm.user_id IS NOT NULL THEN pm.permission
    ELSE 'read' END AS permission
  FROM projects p
  LEFT JOIN project_share_links share
    ON share.id = ? AND share.project_id = p.id AND share.permission = 'read' AND share.revoked_at IS NULL
  LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
  WHERE p.id = ? AND (p.owner_id = ? OR pm.user_id IS NOT NULL OR share.id IS NOT NULL)
`;

export function prepareAccessibleProjectStatement(db: DatabaseConnection): AccessibleProjectStatement {
  return db.prepare<
    [userIdForPermission: string, shareLinkOwnerUserId: string, shareLinkId: string, memberUserId: string, projectId: string, ownerUserId: string],
    AccessibleProject
  >(ACCESSIBLE_PROJECT_SQL);
}

export function prepareCollaborationProjectAccessStatement(
  db: DatabaseConnection
): CollaborationProjectAccessStatement {
  return db.prepare<
    [ownerUserId: string, shareLinkId: string, memberUserId: string, projectId: string, accessUserId: string],
    CollaborationProjectAccess
  >(COLLABORATION_PROJECT_ACCESS_SQL);
}

export function accessibleProjectFromStatement(
  statement: AccessibleProjectStatement,
  projectId: string,
  user: UserRow
): AccessibleProject | null {
  const row = statement.get(user.id, user.id, user.share_link_id ?? "", user.id, projectId, user.id);
  return row ?? null;
}

export function collaborationProjectAccessFromStatement(
  statement: CollaborationProjectAccessStatement,
  projectId: string,
  user: UserRow
): CollaborationProjectAccess | null {
  return statement.get(user.id, user.share_link_id ?? "", user.id, projectId, user.id) ?? null;
}

export function accessibleProject(
  db: DatabaseConnection,
  projectId: string,
  user: UserRow
): AccessibleProject | null {
  return accessibleProjectFromStatement(prepareAccessibleProjectStatement(db), projectId, user);
}

export function canEdit(project: ProjectAccess): boolean {
  return project.permission === "owner" || project.permission === "edit";
}

/**
 * Existing project members may continue to participate in comments even when
 * their stored project permission is read-only. A bearer read link, however,
 * must not become an anonymous comment credential: only users who are not
 * members of the linked project are blocked here.
 */
export function canComment(db: DatabaseConnection, project: AccessibleProject, user: UserRow): boolean {
  if (!user.share_link_id || project.owner_id === user.id) return true;
  return Boolean(db.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?")
    .get(project.id, user.id));
}
