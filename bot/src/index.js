import { Bot } from "grammy";
import { createServer } from "http";
import { randomBytes } from "crypto";
import { config } from "./config.js";
import db from "./db.js";
import { encryptJWT, decryptJWT } from "./crypto.js";

const bot = new Bot(config.tgBotToken);

// локальная дата (YYYY-MM-DD) — не UTC, чтобы «сегодня» считалось по времени сервера
function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

// ответ на callback + безопасное редактирование («message is not modified» не роняет бота)
async function safeEdit(ctx, text, opts) {
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.editMessageText(text, opts).catch(() => {});
}

// блокировка забаненных пользователей
bot.use((ctx, next) => {
  if (ctx.from && ctx.from.id) {
    try {
      const banned = db.prepare("SELECT id FROM banned_users WHERE tg_user_id = ?").get(ctx.from.id);
      if (banned) {
        // для callback — отвечаем тихо, для команд — сообщение
        if (ctx.callbackQuery) {
          ctx.answerCallbackQuery("⛔ Вы заблокированы.").catch(() => {});
        } else {
          ctx.reply("⛔ Вы заблокированы.").catch(() => {});
        }
        return;
      }
    } catch {}
  }
  return next();
});

// обновляем tg_username при каждом обращении
bot.use((ctx, next) => {
  if (ctx.from && ctx.from.id) {
    try {
      const existing = db.prepare("SELECT id FROM users WHERE tg_user_id = ?").get(ctx.from.id);
      if (existing) {
        db.prepare("UPDATE users SET tg_username = ? WHERE tg_user_id = ?").run(ctx.from.username || "", ctx.from.id);
      }
    } catch {}
  }
  return next();
});

// /start
bot.command("start", (ctx) => {
  const startPayload = ctx.match;
  // bugreport с проверкой привязки
  if (startPayload && startPayload.startsWith("bugreport")) {
    const duoId = startPayload.replace("bugreport_", "").replace("bugreport", "");
    if (duoId) {
      // проверяем: привязан ли этот TG к этому Duolingo ID
      const linked = db.prepare("SELECT * FROM users WHERE tg_user_id = ? AND duolingo_user_id = ?").get(ctx.from.id, duoId);
      if (!linked) {
        ctx.reply("❌ Этот Telegram не привязан к данному аккаунту Duolingo. Сначала привяжите аккаунт через скрипт.");
        return;
      }
    }
    bugReportState.set(ctx.from.id, "waiting");
    ctx.reply(
      "🐛 <b>Багрепорт</b>\n\n" +
      "Опишите проблему одним сообщением:",
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "✖ Отмена", callback_data: "bug_cancel" }]] },
      }
    );
    return;
  }
  if (startPayload) {
    // deep link с кодом линковки
    handleLinkCode(ctx, startPayload);
    return;
  }
  showMainMenu(ctx);
});

// === Меню ===
function mainMenuKeyboard(isAdmin) {
  const rows = [
    [
      { text: "📊 Статистика", callback_data: "action_stats" },
      { text: "👥 Друзья", callback_data: "action_friends" },
    ],
    [
      { text: "🏆 Лига", callback_data: "action_league" },
    ],
    [
      { text: "⚙️ Настройки", callback_data: "menu_settings" },
      { text: "🐛 Багрепорт", callback_data: "bug_report_start" },
    ],
    [{ text: "🌐 Открыть сайт", url: "https://www.duolingo.com" }],
  ];
  if (isAdmin) {
    rows.push([{ text: "🔧 Админ-панель", callback_data: "menu_admin" }]);
  }
  return { inline_keyboard: rows };
}

function settingsMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🔔 Уведомления", callback_data: "settings_notify" }],
      [{ text: "🔗 Линковка", callback_data: "settings_link" }],
      [{ text: "← Назад", callback_data: "menu_main" }],
    ],
  };
}

// рендер бан-листа с пагинацией
async function renderBanList(ctx, page) {
  const perPage = 10;
  const total = db.prepare("SELECT COUNT(*) as n FROM banned_users").get().n;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const p = Math.max(1, Math.min(page, totalPages));
  const rows = db.prepare("SELECT * FROM banned_users ORDER BY banned_at DESC LIMIT " + perPage + " OFFSET " + ((p - 1) * perPage)).all();

  let text = `🚫 <b>Бан-лист</b> (${total})\n\n`;
  if (!rows.length) {
    text += "Список пуст.";
  } else {
    for (const r of rows) {
      const name = r.tg_username || r.tg_user_id;
      const duo = r.duolingo_username || r.duolingo_user_id || "—";
      text += `🚫 <b>${name}</b> · <code>${r.tg_user_id}</code>\n`;
      text += `   duo: ${duo} · ${r.banned_at}\n\n`;
    }
  }

  // кнопки пагинации + разбан для каждого
  const kb = [];
  for (const r of rows) {
    const name = r.tg_username || r.tg_user_id;
    kb.push([{ text: "✅ Разбанить " + name, callback_data: "unban_" + r.tg_user_id }]);
  }
  const nav = [];
  if (p > 1) nav.push({ text: "← Назад", callback_data: "banlist_page_" + (p - 1) });
  nav.push({ text: `${p}/${totalPages}`, callback_data: "noop" });
  if (p < totalPages) nav.push({ text: "Вперёд →", callback_data: "banlist_page_" + (p + 1) });
  if (nav.length) kb.push(nav);
  kb.push([{ text: "← В админку", callback_data: "menu_admin" }]);

  await safeEdit(ctx, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: kb },
  });
}

function adminMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📊 Статистика бота", callback_data: "admin_stats" },
        { text: "👥 Пользователи", callback_data: "admin_users" },
      ],
      [
        { text: "📦 Установки", callback_data: "admin_installs" },
        { text: "🚫 Бан-лист", callback_data: "admin_banlist" },
      ],
      [
        { text: "🐛 Багрепорты", callback_data: "admin_bugs" },
        { text: "🗑 Очистка данных", callback_data: "admin_cleanup" },
      ],
      [
        { text: "📋 Логи", callback_data: "admin_logs" },
        { text: "💰 Баланс кошельков", callback_data: "admin_balance" },
      ],
      [{ text: "← Назад", callback_data: "menu_main" }],
    ],
  };
}

// формирование текста главного меню
function mainMenuText(tgId) {
  const user = db.prepare("SELECT duolingo_user_id, duolingo_username FROM users WHERE tg_user_id = ?").get(tgId);
  let text = "🦉 <b>Duolingo Helper</b>\n\n";
  if (user) {
    const uname = user.duolingo_username || user.duolingo_user_id;
    text += `👤 <b>${uname}</b> · <code>${user.duolingo_user_id}</code>\n\n`;
  } else {
    text += "❌ Аккаунт не привязан\n\n";
  }
  text += "Выберите действие:";
  return text;
}

function showMainMenu(ctx) {
  const isAdmin = ctx.from.id === config.adminTgId;
  ctx.reply(mainMenuText(ctx.from.id), {
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboard(isAdmin),
  });
}

// сборка текста статистики (используется в экране статистики и после накрутки XP)
async function buildStatsText(user) {
  const jwt = decryptJWT(user.jwt_encrypted);
  const res = await fetch(
    `https://www.duolingo.com/2017-06-30/users/${user.duolingo_user_id}?fields=totalXp,streak,name,username,streakData`,
    { headers: { accept: "application/json", cookie: `jwt_token=${jwt}` } }
  );
  const d = await res.json();
  const totalXp = d.totalXp ?? 0;
  const streak = d.streak ?? 0;
  const name = d.name || user.duolingo_username || user.duolingo_user_id;

  // XP в лиге (текущий скор в таблице лиги)
  let leagueXp = null;
  try {
    const lr = await fetch(
      "https://duolingo-leaderboards-prod.duolingo.com/leaderboards/7d9f5dd1-8423-491a-91f2-2532052038ce/users/" + user.duolingo_user_id + "?client_unlocked=true&get_reactions=true&_=" + Date.now(),
      { headers: { accept: "application/json", cookie: `jwt_token=${jwt}`, authorization: `Bearer ${jwt}` } }
    );
    const ld = await lr.json();
    const rankings = (ld && ld.active && ld.active.cohort && ld.active.cohort.rankings) || [];
    const myId = String(user.duolingo_user_id);
    const myIdx = rankings.findIndex((r) => String(r.user_id) === myId);
    if (myIdx >= 0) leagueXp = rankings[myIdx].score;
  } catch {}

  // определяем, занимался ли сегодня
  let todayStatus = "⚠️ <i>Ещё нет</i>";
  try {
    const lastExtended = d.streakData?.currentStreak?.lastExtendedDate;
    if (lastExtended) {
      const today = localDateStr();
      if (lastExtended >= today) todayStatus = "✅ <i>Занимался</i>";
    }
  } catch {}

  // дневной/недельный XP — из разницы итогов total_xp (привязаны к реальному итогу Duolingo);
  // SUM(xp) не используется: колонка xp исторически размазана по дням и завышена
  const today = localDateStr();
  const weekStart = localDateStr(new Date(Date.now() - 7 * 86400000));
  const anchor = (before) =>
    db.prepare("SELECT total_xp FROM user_stats WHERE duolingo_user_id = ? AND date < ? AND total_xp IS NOT NULL ORDER BY date DESC LIMIT 1")
      .get(user.duolingo_user_id, before);
  const todayBase = anchor(today);
  const weekBase = anchor(weekStart);
  const dayXp = todayBase ? totalXp - Number(todayBase.total_xp) : null;
  db.prepare(`
    INSERT INTO user_stats (duolingo_user_id, date, xp, streak, total_xp)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(duolingo_user_id, date) DO UPDATE SET
      xp = COALESCE(excluded.xp, user_stats.xp),
      streak = COALESCE(excluded.streak, user_stats.streak),
      total_xp = COALESCE(excluded.total_xp, user_stats.total_xp)
  `).run(user.duolingo_user_id, today, dayXp, streak, totalXp);

  let todayXp = dayXp != null ? dayXp : 0;
  if (dayXp == null) {
    const tRow = db.prepare("SELECT xp FROM user_stats WHERE duolingo_user_id = ? AND date = ?").get(user.duolingo_user_id, today);
    todayXp = Number(tRow && tRow.xp) || 0;
  }
  let weekXp;
  if (weekBase) weekXp = totalXp - Number(weekBase.total_xp);
  else {
    const wRow = db.prepare("SELECT SUM(xp) as total FROM user_stats WHERE duolingo_user_id = ? AND date >= ?").get(user.duolingo_user_id, weekStart);
    weekXp = wRow && wRow.total ? wRow.total : 0;
  }

  // график за 7 дней (значения — разницы total_xp; +1 строка вниз как база)
  const days = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
  const statsRows = db.prepare("SELECT date, xp, total_xp FROM user_stats WHERE duolingo_user_id = ? ORDER BY date DESC LIMIT 8").all(user.duolingo_user_id);
  let chart = "";
  if (statsRows.length > 0) {
    const valOf = (r, nxt) =>
      r.total_xp != null && nxt && nxt.total_xp != null
        ? Number(r.total_xp) - Number(nxt.total_xp)
        : Number(r.xp) || 0;
    const revRows = statsRows
      .slice(0, 7)
      .map((r, i) => ({ date: r.date, xp: valOf(r, statsRows[i + 1]) }))
      .reverse();
    const maxXp = Math.max(1, ...revRows.map((r) => r.xp));
    chart = "\n\n📈 <b>XP за 7 дней:</b>\n<pre>";
    for (const r of revRows) {
      const d = new Date(r.date + "T12:00:00");
      const dayLabel = days[d.getDay()];
      const barLen = Math.max(0, Math.min(12, Math.round((r.xp / maxXp) * 12)));
      const bar = "█".repeat(barLen) + "░".repeat(12 - barLen);
      chart += `${dayLabel} ${bar} ${Number(r.xp).toLocaleString("ru")}\n`;
    }
    chart += "</pre>";
  }

  return (
    `📊 <b>Статистика</b>\n\n` +
    `👤 <b>${name}</b> · <code>${user.duolingo_user_id}</code>\n\n` +
    `⚡ <b>XP:</b> ${Number(totalXp).toLocaleString("ru")}\n` +
    `🏆 <b>XP в лиге:</b> ${leagueXp == null ? "—" : Number(leagueXp).toLocaleString("ru")}\n` +
    `🔥 <b>Streak:</b> ${streak} дней\n` +
    `📅 <b>Сегодня:</b> ${todayStatus}\n` +
    `⚡ <b>Сегодня:</b> ${fmtSigned(todayXp)}\n` +
    `📅 <b>Неделя:</b> ${fmtSigned(weekXp)}` + chart
  );
}

function statsKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🎁 Получить XP", callback_data: "xp_get" }],
      [{ text: "🔥 Серия дней", callback_data: "streak_get" }],
      [{ text: "💝 Донат", callback_data: "donate_menu" }],
      [{ text: "← Назад", callback_data: "menu_main" }],
    ],
  };
}

// накрутка XP через stories (логика из farmXp("stories") скрипта)
const STORY_SLUG = "fr-en-le-passeport";

async function runXpFarm(user, target) {
  const jwt = decryptJWT(user.jwt_encrypted);
  // язык интерфейса — для fromLanguage в теле запроса
  let fromLanguage = "en";
  try {
    const r = await fetch(
      `https://www.duolingo.com/2017-06-30/users/${user.duolingo_user_id}?fields=fromLanguage,learningLanguage`,
      { headers: { accept: "application/json", cookie: `jwt_token=${jwt}` } }
    );
    const u = await r.json();
    fromLanguage = u.fromLanguage || "en";
  } catch {}

  let earned = 0;
  let fails = 0;
  while (earned < target) {
    let got = 0;
    try {
      const res = await fetch(`https://stories.duolingo.com/api2/stories/${STORY_SLUG}/complete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          accept: "application/json",
          authorization: "Bearer " + jwt,
        },
        body: JSON.stringify({
          awardXp: true,
          completedBonusChallenge: true,
          fromLanguage: fromLanguage === "en" ? "fr" : fromLanguage,
          learningLanguage: "en",
          hasXpBoost: true,
          illustrationFormat: "svg",
          isFeaturedStoryInPracticeHub: true,
          isLegendaryMode: true,
          isV2Redo: false,
        }),
      });
      if (res.status === 200) {
        const body = await res.json();
        got = Number((body && (body.awardedXp || body.xpGain)) || 499);
      }
    } catch {}
    if (got > 0) {
      earned += got;
      fails = 0;
    } else {
      fails++;
      if (fails >= 5) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (earned < target) {
      await new Promise((r) => setTimeout(r, 350 + Math.floor(Math.random() * 350)));
    }
  }
  return earned;
}

// накрутка серии дней (логика из runStreakFarm скрипта):
// сессии GLOBAL_PRACTICE с endTime в прошлые дни — серия растёт назад
const CHALLENGE_TYPES = [
  "assist","characterIntro","characterMatch","characterPuzzle","characterSelect",
  "characterTrace","characterWrite","completeReverseTranslation","definition",
  "dialogue","extendedMatch","extendedListenMatch","form","freeResponse","gapFill",
  "judge","listen","listenComplete","listenMatch","match","name","listenComprehension",
  "listenIsolation","listenSpeak","listenTap","orderTapComplete","partialListen",
  "partialReverseTranslate","patternTapComplete","radioBinary","radioImageSelect",
  "radioListenMatch","radioListenRecognize","radioSelect","readComprehension",
  "reverseAssist","sameDifferent","select","selectPronunciation","selectTranscription",
  "svgPuzzle","syllableTap","syllableListenTap","speak","tapCloze","tapClozeTable",
  "tapComplete","tapCompleteTable","tapDescribe","translate","transliterate",
  "transliterationAssist","typeCloze","typeClozeTable","typeComplete","typeCompleteTable",
  "writeComprehension",
];

function tzParts(timeZone, date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out = {};
  dtf.formatToParts(date).forEach((p) => {
    if (p.type !== "literal") out[p.type] = p.value;
  });
  return out;
}

// YYYY-MM-DD в часовом поясе tz
function dateStrInTz(tz, date) {
  const p = tzParts(tz, date);
  return `${p.year}-${p.month}-${p.day}`;
}

// день недели даты YYYY-MM-DD (0 = вс … 6 = сб)
function weekdayOfDateStr(dateStr) {
  return new Date(dateStr + "T12:00:00").getDay();
}

// понедельник недели, содержащей dateStr (YYYY-MM-DD)
function mondayStrOf(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// «22–28 окт» / «28 сен – 4 окт»
function fmtRange(startStr, endStr) {
  const months = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const a = new Date(startStr + "T12:00:00");
  const b = new Date(endStr + "T12:00:00");
  const am = months[a.getMonth()];
  const bm = months[b.getMonth()];
  return am === bm
    ? `${a.getDate()}–${b.getDate()} ${bm}`
    : `${a.getDate()} ${am} – ${b.getDate()} ${bm}`;
}

function wallClockToSeconds(timeZone, year, month, day, hour, minute, second) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const parts = tzParts(timeZone, new Date(guess));
  const localAsUtc = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour,
    +parts.minute,
    +parts.second,
  );
  return Math.floor((guess - (localAsUtc - guess)) / 1000);
}

async function sessionRequest(jwt, method, url, payload) {
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        accept: "application/json",
        authorization: "Bearer " + jwt,
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    let body = null;
    try { body = await res.json(); } catch {}
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

async function runStreakFarm(user, target, onProgress) {
  const jwt = decryptJWT(user.jwt_encrypted);
  const u = await (await fetch(
    `https://www.duolingo.com/2017-06-30/users/${user.duolingo_user_id}?fields=timezone,streakData,fromLanguage,learningLanguage`,
    { headers: { accept: "application/json", cookie: `jwt_token=${jwt}` } }
  )).json();
  const tz = u.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const startDate = u.streakData && u.streakData.currentStreak ? u.streakData.currentStreak.startDate : null;
  const fromLanguage = u.fromLanguage || "en";
  const learningLanguage = u.learningLanguage || "en";

  let base;
  if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    const [y, m, d] = startDate.split("-").map(Number);
    base = { year: y, month: m, day: d };
  } else {
    const p = tzParts(tz, new Date());
    base = { year: +p.year, month: +p.month, day: +p.day };
  }

  let saved = 0;
  let fails = 0;
  for (let i = 0; i < target; i++) {
    const sr = await sessionRequest(jwt, "POST", "https://www.duolingo.com/2017-06-30/sessions", {
      challengeTypes: CHALLENGE_TYPES,
      fromLanguage,
      isFinalLevel: false,
      isV2: true,
      juicy: true,
      learningLanguage,
      smartTipsVersion: 2,
      type: "GLOBAL_PRACTICE",
    });
    if (sr.status !== 200 || !sr.body || !sr.body.id) {
      fails++;
      if (onProgress) onProgress(i, saved, true);
      if (fails >= 5) break;
      await new Promise((r) => setTimeout(r, 2500));
      continue;
    }
    const endSecs = wallClockToSeconds(tz, base.year, base.month, base.day - 1 - i, 12, 0, 0);
    const pr = await sessionRequest(jwt, "PUT", `https://www.duolingo.com/2017-06-30/sessions/${sr.body.id}`, {
      ...sr.body,
      heartsLeft: 5,
      startTime: endSecs - 1,
      endTime: endSecs,
      enableBonusPoints: false,
      failed: false,
      maxInLessonStreak: 9,
      shouldLearnThings: true,
    });
    if (pr.status === 200) {
      saved++;
      fails = 0;
    } else {
      fails++;
      if (fails >= 5) break;
    }
    if (onProgress) onProgress(i, saved, false);
    await new Promise((r) => setTimeout(r, 400 + Math.floor(Math.random() * 400)));
  }
  return saved;
}

// === ДРУЗЬЯ: API (логика из скрипта) ===
const FRIENDS_API = "https://www.duolingo.com/2017-06-30/friends";

async function fetchUserList(jwt, userId, kind) {
  const users = [];
  let cursor = null;
  for (let page = 0; page < 30; page++) {
    let url = `${FRIENDS_API}/users/${userId}/${kind}?viewerId=${userId}&limit=100`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    const res = await fetch(url, {
      headers: { accept: "application/json", cookie: `jwt_token=${jwt}` },
    }).catch(() => null);
    if (!res || !res.ok) break;
    const data = await res.json().catch(() => ({}));
    const bucket = data[kind] || data;
    const pageUsers = bucket.users || bucket || [];
    if (Array.isArray(pageUsers)) users.push(...pageUsers);
    cursor = bucket.nextCursor || bucket.cursor || data.nextCursor || data.cursor || null;
    const hasMore = bucket.hasMore ?? data.hasMore ?? (cursor !== null && pageUsers.length > 0);
    if (!hasMore || !cursor || pageUsers.length === 0) break;
  }
  return users.map((u) => ({
    userId: String(u.userId ?? u.id ?? ""),
    username: u.username || "",
    name: u.displayName || u.name || u.username || "",
  }));
}

async function unfollowUser(jwt, myId, targetId) {
  try {
    const res = await fetch(`${FRIENDS_API}/users/${myId}/follow/${targetId}`, {
      method: "DELETE",
      headers: { accept: "application/json", authorization: "Bearer " + jwt },
    });
    return res.status === 200 || res.status === 201 || res.status === 204;
  } catch { return false; }
}

async function blockUser(jwt, myId, targetId) {
  try {
    const res = await fetch(`${FRIENDS_API}/users/${myId}/block/${targetId}`, {
      method: "POST",
      headers: { accept: "application/json", authorization: "Bearer " + jwt },
    });
    return res.status === 200 || res.status === 201;
  } catch { return false; }
}

function getExclusions(user) {
  try {
    return new Set(JSON.parse(user.exclude_list || "[]").map(String));
  } catch { return new Set(); }
}

// запись в action_log → уйдёт в историю скрипта (undo там)
function logBotAction(duoId, type, ids, name) {
  try {
    db.prepare("INSERT INTO action_log (duolingo_user_id, type, ids, name, ts) VALUES (?, ?, ?, ?, ?)")
      .run(String(duoId), type, JSON.stringify(ids.map(String)), name, Date.now());
  } catch {}
}

function loadFriendScan(duoId) {
  const row = db.prepare("SELECT data FROM friend_scan WHERE duolingo_user_id = ?").get(String(duoId));
  if (!row) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}

// скан активности (логика из scanFriendsActivity скрипта)
async function runFriendsScan(user, targets, daysLimit, onProgress, shouldStop) {
  const jwt = decryptJWT(user.jwt_encrypted);
  const results = [];
  for (let i = 0; i < targets.length; i++) {
    if (shouldStop && shouldStop()) break;
    const r = targets[i];
    let inactive = false;
    let inactiveDays = 999;
    try {
      const res = await fetch(
        `https://www.duolingo.com/2017-06-30/users/${r.userId}?fields=totalXp,streak,streakData`,
        { headers: { accept: "application/json", cookie: `jwt_token=${jwt}` } }
      );
      const data = await res.json();
      const streakData = data && data.streakData;
      const cur = streakData && streakData.currentStreak;
      let activityTs = NaN;
      if (cur) {
        const lastExt = cur.lastExtendedDate ? Date.parse(cur.lastExtendedDate) : NaN;
        const start = cur.startDate ? Date.parse(cur.startDate) : NaN;
        activityTs = Number.isFinite(lastExt) ? lastExt : start;
      }
      if (!Number.isFinite(activityTs) && streakData && streakData.previousStreak && streakData.previousStreak.endDate) {
        activityTs = Date.parse(streakData.previousStreak.endDate);
      }
      if (Number.isFinite(activityTs)) {
        inactiveDays = Math.floor((Date.now() - activityTs) / 86400000);
        inactive = inactiveDays >= daysLimit;
      } else {
        inactive = !cur || !cur.startDate;
        inactiveDays = inactive ? 999 : 0;
      }
    } catch {}
    results.push({ userId: r.userId, name: r.name, iFollow: !!r.iFollow, inactive, inactiveDays });
    if (onProgress) onProgress(i + 1, targets.length);
    await new Promise((rr) => setTimeout(rr, 300 + Math.floor(Math.random() * 250)));
  }
  return results;
}

// запуск скана: правит сообщение (chatId, messageId), порог — параметр (только этот скан)
async function startFriendsScan(user, daysLimit, chatId, messageId, tgId) {
  const edit = (text, replyMarkup) =>
    bot.api.editMessageText(chatId, messageId, text, { parse_mode: "HTML", reply_markup: replyMarkup }).catch(() => {});
  const cache = friendsCache.get(tgId);
  // подписки ∪ подписчики (как фильтр «Неактивные» в скрипте)
  const byId = new Map();
  for (const u of (cache ? cache.following : [])) byId.set(String(u.userId), { userId: String(u.userId), name: u.name, iFollow: true });
  for (const f of (cache ? cache.followers : [])) {
    const id = String(f.userId);
    if (!byId.has(id)) byId.set(id, { userId: id, name: f.name, iFollow: false });
  }
  const targets = [...byId.values()];
  if (!targets.length) {
    await edit("🔍 <b>Активность</b>\n\nСначала откройте список друзей.", {
      inline_keyboard: [[{ text: "← Назад", callback_data: "action_friends" }]],
    });
    return;
  }
  if (friendsRunning.has(tgId)) {
    await edit("🔍 <b>Активность</b>\n\n⏳ Уже выполняется.", {
      inline_keyboard: [[{ text: "← Назад", callback_data: "action_friends" }]],
    });
    return;
  }
  friendsRunning.add(tgId);
  friendsScanStop.delete(tgId);
  const stopKb = { inline_keyboard: [[{ text: "⏹ Стоп", callback_data: "friends_scan_stop" }]] };
  await edit(`🔍 <b>Активность</b>\n\nПроверка 0/${targets.length}…`, stopKb);
  let lastEdit = 0;
  try {
    const items = await runFriendsScan(user, targets, daysLimit, (done, total) => {
      const now = Date.now();
      if (now - lastEdit < 2000) return;
      lastEdit = now;
      edit(`🔍 <b>Активность</b>\n\nПроверка ${done}/${total}…`, stopKb);
    }, () => friendsScanStop.has(tgId));
    const stopped = friendsScanStop.has(tgId);
    try {
      db.prepare(`
        INSERT INTO friend_scan (duolingo_user_id, data, scanned_at)
        VALUES (?, ?, ?)
        ON CONFLICT(duolingo_user_id) DO UPDATE SET data = excluded.data, scanned_at = excluded.scanned_at
      `).run(String(user.duolingo_user_id), JSON.stringify({ items, daysLimit }), Date.now());
    } catch {}
    const inactive = items.filter((r) => r.inactive);
    await edit(
      `🔍 <b>Активность</b>\n\n` +
      (stopped
        ? `⏹ Остановлено: проверено <b>${items.length}</b> из ${targets.length}\n`
        : `Проверено: <b>${items.length}</b>\n`) +
      `Неактивны: <b>${inactive.length}</b> (порог ${daysLimit} дн.)`,
      {
        inline_keyboard: [
          [{ text: "🚫 Отписаться от неактивных", callback_data: "friends_unf_inactive" }],
          [{ text: "🚫 Заблокировать неактивных", callback_data: "friends_block_inactive" }],
          [{ text: "← Назад", callback_data: "action_friends" }],
        ],
      }
    );
  } catch {
    await edit("🔍 <b>Активность</b>\n\n❌ Ошибка скана.", {
      inline_keyboard: [[{ text: "← Назад", callback_data: "action_friends" }]],
    });
  } finally {
    friendsRunning.delete(tgId);
    friendsScanStop.delete(tgId);
  }
}

// === УВЕДОМЛЕНИЯ: настройки ===
const NOTIFY_COLS = { practice: "remind_practice", league: "league_overtake", updates: "script_updates", follows: "follow_changes", digest: "digest" };

function getNotifyPrefs(tgId) {
  const row = db.prepare("SELECT * FROM notify_prefs WHERE tg_user_id = ?").get(tgId);
  return {
    remind_practice: row ? Number(row.remind_practice) : 1,
    league_overtake: row ? Number(row.league_overtake) : 1,
    script_updates: row ? Number(row.script_updates) : 1,
    follow_changes: row ? Number(row.follow_changes) : 1,
    digest: row ? Number(row.digest) : 1,
    last_reminder_date: row ? row.last_reminder_date : null,
    last_digest_date: row ? row.last_digest_date : null,
  };
}

function upsertNotifyPrefs(tgId, p) {
  db.prepare(`
    INSERT INTO notify_prefs (tg_user_id, remind_practice, league_overtake, script_updates, follow_changes, digest, last_reminder_date, last_digest_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tg_user_id) DO UPDATE SET
      remind_practice = excluded.remind_practice,
      league_overtake = excluded.league_overtake,
      script_updates = excluded.script_updates,
      follow_changes = excluded.follow_changes,
      digest = excluded.digest,
      last_reminder_date = excluded.last_reminder_date,
      last_digest_date = excluded.last_digest_date
  `).run(tgId, p.remind_practice, p.league_overtake, p.script_updates, p.follow_changes, p.digest, p.last_reminder_date ?? null, p.last_digest_date ?? null);
}

function toggleNotify(tgId, key) {
  const col = NOTIFY_COLS[key];
  if (!col) return;
  const p = getNotifyPrefs(tgId);
  p[col] = p[col] ? 0 : 1;
  upsertNotifyPrefs(tgId, p);
}

function markReminder(tgId, date) {
  const p = getNotifyPrefs(tgId);
  p.last_reminder_date = date;
  upsertNotifyPrefs(tgId, p);
}

function notifyKeyboard(prefs) {
  const flag = (v) => (v ? "✅" : "🔕");
  return {
    inline_keyboard: [
      [{ text: `🔥 Пора позаниматься: ${flag(prefs.remind_practice)}`, callback_data: "notify_toggle_practice" }],
      [{ text: `🏆 Обход в лиге: ${flag(prefs.league_overtake)}`, callback_data: "notify_toggle_league" }],
      [{ text: `👥 Кто подписался / отписался: ${flag(prefs.follow_changes)}`, callback_data: "notify_toggle_follows" }],
      [{ text: `📬 Дайджест: ${flag(prefs.digest)}`, callback_data: "notify_toggle_digest" }],
      [{ text: `🚀 Обновления скрипта: ${flag(prefs.script_updates)}`, callback_data: "notify_toggle_updates" }],
      [{ text: "← Назад", callback_data: "menu_settings" }],
    ],
  };
}

function fmtSigned(n) {
  const v = Math.round(Number(n) || 0);
  return (v < 0 ? "−" : "+") + Math.abs(v).toLocaleString("ru");
}

function cmpVersion(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// sub (числовой id) из JWT — для проверки, что запрос от владельца аккаунта
function jwtSub(jwt) {
  try {
    const b64 = String(jwt).split(".")[1] || "";
    const norm = b64.replace(/-/g, "+").replace(/_/g, "/");
    const p = JSON.parse(Buffer.from(norm, "base64").toString("utf8"));
    return p && p.sub != null ? String(p.sub) : null;
  } catch {
    return null;
  }
}

// полная очистка данных пользователя при отвязке
function wipeUserData(tgId, duoId) {
  try {
    if (duoId) {
      const id = String(duoId);
      db.prepare("DELETE FROM backups WHERE duolingo_user_id = ?").run(id);
      db.prepare("DELETE FROM user_stats WHERE duolingo_user_id = ?").run(id);
      db.prepare("DELETE FROM action_log WHERE duolingo_user_id = ?").run(id);
      db.prepare("DELETE FROM friend_scan WHERE duolingo_user_id = ?").run(id);
      db.prepare("DELETE FROM league_snapshot WHERE duolingo_user_id = ?").run(id);
      db.prepare("DELETE FROM friends_snapshot WHERE duolingo_user_id = ?").run(id);
      db.prepare("DELETE FROM pending_changes WHERE duolingo_user_id = ?").run(id);
      db.prepare("DELETE FROM xp_farm_log WHERE duolingo_user_id = ?").run(id);
      db.prepare("DELETE FROM link_codes WHERE duolingo_user_id = ?").run(id);
      db.prepare("DELETE FROM script_installs WHERE duolingo_user_id = ?").run(id);
      db.prepare("DELETE FROM users WHERE duolingo_user_id = ?").run(id);
    }
    if (tgId) {
      db.prepare("DELETE FROM users WHERE tg_user_id = ?").run(tgId);
      db.prepare("DELETE FROM notify_prefs WHERE tg_user_id = ?").run(tgId);
    }
  } catch {}
}

// === ДОНАТЫ: кошельки и балансы (логика из yaroytdownload) ===
const USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

// TRON base58check-адрес → hex-параметр для balanceOf(address)
function tronAddressToParam(addr) {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of String(addr)) {
    const i = A.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const hex = n.toString(16).padStart(50, "0"); // 25 байт: 41 + адрес + checksum
  return hex.slice(2, 42).padStart(64, "0");
}

async function getKaspaBalance(address) {
  const res = await fetch(`${config.kaspaApiUrl}/addresses/${address}/balance`);
  const d = await res.json();
  const b = parseInt(d.balance, 10);
  return Number.isFinite(b) ? b / 100000000 : null;
}

async function getTonBalance(address) {
  const res = await fetch(`${config.tonApiUrl}/getAddressBalance?address=${encodeURIComponent(address)}`);
  const d = await res.json();
  const b = parseInt(d.result, 10);
  return Number.isFinite(b) ? b / 1000000000 : null;
}

async function getUsdtBalance(address) {
  const param = tronAddressToParam(address);
  if (!param) return null;
  const headers = { "Content-Type": "application/json" };
  if (config.tronApiKey) headers["TRON-PRO-API-KEY"] = config.tronApiKey;
  const res = await fetch(`${config.tronApiUrl}/wallet/triggerconstantcontract`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      // visible: true — адреса в base58, иначе TronGrid читает их как hex и падает с TRC-20 error
      visible: true,
      owner_address: address,
      contract_address: USDT_TRC20_CONTRACT,
      function_selector: "balanceOf(address)",
      parameter: param,
    }),
  });
  const d = await res.json();
  const hex = d && d.constant_result && d.constant_result[0];
  if (!hex) return null;
  return parseInt(hex, 16) / 1000000;
}

async function getAllBalances() {
  const balances = {};
  if (config.kaspaAddress) balances.kaspa = await getKaspaBalance(config.kaspaAddress).catch(() => null);
  if (config.tonAddress) balances.ton = await getTonBalance(config.tonAddress).catch(() => null);
  if (config.usdtAddress) balances.usdt = await getUsdtBalance(config.usdtAddress).catch(() => null);
  return balances;
}

function fmtBalance(balance, currency) {
  if (balance == null) return `❌ Ошибка получения ${currency}`;
  if (balance === 0) return `0.00 ${currency}`;
  return balance.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 6 }) + ` ${currency}`;
}

function buildBalanceMessage(balances) {
  let msg = "💰 <b>Баланс кошельков:</b>\n\n";
  if (config.kaspaAddress) msg += `💎 <b>Kaspa:</b> ${fmtBalance(balances.kaspa, "KAS")}\n`;
  if (config.tonAddress) msg += `💠 <b>TON:</b> ${fmtBalance(balances.ton, "TON")}\n`;
  if (config.usdtAddress) msg += `💵 <b>USDT:</b> ${fmtBalance(balances.usdt, "USDT")}\n`;
  if (!config.kaspaAddress && !config.tonAddress && !config.usdtAddress) msg += "ℹ️ Кошельки не настроены";
  return msg;
}

function donateMenuText() {
  return (
    "💝 <b>Поддержать проект</b>\n\n" +
    "Если вам нравится Duolingo Helper и вы хотите поддержать его развитие — вы можете сделать донат.\n\n" +
    "Ваша поддержка помогает:\n" +
    "• Развивать новые функции\n" +
    "• Поддерживать стабильную работу\n" +
    "• Оплачивать серверы бота\n\n" +
    "Выберите удобный способ доната:"
  );
}

function donateMenuKeyboard() {
  const rows = [];
  if (config.donationAlertsUrl) rows.push([{ text: "🎁 DonationAlerts", url: config.donationAlertsUrl }]);
  rows.push([{ text: "🌐 Все способы", url: "https://vidrimers.site/donate" }]);
  const crypto = [];
  if (config.kaspaAddress) crypto.push({ text: "💎 Kaspa", callback_data: "donate_kaspa" });
  if (config.tonAddress) crypto.push({ text: "💠 TON", callback_data: "donate_ton" });
  if (config.usdtAddress) crypto.push({ text: "💵 USDT (TRC-20)", callback_data: "donate_usdt" });
  for (let i = 0; i < crypto.length; i += 2) rows.push(crypto.slice(i, i + 2));
  rows.push([{ text: "← Назад", callback_data: "menu_main" }]);
  return { inline_keyboard: rows };
}

function donateAddressView(kind) {
  const map = {
    kaspa: {
      icon: "💎", label: "Kaspa",
      title: "💎 <b>Kaspa (KAS)</b>",
      addr: config.kaspaAddress,
      info: "ℹ️ Kaspa — быстрая и масштабируемая криптовалюта с мгновенными транзакциями",
    },
    ton: {
      icon: "💠", label: "TON",
      title: "💠 <b>TON (Toncoin)</b>",
      addr: config.tonAddress,
      info: "ℹ️ TON — блокчейн от создателей Telegram с низкими комиссиями",
    },
    usdt: {
      icon: "💵", label: "USDT",
      title: "💵 <b>USDT (TRC-20)</b>",
      addr: config.usdtAddress,
      info: "⚠️ <b>Важно:</b> используйте только сеть TRON (TRC-20)!\nОтправка через другие сети приведёт к потере средств.",
    },
  };
  const m = map[kind];
  if (!m || !m.addr) {
    return {
      text: `❌ ${m ? m.label : "Кошелёк"} адрес не настроен`,
      kb: { inline_keyboard: [[{ text: "← Назад", callback_data: "donate_menu" }]] },
    };
  }
  return {
    text:
      `${m.title}\n\n` +
      `Адрес кошелька:\n<code>${m.addr}</code>\n\n` +
      `📋 Нажмите на адрес, чтобы скопировать\n\n` +
      m.info,
    kb: { inline_keyboard: [[{ text: "← Назад к донатам", callback_data: "donate_menu" }]] },
  };
}

// обработка инлайн-кнопок
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const isAdmin = ctx.from.id === config.adminTgId;

  // навигация по меню
  if (data === "menu_main") {
    await ctx.editMessageText(mainMenuText(ctx.from.id), {
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboard(isAdmin),
    });
    return;
  }
  if (data === "menu_settings") {
    await ctx.editMessageText("⚙️ Настройки\n\nВыберите раздел:", {
      reply_markup: settingsMenuKeyboard(),
    });
    return;
  }
  if (data === "menu_admin") {
    if (!isAdmin) {
      await ctx.answerCallbackQuery("⛔ Нет доступа");
      return;
    }
    await ctx.editMessageText("🔧 Админ-панель\n\nВыберите раздел:", {
      reply_markup: adminMenuKeyboard(),
    });
    return;
  }

  // реальная статистика
  if (data === "action_stats") {
    await ctx.answerCallbackQuery();
    const user = db.prepare("SELECT * FROM users WHERE tg_user_id = ?").get(ctx.from.id);
    if (!user || !user.jwt_encrypted) {
      await ctx.editMessageText("📊 Статистика\n\n❌ Аккаунт не привязан или JWT отсутствует.", {
        reply_markup: { inline_keyboard: [[{ text: "← Назад", callback_data: "menu_main" }]] },
      });
      return;
    }
    await ctx.editMessageText("📊 <b>Статистика</b>\n\n⏳ Загрузка…", {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "← Назад", callback_data: "menu_main" }]] },
    });
    try {
      const msg = await buildStatsText(user);
      await ctx.editMessageText(msg, {
        parse_mode: "HTML",
        reply_markup: statsKeyboard(),
      });
    } catch (e) {
      await ctx.editMessageText("📊 <b>Статистика</b>\n\n❌ Ошибка загрузки данных.", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "← Назад", callback_data: "menu_main" }]] },
      });
    }
    return;
  }

  // === ЛИГА ===
  if (data === "action_league" || data === "league_refresh") {
    await ctx.answerCallbackQuery();
    const user = db.prepare("SELECT * FROM users WHERE tg_user_id = ?").get(ctx.from.id);
    if (!user || !user.jwt_encrypted) {
      await ctx.editMessageText("🏆 Лига\n\n❌ Аккаунт не привязан.", {
        reply_markup: { inline_keyboard: [[{ text: "← Назад", callback_data: "menu_main" }]] },
      });
      return;
    }
    await ctx.editMessageText("🏆 <b>Лига</b>\n\n⏳ Загрузка…", {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "← Назад", callback_data: "menu_main" }]] },
    });
    try {
      const jwt = decryptJWT(user.jwt_encrypted);
      const res = await fetch(
        "https://duolingo-leaderboards-prod.duolingo.com/leaderboards/7d9f5dd1-8423-491a-91f2-2532052038ce/users/" + user.duolingo_user_id + "?client_unlocked=true&get_reactions=true&_=" + Date.now(),
        { headers: { accept: "application/json", cookie: `jwt_token=${jwt}`, authorization: `Bearer ${jwt}` } }
      );
      const d = await res.json();
      console.log("[league] API status=" + res.status + " keys=" + Object.keys(d || {}).join(",") + " rankings=" + ((d && d.active && d.active.cohort && d.active.cohort.rankings) ? d.active.cohort.rankings.length : 0));
      const rankings = (d && d.active && d.active.cohort && d.active.cohort.rankings) || [];
      const myId = String(user.duolingo_user_id);
      const myIdx = rankings.findIndex((r) => String(r.user_id) === myId);
      const myScore = myIdx >= 0 ? rankings[myIdx].score : 0;

      const medals = ["🥇", "🥈", "🥉"];
      let table = "🏆 <b>Лига</b>\n\n";
      for (let i = 0; i < Math.min(rankings.length, 15); i++) {
        const r = rankings[i];
        const isMe = String(r.user_id) === myId;
        const gap = r.score - myScore;
        const medal = medals[i] || (i + 1) + ".";
        const dot = isMe ? "●" : gap > 0 ? "🟢" : gap < 0 ? "🔴" : "●";
        const gapStr = isMe
          ? "← ты"
          : gap > 0
            ? "+" + Number(gap).toLocaleString("ru")
            : gap < 0
              ? "−" + Number(Math.abs(gap)).toLocaleString("ru")
              : "0";
        table += `${medal} <b>${r.display_name || r.user_id}</b>\n`;
        table += `${dot} <code>${Number(r.score).toLocaleString("ru")}</code>  ${gapStr}\n\n`;
      }
      table += `Твоё место: <b>${myIdx >= 0 ? myIdx + 1 : "—"}</b>`;

      await ctx.editMessageText(table, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🎯 Фарм до места", callback_data: "farm_menu" }],
            [{ text: "🔄 Обновить", callback_data: "league_refresh" }, { text: "← Назад", callback_data: "menu_main" }],
          ],
        },
      });
    } catch (e) {
      await ctx.editMessageText("🏆 <b>Лига</b>\n\n❌ Ошибка загрузки.", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "← Назад", callback_data: "menu_main" }]] },
      });
    }
    return;
  }

  // меню выбора места для фарма
  if (data === "farm_menu") {
    await ctx.answerCallbackQuery();
    const user = db.prepare("SELECT * FROM users WHERE tg_user_id = ?").get(ctx.from.id);
    if (!user || !user.jwt_encrypted) return;
    try {
      const jwt = decryptJWT(user.jwt_encrypted);
      const res = await fetch(
        "https://duolingo-leaderboards-prod.duolingo.com/leaderboards/7d9f5dd1-8423-491a-91f2-2532052038ce/users/" + user.duolingo_user_id + "?client_unlocked=true&get_reactions=true&_=" + Date.now(),
        { headers: { accept: "application/json", cookie: `jwt_token=${jwt}`, authorization: `Bearer ${jwt}` } }
      );
      const d = await res.json();
      const rankings = (d && d.active && d.active.cohort && d.active.cohort.rankings) || [];
      const myId = String(user.duolingo_user_id);
      const myIdx = rankings.findIndex((r) => String(r.user_id) === myId);
      const myRank = myIdx >= 0 ? myIdx + 1 : 0;

      // кнопки только мест выше текущего
      const medals = ["🥇", "🥈", "🥉"];
      const rows = [];
      const btns = [];
      for (let i = 1; i < myRank; i++) {
        const label = i <= 3 ? medals[i - 1] + " " + i : String(i);
        btns.push({ text: label, callback_data: "farm_target_" + i });
        if (btns.length === 5) { rows.push(btns.splice(0)); }
      }
      if (btns.length) rows.push(btns);
      rows.push([{ text: "← Назад", callback_data: "action_league" }]);

      await ctx.editMessageText(
        `🎯 <b>Фарм до места</b>\n\n` +
        `Эта функция поможет тебе подняться в лиге — бот будет накручивать XP, пока не достигнешь выбранного места.\n\n` +
        `Твоё место: <b>${myRank}</b>\nВыберите целевое место:`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: rows } }
      );
    } catch {
      await ctx.answerCallbackQuery("❌ Ошибка");
    }
    return;
  }

  // фарм до места
  if (data.startsWith("farm_target_")) {
    const targetRank = parseInt(data.replace("farm_target_", ""), 10);
    await ctx.answerCallbackQuery();
    const user = db.prepare("SELECT * FROM users WHERE tg_user_id = ?").get(ctx.from.id);
    if (!user || !user.jwt_encrypted) return;
    const jwt = decryptJWT(user.jwt_encrypted);
    const myId = String(user.duolingo_user_id);

    await ctx.editMessageText(`🎯 <b>Фарм до места ${targetRank}</b>\n\n⏳ Начинаю…`, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
    });

    const LEADERBOARD = "https://duolingo-leaderboards-prod.duolingo.com/leaderboards/7d9f5dd1-8423-491a-91f2-2532052038ce";
    const headers = { accept: "application/json", cookie: `jwt_token=${jwt}`, authorization: `Bearer ${jwt}` };

    async function getRankings() {
      const res = await fetch(`${LEADERBOARD}/users/${myId}?client_unlocked=true&get_reactions=true&_=${Date.now()}`, { headers });
      const d = await res.json();
      return (d && d.active && d.active.cohort && d.active.cohort.rankings) || [];
    }

    async function addXp(amount) {
      // XP через stories (полный формат из скрипта)
      const res = await fetch("https://stories.duolingo.com/api2/stories/fr-en-le-passeport/complete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          accept: "application/json",
          authorization: "Bearer " + (jwt || ""),
          cookie: `jwt_token=${jwt}`,
        },
        body: JSON.stringify({
          awardXp: true,
          completedBonusChallenge: true,
          fromLanguage: "fr",
          learningLanguage: "en",
          hasXpBoost: true,
          illustrationFormat: "svg",
          isFeaturedStoryInPracticeHub: true,
          isLegendaryMode: true,
          isV2Redo: false,
        }),
      });
      return res.ok;
    }

    let iterations = 0;
    const maxIterations = 200; // страховка
    while (iterations < maxIterations) {
      iterations++;
      const rankings = await getRankings();
      const myIdx = rankings.findIndex((r) => String(r.user_id) === myId);
      const myRank = myIdx >= 0 ? myIdx + 1 : 0;

      if (myRank > 0 && myRank <= targetRank) {
        // цель достигнута
        const medals = ["🥇", "🥈", "🥉"];
        let table = `✅ <b>Цель достигнута!</b> Место: <b>${myRank}</b>\n\n🏆 <b>Лига</b>\n\n`;
        for (let i = 0; i < Math.min(rankings.length, 15); i++) {
          const r = rankings[i];
          const isMe = String(r.user_id) === myId;
          const gap = r.score - (myIdx >= 0 ? rankings[myIdx].score : 0);
          const medal = medals[i] || (i + 1) + ".";
          const dot = isMe ? "●" : gap > 0 ? "🟢" : gap < 0 ? "🔴" : "●";
          const gapStr = isMe
            ? "← ты"
            : gap > 0
              ? "+" + Number(gap).toLocaleString("ru")
              : gap < 0
                ? "−" + Number(Math.abs(gap)).toLocaleString("ru")
                : "0";
          table += `${medal} <b>${r.display_name || r.user_id}</b>\n`;
          table += `${dot} <code>${Number(r.score).toLocaleString("ru")}</code>  ${gapStr}\n\n`;
        }
        await ctx.editMessageText(table, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "← Назад", callback_data: "action_league" }]] },
        });
        return;
      }

      // добавляем XP
      await addXp(50);
      await new Promise((r) => setTimeout(r, 1500));

      // обновляем прогресс
      const newRankings = await getRankings();
      const newIdx = newRankings.findIndex((r) => String(r.user_id) === myId);
      const newRank = newIdx >= 0 ? newIdx + 1 : 0;
      const myNewScore = newIdx >= 0 ? newRankings[newIdx].score : 0;

      await ctx.editMessageText(
        `🎯 <b>Фарм до места ${targetRank}</b>\n\n` +
        `⚡ +50 XP · место: <b>${newRank}</b>\n` +
        `📊 Текущий XP: <b>${Number(myNewScore).toLocaleString("ru")}</b>\n` +
        `⏱ Цикл: ${iterations}`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } }
      ).catch(() => {});
    }

    await ctx.editMessageText("🎯 <b>Фарм</b>\n\n⚠️ Достигнут лимит итераций.", {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "← Назад", callback_data: "action_league" }]] },
    });
    return;
  }

  // === БАН ===
  if (data.startsWith("ban_user_")) {
    if (ctx.from.id !== config.adminTgId) { await ctx.answerCallbackQuery("⛔ Нет доступа"); return; }
    const targetTgId = parseInt(data.replace("ban_user_", ""), 10);
    if (isNaN(targetTgId)) { await ctx.answerCallbackQuery("❌ Неверный ID"); return; }
    if (targetTgId === config.adminTgId) {
      await ctx.answerCallbackQuery("⛔ Нельзя забанить самого себя");
      return;
    }
    const targetUser = db.prepare("SELECT * FROM users WHERE tg_user_id = ?").get(targetTgId);
    if (targetUser) {
      db.prepare(`INSERT OR IGNORE INTO banned_users (tg_user_id, tg_username, duolingo_user_id, duolingo_username, reason)
        VALUES (?, ?, ?, ?, ?)`).run(
        targetTgId, targetUser.tg_username || "", targetUser.duolingo_user_id || "", targetUser.duolingo_username || "", ""
      );
    } else {
      db.prepare(`INSERT OR IGNORE INTO banned_users (tg_user_id) VALUES (?)`).run(targetTgId);
    }
    await ctx.editMessageReplyMarkup({
      inline_keyboard: [[{ text: "🚫 Забанен", callback_data: "noop" }]],
    }).catch(() => {});
    await ctx.answerCallbackQuery("🚫 Пользователь забанен");
    return;
  }

  if (data.startsWith("unban_")) {
    if (ctx.from.id !== config.adminTgId) { await ctx.answerCallbackQuery("⛔ Нет доступа"); return; }
    const targetTgId = parseInt(data.replace("unban_", ""), 10);
    db.prepare("DELETE FROM banned_users WHERE tg_user_id = ?").run(targetTgId);
    await ctx.answerCallbackQuery("✅ Разбанен");
    // обновляем бан-лист
    const page = 1;
    await renderBanList(ctx, page);
    return;
  }

  // бан-лист
  if (data === "admin_banlist" || data.startsWith("banlist_page_")) {
    if (ctx.from.id !== config.adminTgId) { await ctx.answerCallbackQuery("⛔ Нет доступа"); return; }
    const page = data.startsWith("banlist_page_") ? parseInt(data.replace("banlist_page_", ""), 10) : 1;
    await renderBanList(ctx, page);
    return;
  }

  // === АДМИН: СТАТИСТИКА ===
  if (data === "admin_stats") {
    if (ctx.from.id !== config.adminTgId) { await ctx.answerCallbackQuery("⛔ Нет доступа"); return; }
    const userCount = db.prepare("SELECT COUNT(*) as n FROM users").get().n;
    const backupCount = db.prepare("SELECT COUNT(*) as n FROM backups").get().n;
    const codeCount = db.prepare("SELECT COUNT(*) as n FROM link_codes WHERE used = 0 AND expires_at > ?").get(Date.now()).n;
    const installCount = db.prepare("SELECT COUNT(*) as n FROM script_installs").get().n;
    const banCount = db.prepare("SELECT COUNT(*) as n FROM banned_users").get().n;
    // версии скрипта: сколько человек на каждой (по последнему sync-stats)
    const verRows = db.prepare("SELECT version, COUNT(*) as n FROM script_installs GROUP BY version").all();
    let verLine = "";
    if (verRows.length) {
      const known = verRows.filter((r) => r.version).sort((a, b) => cmpVersion(b.version, a.version));
      const unknown = verRows.find((r) => !r.version);
      const parts = known.map((r) => `${r.version} — ${r.n}`);
      if (unknown) parts.push(`без версии — ${unknown.n}`);
      verLine = `\n   📈 ${parts.join(" · ")}`;
    }
    await ctx.editMessageText(
      `📊 <b>Статистика бота</b>\n\n` +
      `🔗 Привязок Telegram: <b>${userCount}</b>\n` +
      `📦 Установок скрипта: <b>${installCount}</b>${verLine}\n` +
      `💾 Бэкапов: <b>${backupCount}</b>\n` +
      `🔑 Активных кодов: <b>${codeCount}</b>\n` +
      `🚫 Забанено: <b>${banCount}</b>`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "← Назад", callback_data: "menu_admin" }]] },
      }
    );
    return;
  }

  // === АДМИН: ПОЛЬЗОВАТЕЛИ ===
  if (data === "admin_users" || data.startsWith("users_page_")) {
    if (ctx.from.id !== config.adminTgId) { await ctx.answerCallbackQuery("⛔ Нет доступа"); return; }
    const page = data.startsWith("users_page_") ? parseInt(data.replace("users_page_", ""), 10) : 1;
    const perPage = 5;
    const total = db.prepare("SELECT COUNT(*) as n FROM users").get().n;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const p = Math.max(1, Math.min(page, totalPages));
    const rows = db.prepare("SELECT * FROM users ORDER BY linked_at DESC LIMIT " + perPage + " OFFSET " + ((p - 1) * perPage)).all();

    let text = `👥 <b>Пользователи</b> (${total})\n\n`;
    if (!rows.length) {
      text += "Нет привязанных аккаунтов.";
    }
    const kb = [];
    for (const r of rows) {
      const duoName = r.duolingo_username || r.duolingo_user_id || "—";
      const tgName = r.tg_username || r.tg_user_id;
      const hasJwt = r.jwt_encrypted ? "✓" : "✗";
      text += `👤 <b>${duoName}</b>\n`;
      text += `   🆔 <code>${r.duolingo_user_id || "—"}</code>\n`;
      text += `   📱 @${tgName} · <code>${r.tg_user_id}</code>\n`;
      text += `   🔑 JWT: ${hasJwt} · 📅 ${r.linked_at}\n\n`;
      kb.push([
        { text: "🚫 Забанить " + duoName, callback_data: "ban_user_" + r.tg_user_id },
      ]);
    }
    const nav = [];
    if (p > 1) nav.push({ text: "← Назад", callback_data: "users_page_" + (p - 1) });
    nav.push({ text: `${p}/${totalPages}`, callback_data: "noop" });
    if (p < totalPages) nav.push({ text: "Вперёд →", callback_data: "users_page_" + (p + 1) });
    if (nav.length) kb.push(nav);
    kb.push([{ text: "← В админку", callback_data: "menu_admin" }]);

    await safeEdit(ctx, text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: kb },
    });
    return;
  }

  // === АДМИН: УСТАНОВКИ ===
  if (data === "admin_installs" || data.startsWith("installs_page_")) {
    if (ctx.from.id !== config.adminTgId) { await ctx.answerCallbackQuery("⛔ Нет доступа"); return; }
    const page = data.startsWith("installs_page_") ? parseInt(data.replace("installs_page_", ""), 10) : 1;
    const perPage = 10;
    const total = db.prepare("SELECT COUNT(*) as n FROM script_installs").get().n;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const p = Math.max(1, Math.min(page, totalPages));
    const rows = db.prepare("SELECT * FROM script_installs ORDER BY first_seen DESC LIMIT " + perPage + " OFFSET " + ((p - 1) * perPage)).all();

    let text = `📦 <b>Установки скрипта</b> (${total})\n\n`;
    if (!rows.length) {
      text += "Нет данных.";
    }
    for (const r of rows) {
      const name = r.username || r.duolingo_user_id;
      text += `📦 <b>${name}</b> · <code>${r.duolingo_user_id}</code>\n`;
      text += `   📅 ${r.first_seen}${r.version ? " · v" + r.version : ""}\n\n`;
    }
    const kb = [];
    const nav = [];
    if (p > 1) nav.push({ text: "← Назад", callback_data: "installs_page_" + (p - 1) });
    nav.push({ text: `${p}/${totalPages}`, callback_data: "noop" });
    if (p < totalPages) nav.push({ text: "Вперёд →", callback_data: "installs_page_" + (p + 1) });
    if (nav.length) kb.push(nav);
    kb.push([{ text: "← В админку", callback_data: "menu_admin" }]);

    await safeEdit(ctx, text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: kb },
    });
    return;
  }

  // === ДРУЗЬЯ ===
  if (data === "action_friends") {
    await ctx.answerCallbackQuery();
    const user = db.prepare("SELECT * FROM users WHERE tg_user_id = ?").get(ctx.from.id);
    if (!user || !user.jwt_encrypted) {
      await ctx.editMessageText("👥 Друзья\n\n❌ Аккаунт не привязан.", {
        reply_markup: { inline_keyboard: [[{ text: "← Назад", callback_data: "menu_main" }]] },
      }).catch(() => {});
      return;
    }
    await ctx.editMessageText("👥 <b>Друзья</b>\n\n⏳ Загрузка…", { parse_mode: "HTML" }).catch(() => {});
    try {
      const jwt = decryptJWT(user.jwt_encrypted);
      const myId = user.duolingo_user_id;
      const [following, followers] = await Promise.all([
        fetchUserList(jwt, myId, "following"),
        fetchUserList(jwt, myId, "followers"),
      ]);
      const followersSet = new Set(followers.map((f) => String(f.userId)));
      const nonFollowers = following.filter((u) => !followersSet.has(String(u.userId)));
      friendsCache.set(ctx.from.id, { myId, following, followers, nonFollowers });
      await ctx.editMessageText(
        `👥 <b>Друзья</b>\n\n` +
        `Подписок: <b>${following.length}</b>\n` +
        `Подписчиков: <b>${followers.length}</b>\n` +
        `Не подписаны: <b>${nonFollowers.length}</b>`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🚫 Отписаться от неподписанных", callback_data: "friends_unfollow_nonf" }],
              [{ text: "🔍 Активность", callback_data: "friends_scan" }],
              [{ text: "← Назад", callback_data: "menu_main" }],
            ],
          },
        }
      ).catch(() => {});
    } catch {
      await ctx.editMessageText("👥 <b>Друзья</b>\n\n❌ Ошибка загрузки.", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "← Назад", callback_data: "menu_main" }]] },
      }).catch(() => {});
    }
    return;
  }

  if (data === "friends_unfollow_nonf") {
    await ctx.answerCallbackQuery();
    const user = db.prepare("SELECT * FROM users WHERE tg_user_id = ?").get(ctx.from.id);
    const cache = friendsCache.get(ctx.from.id);
    const excl = getExclusions(user || {});
    const targets = cache ? cache.nonFollowers.filter((u) => !excl.has(String(u.userId))) : [];
    if (!targets.length) {
      await safeEdit(ctx, "🚫 <b>Отписка от неподписанных</b>\n\nНет целей (обновите список друзей).", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "← Назад", callback_data: "action_friends" }]] },
      });
      return;
    }
    await safeEdit(ctx,
      `🚫 <b>Отписка от неподписанных</b>\n\nОтписаться от ${targets.length} пользователей, которые не подписаны на вас?\nИсключения 🛡 не тронем.`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: `✅ Да, отписать ${targets.length}`, callback_data: "friends_unfollow_nonf_go" }],
            [{ text: "← Назад", callback_data: "action_friends" }],
          ],
        },
      }
    );
    return;
  }

  if (data === "friends_unfollow_nonf_go" || data === "friends_unf_inactive_go" || data === "friends_block_inactive_go") {
    await ctx.answerCallbackQuery();
    const isBlock = data === "friends_block_inactive_go";
    const isNonf = data === "friends_unfollow_nonf_go";
    const user = db.prepare("SELECT * FROM users WHERE tg_user_id = ?").get(ctx.from.id);
    if (!user || !user.jwt_encrypted) {
      await safeEdit(ctx, "❌ Аккаунт не привязан.", {
        reply_markup: { inline_keyboard: [[{ text: "← Назад", callback_data: "action_friends" }]] },
      });
      return;
    }
    const excl = getExclusions(user);
    let targets = [];
    let title = "";
    if (isNonf) {
      const cache = friendsCache.get(ctx.from.id);
      targets = cache ? cache.nonFollowers.filter((u) => !excl.has(String(u.userId))) : [];
      title = "🚫 <b>Отписка от неподписанных</b>";
    } else {
      const scan = loadFriendScan(user.duolingo_user_id);
      const items = scan ? (scan.items || []) : [];
      targets = items.filter((r) => r.inactive && !excl.has(String(r.userId)) && (isBlock || r.iFollow));
      title = isBlock ? "🚫 <b>Блокировка неактивных</b>" : "🚫 <b>Отписка от неактивных</b>";
    }
    if (!targets.length) {
      await safeEdit(ctx, title + "\n\nНет целей.", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "← Назад", callback_data: "action_friends" }]] },
      });
      return;
    }
    if (friendsRunning.has(ctx.from.id)) {
      await safeEdit(ctx, title + "\n\n⏳ Действие уже выполняется.", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "← Назад", callback_data: "action_friends" }]] },
      });
      return;
    }
    friendsRunning.add(ctx.from.id);
    const jwt = decryptJWT(user.jwt_encrypted);
    const myId = user.duolingo_user_id;
    let ok = 0;
    const ids = [];
    let lastEdit = 0;
    try {
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const success = isBlock ? await blockUser(jwt, myId, t.userId) : await unfollowUser(jwt, myId, t.userId);
        if (success) { ok++; ids.push(String(t.userId)); }
        const now = Date.now();
        if (now - lastEdit >= 2000 || i === targets.length - 1) {
          lastEdit = now;
          await ctx.editMessageText(`${title}\n\n${isBlock ? "Блокировка" : "Отписка"} ${i + 1}/${targets.length}… (+${ok})`, {
            parse_mode: "HTML",
          }).catch(() => {});
        }
        await new Promise((r) => setTimeout(r, 300 + Math.floor(Math.random() * 250)));
      }
      const name = isNonf
        ? `отписка от ${ok} неподписанных`
        : isBlock
          ? `блокировка ${ok} неактивных`
          : `отписка от ${ok} неактивных`;
      logBotAction(user.duolingo_user_id, isBlock ? "block_mass" : "unfollow_mass", ids, name);
      await ctx.editMessageText(
        `${title}\n\n✅ Готово: ${ok} / ${targets.length}`,
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "← Назад", callback_data: "action_friends" }]] },
        }
      ).catch(() => {});
    } catch {
      await ctx.editMessageText(`${title}\n\n❌ Ошибка (${ok} / ${targets.length}).`, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "← Назад", callback_data: "action_friends" }]] },
      }).catch(() => {});
    } finally {
      friendsRunning.delete(ctx.from.id);
    }
    return;
  }

  if (data === "friends_scan_stop") {
    friendsScanStop.add(ctx.from.id);
    await ctx.answerCallbackQuery("⏹ Останавливаю…").catch(() => {});
    return;
  }

  if (data === "friends_scan") {
    await ctx.answerCallbackQuery();
    const user = db.prepare("SELECT * FROM users WHERE tg_user_id = ?").get(ctx.from.id);
    if (!user || !user.jwt_encrypted) {
      await safeEdit(ctx, "🔍 <b>Активность</b>\n\n❌ Аккаунт не привязан.", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "← Назад", callback_data: "action_friends" }]] },
      });
      return;
    }
    // выбор порога — применяется только к этому скану
    await safeEdit(ctx,
      "🔍 <b>Активность</b>\n\nПорог неактивности, дней:",
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "7 дн", callback_data: "friends_scan_d_7" }, { text: "14 дн", callback_data: "friends_scan_d_14" }, { text: "30 дн", callback_data: "friends_scan_d_30" }],
            [{ text: "✏ Ввести число", callback_data: "friends_scan_custom" }],
            [{ text: "← Назад", callback_data: "action_friends" }],
          ],
        },
      }
    );
    return;
  }

  if (/^friends_scan_d_\d+$/.test(data)) {
    await ctx.answerCallbackQuery();
    const daysLimit = parseInt(data.replace("friends_scan_d_", ""), 10);
    const user = db.prepare("SELECT * FROM users WHERE tg_user_id = ?").get(ctx.from.id);
    if (!user || !user.jwt_encrypted) {
      await safeEdit(ctx, "🔍 <b>Активность</b>\n\n❌ Аккаунт не привязан.", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "← Назад", callback_data: "action_friends" }]] },
      });
      return;
    }
    const msg = ctx.callbackQuery.message;
    await startFriendsScan(user, daysLimit, msg.chat.id, msg.message_id, ctx.from.id);
    return;
  }

  if (data === "friends_scan_custom") {
    const msg = ctx.callbackQuery.message;
    scanDaysState.set(ctx.from.id, { chatId: msg.chat.id, messageId: msg.message_id });
    await safeEdit(ctx,
      "✏ <b>Порог неактивности</b>\n\nВведите число дней (1–365):",
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "✖ Отмена", callback_data: "friends_scan" }]] },
      }
    );
    return;
  }

  if (data === "friends_unf_inactive" || data === "friends_block_inactive") {
    await ctx.answerCallbackQuery();
    const isBlock = data === "friends_block_inactive";
    const user = db.prepare("SELECT * FROM users WHERE tg_user_id = ?").get(ctx.from.id);
    const excl = getExclusions(user || {});
    const scan = user ? loadFriendScan(user.duolingo_user_id) : null;
    const items = scan ? (scan.items || []) : [];
    const targets = items.filter((r) => r.inactive && !excl.has(String(r.userId)) && (isBlock || r.iFollow));
    const title = isBlock ? "🚫 <b>Блокировка неактивных</b>" : "🚫 <b>Отписка от неактивных</b>";
    if (!targets.length) {
      await safeEdit(ctx, title + "\n\nНет целей (сначала проверьте активность).", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "← Назад", callback_data: "action_friends" }]] },
      });
      return;
    }
    await safeEdit(ctx,
      `${title}\n\n${isBlock ? "Заблокировать" : "Отписаться от"} ${targets.length} неактивных?\nИсключения 🛡 не тронем.`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: `✅ Да, ${isBlock ? "заблокировать" : "отписать"} ${targets.length}`, callback_data: isBlock ? "friends_block_inactive_go" : "friends_unf_inactive_go" }],
            [{ text: "← Назад", callback_data: "action_friends" }],
          ],
        },
      }
    );
    return;
  }

  // === XP БУСТ ===
  if (data === "xp_get") {
    streakAmountState.delete(ctx.from.id);
    xpAmountState.set(ctx.from.id, "waiting");
    await safeEdit(ctx,
      "🎁 <b>Получить XP</b>\n\n" +
      "Введите количество XP (минимум 50):\n\n" +
      "⚠️ <i>Накрутка XP — на свой страх и риск, возможна блокировка.</i>",
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "✖ Отмена", callback_data: "xp_cancel" }]] },
      }
    );
    return;
  }

  if (data === "xp_cancel") {
    xpAmountState.delete(ctx.from.id);
    await safeEdit(ctx, "❌ Накрутка отменена.", {
      reply_markup: { inline_keyboard: [[{ text: "← В статистику", callback_data: "action_stats" }]] },
    });
    return;
  }

  // === СЕРИЯ ДНЕЙ ===
  if (data === "streak_get") {
    xpAmountState.delete(ctx.from.id);
    streakAmountState.set(ctx.from.id, "waiting");
    await safeEdit(ctx,
      "🔥 <b>Накрутка серии</b>\n\n" +
      "Сколько дней накрутить? (минимум 1, максимум 365)\n\n" +
      "⚠️ <i>Накрутка серии — на свой страх и риск, возможна блокировка.</i>\n" +
      "⏱ <i>Процесс может занять 5–6 минут.</i>",
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "✖ Отмена", callback_data: "streak_cancel" }]] },
      }
    );
    return;
  }

  if (data === "streak_cancel") {
    streakAmountState.delete(ctx.from.id);
    await safeEdit(ctx, "❌ Накрутка отменена.", {
      reply_markup: { inline_keyboard: [[{ text: "← В статистику", callback_data: "action_stats" }]] },
    });
    return;
  }

  // === БАГРЕПОРТЫ ===
  if (data === "bug_report_start") {
    bugReportState.set(ctx.from.id, "waiting");
    await safeEdit(ctx,
      "🐛 <b>Багрепорт</b>\n\n" +
      "Опишите проблему одним сообщением:",
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "✖ Отмена", callback_data: "bug_cancel" }]] },
      }
    );
    return;
  }

  if (data === "bug_cancel") {
    bugReportState.delete(ctx.from.id);
    bugReplyState.delete(ctx.from.id);
    await safeEdit(ctx, "❌ Багрепорт отменён.", {
      reply_markup: { inline_keyboard: [[{ text: "← В меню", callback_data: "menu_main" }]] },
    });
    return;
  }

  if (data.startsWith("bug_accept_")) {
    if (ctx.from.id !== config.adminTgId) { await ctx.answerCallbackQuery("⛔ Нет доступа"); return; }
    const bugId = parseInt(data.replace("bug_accept_", ""), 10);
    const bug = db.prepare("SELECT * FROM bug_reports WHERE id = ?").get(bugId);
    if (!bug) { await ctx.answerCallbackQuery("Багрепорт не найден"); return; }
    if (bug.status !== "received") { await ctx.answerCallbackQuery("Уже обработан"); return; }
    db.prepare("UPDATE bug_reports SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?").run(bugId);
    await ctx.answerCallbackQuery("✅ Принято в работу");
    await ctx.editMessageReplyMarkup({
      inline_keyboard: [[
        { text: "🔄 В работе", callback_data: "noop" },
        { text: "💬 Ответить", callback_data: "bug_reply_" + bugId },
      ]],
    }).catch(() => {});
    // уведомление пользователю
    bot.api.sendMessage(Number(bug.tg_user_id),
      "🔄 Ваш багрепорт принят в работу!",
    ).catch(() => {});
    return;
  }

  if (data.startsWith("bug_reject_")) {
    if (ctx.from.id !== config.adminTgId) { await ctx.answerCallbackQuery("⛔ Нет доступа"); return; }
    const bugId = parseInt(data.replace("bug_reject_", ""), 10);
    const bugR = db.prepare("SELECT * FROM bug_reports WHERE id = ?").get(bugId);
    if (!bugR) { await ctx.answerCallbackQuery("Багрепорт не найден"); return; }
    if (bugR.status !== "received") { await ctx.answerCallbackQuery("Уже обработан"); return; }
    db.prepare("UPDATE bug_reports SET status = 'rejected', updated_at = datetime('now') WHERE id = ?").run(bugId);
    await ctx.answerCallbackQuery("❌ Отклонено");
    await ctx.editMessageReplyMarkup({
      inline_keyboard: [[{ text: "❌ Отклонён", callback_data: "noop" }]],
    }).catch(() => {});
    // пользователю НЕ отправляем уведомление об отклонении
    return;
  }

  if (data.startsWith("bug_complete_")) {
    if (ctx.from.id !== config.adminTgId) { await ctx.answerCallbackQuery("⛔ Нет доступа"); return; }
    const bugId = parseInt(data.replace("bug_complete_", ""), 10);
    const bug = db.prepare("SELECT * FROM bug_reports WHERE id = ?").get(bugId);
    if (!bug) { await ctx.answerCallbackQuery("Багрепорт не найден"); return; }
    if (bug.status !== "in_progress") { await ctx.answerCallbackQuery("Нельзя выполнить — не в работе"); return; }
    db.prepare("UPDATE bug_reports SET status = 'completed', updated_at = datetime('now') WHERE id = ?").run(bugId);
    await ctx.answerCallbackQuery("✅ Выполнено");
    if (bug) {
      bot.api.sendMessage(Number(bug.tg_user_id), "✅ Ваш багрепорт выполнен!").catch(() => {});
    }
    return;
  }

  if (data.startsWith("bug_reply_")) {
    if (ctx.from.id !== config.adminTgId) { await ctx.answerCallbackQuery("⛔ Нет доступа"); return; }
    const bugId = parseInt(data.replace("bug_reply_", ""), 10);
    // запрашиваем текст ответа
    bugReplyState.set(ctx.from.id, bugId);
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.reply("💬 Введите текст ответа пользователю:");
    return;
  }

  // список багрепортов по статусам
  if (data === "admin_bugs" || data.startsWith("bugs_")) {
    if (ctx.from.id !== config.adminTgId) { await ctx.answerCallbackQuery("⛔ Нет доступа"); return; }
    let status = "received";
    let page = 1;
    if (data.startsWith("bugs_")) {
      const m = data.match(/^bugs_(.+)_(\d+)$/);
      if (m) {
        status = m[1];
        page = parseInt(m[2], 10) || 1;
      }
    }
    const statusLabels = {
      received: "📥 Полученные",
      in_progress: "🔄 В работе",
      completed: "✅ Выполненные",
      rejected: "❌ Отклонённые",
    };
    const perPage = 5;
    const total = db.prepare("SELECT COUNT(*) as n FROM bug_reports WHERE status = ?").get(status).n;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const p = Math.max(1, Math.min(page, totalPages));
    const rows = db.prepare("SELECT * FROM bug_reports WHERE status = ? ORDER BY updated_at DESC LIMIT " + perPage + " OFFSET " + ((p - 1) * perPage)).all(status);

    // собираем текст и кнопки
    const SEP = "━━━━━━━━━━━━━━━━━━";
    let text = "🐛 <b>" + (statusLabels[status] || status) + "</b> (" + total + ")\n\n";
    const kb = [];
    if (!rows.length) {
      text += "Нет записей.";
    }
    for (let idx = 0; idx < rows.length; idx++) {
      const r = rows[idx];
      const name = r.tg_username || r.tg_user_id;
      text += SEP + "\n";
      text += "<b>" + (idx + 1) + ".</b> " + (r.message || "").substring(0, 120) + ((r.message || "").length > 120 ? "…" : "") + "\n";
      text += "@" + name + " · " + r.created_at + "\n";
      if (r.admin_reply) text += "💬 " + r.admin_reply.substring(0, 80) + "\n";
      if (status === "received") {
        kb.push([
          { text: "✅ Принять " + (idx + 1), callback_data: "bug_accept_" + r.id },
          { text: "❌ Отклонить " + (idx + 1), callback_data: "bug_reject_" + r.id },
        ]);
      } else if (status === "in_progress") {
        kb.push([
          { text: "✅ Выполнено " + (idx + 1), callback_data: "bug_complete_" + r.id },
          { text: "💬 Ответить " + (idx + 1), callback_data: "bug_reply_" + r.id },
        ]);
      }
    }
    if (rows.length) text += SEP;

    // фильтры
    kb.push([
      { text: "📥", callback_data: "bugs_received_1" },
      { text: "🔄", callback_data: "bugs_in_progress_1" },
      { text: "✅", callback_data: "bugs_completed_1" },
      { text: "❌", callback_data: "bugs_rejected_1" },
    ]);
    // пагинация
    const nav = [];
    if (p > 1) nav.push({ text: "← Назад", callback_data: "bugs_" + status + "_" + (p - 1) });
    nav.push({ text: p + "/" + totalPages, callback_data: "noop" });
    if (p < totalPages) nav.push({ text: "Вперёд →", callback_data: "bugs_" + status + "_" + (p + 1) });
    if (nav.length) kb.push(nav);
    kb.push([{ text: "← В админку", callback_data: "menu_admin" }]);

    await safeEdit(ctx, text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: kb },
    });
    return;
  }

  // === УВЕДОМЛЕНИЯ ===
  if (data === "settings_notify" || data.startsWith("notify_toggle_")) {
    if (data.startsWith("notify_toggle_")) {
      toggleNotify(ctx.from.id, data.replace("notify_toggle_", ""));
    }
    await safeEdit(ctx, "🔔 <b>Уведомления</b>\n\nВыберите, что уведомлять:", {
      parse_mode: "HTML",
      reply_markup: notifyKeyboard(getNotifyPrefs(ctx.from.id)),
    });
    return;
  }

  // === ЛИНКОВКА ===
  if (data === "settings_link") {
    const user = db.prepare("SELECT * FROM users WHERE tg_user_id = ?").get(ctx.from.id);
    if (!user) {
      await safeEdit(ctx,
        "🔗 <b>Линковка</b>\n\n" +
        "❌ Аккаунт не привязан.\nИспользуйте кнопку «Привязать Telegram» в скрипте Duolingo Helper.",
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "← Назад", callback_data: "menu_settings" }]] },
        }
      );
      return;
    }
    const tgName = user.tg_username || ctx.from.username || String(user.tg_user_id);
    await safeEdit(ctx,
      `🔗 <b>Линковка</b>\n\n` +
      `✅ Аккаунт привязан\n\n` +
      `👤 <b>${user.duolingo_username || user.duolingo_user_id}</b> · <code>${user.duolingo_user_id}</code>\n` +
      `📱 @${tgName} · <code>${user.tg_user_id}</code>\n` +
      `📅 Привязан: ${user.linked_at}`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔓 Отвязать аккаунт", callback_data: "settings_unlink" }],
            [{ text: "← Назад", callback_data: "menu_settings" }],
          ],
        },
      }
    );
    return;
  }

  if (data === "settings_unlink") {
    const user = db.prepare("SELECT * FROM users WHERE tg_user_id = ?").get(ctx.from.id);
    if (!user) {
      await safeEdit(ctx, "🔗 <b>Линковка</b>\n\n❌ Аккаунт не привязан.", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "← Назад", callback_data: "menu_settings" }]] },
      });
      return;
    }
    await safeEdit(ctx,
      "🔓 <b>Отвязка аккаунта</b>\n\n" +
      "⚠️ Отвязать аккаунт?\n" +
      "Все данные и настройки будут удалены с сервера:\n" +
      "статистика, уведомления, друзья, история действий.",
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Да, отвязать", callback_data: "settings_unlink_go" }],
            [{ text: "← Назад", callback_data: "settings_link" }],
          ],
        },
      }
    );
    return;
  }

  if (data === "settings_unlink_go") {
    const user = db.prepare("SELECT * FROM users WHERE tg_user_id = ?").get(ctx.from.id);
    if (user) wipeUserData(user.tg_user_id, user.duolingo_user_id);
    await safeEdit(ctx,
      "✅ Аккаунт отвязан.\n\nВсе данные удалены с сервера.",
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "← В меню", callback_data: "menu_main" }]] },
      }
    );
    return;
  }

  // === ДОНАТЫ ===
  if (data === "donate_menu") {
    await ctx.answerCallbackQuery("Открываю меню донатов").catch(() => {});
    // отдельным сообщением, чтобы не затирать исходное (дайджест/статистика)
    await ctx.reply(donateMenuText(), {
      parse_mode: "HTML",
      reply_markup: donateMenuKeyboard(),
    }).catch(() => {});
    bot.api.sendMessage(config.adminTgId,
      `💝 <b>Донат меню</b>\n👤 @${ctx.from.username || ctx.from.id} (ID: <code>${ctx.from.id}</code>) открыл меню донатов`,
      { parse_mode: "HTML" }
    ).catch(() => {});
    return;
  }

  if (data === "donate_kaspa" || data === "donate_ton" || data === "donate_usdt") {
    const kind = data.replace("donate_", "");
    const view = donateAddressView(kind);
    await safeEdit(ctx, view.text, {
      parse_mode: "HTML",
      reply_markup: view.kb,
    });
    const meta = kind === "kaspa" ? { icon: "💎", label: "Kaspa" } : kind === "ton" ? { icon: "💠", label: "TON" } : { icon: "💵", label: "USDT" };
    bot.api.sendMessage(config.adminTgId,
      `${meta.icon} <b>Донат: ${meta.label}</b>\n👤 @${ctx.from.username || ctx.from.id} (ID: <code>${ctx.from.id}</code>) открыл адрес ${meta.label}`,
      { parse_mode: "HTML" }
    ).catch(() => {});
    return;
  }

  if (data === "admin_balance") {
    if (ctx.from.id !== config.adminTgId) {
      await ctx.answerCallbackQuery("⛔ Нет доступа");
      return;
    }
    await safeEdit(ctx, "💰 <b>Баланс кошельков</b>\n\n⏳ Получаю балансы...", { parse_mode: "HTML" });
    try {
      const balances = await getAllBalances();
      await safeEdit(ctx, buildBalanceMessage(balances), {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "← В админку", callback_data: "menu_admin" }]] },
      });
    } catch {
      await safeEdit(ctx, "❌ Ошибка получения балансов. Попробуйте позже.", {
        reply_markup: { inline_keyboard: [[{ text: "← В админку", callback_data: "menu_admin" }]] },
      });
    }
    return;
  }

  // заглушки — «в разработке»
  const stubs = {
    admin_cleanup: "🗑 Очистка данных",
    admin_logs: "📋 Логи",
  };
  if (data === "noop") {
    await ctx.answerCallbackQuery();
    return;
  }
  if (stubs[data]) {
    await safeEdit(ctx, stubs[data] + "\n\n⏳ В разработке…", {
      reply_markup: { inline_keyboard: [[{ text: "← Назад", callback_data: "menu_main" }]] },
    });
    return;
  }

  await ctx.answerCallbackQuery();
});

// /help
bot.command("help", (ctx) => {
  ctx.reply(
    "📋 Duolingo Helper Bot\n\n" +
    "Привяжи аккаунт через скрипт Duolingo Helper,\n" +
    "затем используй кнопки меню.",
    { reply_markup: mainMenuKeyboard(ctx.from.id === config.adminTgId) }
  );
});

// /status
bot.command("status", (ctx) => {
  const tgId = ctx.from.id;
  const user = db.prepare("SELECT * FROM users WHERE tg_user_id = ?").get(tgId);
  if (!user) {
    ctx.reply("❌ Аккаунт не привязан. Используй кнопку в скрипте Duolingo Helper.");
    return;
  }
  ctx.reply(
    `✅ Аккаунт привязан:\n\n` +
    `Duolingo: ${user.duolingo_username || user.duolingo_user_id}\n` +
    `ID: ${user.duolingo_user_id}\n` +
    `Привязан: ${user.linked_at}`
  );
});

// /unlink
bot.command("unlink", async (ctx) => {
  const tgId = ctx.from.id;
  const user = db.prepare("SELECT * FROM users WHERE tg_user_id = ?").get(tgId);
  if (!user) {
    ctx.reply("❌ Аккаунт не привязан.");
    return;
  }
  wipeUserData(tgId, user.duolingo_user_id);
  ctx.reply("✅ Аккаунт отвязан. Все данные удалены с сервера.");
});

// /bugreport — отправка бага
const bugReportState = new Map(); // tg_id -> "waiting"
const bugReplyState = new Map(); // tg_id -> bugId
const xpAmountState = new Map(); // tg_id -> "waiting" (ждём количество XP)
const xpRunning = new Set(); // tg_id — накрутка уже идёт
const streakAmountState = new Map(); // tg_id -> "waiting" (ждём количество дней серии)
const streakRunning = new Set(); // tg_id — накрутка серии уже идёт
const friendsCache = new Map(); // tg_id -> { myId, following, followers, nonFollowers }
const friendsRunning = new Set(); // tg_id — действие с друзьями уже идёт
const friendsScanStop = new Set(); // tg_id — флаг остановки скана активности
const scanDaysState = new Map(); // tg_id -> { chatId, messageId } — ждём порог неактивности
bot.command("bugreport", (ctx) => {
  bugReportState.set(ctx.from.id, "waiting");
  ctx.reply(
    "🐛 <b>Багрепорт</b>\n\n" +
    "Опишите проблему одним сообщением:",
    {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "✖ Отмена", callback_data: "bug_cancel" }]] },
    }
  );
});

// приём текста бага и количества XP
bot.on("message:text", async (ctx) => {
  // если ждём количество XP — запускаем накрутку
  if (xpAmountState.get(ctx.from.id) === "waiting") {
    const raw = ctx.message.text.trim();
    if (raw.startsWith("/")) {
      return; // команда — не мешаем
    }
    xpAmountState.delete(ctx.from.id);
    const amount = parseInt(raw, 10);
    if (!Number.isFinite(amount) || amount < 50) {
      await ctx.reply("❌ Минимум 50 XP. Попробуйте ещё раз:");
      xpAmountState.set(ctx.from.id, "waiting");
      return;
    }
    const target = Math.min(99999, amount);
    if (xpRunning.has(ctx.from.id)) {
      await ctx.reply("⏳ Накрутка уже идёт, дождитесь завершения.");
      return;
    }
    const user = db.prepare("SELECT * FROM users WHERE tg_user_id = ?").get(ctx.from.id);
    if (!user || !user.jwt_encrypted) {
      await ctx.reply("❌ Аккаунт не привязан или JWT отсутствует.");
      return;
    }
    const statusMsg = await ctx.reply("⏳ <b>Идёт накрутка XP…</b>", { parse_mode: "HTML" });
    xpRunning.add(ctx.from.id);
    try {
      const earned = await runXpFarm(user, target);
      // лог накруток — для дайджеста
      if (earned > 0) {
        try {
          db.prepare("INSERT INTO xp_farm_log (duolingo_user_id, amount, ts) VALUES (?, ?, ?)")
            .run(String(user.duolingo_user_id), earned, Date.now());
        } catch {}
      }
      const statsText = await buildStatsText(user);
      await ctx.api.editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        (earned ? `✅ <b>Готово: +${Number(earned).toLocaleString("ru")} XP</b>\n\n` : "⚠️ <b>XP не начислены</b>\n\n") + statsText,
        {
          parse_mode: "HTML",
          reply_markup: statsKeyboard(),
        }
      ).catch(() => {});
    } catch (e) {
      await ctx.api.editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        "❌ Ошибка накрутки XP.",
        { reply_markup: statsKeyboard() }
      ).catch(() => {});
    } finally {
      xpRunning.delete(ctx.from.id);
    }
    return;
  }

  // если ждём количество дней серии — запускаем накрутку
  if (streakAmountState.get(ctx.from.id) === "waiting") {
    const raw = ctx.message.text.trim();
    if (raw.startsWith("/")) {
      return; // команда — не мешаем
    }
    streakAmountState.delete(ctx.from.id);
    const amount = parseInt(raw, 10);
    if (!Number.isFinite(amount) || amount < 1) {
      await ctx.reply("❌ Минимум 1 день. Попробуйте ещё раз:");
      streakAmountState.set(ctx.from.id, "waiting");
      return;
    }
    const target = Math.min(365, amount);
    if (streakRunning.has(ctx.from.id)) {
      await ctx.reply("⏳ Накрутка серии уже идёт, дождитесь завершения.");
      return;
    }
    const user = db.prepare("SELECT * FROM users WHERE tg_user_id = ?").get(ctx.from.id);
    if (!user || !user.jwt_encrypted) {
      await ctx.reply("❌ Аккаунт не привязан или JWT отсутствует.");
      return;
    }
    const statusMsg = await ctx.reply(
      `🔥 <b>Накрутка серии…</b>\n\nДень 0/${target}… (+0)\n\n⏱ <i>Может занять 5–6 минут.</i>`,
      { parse_mode: "HTML" }
    );
    streakRunning.add(ctx.from.id);
    try {
      let lastEdit = 0;
      const saved = await runStreakFarm(user, target, (i, ok, isFail) => {
        // обновляем прогресс не чаще раза в 2 секунды
        const now = Date.now();
        if (now - lastEdit < 2000) return;
        lastEdit = now;
        const day = Math.min(i + 1, target);
        ctx.api.editMessageText(
          statusMsg.chat.id,
          statusMsg.message_id,
          `🔥 <b>Накрутка серии…</b>\n\nДень ${day}/${target}… (+${ok})` + (isFail ? " ⚠️" : "") + `\n\n⏱ <i>Может занять 5–6 минут.</i>`,
          { parse_mode: "HTML" }
        ).catch(() => {});
      });
      const statsText = await buildStatsText(user);
      await ctx.api.editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        (saved ? `✅ <b>Готово: +${saved} дн.</b>\n\n` : "⚠️ <b>Серия не увеличена</b>\n\n") + statsText,
        {
          parse_mode: "HTML",
          reply_markup: statsKeyboard(),
        }
      ).catch(() => {});
    } catch (e) {
      await ctx.api.editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        "❌ Ошибка накрутки серии.",
        { reply_markup: statsKeyboard() }
      ).catch(() => {});
    } finally {
      streakRunning.delete(ctx.from.id);
    }
    return;
  }

  // если ждём порог неактивности для скана
  if (scanDaysState.has(ctx.from.id)) {
    const raw = ctx.message.text.trim();
    if (raw.startsWith("/")) {
      return; // команда — не мешаем
    }
    const st = scanDaysState.get(ctx.from.id);
    scanDaysState.delete(ctx.from.id);
    const days = parseInt(raw, 10);
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      await ctx.reply("❌ Введите число от 1 до 365:");
      scanDaysState.set(ctx.from.id, st);
      return;
    }
    const user = db.prepare("SELECT * FROM users WHERE tg_user_id = ?").get(ctx.from.id);
    if (!user || !user.jwt_encrypted) {
      await ctx.reply("❌ Аккаунт не привязан.");
      return;
    }
    await startFriendsScan(user, days, st.chatId, st.messageId, ctx.from.id);
    return;
  }

  // если ждём багрепорт — сохраняем
  if (bugReportState.get(ctx.from.id) === "waiting") {
    bugReportState.delete(ctx.from.id);
    const text = ctx.message.text;
    if (text.startsWith("/")) {
      // это команда, не баг — пропускаем
      bugReportState.set(ctx.from.id, "waiting");
      return;
    }
    if (!text || text.length < 5) {
      ctx.reply("❌ Сообщение слишком короткое. Попробуйте ещё раз: /bugreport");
      return;
    }
    // проверка привязки TG
    const user = db.prepare("SELECT * FROM users WHERE tg_user_id = ?").get(ctx.from.id);
    if (!user) {
      bugReportState.delete(ctx.from.id);
      ctx.reply("❌ Для отправки багрепорта привяжите аккаунт. Кнопка «Привязать Telegram» в скрипте Duolingo Helper.");
      return;
    }
    // rate limit: 1 баг в 5 минут
    const recentBug = db.prepare("SELECT created_at FROM bug_reports WHERE tg_user_id = ? ORDER BY created_at DESC LIMIT 1").get(ctx.from.id);
    if (recentBug) {
      const elapsed = Date.now() - new Date(recentBug.created_at).getTime();
      if (elapsed < 5 * 60 * 1000) {
        bugReportState.delete(ctx.from.id);
        const mins = Math.ceil((5 * 60 * 1000 - elapsed) / 60000);
        ctx.reply("⏱ Слишком часто. Попробуйте через " + mins + " мин.");
        return;
      }
    }
    // rate limit: максимум 10 в день
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayCount = db.prepare("SELECT COUNT(*) as n FROM bug_reports WHERE tg_user_id = ? AND created_at >= ?").get(ctx.from.id, todayStart.toISOString()).n;
    if (todayCount >= 10) {
      bugReportState.delete(ctx.from.id);
      ctx.reply("❌ Достигнут дневной лимит багрепортов (10). Попробуйте завтра.");
      return;
    }
    const bugId = db.prepare(`
      INSERT INTO bug_reports (tg_user_id, tg_username, duolingo_user_id, duolingo_username, message)
      VALUES (?, ?, ?, ?, ?)
    `).run(ctx.from.id, ctx.from.username || "", user ? user.duolingo_user_id || "" : "", user ? user.duolingo_username || "" : "", text).lastInsertRowid;

    // подтверждение пользователю
    ctx.reply("✅ <b>Багрепорт отправлен!</b>\n\nМы рассмотрим его в ближайшее время.", { parse_mode: "HTML" });

    // уведомление админу
    const duoName = (user && user.duolingo_username) || (user && user.duolingo_user_id) || "—";
    bot.api.sendMessage(config.adminTgId,
      `🐛 <b>Новый багрепорт</b>\n\n` +
      `От: @${ctx.from.username || ctx.from.id} (tg)\n` +
      `👤 ${duoName} (duo)\n` +
      `📝 "${text.substring(0, 200)}${text.length > 200 ? "…" : ""}"\n` +
      `📅 ${new Date().toLocaleString("ru")}`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Принять", callback_data: "bug_accept_" + bugId },
            { text: "❌ Отклонить", callback_data: "bug_reject_" + bugId },
          ]],
        },
      }
    ).catch(() => {});
    return;
  }
  // если ждём ответ на багрепорт
  if (bugReplyState.has(ctx.from.id)) {
    const bugId = bugReplyState.get(ctx.from.id);
    bugReplyState.delete(ctx.from.id);
    const replyText = ctx.message.text;
    const bug = db.prepare("SELECT * FROM bug_reports WHERE id = ?").get(bugId);
    if (bug) {
      db.prepare("UPDATE bug_reports SET admin_reply = ?, status = 'in_progress', updated_at = datetime('now') WHERE id = ?").run(replyText, bugId);
      // отправляем ответ пользователю
      bot.api.sendMessage(Number(bug.tg_user_id), `💬 Ответ от поддержки:\n\n${replyText}`).catch(() => {});
      ctx.reply("✅ Ответ отправлен пользователю.");
    }
    return;
  }
  // если не ждём баг — игнорируем (команды обрабатываются отдельно)
});

// /admin — только для ADMIN_TG_ID
bot.command("admin", (ctx) => {
  if (ctx.from.id !== config.adminTgId) {
    ctx.reply("⛔ Нет доступа.");
    return;
  }
  ctx.reply("🔧 Админ-панель\n\nВыберите раздел:", {
    reply_markup: adminMenuKeyboard(),
  });
});

// обработка кода линковки из deep link
function handleLinkCode(ctx, code) {
  const row = db.prepare("SELECT * FROM link_codes WHERE code = ?").get(code);
  if (!row) {
    ctx.reply("❌ Код не найден.");
    return;
  }
  if (row.used) {
    ctx.reply("❌ Код уже использован.");
    return;
  }
  if (Date.now() > row.expires_at) {
    ctx.reply("❌ Код истёк. Получи новый в скрипте.");
    return;
  }
  if (row.attempts >= 5) {
    ctx.reply("❌ Слишком много попыток.");
    return;
  }

  db.prepare("UPDATE link_codes SET used = 1 WHERE code = ?").run(code);

  const existing = db.prepare("SELECT * FROM users WHERE tg_user_id = ?").get(ctx.from.id);
  if (existing && existing.duolingo_user_id !== row.duolingo_user_id) {
    ctx.reply(
      "⚠️ Уже привязан другой Duolingo-аккаунт.\n" +
      "Сначала отвяжи: /unlink"
    );
    return;
  }

  db.prepare(`
    INSERT INTO users (duolingo_user_id, duolingo_username, tg_user_id, tg_username, jwt_encrypted)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(tg_user_id) DO UPDATE SET
      duolingo_user_id = excluded.duolingo_user_id,
      duolingo_username = COALESCE(excluded.duolingo_username, users.duolingo_username),
      tg_username = excluded.tg_username,
      jwt_encrypted = COALESCE(excluded.jwt_encrypted, users.jwt_encrypted),
      linked_at = datetime('now')
  `).run(row.duolingo_user_id, row.duolingo_username || null, ctx.from.id, ctx.from.username || "", row.jwt_encrypted || null);

  ctx.reply(
    "✅ Аккаунт привязан!\n\n" +
    `Duolingo ID: ${row.duolingo_user_id}\n` +
    "Теперь ты получишь доступ к командам бота."
  );

  // уведомление админу о линковке
  try {
    const duoName = row.duolingo_username || row.duolingo_user_id;
    const tgName = ctx.from.username || ctx.from.id;
    bot.api.sendMessage(config.adminTgId,
      `🔗 <b>Линковка Telegram</b>\n\n` +
      `👤 <b>${duoName}</b> (duo)\n` +
      `🔗 <a href="https://www.duolingo.com/profile/${encodeURIComponent(duoName)}">Профиль</a>\n` +
      `🆔 <code>${row.duolingo_user_id}</code>\n` +
      `📱 @${tgName} (tg) · <code>${ctx.from.id}</code>\n` +
      `📅 ${new Date().toLocaleString("ru")}`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "🚫 Забанить", callback_data: "ban_user_" + ctx.from.id },
          ]],
        },
      }
    ).catch(() => {});
  } catch {}
}

// rate limiting
const rateLimitMap = new Map();

// HTTP API для скрипта (генерация кодов линковки)
const httpServer = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/api/link-code") {
    // rate limiting: 5 запросов в минуту с одного IP
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
    const requests = rateLimitMap.get(ip).filter((t) => now - t < 60000);
    if (requests.length >= 5) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "rate limit" }));
      return;
    }
    requests.push(now);
    rateLimitMap.set(ip, requests);

    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const { duolingoUserId, duolingoUsername, jwt } = JSON.parse(body || "{}");
        console.log("[link-code] duolingoUserId=" + duolingoUserId + " jwt=" + (jwt ? "YES len=" + jwt.length : "NULL/UNDEFINED"));
        if (!duolingoUserId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "duolingoUserId required" }));
          return;
        }

        // шифруем JWT
        const jwtEncrypted = jwt ? encryptJWT(jwt) : null;

        // генерируем код
        const code = randomBytes(8).toString("hex");
        const expiresAt = Date.now() + 10 * 60 * 1000; // 10 минут

        // сохраняем в БД
        db.prepare(`
          INSERT INTO link_codes (code, duolingo_user_id, duolingo_username, jwt_encrypted, expires_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(code, String(duolingoUserId), duolingoUsername || null, jwtEncrypted, expiresAt);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          code,
          deepLink: `https://t.me/Duolingo_Helperbot?start=${code}`,
          expiresAt,
        }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/link-status")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const duoId = url.searchParams.get("duolingoUserId");
    if (!duoId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "duolingoUserId required" }));
      return;
    }
    const user = db.prepare("SELECT tg_username, tg_user_id, linked_at FROM users WHERE duolingo_user_id = ?").get(String(duoId));
    if (user) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ linked: true, tgUsername: user.tg_username, tgUserId: user.tg_user_id, hasJwt: !!user.jwt_encrypted, linkedAt: user.linked_at }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ linked: false }));
    }
    return;
  }

  // === ОБЛАЧНЫЙ БЭКАП (управление из скрипта, один бэкап на пользователя) ===
  if (req.method === "POST" && req.url === "/api/backup") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const { duolingoUserId, jwt, data } = JSON.parse(body || "{}");
        if (!duolingoUserId || !jwt || !data) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "duolingoUserId, jwt and data required" }));
          return;
        }
        if (jwtSub(jwt) !== String(duolingoUserId)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "jwt mismatch" }));
          return;
        }
        // один бэкап на пользователя: старый перезаписывается
        const enc = encryptJWT(JSON.stringify(data));
        db.prepare("DELETE FROM backups WHERE duolingo_user_id = ?").run(String(duolingoUserId));
        db.prepare("INSERT INTO backups (duolingo_user_id, data) VALUES (?, ?)").run(String(duolingoUserId), enc);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, savedAt: Date.now() }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === "DELETE" && req.url.startsWith("/api/backup")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const duoId = url.searchParams.get("duolingoUserId");
    const auth = String(req.headers.authorization || "");
    const jwt = auth.replace(/^Bearer\s+/i, "");
    if (!duoId || !jwt) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "duolingoUserId and jwt required" }));
      return;
    }
    if (jwtSub(jwt) !== String(duoId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "jwt mismatch" }));
      return;
    }
    const info = db.prepare("DELETE FROM backups WHERE duolingo_user_id = ?").run(String(duoId));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, deleted: info.changes > 0 }));
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/backup")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const duoId = url.searchParams.get("duolingoUserId");
    const metaOnly = url.searchParams.get("meta") === "1";
    const auth = String(req.headers.authorization || "");
    const jwt = auth.replace(/^Bearer\s+/i, "");
    if (!duoId || !jwt) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "duolingoUserId and jwt required" }));
      return;
    }
    if (jwtSub(jwt) !== String(duoId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "jwt mismatch" }));
      return;
    }
    const row = db.prepare("SELECT data, created_at FROM backups WHERE duolingo_user_id = ?").get(String(duoId));
    if (!row) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, hasBackup: false }));
      return;
    }
    if (metaOnly) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, hasBackup: true, savedAt: row.created_at }));
      return;
    }
    const json = decryptJWT(row.data);
    let data = null;
    try { data = json ? JSON.parse(json) : null; } catch {}
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, hasBackup: true, savedAt: row.created_at, data }));
    return;
  }

  if (req.method === "POST" && req.url === "/api/unlink") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const { duolingoUserId } = JSON.parse(body || "{}");
        if (!duolingoUserId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "duolingoUserId required" }));
          return;
        }
        // полная очистка — как при отвязке в боте
        const linked = db.prepare("SELECT tg_user_id FROM users WHERE duolingo_user_id = ?").get(String(duolingoUserId));
        wipeUserData(linked ? linked.tg_user_id : null, String(duolingoUserId));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // синхронизация статистики из скрипта
  if (req.method === "POST" && req.url === "/api/sync-stats") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const { duolingoUserId, duolingoUsername, xpLog, totalXp, streak, excludeList, scriptVersion } = JSON.parse(body || "{}");
        if (!duolingoUserId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "duolingoUserId required" }));
          return;
        }
        // сохраняем исключения 🛡 из скрипта (порог неактивности выбирается в боте)
        try {
          if (Array.isArray(excludeList)) {
            db.prepare("UPDATE users SET exclude_list = ? WHERE duolingo_user_id = ?")
              .run(JSON.stringify(excludeList.map((x) => String(x && x.userId != null ? x.userId : x))), String(duolingoUserId));
          }
        } catch {}
        // проверяем: новый ли это пользователь (установка скрипта)
        try {
          const existing = db.prepare("SELECT duolingo_user_id FROM script_installs WHERE duolingo_user_id = ?").get(String(duolingoUserId));
          if (!existing) {
            db.prepare("INSERT OR IGNORE INTO script_installs (duolingo_user_id, username, version) VALUES (?, ?, ?)").run(String(duolingoUserId), duolingoUsername || null, scriptVersion || null);
            // уведомление админу
            const uname = duolingoUsername || duolingoUserId;
            bot.api.sendMessage(config.adminTgId,
              `🆕 <b>Новый пользователь скрипта</b>\n\n` +
              `👤 <b>${uname}</b>\n` +
              `🔗 <a href="https://www.duolingo.com/profile/${encodeURIComponent(uname)}">Профиль</a>\n` +
              `🆔 <code>${duolingoUserId}</code>\n` +
              `📅 ${new Date().toLocaleString("ru")}`,
              { parse_mode: "HTML" }
            ).catch(() => {});
          } else {
            if (duolingoUsername) {
              db.prepare("UPDATE script_installs SET username = ? WHERE duolingo_user_id = ?").run(duolingoUsername, String(duolingoUserId));
            }
            if (scriptVersion) {
              db.prepare("UPDATE script_installs SET version = ? WHERE duolingo_user_id = ?").run(String(scriptVersion), String(duolingoUserId));
            }
          }
        } catch {}
        // обновляем имя в users + уведомление при смене
        try {
          if (duolingoUsername) {
            const prevUser = db.prepare("SELECT duolingo_username FROM users WHERE duolingo_user_id = ?").get(String(duolingoUserId));
            const oldName = prevUser ? prevUser.duolingo_username : null;
            if (oldName && oldName !== duolingoUsername) {
              // имя сменилось — уведомление админу
              bot.api.sendMessage(config.adminTgId,
                `✏️ <b>Смена имени Duolingo</b>\n\n` +
                `Было: <b>${oldName}</b>\n` +
                `Стало: <b>${duolingoUsername}</b>\n` +
                `🆔 <code>${duolingoUserId}</code>\n` +
                `📅 ${new Date().toLocaleString("ru")}`,
                {
                  parse_mode: "HTML",
                  reply_markup: {
                    inline_keyboard: (prevUser && prevUser.tg_user_id) ? [[
                      { text: "🚫 Забанить", callback_data: "ban_user_" + prevUser.tg_user_id },
                    ]] : [],
                  },
                }
              ).catch(() => {});
            }
            db.prepare("UPDATE users SET duolingo_username = ? WHERE duolingo_user_id = ?").run(duolingoUsername, String(duolingoUserId));
          }
        } catch {}

        // сохраняем записи xpLog в user_stats.
        // total_xp пишем только для последней даты (реальный итог Duolingo);
        // исторические строки не пересчитываем — старый расчёт «итог минус поздние xp»
        // сдвигал базу дня и раздувал дневной XP. Неделя/день считаются из разниц total_xp.
        if (Array.isArray(xpLog)) {
          const entries = xpLog.filter((e) => e && e.date).sort((a, b) => (a.date < b.date ? -1 : 1));
          const total = totalXp != null ? Number(totalXp) : null;
          for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            const entryXp = Number(entry.xp) || 0;
            const isLatest = i === entries.length - 1;
            db.prepare(`
              INSERT INTO user_stats (duolingo_user_id, date, xp, streak, total_xp)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(duolingo_user_id, date) DO UPDATE SET
                xp = excluded.xp,
                streak = COALESCE(excluded.streak, user_stats.streak),
                total_xp = COALESCE(excluded.total_xp, user_stats.total_xp)
            `).run(String(duolingoUserId), entry.date, entryXp, isLatest ? (streak ?? null) : null, isLatest ? total : null);
          }
        }
        // незакрытые действия бота → в историю скрипта (undo там)
        let pendingActions = [];
        try {
          pendingActions = db.prepare(
            "SELECT type, ids, name, ts FROM action_log WHERE duolingo_user_id = ? AND delivered = 0 ORDER BY id ASC LIMIT 50"
          ).all(String(duolingoUserId)).map((r) => ({
            type: r.type,
            ids: JSON.parse(r.ids || "[]"),
            name: r.name || "",
            ts: r.ts,
          }));
          if (pendingActions.length) {
            db.prepare("UPDATE action_log SET delivered = 1 WHERE duolingo_user_id = ? AND delivered = 0").run(String(duolingoUserId));
          }
        } catch {}
        // события подписок → в «Изменения» скрипта
        let pendingChanges = [];
        try {
          pendingChanges = db.prepare(
            "SELECT kind, user_id AS userId, username, name, ts FROM pending_changes WHERE duolingo_user_id = ? AND delivered = 0 ORDER BY id ASC LIMIT 50"
          ).all(String(duolingoUserId));
          if (pendingChanges.length) {
            db.prepare("UPDATE pending_changes SET delivered = 1 WHERE duolingo_user_id = ? AND delivered = 0").run(String(duolingoUserId));
          }
        } catch {}
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, synced: Array.isArray(xpLog) ? xpLog.length : 0, pendingActions, pendingChanges }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

const HTTP_PORT = config.httpPort;

// автоочистка старых кодов линковки (раз в 30 дней)
function cleanupOldLinkCodes() {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const result = db.prepare("DELETE FROM link_codes WHERE expires_at < ?").run(cutoff);
  if (result.changes > 0) {
    console.log(`[bot] Cleaned ${result.changes} old link codes`);
  }
}
cleanupOldLinkCodes();
// проверяем раз в день (30 дней не влезает в 32-битный setInterval)
setInterval(cleanupOldLinkCodes, 24 * 60 * 60 * 1000);

// === Фоновые уведомления ===
// 1) «Пора позаниматься» — в 23:00 по таймзоне аккаунта, если серия сегодня не продлена
async function checkPracticeReminders() {
  const rows = db.prepare(`
    SELECT u.tg_user_id, u.duolingo_user_id, u.jwt_encrypted, u.timezone
    FROM users u
    WHERE u.tg_user_id IS NOT NULL
      AND u.tg_user_id NOT IN (SELECT tg_user_id FROM banned_users)
  `).all();
  const now = new Date();
  for (const u of rows) {
    try {
      const prefs = getNotifyPrefs(u.tg_user_id);
      if (!prefs.remind_practice) continue;
      let tz = u.timezone;
      // ранняя отсечка по кешированной таймзоне
      if (tz && Number(tzParts(tz, now).hour) < 21) continue;
      if (tz && prefs.last_reminder_date === dateStrInTz(tz, now)) continue;
      const jwt = decryptJWT(u.jwt_encrypted);
      if (!jwt) continue;
      const res = await fetch(
        `https://www.duolingo.com/2017-06-30/users/${u.duolingo_user_id}?fields=timezone,streakData`,
        { headers: { accept: "application/json", cookie: `jwt_token=${jwt}` } }
      );
      const d = await res.json();
      if (!tz) {
        tz = d.timezone || "Europe/Moscow";
        db.prepare("UPDATE users SET timezone = ? WHERE tg_user_id = ?").run(tz, u.tg_user_id);
      }
      const todayUser = dateStrInTz(tz, now);
      if (Number(tzParts(tz, now).hour) < 21) continue;
      if (prefs.last_reminder_date === todayUser) continue;
      const lastExt = d.streakData && d.streakData.currentStreak && d.streakData.currentStreak.lastExtendedDate;
      if (lastExt && lastExt >= todayUser) {
        // уже занимался — больше не проверяем сегодня
        markReminder(u.tg_user_id, todayUser);
        continue;
      }
      await bot.api.sendMessage(u.tg_user_id,
        "🔥 <b>Пора позаниматься!</b>\n\nСегодня вы ещё не занимались. Позанимайся либо получи XP, чтобы не потерять серию.",
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[
              { text: "🎁 Получить XP", callback_data: "xp_get" },
              { text: "🌐 Открыть сайт", url: "https://www.duolingo.com" },
            ]],
          },
        }
      ).catch(() => {});
      markReminder(u.tg_user_id, todayUser);
    } catch {}
  }
}

// 2) «Обход в лиге» — по снапшоту таблицы, уведомляем только на пересечении
async function checkLeagueOvertakes() {
  const rows = db.prepare(`
    SELECT u.tg_user_id, u.duolingo_user_id, u.jwt_encrypted
    FROM users u
    WHERE u.tg_user_id IS NOT NULL
      AND u.tg_user_id NOT IN (SELECT tg_user_id FROM banned_users)
  `).all();
  for (const u of rows) {
    try {
      const prefs = getNotifyPrefs(u.tg_user_id);
      if (!prefs.league_overtake) continue;
      const jwt = decryptJWT(u.jwt_encrypted);
      if (!jwt) continue;
      const res = await fetch(
        "https://duolingo-leaderboards-prod.duolingo.com/leaderboards/7d9f5dd1-8423-491a-91f2-2532052038ce/users/" + u.duolingo_user_id + "?client_unlocked=true&get_reactions=true&_=" + Date.now(),
        { headers: { accept: "application/json", cookie: `jwt_token=${jwt}`, authorization: `Bearer ${jwt}` } }
      );
      const d = await res.json();
      const rankings = (d && d.active && d.active.cohort && d.active.cohort.rankings) || [];
      const myId = String(u.duolingo_user_id);
      const myIdx = rankings.findIndex((r) => String(r.user_id) === myId);
      if (myIdx < 0) continue;
      const myScore = Number(rankings[myIdx].score);
      let prev = null;
      try {
        const snap = db.prepare("SELECT data FROM league_snapshot WHERE duolingo_user_id = ?").get(myId);
        prev = snap ? JSON.parse(snap.data || "null") : null;
      } catch {}
      if (prev && typeof prev === "object") {
        const prevMy = Number(prev.__my != null ? prev.__my : myScore);
        const overtakers = [];
        for (let i = 0; i < myIdx; i++) {
          const r = rankings[i];
          const prevScore = prev[String(r.user_id)] != null ? Number(prev[String(r.user_id)]) : null;
          // был наравне или ниже меня, теперь выше
          if (prevScore != null && prevScore <= prevMy && Number(r.score) > myScore) {
            const gap = Number(r.score) - myScore;
            overtakers.push({ name: r.display_name || String(r.user_id), gap });
          }
        }
        if (overtakers.length) {
          const place = myIdx + 1;
          const text = (overtakers.length === 1
            ? `🏆 <b>Тебя обогнал ${escapeHtml(overtakers[0].name)}</b>\nНа ${Number(overtakers[0].gap).toLocaleString("ru")} очков.`
            : `🏆 <b>Тебя обогнали</b>\n\n` + overtakers.map((t) => `${escapeHtml(t.name)} — на ${Number(t.gap).toLocaleString("ru")} очков`).join("\n")) +
            `\n\n📍 Сейчас твоё место в лиге: <b>${place}</b>`;
          await bot.api.sendMessage(u.tg_user_id, text, {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "🎯 Фарм до места", callback_data: "farm_menu" }]] },
          }).catch(() => {});
        }
      }
      // сохраняем снапшот (первый прогон — просто базовая линия)
      const snapObj = { __my: myScore };
      for (const r of rankings) snapObj[String(r.user_id)] = Number(r.score);
      db.prepare(`
        INSERT INTO league_snapshot (duolingo_user_id, data, scanned_at)
        VALUES (?, ?, ?)
        ON CONFLICT(duolingo_user_id) DO UPDATE SET data = excluded.data, scanned_at = excluded.scanned_at
      `).run(myId, JSON.stringify(snapObj), Date.now());
    } catch {}
  }
}

// 3) «Кто подписался / отписался» — дифф подписчиков со снапшотом
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function profileLink(f) {
  const label = escapeHtml(f.name || f.username || f.id);
  return f.username
    ? `<a href="https://www.duolingo.com/profile/${encodeURIComponent(f.username)}">${label}</a>`
    : label;
}

function insertPendingChange(duoId, kind, f, ts) {
  try {
    db.prepare("INSERT INTO pending_changes (duolingo_user_id, kind, user_id, username, name, ts) VALUES (?, ?, ?, ?, ?, ?)")
      .run(String(duoId), kind, String(f.id), f.username || "", f.name || "", ts);
  } catch {}
}

async function checkFollowChanges() {
  const rows = db.prepare(`
    SELECT u.tg_user_id, u.duolingo_user_id, u.jwt_encrypted
    FROM users u
    WHERE u.tg_user_id IS NOT NULL
      AND u.tg_user_id NOT IN (SELECT tg_user_id FROM banned_users)
  `).all();
  for (const u of rows) {
    try {
      const prefs = getNotifyPrefs(u.tg_user_id);
      if (!prefs.follow_changes) continue;
      const jwt = decryptJWT(u.jwt_encrypted);
      if (!jwt) continue;
      const followers = await fetchUserList(jwt, u.duolingo_user_id, "followers");
      const cur = new Map(followers.map((f) => [String(f.userId), f]));
      const myId = String(u.duolingo_user_id);
      let prev = null;
      try {
        const snap = db.prepare("SELECT data FROM friends_snapshot WHERE duolingo_user_id = ?").get(myId);
        prev = snap ? JSON.parse(snap.data || "null") : null;
      } catch {}
      const snapObj = {};
      for (const [id, f] of cur) snapObj[id] = { username: f.username || "", name: f.name || "" };
      db.prepare(`
        INSERT INTO friends_snapshot (duolingo_user_id, data, scanned_at)
        VALUES (?, ?, ?)
        ON CONFLICT(duolingo_user_id) DO UPDATE SET data = excluded.data, scanned_at = excluded.scanned_at
      `).run(myId, JSON.stringify(snapObj), Date.now());
      if (!prev || typeof prev !== "object") continue; // первый прогон — базовая линия
      const prevIds = new Set(Object.keys(prev));
      const followed = [];
      const unfollowed = [];
      for (const [id, f] of cur) {
        if (!prevIds.has(id)) followed.push({ id, username: f.username || "", name: f.name || f.username || id });
      }
      for (const id of prevIds) {
        if (!cur.has(id)) {
          const p = prev[id] || {};
          unfollowed.push({ id, username: p.username || "", name: p.name || p.username || id });
        }
      }
      if (!followed.length && !unfollowed.length) continue;
      // одним сообщением, со ссылками на профили
      const all = [
        ...followed.map((f) => ({ f, line: `✅ ${profileLink(f)} подписался` })),
        ...unfollowed.map((f) => ({ f, line: `❌ ${profileLink(f)} отписался` })),
      ];
      const shown = all.slice(0, 20);
      const hidden = all.length - shown.length;
      const text = `👥 <b>Изменения</b>\n\n` + shown.map((s) => s.line).join("\n") + (hidden > 0 ? `\n…и ещё ${hidden}` : "");
      await bot.api.sendMessage(u.tg_user_id, text, { parse_mode: "HTML" }).catch(() => {});
      // события → в «Изменения» скрипта (с дедупом на его стороне)
      const now = Date.now();
      for (const f of followed) insertPendingChange(myId, "followed_me", f, now);
      for (const f of unfollowed) insertPendingChange(myId, "unfollowed_me", f, now);
    } catch {}
  }
}

// 4) «Дайджест» — воскресенье 20:00 по таймзоне аккаунта
async function checkWeeklyDigest() {
  const rows = db.prepare(`
    SELECT u.tg_user_id, u.duolingo_user_id, u.jwt_encrypted, u.timezone, u.linked_at
    FROM users u
    WHERE u.tg_user_id IS NOT NULL
      AND u.tg_user_id NOT IN (SELECT tg_user_id FROM banned_users)
  `).all();
  const now = new Date();
  for (const u of rows) {
    try {
      const prefs = getNotifyPrefs(u.tg_user_id);
      if (!prefs.digest) continue;
      let tz = u.timezone;
      if (!tz) {
        const jwt0 = decryptJWT(u.jwt_encrypted);
        if (!jwt0) continue;
        const r0 = await fetch(
          `https://www.duolingo.com/2017-06-30/users/${u.duolingo_user_id}?fields=timezone`,
          { headers: { accept: "application/json", cookie: `jwt_token=${jwt0}` } }
        );
        const d0 = await r0.json();
        tz = d0.timezone || "Europe/Moscow";
        db.prepare("UPDATE users SET timezone = ? WHERE tg_user_id = ?").run(tz, u.tg_user_id);
      }
      const todayUser = dateStrInTz(tz, now);
      if (weekdayOfDateStr(todayUser) !== 0) continue; // только воскресенье
      if (Number(tzParts(tz, now).hour) < 20) continue;
      if (prefs.last_digest_date === todayUser) continue;

      // период: с max(понедельник недели, дата привязки)
      const monday = mondayStrOf(todayUser);
      const linked = String(u.linked_at || "").slice(0, 10);
      const start = linked && linked > monday ? linked : monday;
      const startMs = new Date(start + "T00:00:00").getTime();

      // подписчики — из снапшота проверки подписок
      let followers = null;
      try {
        const snap = db.prepare("SELECT data FROM friends_snapshot WHERE duolingo_user_id = ?").get(String(u.duolingo_user_id));
        const obj = snap ? JSON.parse(snap.data || "null") : null;
        if (obj && typeof obj === "object") followers = Object.keys(obj).length;
      } catch {}

      // подписки/отписки за период
      let followed = 0;
      let unfollowed = 0;
      try {
        const rc = db.prepare(
          "SELECT kind, COUNT(*) AS n FROM pending_changes WHERE duolingo_user_id = ? AND ts >= ? GROUP BY kind"
        ).all(String(u.duolingo_user_id), startMs);
        for (const r of rc) {
          if (r.kind === "followed_me") followed = Number(r.n) || 0;
          if (r.kind === "unfollowed_me") unfollowed = Number(r.n) || 0;
        }
      } catch {}

      // XP за неделю — из разниц итогов total_xp (fallback — SUM(xp)), и накручено
      let weekXp = 0;
      try {
        const inWin = db.prepare("SELECT total_xp FROM user_stats WHERE duolingo_user_id = ? AND date >= ? AND total_xp IS NOT NULL ORDER BY date DESC LIMIT 1")
          .get(String(u.duolingo_user_id), start);
        const base = db.prepare("SELECT total_xp FROM user_stats WHERE duolingo_user_id = ? AND date < ? AND total_xp IS NOT NULL ORDER BY date DESC LIMIT 1")
          .get(String(u.duolingo_user_id), start);
        if (inWin && base) {
          weekXp = Number(inWin.total_xp) - Number(base.total_xp);
        } else {
          const r = db.prepare("SELECT SUM(xp) AS s FROM user_stats WHERE duolingo_user_id = ? AND date >= ?")
            .get(String(u.duolingo_user_id), start);
          weekXp = Number(r && r.s) || 0;
        }
      } catch {}
      let farmedXp = 0;
      try {
        const r = db.prepare("SELECT SUM(amount) AS s FROM xp_farm_log WHERE duolingo_user_id = ? AND ts >= ?")
          .get(String(u.duolingo_user_id), startMs);
        farmedXp = Number(r && r.s) || 0;
      } catch {}

      // активность по последнему скану
      let actBlock = "📊 <i>Активность: нет данных — запустите «🔍 Активность» в разделе «👥 Друзья».</i>";
      try {
        const scan = loadFriendScan(u.duolingo_user_id);
        const items = scan ? (scan.items || []) : [];
        if (items.length) {
          const scanRow = db.prepare("SELECT scanned_at FROM friend_scan WHERE duolingo_user_id = ?").get(String(u.duolingo_user_id));
          const scanned = scanRow ? new Date(scanRow.scanned_at) : null;
          const active = items.filter((i) => Number(i.inactiveDays) < 7).length;
          const inactive = items.length - active;
          const scanDate = scanned
            ? `${scanned.getDate()}.${String(scanned.getMonth() + 1).padStart(2, "0")}`
            : "?";
          actBlock =
            `📊 <i>Активность (по проверке от ${scanDate}):</i>\n` +
            `✅ Активны: <b>${active}</b> · 💤 Неактивны (7+ дн.): <b>${inactive}</b>`;
        }
      } catch {}

      const net = followed - unfollowed;
      const netStr = net > 0 ? ` (+${net})` : net < 0 ? ` (−${Math.abs(net)})` : "";
      const text =
        `📬 <b>Дайджест за неделю (${fmtRange(start, todayUser)})</b>\n\n` +
        `👥 Подписчиков: <b>${followers == null ? "—" : followers}</b>${netStr}\n` +
        `🔄 Подписался: +${followed} · Отписался: −${unfollowed}\n` +
        `⚡ XP за неделю: <b>${fmtSigned(weekXp)}</b>\n` +
        `🎁 Из них накручено XP: <b>+${Number(farmedXp).toLocaleString("ru")}</b>\n\n` +
        actBlock;

      await bot.api.sendMessage(u.tg_user_id, text, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "💝 Донат", callback_data: "donate_menu" }]] },
      }).catch(() => {});
      prefs.last_digest_date = todayUser;
      upsertNotifyPrefs(u.tg_user_id, prefs);
    } catch {}
  }
}

// 5) «Обновления скрипта» — версия с GitHub
async function checkScriptUpdates() {
  try {
    const res = await fetch("https://raw.githubusercontent.com/Vidrimers/Duolingo-helper/master/duo-helper.user.js");
    const text = await res.text();
    const m = text.match(/\/\/\s*@version\s+([0-9]+\.[0-9]+\.[0-9]+)/);
    if (!m) return;
    const version = m[1];
    const row = db.prepare("SELECT value FROM bot_kv WHERE key = ?").get("notified_version");
    const last = row ? row.value : null;
    if (last === version) return;
    if (last && cmpVersion(version, last) <= 0) {
      db.prepare("INSERT OR REPLACE INTO bot_kv (key, value) VALUES (?, ?)").run("notified_version", version);
      return;
    }
    if (last) {
      const users = db.prepare(`
        SELECT u.tg_user_id FROM users u
        WHERE u.tg_user_id IS NOT NULL
          AND u.tg_user_id NOT IN (SELECT tg_user_id FROM banned_users)
      `).all();
      for (const u of users) {
        const prefs = getNotifyPrefs(u.tg_user_id);
        if (!prefs.script_updates) continue;
        await bot.api.sendMessage(u.tg_user_id,
          `🚀 <b>Доступно обновление Duolingo Helper v${version}</b>`,
          {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "📦 Установить", url: "https://raw.githubusercontent.com/Vidrimers/Duolingo-helper/master/duo-helper.user.js" }]] },
          }
        ).catch(() => {});
      }
    }
    // первый прогон — фиксируем текущую версию без оповещений
    db.prepare("INSERT OR REPLACE INTO bot_kv (key, value) VALUES (?, ?)").run("notified_version", version);
  } catch {}
}

checkPracticeReminders();
setInterval(checkPracticeReminders, 15 * 60 * 1000);
checkLeagueOvertakes();
setInterval(checkLeagueOvertakes, 30 * 60 * 1000);
checkFollowChanges();
setInterval(checkFollowChanges, 30 * 60 * 1000);
checkWeeklyDigest();
setInterval(checkWeeklyDigest, 30 * 60 * 1000);
checkScriptUpdates();
setInterval(checkScriptUpdates, 6 * 60 * 60 * 1000);

// бэкфилл: существующие пользователи → script_installs
try {
  db.prepare(`
    INSERT OR IGNORE INTO script_installs (duolingo_user_id, username)
    SELECT duolingo_user_id, duolingo_username FROM users WHERE duolingo_user_id IS NOT NULL
  `).run();
  console.log("[bot] script_installs backfilled");
} catch {}

// обработка ошибок — чтобы бот не падал
bot.catch = (err) => {
  console.error("[bot] Error:", err.message || err);
};

// запуск
bot.start({
  onStart: async (me) => {
    console.log(`[bot] Started as @${me.username}`);
    console.log(`[bot] Admin: ${config.adminTgId}`);
    // меню команд (кнопка рядом с полем ввода)
    await bot.api.setMyCommands([
      { command: "start", description: "Главное меню" },
      { command: "help", description: "Справка" },
      { command: "status", description: "Статус привязки" },
      { command: "bugreport", description: "Сообщить об ошибке" },
      { command: "unlink", description: "Отвязать аккаунт" },
    ]);
    // уведомление админу о старте
    try {
      await bot.api.sendMessage(config.adminTgId, "🟢 Бот запущен и готов к работе.");
    } catch {}
    httpServer.listen(HTTP_PORT, () => {
      console.log(`[bot] HTTP API on port ${HTTP_PORT}`);
    });
  },
});

// уведомление админу об остановке
async function notifyStop() {
  try {
    await bot.api.sendMessage(config.adminTgId, "🔴 Бот остановлен.");
  } catch {}
}
process.on("SIGINT", async () => {
  await notifyStop();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await notifyStop();
  process.exit(0);
});
