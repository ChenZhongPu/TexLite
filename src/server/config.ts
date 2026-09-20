import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { defaultDataDirectory, packageClientDirectory, resolveConfigPath } from "./runtimePaths.js";
import { normalizeBasePath, ROOT_BASE_PATH } from "../shared/basePath.js";

export const LATEX_ENGINES = ["pdflatex", "xelatex", "lualatex"] as const;
export type LatexEngine = typeof LATEX_ENGINES[number];
export const PDF_LOADING_STRATEGIES = ["auto", "full", "range"] as const;
export type PdfLoadingStrategy = typeof PDF_LOADING_STRATEGIES[number];

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizeUrl: string;
  tokenUrl: string;
  apiUrl: string;
}

/** Effective values used when the corresponding file/env setting is omitted. */
export const CONFIG_DEFAULTS = {
  siteName: "TexLite",
  adminEmail: "",
  host: "127.0.0.1",
  port: 3000,
  basePath: ROOT_BASE_PATH,
  // The default listener is local-only, so a local reverse proxy is safe to
  // trust for client-address and protocol forwarding headers.
  trustedProxyIps: ["127.0.0.1", "::1"] as string[],
  dataDir: defaultDataDirectory(),
  clientDir: packageClientDirectory(),
  sessionDays: 7,
  compileTimeoutSeconds: 120,
  maxCompileJobs: 10,
  latexmk: "latexmk",
  defaultEngine: "xelatex" as LatexEngine,
  allowedEngines: [...LATEX_ENGINES] as LatexEngine[],
  extraArgs: [] as string[],
  allowProjectLatexmkrc: true,
  maxFileSizeMB: 50,
  pdfLoadingStrategy: "auto" as PdfLoadingStrategy,
  pdfRangeThresholdMB: 5,
  historyMaxVersions: 0,
  historyMaxStorageMB: 64,
  editHistoryMaxStorageMB: 32,
  // Public deployments need a server-side ceiling in addition to per-upload
  // limits. These apply to source files owned by one account.
  maxProjectsPerUser: 100,
  maxSourceStorageMBPerUser: 2_048,
  githubOAuth: null as GithubOAuthConfig | null,
  // Retained only so old Config fixtures and old config files can be read
  // during migration. Project-level rc files are no longer honored.
  git: "git",
  gitOperationTimeoutSeconds: 120,
  githubApiBaseUrl: "https://api.github.com"
} as const;

const CONFIG_LIMITS = {
  port: [1, 65_535],
  sessionDays: [1, 3_650],
  compileTimeoutSeconds: [1, 3_600],
  maxCompileJobs: [1, 32],
  maxFileSizeMB: [1, 2_048],
  pdfRangeThresholdMB: [1, 2_048],
  historyMaxVersions: [0, 50_000],
  historyMaxStorageMB: [16, 102_400],
  editHistoryMaxStorageMB: [4, 102_400],
  maxProjectsPerUser: [1, 100_000],
  maxSourceStorageMBPerUser: [16, 102_400],
  gitOperationTimeoutSeconds: [1, 3_600]
} as const;

export interface Config {
  configPath: string;
  siteName: string;
  adminEmail: string;
  host: string;
  port: number;
  basePath: string;
  /** Direct reverse-proxy IPs/CIDRs allowed to supply forwarding headers. */
  trustedProxyIps?: string[];
  dataDir: string;
  databasePath: string;
  projectsDir: string;
  clientDir: string;
  sessionDays: number;
  compileTimeoutMs: number;
  maxCompileJobs: number;
  latexmk: string;
  defaultEngine: LatexEngine;
  allowedEngines: LatexEngine[];
  extraArgs: string[];
  maxUploadBytes: number;
  pdfLoadingStrategy: PdfLoadingStrategy;
  pdfRangeThresholdBytes: number;
  historyMaxVersions: number;
  historyMaxStorageBytes: number;
  editHistoryMaxStorageBytes: number;
  /** Per-account project-count ceiling; populated by loadConfig(). */
  maxProjectsPerUser?: number;
  /** Per-account aggregate source-byte ceiling; populated by loadConfig(). */
  maxSourceStorageBytesPerUser?: number;
  githubOAuth?: GithubOAuthConfig | null;
  /** @deprecated Kept for source compatibility; always ignored by compile paths. */
  allowProjectLatexmkrc?: boolean;
  /** @deprecated Kept for source compatibility; Git routes are no longer registered. */
  git: string;
  gitOperationTimeoutMs: number;
  githubApiBaseUrl: string;
}

export function loadConfig(configPathOverride?: string): Config {
  const configPath = resolveConfigPath(configPathOverride);
  const fileConfig = readConfigFile(configPath);
  validateFileConfig(fileConfig);

  const configDirectory = path.dirname(configPath);
  const configuredDataDir = setting("storage.dataDir", process.env.TEXLITE_DATA_DIR, fileConfig.storage?.dataDir, CONFIG_DEFAULTS.dataDir);
  const dataDir = resolveConfiguredPath("storage.dataDir", configuredDataDir, configDirectory);
  const configuredClientDir = setting("TEXLITE_CLIENT_DIR", process.env.TEXLITE_CLIENT_DIR, undefined, CONFIG_DEFAULTS.clientDir);
  const clientDir = resolveConfiguredPath("TEXLITE_CLIENT_DIR", configuredClientDir, configDirectory);

  const configuredEngine: unknown = setting("latex.defaultEngine", process.env.TEXLITE_DEFAULT_ENGINE, fileConfig.latex?.defaultEngine, CONFIG_DEFAULTS.defaultEngine);
  if (!isEngine(configuredEngine)) {
    throw configurationError("latex.defaultEngine", `must be one of ${LATEX_ENGINES.join(", ")}; received ${displayValue(configuredEngine)}`);
  }
  const defaultEngine = configuredEngine;

  const configuredAllowed = fileConfig.latex?.allowedEngines;
  const allowedEngines = configuredAllowed === undefined
    ? [...LATEX_ENGINES]
    : configuredAllowed.map((engine) => engine as LatexEngine);
  if (!allowedEngines.includes(defaultEngine)) {
    throw configurationError("latex.allowedEngines", `must include the configured default engine “${defaultEngine}”`);
  }

  const compileTimeoutSeconds = integerSetting(
    "latex.compileTimeoutSeconds", process.env.TEXLITE_COMPILE_TIMEOUT,
    fileConfig.latex?.compileTimeoutSeconds, CONFIG_DEFAULTS.compileTimeoutSeconds, CONFIG_LIMITS.compileTimeoutSeconds
  );
  const maxCompileJobs = integerSetting(
    "latex.maxCompileJobs", process.env.TEXLITE_MAX_COMPILE_JOBS,
    fileConfig.latex?.maxCompileJobs, CONFIG_DEFAULTS.maxCompileJobs, CONFIG_LIMITS.maxCompileJobs
  );
  const maxFileSizeMB = integerSetting(
    "uploads.maxFileSizeMB", process.env.TEXLITE_MAX_UPLOAD_SIZE_MB,
    fileConfig.uploads?.maxFileSizeMB, CONFIG_DEFAULTS.maxFileSizeMB, CONFIG_LIMITS.maxFileSizeMB
  );
  const configuredPdfLoadingStrategy: unknown = setting(
    "pdf.loadingStrategy", process.env.TEXLITE_PDF_LOADING_STRATEGY,
    fileConfig.pdf?.loadingStrategy, CONFIG_DEFAULTS.pdfLoadingStrategy
  );
  if (!isPdfLoadingStrategy(configuredPdfLoadingStrategy)) {
    throw configurationError(
      "pdf.loadingStrategy",
      `must be one of ${PDF_LOADING_STRATEGIES.join(", ")}; received ${displayValue(configuredPdfLoadingStrategy)}`
    );
  }
  const pdfRangeThresholdMB = integerSetting(
    "pdf.rangeThresholdMB", process.env.TEXLITE_PDF_RANGE_THRESHOLD_MB,
    fileConfig.pdf?.rangeThresholdMB, CONFIG_DEFAULTS.pdfRangeThresholdMB, CONFIG_LIMITS.pdfRangeThresholdMB
  );
  const historyMaxVersions = integerSetting(
    "history.maxVersions", process.env.TEXLITE_HISTORY_MAX_VERSIONS,
    fileConfig.history?.maxVersions, CONFIG_DEFAULTS.historyMaxVersions, CONFIG_LIMITS.historyMaxVersions
  );
  const historyMaxStorageMB = integerSetting(
    "history.maxStorageMB", process.env.TEXLITE_HISTORY_MAX_STORAGE_MB,
    fileConfig.history?.maxStorageMB, CONFIG_DEFAULTS.historyMaxStorageMB, CONFIG_LIMITS.historyMaxStorageMB
  );
  const editHistoryMaxStorageMB = integerSetting(
    "editHistory.maxStorageMB", process.env.TEXLITE_EDIT_HISTORY_MAX_STORAGE_MB,
    fileConfig.editHistory?.maxStorageMB, CONFIG_DEFAULTS.editHistoryMaxStorageMB, CONFIG_LIMITS.editHistoryMaxStorageMB
  );
  const maxProjectsPerUser = integerSetting(
    "projects.maxProjectsPerUser", process.env.TEXLITE_MAX_PROJECTS_PER_USER,
    fileConfig.projects?.maxProjectsPerUser, CONFIG_DEFAULTS.maxProjectsPerUser, CONFIG_LIMITS.maxProjectsPerUser
  );
  const maxSourceStorageMBPerUser = integerSetting(
    "projects.maxSourceStorageMBPerUser", process.env.TEXLITE_MAX_PROJECT_SOURCE_STORAGE_MB,
    fileConfig.projects?.maxSourceStorageMBPerUser,
    CONFIG_DEFAULTS.maxSourceStorageMBPerUser,
    CONFIG_LIMITS.maxSourceStorageMBPerUser
  );
  const gitOperationTimeoutSeconds = integerSetting(
    "git.operationTimeoutSeconds", process.env.TEXLITE_GIT_TIMEOUT,
    fileConfig.git?.operationTimeoutSeconds, CONFIG_DEFAULTS.gitOperationTimeoutSeconds, CONFIG_LIMITS.gitOperationTimeoutSeconds
  );
  const basePath = resolveBasePath(fileConfig);
  const trustedProxyIps = resolveTrustedProxyIps(fileConfig);
  const githubOAuth = resolveGithubOAuth(fileConfig);

  const config: Config = {
    configPath,
    siteName: stringSetting("siteName", process.env.TEXLITE_SITE_NAME, fileConfig.siteName, CONFIG_DEFAULTS.siteName, { min: 1, max: 120 }),
    adminEmail: stringSetting("adminEmail", process.env.TEXLITE_ADMIN_EMAIL, fileConfig.adminEmail, CONFIG_DEFAULTS.adminEmail, { min: 0, max: 320 }),
    host: stringSetting("server.host", process.env.TEXLITE_HOST, fileConfig.server?.host, CONFIG_DEFAULTS.host, { min: 1, max: 255 }),
    port: integerSetting("server.port", process.env.TEXLITE_PORT, fileConfig.server?.port, CONFIG_DEFAULTS.port, CONFIG_LIMITS.port),
    basePath,
    trustedProxyIps,
    dataDir,
    databasePath: path.join(dataDir, "texlite.db"),
    projectsDir: path.join(dataDir, "projects"),
    clientDir,
    sessionDays: integerSetting("sessionDays", process.env.TEXLITE_SESSION_DAYS, fileConfig.sessionDays, CONFIG_DEFAULTS.sessionDays, CONFIG_LIMITS.sessionDays),
    compileTimeoutMs: compileTimeoutSeconds * 1000,
    maxCompileJobs,
    latexmk: stringSetting("latex.latexmk", process.env.TEXLITE_LATEXMK, fileConfig.latex?.latexmk, CONFIG_DEFAULTS.latexmk, { min: 1, max: 256 }),
    defaultEngine,
    allowedEngines,
    extraArgs: fileConfig.latex?.extraArgs === undefined ? [] : [...fileConfig.latex.extraArgs],
    maxUploadBytes: maxFileSizeMB * 1024 * 1024,
    pdfLoadingStrategy: configuredPdfLoadingStrategy,
    pdfRangeThresholdBytes: pdfRangeThresholdMB * 1024 * 1024,
    historyMaxVersions,
    historyMaxStorageBytes: historyMaxStorageMB * 1024 * 1024,
    editHistoryMaxStorageBytes: editHistoryMaxStorageMB * 1024 * 1024,
    maxProjectsPerUser,
    maxSourceStorageBytesPerUser: maxSourceStorageMBPerUser * 1024 * 1024,
    githubOAuth,
    // Explicitly disable this legacy setting. It remains in the materialized
    // shape only for callers compiled against the pre-public-deployment API.
    allowProjectLatexmkrc: false,
    git: stringSetting("git.binary", process.env.TEXLITE_GIT, fileConfig.git?.binary, CONFIG_DEFAULTS.git, { min: 1, max: 256 }),
    gitOperationTimeoutMs: gitOperationTimeoutSeconds * 1000,
    githubApiBaseUrl: stringSetting("git.githubApiBaseUrl", process.env.TEXLITE_GITHUB_API_URL, fileConfig.git?.githubApiBaseUrl, CONFIG_DEFAULTS.githubApiBaseUrl, { min: 1, max: 2_048 }).replace(/\/+$/, "")
  };

  validateConfig(config);
  return config;
}

/**
 * Read only the configured public mount path. Vite uses this during local UI
 * development, where checking server data paths would be unnecessary and can
 * prevent the frontend from starting before the API server is configured.
 */
export function loadBasePath(configPathOverride?: string): string {
  const configPath = resolveConfigPath(configPathOverride);
  const fileConfig = readConfigFile(configPath);
  validateFileConfig(fileConfig);
  return resolveBasePath(fileConfig);
}

/** Validate an already materialized configuration (useful for startup/tests). */
export function validateConfig(config: Config): void {
  if (!config.dataDir || path.parse(config.dataDir).root === config.dataDir) {
    throw configurationError("storage.dataDir", "must be a non-root directory where TexLite can store data");
  }
  validateDirectoryTarget("storage.dataDir", config.dataDir, true);
  validateDirectoryTarget("projects directory", config.projectsDir, true);
  validateFileTarget("database path", config.databasePath);
  validateDirectoryTarget("client directory", config.clientDir, false);
  if (config.githubOAuth) {
    optionalString(config.githubOAuth.clientId, "githubOAuth.clientId", { min: 1, max: 256 });
    optionalString(config.githubOAuth.clientSecret, "githubOAuth.clientSecret", { min: 1, max: 512 });
    optionalString(config.githubOAuth.redirectUri, "githubOAuth.redirectUri", { min: 1, max: 2_048 });
    validateUrl("githubOAuth.redirectUri", config.githubOAuth.redirectUri);
    validateUrl("githubOAuth.authorizeUrl", config.githubOAuth.authorizeUrl);
    validateUrl("githubOAuth.tokenUrl", config.githubOAuth.tokenUrl);
    validateUrl("githubOAuth.apiUrl", config.githubOAuth.apiUrl);
  }
  if (!config.allowedEngines.length || new Set(config.allowedEngines).size !== config.allowedEngines.length) {
    throw configurationError("latex.allowedEngines", "must contain at least one unique engine");
  }
  for (const engine of config.allowedEngines) {
    if (!isEngine(engine)) throw configurationError("latex.allowedEngines", `contains unsupported engine ${displayValue(engine)}`);
  }
  if (!isEngine(config.defaultEngine) || !config.allowedEngines.includes(config.defaultEngine)) {
    throw configurationError("latex.defaultEngine", "must be one of the engines listed in latex.allowedEngines");
  }
  validateInteger("server.port", config.port, CONFIG_LIMITS.port);
  if (normalizeBasePath(config.basePath) !== config.basePath) {
    throw configurationError("server.basePath", "must be / or a normalized URL path such as /texlite or /tools/texlite");
  }
  validateInteger("sessionDays", config.sessionDays, CONFIG_LIMITS.sessionDays);
  validateInteger("latex.compileTimeoutSeconds", config.compileTimeoutMs / 1000, CONFIG_LIMITS.compileTimeoutSeconds);
  validateInteger("latex.maxCompileJobs", config.maxCompileJobs, CONFIG_LIMITS.maxCompileJobs);
  validateInteger("uploads.maxFileSizeMB", config.maxUploadBytes / (1024 * 1024), CONFIG_LIMITS.maxFileSizeMB);
  if (!isPdfLoadingStrategy(config.pdfLoadingStrategy)) {
    throw configurationError("pdf.loadingStrategy", `must be one of ${PDF_LOADING_STRATEGIES.join(", ")}`);
  }
  validateInteger("pdf.rangeThresholdMB", config.pdfRangeThresholdBytes / (1024 * 1024), CONFIG_LIMITS.pdfRangeThresholdMB);
  validateInteger("history.maxVersions", config.historyMaxVersions, CONFIG_LIMITS.historyMaxVersions);
  validateInteger("history.maxStorageMB", config.historyMaxStorageBytes / (1024 * 1024), CONFIG_LIMITS.historyMaxStorageMB);
  validateInteger("editHistory.maxStorageMB", config.editHistoryMaxStorageBytes / (1024 * 1024), CONFIG_LIMITS.editHistoryMaxStorageMB);
  if (config.maxProjectsPerUser !== undefined) {
    validateInteger("projects.maxProjectsPerUser", config.maxProjectsPerUser, CONFIG_LIMITS.maxProjectsPerUser);
  }
  if (config.maxSourceStorageBytesPerUser !== undefined) {
    validateInteger(
      "projects.maxSourceStorageMBPerUser",
      config.maxSourceStorageBytesPerUser / (1024 * 1024),
      CONFIG_LIMITS.maxSourceStorageMBPerUser
    );
  }
  // Legacy Git settings are validated only for old Config objects. They no
  // longer enable any application feature.
  validateUrl("git.githubApiBaseUrl", config.githubApiBaseUrl);
}

interface FileConfig {
  siteName?: string;
  adminEmail?: string;
  sessionDays?: number;
  server?: { host?: string; port?: number; basePath?: string; trustedProxyIps?: string[] };
  storage?: { dataDir?: string };
  latex?: {
    latexmk?: string;
    defaultEngine?: string;
    compileTimeoutSeconds?: number;
    maxCompileJobs?: number;
    allowedEngines?: string[];
    extraArgs?: string[];
    allowProjectLatexmkrc?: boolean;
  };
  uploads?: { maxFileSizeMB?: number };
  pdf?: { loadingStrategy?: string; rangeThresholdMB?: number };
  history?: { maxVersions?: number; maxStorageMB?: number };
  editHistory?: { maxStorageMB?: number };
  projects?: { maxProjectsPerUser?: number; maxSourceStorageMBPerUser?: number };
  githubOAuth?: {
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    authorizeUrl?: string;
    tokenUrl?: string;
    apiUrl?: string;
  };
  git?: { binary?: string; operationTimeoutSeconds?: number; githubApiBaseUrl?: string };
}

function resolveBasePath(fileConfig: FileConfig): string {
  const configuredBasePath = stringSetting(
    "server.basePath", process.env.TEXLITE_BASE_PATH, fileConfig.server?.basePath,
    CONFIG_DEFAULTS.basePath, { min: 1, max: 1_024 }
  );
  const basePath = normalizeBasePath(configuredBasePath);
  if (!basePath) {
    throw configurationError(
      "server.basePath",
      `must be / or a URL path such as /texlite or /tools/texlite; received ${displayValue(configuredBasePath)}`
    );
  }
  return basePath;
}

function resolveTrustedProxyIps(fileConfig: FileConfig): string[] {
  const configured = fileConfig.server?.trustedProxyIps;
  return configured === undefined
    ? [...CONFIG_DEFAULTS.trustedProxyIps]
    : configured.map((address) => address.trim());
}

function isEngine(value: unknown): value is LatexEngine {
  return typeof value === "string" && (LATEX_ENGINES as readonly string[]).includes(value);
}

function isPdfLoadingStrategy(value: unknown): value is PdfLoadingStrategy {
  return typeof value === "string" && (PDF_LOADING_STRATEGIES as readonly string[]).includes(value);
}

function readConfigFile(configPath: string): FileConfig {
  if (!fs.existsSync(configPath)) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!isRecord(parsed) || Array.isArray(parsed)) {
      throw configurationError("configuration file", "must contain a JSON object at the top level");
    }
    return parsed as FileConfig;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid configuration")) throw error;
    throw new Error(`Unable to read configuration file ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateFileConfig(config: FileConfig): void {
  optionalString(config.siteName, "siteName", { min: 1, max: 120 });
  optionalString(config.adminEmail, "adminEmail", { min: 0, max: 320 });
  optionalInteger(config.sessionDays, "sessionDays", CONFIG_LIMITS.sessionDays);
  const server = optionalSection(config.server, "server");
  optionalString(server?.host, "server.host", { min: 1, max: 255 });
  optionalInteger(server?.port, "server.port", CONFIG_LIMITS.port);
  optionalString(server?.basePath, "server.basePath", { min: 1, max: 1_024 });
  optionalTrustedProxyIps(server?.trustedProxyIps, "server.trustedProxyIps");
  const storage = optionalSection(config.storage, "storage");
  optionalString(storage?.dataDir, "storage.dataDir", { min: 1, max: 4_096 });
  const uploads = optionalSection(config.uploads, "uploads");
  optionalInteger(uploads?.maxFileSizeMB, "uploads.maxFileSizeMB", CONFIG_LIMITS.maxFileSizeMB);
  const pdf = optionalSection(config.pdf, "pdf");
  if (pdf && Object.prototype.hasOwnProperty.call(pdf, "loadingStrategy")
    && !isPdfLoadingStrategy(pdf.loadingStrategy)) {
    throw configurationError(
      "pdf.loadingStrategy",
      `must be one of ${PDF_LOADING_STRATEGIES.join(", ")}; received ${displayValue(pdf.loadingStrategy)}`
    );
  }
  optionalInteger(pdf?.rangeThresholdMB, "pdf.rangeThresholdMB", CONFIG_LIMITS.pdfRangeThresholdMB);
  const history = optionalSection(config.history, "history");
  optionalInteger(history?.maxVersions, "history.maxVersions", CONFIG_LIMITS.historyMaxVersions);
  optionalInteger(history?.maxStorageMB, "history.maxStorageMB", CONFIG_LIMITS.historyMaxStorageMB);
  const editHistory = optionalSection(config.editHistory, "editHistory");
  optionalInteger(editHistory?.maxStorageMB, "editHistory.maxStorageMB", CONFIG_LIMITS.editHistoryMaxStorageMB);
  const projects = optionalSection(config.projects, "projects");
  optionalInteger(projects?.maxProjectsPerUser, "projects.maxProjectsPerUser", CONFIG_LIMITS.maxProjectsPerUser);
  optionalInteger(projects?.maxSourceStorageMBPerUser, "projects.maxSourceStorageMBPerUser", CONFIG_LIMITS.maxSourceStorageMBPerUser);

  const githubOAuth = optionalSection(config.githubOAuth, "githubOAuth");
  optionalString(githubOAuth?.clientId, "githubOAuth.clientId", { min: 0, max: 256 });
  optionalString(githubOAuth?.clientSecret, "githubOAuth.clientSecret", { min: 0, max: 512 });
  optionalString(githubOAuth?.redirectUri, "githubOAuth.redirectUri", { min: 0, max: 2_048 });
  optionalString(githubOAuth?.authorizeUrl, "githubOAuth.authorizeUrl", { min: 1, max: 2_048 });
  optionalString(githubOAuth?.tokenUrl, "githubOAuth.tokenUrl", { min: 1, max: 2_048 });
  optionalString(githubOAuth?.apiUrl, "githubOAuth.apiUrl", { min: 1, max: 2_048 });
  const oauthClientId = process.env.TEXLITE_GITHUB_CLIENT_ID?.trim()
    || (typeof githubOAuth?.clientId === "string" ? githubOAuth.clientId.trim() : "") || "";
  const oauthClientSecret = process.env.TEXLITE_GITHUB_CLIENT_SECRET?.trim()
    || (typeof githubOAuth?.clientSecret === "string" ? githubOAuth.clientSecret.trim() : "") || "";
  if (Boolean(oauthClientId) !== Boolean(oauthClientSecret)) {
    throw configurationError("githubOAuth", "clientId and clientSecret must be configured together");
  }

  const latex = optionalSection(config.latex, "latex");
  optionalString(latex?.latexmk, "latex.latexmk", { min: 1, max: 256 });
  if (latex && Object.prototype.hasOwnProperty.call(latex, "defaultEngine") && !isEngine(latex.defaultEngine)) {
    throw configurationError("latex.defaultEngine", `must be one of ${LATEX_ENGINES.join(", ")}; received ${displayValue(latex.defaultEngine)}`);
  }
  optionalInteger(latex?.compileTimeoutSeconds, "latex.compileTimeoutSeconds", CONFIG_LIMITS.compileTimeoutSeconds);
  optionalInteger(latex?.maxCompileJobs, "latex.maxCompileJobs", CONFIG_LIMITS.maxCompileJobs);
  if (latex && Object.prototype.hasOwnProperty.call(latex, "allowedEngines")) {
    if (!Array.isArray(latex.allowedEngines) || latex.allowedEngines.length === 0) {
      throw configurationError("latex.allowedEngines", `must be a non-empty list containing only ${LATEX_ENGINES.join(", ")}`);
    }
    const engines = latex.allowedEngines;
    if (engines.some((engine) => !isEngine(engine))) {
      throw configurationError("latex.allowedEngines", `must contain only ${LATEX_ENGINES.join(", ")}`);
    }
    if (new Set(engines).size !== engines.length) {
      throw configurationError("latex.allowedEngines", "must not contain duplicate engines");
    }
  }
  if (latex && Object.prototype.hasOwnProperty.call(latex, "extraArgs")) {
    if (!Array.isArray(latex.extraArgs) || latex.extraArgs.some((item) => typeof item !== "string" || item.length > 512)) {
      throw configurationError("latex.extraArgs", "must be an array of strings, each no longer than 512 characters");
    }
  }
  if (latex && Object.prototype.hasOwnProperty.call(latex, "allowProjectLatexmkrc") && typeof latex.allowProjectLatexmkrc !== "boolean") {
    throw configurationError("latex.allowProjectLatexmkrc", "must be true or false");
  }

  const git = optionalSection(config.git, "git");
  optionalString(git?.binary, "git.binary", { min: 1, max: 256 });
  optionalInteger(git?.operationTimeoutSeconds, "git.operationTimeoutSeconds", CONFIG_LIMITS.gitOperationTimeoutSeconds);
  if (git && Object.prototype.hasOwnProperty.call(git, "githubApiBaseUrl")) {
    optionalString(git.githubApiBaseUrl, "git.githubApiBaseUrl", { min: 1, max: 2_048 });
    if (typeof git.githubApiBaseUrl === "string") validateUrl("git.githubApiBaseUrl", git.githubApiBaseUrl);
  }
}

function resolveGithubOAuth(fileConfig: FileConfig): GithubOAuthConfig | null {
  const section = fileConfig.githubOAuth;
  const clientId = process.env.TEXLITE_GITHUB_CLIENT_ID?.trim() || section?.clientId?.trim() || "";
  const clientSecret = process.env.TEXLITE_GITHUB_CLIENT_SECRET?.trim() || section?.clientSecret?.trim() || "";
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) {
    throw configurationError("githubOAuth", "clientId and clientSecret must be configured together");
  }
  const redirectUri = process.env.TEXLITE_GITHUB_REDIRECT_URI?.trim() || section?.redirectUri?.trim() || "";
  if (!redirectUri) throw configurationError("githubOAuth.redirectUri", "must be configured when GitHub OAuth is enabled");
  return {
    clientId,
    clientSecret,
    redirectUri,
    authorizeUrl: section?.authorizeUrl?.trim() || "https://github.com/login/oauth/authorize",
    tokenUrl: section?.tokenUrl?.trim() || "https://github.com/login/oauth/access_token",
    apiUrl: (section?.apiUrl?.trim() || "https://api.github.com").replace(/\/+$/, "")
  };
}

function optionalSection(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Array.isArray(value)) throw configurationError(name, "must be a JSON object");
  return value;
}

function optionalString(value: unknown, name: string, limits: { min: number; max: number }): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length < limits.min || value.length > limits.max || (limits.min > 0 && !value.trim())) {
    throw configurationError(name, `must be a ${limits.min === 0 ? "string" : `non-empty string`} of at most ${limits.max} characters`);
  }
}

function optionalInteger(value: unknown, name: string, limits: readonly [number, number]): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw configurationError(name, `must be an integer from ${limits[0]} to ${limits[1]}; received ${displayValue(value)}`);
  }
  validateInteger(name, value, limits);
}

function optionalTrustedProxyIps(value: unknown, name: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 32 || value.some((item) => typeof item !== "string" || !isProxyAddress(item.trim()))) {
    throw configurationError(name, "must be a list of at most 32 proxy IP addresses or CIDR ranges");
  }
  const addresses = value.map((item) => item.trim());
  if (new Set(addresses).size !== addresses.length) {
    throw configurationError(name, "must not contain duplicate proxy addresses");
  }
}

function isProxyAddress(value: string): boolean {
  if (!value || value.length > 255) return false;
  const [address, prefix, ...rest] = value.split("/");
  if (rest.length > 0 || !address) return false;
  const family = isIP(address);
  if (!family) return false;
  if (prefix === undefined) return true;
  if (!/^\d+$/.test(prefix)) return false;
  const prefixLength = Number(prefix);
  return prefixLength <= (family === 4 ? 32 : 128);
}

function integerSetting(
  name: string, envValue: string | undefined, fileValue: number | undefined,
  fallback: number, limits: readonly [number, number]
): number {
  if (envValue !== undefined) {
    if (!/^\d+$/.test(envValue)) {
      throw configurationError(name, `must be an integer from ${limits[0]} to ${limits[1]}; received ${displayValue(envValue)}`);
    }
    const value = Number(envValue);
    validateInteger(name, value, limits);
    return value;
  }
  if (fileValue === undefined) return fallback;
  validateInteger(name, fileValue, limits);
  return fileValue;
}

function stringSetting(
  name: string, envValue: string | undefined, fileValue: string | undefined,
  fallback: string, limits: { min: number; max: number }
): string {
  const value = envValue ?? fileValue ?? fallback;
  optionalString(value, name, limits);
  return value;
}

function setting<T>(name: string, envValue: T | undefined, fileValue: T | undefined, fallback: T): T {
  if (envValue !== undefined) {
    if (typeof envValue === "string" && !envValue.trim()) throw configurationError(name, "must not be empty");
    return envValue;
  }
  return fileValue ?? fallback;
}

function resolveConfiguredPath(name: string, value: string, baseDirectory: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw configurationError(name, "must be a non-empty path without NUL characters");
  }
  try {
    return path.resolve(baseDirectory, value);
  } catch (error) {
    throw configurationError(name, `is not a valid path: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateDirectoryTarget(name: string, target: string, checkWritableParent: boolean): void {
  if (fs.existsSync(target)) {
    let stat: fs.Stats;
    try { stat = fs.statSync(target); } catch (error) {
      throw configurationError(name, `cannot be inspected: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!stat.isDirectory()) throw configurationError(name, `points to a file, not a directory: ${target}`);
    if (checkWritableParent) {
      try { fs.accessSync(target, fs.constants.W_OK); }
      catch { throw configurationError(name, `is not writable: ${target}`); }
    }
    return;
  }
  const parent = nearestExistingParent(target);
  if (!parent) throw configurationError(name, `has no existing parent directory; create one before starting: ${target}`);
  if (checkWritableParent) {
    try { fs.accessSync(parent, fs.constants.W_OK); }
    catch { throw configurationError(name, `cannot be created because its parent is not writable: ${parent}`); }
  }
}

function validateFileTarget(name: string, target: string): void {
  if (!fs.existsSync(target)) return;
  try {
    if (fs.statSync(target).isDirectory()) throw configurationError(name, `points to a directory, but must be a file: ${target}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid configuration")) throw error;
    throw configurationError(name, `cannot be inspected: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function nearestExistingParent(target: string): string | null {
  let current = path.dirname(target);
  while (current !== path.dirname(current)) {
    if (fs.existsSync(current)) return current;
    current = path.dirname(current);
  }
  return fs.existsSync(current) ? current : null;
}

function validateUrl(name: string, value: string): void {
  try {
    const parsed = new URL(value);
    if (!(["http:", "https:"] as string[]).includes(parsed.protocol)) throw new Error("only http:// and https:// are supported");
  } catch (error) {
    throw configurationError(name, `must be a valid http(s) URL: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateInteger(name: string, value: number, limits: readonly [number, number]): void {
  if (!Number.isInteger(value) || value < limits[0] || value > limits[1]) {
    throw configurationError(name, `must be an integer from ${limits[0]} to ${limits[1]}; received ${displayValue(value)}`);
  }
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return `“${value}”`;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function configurationError(name: string, detail: string): Error {
  return new Error(`Invalid configuration (${name}): ${detail}. Update texlite.config.json or the corresponding TEXLITE_* environment variable and try again.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
