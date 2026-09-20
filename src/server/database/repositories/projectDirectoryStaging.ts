import { asc, and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../schema/postgres.js";

export interface ProjectDirectoryStagingRecord {
  project_id: string;
  trash_name: string;
}

/** Typed journal access for reversible project-directory moves. */
export class PostgresProjectDirectoryStagingRepository {
  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async stage(projectId: string, trashName: string, createdAt: string): Promise<void> {
    await this.db.insert(schema.projectDirectoryStaging).values({ projectId, trashName, createdAt });
  }

  async clear(projectId: string, trashName: string): Promise<void> {
    await this.db.delete(schema.projectDirectoryStaging).where(and(
      eq(schema.projectDirectoryStaging.projectId, projectId),
      eq(schema.projectDirectoryStaging.trashName, trashName)
    ));
  }

  async list(): Promise<ProjectDirectoryStagingRecord[]> {
    return await this.db.select({
      project_id: schema.projectDirectoryStaging.projectId,
      trash_name: schema.projectDirectoryStaging.trashName
    })
      .from(schema.projectDirectoryStaging)
      .orderBy(asc(schema.projectDirectoryStaging.createdAt), asc(schema.projectDirectoryStaging.projectId));
  }
}
