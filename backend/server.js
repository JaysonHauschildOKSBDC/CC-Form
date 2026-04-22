import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3001);

const TOKEN_URL = "https://authz.constantcontact.com/oauth2/default/v1/token";
const SIGNUP_URL = "https://api.cc.email/v3/contacts/sign_up_form";
const CONTACT_LISTS_URL = "https://api.cc.email/v3/contact_lists";

const clientId = process.env.CC_CLIENT_ID;
const clientSecret = process.env.CC_CLIENT_SECRET;
const initialRefreshToken = process.env.CC_INITIAL_REFRESH_TOKEN;
const adminApiKey = process.env.ADMIN_API_KEY || "";
const frontendOrigin = process.env.FRONTEND_ORIGIN || "*";
const tokenStorePath = path.resolve(process.cwd(), process.env.TOKEN_STORE_PATH || "./token-store.json");
const newsletterMapPath = path.resolve(process.cwd(), "./newsletter-map.json");
const serverDirPath = path.dirname(fileURLToPath(import.meta.url));
const publicFormScriptPath = path.resolve(serverDirPath, "../form.js");

function normalizeOrigin(origin) {
  if (!origin) return "";
  return String(origin).replace(/\/$/, "").toLowerCase();
}

function withLocalAliases(origins) {
  const set = new Set(origins.map(normalizeOrigin).filter(Boolean));
  origins.forEach((origin) => {
    const normalized = normalizeOrigin(origin);
    if (!normalized) return;
    if (normalized.includes("localhost:")) {
      set.add(normalized.replace("localhost", "127.0.0.1"));
    }
    if (normalized.includes("127.0.0.1:")) {
      set.add(normalized.replace("127.0.0.1", "localhost"));
    }
  });
  return set;
}

if (!clientId || !clientSecret || !initialRefreshToken) {
  console.warn("Missing CC env vars. Set CC_CLIENT_ID, CC_CLIENT_SECRET, and CC_INITIAL_REFRESH_TOKEN.");
}

const configuredOrigins = frontendOrigin
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const allowedOrigins = frontendOrigin === "*" ? null : withLocalAliases(configuredOrigins);

app.use(
  cors({
    origin(origin, callback) {
      if (allowedOrigins === null) {
        callback(null, true);
        return;
      }

      // Allow requests without Origin header (curl, server-to-server).
      if (!origin) {
        callback(null, true);
        return;
      }

      if (allowedOrigins.has(normalizeOrigin(origin))) {
        callback(null, true);
        return;
      }

      callback(new Error("CORS origin not allowed"));
    }
  })
);
app.use(express.json());

app.get("/cc/v1/form.js", (_req, res) => {
  if (!fs.existsSync(publicFormScriptPath)) {
    return res.status(404).type("text/plain").send("form.js not found");
  }

  res.type("application/javascript");
  return res.sendFile(publicFormScriptPath);
});

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function getNewsletterMap() {
  return readJsonFile(newsletterMapPath, {});
}

function getTokenStore() {
  const fallback = {
    accessToken: "",
    refreshToken: initialRefreshToken || "",
    accessTokenExpiresAt: 0
  };
  return readJsonFile(tokenStorePath, fallback);
}

function saveTokenStore(store) {
  writeJsonFile(tokenStorePath, store);
}

function sanitizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""));
}

function hasValidAdminKey(req) {
  const provided = req.get("x-admin-key") || "";
  return Boolean(adminApiKey) && provided === adminApiKey;
}

async function refreshAccessToken() {
  const store = getTokenStore();
  const refreshToken = store.refreshToken || initialRefreshToken;

  if (!refreshToken) {
    throw new Error("Missing refresh token on server.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId || "",
    client_secret: clientSecret || ""
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error("Token refresh failed.");
  }

  const updatedStore = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    accessTokenExpiresAt: Date.now() + Number(data.expires_in || 3600) * 1000
  };

  saveTokenStore(updatedStore);
  return updatedStore.accessToken;
}

async function getValidAccessToken() {
  const store = getTokenStore();
  if (store.accessToken && Number(store.accessTokenExpiresAt) > Date.now() + 60000) {
    return store.accessToken;
  }
  return refreshAccessToken();
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/cc/v1/newsletters", (_req, res) => {
  const newsletterMap = getNewsletterMap();
  const newsletters = Object.entries(newsletterMap).map(([key, value]) => ({
    key,
    label: value.label
  }));

  res.json({ newsletters });
});

app.get("/cc/v1/admin/contact-lists", async (req, res) => {
  try {
    if (!hasValidAdminKey(req)) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const accessToken = await getValidAccessToken();
    const ccResponse = await fetch(CONTACT_LISTS_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      }
    });

    const ccData = await ccResponse.json().catch(() => ({}));
    if (!ccResponse.ok) {
      return res.status(ccResponse.status || 500).json({
        message: "Constant Contact contact list request failed.",
        details: ccData
      });
    }

    const lists = Array.isArray(ccData.lists) ? ccData.lists : [];
    return res.json({
      lists: lists.map((item) => ({
        list_id: item.list_id,
        name: item.name,
        favorite: item.favorite,
        updated_at: item.updated_at
      }))
    });
  } catch (error) {
    return res.status(500).json({
      message: error instanceof Error ? error.message : "Unexpected server error."
    });
  }
});

app.post("/cc/v1/subscribe", async (req, res) => {
  try {
    const payload = req.body || {};
    const email = String(payload.email || "").trim();
    const firstName = String(payload.first_name || "").trim();
    const lastName = String(payload.last_name || "").trim();
    const companyName = String(payload.company_name || "").trim();
    const consent = Boolean(payload.consent);
    const newsletterKeys = Array.isArray(payload.newsletter_keys) ? payload.newsletter_keys.map(sanitizeKey) : [];

    if (!isValidEmail(email)) {
      return res.status(400).json({ message: "Email is required." });
    }

    if (!consent) {
      return res.status(400).json({ message: "Consent is required." });
    }

    const newsletterMap = getNewsletterMap();
    const listMemberships = [...new Set(newsletterKeys)]
      .filter((key) => Boolean(newsletterMap[key]))
      .map((key) => newsletterMap[key].list_id)
      .filter(Boolean);

    if (!listMemberships.length) {
      return res.status(400).json({ message: "Select at least one newsletter option." });
    }

    const accessToken = await getValidAccessToken();

    const ccPayload = {
      email_address: email,
      first_name: firstName,
      last_name: lastName,
      company_name: companyName,
      list_memberships: listMemberships
    };

    const ccResponse = await fetch(SIGNUP_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(ccPayload)
    });

    const ccData = await ccResponse.json().catch(() => ({}));
    if (!ccResponse.ok) {
      return res.status(ccResponse.status || 500).json({
        message: "Constant Contact rejected the request.",
        details: ccData
      });
    }

    return res.json({ ok: true, result: ccData });
  } catch (error) {
    return res.status(500).json({
      message: error instanceof Error ? error.message : "Unexpected server error."
    });
  }
});

app.listen(port, () => {
  console.log(`CC secure server running on http://localhost:${port}`);
});
