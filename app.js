/* ================================================================
   Zendrx — app.js  v2
   Static GitHub-backed content engine
   - front-matter aware (title, tagline, date, tags, repo, draft)
   - in-memory + sessionStorage caching
   - sorted card listings (date desc, falls back to filename)
   - resilient fetching with retry + human-readable errors
   - zero dependencies beyond marked
   ================================================================ */

"use strict";

/* ---------------- config ---------------- */
const CONFIG = {
  owner:  "zendrx",
  repo:   "port",
  branch: "main",          // change if your default branch differs
  snippetLength: 160,
  maxRetries: 2,
  retryDelayMs: 600,
  requestTimeoutMs: 10000,
};

const API = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents`;
const RAW = `https://raw.githubusercontent.com/${CONFIG.owner}/${CONFIG.repo}/${CONFIG.branch}`;

/* ---------------- marked setup ---------------- */
if (typeof marked !== "undefined") {
  marked.use({
    gfm: true,
    breaks: true,
    renderer: {
      // safer links: force external links to open in a new tab
      link(token) {
        const { href, title, text } = token;
        const external = /^https?:\/\//.test(href);
        const t = title ? ` title="${escapeHTML(title)}"` : "";
        const rel = external ? ' target="_blank" rel="noopener noreferrer"' : "";
        return `<a href="${escapeHTML(href)}"${t}${rel}>${text}</a>`;
      },
      // stamp language class on code blocks for hljs even after parse
      code(token) {
        const lang = (token.lang || "").trim().split(/\s+/)[0];
        const cls = lang ? ` class="language-${escapeHTML(lang)}"` : "";
        return `<pre><code${cls}>${escapeHTML(token.text)}</code></pre>`;
      },
    },
  });
}

/* ---------------- utils ---------------- */
const escapeHTML = (s = "") =>
  s.replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const sleep = ms => new Promise(r => setTimeout(r, ms));

function param(key = "") {
  const params = new URLSearchParams(window.location.search);
  if (params.has(key)) return params.get(key) || params.get(key.replace(/^\?/, ""));
  // bare-param style: read.html?my-post
  const bare = window.location.search.replace(/^\?/, "").split("&")[0];
  return decodeURIComponent(bare || "") || null;
}

/* ---------------- front-matter parser (no gray-matter needed) ---------------- */
function parseFrontMatter(md) {
  const result = { meta: {}, body: md };
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return result;

  result.body = md.slice(m[0].length);
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let [, key, value] = kv;
    value = value.trim().replace(/^["']|["']$/g, "");
    if (value.startsWith("[") && value.endsWith("]")) {
      result.meta[key] = value.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
    } else {
      result.meta[key] = value;
    }
  }
  return result;
}

/* ---------------- caching layer ---------------- */
const memoryCache = new Map();

function cacheGet(key) {
  if (memoryCache.has(key)) return memoryCache.get(key);
  try {
    const hit = sessionStorage.getItem(`zendrx:${key}`);
    if (hit) {
      const val = JSON.parse(hit);
      memoryCache.set(key, val);
      return val;
    }
  } catch (_) { /* private mode etc — ignore */ }
  return null;
}

function cacheSet(key, value) {
  memoryCache.set(key, value);
  try { sessionStorage.setItem(`zendrx:${key}`, JSON.stringify(value)); } catch (_) {}
}

/* ---------------- fetch with timeout + retry ---------------- */
async function fetchWithRetry(url, opts = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 404) throw new HttpError(404, "not found");
      if (res.status === 403 && res.headers.get("X-RateLimit-Remaining") === "0") {
        throw new HttpError(403, "GitHub API rate limit reached — try again in a few minutes");
      }
      if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}`);
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      // don't retry definitive failures
      if (e instanceof HttpError && (e.status === 404 || e.status === 403)) throw e;
      if (attempt < CONFIG.maxRetries) await sleep(CONFIG.retryDelayMs * (attempt + 1));
    }
  }
  throw new HttpError(0, `network error after ${CONFIG.maxRetries + 1} attempts (${lastErr?.message || "unknown"})`);
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ---------------- public content API ---------------- */

/** list .md files in a directory (cached) */
async function listMD(dir) {
  const cacheKey = `list:${dir}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const res = await fetchWithRetry(`${API}/${dir}?ref=${CONFIG.branch}`);
  const files = await res.json();
  if (!Array.isArray(files)) throw new HttpError(500, "unexpected GitHub API response");

  const mdFiles = files
    .filter(f => f.type === "file" && f.name.endsWith(".md"))
    .map(f => ({
      name: f.name,
      slug: f.name.replace(/\.md$/, ""),
      sha: f.sha,
      size: f.size,
    }));

  cacheSet(cacheKey, mdFiles);
  return mdFiles;
}

/** fetch raw markdown for one file (cached) */
async function fetchRaw(path) {
  const cacheKey = `raw:${path}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const res = await fetchWithRetry(`${RAW}/${path}`);
  const text = await res.text();
  cacheSet(cacheKey, text);
  return text;
}

/** fetch one document, parsed: { meta, body, html } */
async function fetchDocument(dir, slug) {
  const raw = await fetchRaw(`${dir}/${slug}.md`);
  const { meta, body } = parseFrontMatter(raw);
  return {
    meta,
    slug,
    title: meta.title || prettifySlug(slug),
    tagline: meta.tagline || "",
    date: meta.date || "",
    tags: meta.tags || [],
    repo: meta.repo || "",
    draft: meta.draft === true || meta.draft === "true",
    html: renderMD(body),
    snippet: makeSnippet(body),
  };
}

/** list all documents in a dir, fully parsed + sorted (date desc) */
async function listDocuments(dir) {
  const files = await listMD(dir);
  const docs = await Promise.all(
    files.map(f => fetchDocument(dir, f.slug).catch(() => null))
  );
  return docs
    .filter(Boolean)
    .filter(d => !d.draft)
    .sort((a, b) => {
      const da = Date.parse(a.date) || 0;
      const db = Date.parse(b.date) || 0;
      return db - da || a.slug.localeCompare(b.slug);
    });
}

/* ---------------- rendering helpers ---------------- */

function renderMD(md) {
  return typeof marked !== "undefined"
    ? marked.parse(md)
    : `<p class="error-msg">markdown renderer failed to load</p>`;
}

function prettifySlug(slug = "") {
  return slug
    .split("-")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function makeSnippet(md, max = CONFIG.snippetLength) {
  const text = md
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    .replace(/^#.*$/m, "")
    .replace(/[\s\S]*?/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_>`#\-|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function formatDate(iso) {
  const d = Date.parse(iso);
  if (Number.isNaN(d)) return "";
  return new Date(d).toLocaleDateString("en-US", {
    year: "numeric", month: "short", day: "numeric",
  });
}

/** escape a snippet before injecting into innerHTML */
const safeSnippet = s => escapeHTML(s || "");

/* ---------------- card renderer (shared by projects & blog) ---------------- */

function cardHTML(doc, hrefBase) {
  const meta = [
    doc.date ? formatDate(doc.date) : null,
    doc.tags.length ? doc.tags.map(t => `#${escapeHTML(t)}`).join(" ") : null,
  ].filter(Boolean).join(" · ");

  return `
    <a class="card" href="${hrefBase}?${encodeURIComponent(doc.slug)}">
      <h2>${escapeHTML(doc.title)} <span class="arrow">→</span></h2>
      ${meta ? `<div class="meta">${meta}</div>` : ""}
      ${doc.tagline
        ? `<p class="desc">${escapeHTML(doc.tagline)}</p>`
        : `<p class="desc">${safeSnippet(doc.snippet)}</p>`}
    </a>`;
}

function renderCardList(container, docs, hrefBase) {
  if (!docs.length) {
    container.innerHTML = `<p class="error-msg">nothing here yet — check back soon</p>`;
    return;
  }
  container.innerHTML = docs.map(d => cardHTML(d, hrefBase)).join("");
}

/** wire up a listing page with one call */
async function mountListPage(containerId, dir, hrefBase) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `<div class="loading">fetching ${escapeHTML(dir)}</div>`;
  try {
    const docs = await listDocuments(dir);
    renderCardList(el, docs, hrefBase);
  } catch (e) {
    el.innerHTML = `<p class="error-msg">${escapeHTML(e.message)}</p>`;
  }
}

/** wire up a reader page (show.html / read.html) */
async function mountReaderPage(containerId, dir, backHref, backLabel) {
  const el = document.getElementById(containerId);
  const slug = param("");

  // update back link text
  const back = document.querySelector(".article-back");
  if (back && backLabel) back.textContent = `← back to ${backLabel}`;

  if (!slug) {
    el.innerHTML = `<p class="error-msg">no document specified — <a href="${backHref}">go back</a></p>`;
    return;
  }

  el.innerHTML = `<div class="loading">loading ${escapeHTML(slug)}</div>`;
  try {
    const doc = await fetchDocument(dir, slug);
    document.title = `${doc.title} — Zendrx`;
    el.innerHTML = doc.html;
    if (window.hljs) hljs.highlightAll();
  } catch (e) {
    el.innerHTML = e.status === 404
      ? `<p class="error-msg">"${escapeHTML(slug)}" doesn't exist — <a href="${backHref}">go back</a></p>`
      : `<p class="error-msg">${escapeHTML(e.message)}</p>`;
  }
}
