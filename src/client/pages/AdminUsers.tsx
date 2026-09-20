import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { ConfirmDialog, Modal } from "../Dialog";
import { errorMessage } from "../errors";
import type { SiteConfig, User } from "../types";
import { isUsernameSyntaxValid, MAX_DISPLAY_NAME_LENGTH, MAX_USERNAME_LENGTH, MIN_USERNAME_LENGTH } from "../../shared/userIdentity";
import {
  ChevronLeft, ChevronRight, Dices, FolderCheck, FolderX, KeyRound, LoaderCircle, MoreHorizontal, Search, ShieldCheck, ShieldOff, Trash2,
  UserCheck, UserPlus, UserX, Users, X
} from "lucide-react";

function randomPassword(length = 10): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
}

type RestrictedUserSetting = "disable" | "demote" | "denyProjectCreation";

interface PendingUserSetting {
  target: User;
  setting: RestrictedUserSetting;
}

function AdminUserActionMenu({
  target,
  currentUserId,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  onToggle,
  onToggleRole,
  onToggleProjectCreation,
  onResetPassword,
  onDelete
}: {
  target: User;
  currentUserId: string;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onToggle: () => void;
  onToggleRole: () => void;
  onToggleProjectCreation: () => void;
  onResetPassword: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const closeWhenOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) onCloseMenu();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseMenu();
    };
    document.addEventListener("pointerdown", closeWhenOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeWhenOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen, onCloseMenu]);
  const select = (action: () => void) => {
    onCloseMenu();
    action();
  };
  return <div ref={root} className="project-action-menu-root project-action-menu-list admin-user-actions-root" onClick={(event) => event.stopPropagation()}>
    <button type="button" className="project-action-menu-trigger" aria-label={t("users.actions")} aria-expanded={menuOpen} onClick={onToggleMenu}>
      <MoreHorizontal aria-hidden size={19} />
    </button>
    {menuOpen && <div className="project-action-menu admin-user-actions-menu" role="menu" aria-label={t("users.actions")}>
      <button type="button" role="menuitem" disabled={target.id === currentUserId} onClick={() => select(onToggle)}>{target.disabled ? <UserCheck aria-hidden size={15} /> : <UserX aria-hidden size={15} />}{target.disabled ? t("users.enable") : t("users.disable")}</button>
      <button type="button" role="menuitem" disabled={target.id === currentUserId} onClick={() => select(onToggleRole)}>{target.role === "admin" ? <ShieldOff aria-hidden size={15} /> : <ShieldCheck aria-hidden size={15} />}{target.role === "admin" ? t("users.demote") : t("users.promote")}</button>
      <button type="button" role="menuitem" disabled={target.role === "admin"} onClick={() => select(onToggleProjectCreation)}>{target.canCreateProjects ? <FolderX aria-hidden size={15} /> : <FolderCheck aria-hidden size={15} />}{target.canCreateProjects ? t("users.denyCreate") : t("users.allowCreate")}</button>
      <button type="button" role="menuitem" onClick={() => select(onResetPassword)}><KeyRound aria-hidden size={15} />{t("users.resetPassword")}</button>
      <div className="project-action-menu-separator" aria-hidden="true" />
      <button type="button" role="menuitem" className="danger" disabled={target.id === currentUserId} onClick={() => select(onDelete)}><Trash2 aria-hidden size={15} />{t("common.delete")}</button>
    </div>}
  </div>;
}

export function AdminUsers({ currentUser, minPasswordLength }: { currentUser: User; minPasswordLength: SiteConfig["minPasswordLength"] }) {
  const { t } = useTranslation();
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ username: "", displayName: "", password: "", role: "user" as "user" | "admin", canCreateProjects: false });
  const [resetTarget, setResetTarget] = useState<User | null>(null);
  const [resetValue, setResetValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);
  const [deleteProjects, setDeleteProjects] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [pendingSetting, setPendingSetting] = useState<PendingUserSetting | null>(null);
  const [pendingSettingBusy, setPendingSettingBusy] = useState(false);
  const [pendingSettingError, setPendingSettingError] = useState("");
  const [openUserMenuId, setOpenUserMenuId] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
  const load = (pageNumber = page, searchValue = search, size = pageSize) => api<{ users: User[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }>(
    `/api/admin/users?page=${pageNumber}&pageSize=${size}&search=${encodeURIComponent(searchValue)}`
  ).then((result) => { setUsers(result.users); setPagination(result.pagination); setPage(result.pagination.page); })
    .catch((e) => setError(errorMessage(e)));
  useEffect(() => { void load(1, "", pageSize); }, []);
  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    const nextSearch = searchInput.trim();
    setSearch(nextSearch);
    void load(1, nextSearch, pageSize);
  };
  const create = async () => {
    const username = createForm.username.trim();
    if (!isUsernameSyntaxValid(username)) return setError(t("auth.usernameInvalid"));
    if (createForm.password.length < minPasswordLength) return setError(t("auth.passwordMinimum", { count: minPasswordLength }));
    try {
      await api("/api/admin/users", { method: "POST", body: JSON.stringify({
        username,
        displayName: createForm.displayName.trim() || username,
        password: createForm.password,
        role: createForm.role,
        canCreateProjects: createForm.canCreateProjects
      }) });
      setCreateOpen(false); setCreateForm({ username: "", displayName: "", password: "", role: "user", canCreateProjects: false });
      await load(page, search, pageSize);
    } catch (e) { setError(errorMessage(e)); }
  };
  const updateUser = async (target: User, patch: Record<string, unknown>) => {
    try {
      await api(`/api/admin/users/${target.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      await load(page, search, pageSize);
    } catch (e) { setError(errorMessage(e)); }
  };
  const toggle = async (target: User) => {
    if (!target.disabled) {
      setPendingSetting({ target, setting: "disable" });
      setPendingSettingError("");
      return;
    }
    await updateUser(target, { disabled: false });
  };
  const toggleRole = async (target: User) => {
    if (target.role === "admin") {
      setPendingSetting({ target, setting: "demote" });
      setPendingSettingError("");
      return;
    }
    await updateUser(target, { role: "admin" });
  };
  const toggleProjectCreation = async (target: User) => {
    if (target.canCreateProjects) {
      setPendingSetting({ target, setting: "denyProjectCreation" });
      setPendingSettingError("");
      return;
    }
    await updateUser(target, { canCreateProjects: true });
  };
  const applyRestrictedSetting = async () => {
    if (!pendingSetting) return;
    const { target, setting } = pendingSetting;
    const patch = setting === "disable"
      ? { disabled: true }
      : setting === "demote"
        ? { role: "user" }
        : { canCreateProjects: false };
    setPendingSettingBusy(true);
    setPendingSettingError("");
    try {
      await api(`/api/admin/users/${target.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      await load(page, search, pageSize);
      setPendingSetting(null);
    } catch (e) { setPendingSettingError(errorMessage(e)); }
    finally { setPendingSettingBusy(false); }
  };
  const resetPassword = async () => {
    if (!resetTarget || !resetValue) return;
    if (resetValue.length < minPasswordLength) return setError(t("auth.passwordMinimum", { count: minPasswordLength }));
    try {
      await api(`/api/admin/users/${resetTarget.id}`, { method: "PATCH", body: JSON.stringify({ password: resetValue }) });
      setResetTarget(null); setResetValue("");
    } catch (e) { setError(errorMessage(e)); }
  };
  const remove = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await api(`/api/admin/users/${deleteTarget.id}`, { method: "DELETE", body: JSON.stringify({ deleteProjects }) });
      setDeleteTarget(null); setDeleteProjects(false);
      await load(page, search, pageSize);
    } catch (e) { setDeleteError(errorMessage(e)); }
    finally { setDeleting(false); }
  };
  return <main className="dashboard">
    <div className="section-title"><div><h1><Users aria-hidden size={25} />{t("users.manage")}</h1><p className="muted">{t("users.onlyAdmin")}</p></div><button className="primary icon-button" onClick={() => setCreateOpen(true)}><UserPlus aria-hidden size={15} />{t("users.add")}</button></div>
    {error && <p className="error">{error}</p>}
    <form className="admin-user-search" onSubmit={submitSearch}><Search aria-hidden size={16} /><input type="search" value={searchInput} placeholder={t("users.searchPlaceholder")} onChange={(event) => setSearchInput(event.target.value)} /><button type="submit">{t("common.search")}</button></form>
    <div className="table-card admin-users-table-card"><table className={`admin-users-table${openUserMenuId ? " admin-users-menu-active" : ""}`}><thead><tr><th>{t("common.user")}</th><th>{t("users.email")}</th><th>{t("users.role")}</th><th>{t("users.createProjects")}</th><th>{t("users.ownedProjects")}</th><th>{t("users.status")}</th><th>{t("users.actions")}</th></tr></thead>
      <tbody>{users.map((target) => <tr className={openUserMenuId === target.id ? "admin-user-row-menu-open" : undefined} key={target.id}><td><strong>{target.displayName}</strong><small>@{target.username}</small></td><td><span>{target.email ?? "—"}</span>{target.nuwaxConnected && <small>{t("users.nuwaxConnected")}</small>}</td><td>{target.role === "admin" ? t("common.admin") : t("common.user")}</td><td>{target.canCreateProjects ? t("users.allow") : t("users.deny")}</td><td>{target.ownedProjects}</td><td>{target.disabled ? t("common.disabled") : t("common.normal")}</td><td>
        <AdminUserActionMenu target={target} currentUserId={currentUser.id} menuOpen={openUserMenuId === target.id} onToggleMenu={() => setOpenUserMenuId((current) => current === target.id ? null : target.id)} onCloseMenu={() => setOpenUserMenuId((current) => current === target.id ? null : current)} onToggle={() => { void toggle(target); }} onToggleRole={() => { void toggleRole(target); }} onToggleProjectCreation={() => { void toggleProjectCreation(target); }} onResetPassword={() => { setResetTarget(target); setResetValue(""); }} onDelete={() => { setDeleteTarget(target); setDeleteProjects(false); setDeleteError(""); }} />
      </td></tr>)}</tbody></table></div>
    <div className="pagination-bar"><label>{t("users.pageSize")}<select value={pageSize} onChange={(event) => { const next = Number(event.target.value); setPageSize(next); void load(1, search, next); }}><option value={20}>20</option><option value={50}>50</option><option value={100}>100</option></select></label><span>{t("users.pageOf", { page: pagination.page, totalPages: pagination.totalPages || 1, count: pagination.total })}</span><button className="icon-button" disabled={pagination.page <= 1} onClick={() => void load(pagination.page - 1)}><ChevronLeft size={14} />{t("users.previousPage")}</button><button className="icon-button" disabled={pagination.totalPages === 0 || pagination.page >= pagination.totalPages} onClick={() => void load(pagination.page + 1)}>{t("users.nextPage")}<ChevronRight size={14} /></button></div>
    <Modal open={createOpen} title={t("users.add")} description={t("users.addDescription")} onOpenChange={setCreateOpen} footer={<><button className="icon-button" onClick={() => setCreateOpen(false)}><X aria-hidden size={14} />{t("common.cancel")}</button><button className="primary icon-button" disabled={createForm.password.length < minPasswordLength} onClick={() => void create()}><UserPlus aria-hidden size={14} />{t("users.createUser")}</button></>}>
      <div className="form-stack"><label className="form-field">{t("auth.username")}<input required minLength={MIN_USERNAME_LENGTH} maxLength={MAX_USERNAME_LENGTH} value={createForm.username} onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })} /><small className="field-hint">{t("auth.usernameRules")}</small></label><label className="form-field">{t("users.displayName")}<input required minLength={1} maxLength={MAX_DISPLAY_NAME_LENGTH} value={createForm.displayName} onChange={(e) => setCreateForm({ ...createForm, displayName: e.target.value })} /><small className="field-hint">{t("profile.displayNameHint")}</small></label><label className="form-field">{t("users.initialPassword")}<span className="password-generator"><input minLength={minPasswordLength} autoComplete="new-password" value={createForm.password} onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })} /><button type="button" title={t("users.generatePassword")} onClick={() => setCreateForm({ ...createForm, password: randomPassword() })}><Dices size={15} />{t("users.randomPassword")}</button></span><small className="field-hint">{t("auth.passwordMinimum", { count: minPasswordLength })}</small></label><label className="form-field">{t("users.role")}<select value={createForm.role} onChange={(e) => setCreateForm({ ...createForm, role: e.target.value as "user" | "admin" })}><option value="user">{t("common.user")}</option><option value="admin">{t("common.admin")}</option></select></label><label className="checkbox-field"><input type="checkbox" checked={createForm.canCreateProjects || createForm.role === "admin"} disabled={createForm.role === "admin"} onChange={(e) => setCreateForm({ ...createForm, canCreateProjects: e.target.checked })} /> {t("users.allowCreate")}</label></div>
    </Modal>
    <Modal open={Boolean(resetTarget)} title={t("users.resetPassword")} description={t("users.resetDescription", { username: resetTarget?.username ?? "" })} onOpenChange={(open) => { if (!open) setResetTarget(null); }} footer={<><button className="icon-button" onClick={() => setResetTarget(null)}><X aria-hidden size={14} />{t("common.cancel")}</button><button className="primary icon-button" disabled={resetValue.length < minPasswordLength} onClick={() => void resetPassword()}><KeyRound aria-hidden size={14} />{t("users.reset")}</button></>}>
      <label className="form-field">{t("auth.newPassword")}<input autoFocus type="password" minLength={minPasswordLength} autoComplete="new-password" value={resetValue} onChange={(e) => setResetValue(e.target.value)} /><small className="field-hint">{t("auth.passwordMinimum", { count: minPasswordLength })}</small></label>
    </Modal>
    <Modal open={Boolean(deleteTarget)} title={t("users.deleteTitle")} description={t("users.deleteDescription", { username: deleteTarget?.username ?? "" })} onOpenChange={(open) => { if (!open && !deleting) { setDeleteTarget(null); setDeleteError(""); } }} footer={<><button className="icon-button" disabled={deleting} onClick={() => { setDeleteTarget(null); setDeleteError(""); }}><X aria-hidden size={14} />{t("common.cancel")}</button><button className="danger icon-button" disabled={deleting} aria-busy={deleting} onClick={() => void remove()}>{deleting ? <LoaderCircle className="spin" aria-hidden size={14} /> : <Trash2 aria-hidden size={14} />}{deleting ? t("common.loading") : t("users.deleteTitle")}</button></>}>
      <>{deleteError && <p className="error dialog-error">{deleteError}</p>}<fieldset className="choice-group" disabled={deleting}><legend>{t("users.ownedChoice", { count: deleteTarget?.ownedProjects ?? 0 })}</legend><label><input type="radio" checked={!deleteProjects} onChange={() => setDeleteProjects(false)} /> {t("users.transferProjects")}</label><label><input type="radio" checked={deleteProjects} onChange={() => setDeleteProjects(true)} /> {t("users.deleteProjects")}</label></fieldset></>
    </Modal>
    <ConfirmDialog
      open={Boolean(pendingSetting)}
      title={t(`userConfirmations.${pendingSetting?.setting ?? "disable"}Title`)}
      description={t(`userConfirmations.${pendingSetting?.setting ?? "disable"}Description`, { username: pendingSetting?.target.username ?? "" })}
      confirmLabel={t(`userConfirmations.${pendingSetting?.setting ?? "disable"}Confirm`)}
      danger
      busy={pendingSettingBusy}
      error={pendingSettingError}
      onCancel={() => { if (!pendingSettingBusy) { setPendingSetting(null); setPendingSettingError(""); } }}
      onConfirm={() => void applyRestrictedSetting()}
    />
  </main>;
}
