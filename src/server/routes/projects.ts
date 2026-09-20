import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.js";
import { maxCollaborativeFileBytes, type CollaborationService } from "../collaboration.js";
import type { Config } from "../config.js";
import type { DatabaseConnection, ProjectRow } from "../db.js";
import {
  createProjectFiles,
  defaultProjectSourceBytes,
  duplicateProjectFiles,
  outputRoot,
  purgePersistedProjectDirectoryRemoval,
  removeProjectDirectory,
  restorePersistedProjectDirectoryRemoval,
  resolveSourcePath,
  safeRelativePath,
  stagePersistedProjectDirectoryRemoval,
  sourceRoot,
  type StagedProjectDirectoryRemoval
} from "../files.js";
import type { HistoryReason } from "../history.js";
import { apiError, contentDisposition, httpError } from "../http.js";
import { isMainDocumentCandidate } from "../latexRoot.js";
import { lucideIconSvg, resolveLucideIconName } from "../lucideIcons.js";
import type { LatexCompletionService } from "../latexCompletion.js";
import type { ProjectMutationCoordinator } from "../projectMutations.js";
import type { ProjectQuotaService } from "../projectQuota.js";
import type { ProjectOutlineService } from "../projectOutline.js";
import { accessibleProject, canEdit } from "../projects.js";
import { writeProjectArchive } from "../archive.js";
import { extractProjectZip, projectZipSourceBytes, ZipValidationError } from "../zip.js";
import { HarperLintSupersededError, HarperUnavailableError, type HarperService } from "../harper.js";
import { digestToken } from "../security.js";
import { supportsWritingChecks } from "../../shared/writingChecks.js";
import { unreadMentionCountsForProjects } from "../commentMentions.js";
import {
  commentsSummaryForProject,
  commentsSummaryForProjects,
  dictionaryWord,
  now,
  ProjectTag,
  projectJson,
  requireActiveUser,
  requireProjectOwnerPermission,
  tagColors,
  tagsForProject,
  tagsForProjects,
  text
} from "./projectShared.js";

interface ProjectCatalogRouteContext {
  config: Config;
  db: DatabaseConnection;
  collaboration: CollaborationService;
  projectMutations: ProjectMutationCoordinator;
  latexCompletions: LatexCompletionService;
  projectOutlines: ProjectOutlineService;
  harper: HarperService;
  projectQuota: ProjectQuotaService;
  recordHistory: (projectId: string, userId: string | null, reason: HistoryReason, paths?: readonly string[]) => unknown;
}

const clientIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** Register project catalog, metadata, archive, dictionary, tag, export, and deletion routes. */
export function registerProjectCatalogRoutes(app: FastifyInstance, context: ProjectCatalogRouteContext): void {
  const { config, db, collaboration, projectMutations, latexCompletions, projectOutlines, harper, projectQuota, recordHistory } = context;

  // Advanced project icons are served as cacheable SVG masks. The browser
  // therefore does not have to bundle Lucide's entire icon catalogue merely
  // because an owner selected an icon outside the curated picker.
  app.get("/api/project-icons/:name", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { name } = request.params as { name: string };
    const iconName = resolveLucideIconName(name);
    if (!iconName) return apiError(reply, 404, "PROJECT_ICON_INVALID");
    const svg = await lucideIconSvg(iconName);
    if (!svg) return apiError(reply, 404, "PROJECT_ICON_INVALID");
    return reply
      .header("Cache-Control", "private, max-age=604800")
      .type("image/svg+xml; charset=utf-8")
      .send(svg);
  });

  app.get("/api/tags", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    return { tags: await db.projectCatalog.listTags(user.id) };
  });

  /**
   * Return the current user's tag catalog together with usage counts.  This is
   * intentionally separate from /api/tags: the lightweight catalog is loaded
   * with every project-list refresh, while counts are only needed by the tag
   * management dialog.
   */
  app.get("/api/tags/management", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    return {
      tags: await db.projectCatalog.listTagsManagement(user.id)
    };
  });

  app.post("/api/tags", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const body = (request.body ?? {}) as { name?: unknown; color?: unknown };
    const name = text(body.name, 32);
    const color = tagColors.includes(body.color as typeof tagColors[number])
      ? body.color as typeof tagColors[number] : "gray";
    const tag: ProjectTag = { id: randomUUID(), name, color };
    const createdAt = now();
    if (await db.projectCatalog.tagNameTaken(user.id, tag.name)) {
      return apiError(reply, 409, "TAG_NAME_EXISTS");
    }
    await db.projectCatalog.createTag({ id: tag.id, name: tag.name, color: tag.color, userId: user.id, createdAt });
    return reply.code(201).send({ tag });
  });

  app.patch("/api/tags/:tagId", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { tagId } = request.params as { tagId: string };
    const body = (request.body ?? {}) as { name?: unknown; color?: unknown };
    const name = text(body.name, 32);
    const color = tagColors.includes(body.color as typeof tagColors[number])
      ? body.color as typeof tagColors[number] : "gray";
    const existing = await db.projectCatalog.userOwnsTag(user.id, tagId);
    if (!existing) return apiError(reply, 404, "TAG_NOT_FOUND");
    if (await db.projectCatalog.tagNameTaken(user.id, name, tagId)) {
      return apiError(reply, 409, "TAG_NAME_EXISTS");
    }
    await db.projectCatalog.updateTag({ id: tagId, name, color, updatedAt: now(), userId: user.id });
    return { tag: { id: tagId, name, color } satisfies ProjectTag };
  });

  app.delete("/api/tags/:tagId", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { tagId } = request.params as { tagId: string };
    const tag = await db.projectCatalog.findTag(user.id, tagId);
    if (!tag) return apiError(reply, 404, "TAG_NOT_FOUND");
    // Foreign-key cascading removes only this user's project/tag links. The
    // projects and their source files are deliberately left untouched.
    await db.projectCatalog.deleteTag(user.id, tag.id);
    return { deletedId: tag.id, projectCount: tag.projectCount };
  });

  app.get("/api/projects", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const query = request.query as { archived?: string; page?: string; pageSize?: string; search?: string; tag?: string; sort?: string };
    const archivedOnly = query.archived === "1" || query.archived === "true";
    const requestedPage = Number.parseInt(query.page ?? "1", 10);
    const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const requestedPageSize = Number.parseInt(query.pageSize ?? "20", 10);
    const pageSize = Math.min(100, Math.max(1, Number.isFinite(requestedPageSize) && requestedPageSize > 0 ? requestedPageSize : 20));
    const search = typeof query.search === "string" ? query.search.trim() : "";
    const tagId = typeof query.tag === "string" ? query.tag.trim() : "";
    // A read link is an explicit entry point, not a project-membership grant.
    // Keep link-only projects out of the catalog; they are still available
    // through GET /share/:token and the project-scoped access checks.
    const initialPage = await db.projectCatalog.listAccessibleProjects({
      userId: user.id,
      archivedOnly,
      search,
      tagId,
      sort: query.sort === "created" ? "created" : "updated",
      page,
      pageSize
    });
    const total = initialPage.total;
    const totalPages = Math.ceil(total / pageSize);
    const currentPage = totalPages === 0 ? 1 : Math.min(page, totalPages);
    const pageResult = currentPage === page
      ? initialPage
      : await db.projectCatalog.listAccessibleProjects({
        userId: user.id,
        archivedOnly,
        search,
        tagId,
        sort: query.sort === "created" ? "created" : "updated",
        page: currentPage,
        pageSize
      });
    const projects = pageResult.rows;
    const projectIds = projects.map((project) => project.id);
    const [projectTags, commentsSummaries, unreadMentionCounts] = await Promise.all([
      tagsForProjects(db, projectIds, user.id),
      commentsSummaryForProjects(db, projectIds),
      unreadMentionCountsForProjects(db, projectIds, user.id)
    ]);
    return {
      projects: projects.map((project) => projectJson(
        { ...project, archived: archivedOnly },
        projectTags.get(project.id) ?? [],
        commentsSummaries.get(project.id),
        unreadMentionCounts.get(project.id) ?? 0
      )),
      pagination: { page: currentPage, pageSize, total, totalPages }
    };
  });

  app.post("/api/projects", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    if (user.role !== "admin" && !user.can_create_projects) {
      return apiError(reply, 403, "PROJECT_CREATE_FORBIDDEN");
    }
    return await projectQuota.runForOwner(user.id, async () => {
      // A catalog operation may have waited behind an import, duplication, or
      // administrative deletion. Re-check the durable account status after
      // acquiring that owner queue so a newly disabled account cannot create a
      // project from an already-authenticated request.
      await requireActiveUser(db, user);
      const initialSourceBytes = defaultProjectSourceBytes();
      await projectQuota.assertCanCreate(user.id, initialSourceBytes);
      const body = request.body as Record<string, unknown>;
      const project: ProjectRow = {
        id: randomUUID(), owner_id: user.id, last_modified_by: user.id, name: text(body?.name, 120),
        main_file: "main.tex", engine: config.defaultEngine, icon: null, created_at: now(), updated_at: now()
      };
      createProjectFiles(config, project.id);
      try {
        await db.projectCatalog.createProject(project);
        projectQuota.setSourceBytes(user.id, project.id, initialSourceBytes);
      } catch (error) {
        await removeProjectDirectory(config, project.id);
        throw error;
      }
      recordHistory(project.id, user.id, "initial");
      return reply.code(201).send({ project: projectJson({
        ...project, permission: "owner", owner_username: user.username, owner_display_name: user.display_name,
        last_modified_username: user.username, last_modified_display_name: user.display_name
      }) });
    });
  });

  app.post("/api/projects/import", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    if (user.role !== "admin" && !user.can_create_projects) {
      return apiError(reply, 403, "PROJECT_CREATE_FORBIDDEN");
    }
    const part = await request.file();
    if (!part || !part.filename.toLowerCase().endsWith(".zip")) {
      return apiError(reply, 400, "ZIP_ONLY");
    }
    const archive = await part.toBuffer();
    let importedSourceBytes: number;
    try {
      importedSourceBytes = await projectZipSourceBytes(archive, config.maxUploadBytes);
    } catch (error) {
      if (error instanceof ZipValidationError) return apiError(reply, 400, error.code, error.details);
      return apiError(reply, 400, "ZIP_INVALID");
    }
    return await projectQuota.runForOwner(user.id, async () => {
      await requireActiveUser(db, user);
      await projectQuota.assertCanCreate(user.id, importedSourceBytes);
      const query = request.query as { name?: string };
      const fallbackName = path.basename(part.filename, path.extname(part.filename));
      const project: ProjectRow = {
        id: randomUUID(), owner_id: user.id, last_modified_by: user.id, name: text(query.name || fallbackName, 120),
        main_file: "", engine: config.defaultEngine, icon: null, created_at: now(), updated_at: now()
      };
      fs.mkdirSync(sourceRoot(config, project.id), { recursive: true, mode: 0o700 });
      fs.mkdirSync(outputRoot(config, project.id), { recursive: true, mode: 0o700 });
      try {
        const extracted = await extractProjectZip(archive, sourceRoot(config, project.id), config.maxUploadBytes);
        project.main_file = extracted.mainFile;
        // Extraction is asynchronous. Re-check immediately before the durable
        // insert so concurrent writes to this account cannot race the initial
        // preflight and exceed either aggregate quota.
        await projectQuota.assertCanCreate(user.id, importedSourceBytes);
        await db.projectCatalog.createProject(project);
        // The archive was fully validated before the project row/directory was
        // created. Retain that authoritative byte count here instead of doing a
        // second filesystem walk that could throw after the database insert.
        projectQuota.setSourceBytes(user.id, project.id, importedSourceBytes);
      } catch (error) {
        await removeProjectDirectory(config, project.id);
        if (error instanceof ZipValidationError) return apiError(reply, 400, error.code, error.details);
        throw error;
      }
      recordHistory(project.id, user.id, "initial");
      return reply.code(201).send({ project: projectJson({
        ...project, permission: "owner", owner_username: user.username, owner_display_name: user.display_name,
        last_modified_username: user.username, last_modified_display_name: user.display_name
      }) });
    });
  });

  app.post("/api/projects/:id/duplicate", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    if (user.role !== "admin" && !user.can_create_projects) {
      return apiError(reply, 403, "PROJECT_CREATE_FORBIDDEN");
    }
    const { id } = request.params as { id: string };
    const source = await accessibleProject(db, id, user);
    if (!source) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const body = request.body as { name?: unknown } | undefined;
    const requestedName = typeof body?.name === "string" && body.name.trim() ? body.name : `${source.name.slice(0, 115)} (1)`;
    return await projectQuota.runForOwner(user.id, async () => {
      await requireActiveUser(db, user);
      const project: ProjectRow = {
        id: randomUUID(), owner_id: user.id, last_modified_by: user.id, name: text(requestedName, 120),
        main_file: source.main_file, engine: source.engine, icon: source.icon, created_at: now(), updated_at: now()
      };
      let duplicatedSourceBytes = 0;
      try {
        // Duplicate the source tree only after flushing the live Yjs room and
        // while a short source barrier prevents autosave from changing files
        // between directory entries. The copy is asynchronous, so a large
        // project does not block the Node.js event loop for its entire duration.
        await projectMutations.runConsistentRead(source.id, async () => {
          // The source tree is now durable and held behind the read barrier, so
          // use its exact byte count instead of trusting a pre-flush cache.
          duplicatedSourceBytes = projectQuota.refreshSourceBytes(source.owner_id, source.id);
          await projectQuota.assertCanCreate(user.id, duplicatedSourceBytes);
          return duplicateProjectFiles(config, source.id, project.id);
        }, {
          preflight: async () => {
            await requireActiveUser(db, user);
            if (!(await accessibleProject(db, source.id, user))) {
              throw httpError(404, "PROJECT_NOT_FOUND");
            }
          }
        });
        // Copying can yield to other source mutations. Re-check right before
        // inserting the project row, when the database count is authoritative.
        await projectQuota.assertCanCreate(user.id, duplicatedSourceBytes);
        await db.projectCatalog.createProject(project);
        projectQuota.setSourceBytes(user.id, project.id, duplicatedSourceBytes);
      } catch (error) {
        await removeProjectDirectory(config, project.id);
        throw error;
      }
      recordHistory(project.id, user.id, "initial");
      return reply.code(201).send({ project: projectJson({
        ...project, permission: "owner", owner_username: user.username, owner_display_name: user.display_name,
        last_modified_username: user.username, last_modified_display_name: user.display_name
      }) });
    });
  });

  app.get("/api/projects/:id", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = await accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    return {
      project: projectJson(
        project,
        await tagsForProject(db, id, user.id),
        await commentsSummaryForProject(db, id)
      )
    };
  });

  /** Project icons are shared metadata, so only the project owner can change them. */
  app.patch("/api/projects/:id/icon", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = await accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "PROJECT_OWNER_ONLY");
    const body = (request.body ?? {}) as { icon?: unknown };
    const icon = body.icon === null ? null : resolveLucideIconName(body.icon);
    if (body.icon !== null && !icon) {
      return apiError(reply, 400, "PROJECT_ICON_INVALID");
    }
    const changedAt = now();
    if (!await db.projectCatalog.setIcon({ id, ownerId: user.id, icon, updatedAt: changedAt, lastModifiedBy: user.id })) {
      return apiError(reply, 403, "PROJECT_OWNER_ONLY");
    }
    return {
      project: projectJson(
        (await accessibleProject(db, id, user))!,
        await tagsForProject(db, id, user.id),
        await commentsSummaryForProject(db, id)
      )
    };
  });

  app.put("/api/projects/:id/archive", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!(await accessibleProject(db, id, user))) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    await db.projectCatalog.archive(user.id, id, now());
    return { ok: true, archived: true };
  });

  app.delete("/api/projects/:id/archive", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!(await accessibleProject(db, id, user))) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    await db.projectCatalog.unarchive(user.id, id);
    return { ok: true, archived: false };
  });

  app.get("/api/projects/:id/dictionary", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!(await accessibleProject(db, id, user))) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    return { words: await db.projectCatalog.listDictionaryWords(id) };
  });

  app.post("/api/projects/:id/spellcheck", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!(await accessibleProject(db, id, user))) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const body = request.body as { path?: unknown; source?: unknown; clientId?: unknown; sequence?: unknown } | undefined;
    const source = body?.source;
    const sourcePath = body?.path;
    const clientId = body?.clientId;
    const sequence = body?.sequence;
    if (typeof source !== "string" || typeof sourcePath !== "string") {
      return apiError(reply, 400, "SPELLCHECK_SOURCE_INVALID");
    }
    // Accept already-open clients during a rolling update. Current clients
    // pair a page-local UUID with a monotonically increasing sequence so a
    // delayed HTTP request cannot replace a newer queued check.
    if (clientId !== undefined && (typeof clientId !== "string" || !clientIdPattern.test(clientId))) {
      return apiError(reply, 400, "SPELLCHECK_SOURCE_INVALID");
    }
    if (sequence !== undefined && (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence <= 0 || clientId === undefined)) {
      return apiError(reply, 400, "SPELLCHECK_SOURCE_INVALID");
    }
    if (Buffer.byteLength(source, "utf8") > maxCollaborativeFileBytes(config)) {
      return apiError(reply, 413, "SPELLCHECK_SOURCE_TOO_LARGE");
    }
    let filePath: string;
    try {
      filePath = safeRelativePath(sourcePath);
    } catch {
      return apiError(reply, 400, "SPELLCHECK_SOURCE_INVALID");
    }
    // Bibliography files are structured reference data rather than prose.
    // Keep this server-side guard for legacy clients and direct API callers.
    if (!supportsWritingChecks(filePath)) return { lints: [] };
    // A login session is shared by browser tabs. Pair the authenticated user
    // with the page-local client ID so each new editor can replace only its
    // own obsolete waiting work. Legacy clients retain their former session
    // grouping until their page is refreshed.
    const laneClientId = clientId ?? `legacy:${digestToken(request.cookies.texlite_session ?? "")}`;
    const lane = `${id}\0${user.id}\0${laneClientId}\0${filePath}`;
    try {
      return { lints: await harper.lint(source, filePath, lane, typeof sequence === "number" ? sequence : undefined) };
    } catch (error) {
      if (error instanceof HarperLintSupersededError) {
        return apiError(reply, 409, "SPELLCHECK_SUPERSEDED");
      }
      // Harper.js initialization failures are an expected fallback condition.
      // Keep them out of normal logs while preserving diagnostics otherwise.
      if (error instanceof HarperUnavailableError) request.log.debug({ projectId: id }, "Harper.js unavailable; using browser fallback");
      else request.log.error({ err: error, projectId: id }, "Harper writing check failed");
      return apiError(reply, 503, "HARPER_UNAVAILABLE");
    }
  });

  app.post("/api/projects/:id/dictionary", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = await accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    if (!canEdit(project)) return apiError(reply, 403, "DICTIONARY_EDIT_FORBIDDEN");
    const body = request.body as { word?: unknown } | undefined;
    const word = dictionaryWord(body?.word);
    await db.projectCatalog.addDictionaryWord({ projectId: id, word, createdBy: user.id, createdAt: now() });
    collaboration.signalDictionary(id);
    return reply.code(201).send({ word, words: await db.projectCatalog.listDictionaryWords(id) });
  });

  app.delete("/api/projects/:id/dictionary/:word", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id, word: rawWord } = request.params as { id: string; word: string };
    const project = await accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    if (!canEdit(project)) return apiError(reply, 403, "DICTIONARY_EDIT_FORBIDDEN");
    const word = dictionaryWord(rawWord);
    await db.projectCatalog.removeDictionaryWord(id, word);
    collaboration.signalDictionary(id);
    return { words: await db.projectCatalog.listDictionaryWords(id) };
  });

  app.patch("/api/projects/:id", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (collaboration.isMaintaining(id)) return apiError(reply, 409, "PROJECT_BUSY");
    const project = await accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "PROJECT_OWNER_ONLY");
    const body = request.body as Record<string, unknown>;
    return await projectMutations.runWrite(id, async () => {
      const currentProject = await accessibleProject(db, id, user);
      if (!currentProject || currentProject.permission !== "owner") {
        return apiError(reply, 403, "PROJECT_OWNER_ONLY");
      }
      const name = typeof body.name === "string" ? text(body.name, 120) : currentProject.name;
      let mainFile = currentProject.main_file;
      if (body.mainFile !== undefined) {
        if (typeof body.mainFile !== "string" || !body.mainFile.trim()) {
          return apiError(reply, 400, "MAIN_FILE_INVALID");
        }
        mainFile = safeRelativePath(body.mainFile);
      }
      const engine = typeof body.engine === "string" && config.allowedEngines.includes(body.engine as typeof currentProject.engine)
        ? body.engine as typeof currentProject.engine : currentProject.engine;
      if (!mainFile.toLocaleLowerCase().endsWith(".tex")) {
        return apiError(reply, 400, "MAIN_FILE_INVALID", { path: mainFile });
      }
      const mainFileAbsolute = resolveSourcePath(config, id, mainFile);
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(mainFileAbsolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return apiError(reply, 400, "MAIN_FILE_NOT_FOUND", { path: mainFile });
        }
        throw error;
      }
      if (!stat.isFile()) {
        return apiError(reply, 400, "MAIN_FILE_INVALID", { path: mainFile });
      }
      if (body.mainFile !== undefined && !await isMainDocumentCandidate(config, id, mainFile)) {
        return apiError(reply, 400, "MAIN_DOCUMENT_INVALID", { path: mainFile });
      }
      await db.projectCatalog.updateSettings({ id, name, mainFile, engine, updatedAt: now(), lastModifiedBy: user.id });
      recordHistory(id, user.id, "settings", []);
      return {
        project: projectJson(
          (await accessibleProject(db, id, user))!,
          await tagsForProject(db, id, user.id),
          await commentsSummaryForProject(db, id)
        )
      };
    }, { preflight: async () => { await requireProjectOwnerPermission(db, id, user); } });
  });

  app.post("/api/projects/:id/tags", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = await accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const body = request.body as { tagId?: unknown };
    if (typeof body.tagId !== "string" || !(await db.projectCatalog.userOwnsTag(user.id, body.tagId))) {
      return apiError(reply, 404, "TAG_NOT_FOUND");
    }
    await db.projectCatalog.linkTag(id, body.tagId, now());
    const tags = await tagsForProject(db, id, user.id);
    return reply.code(201).send({
      tags,
      project: projectJson(
        (await accessibleProject(db, id, user))!,
        tags,
        await commentsSummaryForProject(db, id)
      )
    });
  });

  app.delete("/api/projects/:id/tags/:tagId", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id, tagId } = request.params as { id: string; tagId: string };
    const project = await accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    await db.projectCatalog.unlinkTag(user.id, id, tagId);
    const tags = await tagsForProject(db, id, user.id);
    return {
      tags,
      project: projectJson(
        (await accessibleProject(db, id, user))!,
        tags,
        await commentsSummaryForProject(db, id)
      )
    };
  });

  app.get("/api/projects/:id/download", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = await accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const temporaryDirectory = path.join(config.dataDir, "tmp");
    const temporaryArchive = path.join(temporaryDirectory, `project-${id}-${randomUUID()}.zip`);
    try {
      await fs.promises.mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
      await projectMutations.runConsistentRead(id, () => writeProjectArchive(config, id, temporaryArchive), {
        preflight: async () => {
          const current = await accessibleProject(db, id, user);
          if (!current) throw httpError(404, "PROJECT_NOT_FOUND");
        }
      });
    } catch (error) {
      await fs.promises.rm(temporaryArchive, { force: true }).catch(() => undefined);
      throw error;
    }
    const filename = `${project.name}.zip`;
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", contentDisposition(filename, "attachment"));
    const stream = fs.createReadStream(temporaryArchive);
    const cleanup = () => { void fs.promises.rm(temporaryArchive, { force: true }).catch(() => undefined); };
    stream.once("close", cleanup);
    stream.once("error", cleanup);
    return reply.send(stream);
  });

  app.delete("/api/projects/:id", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = await accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    if (project.permission !== "owner") return apiError(reply, 403, "PROJECT_DELETE_FORBIDDEN");
    return await projectQuota.runForOwner(user.id, () => projectMutations.runExclusive(id, "project deletion", async () => {
      // Keep the last scanned byte count until the database row is gone. The
      // durable staging record then lets startup either restore or purge the
      // moved tree if this process exits between the filesystem and DB steps.
      projectQuota.refreshSourceBytes(user.id, id);
      let staged: StagedProjectDirectoryRemoval | null = null;
      try {
        staged = await stagePersistedProjectDirectoryRemoval(config, db, id);
        await db.projectCatalog.deleteProject(id);
      } catch (error) {
        if (staged) {
          try { await restorePersistedProjectDirectoryRemoval(db, staged); }
          catch (restoreError) { throw new AggregateError([error, restoreError], `Unable to restore project directory: ${id}`); }
        }
        throw error;
      }
      if (staged) {
        try { await purgePersistedProjectDirectoryRemoval(db, staged); }
        catch (error) { request.log.error({ err: error, projectId: id }, "Failed to purge deleted project trash"); }
      }
      latexCompletions.invalidate(id);
      projectOutlines.invalidate(id);
      return { ok: true };
    }, { preflight: async () => { await requireProjectOwnerPermission(db, id, user); } }));
  });
}
