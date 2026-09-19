import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { errorMessage } from "../errors";
import type { SiteConfig, User } from "../types";
import { LanguageSwitcher } from "../LanguageSwitcher";
import { SiteFooter, SiteLogo } from "./SiteChrome";
import { appPath } from "../basePath";
import { Github } from "lucide-react";

export function ChangePassword({ site, user, onChanged }: { site: SiteConfig; user: User; onChanged: (user: User) => void }) {
  const { t } = useTranslation();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirm) return setError(t("auth.mismatch"));
    if (newPassword.length < site.minPasswordLength) return setError(t("auth.passwordMinimum", { count: site.minPasswordLength }));
    try {
      const result = await api<{ user: User }>("/api/me/password", { method: "PUT", body: JSON.stringify({ currentPassword, newPassword }) });
      onChanged(result.user);
    } catch (e) { setError(errorMessage(e)); }
  };
  return <main className="login-page"><LanguageSwitcher /><form className="login-card" onSubmit={submit}>
    <SiteLogo siteName={site.siteName} auth /><h1 className="sr-only">{site.siteName}</h1><p className="muted">{t("auth.firstLogin")}</p>
    <label>{t("auth.currentPassword")}<input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} /></label>
    <label>{t("auth.newPassword")}<input type="password" minLength={site.minPasswordLength} autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /><small className="field-hint">{t("auth.passwordMinimum", { count: site.minPasswordLength })}</small></label>
    <label>{t("auth.confirmPassword")}<input type="password" minLength={site.minPasswordLength} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
    {error && <p className="error">{error}</p>}<button className="primary">{t("auth.updatePassword")}</button>
  </form><SiteFooter /></main>;
}
export function Login({ site, onLogin }: { site: SiteConfig; onLogin: (user: User) => void }) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const returnPath = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("return") ?? "";
  const githubLoginPath = returnPath
    ? `${appPath("/api/auth/github", site.basePath)}?return=${encodeURIComponent(returnPath)}`
    : appPath("/api/auth/github", site.basePath);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const result = await api<{ user: User }>("/api/auth/login", {
        method: "POST", body: JSON.stringify({ username, password }), suppressSessionExpired: true
      });
      onLogin(result.user);
    } catch (err) { setError(errorMessage(err)); }
  };
  return <main className="login-page"><LanguageSwitcher />
    <form className="login-card login-auth-card" onSubmit={submit}>
      <SiteLogo siteName={site.siteName} auth />
      <h1 className="login-title">{t("auth.loginTitle", { site: site.siteName })}</h1>
      <p className="muted login-subtitle">{t("auth.tagline")}</p>
      {site.githubOAuthEnabled && <>
        <a className="github-login-button" href={githubLoginPath}><Github aria-hidden size={18} /><span>{t("auth.githubLogin")}</span></a>
        <div className="auth-divider"><span>{t("auth.or")}</span></div>
      </>}
      <div className="login-password-form">
        {site.githubOAuthEnabled && <p className="login-method-label">{t("auth.passwordLogin")}</p>}
        <label>{t("auth.username")}<input autoFocus={!site.githubOAuthEnabled} value={username} onChange={(e) => setUsername(e.target.value)} /></label>
        <label>{t("auth.password")}<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit">{t("auth.login")}</button>
      </div>
      {site.adminEmail && <small className="support">{t("auth.contact", { email: site.adminEmail })}</small>}
    </form><SiteFooter />
  </main>;
}
