/* ============ Zendrx — app.js ============ */
const REPO_OWNER = "zendrx";
const REPO_NAME  = "port";
const BRANCH     = "main"; // change if your default branch isn't main

const API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents`;
const RAW = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${BRANCH}`;

/* ---- shared markdown renderer setup ---- */
if (typeof marked !== "undefined") {
  marked.setOptions({
    highlight: (code, lang) => {
      if (window.hljs && lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return code;
    },
    breaks: true
  });
}

function renderMD(md) {
  // strip leading front-matter if present (--- ... ---)
  md = md.replace(/^---\n[\s\S]*?\n---\n/, "");
  return marked.parse(md);
}

/* get param like ?name=agent-cr */
function param(key) {
  return new URLSearchParams(window.location.search).get(key);
}

/* list .md files in a dir via GitHub API */
async function listMD(dir) {
  const res = await fetch(`${API}/${dir}?ref=${BRANCH}`);
  if (!res.ok) throw new Error(`GitHub API error ${res.status} — check repo is public and branch is "${BRANCH}"`);
  const files = await res.json();
  return files.filter(f => f.name.endsWith(".md"));
}

/* fetch first N chars of a file for card previews */
async function fetchRaw(path) {
  const res = await fetch(`${RAW}/${path}`);
  if (!res.ok) throw new Error(`Could not fetch ${path}`);
  return await res.text();
}

/* build a preview snippet from raw markdown */
function makeSnippet(md, max = 140) {
  const text = md
    .replace(/^---\n[\s\S]*?\n---\n/, "")   // front-matter
    .replace(/^#.*$/m, "")                  // h1 (title shown separately)
    .replace(/[\s\S]*?/g, "")         // code blocks
    .replace(/[*_>`#\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? text.slice(0, max) + "…" : text;
}
