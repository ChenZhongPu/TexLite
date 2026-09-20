import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresOrmDatabaseConnection } from "./connection.js";
import { PostgresIdentityRepository } from "./repositories/identity.js";
import { PostgresProjectRepository } from "./repositories/projects.js";
import { PostgresShareLinkRepository } from "./repositories/shareLinks.js";
import { PostgresNuwaxTokenRepository } from "./repositories/nuwaxTokens.js";
import { PostgresAdministratorRepository } from "./repositories/admin.js";
import { PostgresProjectMemberRepository } from "./repositories/projectMembers.js";
import { PostgresProjectDataRepository } from "./repositories/projectData.js";
import { PostgresCommentMentionRepository } from "./repositories/commentMentions.js";
import { PostgresCommentRepository } from "./repositories/comments.js";
import { PostgresCompileRunRepository } from "./repositories/compileRuns.js";
import { PostgresProjectCatalogRepository } from "./repositories/projectCatalog.js";
import { PostgresProjectDirectoryStagingRepository } from "./repositories/projectDirectoryStaging.js";
import { PostgresEditHistoryRepository } from "./repositories/editHistory.js";
import { PostgresHistoryRepository } from "./repositories/history.js";
import { PostgresCitationRepository } from "./repositories/citations.js";
import * as schema from "./schema/postgres.js";

/** PostgreSQL runtime services backed exclusively by typed Drizzle repositories. */
export class PostgresRuntimeDatabase {
  readonly driver = "postgresql" as const;
  readonly orm: NodePgDatabase<typeof schema>;
  /** Typed identity/session access used by authentication and request auth. */
  readonly identity: PostgresIdentityRepository;
  /** Typed project access checks shared by HTTP and collaboration. */
  readonly projects: PostgresProjectRepository;
  /** Typed bearer-link lookup used to attach request-scoped access. */
  readonly shareLinks: PostgresShareLinkRepository;
  /** Encrypted Nuwax access/refresh token storage. */
  readonly nuwaxTokens: PostgresNuwaxTokenRepository;
  /** Typed administrator/user-management queries. */
  readonly administrators: PostgresAdministratorRepository;
  /** Typed project membership and invitation queries. */
  readonly projectMembers: PostgresProjectMemberRepository;
  /** Typed project-list metadata and aggregate queries. */
  readonly projectData: PostgresProjectDataRepository;
  /** Typed @mention candidate and notification queries. */
  readonly commentMentions: PostgresCommentMentionRepository;
  /** Typed comment/reply read queries. */
  readonly comments: PostgresCommentRepository;
  /** Typed compile queue and run-state queries. */
  readonly compileRuns: PostgresCompileRunRepository;
  /** Typed project metadata, tags, archives, and dictionary queries. */
  readonly projectCatalog: PostgresProjectCatalogRepository;
  /** Typed journal access for reversible directory moves. */
  readonly projectDirectoryStaging: PostgresProjectDirectoryStagingRepository;
  /** Typed bounded collaboration edit-history access. */
  readonly editHistory: PostgresEditHistoryRepository;
  /** Typed immutable project snapshot and recovery-history access. */
  readonly history: PostgresHistoryRepository;
  /** Typed private citation-library access. */
  readonly citations: PostgresCitationRepository;
  constructor(private readonly connection: PostgresOrmDatabaseConnection) {
    this.orm = connection.orm;
    this.identity = new PostgresIdentityRepository(this.orm);
    this.projects = new PostgresProjectRepository(this.orm);
    this.shareLinks = new PostgresShareLinkRepository(this.orm);
    this.nuwaxTokens = new PostgresNuwaxTokenRepository(this.orm);
    this.administrators = new PostgresAdministratorRepository(this.orm);
    this.projectMembers = new PostgresProjectMemberRepository(this.orm);
    this.projectData = new PostgresProjectDataRepository(this.orm);
    this.commentMentions = new PostgresCommentMentionRepository(this.orm);
    this.comments = new PostgresCommentRepository(this.orm);
    this.compileRuns = new PostgresCompileRunRepository(this.orm);
    this.projectCatalog = new PostgresProjectCatalogRepository(this.orm);
    this.projectDirectoryStaging = new PostgresProjectDirectoryStagingRepository(this.orm);
    this.editHistory = new PostgresEditHistoryRepository(this.orm);
    this.history = new PostgresHistoryRepository(this.orm);
    this.citations = new PostgresCitationRepository(this.orm);
  }

  async close(): Promise<void> {
    await this.connection.close();
  }
}
