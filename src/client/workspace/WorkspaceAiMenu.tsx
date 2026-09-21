import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, FileCode2, LoaderCircle, Send, WandSparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FileEntry } from "../types";

const MAX_CONTEXT_FILES = 8;

export type WorkspaceAiAction = {
  operation: "insert" | "replace";
  promptId?: string;
  taskDescription: string;
  includeCurrentFile: boolean;
  contextFiles: string[];
};

export interface WorkspaceAiMenuProps {
  open: boolean;
  onClose: () => void;
  available: boolean;
  readOnly: boolean;
  hasSelection: boolean;
  hasActiveFile: boolean;
  activeFile: string;
  files: FileEntry[];
  busy: boolean;
  ready: boolean;
  phase: "preparing" | "generating" | "review" | "applying" | null;
  onRun: (action: WorkspaceAiAction) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

interface DragState {
  pointerId: number;
  clientX: number;
  clientY: number;
  x: number;
  y: number;
}

/** Draggable AI task dialog opened from the current line-number action. */
export function WorkspaceAiMenu({
  open, onClose, available, readOnly, hasSelection, hasActiveFile, activeFile, files,
  busy, ready, phase, onRun, onCancel, onConfirm
}: WorkspaceAiMenuProps) {
  const { t } = useTranslation();
  const [taskDescription, setTaskDescription] = useState("");
  const [promptId, setPromptId] = useState("");
  const [includeCurrentFile, setIncludeCurrentFile] = useState(false);
  const [contextFiles, setContextFiles] = useState<string[]>([]);
  const [contextOpen, setContextOpen] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dialogRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<DragState | null>(null);
  const contextCandidates = useMemo(
    () => files
      .filter((entry) => entry.type === "file" && /\.(?:tex|bib)$/i.test(entry.path) && entry.path !== activeFile)
      .sort((left, right) => left.path.localeCompare(right.path)),
    [activeFile, files]
  );

  const closeDialog = (): void => {
    if (busy) onCancel();
    else onClose();
  };

  useEffect(() => {
    if (!open) {
      dragState.current = null;
      setOffset({ x: 0, y: 0 });
      setTaskDescription("");
      setPromptId("");
      setIncludeCurrentFile(false);
      setContextFiles([]);
      setContextOpen(false);
      return;
    }
    setOffset({ x: 0, y: 0 });
  }, [open]);

  useEffect(() => {
    setContextFiles((current) => current.filter((path) => contextCandidates.some((entry) => entry.path === path)));
  }, [contextCandidates]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeDialog();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel, onClose, open]);

  if (!open || !available) return null;

  const disabled = readOnly || !hasActiveFile || busy;
  const submit = (): void => {
    const instruction = taskDescription.trim();
    if (disabled || !instruction) return;
    onRun({
      operation: hasSelection ? "replace" : "insert",
      ...(promptId ? { promptId } : {}),
      taskDescription: instruction,
      includeCurrentFile,
      contextFiles
    });
  };
  const choosePreset = (nextPromptId: string, description: string): void => {
    setPromptId(nextPromptId);
    setTaskDescription(description);
  };
  const toggleContextFile = (path: string): void => {
    setContextFiles((current) => current.includes(path)
      ? current.filter((item) => item !== path)
      : current.length >= MAX_CONTEXT_FILES ? current : [...current, path]);
  };
  const selectedContextCount = contextFiles.length + (includeCurrentFile ? 1 : 0);
  const instructionHint = includeCurrentFile
    ? t(hasSelection ? "ai.selectionHint" : "ai.cursorHint")
    : t(hasSelection ? "ai.selectionOnlyHint" : "ai.cursorOnlyHint");
  const phaseLabel = phase === "preparing"
    ? t("ai.preparing")
    : phase === "review"
      ? t("ai.review")
      : phase === "applying"
        ? t("ai.applying")
        : t("ai.generating");
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || event.pointerType === "touch" || isInteractiveTarget(event.target)) return;
    dragState.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, ...offset };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = dragState.current;
    const element = dialogRef.current;
    if (!state || state.pointerId !== event.pointerId || !element) return;
    const rect = element.getBoundingClientRect();
    const maxLeft = Math.max(0, rect.left - 12);
    const maxRight = Math.max(0, window.innerWidth - rect.right - 12);
    const maxTop = Math.max(0, rect.top - 12);
    const maxBottom = Math.max(0, window.innerHeight - rect.bottom - 12);
    setOffset({
      x: clamp(state.x + event.clientX - state.clientX, -maxLeft, maxRight),
      y: clamp(state.y + event.clientY - state.clientY, -maxTop, maxBottom)
    });
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragState.current?.pointerId !== event.pointerId) return;
    dragState.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const dialogStyle = {
    "--ai-dialog-x": `${offset.x}px`,
    "--ai-dialog-y": `${offset.y}px`
  } as CSSProperties;

  return <div className={`ai-writing-overlay${ready ? " ai-writing-overlay-confirm" : ""}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }}>
    <div
      ref={dialogRef}
      className={`ai-writing-dialog${ready ? " ai-writing-dialog-confirm" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={t("ai.title")}
      style={dialogStyle}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {ready
        ? <div className="ai-confirm-only">
          <button type="button" className="primary" onClick={onConfirm}>{t("ai.confirm")}</button>
          <button type="button" onClick={onCancel}>{t("ai.discard")}</button>
        </div>
        : <>
          <div className="ai-writing-dialog-header">
            <div className="ai-writing-dialog-title"><WandSparkles size={17} /><div><strong>{t("ai.title")}</strong><span>{t(hasSelection ? "ai.replaceSelection" : "ai.insertAtCursor")}</span></div></div>
            <button type="button" className="ai-writing-dialog-close" title={t("common.close")} aria-label={t("common.close")} onClick={closeDialog}><X size={17} /></button>
          </div>
          {busy
            ? <div className="ai-writing-busy" role="status" aria-live="polite"><LoaderCircle className="spin" size={22} /><strong>{phaseLabel}</strong><button type="button" onClick={onCancel}>{t("ai.cancel")}</button></div>
            : <div className="ai-writing-dialog-body">
              <section className="ai-instruction-section">
                <label className="ai-composer-label" htmlFor="ai-task-description">{t("ai.instructionLabel")}</label>
                <textarea
                  id="ai-task-description"
                  className="ai-task-input"
                  value={taskDescription}
                  onChange={(event) => { setTaskDescription(event.target.value); setPromptId(""); }}
                  placeholder={t(hasSelection ? "ai.instructionPlaceholderSelection" : "ai.instructionPlaceholderCursor")}
                  rows={5}
                  maxLength={2000}
                  autoFocus
                  aria-describedby={taskDescription.trim() ? "ai-instruction-hint" : "ai-instruction-hint ai-instruction-validation"}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                      event.preventDefault();
                      submit();
                    }
                  }}
                />
                <small id="ai-instruction-hint" className="ai-input-hint">{instructionHint}</small>
                {!taskDescription.trim() && <small id="ai-instruction-validation" className="ai-input-validation">{t("ai.instructionRequired")}</small>}
              </section>
              <section className="ai-quick-section" aria-label={t("ai.quickInstructions")}>
                <span className="ai-section-label">{t("ai.quickInstructions")}</span>
                <div className="ai-preset-row">
                  {hasSelection && <button type="button" onClick={() => choosePreset("polish", t("ai.tasks.polish"))}>{t("ai.polish")}</button>}
                  {hasSelection && <button type="button" onClick={() => choosePreset("academic", t("ai.tasks.academic"))}>{t("ai.academic")}</button>}
                  {hasSelection && <button type="button" onClick={() => choosePreset("simplify", t("ai.tasks.simplify"))}>{t("ai.simplify")}</button>}
                  {!hasSelection && <button type="button" onClick={() => choosePreset("continue-writing", t("ai.tasks.continueWriting"))}>{t("ai.continueWriting")}</button>}
                  {!hasSelection && <button type="button" onClick={() => choosePreset("complete-section", t("ai.tasks.completeSection"))}>{t("ai.completeSection")}</button>}
                  {!hasSelection && <button type="button" onClick={() => choosePreset("follow-style", t("ai.tasks.followStyle"))}>{t("ai.followStyle")}</button>}
                </div>
              </section>
              <div className="ai-target-file"><FileCode2 size={15} /><span>{t("ai.targetFile")} <code title={activeFile}>{activeFile}</code></span></div>
              {hasActiveFile && <section className="ai-context-section">
                <button type="button" className="ai-context-toggle" aria-expanded={contextOpen} onClick={() => setContextOpen((current) => !current)}>
                  <span><FileCode2 size={15} /><strong>{t("ai.addContextFiles")}</strong><small>{t("ai.optional")}</small></span>
                  <span><small>{selectedContextCount > 0 ? t("ai.contextSelected", { count: selectedContextCount }) : t("ai.notAdded")}</small><ChevronDown size={15} /></span>
                </button>
                {contextOpen && <div className="ai-context-body">
                  <small className="ai-context-description">{t("ai.contextFilesHint")}</small>
                  <div className="ai-context-file-list">
                    <label className="ai-context-file ai-context-target" key="__current_file__">
                      <input type="checkbox" checked={includeCurrentFile} onChange={() => setIncludeCurrentFile((current) => !current)} disabled={!includeCurrentFile && selectedContextCount >= MAX_CONTEXT_FILES} />
                      <span title={activeFile}>{activeFile}</span>
                      <small>{t("ai.targetFile")}</small>
                    </label>
                    {contextCandidates.map((entry) => <label className="ai-context-file" key={entry.path}>
                      <input type="checkbox" checked={contextFiles.includes(entry.path)} onChange={() => toggleContextFile(entry.path)} disabled={!contextFiles.includes(entry.path) && selectedContextCount >= MAX_CONTEXT_FILES} />
                      <span title={entry.path}>{entry.path}</span>
                    </label>)}
                  </div>
                  {selectedContextCount > 0 && <small className="ai-context-warning">{t("ai.contextSlowWarning")}</small>}
                </div>}
              </section>}
              <div className="ai-composer-footer">
                <small className="ai-keyboard-hint">{t("ai.keyboardHint")}</small>
                <div className="ai-composer-actions"><button type="button" className="ai-cancel-button" onClick={onClose}>{t("common.cancel")}</button><button type="button" className="ai-submit" disabled={!taskDescription.trim()} onClick={submit}><Send size={15} />{t("ai.generate")}</button></div>
              </div>
            </div>}
        </>}
    </div>
  </div>;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button, a, input, select, textarea, label"));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
