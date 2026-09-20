import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.js";
import type { DatabaseConnection } from "../db.js";
import type {
  CitationLibraryRow,
  CitationLibraryTagRow,
  CitationTagColor
} from "../database/repositories/citations.js";
import { apiError, httpError, ValidationError } from "../http.js";
import { MAX_CITATION_BIBTEX_BYTES } from "../limits.js";

interface CitationRouteContext {
  db: DatabaseConnection;
}

const tagColors = ["red", "orange", "yellow", "green", "blue", "purple", "gray"] as const;
const now = (): string => new Date().toISOString();

function text(value: unknown, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new ValidationError();
  }
  return value.trim();
}

function citationJson(row: CitationLibraryRow, tags: CitationLibraryTagRow[] = []) {
  return {
    id: row.id,
    citationKey: row.citation_key,
    entryType: row.entry_type,
    bibtex: row.bibtex,
    title: row.title,
    authors: row.authors,
    year: row.year,
    revision: row.revision,
    tags: tags.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color, ownerId: tag.user_id })),
    ownerId: row.user_id,
    ownerUsername: row.owner_username ?? null,
    ownerDisplayName: row.owner_display_name ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function citationTagsForEntries(db: DatabaseConnection, entryIds: string[]): Promise<Map<string, CitationLibraryTagRow[]>> {
  return await db.citations.tagsForEntries(entryIds);
}

async function citationTagIds(db: DatabaseConnection, userId: string, value: unknown): Promise<string[] | null> {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new ValidationError();
  const ids = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
  if (ids.length > 100) throw new ValidationError();
  if (!ids.length) return [];
  const found = await db.citations.tagIdsForUser(userId, ids);
  if (found.length !== ids.length) throw httpError(404, "CITATION_TAG_NOT_FOUND");
  return found;
}

function citationTagName(value: unknown): string {
  return text(value, 32);
}

function citationExpectedRevision(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new ValidationError();
  }
  return Number(value);
}

interface CitationInput {
  bibtex: string;
  citationKey: string;
  entryType: string;
  title: string | null;
  authors: string | null;
  year: string | null;
}

function citationNullableText(value: unknown, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > max) throw new ValidationError();
  const trimmed = value.trim();
  return trimmed || null;
}

function citationInput(value: unknown): CitationInput {
  if (typeof value !== "object" || value === null) throw new ValidationError();
  const body = value as Record<string, unknown>;
  if (typeof body.bibtex !== "string" || !body.bibtex.trim()) {
    throw new ValidationError();
  }
  if (Buffer.byteLength(body.bibtex, "utf8") > MAX_CITATION_BIBTEX_BYTES) {
    throw httpError(413, "CITATION_TOO_LARGE");
  }
  if (typeof body.citationKey !== "string" || !body.citationKey.trim() || body.citationKey.length > 512) {
    throw new ValidationError();
  }
  if (typeof body.entryType !== "string" || !body.entryType.trim() || body.entryType.length > 128) {
    throw new ValidationError();
  }
  return {
    bibtex: body.bibtex.trim(),
    citationKey: body.citationKey.trim(),
    entryType: body.entryType.trim(),
    title: citationNullableText(body.title, 2048),
    authors: citationNullableText(body.authors, 2048),
    year: citationNullableText(body.year, 128)
  };
}

/** Register the current user's private citation-library routes. */
export function registerCitationRoutes(app: FastifyInstance, context: CitationRouteContext): void {
  const { db } = context;

  app.get("/api/citations", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const query = request.query as { q?: string; tag?: string; page?: string; pageSize?: string; limit?: string };
    const search = typeof query.q === "string" ? query.q.trim() : "";
    const tagId = typeof query.tag === "string" ? query.tag.trim() : "";
    const requestedPage = Number.parseInt(query.page ?? "1", 10);
    const requestedPageSize = Number.parseInt(query.pageSize ?? query.limit ?? "60", 10);
    const pageSize = Math.min(200, Math.max(1, Number.isFinite(requestedPageSize) ? requestedPageSize : 60));
    const firstPage = Number.isFinite(requestedPage) ? Math.max(1, requestedPage) : 1;
    const preliminary = await db.citations.listEntries({
      userId: user.id,
      search,
      tagId,
      page: firstPage,
      pageSize
    });
    const total = preliminary.total;
    const totalPages = total > 0 ? Math.ceil(total / pageSize) : 0;
    const page = totalPages > 0 ? Math.min(Math.max(1, Number.isFinite(requestedPage) ? requestedPage : 1), totalPages) : 1;
    const rows = page === firstPage ? preliminary.rows : (await db.citations.listEntries({
      userId: user.id,
      search,
      tagId,
      page,
      pageSize
    })).rows;
    const tags = await citationTagsForEntries(db, rows.map((row) => row.id));
    return {
      entries: rows.map((row) => citationJson(row, tags.get(row.id) ?? [])),
      pagination: { page, pageSize, total, totalPages }
    };
  });

  app.get("/api/citations/tags", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const tags = await db.citations.listTags(user.id);
    return { tags: tags.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color, ownerId: tag.user_id })) };
  });

  app.post("/api/citations/tags", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const body = request.body as { name?: unknown; color?: unknown } | undefined;
    const name = citationTagName(body?.name);
    const color = tagColors.includes(body?.color as typeof tagColors[number]) ? body?.color as CitationTagColor : "gray";
    const result = await db.citations.ensureTag({ id: randomUUID(), userId: user.id, name, color, createdAt: now() });
    const tag = { id: result.tag.id, name: result.tag.name, color: result.tag.color, ownerId: result.tag.user_id };
    return reply.code(result.created ? 201 : 200).send({ tag, created: result.created });
  });

  app.delete("/api/citations/tags/:tagId", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { tagId } = request.params as { tagId: string };
    if (!await db.citations.deleteTag(user.id, tagId)) return apiError(reply, 404, "CITATION_TAG_NOT_FOUND");
    return { ok: true };
  });

  // Keep the old settings endpoint explicit so stale clients cannot accidentally
  // reinterpret "settings" as a citation id. Citation libraries are always private.
  app.patch("/api/citations/settings", async (request, reply) => {
    if (!(await requireUser(request, reply, db))) return;
    return apiError(reply, 403, "CITATION_LIBRARY_PRIVATE");
  });

  app.post("/api/citations/lookup", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const body = request.body as { keys?: unknown } | undefined;
    if (!Array.isArray(body?.keys) || body.keys.length > 5000
      || body.keys.some((key) => typeof key !== "string" || !key.trim() || key.length > 512)) {
      throw new ValidationError();
    }
    const keys = [...new Map(body.keys.map((key) => [key.trim().toLowerCase(), key.trim()] as const)).values()];
    const matches: Array<{ id: string; citation_key: string; revision: number }> = [];
    for (let offset = 0; offset < keys.length; offset += 500) {
      const chunk = keys.slice(offset, offset + 500);
      matches.push(...await db.citations.lookup(user.id, chunk));
    }
    return { matches: matches.map((match) => ({ id: match.id, citationKey: match.citation_key, revision: match.revision })) };
  });

  app.post("/api/citations", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const body = request.body as { bibtex?: unknown; citationKey?: unknown; entryType?: unknown; title?: unknown; authors?: unknown; year?: unknown; tagIds?: unknown; overwrite?: unknown; expectedRevision?: unknown } | undefined;
    const citation = citationInput(body);
    const tagIds = await citationTagIds(db, user.id, body?.tagIds);
    const overwrite = body?.overwrite === true;
    const existing = await db.citations.findByKey(user.id, citation.citationKey);
    if (existing && !overwrite) return apiError(reply, 409, "CITATION_KEY_EXISTS");
    const expectedRevision = existing ? citationExpectedRevision(body?.expectedRevision) : null;
    if (existing && existing.revision !== expectedRevision) {
      return apiError(reply, 409, "CITATION_CONFLICT");
    }
    const id = existing?.id ?? randomUUID();
    const timestamp = now();
    const saved = await db.citations.saveEntry({
      id,
      userId: user.id,
      existingId: existing?.id,
      expectedRevision: expectedRevision ?? undefined,
      citationKey: citation.citationKey,
      entryType: citation.entryType,
      bibtex: citation.bibtex,
      title: citation.title,
      authors: citation.authors,
      year: citation.year,
      tagIds,
      timestamp
    });
    if (!saved) return apiError(reply, 409, "CITATION_CONFLICT");
    const row = await db.citations.findById(id, user.id);
    if (!row) return apiError(reply, 404, "CITATION_NOT_FOUND");
    const tags = await citationTagsForEntries(db, [id]);
    return reply.code(existing ? 200 : 201).send({ entry: citationJson(row, tags.get(id) ?? []), updated: Boolean(existing) });
  });

  app.patch("/api/citations/:citationId/tags", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { citationId } = request.params as { citationId: string };
    const existing = await db.citations.findById(citationId, user.id);
    if (!existing) return apiError(reply, 404, "CITATION_NOT_FOUND");
    const body = request.body as { tagIds?: unknown; expectedRevision?: unknown } | undefined;
    const tagIds = await citationTagIds(db, user.id, body?.tagIds);
    if (tagIds === null) throw new ValidationError();
    const expectedRevision = citationExpectedRevision(body?.expectedRevision);
    const timestamp = now();
    const tagUpdate = await db.citations.updateTags({
      id: citationId,
      userId: user.id,
      expectedRevision,
      tagIds,
      timestamp
    });
    if (tagUpdate === "not_found") return apiError(reply, 404, "CITATION_NOT_FOUND");
    if (tagUpdate === "conflict") return apiError(reply, 409, "CITATION_CONFLICT");
    const row = await db.citations.findById(citationId, user.id);
    if (!row) return apiError(reply, 404, "CITATION_NOT_FOUND");
    const tags = await citationTagsForEntries(db, [citationId]);
    return { entry: citationJson(row, tags.get(citationId) ?? []) };
  });

  app.patch("/api/citations/:citationId", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { citationId } = request.params as { citationId: string };
    const existing = await db.citations.findById(citationId, user.id);
    if (!existing) return apiError(reply, 404, "CITATION_NOT_FOUND");
    const body = request.body as { bibtex?: unknown; citationKey?: unknown; entryType?: unknown; title?: unknown; authors?: unknown; year?: unknown; expectedRevision?: unknown } | undefined;
    const citation = citationInput(body);
    const expectedRevision = citationExpectedRevision(body?.expectedRevision);
    const duplicate = await db.citations.findByKey(user.id, citation.citationKey);
    if (duplicate && duplicate.id !== citationId) return apiError(reply, 409, "CITATION_KEY_EXISTS");
    const saved = await db.citations.saveEntry({
      id: citationId,
      userId: user.id,
      existingId: citationId,
      expectedRevision,
      citationKey: citation.citationKey,
      entryType: citation.entryType,
      bibtex: citation.bibtex,
      title: citation.title,
      authors: citation.authors,
      year: citation.year,
      tagIds: null,
      timestamp: now()
    });
    if (!saved) return apiError(reply, 409, "CITATION_CONFLICT");
    const updated = await db.citations.findById(citationId, user.id);
    if (!updated) return apiError(reply, 404, "CITATION_NOT_FOUND");
    const tags = await citationTagsForEntries(db, [citationId]);
    return { entry: citationJson(updated, tags.get(citationId) ?? []) };
  });

  app.delete("/api/citations/:citationId", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { citationId } = request.params as { citationId: string };
    if (!await db.citations.deleteEntry(citationId, user.id)) return apiError(reply, 404, "CITATION_NOT_FOUND");
    return { ok: true };
  });
}
