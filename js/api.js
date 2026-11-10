// The ONLY file that talks to the network.
// Every request goes to the ACS base-model API. To add a backend proxy later (public play without
// player keys), change BASE_URL and authHeaders() here; nothing else in the game needs to change.
//
// Key handling:
//   - The key lives in a module variable (memory). If the player ticks "remember for this tab",
//     it is also copied to sessionStorage, which the browser clears when the tab closes.
//   - It is only ever sent in the Authorization header to BASE_URL.
//   - It is never logged, never put in a URL, and never written to localStorage or cookies.

export const BASE_URL = "https://api.v2.infra.acsresearch.org/v1";
const SESSION_KEY = "sample-says:acs-key";
const COLD_TIMEOUT_MS = 15 * 60 * 1000; // cold boots can take many minutes
const WARM_TIMEOUT_MS = 90 * 1000;

let apiKey = null;
try {
  apiKey = sessionStorage.getItem(SESSION_KEY);
} catch {
  /* storage blocked: memory only */
}

export function setKey(key, { remember = false } = {}) {
  apiKey = (key || "").trim() || null;
  try {
    if (remember && apiKey) sessionStorage.setItem(SESSION_KEY, apiKey);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}
export function hasKey() {
  return !!apiKey;
}
export function isRemembered() {
  try {
    return !!sessionStorage.getItem(SESSION_KEY);
  } catch {
    return false;
  }
}
export function clearKey() {
  setKey(null);
}
/** Show only the start of the key, e.g. "sk-acs-ab12…". */
export function keyHint() {
  if (!apiKey) return "";
  return apiKey.startsWith("sk-acs-") ? apiKey.slice(0, 11) + "…" : apiKey.slice(0, 6) + "…";
}
/** Keys from the old (v1) platform start with "acs-bm-" and don't work on v2. */
export function isOldKey() {
  return !!apiKey && apiKey.startsWith("acs-bm-");
}
const OLD_KEY_MSG =
  "That's a key from the old ACS platform (it starts with acs-bm-). Make a new key at v2.infra.acsresearch.org; v2 keys start with sk-acs-.";

export class ApiError extends Error {
  constructor(message, { code = "error", status = 0, retryAfter = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const FRIENDLY = {
  missing_authorization: "Paste your ACS API key first.",
  invalid_api_key: "That API key wasn't recognised. Check you copied the whole key.",
  key_revoked: "That API key has been revoked. Make a new one on the ACS API keys page.",
  key_disabled: "That API key is paused. Resume it on the ACS API keys page.",
  account_suspended: "This ACS account is suspended.",
  account_not_approved: "This account doesn't have API access yet.",
  scope_denied: "This key doesn't have the 'completions' scope.",
  budget_exceeded: "This key is out of token budget for now. It resets at midnight UTC, or use another key.",
  rate_limited: "Too many requests at once. Wait a few seconds and try again.",
  queue_full: "Too many requests at once. Wait a few seconds and try again.",
  spend_cap: "The ACS service has paused new requests for a while. Try again later.",
  modal_cold_boot: "The model is still starting up. Try again in a minute.",
  model_not_found: "That model isn't available right now. Pick another.",
};

function authHeaders() {
  if (!apiKey) throw new ApiError(FRIENDLY.missing_authorization, { code: "missing_authorization" });
  return { Authorization: `Bearer ${apiKey}` };
}

/** Recent request bodies (never headers or the key), for the "Show me this in the API" view. */
export const requestLog = [];

async function request(path, { method = "GET", body, timeoutMs = WARM_TIMEOUT_MS, auth = true } = {}) {
  if (body) {
    requestLog.push({ path, body });
    if (requestLog.length > 6) requestLog.shift();
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(BASE_URL + path, {
      method,
      headers: {
        ...(auth ? authHeaders() : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
        "X-Acs-Workload": "interactive",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const msg = e.name === "AbortError" ? "The request took too long and was stopped." : "Couldn't reach the ACS API. Check your connection.";
    throw new ApiError(msg, { code: e.name === "AbortError" ? "timeout" : "network" });
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = await res.json(); // JSON allows the API's leading keepalive whitespace
  } catch {
    /* non-JSON */
  }
  const err = data && data.error; // errors can arrive inside a 200 body on long requests
  if (!res.ok || err) {
    const code = (err && typeof err.code === "string" && err.code) || `http_${res.status}`;
    const message =
      (code === "invalid_api_key" && isOldKey() && OLD_KEY_MSG) ||
      FRIENDLY[code] ||
      (err && err.message) ||
      `The API returned an error (${res.status}).`;
    throw new ApiError(message, { code, status: res.status, retryAfter: res.headers.get("Retry-After") });
  }
  return data;
}

/** GET /v1/models -> [{id, ...}] */
export async function listModels() {
  const data = await request("/models");
  return data.data || [];
}

/** GET /v1/models/{id}/status -> {warm, boot:{stage_label, stage_age_s}} */
export async function modelStatus(id) {
  return request(`/models/${encodeURIComponent(id)}/status`);
}

/** Raw completion call. Pass {cold:true} to allow a long wait for a cold model. */
export async function complete(body, { cold = false } = {}) {
  return request("/completions", { method: "POST", body, timeoutMs: cold ? COLD_TIMEOUT_MS : WARM_TIMEOUT_MS });
}
