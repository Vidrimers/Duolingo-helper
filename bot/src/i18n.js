// Словари интерфейса бота. Админка НЕ переводится (только русский).
// Язык: users.lang ("en" | иначе "ru"); ru — fallback, чтобы старые пользователи
// не переключились на английский до первой синхронизации из скрипта.
const RU = "ru";
const EN = "en";

const dicts = {
  ru: {
    // общее
    "common.back": "← Назад",
    "common.backToMenu": "← В меню",
    "common.backToStats": "← В статистику",
    "common.backToDoante": "← Назад к донатам",
    "common.cancel": "✖ Отмена",
    "common.error": "❌ Ошибка",
    "common.banned": "⛔ Вы заблокированы.",
    "common.development": "⏳ В разработке…",
    // меню
    "menu.brand": "🦉 <b>Duolingo Helper</b>\n\n",
    "menu.notLinked": "❌ Аккаунт не привязан\n\n",
    "menu.choose": "Выберите действие:",
    "menu.stats": "📊 Статистика",
    "menu.friends": "👥 Друзья",
    "menu.league": "🏆 Лига",
    "menu.settings": "⚙️ Настройки",
    "menu.bugreport": "🐛 Багрепорт",
    "menu.openSite": "🌐 Открыть сайт",
    "menu.donate": "💝 Донат",
    // настройки
    "settings.title": "⚙️ Настройки\n\nВыберите раздел:",
    "settings.notify": "🔔 Уведомления",
    "settings.link": "🔗 Линковка",
    "settings.notLinked": "❌ Аккаунт не привязан\n\nВыберите действие:",
    // уведомления (тумблеры)
    "notify.title": "🔔 <b>Уведомления</b>\n\nВыберите, что уведомлять:",
    "notify.practice": "🔥 Пора позаниматься: {flag}",
    "notify.league": "🏆 Обход в лиге: {flag}",
    "notify.follows": "👥 Кто подписался / отписался: {flag}",
    "notify.digest": "📬 Дайджест: {flag}",
    "notify.updates": "🚀 Обновления скрипта: {flag}",
    // статистика
    "stats.head": "📊 <b>Статистика</b>\n\n",
    "stats.xp": "⚡ <b>XP:</b> {n}",
    "stats.notLinked": "📊 Статистика\n\n❌ Аккаунт не привязан или JWT отсутствует.",
    "stats.loading": "📊 <b>Статистика</b>\n\n⏳ Загрузка…",
    "stats.error": "📊 <b>Статистика</b>\n\n❌ Ошибка загрузки данных.",
    "stats.todayNone": "⚠️ <i>Ещё нет</i>",
    "stats.todayDone": "✅ <i>Занимался</i>",
    "stats.chart": "\n\n📈 <b>XP за 7 дней:</b>\n<pre>",
    "stats.leagueXp": "🏆 <b>XP в лиге:</b> {n}",
    "stats.streakDays": "🔥 <b>Streak:</b> {n} дней",
    "stats.todayStatus": "📅 <b>Сегодня:</b> {s}",
    "stats.todayXp": "⚡ <b>Сегодня:</b> {n}",
    "stats.weekXp": "📅 <b>Неделя:</b> {n}",
    "stats.getXp": "🎁 Получить XP",
    "stats.streakBtn": "🔥 Серия дней",
    "days.0": "Вс",
    "days.1": "Пн",
    "days.2": "Вт",
    "days.3": "Ср",
    "days.4": "Чт",
    "days.5": "Пт",
    "days.6": "Сб",
    // лига
    "league.notLinked": "🏆 Лига\n\n❌ Аккаунт не привязан.",
    "league.loading": "🏆 <b>Лига</b>\n\n⏳ Загрузка…",
    "league.error": "🏆 <b>Лига</b>\n\n❌ Ошибка загрузки.",
    "league.title": "🏆 <b>Лига</b>\n\n",
    "league.you": "← ты",
    "league.myPlace": "Твоё место: <b>{n}</b>",
    "league.farmTo": "🎯 Фарм до места",
    "league.refresh": "🔄 Обновить",
    "leagueFarm.intro": "🎯 <b>Фарм до места</b>\n\nЭта функция поможет тебе подняться в лиге — бот будет накручивать XP, пока не достигнешь выбранного места.\n\nТвоё место: <b>{rank}</b>\nВыберите целевое место:",
    "leagueFarm.start": "🎯 <b>Фарм до места {n}</b>\n\n⏳ Начинаю…",
    "leagueFarm.done": "✅ <b>Цель достигнута!</b> Место: <b>{n}</b>\n\n🏆 <b>Лига</b>\n\n",
    "leagueFarm.progress": "🎯 <b>Фарм до места {n}</b>\n\n⚡ +50 XP · место: <b>{r}</b>\n📊 Текущий XP: <b>{x}</b>\n⏱ Цикл: {i}",
    "leagueFarm.limit": "🎯 <b>Фарм</b>\n\n⚠️ Достигнут лимит итераций.",
    // друзья
    "friends.notLinked": "👥 Друзья\n\n❌ Аккаунт не привязан.",
    "friends.loading": "👥 <b>Друзья</b>\n\n⏳ Загрузка…",
    "friends.error": "👥 <b>Друзья</b>\n\n❌ Ошибка загрузки.",
    "friends.summary": "👥 <b>Друзья</b>\n\nПодписок: <b>{a}</b>\nПодписчиков: <b>{b}</b>\nНе подписаны: <b>{c}</b>",
    "friends.unfNonf": "🚫 Отписаться от неподписанных",
    "friends.activity": "🔍 Активность",
    // отписка от неподписанных
    "unf.title": "🚫 <b>Отписка от неподписанных</b>",
    "unf.noTargets": "🚫 <b>Отписка от неподписанных</b>\n\nНет целей (обновите список друзей).",
    "unf.confirm": "🚫 <b>Отписка от неподписанных</b>\n\nОтписаться от {n} пользователей, которые не подписаны на вас?\nИсключения 🛡 не тронем.",
    "unf.yes": "✅ Да, отписать {n}",
    "unf.notLinked": "❌ Аккаунт не привязан.",
    // блокировка/отписка от неактивных
    "act.titleBlock": "🚫 <b>Блокировка неактивных</b>",
    "act.titleUnf": "🚫 <b>Отписка от неактивных</b>",
    "act.noTargets": "\n\nНет целей.",
    "act.noTargetsScan": "\n\nНет целей (сначала проверьте активность).",
    "act.busy": "\n\n⏳ Действие уже выполняется.",
    "act.progressBlock": "Блокировка",
    "act.progressUnf": "Отписка",
    "act.verbBlock": "Заблокировать",
    "act.verbUnf": "Отписаться от",
    "act.done": "\n\n✅ Готово: {ok} / {n}",
    "act.error": "\n\n❌ Ошибка ({ok} / {n}).",
    "act.confirm": "{verb} {n} неактивных?\nИсключения 🛡 не тронем.",
    "act.yes": "✅ Да, {verb} {n}",
    "act.logNonf": "отписка от {n} неподписанных",
    "act.logBlock": "блокировка {n} неактивных",
    "act.logUnf": "отписка от {n} неактивных",
    // активность (скан)
    "scan.title": "🔍 <b>Активность</b>",
    "scan.needFriends": "🔍 <b>Активность</b>\n\nСначала откройте список друзей.",
    "scan.busy": "🔍 <b>Активность</b>\n\n⏳ Уже выполняется.",
    "scan.progress": "🔍 <b>Активность</b>\n\nПроверка {done}/{total}…",
    "scan.stop": "⏹ Стоп",
    "scan.stopping": "⏹ Останавливаю…",
    "scan.stopped": "🔍 <b>Активность</b>\n\n⏹ Остановлено: проверено <b>{done}</b> из {total}\n{tail}",
    "scan.checked": "🔍 <b>Активность</b>\n\nПроверено: <b>{n}</b>\n{tail}",
    "scan.tail": "Неактивны: <b>{n}</b> (порог {d} дн.)",
    "scan.unfInactive": "🚫 Отписаться от неактивных",
    "scan.blockInactive": "🚫 Заблокировать неактивных",
    "scan.error": "🔍 <b>Активность</b>\n\n❌ Ошибка скана.",
    "scan.thresholdAsk": "🔍 <b>Активность</b>\n\nПорог неактивности, дней:",
    "scan.d7": "7 дн",
    "scan.d14": "14 дн",
    "scan.d30": "30 дн",
    "scan.custom": "✏ Ввести число",
    "scan.customAsk": "✏ <b>Порог неактивности</b>\n\nВведите число дней (1–365):",
    // фарм XP
    "xp.ask": "🎁 <b>Получить XP</b>\n\nВведите количество XP (минимум 50):\n\n⚠️ <i>Накрутка XP — на свой страх и риск, возможна блокировка.</i>",
    "xp.cancelled": "❌ Накрутка отменена.",
    "xp.min50": "❌ Минимум 50 XP. Попробуйте ещё раз:",
    "xp.running": "⏳ Накрутка уже идёт, дождитесь завершения.",
    "xp.noJwt": "❌ Аккаунт не привязан или JWT отсутствует.",
    "xp.progress": "⏳ <b>Идёт накрутка XP…</b>",
    "xp.done": "✅ <b>Готово: +{n} XP</b>\n\n",
    "xp.none": "⚠️ <b>XP не начислены</b>\n\n",
    "xp.error": "❌ Ошибка накрутки XP.",
    // фарм серии
    "streak.ask": "🔥 <b>Накрутка серии</b>\n\nСколько дней накрутить? (минимум 1, максимум 365)\n\n⚠️ <i>Накрутка серии — на свой страх и риск, возможна блокировка.</i>\n⏱ <i>Процесс может занять 5–6 минут.</i>",
    "streak.min1": "❌ Минимум 1 день. Попробуйте ещё раз:",
    "streak.running": "⏳ Накрутка серии уже идёт, дождитесь завершения.",
    "streak.progress": "🔥 <b>Накрутка серии…</b>\n\nДень {d}/{t}… (+{ok}){warn}",
    "streak.tail": "\n\n⏱ <i>Может занять 5–6 минут.</i>",
    "streak.done": "✅ <b>Готово: +{n} дн.</b>\n\n",
    "streak.none": "⚠️ <b>Серия не увеличена</b>\n\n",
    "streak.error": "❌ Ошибка накрутки серии.",
    // багрепорт
    "bug.prompt": "🐛 <b>Багрепорт</b>\n\nОпишите проблему одним сообщением:",
    "bug.cancelled": "❌ Багрепорт отменён.",
    "bug.tooShort": "❌ Сообщение слишком короткое. Попробуйте ещё раз: /bugreport",
    "bug.needLink": "❌ Для отправки багрепорта привяжите аккаунт. Кнопка «Привязать Telegram» в скрипте Duolingo Helper.",
    "bug.tooOften": "⏱ Слишком часто. Попробуйте через {n} мин.",
    "bug.limit": "❌ Достигнут дневной лимит багрепортов (10). Попробуйте завтра.",
    "bug.sent": "✅ <b>Багрепорт отправлен!</b>\n\nМы рассмотрим его в ближайшее время.",
    "bug.accepted": "🔄 Ваш багрепорт принят в работу!",
    "bug.doneMsg": "✅ Ваш багрепорт выполнен!",
    "bug.reply": "💬 Ответ от поддержки:\n\n{text}",
    // линковка
    "link.notLinked": "🔗 <b>Линковка</b>\n\n❌ Аккаунт не привязан.\nИспользуйте кнопку «Привязать Telegram» в скрипте Duolingo Helper.",
    "link.linked": "🔗 <b>Линковка</b>\n\n✅ Аккаунт привязан\n\n👤 <b>{duo}</b> · <code>{duoId}</code>\n📱 @{tg} · <code>{tgId}</code>\n📅 Привязан: {date}",
    "link.unlinkBtn": "🔓 Отвязать аккаунт",
    "link.unlinkConfirm": "🔓 <b>Отвязка аккаунта</b>\n\n⚠️ Отвязать аккаунт?\nВсе данные и настройки будут удалены с сервера:\nстатистика, уведомления, друзья, история действий.",
    "link.unlinkYes": "✅ Да, отвязать",
    "link.unlinked": "✅ Аккаунт отвязан.\n\nВсе данные удалены с сервера.",
    "link.notLinkedShort": "🔗 <b>Линковка</b>\n\n❌ Аккаунт не привязан.",
    "start.noLink": "Привяжи аккаунт через скрипт Duolingo Helper,\nзатем используй кнопки меню.",
    "status.notLinked": "❌ Аккаунт не привязан. Используй кнопку в скрипте Duolingo Helper.",
    "status.linked": "✅ Аккаунт привязан:\n\nDuolingo: {name}\nID: {id}\nПривязан: {date}",
    "unlink.notLinked": "❌ Аккаунт не привязан.",
    "unlink.done": "✅ Аккаунт отвязан. Все данные удалены с сервера.",
    "code.notFound": "❌ Код не найден.",
    "code.used": "❌ Код уже использован.",
    "code.expired": "❌ Код истёк. Получи новый в скрипте.",
    "code.tooMany": "❌ Слишком много попыток.",
    "code.otherAccount": "⚠️ Уже привязан другой Duolingo-аккаунт.\nСначала отвяжи: /unlink",
    "code.success": "✅ Аккаунт привязан!\n\nDuolingo ID: {id}\nТеперь ты получишь доступ к командам бота.",
    "code.duoNotLinked": "❌ Этот Telegram не привязан к данному аккаунту Duolingo. Сначала привяжите аккаунт через скрипт.",
    // донаты
    "donate.answer": "Открываю меню донатов",
    "donate.text": "💝 <b>Поддержать проект</b>\n\nЕсли вам нравится Duolingo Helper и вы хотите поддержать его развитие — вы можете сделать донат.\n\nВаша поддержка помогает:\n• Развивать новые функции\n• Поддерживать стабильную работу\n• Оплачивать серверы бота\n\nВыберите удобный способ доната:",
    "donate.allWays": "🌐 Все способы",
    "donate.walletMissing": "❌ {label} адрес не настроен",
    "donate.addr": "Адрес кошелька:\n<code>{addr}</code>\n\n📋 Нажмите на адрес, чтобы скопировать\n\n{info}",
    "donate.kaspaInfo": "ℹ️ Kaspa — быстрая и масштабируемая криптовалюта с мгновенными транзакциями",
    "donate.tonInfo": "ℹ️ TON — блокчейн от создателей Telegram с низкими комиссиями",
    "donate.usdtInfo": "⚠️ <b>Важно:</b> используйте только сеть TRON (TRC-20)!\nОтправка через другие сети приведёт к потере средств.",
    // уведомления
    "n.practice": "🔥 <b>Пора позаниматься!</b>\n\nСегодня вы ещё не занимались. Позанимайся либо получи XP, чтобы не потерять серию.",
    "n.overtakeOne": "🏆 <b>Тебя обогнал {name}</b>\nНа {n} очков.",
    "n.overtakeMany": "🏆 <b>Тебя обогнали</b>\n\n",
    "n.overtakeRow": "{name} — на {n} очков",
    "n.overtakePlace": "\n\n📍 Сейчас твоё место в лиге: <b>{p}</b>",
    "n.followed": "✅ {link} подписался",
    "n.unfollowed": "❌ {link} отписался",
    "n.changesTitle": "👥 <b>Изменения</b>\n\n",
    "n.changesMore": "\n…и ещё {n}",
    "n.digestTitle": "📬 <b>Дайджест за неделю ({range})</b>\n\n",
    "n.digestFollowers": "👥 Подписчиков: <b>{n}</b>{net}\n",
    "n.digestFollow": "🔄 Подписался: +{a} · Отписался: −{b}\n",
    "n.digestXp": "⚡ XP за неделю: <b>{n}</b>\n",
    "n.digestFarmed": "🎁 Из них накручено XP: <b>{n}</b>\n\n",
    "n.digestActEmpty": "📊 <i>Активность: нет данных — запустите «🔍 Активность» в разделе «👥 Друзья».</i>",
    "n.digestAct": "📊 <i>Активность (по проверке от {d}):</i>\n✅ Активны: <b>{a}</b> · 💤 Неактивны (7+ дн.): <b>{b}</b>",
    "n.update": "🚀 <b>Доступно обновление Duolingo Helper v{v}</b>",
    "n.updateBtn": "📦 Установить",
    // плюрализация (базовый ключ = форма many/other)
    "stats.streakDays.one": "🔥 <b>Streak:</b> {n} день",
    "stats.streakDays.few": "🔥 <b>Streak:</b> {n} дня",
    "unf.confirm.one": "Отписаться от {n} пользователя, который не подписан на вас?",
  },
  en: {
    // common
    "common.back": "← Back",
    "common.backToMenu": "← To menu",
    "common.backToStats": "← To stats",
    "common.backToDoante": "← Back to donations",
    "common.cancel": "✖ Cancel",
    "common.error": "❌ Error",
    "common.banned": "⛔ You are banned.",
    "common.development": "⏳ In development…",
    // menu
    "menu.brand": "🦉 <b>Duolingo Helper</b>\n\n",
    "menu.notLinked": "❌ Account not linked\n\n",
    "menu.choose": "Choose an action:",
    "menu.stats": "📊 Stats",
    "menu.friends": "👥 Friends",
    "menu.league": "🏆 League",
    "menu.settings": "⚙️ Settings",
    "menu.bugreport": "🐛 Bug report",
    "menu.openSite": "🌐 Open site",
    "menu.donate": "💝 Donate",
    // settings
    "settings.title": "⚙️ Settings\n\nChoose a section:",
    "settings.notify": "🔔 Notifications",
    "settings.link": "🔗 Linking",
    "settings.notLinked": "❌ Account not linked\n\nChoose an action:",
    // notify toggles
    "notify.title": "🔔 <b>Notifications</b>\n\nChoose what to notify about:",
    "notify.practice": "🔥 Practice reminder: {flag}",
    "notify.league": "🏆 League overtake: {flag}",
    "notify.follows": "👥 Follow / unfollow: {flag}",
    "notify.digest": "📬 Digest: {flag}",
    "notify.updates": "🚀 Script updates: {flag}",
    // stats
    "stats.head": "📊 <b>Stats</b>\n\n",
    "stats.xp": "⚡ <b>XP:</b> {n}",
    "stats.notLinked": "📊 Stats\n\n❌ Account not linked or JWT missing.",
    "stats.loading": "📊 <b>Stats</b>\n\n⏳ Loading…",
    "stats.error": "📊 <b>Stats</b>\n\n❌ Failed to load data.",
    "stats.todayNone": "⚠️ <i>Not yet</i>",
    "stats.todayDone": "✅ <i>Practiced</i>",
    "stats.chart": "\n\n📈 <b>XP over 7 days:</b>\n<pre>",
    "stats.leagueXp": "🏆 <b>League XP:</b> {n}",
    "stats.streakDays": "🔥 <b>Streak:</b> {n} days",
    "stats.todayStatus": "📅 <b>Today:</b> {s}",
    "stats.todayXp": "⚡ <b>Today:</b> {n}",
    "stats.weekXp": "📅 <b>Week:</b> {n}",
    "stats.getXp": "🎁 Get XP",
    "stats.streakBtn": "🔥 Streak",
    "days.0": "Sun",
    "days.1": "Mon",
    "days.2": "Tue",
    "days.3": "Wed",
    "days.4": "Thu",
    "days.5": "Fri",
    "days.6": "Sat",
    // league
    "league.notLinked": "🏆 League\n\n❌ Account not linked.",
    "league.loading": "🏆 <b>League</b>\n\n⏳ Loading…",
    "league.error": "🏆 <b>League</b>\n\n❌ Failed to load.",
    "league.title": "🏆 <b>League</b>\n\n",
    "league.you": "← you",
    "league.myPlace": "Your place: <b>{n}</b>",
    "league.farmTo": "🎯 Farm to place",
    "league.refresh": "🔄 Refresh",
    "leagueFarm.intro": "🎯 <b>Farm to place</b>\n\nThis feature will boost your league standing — the bot will farm XP until the chosen place is reached.\n\nYour place: <b>{rank}</b>\nChoose the target place:",
    "leagueFarm.start": "🎯 <b>Farm to place {n}</b>\n\n⏳ Starting…",
    "leagueFarm.done": "✅ <b>Target reached!</b> Place: <b>{n}</b>\n\n🏆 <b>League</b>\n\n",
    "leagueFarm.progress": "🎯 <b>Farm to place {n}</b>\n\n⚡ +50 XP · place: <b>{r}</b>\n📊 Current XP: <b>{x}</b>\n⏱ Cycle: {i}",
    "leagueFarm.limit": "🎯 <b>Farm</b>\n\n⚠️ Iteration limit reached.",
    // friends
    "friends.notLinked": "👥 Friends\n\n❌ Account not linked.",
    "friends.loading": "👥 <b>Friends</b>\n\n⏳ Loading…",
    "friends.error": "👥 <b>Friends</b>\n\n❌ Failed to load.",
    "friends.summary": "👥 <b>Friends</b>\n\nFollowing: <b>{a}</b>\nFollowers: <b>{b}</b>\nNot following back: <b>{c}</b>",
    "friends.unfNonf": "🚫 Unfollow non-followers",
    "friends.activity": "🔍 Activity",
    // unfollow non-followers
    "unf.title": "🚫 <b>Unfollowing non-followers</b>",
    "unf.noTargets": "🚫 <b>Unfollowing non-followers</b>\n\nNo targets (refresh the friends list).",
    "unf.confirm": "🚫 <b>Unfollowing non-followers</b>\n\nUnfollow {n} users who don't follow you back?\nExceptions 🛡 untouched.",
    "unf.yes": "✅ Yes, unfollow {n}",
    "unf.notLinked": "❌ Account not linked.",
    // block/unfollow inactive
    "act.titleBlock": "🚫 <b>Blocking inactive</b>",
    "act.titleUnf": "🚫 <b>Unfollowing inactive</b>",
    "act.noTargets": "\n\nNo targets.",
    "act.noTargetsScan": "\n\nNo targets (run the activity scan first).",
    "act.busy": "\n\n⏳ An action is already running.",
    "act.progressBlock": "Blocking",
    "act.progressUnf": "Unfollowing",
    "act.verbBlock": "Block",
    "act.verbUnf": "Unfollow",
    "act.done": "\n\n✅ Done: {ok} / {n}",
    "act.error": "\n\n❌ Error ({ok} / {n}).",
    "act.confirm": "{verb} {n} inactive users?\nExceptions 🛡 untouched.",
    "act.yes": "✅ Yes, {verb} {n}",
    "act.logNonf": "unfollow {n} non-followers",
    "act.logBlock": "block {n} inactive",
    "act.logUnf": "unfollow {n} inactive",
    // activity scan
    "scan.title": "🔍 <b>Activity</b>",
    "scan.needFriends": "🔍 <b>Activity</b>\n\nOpen the friends list first.",
    "scan.busy": "🔍 <b>Activity</b>\n\n⏳ Already running.",
    "scan.progress": "🔍 <b>Activity</b>\n\nChecking {done}/{total}…",
    "scan.stop": "⏹ Stop",
    "scan.stopping": "⏹ Stopping…",
    "scan.stopped": "🔍 <b>Activity</b>\n\n⏹ Stopped: checked <b>{done}</b> of {total}\n{tail}",
    "scan.checked": "🔍 <b>Activity</b>\n\nChecked: <b>{n}</b>\n{tail}",
    "scan.tail": "Inactive: <b>{n}</b> (threshold {d} d.)",
    "scan.unfInactive": "🚫 Unfollow inactive",
    "scan.blockInactive": "🚫 Block inactive",
    "scan.error": "🔍 <b>Activity</b>\n\n❌ Scan failed.",
    "scan.thresholdAsk": "🔍 <b>Activity</b>\n\nInactivity threshold, days:",
    "scan.d7": "7 d",
    "scan.d14": "14 d",
    "scan.d30": "30 d",
    "scan.custom": "✏ Enter number",
    "scan.customAsk": "✏ <b>Inactivity threshold</b>\n\nEnter the number of days (1–365):",
    // XP farm
    "xp.ask": "🎁 <b>Get XP</b>\n\nEnter the amount of XP (min 50):\n\n⚠️ <i>XP farming is at your own risk — a ban is possible.</i>",
    "xp.cancelled": "❌ Farming cancelled.",
    "xp.min50": "❌ Minimum is 50 XP. Try again:",
    "xp.running": "⏳ Farming is already running, please wait.",
    "xp.noJwt": "❌ Account not linked or JWT missing.",
    "xp.progress": "⏳ <b>Farming XP…</b>",
    "xp.done": "✅ <b>Done: +{n} XP</b>\n\n",
    "xp.none": "⚠️ <b>No XP credited</b>\n\n",
    "xp.error": "❌ XP farming failed.",
    // streak farm
    "streak.ask": "🔥 <b>Streak farming</b>\n\nHow many days to add? (min 1, max 365)\n\n⚠️ <i>Streak farming is at your own risk — a ban is possible.</i>\n⏱ <i>It may take 5–6 minutes.</i>",
    "streak.min1": "❌ Minimum is 1 day. Try again:",
    "streak.running": "⏳ Streak farming is already running, please wait.",
    "streak.progress": "🔥 <b>Farming streak…</b>\n\nDay {d}/{t}… (+{ok}){warn}",
    "streak.tail": "\n\n⏱ <i>May take 5–6 minutes.</i>",
    "streak.done": "✅ <b>Done: +{n} days</b>\n\n",
    "streak.none": "⚠️ <b>Streak not increased</b>\n\n",
    "streak.error": "❌ Streak farming failed.",
    // bug report
    "bug.prompt": "🐛 <b>Bug report</b>\n\nDescribe the problem in one message:",
    "bug.cancelled": "❌ Bug report cancelled.",
    "bug.tooShort": "❌ Message is too short. Try again: /bugreport",
    "bug.needLink": "❌ Link your account to send a bug report. Use the \"Link Telegram\" button in the Duolingo Helper script.",
    "bug.tooOften": "⏱ Too often. Try again in {n} min.",
    "bug.limit": "❌ Daily bug report limit reached (10). Try again tomorrow.",
    "bug.sent": "✅ <b>Bug report sent!</b>\n\nWe will review it soon.",
    "bug.accepted": "🔄 Your bug report has been accepted!",
    "bug.doneMsg": "✅ Your bug report is done!",
    "bug.reply": "💬 Reply from support:\n\n{text}",
    // linking
    "link.notLinked": "🔗 <b>Linking</b>\n\n❌ Account not linked.\nUse the \"Link Telegram\" button in the Duolingo Helper script.",
    "link.linked": "🔗 <b>Linking</b>\n\n✅ Account linked\n\n👤 <b>{duo}</b> · <code>{duoId}</code>\n📱 @{tg} · <code>{tgId}</code>\n📅 Linked: {date}",
    "link.unlinkBtn": "🔓 Unlink account",
    "link.unlinkConfirm": "🔓 <b>Unlink account</b>\n\n⚠️ Unlink the account?\nAll data and settings will be deleted from the server:\nstats, notifications, friends, action history.",
    "link.unlinkYes": "✅ Yes, unlink",
    "link.unlinked": "✅ Account unlinked.\n\nAll data has been deleted from the server.",
    "link.notLinkedShort": "🔗 <b>Linking</b>\n\n❌ Account not linked.",
    "start.noLink": "Link your account via the Duolingo Helper script,\nthen use the menu buttons.",
    "status.notLinked": "❌ Account not linked. Use the button in the Duolingo Helper script.",
    "status.linked": "✅ Account linked:\n\nDuolingo: {name}\nID: {id}\nLinked: {date}",
    "unlink.notLinked": "❌ Account not linked.",
    "unlink.done": "✅ Account unlinked. All data has been deleted from the server.",
    "code.notFound": "❌ Code not found.",
    "code.used": "❌ Code already used.",
    "code.expired": "❌ Code expired. Get a new one in the script.",
    "code.tooMany": "❌ Too many attempts.",
    "code.otherAccount": "⚠️ Another Duolingo account is already linked.\nUnlink it first: /unlink",
    "code.success": "✅ Account linked!\n\nDuolingo ID: {id}\nYou now have access to the bot's commands.",
    "code.duoNotLinked": "❌ This Telegram is not linked to the given Duolingo account. Link the account via the script first.",
    // donate
    "donate.answer": "Opening the donate menu",
    "donate.text": "💝 <b>Support the project</b>\n\nIf you enjoy Duolingo Helper and want to support its development — you can make a donation.\n\nYour support helps to:\n• Develop new features\n• Keep things running stably\n• Pay for the bot's servers\n\nChoose a convenient way to donate:",
    "donate.allWays": "🌐 All ways",
    "donate.walletMissing": "❌ {label} address is not configured",
    "donate.addr": "Wallet address:\n<code>{addr}</code>\n\n📋 Tap the address to copy\n\n{info}",
    "donate.kaspaInfo": "ℹ️ Kaspa — a fast and scalable cryptocurrency with instant transactions",
    "donate.tonInfo": "ℹ️ TON — a blockchain by the creators of Telegram with low fees",
    "donate.usdtInfo": "⚠️ <b>Important:</b> use the TRON network (TRC-20) only!\nSending via other networks will result in lost funds.",
    // notifications
    "n.practice": "🔥 <b>Time to practice!</b>\n\nYou haven't practiced today. Do a lesson or get XP so you don't lose your streak.",
    "n.overtakeOne": "🏆 <b>{name} overtook you</b>\nBy {n} points.",
    "n.overtakeMany": "🏆 <b>You have been overtaken</b>\n\n",
    "n.overtakeRow": "{name} — by {n} points",
    "n.overtakePlace": "\n\n📍 Your current league place: <b>{p}</b>",
    "n.followed": "✅ {link} followed you",
    "n.unfollowed": "❌ {link} unfollowed you",
    "n.changesTitle": "👥 <b>Changes</b>\n\n",
    "n.changesMore": "\n…and {n} more",
    "n.digestTitle": "📬 <b>Weekly digest ({range})</b>\n\n",
    "n.digestFollowers": "👥 Followers: <b>{n}</b>{net}\n",
    "n.digestFollow": "🔄 Followed: +{a} · Unfollowed: −{b}\n",
    "n.digestXp": "⚡ XP this week: <b>{n}</b>\n",
    "n.digestFarmed": "🎁 Including farmed XP: <b>{n}</b>\n\n",
    "n.digestActEmpty": "📊 <i>Activity: no data — run \"🔍 Activity\" in the \"👥 Friends\" section.</i>",
    "n.digestAct": "📊 <i>Activity (as of {d}):</i>\n✅ Active: <b>{a}</b> · 💤 Inactive (7+ d.): <b>{b}</b>",
    "n.update": "🚀 <b>Duolingo Helper v{v} is available</b>",
    "n.updateBtn": "📦 Install",
    // pluralization (base key = other form)
    "stats.streakDays.one": "🔥 <b>Streak:</b> {n} day",
    "unf.confirm.one": "Unfollow {n} user who doesn't follow you back?",
  },
};

export function userLang(user) {
  return user && user.lang === EN ? EN : RU;
}

/**
 * Категория множественного числа (CLDR-подобная).
 * ru/uk: one/few/many; en: one/other; для будущих языков — отдельные ветки
 * (pl и cs уже готовы, новые добавляются по образцу).
 */
function pluralCat(lang, n) {
  const v = Math.abs(Math.round(Number(n) || 0));
  const mod10 = v % 10;
  const mod100 = v % 100;
  if (lang === EN) return v === 1 ? "one" : "other";
  if (lang === "pl") {
    if (v === 1) return "one";
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "few";
    return "many";
  }
  if (lang === "cs") {
    if (v === 1) return "one";
    if (v >= 2 && v <= 4) return "few";
    return "other";
  }
  // ru, uk и другие славянские
  if (mod10 === 1 && mod100 !== 11) return "one";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "few";
  return "many";
}

/** Перевод: t("ru"|"en", "key", { n: 5 }) — {n} в строке подставляется из params.
 *  Плюрализация: при params.count (или params.n) выбирается форма
 *  key.one / key.few / key.many / key.other; при её отсутствии — базовый ключ. */
export function t(lang, key, params) {
  const dict = dicts[lang] || dicts.ru;
  let s = null;
  const count = params && (params.count != null ? params.count : params.n);
  if (count != null) {
    const plural = dict[key + "." + pluralCat(lang, count)];
    if (plural != null) s = plural;
  }
  if (s == null) s = dict[key] != null ? dict[key] : dicts.ru[key] != null ? dicts.ru[key] : key;
  if (params) {
    for (const k of Object.keys(params)) {
      s = s.split("{" + k + "}").join(String(params[k]));
    }
  }
  return s;
}

export function fmtNum(n, lang) {
  return (Number(n) || 0).toLocaleString(lang === EN ? "en-US" : "ru-RU");
}

export function fmtSigned(n, lang) {
  const v = Math.round(Number(n) || 0);
  return (v < 0 ? "−" : "+") + Math.abs(v).toLocaleString(lang === EN ? "en-US" : "ru-RU");
}
