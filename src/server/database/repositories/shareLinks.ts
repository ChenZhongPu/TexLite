import { and, desc, eq, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { digestToken } from "../../security.js";
import * as schema from "../schema/postgres.js";

export interface ActiveShareLinkRecord {
  id: string;
  project_id: string;
  permission: "read";
  created_at: string;
  token_ciphertext: string;
}

export interface ProjectShareLinkRecord {
  id: string;
  permission: "read";
  createdAt: string;
  tokenCiphertext: string;
}

/** Bearer-link lookup kept in a typed repository to avoid raw access checks. */
export class PostgresShareLinkRepository {
  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async findActiveByToken(token: string): Promise<ActiveShareLinkRecord | null> {
    if (token.length < 32 || token.length > 256) return null;
    const [row] = await this.db.select({
      id: schema.projectShareLinks.id,
      project_id: schema.projectShareLinks.projectId,
      permission: schema.projectShareLinks.permission,
      created_at: schema.projectShareLinks.createdAt,
      token_ciphertext: schema.projectShareLinks.tokenCiphertext
    })
      .from(schema.projectShareLinks)
      .where(and(
        eq(schema.projectShareLinks.tokenHash, digestToken(token)),
        eq(schema.projectShareLinks.permission, "read"),
        isNull(schema.projectShareLinks.revokedAt)
      ))
      .limit(1);
    return row?.permission === "read" ? { ...row, permission: "read" } : null;
  }

  async listActiveForProject(projectId: string): Promise<ProjectShareLinkRecord[]> {
    const rows = await this.db.select({
      id: schema.projectShareLinks.id,
      permission: schema.projectShareLinks.permission,
      createdAt: schema.projectShareLinks.createdAt,
      tokenCiphertext: schema.projectShareLinks.tokenCiphertext
    })
      .from(schema.projectShareLinks)
      .where(and(
        eq(schema.projectShareLinks.projectId, projectId),
        eq(schema.projectShareLinks.permission, "read"),
        isNull(schema.projectShareLinks.revokedAt)
      ))
      .orderBy(desc(schema.projectShareLinks.createdAt));
    return rows.map((row) => ({ ...row, permission: "read" }));
  }

  async create(input: {
    id: string;
    projectId: string;
    tokenHash: string;
    tokenCiphertext: string;
    createdBy: string;
    createdAt: string;
  }): Promise<void> {
    await this.db.insert(schema.projectShareLinks).values({
      id: input.id,
      projectId: input.projectId,
      tokenHash: input.tokenHash,
      tokenCiphertext: input.tokenCiphertext,
      permission: "read",
      createdBy: input.createdBy,
      createdAt: input.createdAt,
      revokedAt: null
    });
  }

  async revoke(projectId: string, linkId: string, revokedAt: string): Promise<boolean> {
    const rows = await this.db.update(schema.projectShareLinks)
      .set({ revokedAt })
      .where(and(
        eq(schema.projectShareLinks.id, linkId),
        eq(schema.projectShareLinks.projectId, projectId),
        isNull(schema.projectShareLinks.revokedAt)
      ))
      .returning({ id: schema.projectShareLinks.id });
    return rows.length > 0;
  }
}
