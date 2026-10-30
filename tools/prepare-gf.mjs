#!/usr/bin/env node
// Генератор публичной копии скрипта для Greasy Fork и других площадок.
//
//   node tools/prepare-gf.mjs
//
// Читает duo-helper.user.js (оригинал НЕ изменяется) и пишет
// gf/duo-helper.public.user.js с правками под правила хостингов:
//   1. без @updateURL / @downloadURL — запрещены альтернативные источники загрузки;
//   2. без внутреннего апдейтера — его кнопка ведёт на GitHub raw;
//   3. без @connect GitHub/jsDelivr — они используются только апдейтером;
//   4. @description только на английском.
//
// Папка gf/ в .gitignore — файл для загрузки не попадает в git.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "duo-helper.user.js");
const outDir = join(root, "gf");
const out = join(outDir, "duo-helper.public.user.js");

let text = readFileSync(src, "utf8");
const originalLength = text.length;
const log = [];

function cut(pattern, label) {
  const next = text.replace(pattern, "");
  if (next === text) {
    console.warn(`⚠️  не найдено (пропущено): ${label}`);
  } else {
    log.push(label);
    text = next;
  }
}

// 1) шапка: альтернативные источники и github-connect
cut(/^\/\/ @updateURL[^\n]*\n/gm, "@updateURL");
cut(/^\/\/ @downloadURL[^\n]*\n/gm, "@downloadURL");
cut(/^\/\/ @connect\s+raw\.githubusercontent\.com[^\n]*\n/gm, "@connect raw.githubusercontent.com");
cut(/^\/\/ @connect\s+cdn\.jsdelivr\.net[^\n]*\n/gm, "@connect cdn.jsdelivr.net");
cut(/^\/\/ @connect\s+api\.github\.com[^\n]*\n/gm, "@connect api.github.com");

// 2) @description — только английская часть (до " / ")
{
  const next = text.replace(
    /^\/\/ @description\s+([^\n]*?)\s*\/\s*Проверка[^\n]*\n/gm,
    "// @description  $1\n",
  );
  if (next === text) {
    console.warn("⚠️  не найдено (пропущено): @description → EN");
  } else {
    log.push("@description → EN");
    text = next;
  }
}

// 3) блок «ПРОВЕРКА ОБНОВЛЕНИЙ» — вырезается целиком, остаётся CURRENT_VERSION
// (его используют шаблоны багрепортов). Границы — секционные комментарии.
const startMark = "  // ========== ПРОВЕРКА ОБНОВЛЕНИЙ ==========";
const endMark = "  // ========== Window drag + position ==========";
const s = text.indexOf(startMark);
const e = text.indexOf(endMark);
if (s === -1 || e === -1 || e < s) {
  console.error("❌ не найдены границы блока апдейтера — вырезание отменено");
  process.exit(1);
}
const replacement =
  startMark + "\n" +
  "  // (для Greasy Fork вырезано: апдейтер и адреса GitHub не публикуются)\n" +
  "  const CURRENT_VERSION =\n" +
  "    (typeof GM_info !== \"undefined\" && GM_info.script && GM_info.script.version) ||\n" +
  "    \"0.3.5\";\n\n";
text = text.slice(0, s) + replacement + text.slice(e);
log.push(`блок апдейтера (${e - s} символов → константа CURRENT_VERSION)`);

// 4) вызов initUpdateCheck() в createUI
cut(/\n\s*initUpdateCheck\(\);/g, "вызов initUpdateCheck()");

// 5) строка настроек «Версия скрипта» → версия + пояснение о сборке для Greasy Fork
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const settingsRowLines = [
  '                <div class="dh-setting-row">',
  '                    <div class="dh-setting-label">',
  '                        ${t("set.version")}',
  '                        <small id="dh-current-version">…</small>',
  '                    </div>',
  '                    <button class="dh-btn" id="dh-check-update" style="padding:5px 10px;font-size:11px">${t("set.checkUpdate")}</button>',
  '                </div>',
];
const settingsRowRe = new RegExp(settingsRowLines.map(escRe).join("\r?\n") + "\r?\n", "");
const settingsRowNew = [
  '                <div class="dh-setting-row">',
  '                    <div class="dh-setting-label">',
  '                        ${t("set.version")}',
  '                        <small id="dh-current-version">v${CURRENT_VERSION}</small>',
  '                    </div>',
  '                    <div class="dh-muted" style="font-size:10px;flex:1;min-width:0">${t("set.publicNote")}</div>',
  '                </div>',
  "",
].join("\n");
{
  const next = text.replace(settingsRowRe, settingsRowNew);
  if (next === text) {
    console.warn("⚠️  не найдено (пропущено): строка настроек «Версия скрипта»");
  } else {
    log.push("строка настроек «Версия скрипта» → пояснение о публичной сборке");
    text = next;
  }
}

mkdirSync(outDir, { recursive: true });
writeFileSync(out, text, "utf8");

console.log(`✔ gf/duo-helper.public.user.js (${originalLength} → ${text.length} символов)`);
console.log("  вырезано:");
for (const l of log) console.log("   - " + l);
