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
      [
        { text: "🔔 Уведомления", callback_data: "settings_notify" },
        { text: "☁️ Бэкап", callback_data: "settings_backup" },
      ],
      [
        { text: "🔗 Линковка", callback_data: "settings_link" },
        { text: "📋 Помощь", callback_data: "settings_help" },
      ],
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

  // определяем, занимался ли сегодня
  let todayStatus = "⚠️ <i>Ещё нет</i>";
  try {
    const lastExtended = d.streakData?.currentStreak?.lastExtendedDate;
    if (lastExtended) {
      const today = localDateStr();
      if (lastExtended >= today) todayStatus = "✅ <i>Занимался</i>";
    }
  } catch {}

  // записываем дневной XP (не затираем синхронизированные данные)
  const today = localDateStr();
  const prev = db.prepare("SELECT total_xp FROM user_stats WHERE duolingo_user_id = ? AND date < ? ORDER BY date DESC LIMIT 1").get(user.duolingo_user_id, today);
  const dayXp = prev ? Math.max(0, totalXp - prev.total_xp) : 0;
  db.prepare(`
    INSERT INTO user_stats (duolingo_user_id, date, xp, streak, total_xp)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(duolingo_user_id, date) DO UPDATE SET
      xp = MAX(user_stats.xp, excluded.xp),
      streak = COALESCE(excluded.streak, user_stats.streak),
      total_xp = COALESCE(excluded.total_xp, user_stats.total_xp)
  `).run(user.duolingo_user_id, today, dayXp, streak, totalXp);

  // сегодня / неделя из user_stats
  const todayRow = db.prepare("SELECT xp FROM user_stats WHERE duolingo_user_id = ? AND date = ?").get(user.duolingo_user_id, today);
  const weekStart = localDateStr(new Date(Date.now() - 7 * 86400000));
  const weekRow = db.prepare("SELECT SUM(xp) as total FROM user_stats WHERE duolingo_user_id = ? AND date >= ?").get(user.duolingo_user_id, weekStart);
  const todayXp = todayRow ? todayRow.xp : 0;
  const weekXp = weekRow && weekRow.total ? weekRow.total : 0;

  // график за 7 дней
  const days = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
  const statsRows = db.prepare("SELECT date, xp FROM user_stats WHERE duolingo_user_id = ? ORDER BY date DESC LIMIT 7").all(user.duolingo_user_id);
  let chart = "";
  if (statsRows.length > 0) {
    const maxXp = Math.max(1, ...statsRows.map((r) => r.xp));
    const revRows = [...statsRows].reverse();
    chart = "\n\n📈 <b>XP за 7 дней:</b>\n<pre>";
    for (const r of revRows) {
      const d = new Date(r.date + "T12:00:00");
      const dayLabel = days[d.getDay()];
      const barLen = Math.round((r.xp / maxXp) * 12);
      const bar = "█".repeat(barLen) + "░".repeat(12 - barLen);
      chart += `${dayLabel} ${bar} ${Number(r.xp).toLocaleString("ru")}\n`;
    }
    chart += "</pre>";
  }

  return (
    `📊 <b>Статистика</b>\n\n` +
    `👤 <b>${name}</b> · <code>${user.duolingo_user_id}</code>\n\n` +
    `⚡ <b>XP:</b> ${Number(totalXp).toLocaleString("ru")}\n` +
    `🔥 <b>Streak:</b> ${streak} дней\n` +
    `📅 <b>Сегодня:</b> ${todayStatus}\n` +
    `⚡ <b>Сегодня:</b> +${Number(todayXp).toLocaleString("ru")}\n` +
    `📅 <b>Неделя:</b> +${Number(weekXp).toLocaleString("ru")}` + chart
  );
}

function statsKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🎁 Получить XP", callback_data: "xp_get" }],
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
    await ctx.editMessageText(
      `📊 <b>Статистика бота</b>\n\n` +
      `🔗 Привязок Telegram: <b>${userCount}</b>\n` +
      `📦 Установок скрипта: <b>${installCount}</b>\n` +
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
      text += `   📅 ${r.first_seen}\n\n`;
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

  // === XP БУСТ ===
  if (data === "xp_get") {
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

  // заглушки — «в разработке»
  const stubs = {
    action_friends: "👥 Друзья",
    settings_notify: "🔔 Уведомления",
    settings_backup: "☁️ Бэкап",
    settings_link: "🔗 Линковка",
    settings_help: "📋 Помощь",
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
  // TODO: подтверждение через inline-кнопки
  db.prepare("DELETE FROM users WHERE tg_user_id = ?").run(tgId);
  db.prepare("DELETE FROM backups WHERE duolingo_user_id = ?").run(user.duolingo_user_id);
  ctx.reply("✅ Аккаунт отвязан. Бэкапы удалены.");
});

// /bugreport — отправка бага
const bugReportState = new Map(); // tg_id -> "waiting"
const bugReplyState = new Map(); // tg_id -> bugId
const xpAmountState = new Map(); // tg_id -> "waiting" (ждём количество XP)
const xpRunning = new Set(); // tg_id — накрутка уже идёт
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
        db.prepare("DELETE FROM users WHERE duolingo_user_id = ?").run(String(duolingoUserId));
        db.prepare("DELETE FROM backups WHERE duolingo_user_id = ?").run(String(duolingoUserId));
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
        const { duolingoUserId, xpLog, totalXp, streak } = JSON.parse(body || "{}");
        if (!duolingoUserId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "duolingoUserId required" }));
          return;
        }
        // проверяем: новый ли это пользователь (установка скрипта)
        try {
          const existing = db.prepare("SELECT duolingo_user_id FROM script_installs WHERE duolingo_user_id = ?").get(String(duolingoUserId));
          if (!existing) {
            db.prepare("INSERT OR IGNORE INTO script_installs (duolingo_user_id, username) VALUES (?, ?)").run(String(duolingoUserId), duolingoUsername || null);
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
          } else if (duolingoUsername) {
            // обновляем имя если сменилось
            db.prepare("UPDATE script_installs SET username = ? WHERE duolingo_user_id = ?").run(duolingoUsername, String(duolingoUserId));
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

        // сохраняем записи xpLog в user_stats
        if (Array.isArray(xpLog)) {
          for (const entry of xpLog) {
            if (!entry || !entry.date) continue;
            db.prepare(`
              INSERT INTO user_stats (duolingo_user_id, date, xp, streak, total_xp)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(duolingo_user_id, date) DO UPDATE SET
                xp = MAX(user_stats.xp, excluded.xp),
                streak = COALESCE(excluded.streak, user_stats.streak),
                total_xp = COALESCE(excluded.total_xp, user_stats.total_xp)
            `).run(String(duolingoUserId), entry.date, Number(entry.xp) || 0, streak ?? null, totalXp ?? null);
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, synced: Array.isArray(xpLog) ? xpLog.length : 0 }));
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
