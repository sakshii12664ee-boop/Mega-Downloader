const UPSTREAM = (process.env.UPSTREAM_API_BASE || "https://clonr.co/api").replace(/\/$/, "");
const TERMINAL = new Set(["completed", "partial", "failed", "expired"]);
// Must stay well below the function's maxDuration so we can always answer with JSON
// (a platform timeout returns a non-JSON error page, which the bot cannot interpret).
const MAX_WAIT_MS = Math.min(Number(process.env.MAX_WAIT_MS || 12000), 20000);
const CALL_TIMEOUT_MS = Math.min(Number(process.env.UPSTREAM_TIMEOUT_MS || 8000), 15000);

function effectiveState(x) {
  const total = Number(x?.total_files ?? 0);
  const completed = Number(x?.completed_files ?? 0);
  const failed = Number(x?.failed_files ?? 0);
  if (x?.cache_state === "completed" || (x?.zip_url && total > 0 && completed >= total && failed === 0)) return "completed";
  return x?.state || x?.cache_state || "unknown";
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
const MEGA_HOSTS = ["mega.nz", "mega.io", "mega.co.nz"];
const ID = "[A-Za-z0-9_-]{6,12}", KEY = "[A-Za-z0-9_-]{16,90}";
const LEGACY = new RegExp(`^(F?)!(${ID})!(${KEY})(?:([!?])(${ID}))?$`);
const BANG_PATH = new RegExp(`^/(file|folder)/(${ID})!(${KEY})/?$`);
// Old MEGA links (#F!id!key, #!id!key, /file/id!key) -> https://mega.nz/file|folder/id#key
function normalizeMega(value) {
  let v = String(value || "").trim();
  if (!v.includes("#") && v.includes("%23")) v = v.replace(/%23/g, "#").replace(/%21/g, "!").replace(/%3F/gi, "?");
  let u; try { u = new URL(v); } catch { return v; }
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!MEGA_HOSTS.some(r => host === r || host.endsWith(`.${r}`))) return v;
  const frag = u.hash.replace(/^#/, "");
  let m;
  if ((u.pathname === "/" || u.pathname === "") && (m = LEGACY.exec(frag))) {
    const [, isFolder, id, key, sep, sub] = m;
    let out = `https://mega.nz/${isFolder ? "folder" : "file"}/${id}#${key}`;
    if (isFolder && sub) out += `/${sep === "!" ? "folder" : "file"}/${sub}`;
    return out;
  }
  if (!frag && (m = BANG_PATH.exec(u.pathname))) return `https://mega.nz/${m[1]}/${m[2]}#${m[3]}`;
  if (/^\/(file|folder)\//.test(u.pathname)) return `https://mega.nz${u.pathname}${frag ? "#" + frag : ""}`;
  return v;
}
function safeUrl(value) {
  try {
    const u = new URL(normalizeMega(value));
    const host = u.hostname.toLowerCase().replace(/\.$/, "");
    const isMegaHost = MEGA_HOSTS.some(root => host === root || host.endsWith(`.${root}`));
    return /^https?:$/.test(u.protocol) && !u.username && !u.password && isMegaHost ? u.toString() : null;
  } catch { return null; }
}
async function upstream(path, init = {}) {
  let r;
  try {
    r = await fetch(`${UPSTREAM}${path}`, { ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS), headers: { accept: "application/json", ...(init.headers || {}) } });
  } catch (e) {
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    throw Object.assign(new Error(timedOut ? "The upstream MEGA service took too long to respond." : "Could not reach the upstream MEGA service."), { status: 504, timeout: true });
  }
  const text = await r.text(); let body; try { body = text ? JSON.parse(text) : null; } catch { body = { error: text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) }; }
  if (!r.ok) throw Object.assign(new Error(body?.error || body?.message || `Upstream HTTP ${r.status}`), { status: r.status, body });
  return body;
}
function metadata(x, fallbackId) {
  const files = Array.isArray(x?.files) ? x.files : [];
  return {
    job_id: x?.id || fallbackId,
    state: effectiveState(x),
    name: x?.name || null,
    total_files: x?.total_files ?? files.length,
    total_size: x?.total_size ?? null,
    completed_files: x?.completed_files ?? null,
    failed_files: x?.failed_files ?? null,
    zip_url: x?.zip_url || null,
    files: files.map(f => ({
      name: f.name || null,
      size: f.size ?? null,
      state: f.state || null,
      poster: f.poster || null,
      download_url: f.url || null,
      width: f.width ?? null,
      height: f.height ?? null,
      duration_s: f.duration_s ?? null
    }))
  };
}
function idFrom(body) { return body?.id || body?.job_id; }

export async function GET(request) {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  const input = new URL(request.url, "https://vercel.local").searchParams.get("url");
  const megaUrl = safeUrl(input);
  if (!megaUrl) return json({ error: "invalid_url", message: "Provide a valid MEGA file or folder URL (mega.nz, mega.io, or mega.co.nz). Encode # as %23 in the query string." }, 400);
  let id = null, status = null;
  try {
    const add = await upstream("/clone/add", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: megaUrl, turnstile_token: process.env.TURNSTILE_TOKEN || "" }) });
    id = idFrom(add); if (!id) return json({ error: "upstream_invalid_response", message: "The upstream MEGA service did not return a job ID." }, 502);
    const cached = add.already_cached === true || add.cache_state === "completed";
    if (!cached) await upstream(`/clone/${encodeURIComponent(id)}/start`, { method: "POST" });
    status = await upstream(`/clone/${encodeURIComponent(id)}`);
    const deadline = Date.now() + MAX_WAIT_MS;
    while (!TERMINAL.has(effectiveState(status)) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1000));
      const states = await upstream("/clone/states", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [id] }) });
      const brief = states?.states?.[id];
      if (brief?.state) status = { ...status, ...brief };
      if (TERMINAL.has(effectiveState(status))) break;
      if (Date.now() >= deadline) break;
      status = await upstream(`/clone/${encodeURIComponent(id)}`);
    }
    const result = metadata(status, id);
    return json(result, TERMINAL.has(result.state) ? 200 : 202);
  } catch (e) {
    // The job already exists upstream: tell the bot to keep polling instead of failing the request.
    if (id && (e?.timeout || (e?.status && e.status >= 500))) {
      const partial = metadata(status || {}, id);
      return json({ ...partial, state: "processing" }, 202);
    }
    return json({ error: "upstream_error", message: e?.message || "Upstream error" }, e?.status && e.status < 500 ? e.status : 502);
  }
}

export const config = { runtime: "nodejs", maxDuration: 30 };
