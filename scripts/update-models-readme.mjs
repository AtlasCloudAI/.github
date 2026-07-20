#!/usr/bin/env node
/**
 * update-models-readme.mjs — sync the live Atlas Cloud model catalog into README blocks.
 *
 * Rewrites every `<!-- ATLAS-MODELS:START ... --> ... <!-- ATLAS-MODELS:END -->` block
 * found in markdown files with a freshly generated summary of the live model catalog
 * (fetched from the public, unauthenticated models API).
 *
 * Marker attributes (all optional):
 *   lang=en|zh-CN|ja|ko|es|fr   UI language of the generated block (default: en)
 *   campaign=<utm_campaign>     utm_campaign for the "explore more" link (default: github)
 *   groups=video,image,3d,llm,audio   subset + order of groups to render (default: all)
 *   featured=<n>                max featured model families per group (default: 4; video: 6)
 *
 * Usage:
 *   node update-models-readme.mjs [--dry-run] [files...]
 * With no file args, recursively scans the current working directory for .md files
 * containing the START marker (node_modules/.git skipped).
 *
 * Zero dependencies. Node >= 18. Onboarding a new repo or file = add the two marker
 * lines and (for a repo) the thin caller workflow — nothing else.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const API_URL = "https://api.atlascloud.ai/api/v1/models";
const EXPLORE_URL = "https://www.atlascloud.ai/models";

// Display groups, mapped from the platform's category taxonomy. Categories that
// appear in the API but are not listed here are auto-collected into a "more"
// group so newly launched platform categories are never silently dropped.
const GROUPS = [
  { key: "video", emoji: "🎬", cats: ["TEXT-TO-VIDEO", "IMAGE-TO-VIDEO", "REFERENCE-TO-VIDEO", "VIDEO-TO-VIDEO", "AUDIO-TO-VIDEO"] },
  { key: "image", emoji: "🎨", cats: ["TEXT-TO-IMAGE", "IMAGE-TO-IMAGE", "IMAGE-TOOLS"] },
  { key: "3d", emoji: "🧊", cats: ["IMAGE-TO-3D", "TEXT-TO-3D"] },
  { key: "llm", emoji: "💬", cats: ["LLM"] },
  { key: "audio", emoji: "🔊", cats: ["TEXT-TO-SPEECH", "SPEECH-TO-TEXT"] },
];

const I18N = {
  en:      { video: "Video", image: "Image", "3d": "3D", llm: "LLM", audio: "Audio (TTS · Music · ASR)", more: "More", explore: (n, u) => `📚 **Explore more** — [all ${n} live models »](${u})` },
  "zh-CN": { video: "视频", image: "图片", "3d": "3D", llm: "大语言模型", audio: "音频（TTS · 音乐 · 语音识别）", more: "更多", explore: (n, u) => `📚 **探索更多** — [全部 ${n} 个在线模型 »](${u})` },
  ja:      { video: "動画", image: "画像", "3d": "3D", llm: "LLM", audio: "音声 (TTS · 音楽 · 音声認識)", more: "その他", explore: (n, u) => `📚 **さらに探す** — [全 ${n} モデル »](${u})` },
  ko:      { video: "비디오", image: "이미지", "3d": "3D", llm: "LLM", audio: "오디오 (TTS · 음악 · STT)", more: "기타", explore: (n, u) => `📚 **더 살펴보기** — [전체 ${n}개 모델 »](${u})` },
  es:      { video: "Vídeo", image: "Imagen", "3d": "3D", llm: "LLM", audio: "Audio (TTS · Música · ASR)", more: "Más", explore: (n, u) => `📚 **Explora más** — [los ${n} modelos en vivo »](${u})` },
  fr:      { video: "Vidéo", image: "Image", "3d": "3D", llm: "LLM", audio: "Audio (TTS · Musique · ASR)", more: "Plus", explore: (n, u) => `📚 **Explorer plus** — [les ${n} modèles en ligne »](${u})` },
};

const MARKER_RE = /<!--\s*ATLAS-MODELS:START([^>]*?)-->[\s\S]*?<!--\s*ATLAS-MODELS:END\s*-->/g;

async function fetchModels() {
  const res = await fetch(API_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; atlas-models-sync/1.0; +https://github.com/AtlasCloudAI)" },
  });
  if (!res.ok) throw new Error(`models API HTTP ${res.status}`);
  const body = await res.json();
  const list = body?.data;
  if (!Array.isArray(list) || list.length === 0) throw new Error("models API returned no data");
  return list.filter((m) => m.display_console !== false);
}

// Family key for de-duping variants (e.g. bytedance/seedream-v5.0-pro/{edit,text-to-image}).
function familyKey(m) {
  return (m.model || "").split("/").slice(0, 2).join("/");
}

// Human name for a family: shortest displayName in the family, with task suffixes stripped.
function familyLabel(models) {
  const names = models
    .map((m) => (m.displayName || m.model || ""))
    .map((n) =>
      n
        .replace(/\b(text|image|reference|video|audio|speech)[\s-]*(to|→)[\s-]*(image|video|3d|audio|text|speech)\b/gi, " ")
        .replace(/\b(edit|developer)\b/gi, " ")
        .replace(/\s{2,}/g, " ")
        .replace(/[\s\-–—:]+$/g, "")
        .trim()
    )
    .filter(Boolean);
  names.sort((a, b) => a.length - b.length);
  return names[0] || "";
}

function buildCatalog(models) {
  const byCat = new Map();
  for (const m of models) {
    for (const c of m.categories || []) {
      if (!byCat.has(c)) byCat.set(c, []);
      byCat.get(c).push(m);
    }
  }
  const mappedCats = new Set(GROUPS.flatMap((g) => g.cats));
  const extraCats = [...byCat.keys()].filter((c) => !mappedCats.has(c)).sort();

  const groups = {};
  for (const g of GROUPS) {
    const pool = g.cats.flatMap((c) => byCat.get(c) || []);
    groups[g.key] = summarize(pool);
  }
  if (extraCats.length > 0) {
    groups.more = summarize(extraCats.flatMap((c) => byCat.get(c)));
  }
  return { groups, extraCats, total: models.length };
}

function summarize(pool) {
  const uniq = new Map(); // familyKey -> models[]
  const seen = new Set();
  let count = 0;
  for (const m of pool) {
    if (seen.has(m.model)) continue; // a model can carry several categories of one group
    seen.add(m.model);
    count++;
    const k = familyKey(m);
    if (!uniq.has(k)) uniq.set(k, { prio: m.priority || 0, models: [] });
    const fam = uniq.get(k);
    fam.prio = Math.max(fam.prio, m.priority || 0);
    fam.models.push(m);
  }
  const families = [...uniq.values()]
    .sort((a, b) => b.prio - a.prio)
    .map((f) => familyLabel(f.models))
    .filter(Boolean);
  return { count, families: [...new Set(families)] };
}

function parseAttrs(raw) {
  const attrs = {};
  for (const m of raw.matchAll(/([a-zA-Z_-]+)\s*=\s*([^\s]+)/g)) attrs[m[1]] = m[2];
  return attrs;
}

function renderBlock(attrsRaw, catalog) {
  const attrs = parseAttrs(attrsRaw);
  const lang = I18N[attrs.lang] ? attrs.lang : "en";
  const t = I18N[lang];
  const campaign = attrs.campaign || "github";
  const wanted = attrs.groups ? attrs.groups.split(",").map((s) => s.trim()) : GROUPS.map((g) => g.key);
  const defaultFeatured = Number(attrs.featured) || 0;

  const lines = [];
  lines.push(`<!-- ATLAS-MODELS:START${attrsRaw.replace(/\s+$/, "")} -->`);
  lines.push(`<!-- ⚠️ Auto-generated from the live model catalog by AtlasCloudAI/.github/scripts/update-models-readme.mjs — do not edit by hand. -->`);
  for (const g of GROUPS) {
    if (!wanted.includes(g.key)) continue;
    const data = catalog.groups[g.key];
    if (!data || data.count === 0) continue;
    const n = defaultFeatured || (g.key === "video" ? 6 : 4);
    const featured = data.families.slice(0, n).join(" · ");
    lines.push(`- ${g.emoji} **${t[g.key]}** (${data.count}) — ${featured}`);
  }
  if (catalog.groups.more && wanted.includes("more")) {
    lines.push(`- ✨ **${t.more}** (${catalog.groups.more.count}) — ${catalog.extraCats.join(" · ")}`);
  }
  const exploreUrl = `${EXPLORE_URL}?utm_source=github&utm_campaign=${campaign}`;
  lines.push("");
  lines.push(`- ${t.explore(catalog.total, exploreUrl)}`);
  lines.push(`<!-- ATLAS-MODELS:END -->`);
  return lines.join("\n");
}

function* walkMarkdown(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) yield* walkMarkdown(p);
    else if (entry.toLowerCase().endsWith(".md")) yield p;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const fileArgs = args.filter((a) => !a.startsWith("--"));

  const models = await fetchModels();
  const catalog = buildCatalog(models);

  const files = fileArgs.length > 0 ? fileArgs : [...walkMarkdown(process.cwd())];
  let changed = 0;
  for (const f of files) {
    const before = readFileSync(f, "utf8");
    if (!before.includes("ATLAS-MODELS:START")) continue;
    const after = before.replace(MARKER_RE, (_, attrsRaw) => renderBlock(attrsRaw, catalog));
    if (after !== before) {
      changed++;
      if (!dryRun) writeFileSync(f, after);
      console.log(`${dryRun ? "[dry-run] would update" : "updated"}: ${f}`);
    } else {
      console.log(`up-to-date: ${f}`);
    }
  }
  console.log(`total_live_models=${catalog.total} files_changed=${changed}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `total=${catalog.total}\nchanged=${changed}\n`);
  }
}

main().catch((err) => {
  // Fail loudly: a broken API must never wipe README content (we only ever replace
  // marker blocks on success), and CI should surface the failure.
  console.error(err);
  process.exit(1);
});
