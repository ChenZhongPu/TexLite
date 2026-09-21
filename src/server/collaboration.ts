import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { WebSocket, type RawData } from "ws";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  modifyAwarenessUpdate,
  removeAwarenessStates
} from "y-protocols/awareness";
import type { Config } from "./config.js";
import type { DatabaseConnection, UserRow } from "./db.js";
import { listProjectFilesAsync, outputRoot, resolveSourcePath, safeRelativePath, sourceRoot, type FileEntry } from "./files.js";
import {
  canEdit,
  type CollaborationProjectAccess
} from "./projects.js";
import { reanchorFileComments } from "./anchors.js";
import { ProjectQuotaService } from "./projectQuota.js";
import { hashText, type EditHistorySegmentInput, type EditHistorySpan, type EditHistoryStep } from "./editHistory.js";
import {
  COLLABORATION_PROTOCOL_VERSION,
  CollaborationMessageType,
  isCollaborationCleanMode,
  isCollaborationCompileStatus,
  type CollaborationSaveReceipt,
  type SharedCompileState,
  type SharedCompileStates
} from "../shared/collaborationProtocol.js";
import { isAiContextFilePath, type AiOperation } from "../shared/aiProtocol.js";

export { COLLABORATION_PROTOCOL_VERSION } from "../shared/collaborationProtocol.js";
export type { CollaborationSaveReceipt, SharedCompileState, SharedCompileStates } from "../shared/collaborationProtocol.js";

const {
  Sync: MESSAGE_SYNC,
  Awareness: MESSAGE_AWARENESS,
  QueryAwareness: MESSAGE_QUERY_AWARENESS,
  Flush: MESSAGE_FLUSH,
  Protocol: MESSAGE_PROTOCOL,
  Maintenance: MESSAGE_MAINTENANCE,
  Permission: MESSAGE_PERMISSION,
  CompileStates: MESSAGE_COMPILE_STATES,
  FormatLease: MESSAGE_FORMAT_LEASE
} = CollaborationMessageType;
/**
 * Increment this when a wire-level collaboration change cannot be decoded by
 * an older browser. The epoch marker is rotated at the same time, which makes
 * already-open older pages discard their local draft and reload safely.
 */
const VERSIONED_EPOCH_PREFIX = `${COLLABORATION_PROTOCOL_VERSION}:`;
const SOURCE_PREFIX = "source:";
const MAX_PROJECT_SESSIONS = 10;
const MAX_COLLABORATIVE_FILE_BYTES = 5 * 1024 * 1024;
const DISK_ORIGIN = Symbol("disk");
const HTTP_ORIGIN = Symbol("http");
const META_ORIGIN = Symbol("meta");
const SAVE_DELAY_MS = 750;
const STATE_SAVE_DELAY_MS = 750;
const ROOM_IDLE_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const FORMAT_LEASE_TTL_MS = 45_000;
const MAX_FORMAT_LEASE_WAITERS = MAX_PROJECT_SESSIONS * 2;
// A normal typing burst produces a few small Yjs updates. Keep adjacent
// updates from the same user together without ever merging across another
// collaborator's edit, so the resulting record remains attributable.
const EDIT_SEGMENT_IDLE_MS = 30_000;
const MAX_EDIT_SPANS_PER_STEP = 96;
const MAX_EDIT_PREVIEW_CHARS = 1_200;
// Completion notifications are useful only to browsers that were already
// present when the operation finished. The database and retained manifests
// are the authority for a later workspace open.
const COMPLETED_COMPILE_STATE_TTL_MS = 60_000;
const EPHEMERAL_META_KEYS = ["compileStates", "filesEvent", "commentsRevision", "dictionaryRevision", "historyWarning"] as const;
const COLORS = [
  ["#1677c8", "#1677c833"], ["#d65745", "#d6574533"], ["#16866a", "#16866a33"],
  ["#9a58b5", "#9a58b533"], ["#d27b18", "#d27b1833"], ["#3f7d20", "#3f7d2033"],
  ["#be3e7b", "#be3e7b33"], ["#4964c6", "#4964c633"], ["#8a6a14", "#8a6a1433"],
  ["#087f8c", "#087f8c33"]
] as const;

interface Connection {
  socket: WebSocket;
  user: UserRow;
  /** Digest of the concrete browser session that opened this socket. */
  sessionId: string | null;
  /** Session deadline captured during the authenticated HTTP upgrade. */
  sessionExpiresAt: string | null;
  sessionExpiryTimer: NodeJS.Timeout | null;
  awarenessClientId: number | null;
  protocolVerified: boolean;
  protocolTimer: NodeJS.Timeout | null;
}

interface AiEditOrigin {
  kind: "ai";
  userId: string;
}

export interface AiTargetSnapshot {
  projectId: string;
  filePath: string;
  roomInstanceId: string;
  roomEpoch: string;
  operation: AiOperation;
  startPosition: Uint8Array;
  endPosition: Uint8Array;
  selectedText: string;
  /** Small guards make a cursor insertion fail closed after nearby edits. */
  guardBefore: string;
  guardAfter: string;
  contextBefore: string;
  contextAfter: string;
}

export interface AiContextFileSnapshot {
  filePath: string;
  content: string;
}

export interface AiApplyResult {
  status: "applied" | "noop";
  receipt: CollaborationSaveReceipt;
}

export class AiTargetConflictError extends Error {
  constructor(message = "The collaborative target changed before the AI result was applied") {
    super(message);
    this.name = "AiTargetConflictError";
  }
}

export class AiPermissionError extends Error {
  constructor() {
    super("The user no longer has edit permission for this project");
    this.name = "AiPermissionError";
  }
}

export class AiAuthenticationError extends Error {
  constructor() {
    super("The user's sign-in session is no longer active");
    this.name = "AiAuthenticationError";
  }
}

export class AiApplyAbortedError extends Error {
  constructor() {
    super("The AI result was cancelled before it was applied");
    this.name = "AiApplyAbortedError";
  }
}

interface FormatLease {
  path: string;
  token: string;
  requestId: string;
  connection: Connection;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

interface FormatLeaseWaiter {
  path: string;
  requestId: string;
  connection: Connection;
}

interface Room {
  projectId: string;
  /** Ephemeral room lifetime marker; unlike the persisted epoch it changes on every room instance. */
  instanceId: string;
  doc: Y.Doc;
  awareness: Awareness;
  meta: Y.Map<unknown>;
  connections: Set<Connection>;
  awarenessOwners: Map<number, Connection>;
  allowedPaths: Set<string>;
  persistedContent: Map<string, string>;
  /** Last observed Y.Text contents, used to turn a Yjs delta into text ranges. */
  observedContent: Map<string, string>;
  dirtyPaths: Set<string>;
  /** Author-isolated updates waiting for their corresponding source write. */
  pendingEditSegments: EditHistorySegmentInput[];
  textObservers: Map<string, (event: Y.YTextEvent, transaction: Y.Transaction) => void>;
  saveTimer: NodeJS.Timeout | null;
  flushPromise: Promise<CollaborationSaveReceipt> | null;
  stateSaveTimer: NodeJS.Timeout | null;
  cleanupTimer: NodeJS.Timeout | null;
  lastModifiedUserId: string | null;
  epoch: string;
  persistedRevision: number;
  persistedAt: string;
  maintenanceReason: string | null;
  snapshotBarrierDepth: number;
  snapshotFlushPending: boolean;
  pendingFlushes: Array<{ connection: Connection; requestId: string }>;
  rejectedPaths: Set<string>;
  compileMetaValidationPending: boolean;
  formatLeases: Map<string, FormatLease>;
  formatLeaseWaiters: Map<string, FormatLeaseWaiter[]>;
}

interface RoomBootstrap {
  doc: Y.Doc;
  recoveredState: boolean;
  epoch: string;
  files: Array<{ path: string; content: string }>;
}

export interface CollaborationPersistEvent {
  projectId: string;
  userId: string | null;
  paths: string[];
  edits: EditHistorySegmentInput[];
  durationMs: number;
}

export class CollaborationService {
  private readonly rooms = new Map<string, Room>();
  private readonly maintenanceProjects = new Map<string, string>();
  private readonly roomInitializations = new Map<string, Promise<Room>>();
  private readonly projectGenerations = new Map<string, number>();
  private readonly snapshotBarriers = new Map<string, number>();
  private readonly pendingConnections = new Map<string, number>();
  /** Transient server-side status, restored into each newly opened room. */
  private readonly historyWarnings = new Set<string>();
  private closed = false;
  private readonly projectQuota: ProjectQuotaService;

  constructor(
    private readonly config: Config,
    private readonly db: DatabaseConnection,
    private readonly onPersist?: (event: CollaborationPersistEvent) => Promise<void> | void,
    projectQuota?: ProjectQuotaService
  ) {
    this.projectQuota = projectQuota ?? new ProjectQuotaService(config, db);
  }

  private async lookupProjectAccess(projectId: string, user: UserRow): Promise<CollaborationProjectAccess | null> {
    return await this.db.projects.findCollaborationAccess(projectId, user);
  }

  private async sessionIsActive(user: UserRow): Promise<boolean> {
    return !user.session_id || await this.db.identity.sessionIsActive(
      user.session_id, user.id, new Date().toISOString()
    );
  }

  async connect(socket: WebSocket, projectId: string, user: UserRow): Promise<void> {
    if (this.closed) {
      socket.close(1012, "Collaboration service is shutting down");
      return;
    }
    // currentUser() had an active session during the HTTP upgrade, but the
    // row may have been revoked while this asynchronous room load was queued.
    if (!(await this.sessionIsActive(user))) {
      socket.close(1008, "Sign-in session expired");
      return;
    }
    const project = await this.lookupProjectAccess(projectId, user);
    if (!project) {
      socket.close(1008, "Project access denied");
      return;
    }
    const maintenanceReason = this.maintenanceProjects.get(projectId);
    if (maintenanceReason) {
      socket.close(1013, `Project is temporarily unavailable: ${maintenanceReason}`);
      return;
    }
    const existing = this.rooms.get(projectId);
    if (existing) {
      await this.attachConnection(existing, socket, user);
      return;
    }
    const generation = this.projectGeneration(projectId);
    const pendingKey = this.pendingConnectionKey(projectId, generation);
    const pending = this.pendingConnections.get(pendingKey) ?? 0;
    if (pending >= MAX_PROJECT_SESSIONS) {
      socket.close(1013, "Project collaboration room is full");
      return;
    }
    this.pendingConnections.set(pendingKey, pending + 1);
    const initialization = this.roomInitializations.get(projectId) ?? this.initializeRoom(projectId, generation);
    try {
      const room = await initialization;
      const currentMaintenance = this.maintenanceProjects.get(projectId);
      if (currentMaintenance) {
        this.disposeRoom(room);
        socket.close(1013, `Project is temporarily unavailable: ${currentMaintenance}`);
      } else if (this.projectGeneration(projectId) !== generation) {
        socket.close(1013, "Collaboration state changed; retry required");
      } else if (socket.readyState === WebSocket.OPEN) {
        await this.attachConnection(room, socket, user);
      } else {
        socket.close(1000, "Collaboration connection closed during initialization");
      }
    } catch {
      socket.close(1011, "Unable to initialize collaboration room");
    } finally {
      const count = (this.pendingConnections.get(pendingKey) ?? 1) - 1;
      if (count > 0) this.pendingConnections.set(pendingKey, count);
      else this.pendingConnections.delete(pendingKey);
    }
  }

  /** Wait for an in-flight cold-room load before reading or replacing sources. */
  async waitForReady(projectId: string): Promise<void> {
    const initialization = this.roomInitializations.get(projectId);
    if (!initialization) return;
    try { await initialization; } catch { /* Source files remain authoritative if recovery fails. */ }
  }

  async flushProject(projectId: string): Promise<CollaborationSaveReceipt | null> {
    const room = this.rooms.get(projectId);
    return room ? await this.flushRoom(room) : null;
  }

  /**
   * Prevent collaboration autosaves from changing the source tree while a
   * compiler is copying an immutable snapshot. Yjs updates remain accepted in
   * memory and are flushed when the outermost barrier is released.
   */
  beginSnapshotBarrier(projectId: string): void {
    const depth = (this.snapshotBarriers.get(projectId) ?? 0) + 1;
    this.snapshotBarriers.set(projectId, depth);
    const room = this.rooms.get(projectId);
    if (!room) return;
    room.snapshotBarrierDepth = depth;
    if (depth === 1 && room.cleanupTimer) {
      clearTimeout(room.cleanupTimer);
      room.cleanupTimer = null;
    }
  }

  /**
   * Release a snapshot barrier and persist edits that arrived while the
   * source tree was protected. The returned receipt describes the post-barrier
   * disk revision, allowing callers to label a snapshot that predates edits
   * without treating that consistent snapshot as invalid.
   */
  async endSnapshotBarrier(projectId: string): Promise<CollaborationSaveReceipt | null> {
    const depth = this.snapshotBarriers.get(projectId) ?? 0;
    if (depth <= 0) return this.rooms.get(projectId) ? this.currentReceipt(this.rooms.get(projectId)!) : null;
    const nextDepth = depth - 1;
    if (nextDepth > 0) {
      this.snapshotBarriers.set(projectId, nextDepth);
      const nestedRoom = this.rooms.get(projectId);
      if (nestedRoom) nestedRoom.snapshotBarrierDepth = nextDepth;
      return nestedRoom ? this.currentReceipt(nestedRoom) : null;
    }
    this.snapshotBarriers.delete(projectId);
    const room = this.rooms.get(projectId);
    if (!room) return null;
    room.snapshotBarrierDepth = 0;
    const shouldFlush = room.snapshotFlushPending || room.dirtyPaths.size > 0;
    room.snapshotFlushPending = false;
    let receipt: CollaborationSaveReceipt;
    try {
      receipt = shouldFlush ? await this.flushRoom(room) : this.currentReceipt(room);
    } catch (error) {
      // A state-file or source-file I/O failure must still complete any
      // browser flush requests waiting behind the barrier. The caller should
      // receive the original server error, while editors receive a durable
      // negative receipt instead of timing out.
      receipt = this.currentReceipt(room, false, [...room.dirtyPaths]);
      if (room.dirtyPaths.size > 0) this.scheduleSave(room);
      this.resolvePendingFlushes(room, receipt);
      this.scheduleRoomCleanup(room);
      throw error;
    }
    this.resolvePendingFlushes(room, receipt);
    this.scheduleRoomCleanup(room);
    return receipt;
  }

  stats(): { rooms: number; sessions: number; dirtyFiles: number; initializing: number } {
    let sessions = 0;
    let dirtyFiles = 0;
    for (const room of this.rooms.values()) {
      sessions += room.connections.size;
      dirtyFiles += room.dirtyPaths.size;
    }
    return { rooms: this.rooms.size, sessions, dirtyFiles, initializing: this.roomInitializations.size };
  }

  updateFile(projectId: string, filePathInput: string, content: string, userId: string): void {
    const room = this.rooms.get(projectId);
    if (!room) {
      this.invalidateProject(projectId);
      return;
    }
    if (!isCollaborativeTextFile(filePathInput)) {
      this.invalidateProject(projectId);
      return;
    }
    const filePath = safeRelativePath(filePathInput);
    room.allowedPaths.add(filePath);
    room.persistedContent.set(filePath, content);
    room.doc.transact(() => replaceText(this.trackedText(room, filePath), content), HTTP_ORIGIN);
    room.lastModifiedUserId = userId;
    room.persistedRevision += 1;
    room.persistedAt = new Date().toISOString();
    this.bumpFiles(room, { kind: "update", path: filePath });
  }

  /**
   * Mark a project as undergoing an exclusive source-tree operation. Existing
   * clients are told to stop editing and are disconnected when the operation
   * completes by endMaintenance(), which forces a fresh Yjs epoch.
   */
  beginMaintenance(projectId: string, reason: string): void {
    const normalizedReason = reason.slice(0, 200);
    const existingMaintenance = this.maintenanceProjects.get(projectId);
    if (existingMaintenance) throw new Error("Project is already undergoing a maintenance operation");
    const room = this.rooms.get(projectId);
    if (room?.maintenanceReason) throw new Error("Project is already undergoing a maintenance operation");
    this.maintenanceProjects.set(projectId, normalizedReason);
    if (!room) return;
    room.maintenanceReason = normalizedReason;
    const message = maintenanceMessage(room.maintenanceReason);
    for (const connection of room.connections) {
      send(connection.socket, message);
      // Close immediately after the notice. This prevents local edits from
      // accumulating while a source-tree replacement is in flight; the epoch
      // reset in endMaintenance will make the client reload authoritative data.
      connection.socket.close(4002, `Project maintenance: ${normalizedReason}`);
    }
  }

  endMaintenance(projectId: string): void {
    this.maintenanceProjects.delete(projectId);
    const room = this.rooms.get(projectId);
    if (room) room.maintenanceReason = null;
    // A project-level replacement cannot safely merge edits made while the
    // operation was in flight. Resetting the epoch makes every client reload
    // the authoritative source tree instead of replaying stale local drafts.
    this.resetProject(projectId);
  }

  notifyPermissionChanged(projectId: string, userId: string, permission: "read" | "edit" | "owner" | "revoked"): void {
    const room = this.rooms.get(projectId);
    if (!room) return;
    if (permission === "read" || permission === "revoked") {
      const connectionIds = new Set([...room.connections].filter((connection) => connection.user.id === userId));
      for (const connection of connectionIds) this.releaseFormatLeasesForConnection(room, connection);
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_PERMISSION);
    encoding.writeVarString(encoder, userId);
    encoding.writeVarString(encoder, permission);
    const message = encoding.toUint8Array(encoder);
    for (const connection of room.connections) {
      if (connection.user.id === userId) send(connection.socket, message);
    }
  }

  disconnectUser(userId: string, reason = "User access revoked"): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_PERMISSION);
    encoding.writeVarString(encoder, userId);
    encoding.writeVarString(encoder, "revoked");
    const message = encoding.toUint8Array(encoder);

    for (const room of this.rooms.values()) {
      for (const connection of [...room.connections]) {
        if (connection.user.id === userId) {
          send(connection.socket, message);
          connection.socket.close(1008, reason);
          this.disconnect(room, connection);
        }
      }
    }
  }

  /** Close every live WebSocket authenticated by one revoked session token. */
  disconnectSession(sessionId: string, reason = "Sign-in session expired"): void {
    for (const room of this.rooms.values()) {
      for (const connection of [...room.connections]) {
        if (connection.sessionId !== sessionId) continue;
        sendPermissionRevoked(connection.socket, connection.user.id);
        connection.socket.close(1008, reason);
        this.disconnect(room, connection);
      }
    }
  }

  /** Close a user's older sessions while retaining one newly changed session. */
  disconnectUserSessionsExcept(userId: string, retainedSessionId: string | null, reason = "Sign-in session revoked"): void {
    for (const room of this.rooms.values()) {
      for (const connection of [...room.connections]) {
        if (connection.user.id !== userId || connection.sessionId === retainedSessionId) continue;
        sendPermissionRevoked(connection.socket, connection.user.id);
        connection.socket.close(1008, reason);
        this.disconnect(room, connection);
      }
    }
  }

  /** Close live sessions that entered a project through one bearer link. */
  disconnectShareLink(projectId: string, shareLinkId: string, reason = "Share link revoked"): void {
    const room = this.rooms.get(projectId);
    if (!room) return;
    for (const connection of [...room.connections]) {
      if (connection.user.share_link_id !== shareLinkId) continue;
      sendPermissionRevoked(connection.socket, connection.user.id);
      connection.socket.close(1008, reason);
      this.disconnect(room, connection);
    }
  }

  currentRevision(projectId: string): number | null {
    return this.rooms.get(projectId)?.persistedRevision ?? null;
  }

  /** Return the durable collaborative text currently held by a live room. */
  fileContent(projectId: string, filePathInput: string): string | null {
    const room = this.rooms.get(projectId);
    if (!room) return null;
    const filePath = safeRelativePath(filePathInput);
    if (!room.allowedPaths.has(filePath)) return null;
    return this.trackedText(room, filePath).toString();
  }

  /**
   * Capture a live Yjs target for an AI task.  The room and its epoch are
   * intentionally required: an AI task is ephemeral and must never fall back
   * to a stale source-file snapshot after a room is rebuilt.
   */
  captureAiTarget(
    projectId: string,
    filePathInput: string,
    startOffset: number,
    endOffset: number,
    operation: AiOperation
  ): AiTargetSnapshot {
    const room = this.rooms.get(projectId);
    if (!room) throw new AiTargetConflictError("The collaborative document is not connected");
    const filePath = safeRelativePath(filePathInput);
    if (!isCollaborativeTextFile(filePath) || !room.allowedPaths.has(filePath)) {
      throw new AiTargetConflictError("The selected source file is no longer available");
    }
    const text = this.trackedText(room, filePath);
    const source = text.toString();
    if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset)
      || startOffset < 0 || endOffset < startOffset || endOffset > source.length) {
      throw new AiTargetConflictError("The selected source range is invalid");
    }
    if (operation === "insert" && startOffset !== endOffset) {
      throw new AiTargetConflictError("An insertion target cannot contain a selection");
    }
    if (operation === "replace" && startOffset === endOffset) {
      throw new AiTargetConflictError("A replacement target must contain selected text");
    }
    const selectedText = source.slice(startOffset, endOffset);
    const guardLength = 256;
    const guardBefore = source.slice(Math.max(0, startOffset - guardLength), startOffset);
    const guardAfter = source.slice(endOffset, Math.min(source.length, endOffset + guardLength));
    return {
      projectId,
      filePath,
      roomInstanceId: room.instanceId,
      roomEpoch: room.epoch,
      operation,
      startPosition: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, startOffset, 0)),
      endPosition: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, endOffset, 0)),
      selectedText,
      guardBefore,
      guardAfter,
      contextBefore: source.slice(0, startOffset),
      contextAfter: source.slice(endOffset)
    };
  }

  /** Capture additional read-only AI context from the same live room. */
  captureAiContextFiles(projectId: string, filePaths: readonly string[]): AiContextFileSnapshot[] {
    const room = this.rooms.get(projectId);
    if (!room) throw new AiTargetConflictError("The collaborative document is not connected");
    const seen = new Set<string>();
    return filePaths.map((filePathInput) => {
      const filePath = safeRelativePath(filePathInput);
      if (!isAiContextFilePath(filePath) || seen.has(filePath) || !room.allowedPaths.has(filePath)) {
        throw new AiTargetConflictError("One of the selected AI context files is no longer available");
      }
      seen.add(filePath);
      return { filePath, content: this.trackedText(room, filePath).toString() };
    });
  }

  /** Apply an AI result only if the live Yjs target still matches its guard. */
  async applyAiResult(
    snapshot: AiTargetSnapshot,
    resultText: string,
    userId: string,
    signal?: AbortSignal,
    sessionId?: string | null
  ): Promise<AiApplyResult> {
    const room = this.rooms.get(snapshot.projectId);
    if (!room || room.instanceId !== snapshot.roomInstanceId || room.epoch !== snapshot.roomEpoch || !room.allowedPaths.has(snapshot.filePath)) {
      throw new AiTargetConflictError();
    }
    const currentUser = await this.db.identity.findUserById(userId);
    if (!currentUser || currentUser.disabled) throw new AiPermissionError();
    if (sessionId && !(await this.db.identity.sessionIsActive(sessionId, userId, new Date().toISOString()))) {
      throw new AiAuthenticationError();
    }
    const currentProject = await this.lookupProjectAccess(snapshot.projectId, currentUser);
    if (!currentProject || !canEdit(currentProject)) throw new AiPermissionError();
    // Permission checks above are asynchronous. The room may have been
    // destroyed and recreated while they were running, so never apply to the
    // stale Y.Doc captured before the await.
    if (this.rooms.get(snapshot.projectId) !== room
      || room.instanceId !== snapshot.roomInstanceId
      || room.epoch !== snapshot.roomEpoch
      || !room.allowedPaths.has(snapshot.filePath)) {
      throw new AiTargetConflictError();
    }
    if (signal?.aborted) throw new AiApplyAbortedError();
    const text = this.trackedText(room, snapshot.filePath);
    const start = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(snapshot.startPosition), room.doc
    );
    const end = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(snapshot.endPosition), room.doc
    );
    if (!start || !end || start.type !== text || end.type !== text || start.index > end.index) {
      throw new AiTargetConflictError();
    }
    const current = text.toString();
    const currentSelected = current.slice(start.index, end.index);
    if (snapshot.operation === "replace") {
      if (currentSelected !== snapshot.selectedText) throw new AiTargetConflictError();
    } else {
      if (start.index !== end.index) throw new AiTargetConflictError();
      const before = current.slice(Math.max(0, start.index - snapshot.guardBefore.length), start.index);
      const after = current.slice(end.index, Math.min(current.length, end.index + snapshot.guardAfter.length));
      if (before !== snapshot.guardBefore || after !== snapshot.guardAfter) throw new AiTargetConflictError();
    }
    if (snapshot.operation === "insert" && resultText.length === 0) {
      const receipt = await this.flushProject(snapshot.projectId);
      if (!receipt?.ok) throw new Error("The project source could not be saved");
      return { status: "noop", receipt };
    }
    if (snapshot.operation === "replace" && resultText === snapshot.selectedText) {
      const receipt = await this.flushProject(snapshot.projectId);
      if (!receipt?.ok) throw new Error("The project source could not be saved");
      return { status: "noop", receipt };
    }
    room.doc.transact(() => {
      if (snapshot.operation === "replace") text.delete(start.index, end.index - start.index);
      text.insert(start.index, resultText);
    }, { kind: "ai", userId } satisfies AiEditOrigin);
    const receipt = await this.flushProject(snapshot.projectId);
    if (!receipt?.ok) throw new Error("The project source could not be saved");
    return { status: "applied", receipt };
  }

  /**
   * Returns the current source-tree epoch.  Exclusive filesystem operations
   * increment this value, allowing callers to cheaply distinguish a request
   * admitted before and after a project replacement without reading files.
   */
  currentGeneration(projectId: string): number {
    return this.projectGeneration(projectId);
  }

  hasPendingChanges(projectId: string): boolean {
    return Boolean(this.rooms.get(projectId)?.dirtyPaths.size);
  }

  isMaintaining(projectId: string): boolean {
    return this.maintenanceProjects.has(projectId);
  }

  isStable(projectId: string, revision: number | null): boolean {
    const room = this.rooms.get(projectId);
    return room
      ? room.maintenanceReason === null && room.persistedRevision === revision && room.dirtyPaths.size === 0
      : revision === null;
  }

  async movePath(projectId: string, sourceInput: string, destinationInput: string, userId: string): Promise<void> {
    const room = this.rooms.get(projectId);
    if (!room) {
      this.invalidateProject(projectId);
      return;
    }
    await this.flushRoom(room);
    const source = safeRelativePath(sourceInput);
    const destination = safeRelativePath(destinationInput);
    const moved = [...room.allowedPaths].filter((filePath) => filePath === source || filePath.startsWith(`${source}/`));
    room.doc.transact(() => {
      for (const oldPath of moved) {
        const nextPath = oldPath === source ? destination : `${destination}${oldPath.slice(source.length)}`;
        const content = this.trackedText(room, oldPath).toString();
        replaceText(this.trackedText(room, nextPath), content);
        replaceText(this.trackedText(room, oldPath), "");
        room.allowedPaths.delete(oldPath);
        room.allowedPaths.add(nextPath);
        room.persistedContent.delete(oldPath);
        room.persistedContent.set(nextPath, content);
      }
    }, HTTP_ORIGIN);
    room.lastModifiedUserId = userId;
    room.persistedRevision += 1;
    room.persistedAt = new Date().toISOString();
    this.bumpFiles(room, { kind: "move", source, destination });
  }

  removePath(projectId: string, filePathInput: string): void {
    const room = this.rooms.get(projectId);
    if (!room) {
      this.invalidateProject(projectId);
      return;
    }
    const filePath = safeRelativePath(filePathInput);
    const removed = [...room.allowedPaths].filter((candidate) => candidate === filePath || candidate.startsWith(`${filePath}/`));
    room.doc.transact(() => {
      for (const candidate of removed) {
        replaceText(this.trackedText(room, candidate), "");
        room.allowedPaths.delete(candidate);
        room.persistedContent.delete(candidate);
        room.dirtyPaths.delete(candidate);
      }
    }, HTTP_ORIGIN);
    room.persistedRevision += 1;
    room.persistedAt = new Date().toISOString();
    this.bumpFiles(room, { kind: "delete", path: filePath });
  }

  invalidateSourceTree(projectId: string, filePathInput?: string): void {
    this.invalidateProject(projectId);
    const room = this.rooms.get(projectId);
    if (!room) return;
    const filePath = filePathInput ? safeRelativePath(filePathInput) : "";
    this.bumpFiles(room, { kind: "update", path: filePath });
  }

  setHistoryWarning(projectId: string, warning: boolean): void {
    if (warning) this.historyWarnings.add(projectId);
    else this.historyWarnings.delete(projectId);
    const room = this.rooms.get(projectId);
    if (!room || room.meta.get("historyWarning") === warning) return;
    room.doc.transact(() => room.meta.set("historyWarning", warning), META_ORIGIN);
  }

  signalComments(projectId: string): void {
    const room = this.rooms.get(projectId);
    if (!room) return;
    room.doc.transact(() => room.meta.set("commentsRevision", randomUUID()), META_ORIGIN);
  }

  signalDictionary(projectId: string): void {
    const room = this.rooms.get(projectId);
    if (!room) return;
    room.doc.transact(() => room.meta.set("dictionaryRevision", randomUUID()), META_ORIGIN);
  }

  signalCompileState(projectId: string, state: SharedCompileState): void {
    const room = this.rooms.get(projectId);
    if (!room) return;
    const current = room.meta.get("compileStates");
    const states = current && typeof current === "object" && !Array.isArray(current)
      ? { ...current as SharedCompileStates }
      : {};
    states[state.mainFile] = state;
    const retained = Object.fromEntries(Object.entries(states)
      .sort((left, right) => Date.parse(right[1].updatedAt) - Date.parse(left[1].updatedAt))
      .slice(0, 20));
    room.doc.transact(() => room.meta.set("compileStates", retained), META_ORIGIN);
  }

  /**
   * Keep collaboration compile metadata strictly ephemeral and database
   * backed. A browser can replay old IndexedDB updates after reconnecting;
   * completed states must therefore not override the retained-PDF lookup for
   * a newly opened workspace.
   */
  private async sanitizeCompileStates(room: Room): Promise<void> {
    const current = room.meta.get("compileStates");
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      if (current !== undefined) room.doc.transact(() => room.meta.delete("compileStates"), META_ORIGIN);
      return;
    }
    const retained: SharedCompileStates = {};
    let changed = false;
    const checkedAt = Date.now();
    for (const [mainFile, value] of Object.entries(current as Record<string, unknown>)) {
      if (!isSharedCompileState(mainFile, value)) {
        changed = true;
        continue;
      }
      if (value.status === "queued" || value.status === "running") {
        const run = await this.db.compileRuns.findRun(value.runId, room.projectId);
        if (!run || run.main_file !== mainFile || (run.status !== "queued" && run.status !== "running")) {
          changed = true;
          continue;
        }
      } else {
        const updatedAt = Date.parse(value.updatedAt);
        const fresh = Number.isFinite(updatedAt)
          && updatedAt <= checkedAt + COMPLETED_COMPILE_STATE_TTL_MS
          && checkedAt - updatedAt <= COMPLETED_COMPILE_STATE_TTL_MS;
        if (!fresh) {
          changed = true;
          continue;
        }
        if (value.status !== "cleaned") {
          const run = await this.db.compileRuns.findRun(value.runId, room.projectId);
          const latest = await this.db.compileRuns.latestCreated(room.projectId, mainFile);
          if (!run || run.main_file !== mainFile || run.status !== value.status
            || !latest || latest.id !== value.runId || latest.status !== value.status) {
            changed = true;
            continue;
          }
        }
      }
      retained[mainFile] = value;
    }
    if (!changed && Object.keys(retained).length === Object.keys(current).length) return;
    room.doc.transact(() => {
      if (Object.keys(retained).length) room.meta.set("compileStates", retained);
      else room.meta.delete("compileStates");
    }, META_ORIGIN);
  }

  private async sendCompileStates(room: Room, socket: WebSocket): Promise<void> {
    const payload = await this.compileStatesForClient(room);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_COMPILE_STATES);
    encoding.writeVarString(encoder, JSON.stringify(payload));
    send(socket, encoding.toUint8Array(encoder));
  }

  /**
   * Include active database runs even when no live room existed when the run
   * was queued. This keeps the handshake authoritative without making every
   * compile request persist a duplicate Yjs metadata update.
   */
  private async compileStatesForClient(room: Room): Promise<SharedCompileStates> {
    const current = room.meta.get("compileStates");
    const states: SharedCompileStates = isCompileStateMap(current) ? { ...current } : {};
    const activeRuns = await this.db.compileRuns.activeRuns(room.projectId);
    for (const run of activeRuns) {
      if (states[run.main_file]?.status === "running" && run.status === "queued") continue;
      states[run.main_file] = {
        mainFile: run.main_file,
        runId: run.id,
        status: run.status,
        requestedBy: {
          id: run.requested_by ?? "deleted-user",
          username: run.requested_by_username ?? "deleted-user",
          name: run.requested_by_name ?? "Deleted User"
        },
        updatedAt: run.created_at
      };
    }
    return Object.fromEntries(Object.entries(states)
      .sort((left, right) => Date.parse(right[1].updatedAt) - Date.parse(left[1].updatedAt))
      .slice(0, 20));
  }

  private clearRecoveredMetadata(room: Room): boolean {
    let changed = false;
    room.doc.transact(() => {
      for (const key of EPHEMERAL_META_KEYS) {
        if (!room.meta.has(key)) continue;
        room.meta.delete(key);
        changed = true;
      }
    }, META_ORIGIN);
    return changed;
  }

  closeProject(projectId: string): void {
    this.invalidateProject(projectId);
    this.snapshotBarriers.delete(projectId);
    const room = this.rooms.get(projectId);
    if (!room) return;
    for (const connection of room.connections) connection.socket.close(1008, "Project closed");
    void this.destroyRoom(room);
  }

  resetProject(projectId: string): void {
    this.invalidateProject(projectId);
    this.snapshotBarriers.delete(projectId);
    const room = this.rooms.get(projectId);
    if (room) {
      for (const connection of room.connections) connection.socket.close(4001, "Project version changed; reload required");
      void this.destroyRoom(room, false);
    }
    fs.rmSync(collaborationStatePath(this.config, projectId), { force: true });
    fs.rmSync(collaborationEpochPath(this.config, projectId), { force: true });
  }

  async destroy(): Promise<void> {
    this.closed = true;
    for (const room of [...this.rooms.values()]) await this.destroyRoom(room);
    this.roomInitializations.clear();
    this.snapshotBarriers.clear();
    this.pendingConnections.clear();
    this.historyWarnings.clear();
  }

  private initializeRoom(projectId: string, generation: number): Promise<Room> {
    const existing = this.rooms.get(projectId);
    if (existing) return Promise.resolve(existing);
    const pending = this.roomInitializations.get(projectId);
    if (pending) return pending;
    const request = this.loadRoomBootstrap(projectId)
      .then((bootstrap) => {
        if (this.closed || this.projectGeneration(projectId) !== generation) {
          bootstrap.doc.destroy();
          throw new Error("Collaboration room initialization was invalidated");
        }
        return this.createRoom(projectId, bootstrap);
      })
      .finally(() => {
        if (this.roomInitializations.get(projectId) === request) this.roomInitializations.delete(projectId);
      });
    this.roomInitializations.set(projectId, request);
    return request;
  }

  /** Read the potentially large source tree without blocking the event loop. */
  private async loadRoomBootstrap(projectId: string): Promise<RoomBootstrap> {
    let doc = new Y.Doc();
    try {
      let recoveredState = false;
      let persistedState: Buffer | null = null;
      try {
        persistedState = await fs.promises.readFile(collaborationStatePath(this.config, projectId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (persistedState) {
        try {
          Y.applyUpdate(doc, persistedState, DISK_ORIGIN);
          recoveredState = true;
        } catch {
          // Malformed Yjs data is recoverable because source files remain the
          // authority. Start with a pristine document in case applyUpdate()
          // partially mutated the original before rejecting the payload.
          doc.destroy();
          doc = new Y.Doc();
        }
      }
      const epoch = await collaborationEpochAsync(this.config, projectId, recoveredState);
      const files = await this.readCollaborativeFiles(projectId);
      return { doc, recoveredState, epoch, files };
    } catch (error) {
      doc.destroy();
      throw error;
    }
  }

  /**
   * Recheck file metadata after reading. This closes the small race where an
   * upload or autosave changes a file while the cold room is being hydrated.
   */
  private async readCollaborativeFiles(projectId: string): Promise<Array<{ path: string; content: string }>> {
    const assertSourceRoot = async (): Promise<void> => {
      const stats = await fs.promises.lstat(sourceRoot(this.config, projectId));
      if (stats.isSymbolicLink()) throw new Error("Collaborative source root cannot be a symbolic link");
      if (!stats.isDirectory()) throw new Error("Collaborative source root is not a directory");
    };
    let lastFailure = "Unable to obtain a stable collaborative source snapshot";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assertSourceRoot();
      const entries = (await listProjectFilesAsync(this.config, projectId))
        .filter((entry) => entry.type === "file" && isCollaborativeTextFile(entry.path)
          && (entry.size ?? 0) <= maxCollaborativeFileBytes(this.config));
      const files: Array<{ path: string; content: string }> = [];
      const failedPaths: string[] = [];
      for (let offset = 0; offset < entries.length; offset += 8) {
        const batch = entries.slice(offset, offset + 8);
        const loaded = await Promise.all(batch.map(async (entry) => {
          try {
            return { path: entry.path, content: await fs.promises.readFile(resolveSourcePath(this.config, projectId, entry.path), "utf8") };
          } catch {
            failedPaths.push(entry.path);
            return null;
          }
        }));
        files.push(...loaded.filter((file): file is { path: string; content: string } => file !== null));
      }
      const currentEntries = (await listProjectFilesAsync(this.config, projectId))
        .filter((entry) => entry.type === "file" && isCollaborativeTextFile(entry.path)
          && (entry.size ?? 0) <= maxCollaborativeFileBytes(this.config));
      await assertSourceRoot();
      const before = entries.map(collaborativeEntrySignature).sort().join("\n");
      const after = currentEntries.map(collaborativeEntrySignature).sort().join("\n");
      if (before === after && failedPaths.length === 0) return files;
      if (failedPaths.length) lastFailure = `Unable to read collaborative source files: ${failedPaths.join(", ")}`;
    }
    throw new Error(lastFailure);
  }

  private async createRoom(projectId: string, bootstrap: RoomBootstrap): Promise<Room> {
    const existing = this.rooms.get(projectId);
    if (existing) {
      bootstrap.doc.destroy();
      return existing;
    }
    const room: Room = {
      projectId,
      instanceId: randomUUID(),
      doc: bootstrap.doc,
      awareness: new Awareness(bootstrap.doc),
      meta: bootstrap.doc.getMap("texlite:meta"),
      connections: new Set(),
      awarenessOwners: new Map(),
      allowedPaths: new Set(),
      persistedContent: new Map(),
      observedContent: new Map(),
      dirtyPaths: new Set(),
      pendingEditSegments: [],
      textObservers: new Map(),
      saveTimer: null,
      stateSaveTimer: null,
      flushPromise: null,
      cleanupTimer: null,
      lastModifiedUserId: null,
      epoch: bootstrap.epoch,
      persistedRevision: 0,
      persistedAt: new Date().toISOString(),
      maintenanceReason: this.maintenanceProjects.get(projectId) ?? null,
      snapshotBarrierDepth: this.snapshotBarriers.get(projectId) ?? 0,
      snapshotFlushPending: false,
      pendingFlushes: [],
      rejectedPaths: new Set(),
      compileMetaValidationPending: false,
      formatLeases: new Map(),
      formatLeaseWaiters: new Map()
    };
    room.awareness.setLocalState(null);
    // A recovered Yjs document may contain metadata from a process that no
    // longer exists. The database/source tree are authoritative after a
    // restart; clear the markers before any browser can sync them back.
    const recoveredMetadataChanged = bootstrap.recoveredState && this.clearRecoveredMetadata(room);
    // History bookkeeping is not stored in a project Yjs document, but a
    // temporary failure must remain visible if its room was idled out before
    // the editor reconnects.
    if (this.historyWarnings.has(projectId)) {
      room.doc.transact(() => room.meta.set("historyWarning", true), META_ORIGIN);
    }
    await this.sanitizeCompileStates(room);
    let recoveredDirty = false;
    const diskPaths = new Set<string>();
    room.doc.transact(() => {
      for (const file of bootstrap.files) {
        diskPaths.add(file.path);
        room.allowedPaths.add(file.path);
        room.persistedContent.set(file.path, file.content);
        const name = typeName(file.path);
        // Yjs decodes top-level shared types lazily; the source: namespace is
        // the stable identifier before getText() materializes the public type.
        const hasRecoveredText = bootstrap.recoveredState && room.doc.share.has(name);
        const text = this.trackedText(room, file.path);
        if (hasRecoveredText && text.toString() !== file.content) {
          room.dirtyPaths.add(file.path);
          recoveredDirty = true;
        } else {
          replaceText(text, file.content);
        }
        room.observedContent.set(file.path, text.toString());
      }
      for (const name of room.doc.share.keys()) {
        if (!name.startsWith(SOURCE_PREFIX)) continue;
        const filePath = name.slice(SOURCE_PREFIX.length);
        if (!diskPaths.has(filePath)) {
          const text = room.doc.getText(name);
          replaceText(text, "");
          room.observedContent.set(filePath, text.toString());
        }
      }
    }, DISK_ORIGIN);
    const rejectedRecoveredPaths = this.rejectOversizedTexts(room);
    const rejectedRecoveredOverQuotaPaths = await this.rejectOverQuotaTexts(room);
    recoveredDirty = room.dirtyPaths.size > 0;
    room.meta.observe((_event, transaction) => {
      if (isConnectionOrigin(transaction.origin)) room.compileMetaValidationPending = true;
    });
    room.doc.on("update", (update, origin) => {
      this.broadcast(room, syncUpdateMessage(update), origin instanceof Object && "socket" in origin ? origin as Connection : null);
      // Compile state, file-list revisions, and comment/dictionary revision
      // markers are ephemeral metadata. They are reconstructed from SQLite
      // and the source tree after a restart, so do not encode and synchronously
      // rewrite the complete Yjs document for every metadata-only event.
      if (origin !== META_ORIGIN) this.scheduleStateSave(room);
      if (room.compileMetaValidationPending) {
        room.compileMetaValidationPending = false;
        void this.sanitizeCompileStates(room).catch(() => undefined);
      }
      if (origin !== DISK_ORIGIN && origin !== HTTP_ORIGIN && origin !== META_ORIGIN) {
        const authorId = editAuthorId(origin);
        if (authorId) room.lastModifiedUserId = authorId;
        this.scheduleSave(room);
      }
    });
    room.awareness.on("update", ({ added, updated, removed }: {
      added: number[]; updated: number[]; removed: number[];
    }, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      if (!changed.length) return;
      this.broadcast(room, awarenessMessage(encodeAwarenessUpdate(room.awareness, changed)), null);
      if (origin && typeof origin === "object" && "socket" in origin) {
        const connection = origin as Connection;
        for (const clientId of [...added, ...updated]) room.awarenessOwners.set(clientId, connection);
        for (const clientId of removed) {
          if (room.awarenessOwners.get(clientId) === connection) room.awarenessOwners.delete(clientId);
        }
      }
    });
    try {
      // Persist a corrected state even when an oversized recovered document was
      // reverted to the source file and no source write remains dirty.
      if (recoveredDirty || rejectedRecoveredPaths.length > 0 || rejectedRecoveredOverQuotaPaths.length > 0) await this.flushRoom(room);
      else if (recoveredMetadataChanged) this.scheduleStateSave(room);
    } catch (error) {
      this.disposeRoom(room);
      throw error;
    }
    this.rooms.set(projectId, room);
    // A fresh room has no unsaved Yjs state yet. Delaying state persistence
    // avoids a large synchronous write on the first connection; subsequent
    // updates schedule the normal atomic save.
    return room;
  }

  private async attachConnection(room: Room, socket: WebSocket, user: UserRow): Promise<void> {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (!(await this.sessionIsActive(user))) {
      socket.close(1008, "Sign-in session expired");
      return;
    }
    if (!(await this.lookupProjectAccess(room.projectId, user))) {
      socket.close(1008, "Project access denied");
      return;
    }
    const maintenanceReason = this.maintenanceProjects.get(room.projectId);
    if (maintenanceReason) {
      socket.close(1013, `Project is temporarily unavailable: ${maintenanceReason}`);
      return;
    }
    if (room.connections.size >= MAX_PROJECT_SESSIONS) {
      socket.close(1013, "Project collaboration room is full");
      return;
    }
    if (room.cleanupTimer) {
      clearTimeout(room.cleanupTimer);
      room.cleanupTimer = null;
    }
    const connection: Connection = {
      socket, user, sessionId: user.session_id ?? null,
      sessionExpiresAt: user.session_expires_at ?? null, sessionExpiryTimer: null,
      awarenessClientId: null, protocolVerified: false, protocolTimer: null
    };
    room.connections.add(connection);
    this.scheduleSessionExpiry(room, connection);
    if (!room.connections.has(connection)) return;
    socket.binaryType = "arraybuffer";
    socket.on("message", (data) => {
      try {
        void this.handleMessage(room, connection, rawData(data)).catch(() => {
          socket.close(1003, "Invalid collaboration message");
        });
      } catch {
        socket.close(1003, "Invalid collaboration message");
      }
    });
    socket.on("close", () => this.disconnect(room, connection));
    socket.on("error", () => this.disconnect(room, connection));
    connection.protocolTimer = setTimeout(() => {
      if (!connection.protocolVerified) socket.close(4001, "Reload required");
    }, 10_000);
    send(socket, protocolMessage(room.epoch));
  }

  /** Disconnect promptly at session expiry instead of waiting for a packet. */
  private scheduleSessionExpiry(room: Room, connection: Connection): void {
    const sessionId = connection.sessionId;
    const expiresAt = connection.sessionExpiresAt;
    if (!sessionId || !expiresAt) return;
    const expire = (): void => {
      if (!room.connections.has(connection)) return;
      const remaining = Date.parse(expiresAt) - Date.now();
      if (Number.isFinite(remaining) && remaining > 0) {
        const timer = setTimeout(expire, Math.min(remaining, MAX_TIMER_DELAY_MS));
        timer.unref();
        connection.sessionExpiryTimer = timer;
        return;
      }
      this.disconnectSession(sessionId, "Sign-in session expired");
    };
    const remaining = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      this.disconnectSession(sessionId, "Sign-in session expired");
      return;
    }
    const timer = setTimeout(expire, Math.min(remaining, MAX_TIMER_DELAY_MS));
    timer.unref();
    connection.sessionExpiryTimer = timer;
  }

  private trackedText(room: Room, filePath: string): Y.Text {
    const text = room.doc.getText(typeName(filePath));
    if (room.textObservers.has(filePath)) return text;
    const observer = (event: Y.YTextEvent, transaction: Y.Transaction): void => {
      const before = room.observedContent.get(filePath) ?? text.toString();
      const after = text.toString();
      if (transaction.origin === DISK_ORIGIN || transaction.origin === HTTP_ORIGIN || transaction.origin === META_ORIGIN) {
        // Non-collaborative mutations deliberately reset the source chain.
        // They are represented by recovery snapshots, not by a guessed user
        // edit record; keeping this mirror current prevents later edits from
        // being mapped across such a replacement.
        room.observedContent.set(filePath, after);
        return;
      }
      if (!room.allowedPaths.has(filePath)) {
        // A client can still have the old Y.Text bound briefly after another
        // session deletes or moves a file. Correct any late update immediately;
        // otherwise the editor would appear writable even though the content
        // can no longer be persisted to a source path.
        room.doc.transact(() => replaceText(text, ""), DISK_ORIGIN);
        return;
      }
      const authorId = editAuthorId(transaction.origin);
      if (authorId && before !== after) {
        const connection = isConnectionOrigin(transaction.origin) ? transaction.origin : null;
        this.recordEditStep(room, filePath, authorId, connection, event, before, after);
      }
      room.observedContent.set(filePath, after);
      room.dirtyPaths.add(filePath);
    };
    text.observe(observer);
    room.textObservers.set(filePath, observer);
    return text;
  }

  /**
   * Keep live collaborative changes in short, author-isolated segments. The
   * segment is only handed to the history service after `flushRoom()` has
   * made the matching source content durable.
   */
  private recordEditStep(
    room: Room,
    filePath: string,
    authorId: string,
    connection: Connection | null,
    event: Y.YTextEvent,
    before: string,
    after: string
  ): void {
    const spans = editSpansFromYDelta(event.delta, before, after);
    if (!spans.length) return;
    const createdAt = new Date().toISOString();
    const activeLease = this.activeFormatLease(room, filePath);
    const kind: EditHistorySegmentInput["kind"] = connection && activeLease?.connection === connection ? "format" : "edit";
    const step: EditHistoryStep = {
      beforeHash: hashText(before),
      afterHash: hashText(after),
      createdAt,
      spans
    };
    const previous = room.pendingEditSegments.at(-1);
    const previousTime = previous ? Date.parse(previous.updatedAt) : Number.NaN;
    if (previous
      && previous.filePath === filePath
      && previous.authorId === authorId
      && previous.kind === kind
      && previous.afterHash === step.beforeHash
      && Number.isFinite(previousTime)
      && Date.parse(createdAt) - previousTime <= EDIT_SEGMENT_IDLE_MS) {
      previous.steps.push(step);
      previous.afterHash = step.afterHash;
      previous.updatedAt = createdAt;
      return;
    }
    room.pendingEditSegments.push({
      filePath,
      authorId,
      kind,
      beforeHash: step.beforeHash,
      afterHash: step.afterHash,
      createdAt,
      updatedAt: createdAt,
      steps: [step]
    });
  }

  private async handleMessage(room: Room, connection: Connection, bytes: Uint8Array): Promise<void> {
    // Authentication is normally checked when the WebSocket upgrades, but a
    // socket can outlive logout, password changes and natural expiry. Keep the
    // concrete session row as the authority for every protocol message.
    if (!(await this.sessionIsActive(connection.user))) {
      if (connection.sessionId) this.disconnectSession(connection.sessionId, "Sign-in session expired");
      else {
        connection.socket.close(1008, "Sign-in session expired");
        this.disconnect(room, connection);
      }
      return;
    }
    const refreshedUser = await this.db.identity.findUserById(connection.user.id);
    if (!refreshedUser || refreshedUser.disabled) {
      connection.socket.close(1008, "Project access revoked");
      this.disconnect(room, connection);
      return;
    }
    // The share-link id is request-scoped and therefore is not stored in the
    // users table. Preserve it across the database refresh used to re-check
    // every message; otherwise the first protocol packet from a read-link
    // session is incorrectly treated as an unauthorised project access.
    const refreshedAccessUser: UserRow = {
      ...refreshedUser,
      // Keep the request-scoped session/link credentials on the live connection
      // so every later packet still verifies the same browser session.
      session_id: connection.sessionId,
      session_expires_at: connection.sessionExpiresAt,
      ...(connection.user.share_link_id ? { share_link_id: connection.user.share_link_id } : {})
    };
    connection.user = refreshedAccessUser;
    const current = await this.lookupProjectAccess(room.projectId, refreshedAccessUser);
    if (!current) {
      connection.socket.close(1008, "Project access revoked");
      return;
    }
    const decoder = decoding.createDecoder(bytes);
    const messageType = decoding.readVarUint(decoder);
    if (room.maintenanceReason && messageType !== MESSAGE_PROTOCOL && messageType !== MESSAGE_QUERY_AWARENESS) {
      return;
    }
    if (messageType === MESSAGE_PROTOCOL) {
      const epoch = decoding.readVarString(decoder);
      const clientProtocolVersion = decoding.hasContent(decoder)
        ? decoding.readVarUint(decoder)
        : null;
      if (epoch !== room.epoch) {
        connection.socket.close(4001, "Collaboration state changed; reload required");
        return;
      }
      // A pre-versioning client cannot safely decode the durable FLUSH
      // response introduced in the previous release. Send a protocol marker
      // that deliberately differs from the room epoch; the existing client
      // handler treats it as a state change and reloads before it can edit.
      // New clients append their version to the otherwise-compatible handshake.
      if (clientProtocolVersion !== COLLABORATION_PROTOCOL_VERSION) {
        send(connection.socket, protocolMessage(`${room.epoch}:reload`));
        connection.socket.close(4001, "Collaboration protocol upgrade required");
        return;
      }
      if (!connection.protocolVerified) {
        connection.protocolVerified = true;
        if (connection.protocolTimer) clearTimeout(connection.protocolTimer);
        connection.protocolTimer = null;
        await this.sanitizeCompileStates(room);
        this.sendSyncStep1(room, connection.socket);
        await this.sendCompileStates(room, connection.socket);
        this.sendAwareness(room, connection.socket);
        this.sendFormatLeaseStates(room, connection);
      }
      return;
    }
    if (!connection.protocolVerified) return;
    if (messageType === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      const syncType = decoding.readVarUint(decoder);
      if (syncType === syncProtocol.messageYjsSyncStep1) {
        syncProtocol.readSyncStep1(decoder, encoder, room.doc);
      } else if (syncType === syncProtocol.messageYjsSyncStep2) {
        // Read-only browsers may still carry a stale IndexedDB document. Do
        // not apply their source updates, but always send the authoritative
        // ephemeral compile state back to them.
        if (canEdit(current)) syncProtocol.readSyncStep2(decoder, room.doc, connection);
        await this.sanitizeCompileStates(room);
        await this.sendCompileStates(room, connection.socket);
      } else if (canEdit(current)) {
        if (syncType === syncProtocol.messageYjsUpdate) syncProtocol.readUpdate(decoder, room.doc, connection);
      }
      if (encoding.length(encoder) > 1) send(connection.socket, encoding.toUint8Array(encoder));
      return;
    }
    if (messageType === MESSAGE_QUERY_AWARENESS) {
      this.sendAwareness(room, connection.socket);
      return;
    }
    if (messageType === MESSAGE_FLUSH) {
      const requestId = decoding.readVarString(decoder).slice(0, 128);
      if (!canEdit(current)) return;
      if (room.snapshotBarrierDepth > 0 || (this.snapshotBarriers.get(room.projectId) ?? 0) > 0) {
        // Do not report the intentionally deferred flush as a failure. The
        // request is completed by endSnapshotBarrier() after the source tree
        // is released and the pending edits have been persisted.
        room.pendingFlushes.push({ connection, requestId });
        room.snapshotFlushPending = room.dirtyPaths.size > 0 || room.snapshotFlushPending;
        return;
      }
      let receipt: CollaborationSaveReceipt;
      try {
        receipt = await this.flushRoom(room);
      } catch {
        receipt = this.currentReceipt(room, false, [...room.dirtyPaths]);
        if (room.dirtyPaths.size > 0) this.scheduleSave(room);
      }
      this.sendFlushReceipt(connection, requestId, receipt);
      return;
    }
    if (messageType === MESSAGE_FORMAT_LEASE) {
      this.handleFormatLeaseMessage(room, connection, decoder, current);
      return;
    }
    if (messageType !== MESSAGE_AWARENESS) return;
    const update = decoding.readVarUint8Array(decoder);
    const clientIds = awarenessClientIds(update);
    if (clientIds.length !== 1) return;
    const clientId = clientIds[0];
    const owner = room.awarenessOwners.get(clientId);
    if ((connection.awarenessClientId !== null && connection.awarenessClientId !== clientId) || (owner && owner !== connection)) return;
    connection.awarenessClientId = clientId;
    const [color, colorLight] = COLORS[Math.abs(clientId) % COLORS.length];
    const sanitized = modifyAwarenessUpdate(update, (state) => state === null ? null : {
      cursor: state && typeof state === "object" ? state.cursor ?? null : null,
      filePath: state && typeof state.filePath === "string" ? state.filePath.slice(0, 1024) : "",
      user: {
        id: connection.user.id,
        username: connection.user.username,
        name: connection.user.display_name,
        color,
        colorLight,
        permission: current.permission,
        sessionId: String(clientId)
      }
    });
    applyAwarenessUpdate(room.awareness, sanitized, connection);
  }

  private disconnect(room: Room, connection: Connection): void {
    if (!room.connections.delete(connection)) return;
    this.releaseFormatLeasesForConnection(room, connection);
    room.pendingFlushes = room.pendingFlushes.filter((pending) => pending.connection !== connection);
    if (connection.protocolTimer) clearTimeout(connection.protocolTimer);
    connection.protocolTimer = null;
    if (connection.sessionExpiryTimer) clearTimeout(connection.sessionExpiryTimer);
    connection.sessionExpiryTimer = null;
    if (connection.awarenessClientId !== null) {
      removeAwarenessStates(room.awareness, [connection.awarenessClientId], connection);
      room.awarenessOwners.delete(connection.awarenessClientId);
    }
    this.scheduleRoomCleanup(room);
  }

  private sendSyncStep1(room: Room, socket: WebSocket): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, room.doc);
    send(socket, encoding.toUint8Array(encoder));
  }

  private sendAwareness(room: Room, socket: WebSocket): void {
    const clients = [...room.awareness.getStates().keys()];
    if (clients.length) send(socket, awarenessMessage(encodeAwarenessUpdate(room.awareness, clients)));
  }

  private broadcast(room: Room, message: Uint8Array, except: Connection | null): void {
    for (const connection of room.connections) if (connection !== except) send(connection.socket, message);
  }

  /**
   * Serialize access to one source file while a browser-side formatter is
   * calculating and applying its replacement. This is intentionally an
   * in-memory room primitive: the lease is advisory to the live collaboration
   * room, while the Yjs update + flush ordering remains the authoritative
   * durability boundary. A disconnected holder can never keep a lease alive.
   */
  private handleFormatLeaseMessage(
    room: Room,
    connection: Connection,
    decoder: decoding.Decoder,
    currentProject: CollaborationProjectAccess
  ): void {
    const operation = decoding.hasContent(decoder) ? decoding.readVarString(decoder).slice(0, 16) : "";
    const requestId = decoding.hasContent(decoder) ? decoding.readVarString(decoder).slice(0, 128) : "";
    const rawPath = decoding.hasContent(decoder) ? decoding.readVarString(decoder) : "";
    const token = decoding.hasContent(decoder) ? decoding.readVarString(decoder).slice(0, 128) : "";
    let filePath: string;
    try {
      filePath = safeRelativePath(rawPath);
    } catch {
      this.sendFormatLeaseResponse(connection, "denied", requestId, rawPath, "invalid path");
      return;
    }
    if (!requestId || !isCollaborativeTextFile(filePath) || !room.allowedPaths.has(filePath)) {
      this.sendFormatLeaseResponse(connection, "denied", requestId, filePath, "file is not format-able");
      return;
    }
    if (!canEdit(currentProject)) {
      this.sendFormatLeaseResponse(connection, "denied", requestId, filePath, "write permission is required");
      return;
    }
    if (operation === "acquire") {
      const current = this.activeFormatLease(room, filePath);
      if (!current) {
        // Expiring a lease may have immediately granted the next queued
        // request. Do not overwrite that grant with this new request.
        if (room.formatLeases.has(filePath)) {
          const waiters = room.formatLeaseWaiters.get(filePath) ?? [];
          if (waiters.length >= MAX_FORMAT_LEASE_WAITERS) {
            this.sendFormatLeaseResponse(connection, "denied", requestId, filePath, "too many formatters are waiting");
            return;
          }
          waiters.push({ path: filePath, requestId, connection });
          room.formatLeaseWaiters.set(filePath, waiters);
          return;
        }
        this.grantFormatLease(room, { path: filePath, requestId, connection });
        return;
      }
      if (current.connection === connection) {
        this.sendFormatLeaseResponse(connection, "denied", requestId, filePath, "this session already holds the lease");
        return;
      }
      const waiters = room.formatLeaseWaiters.get(filePath) ?? [];
      if (waiters.some((waiter) => waiter.connection === connection && waiter.requestId === requestId)) return;
      if (waiters.length >= MAX_FORMAT_LEASE_WAITERS) {
        this.sendFormatLeaseResponse(connection, "denied", requestId, filePath, "too many formatters are waiting");
        return;
      }
      waiters.push({ path: filePath, requestId, connection });
      room.formatLeaseWaiters.set(filePath, waiters);
      return;
    }
    if (operation === "renew") {
      const lease = this.activeFormatLease(room, filePath);
      if (!lease || lease.connection !== connection || lease.token !== token) {
        this.sendFormatLeaseResponse(connection, "denied", requestId, filePath, "format lease is no longer valid");
        return;
      }
      this.extendFormatLease(room, lease);
      this.sendFormatLeaseResponse(connection, "renewed", requestId, filePath, "", lease.expiresAt, lease.token);
      this.broadcastFormatLeaseState(room, lease);
      return;
    }
    if (operation === "release") {
      const lease = this.activeFormatLease(room, filePath);
      if (!lease || lease.connection !== connection || lease.token !== token) {
        this.sendFormatLeaseResponse(connection, "denied", requestId, filePath, "format lease is no longer valid");
        return;
      }
      this.releaseFormatLease(room, lease);
      this.sendFormatLeaseResponse(connection, "released", requestId, filePath);
      return;
    }
    if (operation === "cancel") {
      const waiters = room.formatLeaseWaiters.get(filePath) ?? [];
      const remaining = waiters.filter((waiter) => !(waiter.connection === connection && waiter.requestId === requestId));
      if (remaining.length) room.formatLeaseWaiters.set(filePath, remaining);
      else room.formatLeaseWaiters.delete(filePath);
      // A timeout may race with the server granting the request. In that
      // window the request is no longer in the waiter queue, so also revoke a
      // matching active lease instead of leaving it until the TTL expires.
      const active = this.activeFormatLease(room, filePath);
      if (active?.connection === connection && active.requestId === requestId) {
        this.releaseFormatLease(room, active);
      }
      this.sendFormatLeaseResponse(connection, "released", requestId, filePath);
      return;
    }
    this.sendFormatLeaseResponse(connection, "denied", requestId, filePath, "unknown format lease operation");
  }

  private activeFormatLease(room: Room, filePath: string): FormatLease | null {
    const lease = room.formatLeases.get(filePath);
    if (!lease) return null;
    if (lease.expiresAt > Date.now()) return lease;
    this.releaseFormatLease(room, lease);
    return null;
  }

  private grantFormatLease(room: Room, waiter: FormatLeaseWaiter): boolean {
    if (!room.connections.has(waiter.connection) || waiter.connection.socket.readyState !== WebSocket.OPEN) return false;
    const lease: FormatLease = {
      path: waiter.path,
      token: randomUUID(),
      requestId: waiter.requestId,
      connection: waiter.connection,
      expiresAt: Date.now() + FORMAT_LEASE_TTL_MS,
      timer: setTimeout(() => this.expireFormatLease(room, waiter.path), FORMAT_LEASE_TTL_MS + 25)
    };
    room.formatLeases.set(waiter.path, lease);
    this.sendFormatLeaseResponse(waiter.connection, "grant", waiter.requestId, lease.path, "", lease.expiresAt, lease.token);
    this.broadcastFormatLeaseState(room, lease);
    return true;
  }

  private extendFormatLease(room: Room, lease: FormatLease): void {
    clearTimeout(lease.timer);
    lease.expiresAt = Date.now() + FORMAT_LEASE_TTL_MS;
    lease.timer = setTimeout(() => this.expireFormatLease(room, lease.path), FORMAT_LEASE_TTL_MS + 25);
  }

  private expireFormatLease(room: Room, filePath: string): void {
    const lease = room.formatLeases.get(filePath);
    if (!lease) return;
    if (lease.expiresAt > Date.now()) {
      lease.timer = setTimeout(() => this.expireFormatLease(room, filePath), lease.expiresAt - Date.now() + 25);
      return;
    }
    this.releaseFormatLease(room, lease);
  }

  private releaseFormatLease(room: Room, lease: FormatLease): void {
    if (room.formatLeases.get(lease.path) !== lease) return;
    clearTimeout(lease.timer);
    room.formatLeases.delete(lease.path);
    this.broadcastFormatLeaseState(room, null, lease.path);
    this.grantNextFormatLease(room, lease.path);
  }

  private grantNextFormatLease(room: Room, filePath: string): void {
    if (room.formatLeases.has(filePath)) return;
    const waiters = room.formatLeaseWaiters.get(filePath);
    if (!waiters?.length) {
      room.formatLeaseWaiters.delete(filePath);
      return;
    }
    while (waiters.length) {
      const waiter = waiters.shift()!;
      if (!room.connections.has(waiter.connection) || waiter.connection.socket.readyState !== WebSocket.OPEN) continue;
      // Keep all later requests in the room queue while the first valid
      // waiter owns the lease. The previous implementation deleted the map
      // before granting and silently dropped every later waiter.
      if (waiters.length) room.formatLeaseWaiters.set(filePath, waiters);
      else room.formatLeaseWaiters.delete(filePath);
      if (this.grantFormatLease(room, waiter)) return;
    }
    room.formatLeaseWaiters.delete(filePath);
  }

  private releaseFormatLeasesForConnection(room: Room, connection: Connection): void {
    const pathsToGrant = new Set<string>();
    for (const [filePath, lease] of room.formatLeases) {
      if (lease.connection !== connection) continue;
      pathsToGrant.add(filePath);
      clearTimeout(lease.timer);
      room.formatLeases.delete(filePath);
      this.broadcastFormatLeaseState(room, null, filePath);
    }
    for (const [filePath, waiters] of room.formatLeaseWaiters) {
      const remaining = waiters.filter((waiter) => waiter.connection !== connection);
      if (remaining.length) room.formatLeaseWaiters.set(filePath, remaining);
      else room.formatLeaseWaiters.delete(filePath);
    }
    for (const filePath of pathsToGrant) this.grantNextFormatLease(room, filePath);
  }

  private sendFormatLeaseResponse(
    connection: Connection,
    status: "grant" | "renewed" | "released" | "denied",
    requestId: string,
    filePath: string,
    reason = "",
    expiresAt = 0,
    token = ""
  ): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_FORMAT_LEASE);
    encoding.writeVarString(encoder, status);
    encoding.writeVarString(encoder, requestId);
    encoding.writeVarString(encoder, filePath);
    encoding.writeVarString(encoder, token);
    encoding.writeVarString(encoder, expiresAt > 0 ? String(expiresAt) : "");
    encoding.writeVarString(encoder, reason.slice(0, 256));
    send(connection.socket, encoding.toUint8Array(encoder));
  }

  private broadcastFormatLeaseState(room: Room, lease: FormatLease | null, filePath = lease?.path ?? ""): void {
    this.broadcast(room, formatLeaseStateMessage(lease, filePath), null);
  }

  private sendFormatLeaseStates(room: Room, connection: Connection): void {
    for (const lease of room.formatLeases.values()) {
      if (lease.expiresAt > Date.now()) send(connection.socket, formatLeaseStateMessage(lease, lease.path));
    }
  }

  private scheduleRoomCleanup(room: Room): void {
    if (room.connections.size === 0 && !room.cleanupTimer) {
      room.cleanupTimer = setTimeout(() => { void this.destroyRoom(room); }, ROOM_IDLE_MS);
    }
  }

  private scheduleSave(room: Room): void {
    if (room.saveTimer) clearTimeout(room.saveTimer);
    room.saveTimer = setTimeout(() => {
      void this.flushRoom(room).catch(() => {
        room.saveTimer = null; /* The Yjs state remains durable and the next client flush retries. */
      });
    }, SAVE_DELAY_MS);
  }

  private scheduleStateSave(room: Room): void {
    if (room.stateSaveTimer) clearTimeout(room.stateSaveTimer);
    room.stateSaveTimer = setTimeout(() => {
      try { this.persistRoomState(room); }
      catch { room.stateSaveTimer = null; /* A later source flush will retry state persistence. */ }
    }, STATE_SAVE_DELAY_MS);
  }

  private persistRoomState(room: Room): void {
    if (room.stateSaveTimer) clearTimeout(room.stateSaveTimer);
    room.stateSaveTimer = null;
    this.rejectOversizedTexts(room);
    const target = collaborationStatePath(this.config, room.projectId);
    const temporary = `${target}.tmp`;
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, Y.encodeStateAsUpdate(room.doc), { mode: 0o600 });
    fs.renameSync(temporary, target);
  }

  private flushRoom(room: Room): Promise<CollaborationSaveReceipt> {
    if (room.flushPromise) return room.flushPromise;
    const pending = (async (): Promise<CollaborationSaveReceipt> => {
      try {
        return await this.flushRoomInternal(room);
      } finally {
        room.flushPromise = null;
      }
    })();
    room.flushPromise = pending;
    return pending;
  }

  private async flushRoomInternal(room: Room): Promise<CollaborationSaveReceipt> {
    if (room.snapshotBarrierDepth > 0 || (this.snapshotBarriers.get(room.projectId) ?? 0) > 0) {
      if (room.saveTimer) clearTimeout(room.saveTimer);
      room.saveTimer = null;
      if (room.dirtyPaths.size > 0) room.snapshotFlushPending = true;
      return this.currentReceipt(room, room.dirtyPaths.size === 0, []);
    }
    const startedAt = performance.now();
    if (room.saveTimer) clearTimeout(room.saveTimer);
    room.saveTimer = null;
    const rejectedDuringFlush = [
      ...this.rejectOversizedTexts(room),
      ...(await this.rejectOverQuotaTexts(room))
    ];
    this.persistRoomState(room);
    let changed = false;
    const changedPaths: string[] = [];
    let persistedSourceDelta = 0;
    const failedPaths: string[] = [...room.rejectedPaths];
    const finalizedPaths = new Set<string>(rejectedDuringFlush);
    const dirtyPaths = [...room.dirtyPaths];
    for (const filePath of dirtyPaths) {
      if (!room.allowedPaths.has(filePath)) {
        room.dirtyPaths.delete(filePath);
        finalizedPaths.add(filePath);
        continue;
      }
      const next = this.trackedText(room, filePath).toString();
      const previous = room.persistedContent.get(filePath) ?? "";
      if (next === previous) {
        room.dirtyPaths.delete(filePath);
        finalizedPaths.add(filePath);
        continue;
      }
      if (Buffer.byteLength(next, "utf8") > maxCollaborativeFileBytes(this.config)) {
        failedPaths.push(filePath);
        continue;
      }
      const absolute = resolveSourcePath(this.config, room.projectId, filePath);
      try {
        fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
      } catch {
        failedPaths.push(filePath);
        continue;
      }
      const temporary = `${absolute}.collaboration-${process.pid}-${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, next, { encoding: "utf8", mode: 0o600 });
        fs.renameSync(temporary, absolute);
      } catch (error) {
        fs.rmSync(temporary, { force: true });
        failedPaths.push(filePath);
        continue;
      }
      room.persistedContent.set(filePath, next);
      persistedSourceDelta += Buffer.byteLength(next, "utf8") - Buffer.byteLength(previous, "utf8");
      room.dirtyPaths.delete(filePath);
      finalizedPaths.add(filePath);
      try { await reanchorFileComments(this.db, room.projectId, filePath, previous, next); }
      catch { /* Source durability is primary; comments can still be re-anchored by a later edit. */ }
      changed = true;
      changedPaths.push(filePath);
    }
    const persistedPaths = new Set(changedPaths);
    const edits = room.pendingEditSegments.filter((segment) => persistedPaths.has(segment.filePath));
    // A reverted edit or rejected oversized file did not produce a durable
    // source revision, so it must not become a misleading edit-history row.
    if (finalizedPaths.size > 0) {
      room.pendingEditSegments = room.pendingEditSegments.filter((segment) => !finalizedPaths.has(segment.filePath));
    }
    if (changed && room.lastModifiedUserId) {
      await this.db.projectData.touchProject(room.projectId, room.lastModifiedUserId, new Date().toISOString());
    }
    if (persistedSourceDelta !== 0) {
      const ownerId = await this.db.projects.findOwnerId(room.projectId);
      if (ownerId) await this.projectQuota.adjustSourceBytes(ownerId, room.projectId, persistedSourceDelta);
    }
    if (changed) this.signalComments(room.projectId);
    if (changed && this.onPersist) {
      try { await this.onPersist({ projectId: room.projectId, userId: room.lastModifiedUserId, paths: changedPaths, edits, durationMs: performance.now() - startedAt }); }
      catch { /* Source durability must not depend on optional history bookkeeping. */ }
    }
    const ok = failedPaths.length === 0 && room.dirtyPaths.size === 0;
    if (changed) room.persistedRevision += 1;
    if (ok) {
      room.persistedAt = new Date().toISOString();
    } else if (!room.saveTimer && room.dirtyPaths.size > 0) {
      // Retry with backoff if dirty files remain unpersisted
      room.saveTimer = setTimeout(() => {
        void this.flushRoom(room).catch(() => { room.saveTimer = null; });
      }, 2000);
    }
    const receipt = this.currentReceipt(room, ok, [...new Set(failedPaths)]);
    room.rejectedPaths.clear();
    return receipt;
  }

  private currentReceipt(room: Room, ok = true, failedPaths: string[] = []): CollaborationSaveReceipt {
    return {
      revision: room.persistedRevision,
      persistedAt: room.persistedAt,
      ok: ok && room.dirtyPaths.size === 0,
      failedPaths
    };
  }

  private bumpFiles(room: Room, event: Record<string, string>): void {
    room.doc.transact(() => room.meta.set("filesEvent", { ...event, revision: randomUUID() }), META_ORIGIN);
  }

  private async destroyRoom(room: Room, persist = true): Promise<void> {
    if (this.rooms.get(room.projectId) !== room) return;
    if (persist) {
      try { await this.flushRoom(room); }
      catch { try { this.persistRoomState(room); } catch { /* Keep shutdown best-effort. */ } }
    }
    this.disposeRoom(room);
    this.rooms.delete(room.projectId);
  }

  private disposeRoom(room: Room): void {
    if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
    if (room.saveTimer) clearTimeout(room.saveTimer);
    if (room.stateSaveTimer) clearTimeout(room.stateSaveTimer);
    for (const connection of room.connections) {
      if (connection.protocolTimer) clearTimeout(connection.protocolTimer);
      connection.protocolTimer = null;
      if (connection.sessionExpiryTimer) clearTimeout(connection.sessionExpiryTimer);
      connection.sessionExpiryTimer = null;
    }
    room.connections.clear();
    for (const lease of room.formatLeases.values()) clearTimeout(lease.timer);
    room.formatLeases.clear();
    room.formatLeaseWaiters.clear();
    room.pendingFlushes.splice(0);
    room.rejectedPaths.clear();
    room.awarenessOwners.clear();
    for (const [filePath, observer] of room.textObservers) {
      room.doc.getText(typeName(filePath)).unobserve(observer);
    }
    room.awareness.destroy();
    room.doc.destroy();
  }

  private rejectOversizedTexts(room: Room): string[] {
    const rejected: string[] = [];
    const limit = maxCollaborativeFileBytes(this.config);
    for (const filePath of [...room.dirtyPaths]) {
      const text = this.trackedText(room, filePath);
      if (Buffer.byteLength(text.toString(), "utf8") <= limit) continue;
      const previous = room.persistedContent.get(filePath) ?? "";
      room.doc.transact(() => replaceText(text, previous), DISK_ORIGIN);
      room.dirtyPaths.delete(filePath);
      room.rejectedPaths.add(filePath);
      rejected.push(filePath);
    }
    return rejected;
  }

  /**
   * Revert a batch of live edits before it reaches disk when its resulting
   * source tree would exceed the owning account's aggregate quota.  This is
   * intentionally parallel to the per-file collaborative size guard: Yjs
   * state must not keep an over-quota draft that would later be retried after
   * an unrelated file operation.
   */
  private async rejectOverQuotaTexts(room: Room): Promise<string[]> {
    const ownerId = await this.db.projects.findOwnerId(room.projectId);
    if (!ownerId) return [];
    const changes: Array<{ filePath: string; text: Y.Text; previous: string; delta: number }> = [];
    let delta = 0;
    for (const filePath of room.dirtyPaths) {
      if (!room.allowedPaths.has(filePath)) continue;
      const text = this.trackedText(room, filePath);
      const previous = room.persistedContent.get(filePath) ?? "";
      const next = text.toString();
      if (next === previous) continue;
      const change = Buffer.byteLength(next, "utf8") - Buffer.byteLength(previous, "utf8");
      changes.push({ filePath, text, previous, delta: change });
      delta += change;
    }
    if (!changes.length || delta <= 0) return [];
    const currentBytes = await this.projectQuota.sourceBytes(ownerId, room.projectId);
    if (await this.projectQuota.canStoreSource(ownerId, room.projectId, currentBytes + delta)) return [];
    room.doc.transact(() => {
      for (const change of changes) replaceText(change.text, change.previous);
    }, DISK_ORIGIN);
    for (const change of changes) {
      room.dirtyPaths.delete(change.filePath);
      room.rejectedPaths.add(change.filePath);
    }
    return changes.map((change) => change.filePath);
  }

  private sendFlushReceipt(connection: Connection, requestId: string, receipt: CollaborationSaveReceipt): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_FLUSH);
    encoding.writeVarString(encoder, requestId);
    encoding.writeVarUint(encoder, receipt.ok ? 1 : 0);
    encoding.writeVarUint(encoder, receipt.revision);
    encoding.writeVarString(encoder, receipt.persistedAt);
    encoding.writeVarUint(encoder, receipt.failedPaths?.length ?? 0);
    for (const failed of receipt.failedPaths ?? []) encoding.writeVarString(encoder, failed);
    send(connection.socket, encoding.toUint8Array(encoder));
  }

  private resolvePendingFlushes(room: Room, receipt: CollaborationSaveReceipt): void {
    const pending = room.pendingFlushes.splice(0);
    for (const request of pending) {
      if (room.connections.has(request.connection)) this.sendFlushReceipt(request.connection, request.requestId, receipt);
    }
  }

  private projectGeneration(projectId: string): number {
    return this.projectGenerations.get(projectId) ?? 0;
  }

  private pendingConnectionKey(projectId: string, generation: number): string {
    return `${projectId}\0${generation}`;
  }

  private invalidateProject(projectId: string): void {
    this.projectGenerations.set(projectId, this.projectGeneration(projectId) + 1);
    this.roomInitializations.delete(projectId);
  }
}

export function collaborationStatePath(config: Config, projectId: string): string {
  return path.join(outputRoot(config, projectId), ".texlite", "collaboration.bin");
}

export function collaborationEpochPath(config: Config, projectId: string): string {
  return path.join(outputRoot(config, projectId), ".texlite", "collaboration.epoch");
}

export function maxCollaborativeFileBytes(config: Config): number {
  return Math.min(config.maxUploadBytes, MAX_COLLABORATIVE_FILE_BYTES);
}

export function isCollaborativeTextFile(filePath: string): boolean {
  return /\.(?:tex|bib|bst|sty|cls|txt|md)$/i.test(filePath);
}

function collaborativeEntrySignature(entry: FileEntry): string {
  return `${entry.path}\0${entry.size ?? 0}\0${entry.mtimeMs ?? 0}`;
}

async function collaborationEpochAsync(config: Config, projectId: string, recoveredState: boolean): Promise<string> {
  const target = collaborationEpochPath(config, projectId);
  if (recoveredState) {
    try {
      const existing = (await fs.promises.readFile(target, "utf8")).trim();
      if (new RegExp(`^${COLLABORATION_PROTOCOL_VERSION}:[a-f0-9-]{36}$`, "i").test(existing)) return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Generate a fresh epoch when the previous marker is missing.
    }
  }
  const epoch = `${VERSIONED_EPOCH_PREFIX}${randomUUID()}`;
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    await fs.promises.writeFile(temporary, epoch, { encoding: "utf8", mode: 0o600 });
    await fs.promises.rename(temporary, target);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true });
    throw error;
  }
  return epoch;
}

function typeName(filePath: string): string {
  return `${SOURCE_PREFIX}${filePath}`;
}

function replaceText(text: Y.Text, content: string): void {
  if (text.toString() === content) return;
  if (text.length) text.delete(0, text.length);
  if (content) text.insert(0, content);
}

/**
 * Turn Y.Text's transaction delta into compact positional spans. We retain
 * lengths for exact range mapping, while previews keep a pasted/formatter
 * change from turning the edit-history database into a second source store.
 */
function editSpansFromYDelta(delta: readonly unknown[], before: string, after: string): EditHistorySpan[] {
  if (before === after) return [];
  let beforeOffset = 0;
  let afterOffset = 0;
  let invalid = false;
  const spans: EditHistorySpan[] = [];
  let pending: { beforeStart: number; afterStart: number; deleted: string; inserted: string } | null = null;
  const flushPending = () => {
    if (!pending) return;
    const deletedLength = pending.deleted.length;
    const insertedLength = pending.inserted.length;
    if (deletedLength || insertedLength) {
      spans.push(editSpan(
        pending.beforeStart, pending.beforeStart + deletedLength,
        pending.afterStart, pending.afterStart + insertedLength,
        pending.deleted, pending.inserted
      ));
    }
    pending = null;
  };
  const startPending = () => {
    if (!pending) pending = { beforeStart: beforeOffset, afterStart: afterOffset, deleted: "", inserted: "" };
    return pending;
  };

  for (const raw of delta) {
    if (!raw || typeof raw !== "object") { invalid = true; break; }
    const operation = raw as { retain?: unknown; delete?: unknown; insert?: unknown };
    if (typeof operation.retain === "number" && Number.isInteger(operation.retain) && operation.retain >= 0) {
      flushPending();
      beforeOffset += operation.retain;
      afterOffset += operation.retain;
      continue;
    }
    if (typeof operation.delete === "number" && Number.isInteger(operation.delete) && operation.delete >= 0) {
      const length = operation.delete;
      if (beforeOffset + length > before.length) { invalid = true; break; }
      startPending().deleted += before.slice(beforeOffset, beforeOffset + length);
      beforeOffset += length;
      continue;
    }
    if (typeof operation.insert === "string") {
      startPending().inserted += operation.insert;
      afterOffset += operation.insert.length;
      continue;
    }
    invalid = true;
    break;
  }
  flushPending();
  // Yjs normally emits retains for all unchanged text. Be defensive about
  // omitted trailing retains, then reject anything whose coordinate model does
  // not reconstruct the actual strings.
  const beforeRemaining = before.length - beforeOffset;
  const afterRemaining = after.length - afterOffset;
  if (beforeRemaining === afterRemaining && beforeRemaining >= 0) {
    beforeOffset = before.length;
    afterOffset = after.length;
  }
  if (invalid || beforeOffset !== before.length || afterOffset !== after.length || spans.length > MAX_EDIT_SPANS_PER_STEP) {
    return [wholeDocumentEditSpan(before, after)];
  }
  return spans.length ? spans : [wholeDocumentEditSpan(before, after)];
}

function wholeDocumentEditSpan(before: string, after: string): EditHistorySpan {
  const prefix = commonPrefixLength(before, after);
  const suffix = commonSuffixLength(before, after, prefix);
  return editSpan(
    prefix, before.length - suffix,
    prefix, after.length - suffix,
    before.slice(prefix, before.length - suffix), after.slice(prefix, after.length - suffix)
  );
}

function editSpan(
  beforeStart: number,
  beforeEnd: number,
  afterStart: number,
  afterEnd: number,
  deleted: string,
  inserted: string
): EditHistorySpan {
  const deletedPreview = previewEditText(deleted);
  const insertedPreview = previewEditText(inserted);
  return {
    beforeStart,
    beforeEnd,
    afterStart,
    afterEnd,
    deletedLength: deleted.length,
    insertedLength: inserted.length,
    deletedPreview,
    insertedPreview,
    truncated: deletedPreview.length < deleted.length || insertedPreview.length < inserted.length
  };
}

function previewEditText(value: string): string {
  if (value.length <= MAX_EDIT_PREVIEW_CHARS) return value;
  const edge = Math.floor((MAX_EDIT_PREVIEW_CHARS - 1) / 2);
  return `${value.slice(0, edge)}…${value.slice(value.length - edge)}`;
}

function commonPrefixLength(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
}

function commonSuffixLength(left: string, right: string, prefixLength: number): number {
  const max = Math.min(left.length, right.length) - prefixLength;
  let index = 0;
  while (index < max && left.charCodeAt(left.length - 1 - index) === right.charCodeAt(right.length - 1 - index)) index += 1;
  return index;
}

function syncUpdateMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

function awarenessMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

function protocolMessage(epoch: string): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_PROTOCOL);
  encoding.writeVarString(encoder, epoch);
  return encoding.toUint8Array(encoder);
}

function isConnectionOrigin(origin: unknown): origin is Connection {
  return Boolean(origin && typeof origin === "object" && "socket" in origin);
}

function editAuthorId(origin: unknown): string | null {
  if (isConnectionOrigin(origin)) return origin.user.id;
  if (origin && typeof origin === "object") {
    const candidate = origin as Partial<AiEditOrigin>;
    if (candidate.kind === "ai" && typeof candidate.userId === "string" && candidate.userId) return candidate.userId;
  }
  return null;
}

function isSharedCompileState(mainFile: string, value: unknown): value is SharedCompileState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<SharedCompileState>;
  const requestedBy = state.requestedBy;
  return state.mainFile === mainFile
    && typeof state.runId === "string" && state.runId.length > 0
    && isCollaborationCompileStatus(state.status)
    && (state.status !== "cleaned" || isCollaborationCleanMode(state.cleanMode))
    && (state.stale === undefined || typeof state.stale === "boolean")
    && typeof state.updatedAt === "string"
    && Boolean(requestedBy && typeof requestedBy === "object"
      && typeof requestedBy.id === "string" && typeof requestedBy.username === "string"
      && typeof requestedBy.name === "string");
}

function isCompileStateMap(value: unknown): value is SharedCompileStates {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(([mainFile, state]) => isSharedCompileState(mainFile, state));
}

function maintenanceMessage(reason: string): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_MAINTENANCE);
  encoding.writeVarString(encoder, reason);
  return encoding.toUint8Array(encoder);
}

function formatLeaseStateMessage(lease: FormatLease | null, filePath: string): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_FORMAT_LEASE);
  encoding.writeVarString(encoder, "state");
  encoding.writeVarString(encoder, "");
  encoding.writeVarString(encoder, filePath);
  encoding.writeVarString(encoder, "");
  encoding.writeVarString(encoder, lease ? String(lease.expiresAt) : "");
  encoding.writeVarString(encoder, "");
  encoding.writeVarString(encoder, lease?.connection.user.id ?? "");
  encoding.writeVarString(encoder, lease?.connection.user.display_name ?? "");
  return encoding.toUint8Array(encoder);
}

function awarenessClientIds(update: Uint8Array): number[] {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  const result: number[] = [];
  for (let index = 0; index < count; index += 1) {
    result.push(decoding.readVarUint(decoder));
    decoding.readVarUint(decoder);
    decoding.readVarString(decoder);
  }
  return result;
}

function sendPermissionRevoked(socket: WebSocket, userId: string): void {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_PERMISSION);
  encoding.writeVarString(encoder, userId);
  encoding.writeVarString(encoder, "revoked");
  send(socket, encoding.toUint8Array(encoder));
}

function rawData(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function send(socket: WebSocket, message: Uint8Array): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(message);
}
