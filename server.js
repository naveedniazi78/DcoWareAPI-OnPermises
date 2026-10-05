// DocuWare Dashboard server
// Optional: install dotenv (npm install dotenv) to load DOCUWARE_CLIENT_SECRET from .env.
try { require("dotenv").config(); } catch (_) {}

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const multer = require("multer");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.VERCEL
  ? path.join(os.tmpdir(), "docuware-dashboard")
  : path.join(__dirname, "data");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

// In-memory storage: uploaded/scanned files never touch disk on this server,
// they are streamed straight through to DocuWare.
const scanUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 75 * 1024 * 1024, files: 20 }
});

const DEFAULT_CONFIG = {
  serverUrl: "https://elajou.docuware.cloud/DocuWare",
  organization: "El-Ajou Group",
  organizationId: "",
  cabinetId: "e4c1a469-4219-4cc9-a820-a70e89f2d319",
  applicationId: "0114e0ec-75b9-ebca-b3ba-0b82ce60245d",
  clientSecret: process.env.DOCUWARE_CLIENT_SECRET || "",
  redirectUrl: process.env.DOCUWARE_REDIRECT_URL || "https://naveedapi.vercel.app/oauth/callback",
  authorizationUrl: "https://login-emea.docuware.cloud/92ab99d1-19f3-4a25-a582-0ce5fbb2298f/connect/authorize",
  tokenUrl: "https://login-emea.docuware.cloud/92ab99d1-19f3-4a25-a582-0ce5fbb2298f/connect/token",
  scope: "openid profile offline_access docuware.platform",
  apiBasePath: "/Platform"
};

function loadConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const merged = { ...DEFAULT_CONFIG, ...saved };
    if (process.env.DOCUWARE_CLIENT_SECRET) merged.clientSecret = process.env.DOCUWARE_CLIENT_SECRET;
    if (process.env.DOCUWARE_REDIRECT_URL) merged.redirectUrl = process.env.DOCUWARE_REDIRECT_URL;
    return merged;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(currentConfig) {
  const copy = { ...currentConfig };
  // Never save the environment-provided secret to disk.
  if (process.env.DOCUWARE_CLIENT_SECRET) delete copy.clientSecret;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(copy, null, 2), "utf8");
}

let config = loadConfig();
let tokenStore = { accessToken: "", refreshToken: "", expiresAt: 0 };

// ---------------------------------------------------------------------
// Dashboard login — a styled login page + session cookie, plus an admin
// page to manage users (multiple username/password accounts). Credentials
// are hashed and kept in data/users.json so they can be changed without
// touching code.
// ---------------------------------------------------------------------
const AUTH_FILE = path.join(DATA_DIR, "auth.json");   // legacy single-user file (migrated on first run)
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SESSION_COOKIE = "dw_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const sessions = new Map(); // sessionId -> { userId, username, expires }

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString("hex");
}

function makeAuthFields(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: hashPassword(password, salt) };
}

function makeUserRecord(username, password) {
  return { id: crypto.randomUUID(), username, ...makeAuthFields(password), createdAt: new Date().toISOString() };
}

function saveUsers(list) {
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users: list }, null, 2), "utf8");
}

function loadUsers() {
  try {
    const data = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    if (Array.isArray(data.users) && data.users.length) return data.users;
  } catch {}

  // Migrate from the older single-user data/auth.json, if present.
  try {
    const old = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    if (old && old.username && old.salt && old.hash) {
      const migrated = [{ id: crypto.randomUUID(), username: old.username, salt: old.salt, hash: old.hash, createdAt: new Date().toISOString() }];
      saveUsers(migrated);
      return migrated;
    }
  } catch {}

  const seeded = [makeUserRecord(process.env.DASHBOARD_USERNAME || "niazi", process.env.DASHBOARD_PASSWORD || "123")];
  saveUsers(seeded);
  return seeded;
}

let users = loadUsers();

function findUserByUsername(name) {
  const key = String(name || "").trim().toLowerCase();
  return users.find(u => u.username.toLowerCase() === key);
}
function findUserById(id) {
  return users.find(u => u.id === id);
}

function verifyPassword(password, record) {
  const candidate = Buffer.from(hashPassword(password, record.salt), "hex");
  const actual = Buffer.from(record.hash, "hex");
  return candidate.length === actual.length && crypto.timingSafeEqual(candidate, actual);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(";").forEach(part => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function createSession(userId, username) {
  const id = crypto.randomBytes(24).toString("hex");
  sessions.set(id, { userId, username, expires: Date.now() + SESSION_TTL_MS });
  return id;
}

function getSession(id) {
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(id); return null; }
  return s;
}

function setSessionCookie(res, id) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${id}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

const PUBLIC_PATHS = new Set(["/login", "/login.html", "/api/auth/login"]);

function requireDashboardLogin(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();

  const cookies = parseCookies(req);
  const session = cookies[SESSION_COOKIE] ? getSession(cookies[SESSION_COOKIE]) : null;
  if (session) { req.session = session; return next(); }

  const wantsJson = req.path.startsWith("/api/") || (req.headers.accept || "").includes("application/json");
  if (wantsJson) return res.status(401).json({ ok: false, error: "Not authenticated. Please log in." });
  const dest = encodeURIComponent(req.originalUrl || "/");
  return res.redirect(`/login?redirect=${dest}`);
}

app.use(requireDashboardLogin);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, error: "Username and password are required." });
  const user = findUserByUsername(username);
  if (!user || !verifyPassword(password, user)) {
    return res.status(401).json({ ok: false, error: "Invalid username or password." });
  }
  const id = createSession(user.id, user.username);
  setSessionCookie(res, id);
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  const cookies = parseCookies(req);
  if (cookies[SESSION_COOKIE]) sessions.delete(cookies[SESSION_COOKIE]);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/whoami", (req, res) => {
  res.json({ ok: true, username: req.session?.username || "", userId: req.session?.userId || "" });
});

// Change the CURRENTLY LOGGED-IN user's own username/password.
app.post("/api/auth/change-credentials", (req, res) => {
  const { currentPassword, newUsername, newPassword } = req.body || {};
  const user = findUserById(req.session?.userId);
  if (!user) return res.status(401).json({ ok: false, error: "Session expired. Please log in again." });
  if (!currentPassword) return res.status(400).json({ ok: false, error: "Enter your current password." });
  if (!verifyPassword(currentPassword, user)) return res.status(401).json({ ok: false, error: "Current password is incorrect." });

  const desiredUsername = String(newUsername || "").trim();
  if (desiredUsername && desiredUsername.toLowerCase() !== user.username.toLowerCase() && findUserByUsername(desiredUsername)) {
    return res.status(409).json({ ok: false, error: "That username is already taken." });
  }
  if (newPassword && String(newPassword).length < 4) {
    return res.status(400).json({ ok: false, error: "New password must be at least 4 characters." });
  }

  if (desiredUsername) user.username = desiredUsername;
  if (newPassword) Object.assign(user, makeAuthFields(String(newPassword)));
  saveUsers(users);
  req.session.username = user.username; // keep in-memory session label in sync
  res.json({ ok: true, username: user.username });
});

// List all dashboard users (username + created date only — never hashes).
app.get("/api/auth/users", (req, res) => {
  res.json({
    ok: true,
    selfId: req.session?.userId || "",
    users: users.map(u => ({ id: u.id, username: u.username, createdAt: u.createdAt }))
  });
});

// Create a brand-new user/password. Requires the acting (logged-in) user's
// own current password, so an unattended session can't silently add one.
app.post("/api/auth/users", (req, res) => {
  const { currentPassword, username, password } = req.body || {};
  const actingUser = findUserById(req.session?.userId);
  if (!actingUser) return res.status(401).json({ ok: false, error: "Session expired. Please log in again." });
  if (!currentPassword || !verifyPassword(currentPassword, actingUser)) {
    return res.status(401).json({ ok: false, error: "Your current password is incorrect." });
  }

  const uname = String(username || "").trim();
  if (!uname) return res.status(400).json({ ok: false, error: "Enter a username for the new user." });
  if (findUserByUsername(uname)) return res.status(409).json({ ok: false, error: "That username already exists." });
  if (!password || String(password).length < 4) return res.status(400).json({ ok: false, error: "Password must be at least 4 characters." });

  const rec = makeUserRecord(uname, String(password));
  users.push(rec);
  saveUsers(users);
  res.json({ ok: true, user: { id: rec.id, username: rec.username, createdAt: rec.createdAt } });
});

// Remove a user. Always keeps at least one account so nobody can lock
// everyone out of the dashboard.
app.delete("/api/auth/users/:id", (req, res) => {
  const actingUser = findUserById(req.session?.userId);
  if (!actingUser) return res.status(401).json({ ok: false, error: "Session expired. Please log in again." });
  if (users.length <= 1) return res.status(400).json({ ok: false, error: "You can't remove the last remaining user." });

  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: "User not found." });

  const removedSelf = users[idx].id === req.session.userId;
  users.splice(idx, 1);
  saveUsers(users);

  if (removedSelf) {
    for (const [sid, s] of sessions) if (s.userId === req.session.userId) sessions.delete(sid);
  }
  res.json({ ok: true, removedSelf });
});

function cleanBaseUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

function apiUrl(pathname) {
  return `${cleanBaseUrl(config.serverUrl)}${config.apiBasePath}${pathname}`;
}

function publicConfig() {
  const copy = { ...config };
  delete copy.clientSecret;
  return { ...copy, hasClientSecret: Boolean(config.clientSecret) };
}

function safeError(error) {
  if (error && error.name === "TypeError") return error.message;
  return error?.message || String(error);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    redirect: "manual",
    ...options,
    headers: {
      Accept: "application/json",
      "User-Agent": "ElAjou-DocuWare-Dashboard/1.0",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }

  if (!response.ok) {
    const err = new Error(`HTTP ${response.status} ${response.statusText}`);
    err.status = response.status;
    err.body = body;
    throw err;
  }

  return { status: response.status, body, headers: response.headers };
}

function bearerHeaders() {
  return tokenStore.accessToken
    ? { Authorization: `Bearer ${tokenStore.accessToken}` }
    : {};
}

function normalizeCabinets(payload) {
  const source = Array.isArray(payload)
    ? payload
    : payload?.FileCabinet
      ? (Array.isArray(payload.FileCabinet) ? payload.FileCabinet : [payload.FileCabinet])
      : payload?.FileCabinets
        ? (Array.isArray(payload.FileCabinets) ? payload.FileCabinets : [payload.FileCabinets])
        : payload?.Items
          ? (Array.isArray(payload.Items) ? payload.Items : [payload.Items])
          : [];

  return source.map(item => {
    const id = item?.Id || item?.id || item?.Guid || item?.guid || item?.FileCabinetId || item?.fileCabinetId || "";
    const name = item?.Name || item?.name || item?.DisplayName || item?.displayName || item?.FileCabinetName || item?.fileCabinetName || id;
    return { id: String(id), name: String(name) };
  }).filter(x => x.id);
}

function documentArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.Items)) return payload.Items;
  if (Array.isArray(payload?.Documents)) return payload.Documents;
  if (Array.isArray(payload?.Document)) return payload.Document;
  if (Array.isArray(payload?.documents)) return payload.documents;
  if (payload?.Document) return [payload.Document];
  return [];
}

function isFieldObject(value) {
  return value && typeof value === "object" && (
    Object.prototype.hasOwnProperty.call(value, "FieldName") ||
    Object.prototype.hasOwnProperty.call(value, "FieldLabel")
  );
}

function fieldList(value) {
  if (Array.isArray(value)) return value.filter(isFieldObject);
  if (isFieldObject(value)) return [value];
  if (Array.isArray(value?.Field)) return value.Field.filter(isFieldObject);
  if (Array.isArray(value?.Fields)) return value.Fields.filter(isFieldObject);
  if (Array.isArray(value?.Items)) return value.Items.filter(isFieldObject);
  return [];
}

function addField(row, field) {
  const key = String(field?.FieldName || field?.FieldLabel || "").trim();
  if (!key) return;
  const label = String(field?.FieldLabel || key).trim();
  const value = field?.Item;

  // Keep a stable technical key for reliable UI mapping.
  row[key] = value === undefined || value === null ? "" : value;
  if (label && !Object.prototype.hasOwnProperty.call(row, label)) row[label] = row[key];
}

function normalizeDocument(doc, index) {
  let row = {};
  let metadata = {};
  let fields = [];

  // Some DocuWare responses return each document as [fields[], metadata{}].
  if (Array.isArray(doc)) {
    const fieldPart = doc.find(part => Array.isArray(part) && part.some(isFieldObject));
    fields = fieldList(fieldPart);
    metadata = doc.find(part => part && typeof part === "object" && !Array.isArray(part)) || {};
  } else if (doc && typeof doc === "object") {
    metadata = doc;
    fields = fieldList(doc.Fields) || [];
    if (!fields.length) fields = fieldList(doc.Field);
    if (!fields.length && Array.isArray(doc.Items) && doc.Items.some(isFieldObject)) fields = fieldList(doc.Items);
  }

  fields.forEach(field => addField(row, field));

  // Copy useful metadata properties without copying huge nested objects.
  const metaKeys = [
    "Id", "id", "DocumentId", "documentId", "DWDOCID",
    "Title", "Name", "FileName", "ContentType", "Extension",
    "DWEXTENSION", "SectionCount", "DWPAGECOUNT", "DWDOCSIZE",
    "StoredBy", "ModifiedBy", "StoredOn", "ModifiedOn"
  ];
  for (const key of metaKeys) {
    if (metadata[key] !== undefined && metadata[key] !== null && typeof metadata[key] !== "object") {
      if (row[key] === undefined) row[key] = metadata[key];
    }
  }

  // If the object itself contains simple document properties, retain them too.
  if (!fields.length && !Array.isArray(doc)) {
    for (const [key, value] of Object.entries(doc)) {
      if (value === null || value === undefined) continue;
      if (typeof value !== "object") row[key] = value;
    }
  }

  if (row.DWDOCID === undefined) {
    row.DWDOCID = row.DocumentId ?? row.documentId ?? row.Id ?? row.id ?? "";
  }
  row.__rowNumber = index + 1;
  return row;
}

function normalizeDocuments(payload) {
  return documentArray(payload).map(normalizeDocument).filter(row => {
    return Object.keys(row).some(key => key !== "__rowNumber");
  });
}

// ---------------------------------------------------------------------
// Store-dialog / index-field helpers (used by the "Scan / Upload" page)
// ---------------------------------------------------------------------

function normalizeDialogs(payload) {
  const source = Array.isArray(payload)
    ? payload
    : payload?.Dialog
      ? (Array.isArray(payload.Dialog) ? payload.Dialog : [payload.Dialog])
      : payload?.Dialogs
        ? (Array.isArray(payload.Dialogs) ? payload.Dialogs : [payload.Dialogs])
        : payload?.Items
          ? (Array.isArray(payload.Items) ? payload.Items : [payload.Items])
          : [];

  return source.map(item => ({
    id: String(item?.Id || item?.id || ""),
    name: String(item?.DisplayName || item?.displayName || item?.Name || item?.name || item?.Id || ""),
    type: String(item?.Type || item?.DialogType || item?.type || "")
  })).filter(x => x.id);
}

// DocuWare field-type identifiers vary a little by server version. Map the
// common ones down to the ItemElementName the Fields PUT endpoint expects.
const FIELD_TYPE_MAP = {
  string: "String", text: "String", alphanumeric: "String",
  memo: "Memo", multiline: "Memo",
  numeric: "Int", int: "Int", integer: "Int",
  decimal: "Decimal", number: "Decimal", float: "Decimal",
  date: "Date",
  datetime: "DateTime", timestamp: "DateTime",
  keywords: "Keywords", keyword: "Keywords",
  table: "Table"
};

function mapFieldType(rawType) {
  const key = String(rawType || "").trim().toLowerCase();
  return FIELD_TYPE_MAP[key] || "String";
}

function isDialogFieldObject(value) {
  return value && typeof value === "object" && (
    Object.prototype.hasOwnProperty.call(value, "DBFieldName") ||
    Object.prototype.hasOwnProperty.call(value, "FieldName")
  );
}

// Walk the dialog response (shape differs across DocuWare versions -
// sometimes Fields is top-level, sometimes nested under Sections[]) and
// collect every field definition it can find, a few levels deep.
function collectDialogFields(node, depth, out) {
  if (!node || depth > 5) return;
  if (Array.isArray(node)) {
    node.forEach(item => collectDialogFields(item, depth + 1, out));
    return;
  }
  if (typeof node !== "object") return;
  if (isDialogFieldObject(node)) {
    out.push(node);
    return;
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") collectDialogFields(value, depth + 1, out);
  }
}

function normalizeDialogFields(payload) {
  const found = [];
  collectDialogFields(payload, 0, found);

  const seen = new Set();
  return found.map(field => {
    const name = String(field?.DBFieldName || field?.FieldName || "").trim();
    const label = String(field?.Label || field?.DisplayName || name).trim();
    const rawType = field?.DWFieldType || field?.FieldType || field?.ItemElementType || field?.Type || "";
    const required = Boolean(
      field?.Necessity === true || field?.Necessity === "True" ||
      field?.Required === true || field?.IsRequired === true
    );
    return {
      name,
      label: label || name,
      type: mapFieldType(rawType),
      required,
      length: Number(field?.Length || field?.MaxLength || 0) || null
    };
  }).filter(f => f.name && !seen.has(f.name) && seen.add(f.name));
}

app.get("/api/config", (req, res) => res.json(publicConfig()));

app.put("/api/config", (req, res) => {
  const incoming = req.body || {};
  const allowed = [
    "serverUrl", "organization", "organizationId", "cabinetId",
    "applicationId", "clientSecret", "redirectUrl",
    "authorizationUrl", "tokenUrl", "scope", "apiBasePath"
  ];

  const next = { ...config };
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) {
      if (key === "clientSecret" && incoming[key] === "") continue;
      next[key] = String(incoming[key] ?? "");
    }
  }

  next.serverUrl = cleanBaseUrl(next.serverUrl);
  next.apiBasePath = "/" + String(next.apiBasePath || "/Platform").replace(/^\/+/, "").replace(/\/+$/, "");

  config = next;
  saveConfig(config);
  res.json({ ok: true, config: publicConfig() });
});

app.get("/api/status", async (req, res) => {
  const result = {
    ok: false,
    authenticated: Boolean(tokenStore.accessToken),
    tokenExpiresAt: tokenStore.expiresAt || null,
    cabinetId: config.cabinetId || null,
    checks: []
  };

  try {
    const started = Date.now();
    const r = await fetchJson(apiUrl(""), { headers: bearerHeaders() });
    result.checks.push({ name: "DocuWare Platform", ok: true, status: r.status, ms: Date.now() - started, data: r.body });
    result.ok = true;
  } catch (e) {
    result.checks.push({ name: "DocuWare Platform", ok: false, status: e.status || null, error: safeError(e), details: e.body || null });
  }

  if (tokenStore.accessToken) {
    if (!config.cabinetId) {
      result.checks.push({ name: "File Cabinet", ok: false, error: "No File Cabinet selected." });
    } else {
      try {
        const started = Date.now();
        const r = await fetchJson(apiUrl(`/FileCabinets/${encodeURIComponent(config.cabinetId)}`), { headers: bearerHeaders() });
        result.checks.push({ name: "File Cabinet", ok: true, status: r.status, ms: Date.now() - started, data: r.body });
      } catch (e) {
        result.checks.push({ name: "File Cabinet", ok: false, status: e.status || null, error: safeError(e), details: e.body || null });
      }
    }
  } else {
    result.checks.push({ name: "File Cabinet", ok: false, error: "Not authenticated. Click Connect to DocuWare first." });
  }

  res.json(result);
});

app.get("/oauth/start", (req, res) => {
  if (!config.authorizationUrl || !config.applicationId || !config.redirectUrl) {
    return res.status(400).send("Authorization URL, Application ID and Redirect URL must be configured first.");
  }

  const state = crypto.randomBytes(24).toString("hex");
  const params = new URLSearchParams({
    client_id: config.applicationId,
    redirect_uri: config.redirectUrl,
    response_type: "code",
    scope: config.scope || "openid offline_access",
    state
  });

  app.locals.oauthState = { value: state, expiresAt: Date.now() + 10 * 60 * 1000 };
  res.redirect(`${config.authorizationUrl}${config.authorizationUrl.includes("?") ? "&" : "?"}${params.toString()}`);
});

app.get("/oauth/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) return res.send(`<h2>DocuWare authorization failed</h2><pre>${escapeHtml(error_description || error)}</pre>`);

  const expected = app.locals.oauthState;
  if (!expected || expected.value !== state || expected.expiresAt < Date.now()) {
    return res.status(400).send("Invalid or expired OAuth state.");
  }
  delete app.locals.oauthState;

  if (!code) return res.status(400).send("Authorization code was not returned.");
  if (!config.tokenUrl || !config.clientSecret) {
    return res.status(400).send("Token URL and Client Secret must be configured on the server.");
  }

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: config.redirectUrl,
      client_id: config.applicationId,
      client_secret: config.clientSecret
    });

    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "ElAjou-DocuWare-Dashboard/1.0"
      },
      body
    });

    const text = await response.text();
    let token;
    try { token = JSON.parse(text); } catch { token = {}; }

    if (!response.ok) {
      return res.status(response.status).send(`<h2>Token exchange failed</h2><pre>${escapeHtml(text)}</pre>`);
    }

    tokenStore.accessToken = token.access_token || "";
    tokenStore.refreshToken = token.refresh_token || "";
    tokenStore.expiresAt = Date.now() + Number(token.expires_in || 3600) * 1000;

    res.send(`<!doctype html><html><body style="font-family:system-ui;padding:40px"><h2>Connected to DocuWare</h2><p>You can close this window and return to the dashboard.</p><script>setTimeout(()=>window.close(),800);</script></body></html>`);
  } catch (e) {
    res.status(500).send(`<h2>OAuth error</h2><pre>${escapeHtml(safeError(e))}</pre>`);
  }
});

app.post("/api/logout", (req, res) => {
  tokenStore = { accessToken: "", refreshToken: "", expiresAt: 0 };
  res.json({ ok: true });
});

app.get("/api/cabinets", async (req, res) => {
  if (!tokenStore.accessToken) return res.status(401).json({ ok: false, error: "Not authenticated. Connect to DocuWare first." });
  try {
    const query = config.organizationId ? `?orgid=${encodeURIComponent(config.organizationId)}` : "";
    const r = await fetchJson(apiUrl(`/FileCabinets${query}`), { headers: bearerHeaders() });
    const cabinets = normalizeCabinets(r.body);
    res.json({ ok: true, data: r.body, cabinets, selectedCabinetId: config.cabinetId || "" });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: safeError(e), details: e.body || null });
  }
});

// Store dialogs available for a cabinet (used to know which index fields
// to ask for on the "Scan / Upload" page).
app.get("/api/dialogs", async (req, res) => {
  if (!tokenStore.accessToken) return res.status(401).json({ ok: false, error: "Not authenticated. Connect to DocuWare first." });
  const cabinetId = String(req.query.cabinetId || config.cabinetId || "").trim();
  if (!cabinetId) return res.status(400).json({ ok: false, error: "No File Cabinet selected." });

  try {
    const r = await fetchJson(apiUrl(`/FileCabinets/${encodeURIComponent(cabinetId)}/Dialogs`), { headers: bearerHeaders() });
    const all = normalizeDialogs(r.body);
    const storeDialogs = all.filter(d => /store/i.test(d.type));
    res.json({ ok: true, dialogs: storeDialogs.length ? storeDialogs : all, data: r.body });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: safeError(e), details: e.body || null });
  }
});

// Index-field definitions for one store dialog, used to build the manual
// indexing form dynamically.
app.get("/api/dialogs/:dialogId/fields", async (req, res) => {
  if (!tokenStore.accessToken) return res.status(401).json({ ok: false, error: "Not authenticated. Connect to DocuWare first." });
  const cabinetId = String(req.query.cabinetId || config.cabinetId || "").trim();
  const dialogId = String(req.params.dialogId || "").trim();
  if (!cabinetId) return res.status(400).json({ ok: false, error: "No File Cabinet selected." });
  if (!dialogId) return res.status(400).json({ ok: false, error: "No dialog selected." });

  try {
    const r = await fetchJson(
      apiUrl(`/FileCabinets/${encodeURIComponent(cabinetId)}/Dialogs/${encodeURIComponent(dialogId)}`),
      { headers: bearerHeaders() }
    );
    const fields = normalizeDialogFields(r.body);
    res.json({ ok: true, fields, data: r.body });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: safeError(e), details: e.body || null });
  }
});

// Store one or more scanned/uploaded files into a File Cabinet, then write
// the manually-entered index values onto each new document.
//
// Flow per DocuWare's Platform API:
//   1) POST the raw file bytes to /FileCabinets/{id}/Documents
//      (Content-Type: the file's mime type) -> returns the new Document,
//      including its Id.
//   2) PUT the index values to
//      /FileCabinets/{id}/Documents/{docId}/Fields
//      as { "Field": [ { "FieldName", "Item", "ItemElementName" }, ... ] }
app.post("/api/documents/store", scanUpload.array("files", 20), async (req, res) => {
  if (!tokenStore.accessToken) return res.status(401).json({ ok: false, error: "Not authenticated. Connect to DocuWare first." });

  const cabinetId = String(req.body.cabinetId || config.cabinetId || "").trim();
  if (!cabinetId) return res.status(400).json({ ok: false, error: "No File Cabinet selected." });

  const files = req.files || [];
  if (!files.length) return res.status(400).json({ ok: false, error: "No file was provided. Scan a page or choose a local file first." });

  let fieldValues = [];
  try {
    fieldValues = JSON.parse(req.body.fields || "[]");
  } catch {
    return res.status(400).json({ ok: false, error: "Index field values were not valid JSON." });
  }

  const fieldPayload = fieldValues
    .filter(f => f && f.name)
    .map(f => ({
      FieldName: f.name,
      Item: f.value === undefined ? "" : f.value,
      ItemElementName: mapFieldType(f.type)
    }));

  const results = [];

  for (const file of files) {
    try {
      const created = await fetchJson(apiUrl(`/FileCabinets/${encodeURIComponent(cabinetId)}/Documents`), {
        method: "POST",
        headers: {
          "Content-Type": file.mimetype || "application/octet-stream",
          ...bearerHeaders()
        },
        body: file.buffer
      });

      const documentId = String(
        created.body?.Id || created.body?.id || created.body?.DocumentId || created.body?.documentId || ""
      );

      if (!documentId) {
        results.push({ fileName: file.originalname, ok: false, error: "Document was stored, but DocuWare did not return a document ID." });
        continue;
      }

      if (fieldPayload.length) {
        await fetchJson(
          apiUrl(`/FileCabinets/${encodeURIComponent(cabinetId)}/Documents/${encodeURIComponent(documentId)}/Fields`),
          {
            method: "PUT",
            headers: { "Content-Type": "application/json", ...bearerHeaders() },
            body: JSON.stringify({ Field: fieldPayload })
          }
        );
      }

      results.push({ fileName: file.originalname, ok: true, documentId });
    } catch (e) {
      results.push({ fileName: file.originalname, ok: false, error: safeError(e), details: e.body || null });
    }
  }

  const allOk = results.every(r => r.ok);
  res.status(allOk ? 200 : 207).json({ ok: allOk, cabinetId, results });
});

app.get("/api/documents", async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 2000);
  const cabinetId = String(req.query.cabinetId || config.cabinetId || "").trim();

  if (!tokenStore.accessToken) return res.status(401).json({ ok: false, error: "Not authenticated. Connect to DocuWare first." });
  if (!cabinetId) return res.status(400).json({ ok: false, error: "No File Cabinet selected." });

  try {
    const r = await fetchJson(
      apiUrl(`/FileCabinets/${encodeURIComponent(cabinetId)}/Documents?start=0&count=${limit}`),
      { headers: bearerHeaders() }
    );

    const documents = normalizeDocuments(r.body);
    res.json({
      ok: true,
      cabinetId,
      count: documents.length,
      documents,
      data: r.body
    });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: safeError(e), details: e.body || null });
  }
});

app.get("/api/document/:id", async (req, res) => {
  const cabinetId = String(req.query.cabinetId || config.cabinetId || "").trim();
  if (!tokenStore.accessToken) return res.status(401).json({ ok: false, error: "Not authenticated. Connect to DocuWare first." });
  if (!cabinetId) return res.status(400).json({ ok: false, error: "No File Cabinet selected." });

  try {
    const r = await fetchJson(
      apiUrl(`/FileCabinets/${encodeURIComponent(cabinetId)}/Documents/${encodeURIComponent(req.params.id)}`),
      { headers: bearerHeaders() }
    );
    res.json({ ok: true, data: r.body, document: normalizeDocument(r.body, 0) });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: safeError(e), details: e.body || null });
  }
});

app.get("/api/document/:id/preview", async (req, res) => {
  const cabinetId = String(req.query.cabinetId || config.cabinetId || "").trim();
  const documentId = String(req.params.id || "").trim();

  if (!tokenStore.accessToken) {
    return res.status(401).send("Not authenticated. Connect to DocuWare first.");
  }
  if (!cabinetId) return res.status(400).send("No File Cabinet selected.");
  if (!documentId) return res.status(400).send("No document ID supplied.");

  try {
    const headers = {
      Accept: "application/json, application/pdf, application/octet-stream, */*",
      "User-Agent": "ElAjou-DocuWare-Dashboard/1.0",
      ...bearerHeaders()
    };

    // First retrieve the document metadata. DocuWare can provide the
    // document's fileDownload relation link here, which is safer than
    // assuming the download URL for every document type.
    const documentUrl = apiUrl(
      `/FileCabinets/${encodeURIComponent(cabinetId)}/Documents/${encodeURIComponent(documentId)}`
    );
    const documentResponse = await fetch(documentUrl, { headers });

    if (!documentResponse.ok) {
      const text = await documentResponse.text();
      return res.status(documentResponse.status).send(
        text || `Unable to read document ${documentId}. HTTP ${documentResponse.status}`
      );
    }

    let documentData = null;
    try {
      documentData = await documentResponse.json();
    } catch (_) {}

    const relation =
      documentData?.Links?.find?.(x => String(x?.rel || x?.Rel || "").toLowerCase() === "filedownload")?.href ||
      documentData?.Links?.find?.(x => String(x?.rel || x?.Rel || "").toLowerCase().includes("filedownload"))?.href ||
      documentData?.FileDownloadRelationLink ||
      documentData?.fileDownloadRelationLink ||
      documentData?.Links?.FileDownload ||
      documentData?.Links?.fileDownload ||
      "";

    const directPath =
      `/FileCabinets/${encodeURIComponent(cabinetId)}/Documents/${encodeURIComponent(documentId)}/FileDownload` +
      `?targetFileType=PDF&keepAnnotations=true&downloadFile=false`;

    let downloadUrl = relation;
    if (downloadUrl && !/^https?:\/\//i.test(downloadUrl)) {
      // Relation links are sometimes relative to the Platform API.
      downloadUrl = apiUrl(downloadUrl.startsWith("/") ? downloadUrl : `/${downloadUrl}`);
    }
    if (!downloadUrl) downloadUrl = apiUrl(directPath);

    let response = await fetch(downloadUrl, {
      method: "GET",
      headers: {
        Accept: "application/pdf, application/octet-stream, */*",
        "User-Agent": "ElAjou-DocuWare-Dashboard/1.0",
        ...bearerHeaders()
      },
      redirect: "follow"
    });

    // If the relation does not accept the PDF query parameters, retry the
    // documented direct FileDownload endpoint with PDF conversion.
    if (!response.ok && downloadUrl !== apiUrl(directPath)) {
      response = await fetch(apiUrl(directPath), {
        method: "GET",
        headers: {
          Accept: "application/pdf, application/octet-stream, */*",
          "User-Agent": "ElAjou-DocuWare-Dashboard/1.0",
          ...bearerHeaders()
        },
        redirect: "follow"
      });
    }

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).send(
        `DocuWare preview failed for document ${documentId}. HTTP ${response.status}\n\n${text || "No response body."}`
      );
    }

    const contentType = response.headers.get("content-type") || "application/pdf";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `inline; filename="DocuWare-${documentId}.pdf"`);
    res.setHeader("Cache-Control", "no-store");

    const contentLength = response.headers.get("content-length");
    if (contentLength) res.setHeader("Content-Length", contentLength);

    if (response.body) {
      const { Readable } = require("stream");
      Readable.fromWeb(response.body).pipe(res);
    } else {
      res.end(Buffer.from(await response.arrayBuffer()));
    }
  } catch (e) {
    console.error("Document preview error:", e);
    res.status(500).send(`Preview error for document ${documentId}: ${safeError(e)}`);
  }
});

app.get("/api/raw", async (req, res) => {
  const rawPath = String(req.query.path || "");
  if (!rawPath.startsWith("/")) return res.status(400).json({ ok: false, error: "Path must start with /." });
  try {
    const r = await fetchJson(apiUrl(rawPath), { headers: bearerHeaders() });
    res.json({ ok: true, data: r.body });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: safeError(e), details: e.body || null });
  }
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
  }[c]));
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`DocuWare Dashboard: http://localhost:${PORT}`);
  });
}

module.exports = app;
