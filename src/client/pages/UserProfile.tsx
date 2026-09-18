import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, CheckCircle2, Github, KeyRound, Save, UserRound } from "lucide-react";
import { api } from "../api";
import { errorMessage } from "../errors";
import type { SiteConfig, User } from "../types";

export function UserProfile({ site, user, onUser, onBack }: {
  site: SiteConfig;
  user: User;
  onUser: (user: User) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [displayNameBusy, setDisplayNameBusy] = useState(false);
  const [displayNameError, setDisplayNameError] = useState("");
  const [displayNameSaved, setDisplayNameSaved] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordSaved, setPasswordSaved] = useState(false);

  const saveDisplayName = async (event: FormEvent) => {
    event.preventDefault();
    if (!displayName.trim() || displayNameBusy) return;
    setDisplayNameBusy(true);
    setDisplayNameError("");
    setDisplayNameSaved(false);
    try {
      const result = await api<{ user: User }>("/api/me", {
        method: "PATCH",
        body: JSON.stringify({ displayName })
      });
      setDisplayName(result.user.displayName);
      onUser(result.user);
      setDisplayNameSaved(true);
    } catch (error) {
      setDisplayNameError(errorMessage(error));
    } finally {
      setDisplayNameBusy(false);
    }
  };

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (passwordBusy) return;
    setPasswordError("");
    setPasswordSaved(false);
    if (user.hasPassword && !currentPassword) return setPasswordError(t("profile.currentPasswordRequired"));
    if (newPassword !== confirmPassword) return setPasswordError(t("auth.mismatch"));
    if (newPassword.length < site.minPasswordLength) return setPasswordError(t("auth.passwordMinimum", { count: site.minPasswordLength }));
    setPasswordBusy(true);
    try {
      const result = await api<{ user: User }>("/api/me/password", {
        method: "PUT",
        body: JSON.stringify({ currentPassword, newPassword })
      });
      onUser(result.user);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordSaved(true);
    } catch (error) {
      setPasswordError(errorMessage(error));
    } finally {
      setPasswordBusy(false);
    }
  };

  return <section className="profile-page">
    <header className="profile-page-header">
      <div>
        <h1><UserRound aria-hidden size={25} />{t("profile.title")}</h1>
        <p>{t("profile.description")}</p>
      </div>
      <button type="button" onClick={onBack}><ArrowLeft aria-hidden size={15} />{t("profile.back")}</button>
    </header>
    <div className="profile-grid">
      <section className="profile-card">
        <div className="profile-card-heading"><UserRound aria-hidden size={18} /><div><h2>{t("profile.identityTitle")}</h2><p>{t("profile.identityDescription")}</p></div></div>
        <form className="profile-form" onSubmit={(event) => void saveDisplayName(event)}>
          <label className="form-field">{t("profile.displayName")}
            <input maxLength={100} value={displayName} onChange={(event) => { setDisplayName(event.target.value); setDisplayNameSaved(false); }} />
          </label>
          {displayNameError && <p className="error dialog-error">{displayNameError}</p>}
          {displayNameSaved && <p className="profile-success" role="status"><CheckCircle2 aria-hidden size={14} />{t("profile.saved")}</p>}
          <div className="profile-actions"><button className="primary icon-button" type="submit" disabled={displayNameBusy || !displayName.trim()}><Save aria-hidden size={14} />{displayNameBusy ? t("common.loading") : t("common.save")}</button></div>
        </form>
        <dl className="profile-details">
          <div><dt>{t("profile.username")}</dt><dd>@{user.username}</dd></div>
          <div><dt>{t("profile.email")}</dt><dd>{user.email ?? "—"}</dd></div>
          <div><dt>{t("profile.signIn")}</dt><dd>{user.githubConnected ? <><Github aria-hidden size={14} />{t("profile.github")}</> : t("profile.localPassword")}</dd></div>
        </dl>
      </section>
      <section className="profile-card">
        <div className="profile-card-heading"><KeyRound aria-hidden size={18} /><div><h2>{user.hasPassword ? t("profile.changePassword") : t("profile.setPassword")}</h2><p>{user.hasPassword ? t("profile.changePasswordDescription") : t("profile.setPasswordDescription")}</p></div></div>
        <form className="profile-form" onSubmit={(event) => void changePassword(event)}>
          {user.hasPassword && <label className="form-field">{t("auth.currentPassword")}
            <input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
          </label>}
          <label className="form-field">{t("auth.newPassword")}
            <input type="password" minLength={site.minPasswordLength} autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
            <small className="field-hint">{t("auth.passwordMinimum", { count: site.minPasswordLength })}</small>
          </label>
          <label className="form-field">{t("auth.confirmPassword")}
            <input type="password" minLength={site.minPasswordLength} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
          </label>
          {passwordError && <p className="error dialog-error">{passwordError}</p>}
          {passwordSaved && <p className="profile-success" role="status"><CheckCircle2 aria-hidden size={14} />{t("profile.passwordSaved")}</p>}
          <div className="profile-actions"><button className="primary icon-button" type="submit" disabled={passwordBusy}><KeyRound aria-hidden size={14} />{passwordBusy ? t("common.loading") : t("auth.updatePassword")}</button></div>
        </form>
      </section>
    </div>
  </section>;
}
