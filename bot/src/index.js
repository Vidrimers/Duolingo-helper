import { Bot } from "grammy";
import { createServer } from "http";
import { randomBytes } from "crypto";
import { config } from "./config.js";
import db from "./db.js";
import { encryptJWT, decryptJWT } from "./crypto.js";

const bot = new Bot(config.tgBotToken);

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
      { text: "🏷 Метки", callback_data: "action_tags" },
    ],
    [{ text: "⚙️ Настройки", callback_data: "menu_settings" }],
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
function renderBanList(ctx, page) {
  const perPage = 10;
  const total = db.prepare("SELECT COUNT(*) as n FROM banned_users").get().n;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const p = Math.max(1, Math.min(page, totalPages));
  const rows = db.prepare("SELECT * FROM banned_users ORDER BY banned_at DESC LIMIT ? OFFSET ?").all(perPage, (p - 1) * perPage);

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

  ctx.editMessageText(text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: kb },
  }).catch(() => {});
}

function adminMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📊 Статистика бота", callback_data: "admin_stats" },
        { text: "👥 Пользователи", callback_data: "admin_users" },
      ],
      [
        { text: "🚫 Бан-лист", callback_data: "admin_banlist" },
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
          const today = new Date().toISOString().slice(0, 10);
          if (lastExtended >= today) todayStatus = "✅ <i>Занимался</i>";
        }
      } catch {}

      // записываем дневной XP (не затираем синхронизированные данные)
      const today = new Date().toISOString().slice(0, 10);
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
      const weekStart = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
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

      const msg =
        `📊 <b>Статистика</b>\n\n` +
        `👤 <b>${name}</b> · <code>${user.duolingo_user_id}</code>\n\n` +
        `⚡ <b>XP:</b> ${Number(totalXp).toLocaleString("ru")}\n` +
        `🔥 <b>Streak:</b> ${streak} дней\n` +
        `📅 <b>Сегодня:</b> ${todayStatus}\n` +
        `⚡ <b>Сегодня:</b> +${Number(todayXp).toLocaleString("ru")}\n` +
        `📅 <b>Неделя:</b> +${Number(weekXp).toLocaleString("ru")}` + chart;

      await ctx.editMessageText(msg, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "← Назад", callback_data: "menu_main" }]] },
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
    });
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
    renderBanList(ctx, page);
    return;
  }

  // бан-лист
  if (data === "admin_banlist" || data.startsWith("banlist_page_")) {
    if (ctx.from.id !== config.adminTgId) { await ctx.answerCallbackQuery("⛔ Нет доступа"); return; }
    const page = data.startsWith("banlist_page_") ? parseInt(data.replace("banlist_page_", ""), 10) : 1;
    renderBanList(ctx, page);
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

  // заглушки — «в разработке»
  const stubs = {
    action_friends: "👥 Друзья",
    action_tags: "🏷 Метки",
    settings_notify: "🔔 Уведомления",
    settings_backup: "☁️ Бэкап",
    settings_link: "🔗 Линковка",
    settings_help: "📋 Помощь",
    admin_users: "👥 Пользователи",
    admin_cleanup: "🗑 Очистка данных",
    admin_logs: "📋 Логи",
  };
  if (data === "noop") {
    await ctx.answerCallbackQuery();
    return;
  }
  if (stubs[data]) {
    await ctx.editMessageText(stubs[data] + "\n\n⏳ В разработке…", {
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
            db.prepare("INSERT OR IGNORE INTO script_installs (duolingo_user_id) VALUES (?)").run(String(duolingoUserId));
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
