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

export async function accessibleProject(
  db: DatabaseConnection,
  projectId: string,
  user: UserRow
): Promise<AccessibleProject | null> {
  return await db.projects.findAccessibleProject(projectId, user);
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
export async function canComment(db: DatabaseConnection, project: AccessibleProject, user: UserRow): Promise<boolean> {
  if (!user.share_link_id || project.owner_id === user.id) return true;
  return await db.projects.hasMember(project.id, user.id);
}
