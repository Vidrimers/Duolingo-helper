// ==UserScript==
// @name         Duolingo Helper
// @namespace    https://github.com/Vidrimers/Duolingo-helper
// @version      0.10.3
// @description  Проверка взаимной подписки на профилях Duolingo. Панель, бейджи, кеш.
// @author       Vidrimers
// @match        *://*.duolingo.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_listValues
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @connect      cdn.jsdelivr.net
// @connect      api.github.com
// @connect      goals-api.duolingo.com
// @connect      www.duolingo.com
// @connect      stories.duolingo.com
// @connect      duolingo-leaderboards-prod.duolingo.com
// @connect      localhost
// @connect      89.124.70.156
// @run-at       document-end
// @noframes
// @updateURL    https://raw.githubusercontent.com/Vidrimers/Duolingo-helper/refs/heads/master/duo-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/Vidrimers/Duolingo-helper/refs/heads/master/duo-helper.user.js
// ==/UserScript==

(function () {
  "use strict";

  // ========== КОНСТАНТЫ ==========
  const API = {
    users: "https://www.duolingo.com/2017-06-30/users",
    friends: "https://www.duolingo.com/2017-06-30/friends",
  };
  const STORAGE_KEY = "dh_data";
  const MARKER_ATTR = "data-dh-marked";
  const HOST_ID = "dh-root-host";
  const BOT_API = "http://89.124.70.156:3777";

  // локальная дата (YYYY-MM-DD) — не UTC, чтобы «сегодня» считалось по времени пользователя
  function localDateStr(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  // ========== ХРАНИЛИЩЕ ==========
  // ========== ХРАНИЛИЩЕ (всё per-account, включая настройки) ==========
  const ACCOUNT_FIELDS = [
    "settings",
    "followCache",
    "me",
    "actionLog",
    "excludeList",
    "blockList",
    "friendSnapshots",
    "friendChanges",
    "friendChangesUnread",
    "userTags",
    "stats",
    "privacySnapshot",
  ];

  function defaultSettings() {
    return {
      autoCheck: true,
      cacheMinutes: 30,
      requestDelay: 350,
      inactiveDays: 7,
      activitySort: "xp_desc",
      showBadge: true,
      badgePos: "top-right",
      accent: "#58cc02",
      winPos: null,
      fabPos: null,
      openOnStart: false,
      startState: "remember",
      windowState: "closed",
      theme: "win95",
      protectHearts: true,
      lessonShortener: false,
    storiesShortener: false,
    freeSuper: false,
      autoSolver: false,
      fakeXpBoost: false,
      xpBoostMins: 15,
      notifyHideSec: 5,
    lbGapRefresh: 2,
    };
  }

  function emptyAccount() {
    return {
      settings: defaultSettings(),
      followCache: {},
      me: null,
      actionLog: [],
      excludeList: [],
      blockList: [],
      friendSnapshots: [],
      friendChanges: [],
      friendChangesUnread: 0,
      userTags: {},
      stats: { xpLog: [], leagueLog: [], lastSnapshot: null },
      privacySnapshot: {},
    };
  }

  function loadData() {
    const raw = GM_getValue(STORAGE_KEY, null);
    let parsed = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {}
    }
    let accounts = (parsed && parsed.accounts) || {};

    // миграция: старый формат (настройки и данные вперемешку)
    if (!parsed || !parsed.accounts) {
      const legacy = emptyAccount();
      if (parsed) {
        if (parsed.settings) {
          legacy.settings = { ...defaultSettings(), ...parsed.settings };
        }
        for (const k of ACCOUNT_FIELDS) {
          if (k === "settings") continue;
          if (parsed[k] !== undefined) legacy[k] = parsed[k];
        }
      }
      const myId = getMyId() || "anon";
      accounts = { [myId]: legacy };
    }

    return { accounts };
  }

  function currentAccountId() {
    return getMyId() || "anon";
  }

  function saveToSlot(slotId) {
    if (!slotId) return;
    // перечитываем актуальный store из GM — чтобы не затереть данные других вкладок
    let freshStore = { accounts: {} };
    try {
      const raw = GM_getValue(STORAGE_KEY, null);
      if (raw) freshStore = JSON.parse(raw) || { accounts: {} };
    } catch {}
    freshStore.accounts = freshStore.accounts || {};
    const prev = freshStore.accounts[slotId] || {};
    const acc = { settings: DATA.settings };
    for (const k of ACCOUNT_FIELDS) {
      if (k === "settings") continue;
      acc[k] = DATA[k];
    }
    // мержим userTags — побеждает более свежий таймстемп
    const localTags = DATA.userTags || {};
    const prevTags = (prev.userTags && typeof prev.userTags === "object") ? prev.userTags : {};
    const merged = {};
    const allKeys = new Set([...Object.keys(prevTags), ...Object.keys(localTags)]);
    for (const key of allKeys) {
      const a = prevTags[key];
      const b = localTags[key];
      const aTime = (a && (a.updatedAt || a.deletedAt)) || 0;
      const bTime = (b && (b.updatedAt || b.deletedAt)) || 0;
      if (!a) merged[key] = b;
      else if (!b) merged[key] = a;
      else merged[key] = bTime >= aTime ? b : a;
    }
    // убираем tombstones старше 30 дней
    const cutoff = Date.now() - 30 * 86400000;
    for (const key of Object.keys(merged)) {
      if (merged[key].deleted && (merged[key].deletedAt || 0) < cutoff) {
        delete merged[key];
      }
    }
    acc.userTags = merged;
    // не пишем чужое me — если id не совпадает со слотом
    if (acc.me && String(acc.me.id) !== String(slotId)) {
      acc.me = prev.me && String(prev.me.id) === String(slotId) ? prev.me : null;
    }
    // сохраняем jwt / username / label / updatedAt из предыдущего слота
    if (prev.jwt) acc.jwt = prev.jwt;
    if (prev.username) acc.username = prev.username;
    if (prev.label) acc.label = prev.label;
    if (prev.updatedAt) acc.updatedAt = prev.updatedAt;
    freshStore.accounts[slotId] = acc;
    DATA._store = freshStore;
    GM_setValue(STORAGE_KEY, JSON.stringify(freshStore));
  }

  function saveData() {
    // пишем строго в активный слот (DATA._accountId), не в слот по JWT
    // — иначе при смене JWT настройки старого аккаунта уедут в чужой слот
    saveToSlot(DATA._accountId || currentAccountId());
  }

  /** Переключает контекст на аккаунт userId (или создаёт пустой слот). */
  function switchAccount(userId) {
    const id = String(userId || "anon");
    if (DATA._accountId === id) return;
    if (DATA._accountId) saveToSlot(DATA._accountId);
    const store = DATA._store;
    store.accounts = store.accounts || {};
    if (!store.accounts[id]) store.accounts[id] = emptyAccount();
    const acc = store.accounts[id];
    DATA.settings = { ...defaultSettings(), ...(acc.settings || {}) };
    const def = emptyAccount();
    for (const k of ACCOUNT_FIELDS) {
      if (k === "settings") continue;
      DATA[k] = acc[k] !== undefined ? acc[k] : def[k];
    }
    DATA.me = (acc.me && String(acc.me.id) === id) ? acc.me : (id === "anon" ? null : { id });
    DATA._accountId = id;
    if (typeof resetLiveCaches === "function") resetLiveCaches();
    if (typeof refreshUiForAccount === "function") refreshUiForAccount();
  }

  const _store = loadData();
  let DATA = {
    _store,
    _accountId: null,
    ...emptyAccount(),
  };
  switchAccount(currentAccountId());

  // ========== Шифрование JWT (AES-GCM через Web Crypto) ==========
  async function deriveKey(password, salt) {
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  async function encryptJWT(jwt, password) {
    const enc = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(jwt));
    return {
      v: 1,
      salt: btoa(String.fromCharCode(...salt)),
      iv: btoa(String.fromCharCode(...iv)),
      data: btoa(String.fromCharCode(...new Uint8Array(cipher))),
    };
  }

  async function decryptJWT(encObj, password) {
    try {
      const dec = new TextDecoder();
      const salt = Uint8Array.from(atob(encObj.salt), (c) => c.charCodeAt(0));
      const iv = Uint8Array.from(atob(encObj.iv), (c) => c.charCodeAt(0));
      const data = Uint8Array.from(atob(encObj.data), (c) => c.charCodeAt(0));
      const key = await deriveKey(password, salt);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
      return dec.decode(plain);
    } catch {
      return null;
    }
  }

  /** Сохраняет JWT текущего аккаунта в слот (открытым текстом — шифруется при экспорте). */
  function captureJWT() {
    const jwt = getToken();
    if (!jwt) return;
    // всегда берём id из JWT, а не из DATA._accountId (может быть устаревшим)
    const id = currentAccountId();
    if (!id || id === "anon") return;
    const store = DATA._store;
    if (!store) return;
    store.accounts = store.accounts || {};
    if (!store.accounts[id]) store.accounts[id] = emptyAccount();
    store.accounts[id].jwt = jwt;
    store.accounts[id].username = (DATA.me && String(DATA.me.id) === id && DATA.me.username) || store.accounts[id].username || "";
    store.accounts[id].updatedAt = Date.now();
    GM_setValue(STORAGE_KEY, JSON.stringify(store));
  }

  // периодически запоминаем JWT (если пользователь залогинился)
  setTimeout(() => { try { captureJWT(); } catch {} }, 3000);

  // ========== API ==========
  function getToken() {
    // пробуем разные источники
    const sources = [
      () => document.cookie,
      () => (typeof unsafeWindow !== "undefined" ? unsafeWindow.document.cookie : ""),
    ];
    for (const get of sources) {
      try {
        const m = get().match(/(^| )jwt_token=([^;]+)/);
        if (m && m[2]) {
          try { return decodeURIComponent(m[2]); } catch { return m[2]; }
        }
      } catch {}
    }
    for (const k of ["jwt_token", "jwtToken", "duolingo_jwt"]) {
      const v = localStorage.getItem(k);
      if (v) return v;
    }
    return null;
  }

  function readJwt(jwt) {
    try {
      if (!jwt || jwt.split(".").length < 2) return null;
      const b64 = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
      const json = decodeURIComponent(
        atob(pad)
          .split("")
          .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
          .join(""),
      );
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  function getMyId() {
    const t = getToken();
    if (!t) return null;
    const p = readJwt(t);
    return p && p.sub ? String(p.sub) : null;
  }

  async function apiGet(url) {
    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  async function getMe(force = false) {
    const myId = getMyId();
    if (!myId) return null;
    const prevAcc = DATA._accountId;
    switchAccount(myId); // на случай смены аккаунта в этой вкладке
    if (prevAcc && prevAcc !== DATA._accountId) {
      // сбросить кеши, привязанные к аккаунту
      if (typeof resetLiveCaches === "function") resetLiveCaches();
    }
    if (!force && DATA.me && String(DATA.me.id) === myId) return DATA.me;
    try {
      const u = await apiGet(
        `${API.users}/${myId}?fields=id,username,name,picture`,
      );
      DATA.me = {
        id: String(u.id ?? myId),
        username: u.username || "",
        name: u.name || u.username || "",
        picture: u.picture || null,
      };
      saveData();
      try { captureJWT(); } catch {}
      return DATA.me;
    } catch (e) {
      console.warn("[DuoHelper] getMe failed", e);
      return DATA.me || { id: myId, username: "", name: "" };
    }
  }

  /** username -> { id, name, username, picture } */
  async function resolveUser(username) {
    const data = await apiGet(
      `${API.users}?username=${encodeURIComponent(username)}`,
    );
    const found = (data.users || [])[0];
    if (!found) return null;
    return {
      id: String(found.id),
      username: found.username || username,
      name: found.name || found.displayName || found.username || username,
      picture: found.picture || null,
    };
  }

  /**
   * Достаёт список followers|following пользователя.
   * Формат ответа (проверено на DuoXJS):
   *   { followers: { users: [{ userId, displayName, ... }] } }
   *   { following: { users: [{ userId, displayName, ... }] } }
   */
  async function fetchUserList(userId, kind) {
    const users = [];
    let cursor = null;
    let page = 0;
    const maxPages = 30;

    while (page < maxPages) {
      let url = `${API.friends}/users/${userId}/${kind}?viewerId=${userId}&limit=100`;
      if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

      const data = await apiGet(url);
      const bucket = data[kind] || data;
      const pageUsers = bucket.users || bucket || [];
      if (Array.isArray(pageUsers)) {
        for (const u of pageUsers) users.push(u);
      }

      cursor =
        bucket.nextCursor ||
        bucket.cursor ||
        data.nextCursor ||
        data.cursor ||
        null;
      const hasMore =
        bucket.hasMore ??
        data.hasMore ??
        (cursor !== null && pageUsers.length > 0);

      if (!hasMore || !cursor || pageUsers.length === 0) break;
      page++;
    }

    return users.map((u) => ({
      userId: String(u.userId ?? u.id ?? ""),
      username: u.username || "",
      displayName: u.displayName || u.name || u.username || "",
      picture: u.picture || u.avatar || null,
    }));
  }

  /** Проверяет, подписан ли `target` на меня. */
  async function checkFollowsMe(targetUsername, targetId) {
    const me = await getMe();
    if (!me || !me.id) throw new Error("Не удалось определить ваш аккаунт");

    const meId = String(me.id);
    const meName = (me.username || "").toLowerCase();

    // 1) Их подписки — есть ли я среди них
    if (targetId) {
      try {
        const theirFollowing = await fetchUserList(targetId, "following");
        const hit = theirFollowing.find(
          (u) =>
            String(u.userId) === meId ||
            (meName && u.username && u.username.toLowerCase() === meName),
        );
        if (hit) return true;
        // если список реально вернулся, но меня нет — уже ответ
        if (theirFollowing.length > 0) return false;
      } catch (e) {
        console.warn("[DuoHelper] their following failed", e);
      }
    }

    // 2) Мои подписчики — есть ли он среди них
    const myFollowers = await fetchUserList(meId, "followers");
    const tId = targetId ? String(targetId) : null;
    const tName = (targetUsername || "").toLowerCase();
    return myFollowers.some(
      (u) =>
        (tId && String(u.userId) === tId) ||
        (tName && u.username && u.username.toLowerCase() === tName),
    );
  }

  function getCached(username) {
    if (!username) return null;
    const key = username.toLowerCase();
    const entry = DATA.followCache[key];
    if (!entry) return null;
    const ttl = (DATA.settings.cacheMinutes || 30) * 60 * 1000;
    if (Date.now() - (entry.checkedAt || 0) > ttl) return null;
    return entry;
  }

  function setCached(username, entry) {
    if (!username) return;
    DATA.followCache[username.toLowerCase()] = {
      ...entry,
      checkedAt: Date.now(),
    };
    saveData();
  }

  // ========== URL / SPA ==========
  function getProfileUsername() {
    const m = location.pathname.match(/^\/profile\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function isProfilePage() {
    return /^\/profile\/[^/]+/.test(location.pathname);
  }

  /** Свой профиль? Тогда проверка подписки не нужна. */
  function isOwnProfile(username) {
    if (!username) return false;
    const u = String(username).toLowerCase().replace(/^@/, "");
    // 1) по username из DATA.me
    const meName = (DATA.me && DATA.me.username ? String(DATA.me.username) : "")
      .toLowerCase()
      .replace(/^@/, "");
    if (meName && meName === u) return true;
    // 2) по userId из JWT vs userId из кеша
    const myId = getMyId();
    if (myId) {
      try {
        const rows = (friendsCache && friendsCache.rows) || [];
        for (const r of rows) {
          if ((r.username || "").toLowerCase() === u && String(r.userId) === myId) return true;
        }
      } catch {}
      try {
        const fc = DATA.followCache || {};
        for (const key of Object.keys(fc)) {
          if (key.toLowerCase() === u) {
            const entry = fc[key];
            if (entry && entry.theirId && String(entry.theirId) === myId) return true;
          }
        }
      } catch {}
    }
    return false;
  }

  // ========== UI ==========
  let shadow = null;
  let els = {};

  function createUI() {
    const old = document.getElementById(HOST_ID);
    if (old) old.remove();

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute(MARKER_ATTR, "1");
    host.style.cssText =
      "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
    document.documentElement.appendChild(host);

    shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
            *, *::before, *::after { box-sizing: border-box; }

            /* ===== Notification stack ===== */
            .dh-notifs {
                position: fixed;
                top: 16px;
                right: 16px;
                z-index: 2147483647;
                display: flex;
                flex-direction: column;
                gap: 8px;
                pointer-events: none;
                max-width: min(320px, calc(100vw - 32px));
            }
            .dh-notif {
                pointer-events: auto;
                display: flex;
                align-items: flex-start;
                gap: 8px;
                background: linear-gradient(135deg, #1e1e2e, #2a2a3e);
                color: #fff;
                border-radius: 8px;
                border-left: 4px solid #58cc02;
                padding: 10px 12px;
                font: 600 12px/1.35 Tahoma, sans-serif;
                box-shadow: 0 8px 24px rgba(0,0,0,0.35);
                opacity: 0;
                transform: translateX(20px);
                transition: opacity 0.25s ease, transform 0.25s ease;
                cursor: pointer;
            }
            .dh-notif.show {
                opacity: 1;
                transform: translateX(0);
            }
            .dh-notif.error { border-left-color: #e74c3c; }
            .dh-notif.ok { border-left-color: #58cc02; }
            .dh-notif.info { border-left-color: #3498db; }
            .dh-notif.warn { border-left-color: #f39c12; }
            .dh-notif-icon {
                font-size: 14px;
                line-height: 1.2;
                flex-shrink: 0;
            }
            .dh-notif-text {
                flex: 1;
                min-width: 0;
                word-break: break-word;
            }
            /* Notifs — Vista */
            .dh-notifs.dh-theme-vista .dh-notif {
                background: linear-gradient(135deg, #E8EEF4, #D0DCE8);
                color: #1A1A1A;
                border-radius: 10px;
            }
            /* Notifs — Win95 */
            .dh-notifs.dh-theme-win95 .dh-notif {
                background: #C0C0C0;
                color: #000;
                border-radius: 0;
                border: 2px solid;
                border-color: #FFF #808080 #808080 #FFF;
                border-left: 4px solid #58cc02;
                font-family: "MS Sans Serif", Tahoma, sans-serif;
            }
            /* Notifs — MacOS */
            .dh-notifs.dh-theme-macos .dh-notif {
                background: rgba(255,255,255,0.92);
                color: #333;
                border-radius: 10px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.18);
                font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
                border-left-width: 4px;
            }
            /* Notifs — iOS old */
            .dh-notifs.dh-theme-iosold .dh-notif {
                background: linear-gradient(to bottom, #F0F0F0, #D0D0D0);
                color: #222;
                border-radius: 12px;
                border: 1px solid #A0A0A0;
                border-left: 4px solid #58cc02;
                font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
            }
            /* Notifs — Die my Darling */
            .dh-notifs.dh-theme-dmd .dh-notif {
                background: linear-gradient(135deg, #2A0808, #1A0A0A);
                color: #E0C0C0;
                border-radius: 3px;
                border-left-color: #FF4444;
                font-family: Georgia, "Times New Roman", serif;
            }
            .dh-notifs.dh-theme-dmd .dh-notif.error { border-left-color: #FF4444; }
            .dh-notifs.dh-theme-dmd .dh-notif.ok { border-left-color: #CC2222; }
            .dh-notifs.dh-theme-dmd .dh-notif.info { border-left-color: #AA4444; }
            .dh-notifs.dh-theme-dmd .dh-notif.warn { border-left-color: #FF6644; }
            /* Notifs — Win11 */
            .dh-notifs.dh-theme-win11 .dh-notif {
                background: #FFFFFF;
                color: #1A1A1A;
                border-radius: 8px;
                border: 1px solid #E5E5E5;
                border-left: 4px solid #0067C0;
                box-shadow: 0 8px 24px rgba(0,0,0,0.12);
                font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
            }
            .dh-notifs.dh-theme-win11 .dh-notif.error { border-left-color: #C42B1C; }
            .dh-notifs.dh-theme-win11 .dh-notif.ok { border-left-color: #0F7B0F; }
            .dh-notifs.dh-theme-win11 .dh-notif.info { border-left-color: #0067C0; }
            .dh-notifs.dh-theme-win11 .dh-notif.warn { border-left-color: #9D5D00; }
            /* Notifs — Material 3 Light */
            .dh-notifs.dh-theme-m3l .dh-notif {
                background: #322F35;
                color: #F5EFF7;
                border-radius: 4px;
                border-left-color: #6750A4;
                font-family: "Roboto", "Segoe UI", sans-serif;
            }
            /* Notifs — Material 3 Dark */
            .dh-notifs.dh-theme-m3d .dh-notif {
                background: #E6E0E9;
                color: #322F35;
                border-radius: 4px;
                border-left-color: #D0BCFF;
                font-family: "Roboto", "Segoe UI", sans-serif;
            }
            /* Notifs — iOS Liquid Glass */
            .dh-notifs.dh-theme-glass .dh-notif {
                background: rgba(30,20,50,0.85);
                backdrop-filter: blur(24px) saturate(160%);
                -webkit-backdrop-filter: blur(24px) saturate(160%);
                color: rgba(255,255,255,0.96);
                border-radius: 20px;
                border: 1px solid rgba(255,255,255,0.12);
                border-left: 4px solid #0A84FF;
                box-shadow: 0 8px 32px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.15);
                font-family: -apple-system, "SF Pro Text", sans-serif;
            }

            /* ===== FAB ===== */
            .dh-fab {
                position: fixed;
                bottom: 24px;
                left: 24px;
                width: 34px;
                height: 24px;
                border-radius: 12px;
                background: linear-gradient(135deg, rgba(88,204,2,0.35), rgba(88,204,2,0.65));
                border: none;
                color: white;
                font-size: 15px;
                cursor: pointer;
                z-index: 2147483646;
                box-shadow: 0 4px 24px rgba(88,204,2,0.4);
                transition: transform 0.25s cubic-bezier(.4,2,.6,1), box-shadow 0.3s;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 0;
                animation: dh-fab-pulse 3s ease-in-out infinite;
                pointer-events: auto;
                cursor: grab;
                user-select: none;
                -webkit-user-select: none;
            }
            .dh-fab:active { cursor: grabbing; }
            .dh-fab:hover {
                transform: scale(1.12) rotate(-5deg);
                box-shadow: 0 8px 32px rgba(88,204,2,0.6), 0 0 0 6px rgba(88,204,2,0.15);
            }
            .dh-fab:active { transform: scale(0.95); }
            @keyframes dh-fab-pulse {
                0%, 100% { box-shadow: 0 4px 24px rgba(88,204,2,0.4), 0 0 0 0 rgba(88,204,2,0); }
                50% { box-shadow: 0 4px 24px rgba(88,204,2,0.4), 0 0 0 8px rgba(88,204,2,0.08); }
            }

            /* ===== Badge on profile ===== */
            .dh-badge {
                position: fixed;
                top: 88px;
                right: 24px;
                z-index: 2147483645;
                pointer-events: auto;
                display: none;
                align-items: center;
                gap: 8px;
                padding: 10px 16px;
                border-radius: 14px;
                font: 700 13px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                box-shadow: 0 8px 28px rgba(0,0,0,0.35);
                cursor: pointer;
                transition: transform 0.2s, filter 0.2s;
                backdrop-filter: blur(12px);
                border: 1px solid rgba(255,255,255,0.12);
                max-width: 280px;
            }
            .dh-badge:hover { transform: translateY(-2px); filter: brightness(1.08); }
            .dh-badge.visible { display: inline-flex; }
            .dh-badge.yes {
                background: linear-gradient(135deg, rgba(46,204,113,0.92), rgba(39,174,96,0.92));
                color: #fff;
            }
            .dh-badge.no {
                background: linear-gradient(135deg, rgba(231,76,60,0.92), rgba(192,57,43,0.92));
                color: #fff;
            }
            .dh-badge.checking {
                background: linear-gradient(135deg, rgba(52,73,94,0.92), rgba(44,62,80,0.92));
                color: #ecf0f1;
            }
            .dh-badge.error {
                background: linear-gradient(135deg, rgba(243,156,18,0.92), rgba(211,84,0,0.92));
                color: #fff;
            }
            .dh-badge .dh-badge-icon { font-size: 16px; line-height: 1; }
            .dh-badge .dh-badge-sub {
                display: block;
                font-size: 10px;
                font-weight: 500;
                opacity: 0.85;
                margin-top: 2px;
            }

            /* ===== Modal ===== */
            /* ===== XP Window ===== */
            .dh-modal {
                position: fixed;
                left: 420px;
                top: 120px;
                pointer-events: auto;
                width: 420px;
                max-width: 92vw;
                max-height: 78vh;
                z-index: 2147483645;
                display: none;
                flex-direction: column;
                background: #ECE9D8;
                border: 3px solid;
                border-color: #0055EA #003DD7 #003DD7 #0055EA;
                border-radius: 8px 8px 3px 3px;
                box-shadow:
                    2px 2px 12px rgba(0,0,0,0.45),
                    inset 0 0 0 1px rgba(255,255,255,0.12);
                color: #000;
                font-family: Tahoma, 'Segoe UI', sans-serif;
                font-size: 12px;
                line-height: 1.35;
                overflow: hidden;
                overscroll-behavior: contain;
            }
            .dh-modal.open { display: flex; }
            .dh-modal.dh-anim {
                transition:
                    left 0.28s cubic-bezier(0.2, 0.8, 0.2, 1),
                    top 0.28s cubic-bezier(0.2, 0.8, 0.2, 1),
                    width 0.28s cubic-bezier(0.2, 0.8, 0.2, 1),
                    height 0.28s cubic-bezier(0.2, 0.8, 0.2, 1),
                    transform 0.32s cubic-bezier(0.2, 0.8, 0.2, 1),
                    opacity 0.28s ease;
            }
            .dh-modal.dh-min {
                max-width: 92vw;
                max-height: none !important;
                width: fit-content;
            }
            .dh-modal.dh-min .dh-body,
            .dh-modal.dh-min .dh-footer {
                display: none !important;
            }
            .dh-modal.dh-min .dh-titlebar {
                border-radius: 5px 5px 3px 3px;
            }
            .dh-modal.dh-min .dh-title-text {
                flex: 0 0 auto;
                max-width: none;
                overflow: visible;
                text-overflow: clip;
                width: auto;
            }
            .dh-modal.dh-min .dh-chip {
                display: none;
            }

            /* Title bar (drag handle) */
            .dh-titlebar {
                height: 30px;
                flex-shrink: 0;
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 0 4px 0 8px;
                cursor: move;
                user-select: none;
                -webkit-user-select: none;
                background: linear-gradient(
                    to bottom,
                    #0A246A 0%,
                    #3A6EA5 4%,
                    #0058EE 8%,
                    #3593FF 18%,
                    #288EFF 40%,
                    #127DFF 65%,
                    #0058EE 88%,
                    #003DD7 93%,
                    #001CB8 98%
                );
                border-radius: 5px 5px 0 0;
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.25);
            }
            .dh-titlebar .dh-title-icon {
                font-size: 15px;
                line-height: 1;
                filter: drop-shadow(0 1px 1px rgba(0,0,0,0.35));
            }
            .dh-titlebar .dh-title-text {
                flex: 1;
                color: #fff;
                font-weight: 700;
                font-size: 13px;
                letter-spacing: 0.2px;
                text-shadow: 1px 1px 2px rgba(0,0,0,0.55);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .dh-titlebar .dh-chip {
                font-size: 10px;
                background: rgba(255,255,255,0.18);
                color: #fff;
                padding: 1px 7px;
                border-radius: 8px;
                font-weight: 600;
                text-shadow: none;
            }

            /* XP window buttons */
            .dh-win-btns { display: flex; gap: 2px; flex-shrink: 0; }
            .dh-win-btn {
                width: 22px;
                height: 22px;
                border-radius: 3px;
                border: 1px solid rgba(255,255,255,0.55);
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 13px;
                font-weight: 700;
                line-height: 1;
                padding: 0;
                font-family: Tahoma, sans-serif;
                color: #fff;
                text-shadow: 1px 1px 1px rgba(0,0,0,0.4);
            }
            .dh-win-btn.min {
                background: linear-gradient(to bottom, #4080FF, #1050D0);
            }
            .dh-win-btn.close {
                background: linear-gradient(to bottom, #F5875C, #E03C15);
            }
            .dh-win-btn:hover { filter: brightness(1.12); }
            .dh-win-btn:active { filter: brightness(0.9); }

            /* Body */
            .dh-body {
                flex: 1;
                overflow: hidden;
                padding: 10px 12px 12px;
                background: #ECE9D8;
                display: flex;
                flex-direction: column;
                gap: 10px;
                overscroll-behavior: contain;
            }
            .dh-body::-webkit-scrollbar { width: 14px; }
            .dh-body::-webkit-scrollbar-track {
                background: #F1F1F1;
                border-left: 1px solid #D6D2B8;
            }
            .dh-body::-webkit-scrollbar-thumb {
                background: linear-gradient(to right, #F5F4EA, #C8C4A8);
                border: 1px solid #9C9A7E;
                border-radius: 2px;
            }

            /* ===== Tabs (XP) ===== */
            .dh-tabs {
                display: flex;
                gap: 2px;
                margin: 0 0 -1px;
                padding: 0 0 0 4px;
                position: relative;
                z-index: 1;
            }
            .dh-tab {
                padding: 5px 12px;
                border: 1px solid #919B9C;
                border-bottom: none;
                background: linear-gradient(to bottom, #F0EDE1 0%, #DCD8C8 100%);
                color: #333;
                font-size: 11px;
                font-weight: 700;
                cursor: pointer;
                border-radius: 3px 3px 0 0;
                font-family: Tahoma, sans-serif;
                position: relative;
                top: 1px;
            }
            .dh-tab.active {
                background: #ECE9D8;
                color: #0A246A;
                top: 1px;
                z-index: 2;
                box-shadow: 0 1px 0 #ECE9D8;
            }
            .dh-tab:hover:not(.active) { background: linear-gradient(to bottom, #F8F6EE, #E5E1D0); }

            .dh-tab-content {
                display: none;
                flex-direction: column;
                gap: 10px;
                flex: 1;
                min-height: 0;
                overscroll-behavior: contain;
            }
            .dh-tab-content.active { display: flex; }
            .dh-tab-content[data-tab="friends"].active {
                overflow: hidden;
            }
            .dh-tab-content:not([data-tab="friends"]).active {
                overflow-y: auto;
                padding-right: 6px;
            }
            .dh-tab-content[data-tab="friends"] #dh-friends-list,
            .dh-tab-content[data-tab="friends"] #dh-history-list,
            .dh-tab-content[data-tab="friends"] #dh-changes-list,
            .dh-tab-content[data-tab="friends"] #dh-exclude-list,
            .dh-tab-content[data-tab="friends"] #dh-blocks-list {
                flex: 1;
                min-height: 0;
                overflow-y: auto;
                overscroll-behavior: contain;
            }

            /* ===== Inputs / Buttons (XP) ===== */
            .dh-input {
                width: 100%;
                padding: 5px 8px;
                background: #fff;
                border: 2px solid;
                border-color: #7F9DB9 #DFE7F0 #DFE7F0 #7F9DB9;
                border-radius: 1px;
                color: #000;
                font-size: 12px;
                outline: none;
                font-family: Tahoma, sans-serif;
            }
            .dh-input:focus { border-color: #3C7FB1 #B9D5EA #B9D5EA #3C7FB1; }
            .dh-input::placeholder { color: #9A9A9A; }

            .dh-btn {
                padding: 5px 14px;
                border: 1px solid #003C74;
                border-radius: 3px;
                background: linear-gradient(to bottom, #F5F4EA 0%, #E5E1D0 45%, #D2CEB8 100%);
                color: #000;
                font-size: 12px;
                font-weight: 400;
                cursor: pointer;
                font-family: Tahoma, sans-serif;
                white-space: nowrap;
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.7);
            }
            .dh-btn:hover { filter: brightness(1.04); }
            .dh-btn:active {
                background: linear-gradient(to bottom, #D2CEB8, #E5E1D0);
                box-shadow: inset 0 1px 2px rgba(0,0,0,0.12);
            }
            .dh-btn-primary {
                background: linear-gradient(to bottom, #6EC27A 0%, #4FA85C 45%, #3D8F4A 100%);
                border-color: #2D6B36;
                color: #fff;
                font-weight: 700;
                text-shadow: 0 1px 1px rgba(0,0,0,0.25);
            }
            .dh-btn-ghost {
                background: linear-gradient(to bottom, #F5F4EA 0%, #E5E1D0 45%, #D2CEB8 100%);
                border-color: #003C74;
                color: #000;
            }
            .dh-btn-danger {
                background: linear-gradient(to bottom, #E9847A 0%, #D6483A 45%, #B93C30 100%);
                border-color: #8B2A20;
                color: #fff;
                font-weight: 700;
                text-shadow: 0 1px 1px rgba(0,0,0,0.25);
            }
            .dh-btn:disabled {
                color: #9A9A9A;
                background: #ECE9D8;
                border-color: #C0BDA4;
                cursor: not-allowed;
                box-shadow: none;
                filter: none;
            }

            /* ===== Cards ===== */
            .dh-card {
                background: #fff;
                border: 1px solid #919B9C;
                border-radius: 2px;
                padding: 10px 12px;
                box-shadow: inset 0 0 0 1px #F5F4EA;
            }
            .dh-card-title {
                font-size: 10px;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                color: #666;
                margin: 0 0 6px;
                font-weight: 700;
                font-family: Tahoma, sans-serif;
            }
            .dh-status-line {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 13px;
                font-weight: 700;
                font-family: Tahoma, sans-serif;
            }
            .dh-status-line .icon { font-size: 18px; }
            .dh-status-yes { color: #1F7A1F; }
            .dh-status-no { color: #B02A1E; }
            .dh-status-checking { color: #A57A00; }
            .dh-status-error { color: #B06A1E; }
            .dh-muted { color: #666; font-size: 11px; font-weight: 400; }
            .dh-row { display: flex; gap: 6px; align-items: center; }
            .dh-row .dh-input { flex: 1; }

            /* ===== Settings ===== */
            .dh-setting-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 7px 2px;
                border-bottom: 1px solid #D6D2B8;
                gap: 10px;
            }
            .dh-setting-label { font-size: 12px; color: #333; flex: 1; }
            .dh-setting-label small {
                display: block;
                color: #777;
                font-size: 10px;
                margin-top: 1px;
            }

            /* ===== Shop cards ===== */
            .dh-shop-grid {
                display: grid;
                grid-template-columns: repeat(2, minmax(0, 1fr));
                gap: 6px;
                width: 100%;
                min-width: 0;
                box-sizing: border-box;
            }
            .dh-shop-card {
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 4px;
                padding: 10px 6px 8px;
                background: #FDFCF5;
                border: 1px solid #D6D2B8;
                border-radius: 8px;
                text-align: center;
                transition: box-shadow 0.15s;
                height: 130px;
                box-sizing: border-box;
                min-width: 0;
                overflow: hidden;
            }
            .dh-shop-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
            .dh-shop-card .icon { font-size: 22px; line-height: 1; height: 24px; }
            .dh-shop-card .name {
                font-size: 11px;
                font-weight: 700;
                color: #333;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                max-width: 100%;
                height: 14px;
            }
            .dh-shop-card .desc {
                font-size: 9px;
                color: #777;
                line-height: 1.2;
                height: 22px;
                overflow: hidden;
                display: -webkit-box;
                -webkit-line-clamp: 2;
                -webkit-box-orient: vertical;
            }
            .dh-shop-card .dh-btn {
                padding: 3px 10px;
                font-size: 10px;
                margin-top: auto;
            }

            /* ===== League table ===== */
            .dh-lb-table {
                display: flex;
                flex-direction: column;
                gap: 2px;
            }
            .dh-lb-row {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 5px 8px;
                border-radius: 6px;
                font-size: 11px;
                transition: background 0.15s;
            }
            .dh-lb-row:nth-child(odd) { background: rgba(0,0,0,0.03); }
            .dh-lb-row.me {
                background: rgba(88,204,2,0.15);
                font-weight: 700;
                box-shadow: inset 0 0 0 1.5px #58CC02;
            }
            .dh-lb-row .rank {
                width: 32px;
                text-align: center;
                font-size: 14px;
                flex-shrink: 0;
            }
            .dh-lb-row .name {
                flex: 1;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .dh-lb-row .score {
                flex-shrink: 0;
                font-variant-numeric: tabular-nums;
                font-weight: 700;
            }
            .dh-lb-row .gap {
                flex-shrink: 0;
                width: 52px;
                text-align: right;
                font-size: 10px;
                color: #777;
                font-variant-numeric: tabular-nums;
            }
            .dh-lb-row .gap.up { color: #1F7A1F; }
            .dh-lb-row .gap.down { color: #B02A1E; }

            .dh-switch {
                position: relative;
                width: 40px;
                height: 22px;
                border-radius: 3px;
                background: linear-gradient(to bottom, #E5E1D0, #C8C4A8);
                border: 1px solid #919B9C;
                cursor: pointer;
                flex-shrink: 0;
            }
            .dh-switch.on {
                background: linear-gradient(to bottom, #6EC27A, #3D8F4A);
                border-color: #2D6B36;
            }
            .dh-switch::after {
                content: "";
                position: absolute;
                top: 2px;
                left: 2px;
                width: 16px;
                height: 16px;
                border-radius: 2px;
                background: linear-gradient(to bottom, #FFF, #E8E4D4);
                border: 1px solid #919B9C;
                transition: transform 0.15s;
            }
            .dh-switch.on::after { transform: translateX(18px); }

            .dh-num-input {
                width: 64px;
                padding: 4px 6px;
                background: #fff;
                border: 2px solid;
                border-color: #7F9DB9 #DFE7F0 #DFE7F0 #7F9DB9;
                border-radius: 1px;
                color: #000;
                font-size: 12px;
                outline: none;
                font-family: Tahoma, sans-serif;
                text-align: center;
            }

            /* ===== Footer ===== */
            .dh-footer {
                display: flex;
                gap: 6px;
                padding: 8px 12px;
                background: #ECE9D8;
                border-top: 1px solid #D6D2B8;
                flex-shrink: 0;
                justify-content: center;
                align-items: center;
            }
            .dh-footer .dh-btn { flex: 1; text-align: center; padding: 6px 10px; }

            .dh-donate-link {
                color: #888;
                font-size: 12px;
                text-decoration: none;
                transition: color 0.2s;
            }
            .dh-donate-link:hover {
                color: #ccc;
                text-decoration: underline;
            }

            .dh-op-status:empty { display: none; }

            /* ===== Custom select ===== */
            .dh-select {
                position: relative;
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 5px 10px;
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 8px;
                background: rgba(0,0,0,0.18);
                color: #ccc;
                font: 600 11px/1.2 Tahoma, "Segoe UI", sans-serif;
                cursor: pointer;
                user-select: none;
                min-width: 0;
            }
            .dh-select-text {
                flex: 1;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .dh-select-arrow {
                opacity: 0.6;
                transition: transform 0.2s;
            }
            .dh-select.open .dh-select-arrow { transform: rotate(180deg); }
            .dh-select-options {
                display: none;
                position: absolute;
                left: 0;
                right: 0;
                top: calc(100% + 4px);
                z-index: 20;
                background: #1e1e2e;
                border: 1px solid rgba(102,126,234,0.35);
                border-radius: 8px;
                overflow: hidden;
                box-shadow: 0 8px 24px rgba(0,0,0,0.45);
            }
            .dh-select.open .dh-select-options { display: block; }
            .dh-select-option {
                padding: 7px 10px;
                color: #ddd;
                font-size: 11px;
                cursor: pointer;
            }
            .dh-select-option:hover {
                background: rgba(102,126,234,0.2);
            }
            .dh-modal.dh-theme-vista .dh-select {
                background: rgba(255,255,255,0.4);
                border-color: rgba(120,160,210,0.35);
                color: #1b3a5f;
                font-family: "Segoe UI", Tahoma, sans-serif;
            }
            .dh-modal.dh-theme-vista .dh-select-options {
                background: #fff;
                border-color: rgba(120,160,210,0.45);
            }
            .dh-modal.dh-theme-vista .dh-select-option {
                color: #1b3a5f;
            }
            .dh-modal.dh-theme-win95 .dh-select {
                background: #C0C0C0;
                border: 2px solid;
                border-color: #808080 #FFF #FFF #808080;
                border-radius: 0;
                color: #000;
            }
            .dh-modal.dh-theme-win95 .dh-select-options {
                background: #C0C0C0;
                border: 2px solid;
                border-color: #808080 #FFF #FFF #808080;
                border-radius: 0;
            }
            .dh-modal.dh-theme-win95 .dh-select-option {
                color: #000;
            }

            /* New change rows — highlight until hover */
            .dh-change-new {
                background: rgba(88,204,2,0.14);
                border-radius: 6px;
            }
            .dh-change-new:hover {
                background: rgba(88,204,2,0.06);
            }
            .dh-modal.dh-theme-vista .dh-change-new {
                background: rgba(46,109,168,0.14);
            }
            .dh-modal.dh-theme-win95 .dh-change-new {
                background: #000080;
                color: #fff;
            }
            .dh-modal.dh-theme-win95 .dh-change-new small {
                color: #ddd;
            }
            .dh-modal.dh-theme-win95 .dh-change-new:hover {
                background: #000080;
                color: #fff;
            }

            /* ===== Update banner (XP) ===== */
            .dh-update-banner {
                display: none;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                padding: 7px 10px;
                margin-bottom: 2px;
                background: linear-gradient(to bottom, #E8F5D8, #C8E0A8);
                border: 1px solid #6A9A3A;
                border-radius: 2px;
                font-size: 11px;
                color: #2D5A1A;
                font-family: Tahoma, sans-serif;
                font-weight: 700;
            }
            .dh-update-banner span { flex: 1; }
            .dh-update-btn {
                padding: 3px 10px;
                border: 1px solid #2D6B36;
                border-radius: 3px;
                background: linear-gradient(to bottom, #6EC27A, #3D8F4A);
                color: #fff;
                font-size: 11px;
                font-weight: 700;
                cursor: pointer;
                font-family: Tahoma, sans-serif;
                white-space: nowrap;
            }
            .dh-update-btn:hover { filter: brightness(1.1); }

            /* ===== Confirm dialog (XP) ===== */
            .dh-confirm-overlay {
                position: fixed;
                inset: 0;
                z-index: 2147483646;
                background: rgba(0,0,0,0.35);
                display: flex;
                align-items: center;
                justify-content: center;
                pointer-events: auto;
            }
            .dh-confirm-box {
                width: 340px;
                max-width: 90vw;
                background: #ECE9D8;
                border: 3px solid;
                border-color: #0055EA #003DD7 #003DD7 #0055EA;
                border-radius: 8px 8px 3px 3px;
                box-shadow: 2px 2px 12px rgba(0,0,0,0.45);
                font-family: Tahoma, sans-serif;
                color: #000;
                overflow: hidden;
            }
            .dh-confirm-title {
                height: 28px;
                display: flex;
                align-items: center;
                padding: 0 10px;
                background: linear-gradient(to bottom, #0A246A, #3593FF 40%, #0058EE 90%);
                color: #fff;
                font-weight: 700;
                font-size: 13px;
                text-shadow: 1px 1px 2px rgba(0,0,0,0.5);
            }
            .dh-confirm-body {
                padding: 16px 14px 8px;
                font-size: 12px;
                line-height: 1.45;
            }
            .dh-confirm-actions {
                display: flex;
                gap: 8px;
                justify-content: flex-end;
                padding: 10px 14px 14px;
            }

            /* Confirm — Vista */
            .dh-confirm-overlay.dh-theme-vista .dh-confirm-box {
                background: #E8EEF5;
                border: 1px solid rgba(40, 70, 110, 0.55);
                border-radius: 10px;
                box-shadow: 0 12px 40px rgba(0,0,0,0.45);
                font-family: "Segoe UI", Tahoma, sans-serif;
            }
            .dh-confirm-overlay.dh-theme-vista .dh-confirm-title {
                height: 32px;
                border-radius: 9px 9px 0 0;
                background:
                    linear-gradient(to bottom, rgba(255,255,255,0.4), rgba(120,170,220,0.1) 50%, rgba(20,50,100,0.35)),
                    linear-gradient(to right, #1B3A5F, #2E6DA8 45%, #1B3A5F);
                font-family: "Segoe UI", sans-serif;
                font-weight: 600;
            }

            /* Confirm — Win95 */
            .dh-confirm-overlay.dh-theme-win95 .dh-confirm-box {
                background: #C0C0C0;
                border: 2px solid;
                border-color: #DFDFDF #000 #000 #DFDFDF;
                border-radius: 0;
                font-family: "MS Sans Serif", Tahoma, sans-serif;
            }
            .dh-confirm-overlay.dh-theme-win95 .dh-confirm-title {
                height: 22px;
                background: linear-gradient(to right, #000080, #1084D0);
                border-radius: 0;
                font-family: inherit;
                text-shadow: none;
            }
            .dh-confirm-overlay.dh-theme-win95 .dh-btn {
                border-radius: 0;
                border: 2px solid;
                border-color: #FFF #000 #000 #FFF;
                background: #C0C0C0;
                color: #000;
                font-family: inherit;
            }
            .dh-confirm-overlay.dh-theme-win95 .dh-btn-primary {
                background: #C0C0C0;
                color: #000;
                font-weight: 700;
            }
            .dh-confirm-overlay.dh-theme-macos .dh-confirm-box {
                background: #F5F5F5;
                border: 1px solid #B0B0B0;
                border-radius: 12px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.25);
                color: #333;
                font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
            }
            .dh-confirm-overlay.dh-theme-macos .dh-confirm-title {
                color: #333;
                background: linear-gradient(to bottom, #E8E8E8, #D0D0D0);
                border-bottom-color: #E0E0E0;
                text-shadow: none;
            }
            .dh-confirm-overlay.dh-theme-iosold .dh-confirm-box {
                background: linear-gradient(to bottom, #F0F0F0, #D0D0D0);
                border: 2px solid #808080;
                border-radius: 14px;
                color: #222;
                font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
            }
            .dh-confirm-overlay.dh-theme-iosold .dh-confirm-title {
                color: #fff;
                background: linear-gradient(to bottom, #B8B8B8, #909090);
                border-bottom-color: #B0B0B0;
                text-shadow: 0 -1px 0 rgba(0,0,0,0.3);
            }
            .dh-confirm-overlay.dh-theme-dmd .dh-confirm-box {
                background: #1A0A0A;
                border: 2px solid #8B0000;
                border-radius: 4px;
                box-shadow: 0 0 30px rgba(139,0,0,0.5);
                color: #E0C0C0;
                font-family: Georgia, "Times New Roman", serif;
            }
            .dh-confirm-overlay.dh-theme-dmd .dh-confirm-title {
                color: #FF4444;
                background: linear-gradient(to bottom, #3A1010, #2A0808);
                border-bottom-color: #6A1010;
                text-shadow: none;
            }
            .dh-confirm-overlay.dh-theme-win11 .dh-confirm-box {
                background: #FFFFFF;
                border: 1px solid #E5E5E5;
                border-radius: 8px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.12);
                color: #1A1A1A;
                font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
            }
            .dh-confirm-overlay.dh-theme-win11 .dh-confirm-title {
                color: #1A1A1A;
                background: #F9F9F9;
                border-bottom-color: #E5E5E5;
                text-shadow: none;
            }
            .dh-confirm-overlay.dh-theme-m3l .dh-confirm-box {
                background: #FEF7FF;
                border: none;
                border-radius: 28px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                color: #1D1B20;
                font-family: "Roboto", "Segoe UI", system-ui, sans-serif;
            }
            .dh-confirm-overlay.dh-theme-m3l .dh-confirm-title {
                color: #1D1B20;
                background: transparent;
                border-bottom-color: #CAC4D0;
                text-shadow: none;
            }
            .dh-confirm-overlay.dh-theme-m3d .dh-confirm-box {
                background: #2B2930;
                border: none;
                border-radius: 28px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.4);
                color: #E6E0E9;
                font-family: "Roboto", "Segoe UI", system-ui, sans-serif;
            }
            .dh-confirm-overlay.dh-theme-m3d .dh-confirm-title {
                color: #E6E0E9;
                background: transparent;
                border-bottom-color: #49454F;
                text-shadow: none;
            }
            .dh-confirm-overlay.dh-theme-glass .dh-confirm-box {
                background: rgba(255,255,255,0.10);
                backdrop-filter: blur(40px) saturate(160%);
                -webkit-backdrop-filter: blur(40px) saturate(160%);
                border: 1px solid rgba(255,255,255,0.15);
                border-radius: 28px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.2);
                color: rgba(255,255,255,0.96);
                font-family: -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif;
            }
            .dh-confirm-overlay.dh-theme-glass .dh-confirm-title {
                color: rgba(255,255,255,0.96);
                background: transparent;
                border-bottom-color: rgba(255,255,255,0.12);
                text-shadow: none;
            }
            /* Confirm buttons/inputs — Vista */
            .dh-confirm-overlay.dh-theme-vista .dh-btn {
                background: linear-gradient(to bottom, #FFFFFF, #E0E8F0);
                border: 1px solid #A0B0C8;
                border-radius: 4px;
                color: #1A2A40;
            }
            .dh-confirm-overlay.dh-theme-vista .dh-btn-primary {
                background: linear-gradient(to bottom, #5B9FE6, #3A7BD5);
                border-color: #2A6BC5;
                color: #fff;
            }
            /* Confirm buttons/inputs — Win95 already done */
            /* Confirm buttons/inputs — MacOS */
            .dh-confirm-overlay.dh-theme-macos .dh-btn {
                background: linear-gradient(to bottom, #FFFFFF, #E8E8E8);
                border: 1px solid #B0B0B0;
                border-radius: 6px;
                color: #333;
                font-family: inherit;
            }
            .dh-confirm-overlay.dh-theme-macos .dh-btn-primary {
                background: linear-gradient(to bottom, #5B9FE6, #3A7BD5);
                border-color: #2A6BC5;
                color: #fff;
            }
            .dh-confirm-overlay.dh-theme-macos .dh-input {
                border: 1px solid #B0B0B0;
                border-radius: 5px;
                background: #fff;
                color: #333;
            }
            .dh-confirm-overlay.dh-theme-macos .dh-setting-label { color: #333; }
            /* Confirm buttons/inputs — iOS old */
            .dh-confirm-overlay.dh-theme-iosold .dh-btn {
                background: linear-gradient(to bottom, #F8F8F8, #D0D0D0);
                border: 1px solid #A0A0A0;
                border-radius: 10px;
                color: #333;
            }
            .dh-confirm-overlay.dh-theme-iosold .dh-btn-primary {
                background: linear-gradient(to bottom, #6AB0F0, #3080D0);
                border-color: #2060A0;
                color: #fff;
            }
            .dh-confirm-overlay.dh-theme-iosold .dh-input {
                border: 1px solid #A0A0A0;
                border-radius: 8px;
                background: #fff;
                color: #222;
            }
            .dh-confirm-overlay.dh-theme-iosold .dh-setting-label { color: #222; }
            /* Confirm buttons/inputs — Die my Darling */
            .dh-confirm-overlay.dh-theme-dmd .dh-btn {
                background: #2A0808;
                border: 1px solid #8B0000;
                border-radius: 2px;
                color: #FF6666;
            }
            .dh-confirm-overlay.dh-theme-dmd .dh-btn-primary {
                background: #8B0000;
                border-color: #FF2222;
                color: #fff;
            }
            .dh-confirm-overlay.dh-theme-dmd .dh-input {
                background: #2A0808;
                border: 1px solid #8B0000;
                border-radius: 2px;
                color: #FFAAAA;
            }
            .dh-confirm-overlay.dh-theme-dmd .dh-setting-label { color: #CC9999; }
            /* Confirm buttons/inputs — Win11 */
            .dh-confirm-overlay.dh-theme-win11 .dh-btn {
                background: #FFFFFF;
                border: 1px solid #E5E5E5;
                border-radius: 4px;
                color: #1A1A1A;
            }
            .dh-confirm-overlay.dh-theme-win11 .dh-btn-primary {
                background: #0067C0;
                border-color: #0067C0;
                color: #fff;
            }
            .dh-confirm-overlay.dh-theme-win11 .dh-input {
                background: #FFFFFF;
                border: 1px solid #E5E5E5;
                border-radius: 4px;
                color: #1A1A1A;
            }
            .dh-confirm-overlay.dh-theme-win11 .dh-setting-label { color: #1A1A1A; }
            /* Confirm buttons/inputs — Material 3 Light */
            .dh-confirm-overlay.dh-theme-m3l .dh-btn {
                background: transparent;
                border: 1px solid #79747E;
                border-radius: 9999px;
                color: #6750A4;
                font-family: inherit;
                font-weight: 500;
            }
            .dh-confirm-overlay.dh-theme-m3l .dh-btn-primary {
                background: #6750A4;
                border-color: #6750A4;
                color: #fff;
            }
            .dh-confirm-overlay.dh-theme-m3l .dh-input {
                background: #FFFFFF;
                border: 1px solid #79747E;
                border-radius: 4px 4px 0 0;
                border-bottom: 2px solid #79747E;
                color: #1D1B20;
            }
            .dh-confirm-overlay.dh-theme-m3l .dh-setting-label { color: #1D1B20; }
            /* Confirm buttons/inputs — Material 3 Dark */
            .dh-confirm-overlay.dh-theme-m3d .dh-btn {
                background: transparent;
                border: 1px solid #938F99;
                border-radius: 9999px;
                color: #D0BCFF;
                font-family: inherit;
                font-weight: 500;
            }
            .dh-confirm-overlay.dh-theme-m3d .dh-btn-primary {
                background: #D0BCFF;
                border-color: #D0BCFF;
                color: #381E72;
            }
            .dh-confirm-overlay.dh-theme-m3d .dh-input {
                background: #211F26;
                border: 1px solid #938F99;
                border-radius: 4px 4px 0 0;
                border-bottom: 2px solid #938F99;
                color: #E6E0E9;
            }
            .dh-confirm-overlay.dh-theme-m3d .dh-setting-label { color: #E6E0E9; }
            /* Confirm buttons/inputs — iOS Liquid Glass */
            .dh-confirm-overlay.dh-theme-glass {
                background: rgba(0,0,0,0.25);
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
            }
            .dh-confirm-overlay.dh-theme-glass .dh-btn {
                background: rgba(255,255,255,0.10);
                border: 1px solid rgba(255,255,255,0.12);
                border-radius: 20px;
                color: rgba(255,255,255,0.96);
                font-family: inherit;
            }
            .dh-confirm-overlay.dh-theme-glass .dh-btn-primary {
                background: rgba(10,132,255,0.55);
                border-color: rgba(10,132,255,0.7);
                color: #fff;
            }
            .dh-confirm-overlay.dh-theme-glass .dh-input {
                background: rgba(255,255,255,0.10);
                border: 1px solid rgba(255,255,255,0.12);
                border-radius: 12px;
                color: rgba(255,255,255,0.96);
            }
            .dh-confirm-overlay.dh-theme-glass .dh-setting-label { color: rgba(255,255,255,0.96); }
            .dh-confirm-overlay.dh-theme-glass .dh-setting-label small { color: rgba(255,255,255,0.55); }

            /* ===== Accordion ===== */
            .dh-acc {
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 10px;
                background: rgba(0,0,0,0.12);
                overflow: hidden;
                flex-shrink: 0;
            }
            .dh-acc-head {
                width: 100%;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                padding: 10px 12px;
                background: transparent;
                border: none;
                color: inherit;
                font: 700 12px/1.3 Tahoma, "Segoe UI", sans-serif;
                cursor: pointer;
                text-align: left;
                font-family: inherit;
            }
            .dh-acc-title {
                flex: 1;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .dh-acc-arrow {
                transition: transform 0.25s ease;
                opacity: 0.7;
                font-size: 12px;
                flex-shrink: 0;
            }
            .dh-acc.open .dh-acc-arrow { transform: rotate(180deg); }
            .dh-acc-body {
                display: grid;
                grid-template-rows: 0fr;
                transition: grid-template-rows 0.28s ease;
            }
            .dh-acc.open .dh-acc-body { grid-template-rows: 1fr; }
            .dh-acc-inner {
                overflow: hidden;
                min-height: 0;
                padding: 0 12px;
            }
            .dh-acc.open .dh-acc-inner { padding-bottom: 12px; }

            /* Sub-accordion (inside My Account) */
            .dh-sub-body {
                display: grid;
                grid-template-rows: 0fr;
                transition: grid-template-rows 0.28s ease;
            }
            .dh-sub-body.open { grid-template-rows: 1fr; }
            .dh-sub-inner {
                overflow: hidden;
                min-height: 0;
            }

            /* XP card accents by theme */
            .dh-modal.dh-theme-vista .dh-acc {
                border-color: rgba(120,160,210,0.35);
                background: rgba(255,255,255,0.35);
            }
            .dh-modal.dh-theme-win95 .dh-acc {
                border: 2px solid;
                border-color: #808080 #FFF #FFF #808080;
                border-radius: 0;
                background: #C0C0C0;
            }

            /* ===== Theme picker ===== */
            .dh-theme-picker { display: flex; gap: 6px; flex-wrap: wrap; }
            .dh-theme-btn {
                padding: 5px 10px;
                border: 1px solid #003C74;
                border-radius: 3px;
                background: linear-gradient(to bottom, #F5F4EA 0%, #E5E1D0 45%, #D2CEB8 100%);
                color: #000;
                font-size: 11px;
                font-weight: 700;
                cursor: pointer;
                font-family: Tahoma, sans-serif;
            }
            .dh-theme-btn.active {
                background: linear-gradient(to bottom, #6EC27A, #3D8F4A);
                border-color: #2D6B36;
                color: #fff;
            }

            /* ======================= THEME: Windows Vista ======================= */
            .dh-modal.dh-theme-vista {
                background: #E8EEF5;
                border: 1px solid rgba(40, 70, 110, 0.55);
                border-radius: 10px;
                box-shadow:
                    0 12px 40px rgba(0, 0, 0, 0.45),
                    0 0 0 1px rgba(255, 255, 255, 0.35) inset;
                font-family: "Segoe UI", Tahoma, sans-serif;
            }
            .dh-modal.dh-theme-vista .dh-titlebar {
                height: 32px;
                border-radius: 9px 9px 0 0;
                background:
                    linear-gradient(to bottom,
                        rgba(255,255,255,0.45) 0%,
                        rgba(255,255,255,0.12) 45%,
                        rgba(120,170,220,0.15) 50%,
                        rgba(20,50,100,0.35) 100%),
                    linear-gradient(to right, #1B3A5F 0%, #2E6DA8 45%, #1B3A5F 100%);
                box-shadow:
                    inset 0 1px 0 rgba(255,255,255,0.45),
                    0 1px 2px rgba(0,0,0,0.2);
            }
            .dh-modal.dh-theme-vista .dh-titlebar .dh-title-text {
                font-family: "Segoe UI", sans-serif;
                font-weight: 600;
                letter-spacing: 0.3px;
                text-shadow: 0 1px 2px rgba(0,0,0,0.55);
            }
            .dh-modal.dh-theme-vista .dh-titlebar .dh-chip {
                background: rgba(255,255,255,0.22);
                border: 1px solid rgba(255,255,255,0.28);
            }
            .dh-modal.dh-theme-vista .dh-win-btn {
                width: 26px;
                height: 20px;
                border-radius: 4px;
                border: 1px solid rgba(255,255,255,0.55);
                font-family: "Segoe UI", sans-serif;
                font-size: 12px;
            }
            .dh-modal.dh-theme-vista .dh-win-btn.min {
                background: linear-gradient(to bottom, rgba(220,235,255,0.95), rgba(90,140,200,0.95));
                color: #fff;
            }
            .dh-modal.dh-theme-vista .dh-win-btn.close {
                background: linear-gradient(to bottom, #F5A08C, #D63A1F);
            }
            .dh-modal.dh-theme-vista .dh-body {
                background: #E8EEF5;
            }
            .dh-modal.dh-theme-vista .dh-tabs {
                background: rgba(255,255,255,0.35);
                border: 1px solid rgba(255,255,255,0.55);
                border-radius: 6px;
                padding: 3px;
            }
            .dh-modal.dh-theme-vista .dh-tab {
                border: 1px solid transparent;
                border-radius: 4px;
                background: transparent;
                color: #27476A;
                top: 0;
                font-family: "Segoe UI", sans-serif;
            }
            .dh-modal.dh-theme-vista .dh-tab.active {
                background: linear-gradient(to bottom, #FFFFFF, #DCE8F5);
                border-color: rgba(90,140,200,0.55);
                box-shadow: 0 1px 2px rgba(0,0,0,0.12);
                color: #1B3A5F;
                top: 0;
            }
            .dh-modal.dh-theme-vista .dh-btn {
                border-radius: 4px;
                border: 1px solid rgba(70,110,160,0.55);
                background: linear-gradient(to bottom, #F7FAFD 0%, #DCE8F5 50%, #C2D4E8 100%);
                font-family: "Segoe UI", sans-serif;
            }
            .dh-modal.dh-theme-vista .dh-btn-primary {
                background: linear-gradient(to bottom, #7EC27E 0%, #3F9A4C 50%, #2F7D3B 100%);
                border-color: #2A6B33;
            }
            .dh-modal.dh-theme-vista .dh-btn-danger {
                background: linear-gradient(to bottom, #F09A8C 0%, #D64A38 50%, #B93A2A 100%);
                border-color: #8B2A20;
            }
            .dh-modal.dh-theme-vista .dh-card {
                background: rgba(255,255,255,0.72);
                border: 1px solid rgba(120,160,210,0.35);
                border-radius: 6px;
                box-shadow: 0 1px 2px rgba(0,0,0,0.06);
            }
            .dh-modal.dh-theme-vista .dh-input,
            .dh-modal.dh-theme-vista .dh-num-input {
                border-radius: 3px;
                border: 1px solid #7F9DB9;
                box-shadow: inset 0 1px 2px rgba(0,0,0,0.08);
            }
            .dh-modal.dh-theme-vista .dh-footer {
                background: rgba(232,238,245,0.95);
                border-top: 1px solid rgba(120,160,210,0.35);
            }
            .dh-modal.dh-theme-vista .dh-update-banner {
                background: linear-gradient(to bottom, #E5F3D8, #C8E4A8);
                border-radius: 5px;
            }
            .dh-modal.dh-theme-vista .dh-theme-btn {
                border-radius: 4px;
                border-color: rgba(70,110,160,0.55);
                background: linear-gradient(to bottom, #F7FAFD 0%, #DCE8F5 50%, #C2D4E8 100%);
                font-family: "Segoe UI", sans-serif;
            }
            .dh-modal.dh-theme-vista .dh-theme-btn.active {
                background: linear-gradient(to bottom, #7EC27E, #2F7D3B);
                border-color: #2A6B33;
            }
            .dh-modal.dh-theme-vista .dh-shop-card {
                background: #F7F9FC;
                border-color: #B8CCE0;
                border-radius: 10px;
            }
            .dh-modal.dh-theme-vista .dh-lb-row.me {
                background: rgba(100,180,255,0.15);
                box-shadow: inset 0 0 0 1.5px #4A90D9;
            }

            /* ======================= THEME: Windows 95 ======================= */
            .dh-modal.dh-theme-win95 {
                background: #C0C0C0;
                border: 2px solid;
                border-color: #DFDFDF #000000 #000000 #DFDFDF;
                border-radius: 0;
                box-shadow:
                    2px 2px 0 rgba(0,0,0,0.35),
                    inset 1px 1px 0 #FFFFFF,
                    inset -1px -1px 0 #808080;
                color: #000;
                font-family: "MS Sans Serif", "Microsoft Sans Serif", Tahoma, sans-serif;
                font-size: 12px;
            }
            .dh-modal.dh-theme-win95 .dh-titlebar {
                height: 22px;
                border-radius: 0;
                padding: 0 2px 0 4px;
                gap: 4px;
                background: linear-gradient(to right, #000080, #1084D0);
                box-shadow: none;
            }
            .dh-modal.dh-theme-win95 .dh-titlebar .dh-title-icon { font-size: 13px; }
            .dh-modal.dh-theme-win95 .dh-titlebar .dh-title-text {
                font-family: "MS Sans Serif", "Microsoft Sans Serif", Tahoma, sans-serif;
                font-size: 12px;
                font-weight: 700;
                letter-spacing: 0;
                text-shadow: none;
            }
            .dh-modal.dh-theme-win95 .dh-titlebar .dh-chip {
                background: #C0C0C0;
                color: #000;
                border: 1px solid;
                border-color: #FFF #808080 #808080 #FFF;
                border-radius: 0;
                padding: 0 5px;
                font-size: 10px;
            }
            .dh-modal.dh-theme-win95 .dh-win-btns { gap: 2px; }
            .dh-modal.dh-theme-win95 .dh-win-btn {
                width: 18px;
                height: 16px;
                border-radius: 0;
                border: 2px solid;
                border-color: #FFF #000 #000 #FFF;
                background: #C0C0C0;
                color: #000;
                font-size: 11px;
                font-weight: 700;
                text-shadow: none;
                padding: 0;
                line-height: 1;
            }
            .dh-modal.dh-theme-win95 .dh-win-btn.min,
            .dh-modal.dh-theme-win95 .dh-win-btn.close {
                background: #C0C0C0;
                color: #000;
            }
            .dh-modal.dh-theme-win95 .dh-win-btn:hover { filter: brightness(1.06); }
            .dh-modal.dh-theme-win95 .dh-win-btn:active {
                border-color: #000 #FFF #FFF #000;
                filter: none;
            }
            .dh-modal.dh-theme-win95 .dh-body {
                background: #C0C0C0;
            }
            .dh-modal.dh-theme-win95 .dh-body::-webkit-scrollbar-track {
                background: #C0C0C0;
                border-left: 1px solid #808080;
            }
            .dh-modal.dh-theme-win95 .dh-body::-webkit-scrollbar-thumb {
                background: #C0C0C0;
                border: 2px solid;
                border-color: #FFF #000 #000 #FFF;
                border-radius: 0;
            }
            .dh-modal.dh-theme-win95 .dh-tabs {
                background: #C0C0C0;
                gap: 0;
                padding: 0;
                margin-bottom: 8px;
                border-bottom: 1px solid #808080;
            }
            .dh-modal.dh-theme-win95 .dh-tab {
                border: 2px solid;
                border-color: #FFF #808080 #C0C0C0 #FFF;
                border-bottom: none;
                border-radius: 0;
                background: #C0C0C0;
                color: #000;
                top: 0;
                padding: 3px 10px;
                font-family: "MS Sans Serif", "Microsoft Sans Serif", Tahoma, sans-serif;
                font-size: 11px;
            }
            .dh-modal.dh-theme-win95 .dh-tab.active {
                background: #C0C0C0;
                color: #000;
                border-color: #FFF #808080 #C0C0C0 #FFF;
                box-shadow: none;
                top: 1px;
                margin-bottom: -1px;
                padding-top: 4px;
            }
            .dh-modal.dh-theme-win95 .dh-btn {
                border-radius: 0;
                border: 2px solid;
                border-color: #FFF #000 #000 #FFF;
                background: #C0C0C0;
                color: #000;
                box-shadow: none;
                font-family: "MS Sans Serif", "Microsoft Sans Serif", Tahoma, sans-serif;
                padding: 4px 10px;
            }
            .dh-modal.dh-theme-win95 .dh-btn:active {
                border-color: #000 #FFF #FFF #000;
                background: #C0C0C0;
                box-shadow: none;
                filter: none;
            }
            .dh-modal.dh-theme-win95 .dh-btn-primary {
                background: #C0C0C0;
                color: #000;
                border-color: #FFF #000 #000 #FFF;
                font-weight: 700;
                text-shadow: none;
            }
            .dh-modal.dh-theme-win95 .dh-btn-danger {
                background: #C0C0C0;
                color: #000;
                border-color: #FFF #000 #000 #FFF;
                font-weight: 700;
                text-shadow: none;
            }
            .dh-modal.dh-theme-win95 .dh-btn:disabled {
                color: #808080;
                background: #C0C0C0;
                border-color: #FFF #808080 #808080 #FFF;
                text-shadow: none;
            }
            .dh-modal.dh-theme-win95 .dh-card {
                background: #C0C0C0;
                border: 2px solid;
                border-color: #808080 #FFF #FFF #808080;
                border-radius: 0;
                box-shadow: none;
            }
            .dh-modal.dh-theme-win95 .dh-card-title {
                color: #000;
                text-transform: none;
                letter-spacing: 0;
                font-family: inherit;
            }
            .dh-modal.dh-theme-win95 .dh-muted { color: #444; }
            .dh-modal.dh-theme-win95 .dh-input,
            .dh-modal.dh-theme-win95 .dh-num-input {
                border-radius: 0;
                border: 2px solid;
                border-color: #808080 #FFF #FFF #808080;
                background: #FFF;
                font-family: "MS Sans Serif", "Microsoft Sans Serif", Tahoma, sans-serif;
            }
            .dh-modal.dh-theme-win95 .dh-setting-row {
                border-bottom: 1px solid #808080;
            }
            .dh-modal.dh-theme-win95 .dh-setting-label { color: #000; }
            .dh-modal.dh-theme-win95 .dh-setting-label small { color: #444; }
            .dh-modal.dh-theme-win95 .dh-switch {
                border-radius: 0;
                border: 2px solid;
                border-color: #808080 #FFF #FFF #808080;
                background: #C0C0C0;
            }
            .dh-modal.dh-theme-win95 .dh-switch.on {
                background: #000080;
                border-color: #808080 #FFF #FFF #808080;
            }
            .dh-modal.dh-theme-win95 .dh-switch::after {
                border-radius: 0;
                border: 2px solid;
                border-color: #FFF #000 #000 #FFF;
                background: #C0C0C0;
            }
            .dh-modal.dh-theme-win95 .dh-footer {
                background: #C0C0C0;
                border-top: 1px solid #808080;
            }
            .dh-modal.dh-theme-win95 .dh-update-banner {
                background: #C0C0C0;
                border: 2px solid;
                border-color: #FFF #000 #000 #FFF;
                border-radius: 0;
                color: #000;
            }
            .dh-modal.dh-theme-win95 .dh-update-btn {
                border-radius: 0;
                border: 2px solid;
                border-color: #FFF #000 #000 #FFF;
                background: #C0C0C0;
                color: #000;
                font-family: inherit;
                font-weight: 700;
            }
            .dh-modal.dh-theme-win95 .dh-theme-btn {
                border-radius: 0;
                border: 2px solid;
                border-color: #FFF #000 #000 #FFF;
                background: #C0C0C0;
                color: #000;
                font-family: inherit;
            }
            .dh-modal.dh-theme-win95 .dh-theme-btn.active {
                background: #000080;
                color: #fff;
                border-color: #FFF #000 #000 #FFF;
            }
            .dh-modal.dh-theme-win95 .dh-status-yes { color: #006000; }
            .dh-modal.dh-theme-win95 .dh-status-no { color: #800000; }
            .dh-modal.dh-theme-win95 .dh-status-checking { color: #804000; }
            .dh-modal.dh-theme-win95 .dh-status-error { color: #804000; }
            .dh-modal.dh-theme-win95 .dh-shop-card {
                background: #C0C0C0;
                border: 2px solid;
                border-color: #FFF #808080 #808080 #FFF;
                border-radius: 0;
            }
            .dh-modal.dh-theme-win95 .dh-shop-card .name { color: #000; }
            .dh-modal.dh-theme-win95 .dh-shop-card .desc { color: #404040; }
            .dh-modal.dh-theme-win95 .dh-lb-row.me {
                background: #000080;
                color: #fff;
                box-shadow: none;
            }
            .dh-modal.dh-theme-win95 .dh-lb-row.me .gap { color: #ccc; }

            /* ======================= THEME: MacOS ======================= */
            .dh-modal.dh-theme-macos {
                background: #E8E8E8;
                border: 1px solid #B0B0B0;
                border-radius: 10px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.25), 0 0 0 0.5px rgba(0,0,0,0.1);
                color: #333;
                font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
            }
            .dh-modal.dh-theme-macos .dh-titlebar {
                background: linear-gradient(to bottom, #E8E8E8, #D0D0D0);
                border-bottom: 1px solid #B0B0B0;
                border-radius: 10px 10px 0 0;
                padding: 6px 12px;
            }
            .dh-modal.dh-theme-macos .dh-titlebar .dh-title-text {
                color: #333;
                font-size: 12px;
                font-weight: 600;
                text-align: center;
            }
            .dh-modal.dh-theme-macos .dh-win-btn {
                background: none;
                border: none;
                width: 14px;
                height: 14px;
                border-radius: 50%;
                font-size: 9px;
                color: #fff;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                cursor: default;
                padding: 0;
            }
            .dh-modal.dh-theme-macos .dh-win-btn.close { background: #FF5F57; }
            .dh-modal.dh-theme-macos .dh-win-btn.min { background: #FEBC2E; }
            .dh-modal.dh-theme-macos .dh-win-btn:nth-child(3) { background: #28C840; }
            .dh-modal.dh-theme-macos .dh-body {
                background: #F5F5F5;
            }
            .dh-modal.dh-theme-macos .dh-tabs {
                background: linear-gradient(to bottom, #E0E0E0, #D0D0D0);
                border-bottom: 1px solid #B0B0B0;
            }
            .dh-modal.dh-theme-macos .dh-tab {
                background: transparent;
                border: none;
                border-radius: 6px;
                color: #555;
            }
            .dh-modal.dh-theme-macos .dh-tab.active {
                background: rgba(255,255,255,0.7);
                color: #333;
                box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            }
            .dh-modal.dh-theme-macos .dh-btn {
                background: linear-gradient(to bottom, #FFFFFF, #E8E8E8);
                border: 1px solid #B0B0B0;
                border-radius: 6px;
                color: #333;
                font-family: inherit;
            }
            .dh-modal.dh-theme-macos .dh-btn-primary {
                background: linear-gradient(to bottom, #5B9FE6, #3A7BD5);
                border-color: #2A6BC5;
                color: #fff;
            }
            .dh-modal.dh-theme-macos .dh-btn-danger {
                background: linear-gradient(to bottom, #FF6B6B, #E04040);
                border-color: #C03030;
                color: #fff;
            }
            .dh-modal.dh-theme-macos .dh-input,
            .dh-modal.dh-theme-macos .dh-num-input {
                border: 1px solid #B0B0B0;
                border-radius: 5px;
                background: #fff;
            }
            .dh-modal.dh-theme-macos .dh-card,
            .dh-modal.dh-theme-macos .dh-shop-card {
                background: #fff;
                border-color: #D0D0D0;
                border-radius: 10px;
            }
            .dh-modal.dh-theme-macos .dh-setting-row {
                border-bottom-color: #E0E0E0;
            }
            .dh-modal.dh-theme-macos .dh-acc {
                background: #ECECEC;
                border-color: #D0D0D0;
                border-radius: 8px;
            }
            .dh-modal.dh-theme-macos .dh-acc-head {
                background: linear-gradient(to bottom, #E8E8E8, #D8D8D8);
                border-radius: 8px;
            }
            .dh-modal.dh-theme-macos .dh-switch {
                background: linear-gradient(to bottom, #E0E0E0, #C8C8C8);
            }
            .dh-modal.dh-theme-macos .dh-switch.on {
                background: linear-gradient(to bottom, #6BB8F0, #3A7BD5);
            }
            .dh-modal.dh-theme-macos .dh-footer {
                background: #E8E8E8;
                border-top: 1px solid #D0D0D0;
                border-radius: 0 0 10px 10px;
            }
            .dh-modal.dh-theme-macos .dh-lb-row.me {
                background: rgba(58,123,213,0.12);
                box-shadow: inset 0 0 0 1.5px #3A7BD5;
            }
            .dh-modal.dh-theme-macos .dh-select {
                background: #fff;
                border-color: #B0B0B0;
                color: #333;
            }
            .dh-modal.dh-theme-macos .dh-select-options {
                background: #fff;
                border-color: #B0B0B0;
            }
            .dh-modal.dh-theme-macos .dh-select-option {
                color: #333;
            }
            .dh-modal.dh-theme-macos .dh-select-option:hover {
                background: rgba(58,123,213,0.15);
            }

            /* ======================= THEME: iOS old ======================= */
            .dh-modal.dh-theme-iosold {
                background: #C8C8C8;
                border: 1px solid #808080;
                border-radius: 12px;
                box-shadow: 0 4px 20px rgba(0,0,0,0.3);
                color: #222;
                font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
            }
            .dh-modal.dh-theme-iosold .dh-titlebar {
                background: linear-gradient(to bottom, #B8B8B8, #909090);
                border-bottom: 2px solid #707070;
                border-radius: 12px 12px 0 0;
                padding: 8px 12px;
            }
            .dh-modal.dh-theme-iosold .dh-titlebar .dh-title-text {
                color: #fff;
                font-size: 14px;
                font-weight: 700;
                text-shadow: 0 -1px 0 rgba(0,0,0,0.3);
                text-align: center;
            }
            .dh-modal.dh-theme-iosold .dh-win-btn {
                background: linear-gradient(to bottom, #FF8A8A, #E04040);
                border: 1px solid #B03030;
                border-radius: 8px;
                color: #fff;
                text-shadow: 0 -1px 0 rgba(0,0,0,0.2);
            }
            .dh-modal.dh-theme-iosold .dh-win-btn.min {
                background: linear-gradient(to bottom, #FFD080, #E0A030);
                border-color: #B08020;
            }
            .dh-modal.dh-theme-iosold .dh-body {
                background: repeating-linear-gradient(
                    0deg,
                    #D8D8D8 0px,
                    #D0D0D0 1px,
                    #D8D8D8 2px
                );
            }
            .dh-modal.dh-theme-iosold .dh-tabs {
                background: linear-gradient(to bottom, #A0A0A0, #808080);
                border-bottom: 2px solid #606060;
                padding: 4px;
                gap: 2px;
            }
            .dh-modal.dh-theme-iosold .dh-tab {
                background: linear-gradient(to bottom, #C0C0C0, #A0A0A0);
                border: 1px solid #707070;
                border-radius: 8px;
                color: #333;
                text-shadow: 0 1px 0 rgba(255,255,255,0.3);
                padding: 6px 12px;
            }
            .dh-modal.dh-theme-iosold .dh-tab.active {
                background: linear-gradient(to bottom, #6AB0F0, #3080D0);
                border-color: #2060A0;
                color: #fff;
                text-shadow: 0 -1px 0 rgba(0,0,0,0.2);
            }
            .dh-modal.dh-theme-iosold .dh-btn {
                background: linear-gradient(to bottom, #F8F8F8, #D0D0D0);
                border: 1px solid #A0A0A0;
                border-radius: 10px;
                color: #333;
                text-shadow: 0 1px 0 rgba(255,255,255,0.4);
            }
            .dh-modal.dh-theme-iosold .dh-btn-primary {
                background: linear-gradient(to bottom, #6AB0F0, #3080D0);
                border-color: #2060A0;
                color: #fff;
                text-shadow: 0 -1px 0 rgba(0,0,0,0.2);
            }
            .dh-modal.dh-theme-iosold .dh-btn-danger {
                background: linear-gradient(to bottom, #FF8A8A, #E04040);
                border-color: #B03030;
                color: #fff;
                text-shadow: 0 -1px 0 rgba(0,0,0,0.2);
            }
            .dh-modal.dh-theme-iosold .dh-input,
            .dh-modal.dh-theme-iosold .dh-num-input {
                border: 1px solid #A0A0A0;
                border-radius: 8px;
                background: #fff;
            }
            .dh-modal.dh-theme-iosold .dh-card,
            .dh-modal.dh-theme-iosold .dh-shop-card {
                background: linear-gradient(to bottom, #F0F0F0, #E0E0E0);
                border-color: #A0A0A0;
                border-radius: 12px;
            }
            .dh-modal.dh-theme-iosold .dh-setting-row {
                border-bottom-color: #B0B0B0;
            }
            .dh-modal.dh-theme-iosold .dh-acc {
                background: #D0D0D0;
                border-color: #A0A0A0;
                border-radius: 10px;
            }
            .dh-modal.dh-theme-iosold .dh-acc-head {
                background: linear-gradient(to bottom, #C8C8C8, #B0B0B0);
                border-radius: 10px;
            }
            .dh-modal.dh-theme-iosold .dh-switch {
                background: linear-gradient(to bottom, #B0B0B0, #909090);
            }
            .dh-modal.dh-theme-iosold .dh-switch.on {
                background: linear-gradient(to bottom, #6AB0F0, #3080D0);
            }
            .dh-modal.dh-theme-iosold .dh-footer {
                background: linear-gradient(to bottom, #B0B0B0, #909090);
                border-top: 2px solid #707070;
                border-radius: 0 0 12px 12px;
            }
            .dh-modal.dh-theme-iosold .dh-lb-row.me {
                background: rgba(48,128,208,0.15);
                box-shadow: inset 0 0 0 1.5px #3080D0;
            }
            .dh-modal.dh-theme-iosold .dh-select {
                background: linear-gradient(to bottom, #F8F8F8, #E0E0E0);
                border-color: #A0A0A0;
                color: #333;
            }
            .dh-modal.dh-theme-iosold .dh-select-options {
                background: #F0F0F0;
                border-color: #A0A0A0;
            }
            .dh-modal.dh-theme-iosold .dh-select-option {
                color: #333;
            }
            .dh-modal.dh-theme-iosold .dh-select-option:hover {
                background: rgba(48,128,208,0.15);
            }

            /* ======================= THEME: Die my Darling ======================= */
            .dh-modal.dh-theme-dmd {
                background: #1A0A0A;
                border: 2px solid #8B0000;
                border-radius: 4px;
                box-shadow: 0 0 30px rgba(139,0,0,0.4), 0 0 60px rgba(139,0,0,0.15);
                color: #E0C0C0;
                font-family: Georgia, "Times New Roman", serif;
            }
            .dh-modal.dh-theme-dmd .dh-titlebar {
                background: linear-gradient(to bottom, #3A1010, #2A0808);
                border-bottom: 2px solid #8B0000;
                padding: 6px 12px;
            }
            .dh-modal.dh-theme-dmd .dh-titlebar .dh-title-text {
                color: #FF4444;
                font-size: 13px;
                font-weight: 700;
                letter-spacing: 0.1em;
                text-transform: uppercase;
            }
            .dh-modal.dh-theme-dmd .dh-win-btn {
                background: #2A0808;
                border: 1px solid #8B0000;
                color: #FF4444;
                border-radius: 2px;
            }
            .dh-modal.dh-theme-dmd .dh-win-btn:hover {
                background: #8B0000;
                color: #fff;
            }
            .dh-modal.dh-theme-dmd .dh-body {
                background: #1A0A0A;
            }
            .dh-modal.dh-theme-dmd .dh-tabs {
                background: #2A0808;
                border-bottom: 2px solid #8B0000;
            }
            .dh-modal.dh-theme-dmd .dh-tab {
                background: transparent;
                border: 1px solid #4A1010;
                border-radius: 2px;
                color: #AA6666;
            }
            .dh-modal.dh-theme-dmd .dh-tab.active {
                background: #8B0000;
                border-color: #FF2222;
                color: #fff;
            }
            .dh-modal.dh-theme-dmd .dh-btn {
                background: #2A0808;
                border: 1px solid #8B0000;
                border-radius: 2px;
                color: #FF6666;
            }
            .dh-modal.dh-theme-dmd .dh-btn:hover {
                background: #3A1010;
                border-color: #FF2222;
            }
            .dh-modal.dh-theme-dmd .dh-btn-primary {
                background: #8B0000;
                border-color: #FF2222;
                color: #fff;
            }
            .dh-modal.dh-theme-dmd .dh-btn-primary:hover {
                background: #AA0000;
            }
            .dh-modal.dh-theme-dmd .dh-btn-danger {
                background: #4A0000;
                border-color: #CC0000;
                color: #FF8888;
            }
            .dh-modal.dh-theme-dmd .dh-input,
            .dh-modal.dh-theme-dmd .dh-num-input {
                background: #2A0808;
                border: 1px solid #8B0000;
                border-radius: 2px;
                color: #FFAAAA;
            }
            .dh-modal.dh-theme-dmd .dh-card,
            .dh-modal.dh-theme-dmd .dh-shop-card {
                background: #2A0808;
                border-color: #6A1010;
                border-radius: 3px;
            }
            .dh-modal.dh-theme-dmd .dh-shop-card:hover {
                box-shadow: 0 0 12px rgba(139,0,0,0.5);
            }
            .dh-modal.dh-theme-dmd .dh-shop-card .name { color: #FF6666; }
            .dh-modal.dh-theme-dmd .dh-shop-card .desc { color: #AA6666; }
            .dh-modal.dh-theme-dmd .dh-setting-row {
                border-bottom-color: #4A1010;
            }
            .dh-modal.dh-theme-dmd .dh-acc {
                background: #220808;
                border-color: #6A1010;
                border-radius: 2px;
            }
            .dh-modal.dh-theme-dmd .dh-acc-head {
                background: linear-gradient(to bottom, #3A1010, #2A0808);
                border-radius: 2px;
            }
            .dh-modal.dh-theme-dmd .dh-acc-title {
                color: #FF4444;
            }
            .dh-modal.dh-theme-dmd .dh-switch {
                background: #2A0808;
                border: 1px solid #8B0000;
            }
            .dh-modal.dh-theme-dmd .dh-switch.on {
                background: #8B0000;
            }
            .dh-modal.dh-theme-dmd .dh-footer {
                background: #2A0808;
                border-top: 2px solid #8B0000;
            }
            .dh-modal.dh-theme-dmd .dh-muted { color: #996666; }
            .dh-modal.dh-theme-dmd .dh-card-title { color: #CC4444; }
            .dh-modal.dh-theme-dmd .dh-setting-label { color: #CC9999; }
            .dh-modal.dh-theme-dmd .dh-setting-label small { color: #996666; }
            .dh-modal.dh-theme-dmd .dh-select {
                background: #2A0808;
                border-color: #8B0000;
            }
            .dh-modal.dh-theme-dmd .dh-select-options {
                background: #2A0808;
                border-color: #8B0000;
            }
            .dh-modal.dh-theme-dmd .dh-select-option {
                color: #CC9999;
            }
            .dh-modal.dh-theme-dmd .dh-select-option:hover {
                background: #8B0000;
                color: #fff;
            }
            .dh-modal.dh-theme-dmd .dh-lb-row.me {
                background: rgba(139,0,0,0.25);
                box-shadow: inset 0 0 0 1.5px #FF2222;
            }
            .dh-modal.dh-theme-dmd .dh-lb-row .gap.up { color: #FF6666; }
            .dh-modal.dh-theme-dmd .dh-lb-row .gap.down { color: #AA4444; }
            .dh-modal.dh-theme-dmd .dh-status-yes { color: #FF4444; }
            .dh-modal.dh-theme-dmd .dh-status-no { color: #FF8888; }

            /* ======================= THEME: Win11 (Fluent / Mica) ======================= */
            .dh-modal.dh-theme-win11 {
                background: #F3F3F3;
                border: 1px solid #E5E5E5;
                border-radius: 8px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.12), 0 0 0 0.5px rgba(0,0,0,0.05);
                color: #1A1A1A;
                font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
            }
            .dh-modal.dh-theme-win11 .dh-titlebar {
                background: #F9F9F9;
                border-bottom: 1px solid #E5E5E5;
                border-radius: 8px 8px 0 0;
                padding: 6px 12px;
            }
            .dh-modal.dh-theme-win11 .dh-titlebar .dh-title-text {
                color: #1A1A1A;
                font-size: 12px;
                font-weight: 600;
                text-align: center;
            }
            .dh-modal.dh-theme-win11 .dh-win-btn {
                background: none;
                border: none;
                width: 30px;
                height: 30px;
                border-radius: 4px;
                font-size: 12px;
                color: #1A1A1A;
                display: inline-flex;
                align-items: center;
                justify-content: center;
            }
            .dh-modal.dh-theme-win11 .dh-win-btn:hover {
                background: rgba(0,0,0,0.05);
            }
            .dh-modal.dh-theme-win11 .dh-win-btn.close:hover {
                background: #C42B1C;
                color: #fff;
            }
            .dh-modal.dh-theme-win11 .dh-body {
                background: #F3F3F3;
            }
            .dh-modal.dh-theme-win11 .dh-tabs {
                background: #F9F9F9;
                border-bottom: 1px solid #E5E5E5;
            }
            .dh-modal.dh-theme-win11 .dh-tab {
                background: transparent;
                border: none;
                border-radius: 4px;
                color: #5D5D5D;
            }
            .dh-modal.dh-theme-win11 .dh-tab:hover {
                background: rgba(0,0,0,0.04);
            }
            .dh-modal.dh-theme-win11 .dh-tab.active {
                background: rgba(0,103,192,0.08);
                color: #0067C0;
                font-weight: 600;
            }
            .dh-modal.dh-theme-win11 .dh-btn {
                background: #FFFFFF;
                border: 1px solid #E5E5E5;
                border-radius: 4px;
                color: #1A1A1A;
                font-family: inherit;
            }
            .dh-modal.dh-theme-win11 .dh-btn:hover {
                background: #F0F0F0;
                border-color: #C8C8C8;
            }
            .dh-modal.dh-theme-win11 .dh-btn-primary {
                background: #0067C0;
                border-color: #0067C0;
                color: #fff;
            }
            .dh-modal.dh-theme-win11 .dh-btn-primary:hover {
                background: #0078D4;
            }
            .dh-modal.dh-theme-win11 .dh-btn-danger {
                background: #C42B1C;
                border-color: #C42B1C;
                color: #fff;
            }
            .dh-modal.dh-theme-win11 .dh-input,
            .dh-modal.dh-theme-win11 .dh-num-input {
                background: #FFFFFF;
                border: 1px solid #E5E5E5;
                border-radius: 4px;
                color: #1A1A1A;
            }
            .dh-modal.dh-theme-win11 .dh-card,
            .dh-modal.dh-theme-win11 .dh-shop-card {
                background: #FFFFFF;
                border-color: #E5E5E5;
                border-radius: 8px;
            }
            .dh-modal.dh-theme-win11 .dh-shop-card .name { color: #1A1A1A; }
            .dh-modal.dh-theme-win11 .dh-shop-card .desc { color: #5D5D5D; }
            .dh-modal.dh-theme-win11 .dh-setting-row {
                border-bottom-color: #E5E5E5;
            }
            .dh-modal.dh-theme-win11 .dh-acc {
                background: #FFFFFF;
                border-color: #E5E5E5;
                border-radius: 8px;
            }
            .dh-modal.dh-theme-win11 .dh-acc-head {
                background: #F9F9F9;
                border-radius: 8px;
            }
            .dh-modal.dh-theme-win11 .dh-switch {
                background: #E5E5E5;
                border: 1px solid #C8C8C8;
            }
            .dh-modal.dh-theme-win11 .dh-switch.on {
                background: #0067C0;
                border-color: #0067C0;
            }
            .dh-modal.dh-theme-win11 .dh-footer {
                background: #F9F9F9;
                border-top: 1px solid #E5E5E5;
                border-radius: 0 0 8px 8px;
            }
            .dh-modal.dh-theme-win11 .dh-muted { color: #5D5D5D; }
            .dh-modal.dh-theme-win11 .dh-card-title { color: #5D5D5D; }
            .dh-modal.dh-theme-win11 .dh-setting-label { color: #1A1A1A; }
            .dh-modal.dh-theme-win11 .dh-setting-label small { color: #5D5D5D; }
            .dh-modal.dh-theme-win11 .dh-select {
                background: #FFFFFF;
                border-color: #E5E5E5;
                color: #1A1A1A;
            }
            .dh-modal.dh-theme-win11 .dh-select-options {
                background: #FFFFFF;
                border-color: #E5E5E5;
                box-shadow: 0 8px 24px rgba(0,0,0,0.12);
            }
            .dh-modal.dh-theme-win11 .dh-select-option {
                color: #1A1A1A;
            }
            .dh-modal.dh-theme-win11 .dh-select-option:hover {
                background: rgba(0,103,192,0.08);
            }
            .dh-modal.dh-theme-win11 .dh-lb-row.me {
                background: rgba(0,103,192,0.08);
                box-shadow: inset 0 0 0 1.5px #0067C0;
            }
            .dh-modal.dh-theme-win11 .dh-lb-row .gap.up { color: #0F7B0F; }
            .dh-modal.dh-theme-win11 .dh-lb-row .gap.down { color: #C42B1C; }
            .dh-modal.dh-theme-win11 .dh-status-yes { color: #0F7B0F; }
            .dh-modal.dh-theme-win11 .dh-status-no { color: #C42B1C; }

            /* ======================= THEME: Material 3 Light ======================= */
            .dh-modal.dh-theme-m3l {
                background: #FEF7FF;
                border: 1px solid #E6E0E9;
                border-radius: 16px;
                box-shadow: 0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.08);
                color: #1D1B20;
                font-family: "Roboto", "Segoe UI", system-ui, sans-serif;
            }
            .dh-modal.dh-theme-m3l .dh-titlebar {
                background: #FEF7FF;
                border-bottom: 1px solid #E6E0E9;
                border-radius: 16px 16px 0 0;
                padding: 8px 14px;
            }
            .dh-modal.dh-theme-m3l .dh-titlebar .dh-title-text {
                color: #1D1B20;
                font-size: 14px;
                font-weight: 500;
            }
            .dh-modal.dh-theme-m3l .dh-win-btn {
                background: none;
                border: none;
                width: 32px;
                height: 32px;
                border-radius: 16px;
                font-size: 12px;
                color: #49454F;
            }
            .dh-modal.dh-theme-m3l .dh-win-btn:hover { background: rgba(103,80,164,0.08); }
            .dh-modal.dh-theme-m3l .dh-win-btn.close:hover { background: rgba(179,38,30,0.12); color: #B3261E; }
            .dh-modal.dh-theme-m3l .dh-body { background: #FEF7FF; }
            .dh-modal.dh-theme-m3l .dh-tabs {
                background: #FEF7FF;
                border-bottom: 1px solid #E6E0E9;
                padding: 4px;
                gap: 4px;
            }
            .dh-modal.dh-theme-m3l .dh-tab {
                background: transparent;
                border: none;
                border-radius: 9999px;
                color: #49454F;
                font-weight: 500;
                padding: 8px 16px;
            }
            .dh-modal.dh-theme-m3l .dh-tab:hover { background: rgba(103,80,164,0.08); }
            .dh-modal.dh-theme-m3l .dh-tab.active {
                background: #EADDFF;
                color: #21005D;
            }
            .dh-modal.dh-theme-m3l .dh-btn {
                background: transparent;
                border: 1px solid #79747E;
                border-radius: 9999px;
                color: #6750A4;
                font-family: inherit;
                font-weight: 500;
            }
            .dh-modal.dh-theme-m3l .dh-btn:hover { background: rgba(103,80,164,0.08); }
            .dh-modal.dh-theme-m3l .dh-btn-primary {
                background: #6750A4;
                border-color: #6750A4;
                color: #FFFFFF;
            }
            .dh-modal.dh-theme-m3l .dh-btn-primary:hover { background: #5B4390; }
            .dh-modal.dh-theme-m3l .dh-btn-danger {
                background: #B3261E;
                border-color: #B3261E;
                color: #FFFFFF;
            }
            .dh-modal.dh-theme-m3l .dh-input,
            .dh-modal.dh-theme-m3l .dh-num-input {
                background: #FFFFFF;
                border: 1px solid #79747E;
                border-radius: 4px 4px 0 0;
                border-bottom: 2px solid #79747E;
                color: #1D1B20;
                font-family: inherit;
            }
            .dh-modal.dh-theme-m3l .dh-card,
            .dh-modal.dh-theme-m3l .dh-shop-card {
                background: #E6E0E9;
                border: none;
                border-radius: 12px;
            }
            .dh-modal.dh-theme-m3l .dh-shop-card:hover { box-shadow: 0 1px 3px rgba(0,0,0,0.15); }
            .dh-modal.dh-theme-m3l .dh-shop-card .name { color: #1D1B20; }
            .dh-modal.dh-theme-m3l .dh-shop-card .desc { color: #49454F; }
            .dh-modal.dh-theme-m3l .dh-setting-row { border-bottom-color: #CAC4D0; }
            .dh-modal.dh-theme-m3l .dh-acc {
                background: #F1ECF4;
                border: none;
                border-radius: 12px;
            }
            .dh-modal.dh-theme-m3l .dh-acc-head {
                background: #F1ECF4;
                border-radius: 12px;
            }
            .dh-modal.dh-theme-m3l .dh-switch {
                background: #E6E0E9;
                border: 2px solid #79747E;
            }
            .dh-modal.dh-theme-m3l .dh-switch.on {
                background: #6750A4;
                border-color: #6750A4;
            }
            .dh-modal.dh-theme-m3l .dh-footer {
                background: #F7F2FA;
                border-top: 1px solid #E6E0E9;
                border-radius: 0 0 16px 16px;
            }
            .dh-modal.dh-theme-m3l .dh-muted { color: #49454F; }
            .dh-modal.dh-theme-m3l .dh-card-title { color: #49454F; }
            .dh-modal.dh-theme-m3l .dh-setting-label { color: #1D1B20; }
            .dh-modal.dh-theme-m3l .dh-setting-label small { color: #49454F; }
            .dh-modal.dh-theme-m3l .dh-select {
                background: #FFFFFF;
                border-color: #79747E;
                border-radius: 4px;
                color: #1D1B20;
            }
            .dh-modal.dh-theme-m3l .dh-select-options {
                background: #FFFFFF;
                border-color: #CAC4D0;
                border-radius: 12px;
                box-shadow: 0 2px 6px rgba(0,0,0,0.15);
            }
            .dh-modal.dh-theme-m3l .dh-select-option { color: #1D1B20; }
            .dh-modal.dh-theme-m3l .dh-select-option:hover {
                background: rgba(103,80,164,0.08);
            }
            .dh-modal.dh-theme-m3l .dh-lb-row.me {
                background: rgba(103,80,164,0.12);
                box-shadow: inset 0 0 0 2px #6750A4;
            }
            .dh-modal.dh-theme-m3l .dh-lb-row .gap.up { color: #146C2E; }
            .dh-modal.dh-theme-m3l .dh-lb-row .gap.down { color: #B3261E; }
            .dh-modal.dh-theme-m3l .dh-status-yes { color: #146C2E; }
            .dh-modal.dh-theme-m3l .dh-status-no { color: #B3261E; }

            /* ======================= THEME: Material 3 Dark ======================= */
            .dh-modal.dh-theme-m3d {
                background: #141218;
                border: 1px solid #49454F;
                border-radius: 16px;
                box-shadow: 0 1px 3px rgba(0,0,0,0.4);
                color: #E6E0E9;
                font-family: "Roboto", "Segoe UI", system-ui, sans-serif;
            }
            .dh-modal.dh-theme-m3d .dh-titlebar {
                background: #141218;
                border-bottom: 1px solid #49454F;
                border-radius: 16px 16px 0 0;
                padding: 8px 14px;
            }
            .dh-modal.dh-theme-m3d .dh-titlebar .dh-title-text {
                color: #E6E0E9;
                font-size: 14px;
                font-weight: 500;
            }
            .dh-modal.dh-theme-m3d .dh-win-btn {
                background: none;
                border: none;
                width: 32px;
                height: 32px;
                border-radius: 16px;
                font-size: 12px;
                color: #CAC4D0;
            }
            .dh-modal.dh-theme-m3d .dh-win-btn:hover { background: rgba(208,188,255,0.08); }
            .dh-modal.dh-theme-m3d .dh-win-btn.close:hover { background: rgba(242,184,181,0.15); color: #F2B8B5; }
            .dh-modal.dh-theme-m3d .dh-body { background: #141218; }
            .dh-modal.dh-theme-m3d .dh-tabs {
                background: #141218;
                border-bottom: 1px solid #49454F;
                padding: 4px;
                gap: 4px;
            }
            .dh-modal.dh-theme-m3d .dh-tab {
                background: transparent;
                border: none;
                border-radius: 9999px;
                color: #CAC4D0;
                font-weight: 500;
                padding: 8px 16px;
            }
            .dh-modal.dh-theme-m3d .dh-tab:hover { background: rgba(208,188,255,0.08); }
            .dh-modal.dh-theme-m3d .dh-tab.active {
                background: #4F378B;
                color: #EADDFF;
            }
            .dh-modal.dh-theme-m3d .dh-btn {
                background: transparent;
                border: 1px solid #938F99;
                border-radius: 9999px;
                color: #D0BCFF;
                font-family: inherit;
                font-weight: 500;
            }
            .dh-modal.dh-theme-m3d .dh-btn:hover { background: rgba(208,188,255,0.08); }
            .dh-modal.dh-theme-m3d .dh-btn-primary {
                background: #D0BCFF;
                border-color: #D0BCFF;
                color: #381E72;
            }
            .dh-modal.dh-theme-m3d .dh-btn-primary:hover { background: #BFA8FF; }
            .dh-modal.dh-theme-m3d .dh-btn-danger {
                background: #F2B8B5;
                border-color: #F2B8B5;
                color: #601410;
            }
            .dh-modal.dh-theme-m3d .dh-input,
            .dh-modal.dh-theme-m3d .dh-num-input {
                background: #211F26;
                border: 1px solid #938F99;
                border-radius: 4px 4px 0 0;
                border-bottom: 2px solid #938F99;
                color: #E6E0E9;
                font-family: inherit;
            }
            .dh-modal.dh-theme-m3d .dh-card,
            .dh-modal.dh-theme-m3d .dh-shop-card {
                background: #36343B;
                border: none;
                border-radius: 12px;
            }
            .dh-modal.dh-theme-m3d .dh-shop-card:hover { box-shadow: 0 1px 3px rgba(0,0,0,0.4); }
            .dh-modal.dh-theme-m3d .dh-shop-card .name { color: #E6E0E9; }
            .dh-modal.dh-theme-m3d .dh-shop-card .desc { color: #CAC4D0; }
            .dh-modal.dh-theme-m3d .dh-setting-row { border-bottom-color: #49454F; }
            .dh-modal.dh-theme-m3d .dh-acc {
                background: #211F26;
                border: none;
                border-radius: 12px;
            }
            .dh-modal.dh-theme-m3d .dh-acc-head {
                background: #211F26;
                border-radius: 12px;
            }
            .dh-modal.dh-theme-m3d .dh-switch {
                background: #36343B;
                border: 2px solid #938F99;
            }
            .dh-modal.dh-theme-m3d .dh-switch.on {
                background: #D0BCFF;
                border-color: #D0BCFF;
            }
            .dh-modal.dh-theme-m3d .dh-footer {
                background: #1D1B20;
                border-top: 1px solid #49454F;
                border-radius: 0 0 16px 16px;
            }
            .dh-modal.dh-theme-m3d .dh-muted { color: #CAC4D0; }
            .dh-modal.dh-theme-m3d .dh-card-title { color: #CAC4D0; }
            .dh-modal.dh-theme-m3d .dh-setting-label { color: #E6E0E9; }
            .dh-modal.dh-theme-m3d .dh-setting-label small { color: #CAC4D0; }
            .dh-modal.dh-theme-m3d .dh-select {
                background: #211F26;
                border-color: #938F99;
                border-radius: 4px;
                color: #E6E0E9;
            }
            .dh-modal.dh-theme-m3d .dh-select-options {
                background: #2B2930;
                border-color: #49454F;
                border-radius: 12px;
                box-shadow: 0 2px 6px rgba(0,0,0,0.4);
            }
            .dh-modal.dh-theme-m3d .dh-select-option { color: #E6E0E9; }
            .dh-modal.dh-theme-m3d .dh-select-option:hover {
                background: rgba(208,188,255,0.08);
            }
            .dh-modal.dh-theme-m3d .dh-lb-row.me {
                background: rgba(208,188,255,0.12);
                box-shadow: inset 0 0 0 2px #D0BCFF;
            }
            .dh-modal.dh-theme-m3d .dh-lb-row .gap.up { color: #7BDE8E; }
            .dh-modal.dh-theme-m3d .dh-lb-row .gap.down { color: #F2B8B5; }
            .dh-modal.dh-theme-m3d .dh-status-yes { color: #7BDE8E; }
            .dh-modal.dh-theme-m3d .dh-status-no { color: #F2B8B5; }

            /* ======================= THEME: iOS Liquid Glass ======================= */
            .dh-modal.dh-theme-glass {
                background: rgba(255,255,255,0.06);
                backdrop-filter: blur(32px) saturate(160%);
                -webkit-backdrop-filter: blur(32px) saturate(160%);
                border: 1px solid rgba(255,255,255,0.12);
                border-radius: 28px;
                overflow: hidden;
                box-shadow: 0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.15);
                color: rgba(255,255,255,0.96);
                font-family: -apple-system, "SF Pro Text", "Helvetica Neue", Helvetica, sans-serif;
            }
            .dh-modal.dh-theme-glass .dh-titlebar {
                background: rgba(255,255,255,0.08);
                border-bottom: 1px solid rgba(255,255,255,0.12);
                border-radius: 28px 28px 0 0;
                padding: 8px 14px;
            }
            .dh-modal.dh-theme-glass .dh-titlebar .dh-title-text {
                color: rgba(255,255,255,0.96);
                font-size: 14px;
                font-weight: 600;
            }
            .dh-modal.dh-theme-glass .dh-win-btn {
                background: rgba(255,255,255,0.10);
                border: 1px solid rgba(255,255,255,0.12);
                width: 22px;
                height: 22px;
                border-radius: 11px;
                font-size: 10px;
                color: rgba(255,255,255,0.8);
                flex-shrink: 0;
            }
            .dh-modal.dh-theme-glass .dh-win-btn:hover { background: rgba(255,255,255,0.18); }
            .dh-modal.dh-theme-glass .dh-win-btn.close:hover { background: rgba(255,69,58,0.6); color: #fff; }
            .dh-modal.dh-theme-glass .dh-body {
                background: transparent;
            }
            .dh-modal.dh-theme-glass .dh-tabs {
                background: rgba(255,255,255,0.06);
                border-bottom: 1px solid rgba(255,255,255,0.12);
                padding: 6px;
                gap: 4px;
            }
            .dh-modal.dh-theme-glass .dh-tab {
                background: transparent;
                border: none;
                border-radius: 9999px;
                color: rgba(255,255,255,0.68);
                font-weight: 500;
                padding: 8px 16px;
            }
            .dh-modal.dh-theme-glass .dh-tab:hover { background: rgba(255,255,255,0.10); }
            .dh-modal.dh-theme-glass .dh-tab.active {
                background: rgba(255,255,255,0.18);
                color: #fff;
            }
            .dh-modal.dh-theme-glass .dh-btn {
                background: rgba(255,255,255,0.10);
                border: 1px solid rgba(255,255,255,0.12);
                border-radius: 20px;
                color: rgba(255,255,255,0.96);
                font-family: inherit;
                backdrop-filter: blur(16px);
                -webkit-backdrop-filter: blur(16px);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.2);
            }
            .dh-modal.dh-theme-glass .dh-btn:hover { background: rgba(255,255,255,0.16); }
            .dh-modal.dh-theme-glass .dh-btn-primary {
                background: rgba(10,132,255,0.55);
                border-color: rgba(10,132,255,0.7);
                color: #fff;
            }
            .dh-modal.dh-theme-glass .dh-btn-primary:hover { background: rgba(10,132,255,0.7); }
            .dh-modal.dh-theme-glass .dh-btn-danger {
                background: rgba(255,69,58,0.5);
                border-color: rgba(255,69,58,0.6);
                color: #fff;
            }
            .dh-modal.dh-theme-glass .dh-input,
            .dh-modal.dh-theme-glass .dh-num-input {
                background: rgba(255,255,255,0.10);
                border: 1px solid rgba(255,255,255,0.12);
                border-radius: 12px;
                color: rgba(255,255,255,0.96);
                font-family: inherit;
            }
            .dh-modal.dh-theme-glass .dh-card,
            .dh-modal.dh-theme-glass .dh-shop-card {
                background: rgba(255,255,255,0.06);
                border: 1px solid rgba(255,255,255,0.10);
                border-radius: 16px;
            }
            .dh-modal.dh-theme-glass .dh-shop-card:hover { background: rgba(255,255,255,0.10); }
            .dh-modal.dh-theme-glass .dh-shop-card .name { color: rgba(255,255,255,0.96); }
            .dh-modal.dh-theme-glass .dh-shop-card .desc { color: rgba(255,255,255,0.68); }
            .dh-modal.dh-theme-glass .dh-setting-row { border-bottom-color: rgba(255,255,255,0.10); }
            .dh-modal.dh-theme-glass .dh-acc {
                background: rgba(255,255,255,0.06);
                border: 1px solid rgba(255,255,255,0.10);
                border-radius: 16px;
            }
            .dh-modal.dh-theme-glass .dh-acc-head {
                background: rgba(255,255,255,0.08);
                border-radius: 16px;
            }
            .dh-modal.dh-theme-glass .dh-switch {
                background: rgba(255,255,255,0.15);
                border: 1px solid rgba(255,255,255,0.2);
            }
            .dh-modal.dh-theme-glass .dh-switch.on {
                background: rgba(10,132,255,0.6);
                border-color: rgba(10,132,255,0.8);
            }
            .dh-modal.dh-theme-glass .dh-footer {
                background: rgba(255,255,255,0.08);
                border-top: 1px solid rgba(255,255,255,0.12);
                border-radius: 0 0 28px 28px;
            }
            .dh-modal.dh-theme-glass .dh-muted { color: rgba(255,255,255,0.68); }
            .dh-modal.dh-theme-glass .dh-card-title { color: rgba(255,255,255,0.68); }
            .dh-modal.dh-theme-glass .dh-setting-label { color: rgba(255,255,255,0.96); }
            .dh-modal.dh-theme-glass .dh-setting-label small { color: rgba(255,255,255,0.55); }
            .dh-modal.dh-theme-glass .dh-select {
                background: rgba(255,255,255,0.10);
                border-color: rgba(255,255,255,0.12);
                border-radius: 12px;
                color: rgba(255,255,255,0.96);
            }
            .dh-modal.dh-theme-glass .dh-select-options {
                background: rgba(30,20,50,0.92);
                border-color: rgba(255,255,255,0.12);
                border-radius: 12px;
                box-shadow: 0 8px 24px rgba(0,0,0,0.4);
            }
            .dh-modal.dh-theme-glass .dh-select-option { color: rgba(255,255,255,0.9); }
            .dh-modal.dh-theme-glass .dh-select-option:hover {
                background: rgba(255,255,255,0.10);
            }
            .dh-modal.dh-theme-glass .dh-lb-row.me {
                background: rgba(10,132,255,0.2);
                box-shadow: inset 0 0 0 1.5px rgba(10,132,255,0.6);
            }
            .dh-modal.dh-theme-glass .dh-lb-row .gap.up { color: rgba(125,222,142,0.9); }
            .dh-modal.dh-theme-glass .dh-lb-row .gap.down { color: rgba(255,105,98,0.9); }
            .dh-modal.dh-theme-glass .dh-status-yes { color: rgba(125,222,142,0.9); }
            .dh-modal.dh-theme-glass .dh-status-no { color: rgba(255,105,98,0.9); }
            .dh-modal.dh-theme-glass.dh-min {
                border-radius: 16px;
            }
            .dh-modal.dh-theme-glass.dh-min .dh-titlebar {
                border-radius: 16px 16px 0 0;
            }
        `;
    shadow.appendChild(style);

    // FAB
    const fab = document.createElement("button");
    fab.className = "dh-fab";
    fab.textContent = "🦉";
    fab.title = "Duolingo Helper";
    shadow.appendChild(fab);

    // Badge
    const badge = document.createElement("div");
    badge.className = "dh-badge";
    badge.innerHTML = `
        <span class="dh-badge-icon">…</span>
        <span>
            <span class="dh-badge-text">Проверка…</span>
            <span class="dh-badge-sub">нажми, чтобы открыть панель</span>
        </span>
    `;
    shadow.appendChild(badge);

    // Modal (XP window)
    const modal = document.createElement("div");
    modal.className = "dh-modal";
    modal.innerHTML = `
        <div class="dh-titlebar" id="dh-titlebar">
            <span class="dh-title-icon">🦉</span>
            <span class="dh-title-text">Duolingo Helper</span>
            <span class="dh-chip" id="dh-version-chip"></span>
            <div class="dh-win-btns">
                <button class="dh-win-btn" id="dh-about-btn" title="О скрипте" style="width:22px;height:22px">?</button>
                <button class="dh-win-btn" id="dh-bug-btn" title="Сообщить об ошибке" style="width:22px;height:22px">🐞</button>
                <button class="dh-win-btn min" id="dh-min-btn" title="Свернуть">–</button>
                <button class="dh-win-btn close" id="dh-close-btn" title="Закрыть">×</button>
            </div>
        </div>

        <div class="dh-body">
            <div class="dh-update-banner" id="dh-update-banner">
                <span id="dh-update-text"></span>
                <button class="dh-update-btn" id="dh-update-btn">⬆️ Установить</button>
            </div>

            <div class="dh-tabs">
                <button class="dh-tab active" data-tab="check">👤 Проверка</button>
                <button class="dh-tab" data-tab="friends">👥 Друзья</button>
                <button class="dh-tab" data-tab="tools">🧰 Инструменты</button>
                <button class="dh-tab" data-tab="settings">⚙️ Настройки</button>
            </div>

            <div class="dh-tab-content active" data-tab="check">
                <div class="dh-card">
                    <div class="dh-card-title">Текущий профиль</div>
                    <div class="dh-status-line" id="dh-status">
                        <span class="icon">…</span>
                        <span class="text">Открой профиль пользователя</span>
                    </div>
                    <div class="dh-muted" id="dh-status-sub" style="margin-top:6px">
                        Скрипт покажет, подписан ли он на тебя в ответ.
                    </div>
                </div>

                <div class="dh-row">
                    <input class="dh-input" id="dh-user-input" placeholder="username для проверки" />
                    <button class="dh-btn dh-btn-primary" id="dh-check-btn">Проверить</button>
                </div>

                <div class="dh-card" id="dh-manual-card" style="display:none">
                    <div class="dh-card-title">Ручная проверка</div>
                    <div class="dh-status-line" id="dh-manual-status">
                        <span class="icon">…</span>
                        <span class="text">—</span>
                    </div>
                    <div class="dh-muted" id="dh-manual-sub" style="margin-top:6px"></div>
                </div>

                <div class="dh-row">
                    <button class="dh-btn dh-btn-ghost" id="dh-recheck-btn">🔄 Перепроверить</button>
                    <button class="dh-btn dh-btn-ghost" id="dh-copy-btn">📋 Копировать</button>
                    <button class="dh-btn dh-btn-ghost" id="dh-refresh-page">🔄 Обновить</button>
                </div>

                <div class="dh-acc" data-acc>
                    <button type="button" class="dh-acc-head">
                        <span class="dh-acc-title">Мой аккаунт</span>
                        <span class="dh-acc-arrow">▾</span>
                    </button>
                    <div class="dh-acc-body"><div class="dh-acc-inner">
                        <div class="dh-muted" id="dh-me-info">Определение…</div>
                        <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(128,128,128,0.25)">
                            <button type="button" class="dh-sub-toggle" id="dh-stats-toggle" style="width:100%;display:flex;align-items:center;justify-content:space-between;background:none;border:none;cursor:pointer;padding:6px 0;font:inherit;color:inherit">
                                <span class="dh-card-title" style="margin:0">📊 Статистика</span>
                                <span class="dh-sub-arrow">▸</span>
                            </button>
                            <div class="dh-sub-body" id="dh-stats-body"><div class="dh-sub-inner" style="margin-top:6px">
                                <div style="display:flex;gap:6px;margin-bottom:8px">
                                    <div style="flex:1;background:rgba(128,128,128,0.08);border-radius:8px;padding:8px 6px;text-align:center">
                                        <div style="font-size:9px;opacity:0.6">⚡ Сегодня</div>
                                        <div style="font-size:15px;font-weight:700" id="dh-stat-today">…</div>
                                    </div>
                                    <div style="flex:1;background:rgba(128,128,128,0.08);border-radius:8px;padding:8px 6px;text-align:center">
                                        <div style="font-size:9px;opacity:0.6">📅 Неделя</div>
                                        <div style="font-size:15px;font-weight:700" id="dh-stat-week">…</div>
                                    </div>
                                    <div style="flex:1;background:rgba(128,128,128,0.08);border-radius:8px;padding:8px 6px;text-align:center">
                                        <div style="font-size:9px;opacity:0.6">🔥 Streak</div>
                                        <div style="font-size:15px;font-weight:700" id="dh-stat-streak">…</div>
                                    </div>
                                </div>
                                <div style="margin-bottom:8px">
                                    <div style="font-size:9px;opacity:0.6;margin-bottom:3px">XP за 7 дней</div>
                                    <div id="dh-stat-chart" style="display:flex;align-items:flex-end;gap:3px;height:36px"></div>
                                </div>
                            </div></div>
                        </div>
                        <div style="margin-top:4px;padding-top:8px;border-top:1px solid rgba(128,128,128,0.25)">
                            <button type="button" class="dh-sub-toggle" id="dh-dash-toggle" style="width:100%;display:flex;align-items:center;justify-content:space-between;background:none;border:none;cursor:pointer;padding:6px 0;font:inherit;color:inherit">
                                <span class="dh-card-title" style="margin:0">📋 Дашборд</span>
                                <span class="dh-sub-arrow">▸</span>
                            </button>
                            <div class="dh-sub-body" id="dh-dash-body"><div class="dh-sub-inner" style="margin-top:6px">
                                <div id="dh-acc-dashboard" style="display:flex;flex-direction:column;gap:6px"></div>
                            </div></div>
                        </div>
                        <div style="margin-top:4px;padding-top:8px;border-top:1px solid rgba(128,128,128,0.25)">
                            <button type="button" class="dh-sub-toggle" id="dh-acc-toggle" style="width:100%;display:flex;align-items:center;justify-content:space-between;background:none;border:none;cursor:pointer;padding:6px 0;font:inherit;color:inherit">
                                <span class="dh-card-title" style="margin:0">👥 Аккаунты</span>
                                <span class="dh-sub-arrow">▸</span>
                            </button>
                            <div class="dh-sub-body" id="dh-acc-list-wrap"><div class="dh-sub-inner" style="margin-top:6px">
                                <div class="dh-muted" style="margin-bottom:6px;font-size:10px">Чтобы второй аккаунт появился в списке — залогинься под ним на сайте Duolingo. После этого можно переключаться без повторного входа.</div>
                                <div id="dh-acc-list" style="display:flex;flex-direction:column;gap:4px"></div>
                            </div></div>
                        </div>
                        <div style="margin-top:4px;padding-top:8px;border-top:1px solid rgba(128,128,128,0.25)">
                            <button type="button" class="dh-sub-toggle" id="dh-privacy-toggle" style="width:100%;display:flex;align-items:center;justify-content:space-between;background:none;border:none;cursor:pointer;padding:6px 0;font:inherit;color:inherit">
                                <span class="dh-card-title" style="margin:0">🔒 Приватность</span>
                                <span class="dh-sub-arrow">▸</span>
                            </button>
                            <div class="dh-sub-body" id="dh-privacy-body"><div class="dh-sub-inner" style="margin-top:6px">
                                <div class="dh-muted" style="margin-bottom:6px;font-size:10px">Настройки приватности Duolingo. Состояние загружается с сервера.</div>
                                <div id="dh-privacy-list"></div>
                            </div></div>
                        </div>
                    </div></div>
                </div>

                <div class="dh-acc" data-acc>
                    <button type="button" class="dh-acc-head">
                        <span class="dh-acc-title">Метки</span>
                        <span class="dh-acc-arrow">▾</span>
                    </button>
                    <div class="dh-acc-body"><div class="dh-acc-inner">
                        <div id="dh-tags-form">
                            <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px">
                                <span style="font-size:16px">🏷</span>
                                <div class="dh-muted" id="dh-tags-user" style="font-size:11px">Метка для профиля</div>
                            </div>
                            <div style="margin-bottom:8px">
                                <div style="font-size:10px;opacity:0.6;margin-bottom:3px">Текст</div>
                                <input class="dh-input" id="dh-tag-label" maxlength="40" style="width:100%" />
                            </div>
                            <div style="display:flex;gap:8px;margin-bottom:10px">
                                <div style="flex:1">
                                    <div style="font-size:10px;opacity:0.6;margin-bottom:3px">Цвет</div>
                                    <input type="hidden" id="dh-tag-color" value="#58cc02" />
                                    <div id="dh-tag-palette" style="display:flex;flex-wrap:wrap;gap:5px">
                                        <button type="button" data-color="#58CC02" class="dh-swatch active" style="width:22px;height:22px;border-radius:50%;background:#58CC02;border:2px solid #fff;box-shadow:0 0 0 1.5px #58CC02;cursor:pointer;padding:0"></button>
                                        <button type="button" data-color="#1CB0F6" class="dh-swatch" style="width:22px;height:22px;border-radius:50%;background:#1CB0F6;border:2px solid #fff;box-shadow:0 0 0 1.5px transparent;cursor:pointer;padding:0"></button>
                                        <button type="button" data-color="#CE82FF" class="dh-swatch" style="width:22px;height:22px;border-radius:50%;background:#CE82FF;border:2px solid #fff;box-shadow:0 0 0 1.5px transparent;cursor:pointer;padding:0"></button>
                                        <button type="button" data-color="#FF4B4B" class="dh-swatch" style="width:22px;height:22px;border-radius:50%;background:#FF4B4B;border:2px solid #fff;box-shadow:0 0 0 1.5px transparent;cursor:pointer;padding:0"></button>
                                        <button type="button" data-color="#FF9600" class="dh-swatch" style="width:22px;height:22px;border-radius:50%;background:#FF9600;border:2px solid #fff;box-shadow:0 0 0 1.5px transparent;cursor:pointer;padding:0"></button>
                                        <button type="button" data-color="#FFC800" class="dh-swatch" style="width:22px;height:22px;border-radius:50%;background:#FFC800;border:2px solid #fff;box-shadow:0 0 0 1.5px transparent;cursor:pointer;padding:0"></button>
                                        <button type="button" data-color="#FF6482" class="dh-swatch" style="width:22px;height:22px;border-radius:50%;background:#FF6482;border:2px solid #fff;box-shadow:0 0 0 1.5px transparent;cursor:pointer;padding:0"></button>
                                        <button type="button" data-color="#00CCAA" class="dh-swatch" style="width:22px;height:22px;border-radius:50%;background:#00CCAA;border:2px solid #fff;box-shadow:0 0 0 1.5px transparent;cursor:pointer;padding:0"></button>
                                        <button type="button" data-color="#0078D4" class="dh-swatch" style="width:22px;height:22px;border-radius:50%;background:#0078D4;border:2px solid #fff;box-shadow:0 0 0 1.5px transparent;cursor:pointer;padding:0"></button>
                                        <button type="button" data-color="#8B5CF6" class="dh-swatch" style="width:22px;height:22px;border-radius:50%;background:#8B5CF6;border:2px solid #fff;box-shadow:0 0 0 1.5px transparent;cursor:pointer;padding:0"></button>
                                        <button type="button" data-color="#6B7280" class="dh-swatch" style="width:22px;height:22px;border-radius:50%;background:#6B7280;border:2px solid #fff;box-shadow:0 0 0 1.5px transparent;cursor:pointer;padding:0"></button>
                                        <button type="button" data-color="#1A1A1A" class="dh-swatch" style="width:22px;height:22px;border-radius:50%;background:#1A1A1A;border:2px solid #fff;box-shadow:0 0 0 1.5px transparent;cursor:pointer;padding:0"></button>
                                    </div>
                                </div>
                                <div style="flex:1">
                                    <div style="font-size:10px;opacity:0.6;margin-bottom:3px">Заметка</div>
                                    <input class="dh-input" id="dh-tag-note" maxlength="120" style="width:100%" />
                                </div>
                            </div>
                            <button class="dh-btn dh-btn-primary" id="dh-tag-save" style="width:100%">Сохранить метку</button>
                        </div>
                        <div class="dh-row" style="margin-top:8px">
                            <button type="button" id="dh-tags-open" style="background:none;border:none;color:#888;cursor:pointer;font:inherit;font-size:11px;padding:0;text-decoration:underline">Люди с метками<span id="dh-tags-badge" style="display:none;margin-left:3px;color:#888;font-size:11px;font-weight:400;text-decoration:none"></span></button>
                            <button type="button" id="dh-tags-back" style="display:none;background:none;border:none;color:#888;cursor:pointer;font:inherit;font-size:11px;padding:0;text-decoration:underline">← Назад</button>
                        </div>
                        <div id="dh-tags-list" style="display:none;flex-direction:column;gap:4px;margin-top:8px;max-height:36vh;overflow-y:auto;padding-right:8px"></div>
                    </div></div>
                </div>
            </div>

            <div class="dh-tab-content" data-tab="friends">
                <div class="dh-row" style="margin-bottom:4px">
                    <input class="dh-input" id="dh-friends-search" placeholder="Поиск по имени" />
                    <button class="dh-btn dh-btn-primary" id="dh-friends-load">Обновить</button>
                </div>
                <div class="dh-muted" style="display:flex;gap:12px;margin-bottom:8px;font-size:11px">
                    <button type="button" id="dh-history-open" style="background:none;border:none;color:#888;cursor:pointer;font:inherit;font-size:11px;padding:0;text-decoration:underline">История</button>
                    <button type="button" id="dh-exclude-open" style="background:none;border:none;color:#888;cursor:pointer;font:inherit;font-size:11px;padding:0;text-decoration:underline">Исключения<span id="dh-exclude-badge" style="display:none;margin-left:3px;color:#888;font-size:11px;font-weight:400;text-decoration:none"></span></button>
                    <button type="button" id="dh-blocks-open" style="background:none;border:none;color:#888;cursor:pointer;font:inherit;font-size:11px;padding:0;text-decoration:underline">Блоки<span id="dh-blocks-badge" style="display:none;margin-left:3px;color:#888;font-size:11px;font-weight:400;text-decoration:none"></span></button>
                    <button type="button" id="dh-changes-open" style="background:none;border:none;color:#888;cursor:pointer;font:inherit;font-size:11px;padding:0;text-decoration:underline">Изменения<span id="dh-changes-badge" style="display:none;min-width:16px;height:16px;padding:0 4px;margin-left:4px;border-radius:8px;background:#c0392b;color:#fff;font-size:10px;font-weight:700;line-height:16px;text-align:center;vertical-align:middle;text-decoration:none"></span></button>
                    <button type="button" id="dh-history-back" style="display:none;background:none;border:none;color:#888;cursor:pointer;font:inherit;font-size:11px;padding:0;text-decoration:underline">← Друзья</button>
                </div>
                <div class="dh-tabs" style="margin:8px 0" id="dh-friends-filters">
                    <button class="dh-tab active" data-friend-filter="all">Все</button>
                    <button class="dh-tab" data-friend-filter="nobody">❌ Не подписаны</button>
                    <button class="dh-tab" data-friend-filter="mutual">✅ Взаимно</button>
                    <button class="dh-tab" data-friend-filter="activity">📊 Активность</button>
                </div>
                <div class="dh-row" id="dh-all-tools" style="display:none;margin:0 0 8px">
                    <button type="button" id="dh-unfollow-anyone" style="background:none;border:none;color:#c0392b;cursor:pointer;font:inherit;font-size:11px;padding:0;text-decoration:underline">Отписаться от всех</button>
                </div>
                <div class="dh-row" id="dh-nobody-tools" style="display:none;margin:0 0 8px">
                    <button class="dh-btn dh-btn-danger" id="dh-unfollow-all" style="padding:5px 10px;font-size:11px">Отписаться от неподписанных</button>
                </div>
                <div id="dh-inactive-tools" style="display:none;margin:0 0 8px;flex-direction:column;gap:6px">
                    <div class="dh-row">
                        <button class="dh-btn dh-btn-primary" id="dh-scan-activity" style="padding:5px 10px;font-size:11px">Проверить активность</button>
                        <button class="dh-btn" id="dh-scan-stop" style="padding:5px 10px;font-size:11px">Стоп</button>
                        <div class="dh-select" id="dh-activity-sort" style="flex:1;min-width:0">
                            <span class="dh-select-text">Больше XP</span><span class="dh-select-arrow">▾</span>
                            <div class="dh-select-options">
                                <div class="dh-select-option" data-sort="xp_desc">Больше XP</div>
                                <div class="dh-select-option" data-sort="xp_asc">Меньше XP</div>
                                <div class="dh-select-option" data-sort="streak_desc">Больше дней</div>
                                <div class="dh-select-option" data-sort="streak_asc">Меньше дней</div>
                                <div class="dh-select-option" data-sort="name_asc">По имени A→Z</div>
                                <div class="dh-select-option" data-sort="name_desc">По имени Z→A</div>
                            </div>
                        </div>
                    </div>
                    <div class="dh-row" id="dh-inactive-mass" style="display:none">
                        <button class="dh-btn dh-btn-danger" id="dh-unfollow-inactive" title="Сначала пройди «Проверить активность»" style="padding:5px 8px;font-size:11px">Отписаться от неактивных</button>
                        <button class="dh-btn dh-btn-danger" id="dh-block-inactive" title="Сначала пройди «Проверить активность»" style="padding:5px 8px;font-size:11px">Заблокировать неактивных</button>
                    </div>
                </div>
                <div class="dh-muted dh-op-status" id="dh-friends-status"></div>
                <div id="dh-friends-list" style="display:flex;flex-direction:column;gap:4px;padding-right:8px"></div>
                <div id="dh-history-list" style="display:none;flex-direction:column;gap:4px;padding-right:8px"></div>
                <div id="dh-changes-list" style="display:none;flex-direction:column;gap:4px;padding-right:8px"></div>
                <div id="dh-exclude-list" style="display:none;flex-direction:column;gap:4px;padding-right:8px"></div>
                <div id="dh-blocks-list" style="display:none;flex-direction:column;gap:4px;padding-right:8px"></div>
            </div>

            <div class="dh-tab-content" data-tab="tools">
                <div class="dh-acc" data-acc>
                    <button type="button" class="dh-acc-head">
                        <span class="dh-acc-title">Защита сердец</span>
                        <span class="dh-acc-arrow">▾</span>
                    </button>
                    <div class="dh-acc-body"><div class="dh-acc-inner">
                        <div class="dh-setting-row" style="border-bottom:none;padding:4px 0">
                            <div class="dh-setting-label">
                                Блокировать списание сердец
                                <small>Не даёт Duolingo уменьшать сердца при ошибках в уроках</small>
                            </div>
                            <div class="dh-switch" id="dh-set-hearts"></div>
                        </div>
                        <div class="dh-muted" style="margin-top:6px">
                            Статус: <strong id="dh-hearts-status">…</strong>
                        </div>
                    </div></div>
                </div>

                <div class="dh-acc" data-acc>
                    <button type="button" class="dh-acc-head">
                        <span class="dh-acc-title">⚠️ Уроки — на свой страх и риск</span>
                        <span class="dh-acc-arrow">▾</span>
                    </button>
                    <div class="dh-acc-body"><div class="dh-acc-inner">
                        <div class="dh-setting-row" style="border-bottom:none;padding:4px 0">
                            <div class="dh-setting-label">
                                Короткие уроки
                                <small>Вместо полного урока 1–2 простых задания</small>
                            </div>
                            <div class="dh-switch" id="dh-set-short"></div>
                        </div>
                        <div class="dh-setting-row" style="border-bottom:none;padding:4px 0">
                            <div class="dh-setting-label">
                                Автосолвер
                                <small>Сам подставляет ответы в уроках</small>
                            </div>
                            <div class="dh-switch" id="dh-set-solver"></div>
                        </div>
                        <div class="dh-setting-row" style="border-bottom:none;padding:4px 0">
                            <div class="dh-setting-label">
                                Короткие stories
                                <small>Убирает вопросы и диалоги, оставляет заголовки</small>
                            </div>
                            <div class="dh-switch" id="dh-set-stories"></div>
                        </div>
                        <div class="dh-row" style="margin-top:6px">
                            <button class="dh-btn dh-btn-primary" id="dh-solve-now">Решить сейчас</button>
                        </div>
                        <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(128,128,128,0.25)">
                            <div class="dh-setting-label" style="margin-bottom:4px">
                                Автопрактика
                                <small>Решает уроки подряд без участия</small>
                            </div>
                            <div class="dh-row" style="gap:6px;align-items:center">
                                <input class="dh-num-input" id="dh-ap-count" type="number" min="1" max="999" value="10" style="width:56px" title="Количество уроков" />
                                <button class="dh-btn dh-btn-primary" id="dh-ap-start" style="padding:5px 12px;font-size:11px">Старт</button>
                                <button class="dh-btn dh-btn-danger" id="dh-ap-stop" style="padding:5px 12px;font-size:11px" disabled>Стоп</button>
                            </div>
                            <div class="dh-muted dh-op-status" id="dh-ap-status" style="margin-top:4px"></div>
                        </div>
                        <div class="dh-muted dh-op-status" id="dh-lesson-status"></div>
                    </div></div>
                </div>

                <div class="dh-acc" data-acc>
                    <button type="button" class="dh-acc-head">
                        <span class="dh-acc-title">⚠️ XP / буст — на свой страх и риск</span>
                        <span class="dh-acc-arrow">▾</span>
                    </button>
                    <div class="dh-acc-body"><div class="dh-acc-inner">
                        <div class="dh-muted" style="margin-bottom:8px">
                            Накрутка XP (реальное начисление, чит). Поле — цель в XP.
                        </div>
                        <div class="dh-row" style="margin-bottom:6px">
                            <input class="dh-num-input" id="dh-xp-amount" type="number" min="1" max="99999" value="500" style="width:72px" />
                            <button class="dh-btn dh-btn-primary" id="dh-xp-stories">Stories</button>
                            <button class="dh-btn dh-btn-danger" id="dh-xp-sessions" title="Экспериментально — может не начислять XP">Sessions *</button>
                            <button class="dh-btn" id="dh-xp-stop">Стоп</button>
                        </div>
                        <div class="dh-muted" style="margin-top:2px">
                            * Sessions — экспериментально, может не начислять XP<br/>
                            <small>Stories — истории Duolingo; за «пройденную» историю реально дают XP.</small><br/>
                            <small>Sessions — имитация учебной сессии/урока без прохождения.</small>
                        </div>
                        <div class="dh-muted dh-op-status" id="dh-xp-status"></div>
                    </div></div>
                </div>

                <div class="dh-acc" data-acc>
                    <button type="button" class="dh-acc-head">
                        <span class="dh-acc-title">⚠️ Квесты — на свой страх и риск</span>
                        <span class="dh-acc-arrow">▾</span>
                    </button>
                    <div class="dh-acc-body"><div class="dh-acc-inner">
                        <div class="dh-muted" style="margin-bottom:8px">
                            Инъекция прогресса в daily / weekly / friends / family / monthly. Нарушает правила Duolingo.
                        </div>
                        <div class="dh-row" style="margin-bottom:6px">
                            <button class="dh-btn dh-btn-primary" id="dh-quest-daily">Daily</button>
                            <button class="dh-btn" id="dh-quest-weekly">Weekly</button>
                            <button class="dh-btn" id="dh-quest-friends">Friends</button>
                        </div>
                        <div class="dh-row" style="margin-bottom:6px">
                            <button class="dh-btn" id="dh-quest-family">Family</button>
                            <button class="dh-btn" id="dh-quest-load">Monthly</button>
                            <button class="dh-btn" id="dh-quest-claim-all">Забрать все</button>
                        </div>
                        <div class="dh-muted dh-op-status" id="dh-quest-status"></div>
                        <div id="dh-quest-list" style="margin-top:8px;display:flex;flex-direction:column;gap:6px"></div>
                    </div></div>
                </div>

                <div class="dh-acc" data-acc>
                    <button type="button" class="dh-acc-head">
                        <span class="dh-acc-title">⚠️ Магазин — на свой страх и риск</span>
                        <span class="dh-acc-arrow">▾</span>
                    </button>
                    <div class="dh-acc-body"><div class="dh-acc-inner">
                        <div class="dh-muted" style="margin-bottom:8px">
                            Выдача предметов магазина без оплаты/гемов. Нарушает правила Duolingo.
                        </div>
                        <div class="dh-row" style="margin-bottom:6px">
                            <button class="dh-btn dh-btn-primary" id="dh-shop-load">Загрузить</button>
                            <button class="dh-btn dh-btn-danger" id="dh-shop-super">Super 3 дня</button>
                        </div>
                        <input class="dh-num-input" id="dh-shop-search" type="text" placeholder="Сначала загрузите список" style="width:100%;margin-bottom:4px;font-size:11px;opacity:0.5" disabled />
                        <div class="dh-muted dh-op-status" id="dh-shop-status"></div>
                        <div id="dh-shop-list" style="margin-top:8px;display:flex;flex-direction:column;gap:6px"></div>
                    </div></div>
                </div>

                <div class="dh-acc" data-acc>
                    <button type="button" class="dh-acc-head">
                        <span class="dh-acc-title">⚠️ Гемы (алмазы) — на свой страх и риск</span>
                        <span class="dh-acc-arrow">▾</span>
                    </button>
                    <div class="dh-acc-body"><div class="dh-acc-inner">
                        <div class="dh-muted" style="margin-bottom:8px">
                            Сбор rewardBundles (SKILL_COMPLETION). Кнопки GET в магазине баланс гемов НЕ пополняют.
                        </div>
                        <div class="dh-row" style="margin-bottom:6px">
                            <button class="dh-btn dh-btn-primary" id="dh-gems-once">Собрать</button>
                            <button class="dh-btn dh-btn-danger" id="dh-gems-farm">Фарм</button>
                            <button class="dh-btn dh-btn-danger" id="dh-gems-farm-fast" title="8 потоков одновременно — быстрее, но опаснее (rate limit)">Фарм ×8 *</button>
                            <button class="dh-btn" id="dh-gems-stop">Стоп</button>
                        </div>
                        <div class="dh-muted" style="margin-bottom:4px;font-size:10px">
                            * Фарм ×8 — 8 параллельных запросов. Быстрее, но выше риск rate limit.
                        </div>
                        <div class="dh-muted dh-op-status" id="dh-gems-status"></div>
                    </div></div>
                </div>

                <div class="dh-acc" data-acc>
                    <button type="button" class="dh-acc-head">
                        <span class="dh-acc-title">⚠️ Free Max / Super — на свой страх и риск</span>
                        <span class="dh-acc-arrow">▾</span>
                    </button>
                    <div class="dh-acc-body"><div class="dh-acc-inner">
                        <div class="dh-muted" style="margin-bottom:8px">
                            Подмена ответа GET /users — клиент видит Super/Max. Разблокирует клиентские функции, серверную подписку не даёт.
                        </div>
                        <div class="dh-setting-row" style="border-bottom:none;padding:4px 0">
                            <div class="dh-setting-label">
                                Free Max / Super
                                <small>Подменяет hasPlus и gold_subscription</small>
                            </div>
                            <div class="dh-switch" id="dh-set-freesuper"></div>
                        </div>
                    </div></div>
                </div>

                <div class="dh-acc" data-acc>
                    <button type="button" class="dh-acc-head">
                        <span class="dh-acc-title">⚠️ Streak — на свой страх и риск</span>
                        <span class="dh-acc-arrow">▾</span>
                    </button>
                    <div class="dh-acc-body"><div class="dh-acc-inner">
                        <div class="dh-muted" style="margin-bottom:8px">
                            Восстановление/накрутка дней серии через подмену дат в sessions. Нарушает правила Duolingo.
                        </div>
                        <div class="dh-row" style="margin-bottom:6px">
                            <input class="dh-num-input" id="dh-streak-days" type="number" min="1" max="365" value="7" style="width:64px" />
                            <button class="dh-btn dh-btn-primary" id="dh-streak-run">Накрутить дни</button>
                            <button class="dh-btn" id="dh-streak-stop">Стоп</button>
                        </div>
                        <div class="dh-muted dh-op-status" id="dh-streak-status"></div>
                    </div></div>
                </div>

                <div class="dh-acc" data-acc>
                    <button type="button" class="dh-acc-head">
                        <span class="dh-acc-title">⚠️ Лига — на свой страх и риск</span>
                        <span class="dh-acc-arrow">▾</span>
                    </button>
                    <div class="dh-acc-body"><div class="dh-acc-inner">
                        <div class="dh-muted" style="margin-bottom:8px">
                            Таблица лиги, вступление, накрутка до целевого места и реакции.
                        </div>
                        <div class="dh-row" style="margin-bottom:6px">
                            <button class="dh-btn dh-btn-primary" id="dh-lb-load">Таблица</button>
                            <button class="dh-btn" id="dh-lb-join">Вступить</button>
                        </div>
                        <div class="dh-row" style="margin-bottom:6px">
                            <input class="dh-num-input" id="dh-lb-target" type="number" min="1" max="100" value="3" style="width:56px" />
                            <button class="dh-btn dh-btn-danger" id="dh-lb-farm">Фарм до места</button>
                            <button class="dh-btn" id="dh-lb-stop">Стоп</button>
                        </div>
                        <div class="dh-muted dh-op-status" id="dh-lb-status"></div>
                        <div id="dh-lb-list" style="margin-top:8px;display:flex;flex-direction:column;gap:4px"></div>
                    </div></div>
                </div>
            </div>

            <div class="dh-tab-content" data-tab="settings">
                <div class="dh-setting-row">
                    <div class="dh-setting-label">
                        Автопроверка на профиле
                        <small>Сам проверять подписку при открытии профиля</small>
                    </div>
                    <div class="dh-switch" id="dh-set-auto"></div>
                </div>
                <div class="dh-setting-row">
                    <div class="dh-setting-label">
                        Показывать бейдж
                        <small>Плашка рядом с именем на профиле</small>
                    </div>
                    <div class="dh-switch" id="dh-set-badge"></div>
                </div>
                <div class="dh-setting-row">
                    <div class="dh-setting-label">
                        Стартовое состояние
                        <small>Как показывать окно при заходе на Duolingo</small>
                    </div>
                    <div class="dh-select" id="dh-set-start" style="width:160px;flex:0 0 160px">
                        <span class="dh-select-text">Помнить последнее</span><span class="dh-select-arrow">▾</span>
                        <div class="dh-select-options">
                            <div class="dh-select-option" data-start="remember">Помнить последнее</div>
                            <div class="dh-select-option" data-start="closed">Закрыто</div>
                            <div class="dh-select-option" data-start="min">Свёрнуто</div>
                            <div class="dh-select-option" data-start="open">Раскрыто</div>
                        </div>
                    </div>
                </div>
                <div class="dh-setting-row">
                    <div class="dh-setting-label">
                        Тема окна
                    </div>
                    <div class="dh-select" id="dh-set-theme" style="width:160px;flex:0 0 160px">
                        <span class="dh-select-text">Win95</span><span class="dh-select-arrow">▾</span>
                        <div class="dh-select-options">
                            <div class="dh-select-option" data-theme="win95">Win95</div>
                            <div class="dh-select-option" data-theme="xp">WinXP</div>
                            <div class="dh-select-option" data-theme="vista">Vista</div>
                            <div class="dh-select-option" data-theme="win11">Win11</div>
                            <div class="dh-select-option" data-theme="m3l">Material 3 Light</div>
                            <div class="dh-select-option" data-theme="m3d">Material 3 Dark</div>
                            <div class="dh-select-option" data-theme="macos">MacOS</div>
                            <div class="dh-select-option" data-theme="iosold">iOS old</div>
                            <div class="dh-select-option" data-theme="glass">iOS Liquid Glass</div>
                            <div class="dh-select-option" data-theme="dmd">Die my Darling</div>
                        </div>
                    </div>
                </div>
                <div class="dh-setting-row">
                    <div class="dh-setting-label">
                        Кеш (минут)
                        <small>Не перезапрашивать API, пока результат свежий</small>
                    </div>
                    <input class="dh-num-input" id="dh-set-cache" type="number" min="1" max="1440" />
                </div>
                <div class="dh-setting-row">
                    <div class="dh-setting-label">
                        Задержка между запросами (мс)
                        <small>Чтобы не словить rate limit</small>
                    </div>
                    <input class="dh-num-input" id="dh-set-delay" type="number" min="0" max="5000" step="50" />
                </div>
                <div class="dh-setting-row">
                    <div class="dh-setting-label">
                        Неактивные, дней
                        <small>Порог для фильтра «Неактивные»</small>
                    </div>
                    <input class="dh-num-input" id="dh-set-inactive" type="number" min="1" max="365" />
                </div>
                <div class="dh-setting-row">
                    <div class="dh-setting-label">
                        Уведомления, сек
                        <small>Через сколько пропадают (1–30)</small>
                    </div>
                    <input class="dh-num-input" id="dh-set-notify" type="number" min="1" max="30" />
                </div>
                <div class="dh-setting-row">
                    <div class="dh-setting-label">
                        Обновление рейтинга, сек
                        <small>Как часто обновляются разрывы XP на странице рейтингов (leaderboard) (1–60)</small>
                    </div>
                    <input class="dh-num-input" id="dh-set-lbgap" type="number" min="1" max="60" />
                </div>
                <div class="dh-setting-row">
                    <div class="dh-setting-label">
                        Версия скрипта
                        <small id="dh-current-version">…</small>
                    </div>
                    <button class="dh-btn" id="dh-check-update" style="padding:5px 10px;font-size:11px">🔍 Проверить обновления</button>
                </div>
                <div class="dh-setting-row">
                    <div class="dh-setting-label">
                        Сбросить позицию окна
                        <small>Вернуть окно в место по умолчанию</small>
                    </div>
                    <button class="dh-btn" id="dh-reset-pos" style="padding:5px 10px;font-size:11px">Сброс</button>
                </div>
                <div class="dh-setting-row">
                    <div class="dh-setting-label">
                        Очистить кеш
                        <small>Удалить сохранённые результаты проверок</small>
                    </div>
                    <button class="dh-btn dh-btn-danger" id="dh-clear-cache" style="padding:5px 10px;font-size:11px">Очистить</button>
                </div>
                <div class="dh-setting-row" style="border-bottom:none">
                    <div class="dh-setting-label">
                        Данные
                        <small>Экспорт / импорт локальных данных скрипта</small>
                    </div>
                    <div class="dh-row" style="gap:6px">
                        <button class="dh-btn" id="dh-export" style="padding:5px 10px;font-size:11px">📥 Экспорт</button>
                        <button class="dh-btn" id="dh-import" style="padding:5px 10px;font-size:11px">📤 Импорт</button>
                    </div>
                </div>
                <div class="dh-setting-row" style="border-bottom:none">
                    <div class="dh-setting-label">
                        Облачные сохранения
                        <small id="dh-cloud-status">Бэкап на сервере бота · один на аккаунт</small>
                    </div>
                    <div class="dh-row" style="gap:6px;flex-wrap:wrap">
                        <button class="dh-btn" id="dh-cloud-save" style="padding:5px 10px;font-size:11px" title="Сначала привяжите Telegram">☁️ Сохранить</button>
                        <button class="dh-btn" id="dh-cloud-load" style="padding:5px 10px;font-size:11px" title="Сначала привяжите Telegram">📥 Восстановить</button>
                        <button class="dh-btn" id="dh-cloud-delete" style="padding:5px 10px;font-size:11px" title="Сначала привяжите Telegram">🗑 Удалить</button>
                    </div>
                </div>
            </div>
        </div>
        <div class="dh-footer">
            <a class="dh-donate-link" href="https://vidrimers.su/donate" target="_blank" rel="noopener">Поддержать проект</a>
            <span style="opacity:0.4;margin:0 6px">·</span>
            <a class="dh-donate-link" id="dh-license-link" href="#" style="cursor:pointer">Лицензия</a>
        </div>
        <input type="file" id="dh-import-file" accept="application/json,.json" style="display:none" />
    `;
    shadow.appendChild(modal);

    els = {
      fab,
      badge,
      badgeIcon: badge.querySelector(".dh-badge-icon"),
      badgeText: badge.querySelector(".dh-badge-text"),
      badgeSub: badge.querySelector(".dh-badge-sub"),
      modal,
      titlebar: modal.querySelector("#dh-titlebar"),
      minBtn: modal.querySelector("#dh-min-btn"),
      closeBtn: modal.querySelector("#dh-close-btn"),
      aboutBtn: modal.querySelector("#dh-about-btn"),
      bugBtn: modal.querySelector("#dh-bug-btn"),
      resetPosBtn: modal.querySelector("#dh-reset-pos"),
      tabs: [...modal.querySelectorAll(".dh-tab[data-tab]")],
      tabContents: [...modal.querySelectorAll(".dh-tab-content")],
      status: modal.querySelector("#dh-status"),
      statusSub: modal.querySelector("#dh-status-sub"),
      userInput: modal.querySelector("#dh-user-input"),
      checkBtn: modal.querySelector("#dh-check-btn"),
      manualCard: modal.querySelector("#dh-manual-card"),
      manualStatus: modal.querySelector("#dh-manual-status"),
      manualSub: modal.querySelector("#dh-manual-sub"),
      meInfo: modal.querySelector("#dh-me-info"),
      recheckBtn: modal.querySelector("#dh-recheck-btn"),
      copyBtn: modal.querySelector("#dh-copy-btn"),
      setAuto: modal.querySelector("#dh-set-auto"),
      setBadge: modal.querySelector("#dh-set-badge"),
      setOpen: modal.querySelector("#dh-set-open"),
      setStart: modal.querySelector("#dh-set-start"),
      setStartText: modal.querySelector("#dh-set-start .dh-select-text"),
      setStartOpts: [...modal.querySelectorAll("#dh-set-start .dh-select-option")],
      setTheme: modal.querySelector("#dh-set-theme"),
      setThemeText: modal.querySelector("#dh-set-theme .dh-select-text"),
      setThemeOpts: [...modal.querySelectorAll("#dh-set-theme .dh-select-option")],
      setHearts: modal.querySelector("#dh-set-hearts"),
      heartsStatus: modal.querySelector("#dh-hearts-status"),
      setShort: modal.querySelector("#dh-set-short"),
      setSolver: modal.querySelector("#dh-set-solver"),
      setStories: modal.querySelector("#dh-set-stories"),
      setFreeSuper: modal.querySelector("#dh-set-freesuper"),
      privacyToggle: modal.querySelector("#dh-privacy-toggle"),
      privacyBody: modal.querySelector("#dh-privacy-body"),
      privacyList: modal.querySelector("#dh-privacy-list"),
      solveNow: modal.querySelector("#dh-solve-now"),
      apCount: modal.querySelector("#dh-ap-count"),
      apStart: modal.querySelector("#dh-ap-start"),
      apStop: modal.querySelector("#dh-ap-stop"),
      apStatus: modal.querySelector("#dh-ap-status"),
      lessonStatus: modal.querySelector("#dh-lesson-status"),
      setXpBoost: modal.querySelector("#dh-set-xpboost"),
      xpBoost15: modal.querySelector("#dh-xpboost-15"),
      xpBoost60: modal.querySelector("#dh-xpboost-60"),
      xpAmount: modal.querySelector("#dh-xp-amount"),
      xpStories: modal.querySelector("#dh-xp-stories"),
      xpSessions: modal.querySelector("#dh-xp-sessions"),
      xpStop: modal.querySelector("#dh-xp-stop"),
      xpStatus: modal.querySelector("#dh-xp-status"),
      accs: [...modal.querySelectorAll("[data-acc]")],
      questDaily: modal.querySelector("#dh-quest-daily"),
      questWeekly: modal.querySelector("#dh-quest-weekly"),
      questFriends: modal.querySelector("#dh-quest-friends"),
      questFamily: modal.querySelector("#dh-quest-family"),
      questLoad: modal.querySelector("#dh-quest-load"),
      questClaimAll: modal.querySelector("#dh-quest-claim-all"),
      questStatus: modal.querySelector("#dh-quest-status"),
      questList: modal.querySelector("#dh-quest-list"),
      shopLoad: modal.querySelector("#dh-shop-load"),
      shopSuper: modal.querySelector("#dh-shop-super"),
      shopSearch: modal.querySelector("#dh-shop-search"),
      shopStatus: modal.querySelector("#dh-shop-status"),
      shopList: modal.querySelector("#dh-shop-list"),
      gemsOnce: modal.querySelector("#dh-gems-once"),
      gemsFarm: modal.querySelector("#dh-gems-farm"),
      gemsFarmFast: modal.querySelector("#dh-gems-farm-fast"),
      gemsStop: modal.querySelector("#dh-gems-stop"),
      gemsStatus: modal.querySelector("#dh-gems-status"),
      streakDays: modal.querySelector("#dh-streak-days"),
      streakRun: modal.querySelector("#dh-streak-run"),
      streakStop: modal.querySelector("#dh-streak-stop"),
      streakStatus: modal.querySelector("#dh-streak-status"),
      lbLoad: modal.querySelector("#dh-lb-load"),
      lbJoin: modal.querySelector("#dh-lb-join"),
      lbStatus: modal.querySelector("#dh-lb-status"),
      lbList: modal.querySelector("#dh-lb-list"),
      lbTarget: modal.querySelector("#dh-lb-target"),
      lbFarm: modal.querySelector("#dh-lb-farm"),
      lbStop: modal.querySelector("#dh-lb-stop"),
      friendsSearch: modal.querySelector("#dh-friends-search"),
      friendsLoad: modal.querySelector("#dh-friends-load"),
      friendsStatus: modal.querySelector("#dh-friends-status"),
      friendsList: modal.querySelector("#dh-friends-list"),
      friendFilters: [...modal.querySelectorAll("[data-friend-filter]")],
      activitySort: modal.querySelector("#dh-activity-sort"),
      activitySortText: modal.querySelector("#dh-activity-sort .dh-select-text"),
      activitySortOpts: [...modal.querySelectorAll("#dh-activity-sort .dh-select-option")],
      friendsFiltersWrap: modal.querySelector("#dh-friends-filters"),
      unfollowAll: modal.querySelector("#dh-unfollow-all"),
      nobodyTools: modal.querySelector("#dh-nobody-tools"),
      allTools: modal.querySelector("#dh-all-tools"),
      unfollowAnyone: modal.querySelector("#dh-unfollow-anyone"),
      historyOpen: modal.querySelector("#dh-history-open"),
      historyBack: modal.querySelector("#dh-history-back"),
      historyList: modal.querySelector("#dh-history-list"),
      changesOpen: modal.querySelector("#dh-changes-open"),
      changesList: modal.querySelector("#dh-changes-list"),
      changesBadge: modal.querySelector("#dh-changes-badge"),
      setCache: modal.querySelector("#dh-set-cache"),
      setDelay: modal.querySelector("#dh-set-delay"),
      setNotify: modal.querySelector("#dh-set-notify"),
      setLbGap: modal.querySelector("#dh-set-lbgap"),
      setInactive: modal.querySelector("#dh-set-inactive"),
      scanActivity: modal.querySelector("#dh-scan-activity"),
      scanStop: modal.querySelector("#dh-scan-stop"),
      inactiveTools: modal.querySelector("#dh-inactive-tools"),
      inactiveMass: modal.querySelector("#dh-inactive-mass"),
      unfollowInactive: modal.querySelector("#dh-unfollow-inactive"),
      blockInactive: modal.querySelector("#dh-block-inactive"),
      excludeOpen: modal.querySelector("#dh-exclude-open"),
      excludeList: modal.querySelector("#dh-exclude-list"),
      excludeBadge: modal.querySelector("#dh-exclude-badge"),
      blocksOpen: modal.querySelector("#dh-blocks-open"),
      tagsOpen: modal.querySelector("#dh-tags-open"),
      tagsList: modal.querySelector("#dh-tags-list"),
      tagsBadge: modal.querySelector("#dh-tags-badge"),
      tagsBack: modal.querySelector("#dh-tags-back"),
      tagsUser: modal.querySelector("#dh-tags-user"),
      tagsForm: modal.querySelector("#dh-tags-form"),
      tagLabel: modal.querySelector("#dh-tag-label"),
      tagColor: modal.querySelector("#dh-tag-color"),
      tagNote: modal.querySelector("#dh-tag-note"),
      tagSave: modal.querySelector("#dh-tag-save"),
      blocksList: modal.querySelector("#dh-blocks-list"),
      blocksBadge: modal.querySelector("#dh-blocks-badge"),
      clearCache: modal.querySelector("#dh-clear-cache"),
      refreshPage: modal.querySelector("#dh-refresh-page"),
      exportBtn: modal.querySelector("#dh-export"),
      importBtn: modal.querySelector("#dh-import"),
      importFile: modal.querySelector("#dh-import-file"),
      cloudSave: modal.querySelector("#dh-cloud-save"),
      cloudLoad: modal.querySelector("#dh-cloud-load"),
      cloudDelete: modal.querySelector("#dh-cloud-delete"),
      cloudStatus: modal.querySelector("#dh-cloud-status"),
      licenseLink: modal.querySelector("#dh-license-link"),
      statsToggle: modal.querySelector("#dh-stats-toggle"),
      statsBody: modal.querySelector("#dh-stats-body"),
      dashToggle: modal.querySelector("#dh-dash-toggle"),
      dashBody: modal.querySelector("#dh-dash-body"),
      accToggle: modal.querySelector("#dh-acc-toggle"),
      accListWrap: modal.querySelector("#dh-acc-list-wrap"),
      statToday: modal.querySelector("#dh-stat-today"),
      statWeek: modal.querySelector("#dh-stat-week"),
      statStreak: modal.querySelector("#dh-stat-streak"),
      statChart: modal.querySelector("#dh-stat-chart"),
      updateBanner: modal.querySelector("#dh-update-banner"),
      updateText: modal.querySelector("#dh-update-text"),
      updateBtn: modal.querySelector("#dh-update-btn"),
      checkUpdateBtn: modal.querySelector("#dh-check-update"),
      currentVersion: modal.querySelector("#dh-current-version"),
      versionChip: modal.querySelector("#dh-version-chip"),
    };

    bindEvents();
    applyTheme();
    initDrag();
    initFabDrag();
    applyWinPos();
    applyFabPos();
    uiReady = true;
    // при resize окна/открытии devtools — подтягиваем элементы в экран
    window.addEventListener("resize", () => {
      if (els.modal && els.modal.classList.contains("open")) applyWinPos();
      applyFabPos();
    });
    initUpdateCheck();
    updateCloudBlock();
  }

  // ========== Theme ==========
  function applyTheme() {
    try {
      if (!els || !els.modal) return;
    } catch { return; }
    const theme = DATA.settings.theme || "win95";
    els.modal.classList.remove(
      "dh-theme-xp", "dh-theme-vista", "dh-theme-win95",
      "dh-theme-macos", "dh-theme-iosold", "dh-theme-dmd",
      "dh-theme-win11", "dh-theme-m3l", "dh-theme-m3d", "dh-theme-glass",
    );
    els.modal.classList.add("dh-theme-" + theme);
    // уведомления тоже под тему
    const nbox = shadow.querySelector(".dh-notifs");
    if (nbox) {
      nbox.className = "dh-notifs dh-theme-" + theme;
    }
    if (els.setThemeText) {
      const labels = { xp: "WinXP", vista: "Vista", win95: "Win95", macos: "MacOS", iosold: "iOS old", dmd: "Die my Darling", win11: "Win11", m3l: "Material 3 Light", m3d: "Material 3 Dark", glass: "iOS Liquid Glass" };
      els.setThemeText.textContent = labels[theme] || "Win95";
    }
    if (els.setThemeOpts && els.setThemeOpts.length) {
      els.setThemeOpts.forEach((o) => {
        o.classList.toggle("active", o.dataset.theme === theme);
      });
    }
  }

  // ========== Защита сердец ==========
  // Страница Duolingo шлёт запрос на списание сердца при ошибке.
  // Хук ставится в page-context (не в sandbox), чтобы перехватить fetch/XHR React'а.
  const HEARTS_LS_KEY = "dh_protect_hearts";

  function syncHeartsFlag() {
    const on = !!DATA.settings.protectHearts;
    try {
      localStorage.setItem(HEARTS_LS_KEY, on ? "true" : "false");
    } catch {}
    if (els.setHearts) els.setHearts.classList.toggle("on", on);
    if (els.heartsStatus) {
      els.heartsStatus.textContent = on
        ? "включена — сердца не списываются"
        : "выключена — списание как обычно";
    }
  }

  // ========== Уроки: shortener + aut solver ==========
  // ⚠️ Читы, на свой страх и риск.
  const LESSON_LS_SHORT = "dh_lesson_short";
  const LESSON_LS_SOLVER = "dh_lesson_solver";
  const STORIES_LS_SHORT = "dh_stories_short";
  const FREE_SUPER_LS = "dh_free_super";

  function syncLessonFlags() {
    const shortOn = !!DATA.settings.lessonShortener;
    const solveOn = !!DATA.settings.autoSolver;
    const storiesOn = !!DATA.settings.storiesShortener;
    try {
      localStorage.setItem(LESSON_LS_SHORT, shortOn ? "true" : "false");
      localStorage.setItem(LESSON_LS_SOLVER, solveOn ? "true" : "false");
      localStorage.setItem(STORIES_LS_SHORT, storiesOn ? "true" : "false");
    } catch {}
    if (els.setShort) els.setShort.classList.toggle("on", shortOn);
    if (els.setSolver) els.setSolver.classList.toggle("on", solveOn);
    if (els.setStories) els.setStories.classList.toggle("on", storiesOn);
    if (els.lessonStatus) {
      els.lessonStatus.textContent =
        "короткие уроки: " +
        (shortOn ? "вкл" : "выкл") +
        " · автосолвер: " +
        (solveOn ? "вкл" : "выкл") +
        " · stories: " +
        (storiesOn ? "вкл" : "выкл");
    }
  }

  function setLessonStatus(t) {
    if (els.lessonStatus) els.lessonStatus.textContent = t;
  }

  function installLessonTools() {
    if (document.getElementById("dh-lesson-hook")) return;
    const s = document.createElement("script");
    s.id = "dh-lesson-hook";
    s.textContent = `(function() {
      if (window.__dhLessonHooked) return;
      window.__dhLessonHooked = true;

      var SHORT_KEY = ${JSON.stringify(LESSON_LS_SHORT)};
      var SOLVER_KEY = ${JSON.stringify(LESSON_LS_SOLVER)};
      var STORIES_KEY = ${JSON.stringify(STORIES_LS_SHORT)};
      var SUPER_KEY = ${JSON.stringify(FREE_SUPER_LS)};

      function flag(k) {
        try { return localStorage.getItem(k) === 'true'; } catch (e) { return false; }
      }

      // ===== Lesson Shortener: подмена challenges в POST /sessions =====
      function trivialChallenge(n) {
        return {
          type: 'assist',
          id: 'dh_short',
          prompt: 'Lesson Shortener',
          correctIndex: 0,
          choices: ['OK'],
          options: [{ text: 'OK' }],
          newWords: [],
          progressUpdates: [],
          canBeSkipped: true,
          metadata: { type: 'assist', specific_type: 'assist' }
        };
      }
      function shortenLessonData(data) {
        try {
          var n = (data && data.type && data.type.indexOf('LEGENDARY') === 0) ? 2 : 1;
          data.challenges = Array.from({ length: n }, function(_, i) { return trivialChallenge(i); });
          if (data.adaptiveChallenges) data.adaptiveChallenges = [];
          if (data.adaptiveInterleavedChallenges) {
            data.adaptiveInterleavedChallenges = { challenges: [], speakOrListenReplacementIndices: [] };
          }
        } catch (e) {}
        return data;
      }

      var origFetch = window.fetch;
      window.fetch = function(resource, options) {
        var url = resource instanceof Request ? resource.url : String(resource || '');
        var method = options && options.method ? options.method : (resource instanceof Request ? resource.method : 'GET');
        method = String(method || 'GET').toUpperCase();
        var isSessionCreate =
          method === 'POST' &&
          (url.indexOf('/2023-05-23/sessions') !== -1 || url.indexOf('/2017-06-30/sessions') !== -1);

        if (isSessionCreate && flag(SHORT_KEY)) {
          return origFetch.apply(this, arguments).then(function(res) {
            return res.clone().json().then(function(data) {
              return new Response(JSON.stringify(shortenLessonData(data)), {
                status: res.status,
                statusText: res.statusText,
                headers: { 'content-type': 'application/json' }
              });
            }).catch(function() { return res; });
          });
        }

        // ===== Stories Shortener: оставляем только HEADER =====
        var isStoryGet =
          method === 'GET' &&
          url.indexOf('stories.duolingo.com/api2/stories/') !== -1;

        if (isStoryGet && flag(STORIES_KEY)) {
          return origFetch.apply(this, arguments).then(function(res) {
            return res.clone().json().then(function(data) {
              if (data && Array.isArray(data.elements)) {
                data.elements = data.elements.filter(function(el) {
                  return el.type === 'HEADER';
                });
              }
              return new Response(JSON.stringify(data), {
                status: res.status,
                statusText: res.statusText,
                headers: { 'content-type': 'application/json' }
              });
            }).catch(function() { return res; });
          });
        }

        // ===== Free Super: подмена GET /users =====
        var isUserGet =
          method === 'GET' &&
          /\\/\\d{4}-\\d{2}-\\d{2}\\/users\\/.+/.test(url) &&
          url.indexOf('/shop-items') === -1;

        if (isUserGet && flag(SUPER_KEY)) {
          return origFetch.apply(this, arguments).then(function(res) {
            return res.clone().text().then(function(text) {
              try {
                var d = JSON.parse(text);
                d.hasPlus = true;
                if (!d.trackingProperties || typeof d.trackingProperties !== 'object') d.trackingProperties = {};
                d.trackingProperties.has_item_gold_subscription = true;
                d.shopItems = Object.assign({}, d.shopItems, {
                  gold_subscription: {
                    itemName: 'gold_subscription',
                    subscriptionInfo: {
                      vendor: 'STRIPE',
                      renewing: true,
                      isFamilyPlan: true,
                      expectedExpiration: 9999999999000
                    }
                  }
                });
                return new Response(JSON.stringify(d), {
                  status: res.status,
                  statusText: res.statusText,
                  headers: { 'content-type': 'application/json' }
                });
              } catch (e) { return res; }
            }).catch(function() { return res; });
          });
        }

        return origFetch.apply(this, arguments);
      };
      window.fetch.__dhLesson = true;

      // ===== Auto Solver (полный) =====
      function delay(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
      function safeWait(ms) { return ms + Math.floor(Math.random() * 120); }

      function findReactProps(dom) {
        if (!dom) return null;
        var keys = Object.keys(dom);
        for (var i = 0; i < keys.length; i++) {
          var key = keys[i];
          if (key.indexOf('__reactFiber$') === 0 || key.indexOf('__reactInternalInstance$') === 0) {
            var fiber = dom[key];
            var hops = 0;
            while (fiber && hops < 100) {
              var props = fiber.memoizedProps || fiber.pendingProps;
              if (props && props.currentChallenge) return props.currentChallenge;
              fiber = fiber.return;
              hops++;
            }
          }
        }
        return null;
      }

      function findChallengeRoot() {
        return document.querySelector('[data-test="challenge"]') ||
          document.querySelector('._3yE3H') ||
          document.querySelector('[class*="challenge"]') ||
          document.querySelector('main');
      }

      function getSol() {
        return findReactProps(findChallengeRoot()) || window.sol;
      }

      function setInputValue(el, value) {
        if (!el) return false;
        try {
          var isTa = el.tagName === 'TEXTAREA';
          var proto = isTa ? window.HTMLTextAreaElement : window.HTMLInputElement;
          var setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
          setter.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        } catch (e) {
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
      }

      function typeCE(el, value) {
        try {
          var setter = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent').set;
          setter.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } catch (e) {
          if (el) { el.textContent = value; el.dispatchEvent(new Event('input', { bubbles: true })); }
        }
      }

      function clickBySolText(text) {
        if (text == null) return false;
        var t = String(text).trim().toLowerCase();
        var nodes = document.querySelectorAll('[data-test="challenge-choice"], [data-test*="challenge-tap-token"], [role="button"], button, span');
        for (var i = 0; i < nodes.length; i++) {
          var v = (nodes[i].textContent || '').trim().toLowerCase();
          if (v === t) { nodes[i].click(); return true; }
        }
        return false;
      }

      function clickNext() {
        var inStory = location.hostname.indexOf('stories.duolingo.com') !== -1 ||
          location.pathname.indexOf('/stories') !== -1 ||
          !!document.querySelector('[data-test="stories-choice"]') ||
          !!document.querySelector('[data-test="story-start"]') ||
          !!document.querySelector('[data-test="stories-player-continue"]') ||
          !!document.querySelector('[data-test="stories-player-done"]');
        if (inStory) {
          try {
            var node = document.getElementsByClassName('_2neC7')[0];
            if (node) {
              var keys = Object.keys(node);
              for (var i = 0; i < keys.length; i++) {
                if (keys[i].indexOf('__reactFiber$') === 0) {
                  var fn = node[keys[i]] && node[keys[i]].return && node[keys[i]].return.memoizedProps && node[keys[i]].return.memoizedProps.continueStory;
                  if (typeof fn === 'function') { fn(); return; }
                }
              }
            }
          } catch (e) {}
        }
        var next = document.querySelector('[data-test="player-next"]') ||
          document.querySelector('[data-test="stories-player-continue"]') ||
          document.querySelector('[data-test="stories-player-done"]');
        if (!next) return;
        var disabled = next.getAttribute('aria-disabled') === 'true' || next.disabled;
        if (!disabled) next.click();
      }

      function determineType(sol) {
        try {
          var t = sol && sol.type;
          if (!t) return null;
          if (t === 'speak' || t === 'listenSpeak') return 'Speak';
          if (t === 'listenMatch') return 'ListenMatch';

          var isStory = location.hostname.indexOf('stories.duolingo.com') !== -1 ||
            location.pathname.indexOf('/stories') !== -1 ||
            !!document.querySelector('[data-test="stories-choice"]') ||
            !!document.querySelector('[data-test="story-start"]');
          var tl = String(t).toLowerCase();
          if (isStory || tl === 'arrange' || tl === 'multiple-choice' || tl === 'multiple_choice' ||
              tl === 'point-to-phrase' || tl === 'point_to_phrase' || tl === 'gap-fill' || tl === 'gap_fill') {
            if (tl === 'arrange') return 'StoryArrange';
            if (tl === 'multiple-choice' || tl === 'multiple_choice' || tl === 'select-phrases') return 'StoryMulti';
            if (tl === 'point-to-phrase' || tl === 'point_to_phrase') return 'StoryPoint';
            if (tl === 'gap-fill' || tl === 'gap_fill') return 'StoryGap';
            if (tl === 'match') return 'Pairs';
          }

          if (t === 'typeCloze') return 'TypeCloze';
          if (t === 'typeClozeTable') return 'TypeClozeTable';
          if (t === 'tapClozeTable') return 'TapClozeTable';
          if (t === 'typeCompleteTable') return 'TypeCompleteTable';
          if (t === 'tapCompleteTable') return 'TapCompleteTable';
          if (t === 'patternTapComplete') return 'PatternTap';
          if (t === 'syllableTap') return 'SyllableTap';
          if (t === 'syllableListenTap') return 'SyllableTap';
          if (t === 'listenTap') return 'ListenTap';
          if (t === 'listen') return 'ListenType';
          if (t === 'translate') return 'Translate';
          if (t === 'completeReverseTranslation') return 'CompleteReverse';
          if (t === 'judge') return 'Judge';
          if (t === 'dialogue' || t === 'characterIntro' || t === 'selectTranscription') return 'Dialogue';
          if (t === 'characterMatch' || t === 'match') return 'Pairs';
          if (t === 'select' || t === 'characterSelect' || t === 'form' ||
              t === 'readComprehension' || t === 'listenComprehension' || t === 'selectPronunciation') {
            return 'SelectCard';
          }
          if (t === 'orderTapComplete') return 'OrderTap';
          if (t === 'assist' || t === 'characterSelect') return 'Choice';
          if (document.querySelectorAll('[data-test*="challenge-partialReverseTranslate"]').length) return 'PartialReverse';
          if (document.querySelectorAll('[data-test="challenge challenge-characterWrite"]').length) return 'CharWrite';
          if (document.querySelectorAll('[data-test*="challenge-name"]').length &&
              document.querySelectorAll('[data-test="challenge-choice"]').length) return 'Name';
          if (document.querySelectorAll('[data-test="challenge-choice"]').length) {
            if (document.querySelectorAll('[data-test="challenge-text-input"]').length) return 'ChoiceInput';
            return 'Choice';
          }
          if (document.querySelectorAll('[data-test*="challenge-tap-token"]').length) {
            if (sol.pairs) return 'Pairs';
            if (sol.correctTokens) return 'TokensRun';
            if (sol.correctIndices) return 'IndicesRun';
          }
          if (document.querySelectorAll('[data-test="challenge-tap-token-text"]').length) return 'FillGap';
          if (document.querySelector('textarea[data-test="challenge-translate-input"]')) return 'Translate';
          if (document.querySelectorAll('[data-test="challenge-text-input"]').length) return 'TextInput';
          if (document.querySelector('[data-test="daily-quest-progress-slide"]') ||
              document.querySelector('[data-test="streak-slide"]') ||
              document.querySelector('[data-test="leaderboard-slide"]')) return 'Slide';
          return null;
        } catch (e) { return null; }
      }

      async function handleType(type, sol) {
        var ch = sol || {};
        switch (type) {
          case 'Slide':
            clickNext();
            return;

          case 'Choice':
          case 'SelectCard':
          case 'Judge':
          case 'Dialogue': {
            if (typeof ch.correctIndex === 'number') {
              var btns = document.querySelectorAll('[data-test="challenge-choice"]');
              if (btns[ch.correctIndex]) { btns[ch.correctIndex].click(); return; }
              if (ch.choices && ch.choices[ch.correctIndex] != null) clickBySolText(ch.choices[ch.correctIndex]);
            }
            if (ch.correctSolutions && ch.correctSolutions[0]) clickBySolText(ch.correctSolutions[0]);
            return;
          }

          case 'Name': {
            if (ch.articles && ch.correctSolutions && ch.correctSolutions[0]) {
              var solStr = ch.correctSolutions[0];
              var art = ch.articles.find(function(a) { return solStr.indexOf(a) === 0; });
              if (art !== undefined) {
                var idx = ch.articles.indexOf(art);
                var rest = solStr.substring(art.length).trim();
                var el = document.querySelector('[data-test="challenge-choice"]:nth-child(' + (idx + 1) + ')');
                if (el) el.click();
                var input = document.querySelector('[data-test="challenge-text-input"]');
                if (input) setInputValue(input, rest);
              }
            }
            return;
          }

          case 'ChoiceInput': {
            if (typeof ch.correctIndex === 'number') {
              var cb = document.querySelectorAll('[data-test="challenge-choice"]');
              if (cb[ch.correctIndex]) cb[ch.correctIndex].click();
            }
            if (ch.correctSolutions && ch.correctSolutions[0]) {
              var ti = document.querySelector('[data-test="challenge-text-input"]');
              if (ti) setInputValue(ti, ch.correctSolutions[0]);
            }
            return;
          }

          case 'Translate':
          case 'ListenType':
          case 'TextInput': {
            var answer = (ch.correctSolutions && ch.correctSolutions[0]) || ch.prompt || '';
            var ta = document.querySelector('textarea[data-test="challenge-translate-input"]') ||
              document.querySelector('[data-test="challenge-translate-input"]') ||
              document.querySelector('textarea') ||
              document.querySelector('[data-test="challenge-text-input"]') ||
              document.querySelector('input[type="text"]');
            if (ta) setInputValue(ta, answer);
            else clickBySolText(answer);
            return;
          }

          case 'CompleteReverse': {
            if (ch.correctSolutions && ch.correctSolutions[0]) {
              var ce = document.querySelector('[contenteditable="true"]');
              if (ce) typeCE(ce, ch.correctSolutions[0]);
              else {
                var inp = document.querySelector('[data-test="challenge-text-input"]') || document.querySelector('textarea');
                if (inp) setInputValue(inp, ch.correctSolutions[0]);
              }
            }
            return;
          }

          case 'PartialReverse': {
            var ce2 = document.querySelector('[contenteditable="true"]');
            var text = '';
            if (ch.displayTokens) {
              text = ch.displayTokens.filter(function(t) { return t.isBlank; }).map(function(t) { return t.text; }).join('').trim();
            }
            if (!text && ch.correctSolutions) text = ch.correctSolutions[0];
            if (ce2) typeCE(ce2, text);
            return;
          }

          case 'Pairs': {
            var buttons = document.querySelectorAll('[data-test*="challenge-tap-token"]:not(span)');
            var texts = document.querySelectorAll('[data-test="challenge-tap-token-text"]');
            if (!buttons.length) return;
            var pairs = ch.pairs || [];
            for (var p = 0; p < pairs.length; p++) {
              var pair = pairs[p];
              for (var i = 0; i < buttons.length; i++) {
                if (buttons[i].disabled) continue;
                var txt = (texts[i] ? texts[i].innerText : buttons[i].textContent || '').toLowerCase().trim();
                var ok = txt === String(pair.transliteration || '').toLowerCase().trim() ||
                  txt === String(pair.character || '').toLowerCase().trim() ||
                  txt === String(pair.learningToken || '').toLowerCase().trim() ||
                  txt === String(pair.fromToken || '').toLowerCase().trim() ||
                  txt === String(pair[0] || '').toLowerCase().trim() ||
                  txt === String(pair[1] || '').toLowerCase().trim() ||
                  txt === String(pair.from || '').toLowerCase().trim() ||
                  txt === String(pair.to || '').toLowerCase().trim();
                if (ok) {
                  buttons[i].click();
                  await delay(safeWait(40));
                  break;
                }
              }
            }
            return;
          }

          case 'TokensRun': {
            var all = document.querySelectorAll('[data-test$="challenge-tap-token"]');
            var used = [];
            var toClick = [];
            var cts = ch.correctTokens || [];
            for (var c = 0; c < cts.length; c++) {
              var token = cts[c];
              var matches = Array.prototype.filter.call(all, function(el) {
                return el.textContent.trim() === String(token).trim();
              });
              if (matches.length) {
                var n = used.filter(function(u) { return u.textContent.trim() === String(token).trim(); }).length;
                var el2 = matches[n] || matches[0];
                if (!el2.disabled) { toClick.push(el2); used.push(el2); }
              }
            }
            for (var k = 0; k < toClick.length; k++) {
              toClick[k].click();
              await delay(safeWait(35));
            }
            return;
          }

          case 'IndicesRun': {
            if (!ch.correctIndices) return;
            var bank = document.querySelector('div[data-test="word-bank"]') || document.querySelector('.eSgkc');
            if (!bank) return;
            var bb = Array.prototype.slice.call(bank.querySelectorAll('button[data-test*="challenge-tap-token"]:not(span)'));
            for (var ii = 0; ii < ch.correctIndices.length; ii++) {
              var ix = ch.correctIndices[ii];
              if (ix >= 0 && ix < bb.length && !bb[ix].disabled) {
                bb[ix].click();
                await delay(safeWait(35));
              }
            }
            return;
          }

          case 'OrderTap': {
            var blanks = (ch.displayTokens || []).filter(function(t) { return t.isBlank; });
            if (!blanks.length) return;
            var choicesData = ch.choices || [];
            var usedIdx = {};
            for (var b = 0; b < blanks.length; b++) {
              var want = blanks[b].text;
              for (var ci = 0; ci < choicesData.length; ci++) {
                if (usedIdx[ci]) continue;
                var ct = typeof choicesData[ci] === 'object' ? choicesData[ci].text : choicesData[ci];
                if (String(ct).trim() === String(want).trim()) {
                  usedIdx[ci] = true;
                  clickBySolText(want);
                  await delay(safeWait(35));
                  break;
                }
              }
            }
            return;
          }

          case 'TapCompleteTable':
          case 'TypeCompleteTable':
          case 'TapClozeTable':
          case 'TypeClozeTable': {
            var rows = (ch.displayTableTokens || []).slice(1);
            var trs = document.querySelectorAll('tbody tr');
            var wordBank = document.querySelector('div[data-test="word-bank"]');
            var wbBtns = wordBank ? wordBank.querySelectorAll('button[data-test*="challenge-tap-token"]') : [];
            var usedWb = {};
            for (var r = 0; r < rows.length && r < trs.length; r++) {
              var cell = rows[r][1] || [];
              var blankTok = cell.find ? cell.find(function(t) { return t.isBlank; }) : null;
              if (!blankTok) continue;
              var answerText = blankTok.text;
              if (type === 'TypeCompleteTable' || type === 'TypeClozeTable') {
                var tin = trs[r].querySelector('input, textarea');
                if (tin) { setInputValue(tin, answerText); continue; }
              }
              var clicked = false;
              var rowBtns = trs[r].querySelectorAll('button[data-test*="challenge-tap-token"]');
              for (var rb = 0; rb < rowBtns.length; rb++) {
                var te = rowBtns[rb].querySelector('[data-test="challenge-tap-token-text"]');
                if (te && te.innerText.trim() === answerText && !rowBtns[rb].disabled) {
                  rowBtns[rb].click(); clicked = true;
                  await delay(safeWait(35));
                  break;
                }
              }
              if (!clicked && wbBtns.length) {
                for (var w = 0; w < wbBtns.length; w++) {
                  if (usedWb[w]) continue;
                  var te2 = wbBtns[w].querySelector('[data-test="challenge-tap-token-text"]');
                  if (te2 && te2.innerText.trim() === answerText && !wbBtns[w].disabled) {
                    wbBtns[w].click(); usedWb[w] = true;
                    await delay(safeWait(35));
                    break;
                  }
                }
              }
            }
            return;
          }

          case 'TypeCloze': {
            if (ch.correctSolutions && ch.correctSolutions[0]) {
              var tin2 = document.querySelector('[data-test="challenge-text-input"]') || document.querySelector('input[type="text"]') || document.querySelector('textarea');
              if (tin2) setInputValue(tin2, ch.correctSolutions[0]);
            }
            return;
          }

          case 'PatternTap':
          case 'SyllableTap':
          case 'ListenTap':
          case 'FillGap': {
            if (ch.correctTokens && ch.correctTokens.length) {
              for (var s = 0; s < ch.correctTokens.length; s++) clickBySolText(ch.correctTokens[s]);
              return;
            }
            if (ch.displayTokens) {
              var isb = ch.displayTokens.filter(function(t) { return t.isBlank; });
              for (var d = 0; d < isb.length; d++) clickBySolText(isb[d].text);
            }
            return;
          }

          case 'StoryArrange': {
            if (ch.phraseOrder) {
              var chs = document.querySelectorAll('[data-test="stories-choice"], [data-test="challenge-choice"]');
              for (var ph = 0; ph < ch.phraseOrder.length; ph++) {
                if (chs[ch.phraseOrder[ph]]) chs[ch.phraseOrder[ph]].click();
              }
            }
            return;
          }

          case 'StoryMulti':
          case 'StoryPoint':
          case 'StoryGap': {
            if (typeof ch.correctAnswerIndex === 'number') {
              var sc = document.querySelectorAll('[data-test="stories-choice"], [data-test="challenge-choice"]');
              if (sc[ch.correctAnswerIndex]) sc[ch.correctAnswerIndex].click();
            } else if (ch.correctSolutions && ch.correctSolutions[0]) {
              clickBySolText(ch.correctSolutions[0]);
            } else if (typeof ch.correctIndex === 'number') {
              var sc2 = document.querySelectorAll('[data-test="challenge-choice"]');
              if (sc2[ch.correctIndex]) sc2[ch.correctIndex].click();
            }
            return;
          }

          case 'CharWrite': {
            clickNext();
            return;
          }

          case 'Speak':
          case 'ListenMatch': {
            // пропускаем голосовые
            clickNext();
            return;
          }
        }
      }

      async function solveOnce(force) {
        if (!flag(SOLVER_KEY) && !force) return false;

        // пропуск модалок / слайдов
        var skips = [
          '[data-test="practice-hub-ad-no-thanks-button"]',
          '[data-test="plus-no-thanks"]',
          '[data-test="story-start"]',
          '[data-test="player-next"]'
        ];
        for (var si = 0; si < skips.length; si++) {
          var sk = document.querySelector(skips[si]);
          if (sk && skips[si] !== '[data-test="player-next"]') sk.click();
        }

        var root = findChallengeRoot();
        if (!root) {
          clickNext();
          return false;
        }
        window.sol = findReactProps(root);
        if (!window.sol) {
          clickNext();
          return false;
        }
        var type = determineType(window.sol);
        if (!type) {
          clickNext();
          return false;
        }
        try {
          await handleType(type, window.sol);
          // после выбора ответа — «Проверить», затем «Далее»
          await new Promise(function(r) { setTimeout(r, 350); });
          clickNext(); // «Проверить»
          await new Promise(function(r) { setTimeout(r, 550); });
          clickNext(); // «Далее»
          return true;
        } catch (e) {
          return false;
        }
      }

      window.__dhSolveOnce = function(force) {
        return solveOnce(!!force);
      };

      setInterval(function() {
        if (!flag(SOLVER_KEY)) return;
        var p = location.pathname;
        if (p.indexOf('/lesson') !== 0 && p.indexOf('/practice') !== 0 && p.indexOf('/stories') !== 0) return;
        solveOnce(false);
      }, 650);

      document.addEventListener('dh-solve-now', function() {
        try { window.__dhSolveOnce(true); } catch (e) {}
      });
    })();`;
    (document.documentElement || document.body).appendChild(s);
    s.remove();
    syncLessonFlags();
  }

  function solveNow() {
    // вызов в page-context
    try {
      const s = document.createElement("script");
      s.textContent = "try { window.__dhSolveOnce && window.__dhSolveOnce(true); } catch(e){}";
      document.documentElement.appendChild(s);
      s.remove();
    } catch {}
    // и напрямую, если видим page window
    try {
      if (typeof unsafeWindow !== "undefined" && unsafeWindow.__dhSolveOnce) {
        unsafeWindow.__dhSolveOnce(true);
      }
    } catch {}
    setLessonStatus("Отправлен solve…");
    showToast("Автосолвер: пробую решить");
  }

  // ========== Автопрактика ==========
  const AP_KEY = "dh_autopractice";

  function apState() {
    try {
      return JSON.parse(sessionStorage.getItem(AP_KEY) || "null");
    } catch {
      return null;
    }
  }

  function apSave(s) {
    try {
      if (s) sessionStorage.setItem(AP_KEY, JSON.stringify(s));
      else sessionStorage.removeItem(AP_KEY);
    } catch {}
  }

  function setApRunning(running) {
    if (els.apStart) els.apStart.disabled = running;
    if (els.apStop) els.apStop.disabled = !running;
    // блокируем тумблеры уроков
    const toggles = [els.setShort, els.setSolver, els.setStories];
    for (const t of toggles) {
      if (!t) continue;
      t.style.opacity = running ? "0.5" : "";
      t.style.pointerEvents = running ? "none" : "";
    }
  }

  function setApStatus(t) {
    if (els.apStatus) els.apStatus.textContent = t;
  }

  function startAutoPractice(count) {
    const st = apState();
    if (st && st.active) {
      showToast("Автопрактика уже идёт");
      return;
    }
    const prevShort = !!DATA.settings.lessonShortener;
    const prevSolver = !!DATA.settings.autoSolver;
    // включаем короткие уроки + солвер для цикла
    DATA.settings.lessonShortener = true;
    DATA.settings.autoSolver = true;
    saveData();
    syncLessonFlags();
    apSave({
      active: true,
      target: count,
      done: 0,
      prevShort,
      prevSolver,
    });
    setApRunning(true);
    setApStatus("Урок 0 / " + count + "…");
    showToast("Автопрактика: старт (" + count + " уроков)");
    if (location.pathname.indexOf("/practice") !== 0) {
      location.assign("/practice");
    } else {
      resumeAutoPractice();
    }
  }

  function stopAutoPractice(completed) {
    const st = apState();
    apSave(null);
    setApRunning(false);
    // восстанавливаем короткие уроки и солвер
    if (st && typeof st.prevShort === "boolean") {
      DATA.settings.lessonShortener = st.prevShort;
    }
    if (st && typeof st.prevSolver === "boolean") {
      DATA.settings.autoSolver = st.prevSolver;
    }
    saveData();
    syncLessonFlags();
    if (completed) {
      setApStatus("Готово: " + (st ? st.done : 0) + " уроков");
      showToast("✓ Автопрактика завершена");
    } else {
      setApStatus("Остановлено");
      showToast("Автопрактика остановлена");
    }
  }

  function resumeAutoPractice() {
    const st = apState();
    if (!st || !st.active) return;
    setApRunning(true);
    setApStatus("Урок " + st.done + " / " + st.target + "…");
    // ждём появления challenge или конца сессии
    let waited = 0;
    const iv = setInterval(() => {
      waited += 600;
      const st2 = apState();
      if (!st2 || !st2.active) {
        clearInterval(iv);
        return;
      }
      // конец сессии?
      const done =
        document.querySelector('[data-test="session-over"]') ||
        document.querySelector('[data-test="session-complete-slide"]') ||
        document.querySelector('[data-test="session-complete"]');
      if (done) {
        clearInterval(iv);
        st2.done++;
        apSave(st2);
        if (st2.done >= st2.target) {
          stopAutoPractice(true);
          return;
        }
        setApStatus("Урок " + st2.done + " / " + st2.target + "…");
        setTimeout(() => {
          if (apState() && apState().active) location.assign("/practice");
        }, 900);
        return;
      }
      // если challenge есть — солвер и так работает через свой interval
      if (waited > 120000) {
        clearInterval(iv);
        stopAutoPractice(false);
        setApStatus("Таймаут — урок не загрузился");
      }
    }, 600);
  }

  function installHeartsHook() {
    if (document.getElementById("dh-hearts-hook")) return;
    const s = document.createElement("script");
    s.id = "dh-hearts-hook";
    s.textContent = `(function() {
      if (window.__dhHeartsHooked) return;
      window.__dhHeartsHooked = true;
      var KEY = ${JSON.stringify(HEARTS_LS_KEY)};
      function active() {
        try { return localStorage.getItem(KEY) === 'true'; } catch (e) { return true; }
      }
      function isHeartLoss(url) {
        if (!url) return false;
        var u = String(url).toLowerCase();
        return (
          u.indexOf('remove-heart') !== -1 ||
          u.indexOf('remove_heart') !== -1 ||
          u.indexOf('removeheart') !== -1 ||
          u.indexOf('remove-hearts') !== -1
        );
      }
      function fakeOk() {
        try {
          document.dispatchEvent(new CustomEvent('dh-heart-blocked'));
        } catch (e) {}
        var expected = null;
        try { expected = localStorage.getItem('dh_hearts_expected'); } catch (e) {}
        var body = { ok: true };
        if (expected != null && expected !== '') {
          var n = parseInt(expected, 10);
          if (!isNaN(n)) {
            body.hearts = n;
            body.maxHearts = n;
            body.health = { hearts: n, maxHearts: n };
          }
        }
        return Promise.resolve(new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }));
      }

      // fetch
      var origFetch = window.fetch;
      window.fetch = function(resource, options) {
        var url = resource instanceof Request ? resource.url : String(resource || '');
        if (active() && isHeartLoss(url)) return fakeOk();
        return origFetch.apply(this, arguments);
      };
      window.fetch.__dhHearts = true;

      // XHR fallback
      var origOpen = XMLHttpRequest.prototype.open;
      var origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url) {
        this.__dhHeartLoss = active() && isHeartLoss(url);
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function() {
        if (this.__dhHeartLoss) {
          try {
            document.dispatchEvent(new CustomEvent('dh-heart-blocked'));
            Object.defineProperty(this, 'readyState', { configurable: true, value: 4 });
            Object.defineProperty(this, 'status', { configurable: true, value: 200 });
            Object.defineProperty(this, 'responseText', { configurable: true, value: '{}' });
            Object.defineProperty(this, 'response', { configurable: true, value: '{}' });
            if (typeof this.onreadystatechange === 'function') this.onreadystatechange();
            if (typeof this.onload === 'function') this.onload();
            return;
          } catch (e) {}
        }
        return origSend.apply(this, arguments);
      };
    })();`;
    (document.documentElement || document.body).appendChild(s);
    s.remove();
    syncHeartsFlag();
  }

  /** Сервер vs экран: подтягиваем реальные сердца в UI после блокировки/урока. */
  async function fetchServerHearts() {
    const myId = getMyId();
    if (!myId) return null;
    try {
      const data = await apiGet(
        `${API.users}/${myId}?fields=health&_=${Date.now()}`,
      );
      const h = data && data.health;
      if (!h) return null;
      const server = {
        hearts: Number(h.hearts),
        maxHearts: Number(h.maxHearts != null ? h.maxHearts : 5),
      };
      if (Number.isFinite(server.hearts)) {
        try {
          localStorage.setItem("dh_hearts_expected", String(server.hearts));
        } catch {}
      }
      return server;
    } catch {
      return null;
    }
  }

  let lastServerHearts = null;
  let heartNumElsCache = null;

  function getHeartNumEls() {
    // кэш на короткое время — React иногда пересоздаёт DOM
    if (heartNumElsCache && heartNumElsCache.ts && Date.now() - heartNumElsCache.ts < 3000) {
      const live = heartNumElsCache.list.filter((el) => el.isConnected);
      if (live.length) {
        heartNumElsCache.list = live;
        return live;
      }
    }
    const list = findHeartCountEls();
    heartNumElsCache = { list, ts: Date.now() };
    return list;
  }

  async function fixHeartsUi({ silent = false, forceFetch = false } = {}) {
    if (!DATA.settings.protectHearts) return;
    let server = lastServerHearts;
    if (!server || forceFetch) {
      server = await fetchServerHearts();
      if (server && Number.isFinite(server.hearts)) lastServerHearts = server;
    }
    if (!server || !Number.isFinite(server.hearts)) return;

    const elsH = getHeartNumEls();
    const maxH = Math.max(server.maxHearts, server.hearts, 5);
    let patched = 0;
    for (const el of elsH) {
      const cur = Number((el.textContent || "").trim());
      if (!Number.isFinite(cur)) continue;
      if (cur < 0 || cur > maxH + 5) continue;
      if (cur !== server.hearts) {
        el.textContent = String(server.hearts);
        patched++;
      }
    }
    if (patched && !silent) {
      showToast("Сердца синхронизированы с сервером: " + server.hearts);
    }
    return { server: server.hearts, patched };
  }

  let heartsLessonTimer = null;
  let heartsRaf = 0;
  let heartsMo = null;
  let heartsRafLoop = false;

  function startHeartsWatch() {
    stopHeartsWatch();
    if (!DATA.settings.protectHearts) return;

    heartsLessonTimer = setInterval(() => {
      fixHeartsUi({ silent: true });
    }, 500);

    if (!heartsMo) {
      heartsMo = new MutationObserver(() => {
        if (!DATA.settings.protectHearts) return;
        if (heartsRaf) return;
        heartsRaf = requestAnimationFrame(() => {
          heartsRaf = 0;
          fixHeartsUi({ silent: true });
        });
      });
      heartsMo.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }

    // жёсткий режим: каждый кадр держим цифру = серверу
    heartsRafLoop = true;
    const tick = () => {
      if (!heartsRafLoop) return;
      fixHeartsUi({ silent: true });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function stopHeartsWatch() {
    heartsRafLoop = false;
    if (heartsLessonTimer) {
      clearInterval(heartsLessonTimer);
      heartsLessonTimer = null;
    }
    if (heartsRaf) {
      cancelAnimationFrame(heartsRaf);
      heartsRaf = 0;
    }
  }

  function watchHeartsUi() {
    document.addEventListener("dh-heart-blocked", () => {
      setTimeout(() => fixHeartsUi({ silent: true }), 80);
      setTimeout(() => fixHeartsUi({ silent: true }), 400);
    });

    const sync = () => {
      const onLesson = /^\/lesson/.test(location.pathname);
      if (onLesson) {
        fetchServerHearts().then((s) => {
          if (s) lastServerHearts = s;
          startHeartsWatch();
          fixHeartsUi({ silent: true });
        });
      } else {
        stopHeartsWatch();
        setTimeout(() => fixHeartsUi({ silent: true, forceFetch: true }), 400);
      }
    };
    window.addEventListener("popstate", sync);
    const origPush = history.pushState;
    history.pushState = function () {
      origPush.apply(this, arguments);
      sync();
    };
    if (/^\/lesson/.test(location.pathname)) sync();
  }

  function findHeartCountEls() {
    const out = [];
    const seen = new Set();
    const push = (el) => {
      if (el && el.nodeType === 1 && !seen.has(el)) {
        seen.add(el);
        out.push(el);
      }
    };
    const isNum = (el) => /^\d+$/.test(((el && el.textContent) || "").trim());

    // 1) img/svg с hearts в src/классе + сосед-цифра (основной кейс Duolingo)
    document
      .querySelectorAll('img[src*="hearts/"], img[src*="/hearts"], img[src*="heart"]')
      .forEach((img) => {
        const wrap = img.parentElement;
        if (!wrap) return;
        wrap.querySelectorAll("span,div,strong,b,p").forEach((n) => {
          if (isNum(n) && n.childElementCount === 0) push(n);
        });
        [img.previousElementSibling, img.nextElementSibling].forEach((n) => {
          if (isNum(n) && n.childElementCount === 0) push(n);
        });
        if (isNum(wrap) && wrap.childElementCount <= 2) {
          // на wrap-контейнере сразу текст «4» рядом с картинкой
          Array.from(wrap.childNodes).forEach((n) => {
            if (n.nodeType === 3 && /^\d+$/.test(n.textContent.trim())) {
              // заменяем текстовый узел через родителя — проще найти span
            }
          });
          wrap.querySelectorAll("*").forEach((n) => {
            if (isNum(n) && n.childElementCount === 0) push(n);
          });
        }
      });

    // 2) heart-контейнеры по классам/атрибутам
    document
      .querySelectorAll(
        '[data-test*="heart" i],[data-testid*="heart" i],[aria-label*="heart" i],[class*="heart" i],[class*="Heart"]',
      )
      .forEach((el) => {
        if (isNum(el) && el.childElementCount === 0) push(el);
        el.querySelectorAll("span,div,strong,b,p").forEach((n) => {
          if (isNum(n) && n.childElementCount === 0) push(n);
        });
        [el.previousElementSibling, el.nextElementSibling].forEach((n) => {
          if (isNum(n) && n.childElementCount === 0) push(n);
        });
      });

    // 3) svg-heart и цифры рядом
    document.querySelectorAll("svg").forEach((svg) => {
      const label = (
        (svg.getAttribute("aria-label") || "") +
        " " +
        (svg.getAttribute("class") || "") +
        " " +
        (svg.getAttribute("data-test") || "")
      ).toLowerCase();
      const isHeart =
        label.includes("heart") || (svg.innerHTML || "").toLowerCase().includes("heart");
      if (!isHeart) return;
      let box = svg.parentElement;
      for (let i = 0; i < 3 && box; i++) {
        box.querySelectorAll("span,div,strong,b,p").forEach((n) => {
          if (isNum(n) && n.childElementCount === 0) push(n);
        });
        const prev = box.previousElementSibling;
        const next = box.nextElementSibling;
        if (isNum(prev) && prev.childElementCount === 0) push(prev);
        if (isNum(next) && next.childElementCount === 0) push(next);
        box = box.parentElement;
      }
    });

    return out;
  }

  // ========== Theme end ==========

  // ========== Квесты (goals-api) ==========
  // ⚠️ Инъекция прогресса — чит, на свой страх и риск.
  const GOALS_API = "https://goals-api.duolingo.com";

  function goalHeaders() {
    const jwt = getToken();
    const myId = getMyId() || "";
    return {
      "Content-Type": "application/json",
      accept: "application/json; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
      Authorization: "Bearer " + (jwt || ""),
      cookie: "jwt_token=" + (jwt || ""),
      origin: "https://www.duolingo.com",
      "x-amzn-trace-id": "User=" + myId,
    };
  }

  function goalsFetch(method, path, data) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method,
        url: GOALS_API + path,
        headers: goalHeaders(),
        data: data ? JSON.stringify(data) : undefined,
        timeout: 15000,
        onload(resp) {
          let body = null;
          try {
            body = JSON.parse(resp.responseText || "null");
          } catch {}
          resolve({ status: resp.status, body, raw: resp.responseText });
        },
        onerror() {
          resolve({ status: 0, body: null, raw: "" });
        },
        ontimeout() {
          resolve({ status: 0, body: null, raw: "" });
        },
      });
    });
  }

  function questTimestamp(goalId) {
    const m = String(goalId || "").match(/^(\d{4})_(\d{2})_monthly/);
    if (m) {
      return new Date(
        Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, 15, 12, 0, 0),
      ).toISOString();
    }
    return new Date().toISOString();
  }

  function setQuestStatus(text) {
    if (els.questStatus) els.questStatus.textContent = text;
  }

  async function fetchQuestData() {
    const myId = getMyId();
    if (!myId) throw new Error("Не выполнен вход");
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const [schemaR, progR] = await Promise.all([
      goalsFetch("GET", `/schema?ui_language=en&_=${Date.now()}`),
      goalsFetch(
        "GET",
        `/users/${myId}/progress?timezone=${encodeURIComponent(tz)}&ui_language=en`,
      ),
    ]);
    if (schemaR.status !== 200 || progR.status !== 200) {
      throw new Error("goals-api: " + (schemaR.status || progR.status));
    }
    return { schema: schemaR.body, progressRes: progR.body, tz, myId };
  }

  async function postGoalBatch(metricUpdates, timestamp, tz, myId) {
    return goalsFetch("POST", `/users/${myId}/progress/batch`, {
      metric_updates: metricUpdates,
      timezone: tz,
      timestamp: timestamp || new Date().toISOString(),
    });
  }

  /** Инъекция всех незакрытых квестов выбранного типа одной кнопкой. */
  async function runQuestsByKind(kind, label, btn) {
    if (btn) btn.disabled = true;
    setQuestStatus("Загрузка " + label + "…");
    try {
      const { schema, progressRes, tz, myId } = await fetchQuestData();
      const earned = new Set(
        (progressRes.badges && progressRes.badges.earned) || [],
      );
      const progressMap =
        (progressRes.goals && progressRes.goals.progress) || progressRes.progress || {};
      const matchKind = (g) => {
        const id = String(g.goalId || "").toLowerCase();
        if (/^\d{4}_\d{2}_/.test(id) || id.includes("monthly")) return false;
        if (id.includes("challenge") && !id.includes("weekly_challenge")) return false;
        switch (kind) {
          case "daily":
            return (
              id.includes("daily_quest") &&
              !id.includes("weekly") &&
              !id.includes("friends_quest") &&
              !id.includes("family_quest")
            );
          case "weekly":
            return id.includes("weekly_quest") || id.includes("weekly_challenge");
          case "friends":
            return id.includes("friends_quest") && !id.includes("weekly");
          case "family":
            return id.includes("family_quest") && !id.includes("weekly");
          default:
            return false;
        }
      };
      const goals = (Array.isArray(schema.goals) ? schema.goals : []).filter(matchKind);
      // собираем уникальные метрики незакрытых целей
      const updates = [];
      const seenMetric = new Set();
      const seenGoal = new Set();
      for (const g of goals) {
        const gid = String(g.goalId || "");
        if (!gid || seenGoal.has(gid)) continue;
        seenGoal.add(gid);
        const metric = g.metric || "QUESTS";
        let cur = 0;
        const p = progressMap[gid];
        if (typeof p === "number") cur = p;
        else if (p && typeof p === "object") cur = Number(p.progress || 0);
        const tgt = Math.max(1, Number(g.threshold || 1));
        const done = earned.has(g.badgeId) || earned.has(g.goalId) || cur >= tgt;
        if (done) continue;
        if (seenMetric.has(metric)) continue;
        seenMetric.add(metric);
        updates.push({ metric, quantity: 2000 });
      }
      if (!updates.length) {
        setQuestStatus(label + ": готово (0)");
        showToast(label + ": нечего забирать");
        return;
      }
      updates.push({ metric: "QUESTS", quantity: 1 });
      setQuestStatus(label + ": инъекция " + updates.length + "…");
      const ts = new Date().toISOString();
      await postGoalBatch(updates, ts, tz, myId);
      await new Promise((r) => setTimeout(r, 800));
      await postGoalBatch(updates, ts, tz, myId);
      setQuestStatus(label + ": готово (" + updates.length + ")");
      showToast("✓ " + label + ": " + updates.length + " метрик");
    } catch (e) {
      setQuestStatus("Ошибка: " + (e && e.message));
      showToast(e && e.message ? e.message : "Ошибка квестов", true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // var — чтобы resetLiveCaches не падал на старте (TDZ у let)
  var questCache = null;

  async function runDailyQuests() {
    return runQuestsByKind("daily", "Daily", els.questDaily);
  }

  function renderMonthlyList(items) {
    if (!els.questList) return;
    els.questList.innerHTML = "";
    if (!items.length) {
      els.questList.innerHTML =
        '<div class="dh-muted">Нет незакрытых monthly-квестов</div>';
      return;
    }
    const grid = document.createElement("div");
    grid.className = "dh-shop-grid";
    for (const it of items) {
      const pct = Math.min(100, Math.round((it.progress / Math.max(1, it.target)) * 100));
      const emoji = questEmoji(it.metric);
      const card = document.createElement("div");
      card.className = "dh-shop-card";
      card.innerHTML = `
        <div class="icon">${emoji}</div>
        <div class="name">${it.title}</div>
        <div class="desc">${it.progress} / ${it.target} · ${it.metric}</div>
        <div style="width:100%;height:4px;background:rgba(0,0,0,0.1);border-radius:2px;overflow:hidden;flex-shrink:0">
          <div style="width:${pct}%;height:100%;background:#58CC02;border-radius:2px"></div>
        </div>
        <button class="dh-btn">Получить</button>`;
      const b = card.querySelector("button");
      b.addEventListener("click", async () => {
        b.disabled = true;
        b.textContent = "…";
        const ok = await claimMonthlyOne(it);
        b.textContent = ok ? "✓ Получено" : "Ошибка";
        if (ok) {
          showToast("✓ " + it.title);
          setTimeout(() => loadMonthlyQuests(), 900);
        } else {
          setTimeout(() => {
            b.disabled = false;
            b.textContent = "Получить";
          }, 2500);
        }
      });
      grid.appendChild(card);
    }
    els.questList.appendChild(grid);
  }

  /** Эмодзи для метрики квеста. */
  function questEmoji(metric) {
    const m = String(metric).toUpperCase();
    if (m === "XP") return "⚡";
    if (m === "LESSONS") return "📚";
    if (m === "QUESTS") return "📜";
    if (m === "PERFECT_LESSONS") return "⭐";
    if (m === "NINETY_ACCURACY_LESSONS") return "🎯";
    if (m === "STREAK") return "🔥";
    return "🏆";
  }

  function buildMonthlyItems(schema, progressRes) {
    const progress = (progressRes.goals && progressRes.goals.progress) || progressRes.progress || {};
    const earned = new Set((progressRes.badges && progressRes.badges.earned) || []);
    const schemaMap = new Map();
    (schema.goals || []).forEach((g) => {
      const m = (g.goalId || "").match(/^(\d{4}_\d{2})_monthly/);
      if (!m) return;
      const key = m[1];
      const ex = schemaMap.get(key);
      if (
        !ex ||
        (g.category && g.category.includes("CHALLENGE") && !(ex.category && ex.category.includes("CHALLENGE")))
      ) {
        schemaMap.set(key, g);
      }
    });

    const monthKeys = [];
    Object.keys(progress).forEach((k) => {
      const m = k.match(/^(\d{4}_\d{2})_monthly/);
      if (m) monthKeys.push(m[1]);
    });
    schemaMap.forEach((_, key) => {
      if (!monthKeys.includes(key)) monthKeys.push(key);
    });
    const uniq = [...new Set(monthKeys)].sort().reverse();
    const now = new Date();
    const curYM =
      now.getFullYear() +
      "_" +
      String(now.getMonth() + 1).padStart(2, "0");

    const items = [];
    uniq.forEach((ym) => {
      const schemaGoal = schemaMap.get(ym);
      const progressKey = Object.keys(progress).find((k) =>
        k.startsWith(ym + "_monthly"),
      );
      const rawProg = progressKey ? progress[progressKey] : undefined;
      let cur =
        typeof rawProg === "number"
          ? rawProg
          : (rawProg && rawProg.progress) || 0;
      const tgt = (schemaGoal && schemaGoal.threshold) || 1;
      const isEarned = schemaGoal
        ? earned.has(schemaGoal.badgeId) || earned.has(schemaGoal.goalId)
        : false;
      if (isEarned) return;
      const remaining = Math.max(0, tgt - cur);
      if (remaining <= 0 && ym === curYM) return;
      const [yr, mo] = ym.split("_");
      const monthLabel = new Date(parseInt(yr, 10), parseInt(mo, 10) - 1, 1)
        .toLocaleString("default", { month: "long", year: "numeric" });
      const title =
        (schemaGoal && schemaGoal.title && (schemaGoal.title.uiString || schemaGoal.title)) ||
        "Monthly — " + monthLabel;
      const metric = (schemaGoal && schemaGoal.metric) || "XP";
      // XP-челленджи не закрываются инъекцией — показываем только рабочие QUESTS
      if (metric !== "QUESTS") return;
      items.push({
        ym,
        progressKey: progressKey || ym + "_monthly_challenge",
        title: String(title),
        progress: cur,
        target: tgt,
        metric,
        amount: remaining > 0 ? remaining : tgt,
        isCurrent: ym === curYM,
      });
    });
    return items;
  }

  var monthlyCache = null;

  async function loadMonthlyQuests() {
    const btn = els.questLoad;
    if (btn) btn.disabled = true;
    setQuestStatus("Загрузка monthly…");
    try {
      const data = await fetchQuestData();
      const items = buildMonthlyItems(data.schema, data.progressRes);
      monthlyCache = { ...data, items };
      renderMonthlyList(items);
      setQuestStatus("Monthly: " + items.length + " шт.");
    } catch (e) {
      setQuestStatus("Ошибка: " + (e && e.message));
      showToast(e && e.message ? e.message : "Ошибка monthly", true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function claimMonthlyOne(item) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const myId = getMyId();
    const ts = questTimestamp(item.progressKey || item.ym);
    // как в daily-бруте: большой quantity + QUESTS, иначе XP-квесты не закрываются
    const updates = [
      { metric: item.metric, quantity: Math.max(Number(item.amount) || 1, 2000) },
      { metric: "QUESTS", quantity: 1 },
    ];
    // Duolingo иногда требует второй вызов для выдачи бейджа
    const r1 = await postGoalBatch(updates, ts, tz, myId);
    if (r1.status !== 200) return false;
    await new Promise((r) => setTimeout(r, 800));
    const r2 = await postGoalBatch(updates, ts, tz, myId);
    return r2.status === 200;
  }

  async function claimAllMonthly() {
    const btn = els.questClaimAll;
    if (btn) btn.disabled = true;
    try {
      if (!monthlyCache || !monthlyCache.items) {
        await loadMonthlyQuests();
      }
      const items = (monthlyCache && monthlyCache.items) || [];
      if (!items.length) {
        showToast("Нечего забирать");
        setQuestStatus("Нечего забирать");
        return;
      }
      let ok = 0;
      for (let i = 0; i < items.length; i++) {
        setQuestStatus("Забор " + (i + 1) + "/" + items.length + "…");
        if (await claimMonthlyOne(items[i])) ok++;
        await new Promise((r) => setTimeout(r, 400));
      }
      setQuestStatus("Забрано: " + ok + "/" + items.length);
      showToast("✓ Забрано квестов: " + ok);
      await loadMonthlyQuests();
    } catch (e) {
      setQuestStatus("Ошибка: " + (e && e.message));
      showToast(e && e.message ? e.message : "Ошибка", true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ========== Shop ==========
  // ⚠️ Выдача предметов isFree — чит, на свой страх и риск.

  /** Человекочитаемые названия предметов магазина + количество/цена. */
  /** Эмодзи-иконка для предмета магазина. */
  function shopEmoji(id) {
    const s = String(id).toLowerCase();
    if (s.includes("streak_freeze") || s.includes("streak_shield")) return "🧊";
    if (s.includes("streak_repair")) return "🔧";
    if (s.includes("xp_boost") || s.includes("double_xp")) return "⚡";
    if (s.includes("health") || s.includes("heart")) return "❤️";
    if (s.includes("gem") || s.includes("crystal")) return "💎";
    if (s.includes("outfit") || s.includes("skin")) return "👕";
    if (s.includes("immersive") || s.includes("super")) return "⭐";
    if (s.includes("legendary")) return "🏆";
    if (s.includes("quest")) return "📜";
    return "📦";
  }

  function describeShopItem(item) {
    const id = String(item.id || "");
    const idLow = id.toLowerCase();
    const rawName = (item.name ? String(item.name) : "").trim();

    // число из id/имени: gems_500 → 500, xp_boost_15 → 15
    const num =
      (id.match(/(\d+)\s*$/) || id.match(/(\d+)/) || [])[1] ||
      (rawName.match(/(\d+)/) || [])[1] ||
      "";
    const qty =
      item.quantity != null && item.quantity !== "" ? String(item.quantity) : "";
    const amount = qty || num;

    // короткий смысл — для подписи
    const hints = [
      [/immersive_subscription|super_?3|super_?trial|free_taste/, "Триал Super"],
      [/streak_repair|repair_streak/, "Починка streak"],
      [/streak_freeze|streak_shield|streak_protect/, "Заморозка серии"],
      [/xp_boost|double_xp|xp_2x|xp_15|xp_60/, "Двойной XP"],
      [/health_refill|heart_refill|refill_heart|health_pack|buy_heart|hearts?$/, "Сердца"],
      [/heart_segment|unlimited_hearts|health_shield/, "Сердца"],
      [/gem|crystal/, "Гемы"],
      [/outfit|skin|costume|wearable/, "Аутфит"],
      [/legendary/, "Legendary"],
      [/pronunciation/, "Произношение"],
      [/row_blaster/, "Row Blaster"],
      [/quest_reroll|daily_quest/, "Квесты"],
      [/mastery_test|skill_test/, "Тест"],
      [/bookshelf|chapter/, "Книга"],
      [/ramp_up|final_level|side_quest|practice/, "Доступ"],
    ];
    let hint = id;
    for (const [re, h] of hints) {
      if (re.test(idLow)) {
        hint = h;
        break;
      }
    }

    // имя: API name в приоритете, иначе притираем id
    let name = rawName;
    if (!name || name.toLowerCase() === idLow) {
      name = id
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }
    // подставляем количество, если его нет в названии
    if (amount && !/\d/.test(name)) {
      name += " ×" + amount;
    }

    const bits = [hint];
    if (item.price != null && item.price !== "") {
      bits.push(item.price + " " + (item.currencyType || ""));
    }
    bits.push(id);

    return {
      name: name || id,
      desc: bits.filter(Boolean).join(" · "),
      amount,
    };
  }

  function setShopStatus(text) {
    if (els.shopStatus) els.shopStatus.textContent = text;
  }

  async function getMeLanguages() {
    const myId = getMyId();
    if (!myId) return { fromLanguage: "en", learningLanguage: "en" };
    try {
      const u = await apiGet(
        `${API.users}/${myId}?fields=fromLanguage,learningLanguage`,
      );
      return {
        fromLanguage: u.fromLanguage || "en",
        learningLanguage: u.learningLanguage || "en",
      };
    } catch {
      return { fromLanguage: "en", learningLanguage: "en" };
    }
  }

  function shopPost(url, payload) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "POST",
        url,
        headers: {
          "Content-Type": "application/json",
          accept: "application/json",
          authorization: "Bearer " + (getToken() || ""),
        },
        data: JSON.stringify(payload),
        timeout: 15000,
        onload(resp) {
          resolve(resp.status);
        },
        onerror() {
          resolve(0);
        },
        ontimeout() {
          resolve(0);
        },
      });
    });
  }

  async function buyShopItem(itemName, extra = {}) {
    const myId = getMyId();
    if (!myId) return false;
    const langs = await getMeLanguages();
    const status = await shopPost(
      `${API.users}/${myId}/shop-items`,
      {
        itemName,
        isFree: true,
        consumed: true,
        fromLanguage: langs.fromLanguage,
        learningLanguage: langs.learningLanguage,
        ...extra,
      },
    );
    return status === 200 || status === 201;
  }

  var shopCache = [];

  /** Проверяет, появился ли предмет в shopItems пользователя. */
  async function verifyShopItem(itemName) {
    try {
      const myId = getMyId();
      if (!myId) return null;
      const res = await new Promise((resolve) => {
        GM_xmlhttpRequest({
          method: "GET",
          url: `https://www.duolingo.com/2023-05-23/users/${myId}?fields=shopItems`,
          headers: { accept: "application/json" },
          timeout: 10000,
          onload(resp) {
            try {
              resolve(JSON.parse(resp.responseText || "{}"));
            } catch {
              resolve(null);
            }
          },
          onerror() { resolve(null); },
          ontimeout() { resolve(null); },
        });
      });
      if (!res) return null;
      const list = res.shopItems || (res.body && res.body.shopItems) || [];
      return list.some((s) => {
        const id = String(s.itemName || s.id || s.name || "").toLowerCase();
        return id === String(itemName).toLowerCase() || id.includes(String(itemName).toLowerCase());
      });
    } catch {
      return null;
    }
  }

  function renderShopItems(items) {
    shopCache = items || [];
    renderShopFiltered();
  }
  function renderShopFiltered() {
    if (!els.shopList) return;
    const q = (els.shopSearch && els.shopSearch.value || "").trim().toLowerCase();
    const items = shopCache;
    els.shopList.innerHTML = "";
    const valid = items.filter(
      (i) => (i.currencyType === "XGM" || !i.currencyType) && !(i.id || "").includes("gift"),
    );
    const filtered = q
      ? valid.filter((i) =>
          (i.id || "").toLowerCase().includes(q) ||
          (i.name || "").toLowerCase().includes(q)
        )
      : valid;
    if (!filtered.length) {
      els.shopList.innerHTML = '<div class="dh-muted">' + (q ? "Ничего не найдено" : "Нет предметов") + "</div>";
      return;
    }
    const order = [
      ["Streak", (id) => id.includes("streak_freeze")],
      ["XP", (id) => id.includes("xp_boost")],
      ["Hearts", (id) => id.includes("health") || id.includes("heart")],
      ["Gems", (id) => id.includes("gem")],
      ["Outfits", (id, i) => i.type === "outfit"],
      ["Прочее", () => true],
    ];
    const used = new Set();
    for (const [label, pred] of order) {
      const group = filtered.filter((i) => {
        if (used.has(i.id)) return false;
        if (!pred((i.id || "").toLowerCase(), i)) return false;
        used.add(i.id);
        return true;
      });
      if (!group.length) continue;
      const head = document.createElement("div");
      head.className = "dh-card-title";
      head.style.marginTop = "6px";
      head.textContent = label;
      els.shopList.appendChild(head);
      const grid = document.createElement("div");
      grid.className = "dh-shop-grid";
      for (const item of group) {
        const info = describeShopItem(item);
        const card = document.createElement("div");
        card.className = "dh-shop-card";
        const emoji = shopEmoji(item.id || "");
        card.innerHTML = `
            <div class="icon">${emoji}</div>
            <div class="name">${info.name}</div>
            <div class="desc">${info.desc}</div>
            <button class="dh-btn">Получить</button>`;
        const b = card.querySelector("button");
        b.addEventListener("click", async () => {
          b.disabled = true;
          b.textContent = "…";
          const ok = await buyShopItem(item.id);
          if (!ok) {
            b.textContent = "Ошибка";
            showToast("Не удалось: " + info.name, true);
            setTimeout(() => {
              b.disabled = false;
              b.textContent = "Получить";
            }, 2500);
            return;
          }
          const verified = await verifyShopItem(item.id);
          if (verified === true) {
            b.textContent = "✓ Получено";
            showToast("✓ " + info.name);
          } else {
            b.textContent = "?";
            showToast("? " + info.name + " — проверь в аккаунте");
          }
          setTimeout(() => {
            b.disabled = false;
            b.textContent = "Получить";
          }, 2500);
        });
        grid.appendChild(card);
      }
      els.shopList.appendChild(grid);
    }
  }

  async function loadShop() {
    const btn = els.shopLoad;
    if (btn) btn.disabled = true;
    setShopStatus("Загрузка магазина…");
    try {
      const res = await new Promise((resolve) => {
        GM_xmlhttpRequest({
          method: "GET",
          url: "https://www.duolingo.com/2023-05-23/shop-items",
          headers: { accept: "application/json" },
          timeout: 15000,
          onload(resp) {
            resolve({ status: resp.status, text: resp.responseText });
          },
          onerror() {
            resolve({ status: 0, text: "" });
          },
          ontimeout() {
            resolve({ status: 0, text: "" });
          },
        });
      });
      if (res.status !== 200) throw new Error("HTTP " + res.status);
      const items = (JSON.parse(res.text || "{}").shopItems) || [];
      renderShopItems(items);
      setShopStatus("Предметов: " + items.length);
      if (els.shopSearch) {
        els.shopSearch.disabled = false;
        els.shopSearch.style.opacity = "1";
        els.shopSearch.placeholder = "Поиск предметов…";
      }
    } catch (e) {
      setShopStatus("Ошибка: " + (e && e.message));
      showToast(e && e.message ? e.message : "Ошибка магазина", true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function buySuper3Days() {
    const btn = els.shopSuper;
    if (btn) btn.disabled = true;
    setShopStatus("Выдача Super 3 дня…");
    try {
      const ok = await buyShopItem("immersive_subscription", {
        productId: "com.duolingo.immersive_free_trial_subscription",
      });
      if (ok) {
        setShopStatus("Super 3 дня: выдано");
        showToast("✓ Super 3 дня выдан");
      } else {
        setShopStatus("Super: не удалось");
        showToast("Не удалось выдать Super", true);
      }
    } catch (e) {
      setShopStatus("Ошибка: " + (e && e.message));
      showToast("Ошибка Super", true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ========== Gems (алмазы) ==========
  // ⚠️ Сбор rewardBundles — чит, на свой страх и риск.
  let gemsRunning = false;

  function setGemsStatus(text) {
    if (els.gemsStatus) els.gemsStatus.textContent = text;
  }

  function gemsFetch(method, url, data) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: "Bearer " + (getToken() || ""),
        },
        data: data ? JSON.stringify(data) : undefined,
        timeout: 15000,
        onload(resp) {
          let body = null;
          try {
            body = JSON.parse(resp.responseText || "null");
          } catch {}
          resolve({ status: resp.status, body });
        },
        onerror() {
          resolve({ status: 0, body: null });
        },
        ontimeout() {
          resolve({ status: 0, body: null });
        },
      });
    });
  }

  async function getGemCount() {
    const myId = getMyId();
    if (!myId) return null;
    const res = await gemsFetch(
      "GET",
      `https://www.duolingo.com/2023-05-23/users/${myId}?fields=gemsConfig`,
    );
    if (res.status !== 200 || !res.body) return null;
    const g =
      res.body.gemsConfig && res.body.gemsConfig.gems != null
        ? res.body.gemsConfig.gems
        : null;
    return g;
  }

  async function fetchGemRewards() {
    const myId = getMyId();
    if (!myId) return [];
    const res = await gemsFetch(
      "GET",
      `https://www.duolingo.com/2023-05-23/users/${myId}?fields=rewardBundles{rewards}`,
    );
    if (res.status !== 200 || !res.body) return [];
    const bundles = res.body.rewardBundles || [];
    const out = [];
    for (const bundle of bundles) {
      for (const reward of bundle.rewards || []) {
        const rid = reward.id || "";
        if (reward.consumed) continue;
        if (
          rid.startsWith("SKILL_COMPLETION-") ||
          rid.startsWith("SKILL_COMPLETION_BALANCED-")
        ) {
          out.push({ id: rid, amount: reward.amount || 0 });
        }
      }
    }
    return out;
  }

  async function claimGemReward(rewardId) {
    const myId = getMyId();
    if (!myId) return false;
    const langs = await getMeLanguages();
    const res = await gemsFetch(
      "PATCH",
      `https://www.duolingo.com/2023-05-23/users/${myId}/rewards/${rewardId}`,
      {
        consumed: true,
        fromLanguage: langs.fromLanguage,
        learningLanguage: langs.learningLanguage,
      },
    );
    return res.status >= 200 && res.status < 300;
  }

  async function claimGemsOnce() {
    const btn = els.gemsOnce;
    if (btn) btn.disabled = true;
    setGemsStatus("Поиск наград…");
    try {
      const rewards = await fetchGemRewards();
      if (!rewards.length) {
        setGemsStatus("Нет свободных наград");
        showToast("Нет свободных gem-наград");
        return;
      }
      let ok = 0;
      let gained = 0;
      for (const r of rewards) {
        if (await claimGemReward(r.id)) {
          ok++;
          gained += r.amount || 0;
        }
      }
      const gems = await getGemCount();
      setGemsStatus(
        `Собрано: ${ok}/${rewards.length} (+${gained}) · баланс: ${
          gems != null ? gems : "—"
        }`,
      );
      showToast("✓ Наград: " + ok);
    } catch (e) {
      setGemsStatus("Ошибка: " + (e && e.message));
      showToast("Ошибка сбора гемов", true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function farmGems() {
    if (gemsRunning) return;
    gemsRunning = true;
    if (els.gemsFarm) els.gemsFarm.disabled = true;
    if (els.gemsOnce) els.gemsOnce.disabled = true;
    let total = 0;
    let rounds = 0;
    setGemsStatus("Фарм…");
    try {
      while (gemsRunning) {
        const rewards = await fetchGemRewards();
        if (!rewards.length) {
          rounds++;
          if (rounds >= 4) break;
          await new Promise((r) => setTimeout(r, 800));
          continue;
        }
        rounds = 0;
        for (const r of rewards) {
          if (!gemsRunning) break;
          if (await claimGemReward(r.id)) {
            total += r.amount || 0;
            setGemsStatus("Фарм… + " + total);
          }
          await new Promise((r2) => setTimeout(r2, 150));
        }
      }
      const gems = await getGemCount();
      setGemsStatus(`Фарм стоп · +${total} · баланс: ${gems != null ? gems : "—"}`);
      showToast(total ? "✓ Собрано гемов: " + total : "Фарм завершён");
    } finally {
      gemsRunning = false;
      if (els.gemsFarm) els.gemsFarm.disabled = false;
      if (els.gemsOnce) els.gemsOnce.disabled = false;
    }
  }

  function stopGemsFarm() {
    gemsRunning = false;
    showToast("Фарм гемов остановлен");
  }

  /** Фарм гемов в 8 потоков — быстрее, но рискованнее. */
  async function farmGemsFast() {
    if (gemsRunning) return;
    gemsRunning = true;
    if (els.gemsFarm) els.gemsFarm.disabled = true;
    if (els.gemsFarmFast) els.gemsFarmFast.disabled = true;
    if (els.gemsOnce) els.gemsOnce.disabled = true;
    let total = 0;
    let rounds = 0;
    const THREADS = 8;
    setGemsStatus("Фарм ×8…");
    try {
      while (gemsRunning) {
        const rewards = await fetchGemRewards();
        if (!rewards.length) {
          rounds++;
          if (rounds >= 4) break;
          await new Promise((r) => setTimeout(r, 800));
          continue;
        }
        rounds = 0;
        // разбиваем на пачки по THREADS
        for (let i = 0; i < rewards.length && gemsRunning; i += THREADS) {
          const batch = rewards.slice(i, i + THREADS);
          const results = await Promise.all(
            batch.map((r) => claimGemReward(r.id).then((ok) => (ok ? r.amount || 0 : 0))),
          );
          total += results.reduce((a, b) => a + b, 0);
          setGemsStatus("Фарм ×8… + " + total);
        }
        // небольшая пауза между пачками
        if (gemsRunning) await new Promise((r) => setTimeout(r, 250));
      }
      const gems = await getGemCount();
      setGemsStatus(`Фарм ×8 стоп · +${total} · баланс: ${gems != null ? gems : "—"}`);
      showToast(total ? "✓ Собрано гемов: " + total : "Фарм завершён");
    } finally {
      gemsRunning = false;
      if (els.gemsFarm) els.gemsFarm.disabled = false;
      if (els.gemsFarmFast) els.gemsFarmFast.disabled = false;
      if (els.gemsOnce) els.gemsOnce.disabled = false;
    }
  }

  // ========== Streak ==========
  // ⚠️ Накрутка дней серии — чит, на свой страх и риск.
  let streakRunning = false;

  function setStreakStatus(t) {
    if (els.streakStatus) els.streakStatus.textContent = t;
  }

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

  async function getUserStreakInfo() {
    const myId = getMyId();
    if (!myId) throw new Error("Не выполнен вход");
    const u = await apiGet(
      `${API.users}/${myId}?fields=timezone,streakData,fromLanguage,learningLanguage`,
    );
    return {
      myId,
      timezone: u.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      startDate:
        u.streakData && u.streakData.currentStreak
          ? u.streakData.currentStreak.startDate
          : null,
      fromLanguage: u.fromLanguage || "en",
      learningLanguage: u.learningLanguage || "en",
    };
  }

  function sessionRequest(method, url, payload) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: {
          "Content-Type": "application/json",
          accept: "application/json",
          authorization: "Bearer " + (getToken() || ""),
        },
        data: payload ? JSON.stringify(payload) : undefined,
        timeout: 20000,
        onload(resp) {
          let body = null;
          try {
            body = JSON.parse(resp.responseText || "null");
          } catch {}
          resolve({ status: resp.status, body });
        },
        onerror() {
          resolve({ status: 0, body: null });
        },
        ontimeout() {
          resolve({ status: 0, body: null });
        },
      });
    });
  }

  async function runStreakFarm() {
    if (streakRunning) return;
    const days = Math.max(
      1,
      Math.min(365, parseInt(els.streakDays && els.streakDays.value, 10) || 7),
    );
    streakRunning = true;
    if (els.streakRun) els.streakRun.disabled = true;
    setStreakStatus("Подготовка…");

    try {
      const info = await getUserStreakInfo();
      const tz = info.timezone;
      let base;
      if (info.startDate && /^\d{4}-\d{2}-\d{2}$/.test(info.startDate)) {
        const [y, m, d] = info.startDate.split("-").map(Number);
        base = { year: y, month: m, day: d };
      } else {
        const p = tzParts(tz, new Date());
        base = { year: +p.year, month: +p.month, day: +p.day };
      }

      let saved = 0;
      for (let i = 0; i < days && streakRunning; i++) {
        setStreakStatus(`День ${i + 1}/${days}… (+${saved})`);

        const sr = await sessionRequest("POST", `https://www.duolingo.com/2017-06-30/sessions`, {
          challengeTypes: CHALLENGE_TYPES,
          fromLanguage: info.fromLanguage,
          isFinalLevel: false,
          isV2: true,
          juicy: true,
          learningLanguage: info.learningLanguage,
          smartTipsVersion: 2,
          type: "GLOBAL_PRACTICE",
        });
        if (sr.status !== 200 || !sr.body || !sr.body.id) {
          setStreakStatus(`Ошибка создания сессии (HTTP ${sr.status}), пауза…`);
          await new Promise((r) => setTimeout(r, 2500));
          continue;
        }

        const endSecs = wallClockToSeconds(
          tz,
          base.year,
          base.month,
          base.day - 1 - i,
          12,
          0,
          0,
        );
        const pr = await sessionRequest(
          "PUT",
          `https://www.duolingo.com/2017-06-30/sessions/${sr.body.id}`,
          {
            ...sr.body,
            heartsLeft: 5,
            startTime: endSecs - 1,
            endTime: endSecs,
            enableBonusPoints: false,
            failed: false,
            maxInLessonStreak: 9,
            shouldLearnThings: true,
          },
        );
        if (pr.status === 200) {
          saved++;
          setStreakStatus(`+${saved} дн. (из ${days})`);
        }
        await new Promise((r) => setTimeout(r, 400 + Math.floor(Math.random() * 400)));
      }
      setStreakStatus(`Готово: +${saved} дн.`);
      showToast(saved ? "✓ Streak накручен на " + saved : "Не удалось накрутить");
    } catch (e) {
      setStreakStatus("Ошибка: " + (e && e.message));
      showToast("Ошибка streak", true);
    } finally {
      streakRunning = false;
      if (els.streakRun) els.streakRun.disabled = false;
    }
  }

  function stopStreakFarm() {
    streakRunning = false;
    showToast("Накрутка streak остановлена");
  }

  // ========== League ==========
  // ⚠️ Автофарм до места — чит.
  const LB_BASE =
    "https://duolingo-leaderboards-prod.duolingo.com/leaderboards/7d9f5dd1-8423-491a-91f2-2532052038ce";
  const LEAGUE_TIERS = [
    "Bronze","Silver","Gold","Sapphire","Ruby",
    "Emerald","Amethyst","Pearl","Obsidian","Diamond",
  ];
  let lbRunning = false;
  let lbCohortId = null;

  function setLbStatus(t) {
    if (els.lbStatus) els.lbStatus.textContent = t;
  }

  function lbFetch(method, url, data) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: "Bearer " + (getToken() || ""),
        },
        data: data ? JSON.stringify(data) : undefined,
        timeout: 15000,
        onload(resp) {
          let body = null;
          try {
            body = JSON.parse(resp.responseText || "null");
          } catch {}
          resolve({ status: resp.status, body });
        },
        onerror() {
          resolve({ status: 0, body: null });
        },
        ontimeout() {
          resolve({ status: 0, body: null });
        },
      });
    });
  }

  async function fetchLeaderboard() {
    const myId = getMyId();
    if (!myId) throw new Error("Не выполнен вход");
    const res = await lbFetch(
      "GET",
      `${LB_BASE}/users/${myId}?client_unlocked=true&get_reactions=true&_=${Date.now()}`,
    );
    if (res.status !== 200 || !res.body) return null;
    const raw = Array.isArray(res.body) ? res.body[0] : res.body;
    if (!raw || !raw.active || !raw.active.cohort || !raw.active.cohort.rankings) {
      return null;
    }
    const merged = Object.assign({}, raw.active);
    if (raw.user_id != null) merged.user_id = raw.user_id;
    if (raw.score != null) merged.score = raw.score;
    if (raw.tier != null) merged.tier = raw.tier;
    if (raw.is_demoted != null) merged.is_demoted = raw.is_demoted;
    if (raw.is_promoted != null) merged.is_promoted = raw.is_promoted;
    if (merged.cohort && merged.cohort.cohort_id) lbCohortId = merged.cohort.cohort_id;
    return merged;
  }

  function renderLeaderboard(data) {
    if (!els.lbList) return;
    els.lbList.innerHTML = "";
    const rankings = ((data && data.cohort && data.cohort.rankings) || []).slice();
    if (!rankings.length) {
      els.lbList.innerHTML = '<div class="dh-muted">Нет данных — возможно, ты не в лиге</div>';
      return;
    }
    const myId = String(getMyId() || "");
    const tierName =
      data && typeof data.tier === "number" && LEAGUE_TIERS[data.tier]
        ? LEAGUE_TIERS[data.tier]
        : "League";
    const myRankIdx = rankings.findIndex((u) => String(u.user_id) === myId);
    const myScore = myRankIdx >= 0 ? rankings[myRankIdx].score : 0;

    rankings.forEach((u, i) => {
      const row = document.createElement("div");
      const me = String(u.user_id) === myId;
      row.className = "dh-lb-row" + (me ? " me" : "");
      const gap = Number(u.score || 0) - myScore;
      const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "";
      const rankTxt = medal || (i + 1);
      let gapHtml = "";
      if (me) {
        gapHtml = '<span class="gap">ты</span>';
      } else {
        const g = gap > 0 ? "+" + gap : String(gap);
        const cls = gap > 0 ? "up" : gap < 0 ? "down" : "";
        gapHtml = `<span class="gap ${cls}">${g}</span>`;
      }
      row.innerHTML = `
        <span class="rank">${rankTxt}</span>
        <span class="name">${u.display_name || u.name || u.username || u.user_id}</span>
        <span class="score">${Number(u.score || 0)}</span>
        ${gapHtml}`;
      els.lbList.appendChild(row);
    });

    const prom = rankings.slice(0, 10).some((u) => String(u.user_id) === myId);
    setLbStatus(
      `${tierName} · моё место: ${myRankIdx >= 0 ? myRankIdx + 1 : "—"} · XP: ${myScore}${
        data && data.is_promoted ? " · повышение" : ""
      }${data && data.is_demoted ? " · понижение" : ""}`,
    );
  }

  async function loadLeague() {
    const btn = els.lbLoad;
    if (btn) btn.disabled = true;
    setLbStatus("Загрузка лиги…");
    try {
      const data = await fetchLeaderboard();
      if (!data) {
        setLbStatus("Нет активной лиги");
        els.lbList.innerHTML =
          '<div class="dh-muted">Не в лиге или нет данных</div>';
        return;
      }
      renderLeaderboard(data);
    } catch (e) {
      setLbStatus("Ошибка: " + (e && e.message));
      showToast("Ошибка загрузки лиги", true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function joinLeague() {
    const btn = els.lbJoin;
    if (btn) btn.disabled = true;
    setLbStatus("Вступление в лигу…");
    try {
      const myId = getMyId();
      // если social выключен — временно включаем
      let wasPrivate = false;
      try {
        const pr = await lbFetch(
          "GET",
          `https://www.duolingo.com/2023-05-23/users/${myId}/privacy-settings?fields=privacySettings`,
        );
        if (pr.status === 200 && pr.body) {
          const soc = (pr.body.privacySettings || []).find(
            (s) => s.id === "disable_social",
          );
          wasPrivate = soc ? !!soc.enabled : false;
        }
      } catch {}
      if (wasPrivate) {
        await lbFetch(
          "PATCH",
          `https://www.duolingo.com/2023-05-23/users/${myId}/privacy-settings?fields=privacySettings`,
          { DISABLE_SOCIAL: false },
        );
        await new Promise((r) => setTimeout(r, 2000));
      }

      // лёгкий XP, чтобы попасть в лигу
      await sessionRequest("POST", "https://www.duolingo.com/2017-06-30/sessions", {
        challengeTypes: [],
        fromLanguage: "en",
        learningLanguage: "en",
        type: "GLOBAL_PRACTICE",
      }).catch(() => {});

      if (wasPrivate) {
        await lbFetch(
          "PATCH",
          `https://www.duolingo.com/2023-05-23/users/${myId}/privacy-settings?fields=privacySettings`,
          { DISABLE_SOCIAL: true },
        );
      }
      setLbStatus("Проверь таблицу лиги");
      showToast("Запрос на вступление отправлен");
      await loadLeague();
    } catch (e) {
      setLbStatus("Ошибка: " + (e && e.message));
      showToast("Не удалось вступить в лигу", true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function farmLeague() {
    if (lbRunning) return;
    const targetRank = Math.max(
      1,
      Math.min(100, parseInt(els.lbTarget && els.lbTarget.value, 10) || 3),
    );
    lbRunning = true;
    if (els.lbFarm) els.lbFarm.disabled = true;
    setLbStatus("Фарм до места #" + targetRank + "…");

    try {
      let joins = 0;
      let fails = 0;
      while (lbRunning) {
        const data = await fetchLeaderboard();
        if (!data) {
          if (joins < 3) {
            joins++;
            setLbStatus("Нет лиги — пробую вступить…");
            await joinLeague();
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }
          setLbStatus("Не удалось попасть в лигу");
          break;
        }
        fails = 0;
        const rankings = data.cohort.rankings || [];
        const myId = String(getMyId() || "");
        const meIdx = rankings.findIndex((u) => String(u.user_id) === myId);
        const me = meIdx >= 0 ? rankings[meIdx] : null;
        const myRank = meIdx + 1;
        // цель — обогнать того, кто сейчас на целевом месте (+50 XP)
        const targetPerson = rankings[targetRank - 1] || null;
        const myScore = me ? Number(me.score || 0) : 0;
        const targetScore =
          targetPerson && String(targetPerson.user_id) !== myId
            ? Number(targetPerson.score || 0) + 50
            : myScore + 50;

        renderLeaderboard(data);
        if (me && (myScore >= targetScore || (myRank > 0 && myRank <= targetRank))) {
          setLbStatus("Цель достигнута: #" + myRank);
          showToast("🏆 Место #" + myRank);
          break;
        }

        setLbStatus(
          `Фарм… место ${myRank || "—"}, цель ${targetScore} XP (сейчас ${myScore})`,
        );
        // накрутка XP через stories
        const langs = await getMeLanguages();
        const res = await new Promise((resolve) => {
          GM_xmlhttpRequest({
            method: "POST",
            url: "https://stories.duolingo.com/api2/stories/fr-en-le-passeport/complete",
            headers: {
              "Content-Type": "application/json",
              accept: "application/json",
              authorization: "Bearer " + (getToken() || ""),
            },
            data: JSON.stringify({
              awardXp: true,
              completedBonusChallenge: true,
              fromLanguage: "fr",
              learningLanguage: "en",
              hasXpBoost: false,
              isLegendaryMode: true,
            }),
            timeout: 20000,
            onload(r) {
              resolve({ status: r.status });
            },
            onerror() {
              resolve({ status: 0 });
            },
            ontimeout() {
              resolve({ status: 0 });
            },
          });
        });
        if (res.status !== 200) {
          fails++;
          if (fails >= 5) {
            setLbStatus("Слишком много ошибок, стоп");
            break;
          }
          await new Promise((r) => setTimeout(r, 2500));
        }
        await new Promise((r) => setTimeout(r, 500 + Math.floor(Math.random() * 500)));
      }
    } catch (e) {
      setLbStatus("Ошибка: " + (e && e.message));
    } finally {
      lbRunning = false;
      if (els.lbFarm) els.lbFarm.disabled = false;
    }
  }

  function stopLeagueFarm() {
    lbRunning = false;
    showToast("Фарм лиги остановлен");
  }

  // ========== Список друзей ==========
  var friendsCache = null;

  function resetLiveCaches() {
    friendsCache = null;
    monthlyCache = null;
    questCache = null;
  }

  /** Метки стартового состояния (нужны и в syncSwitches, и в bindEvents). */
  const startLabels = {
    remember: "Помнить последнее",
    closed: "Закрыто",
    min: "Свёрнуто",
    open: "Раскрыто",
  };

  /** Синхронизирует тумблеры и числовые поля с DATA.settings. */
  function syncSwitches() {
    if (!els || !els.setAuto) return;
    els.setAuto.classList.toggle("on", !!DATA.settings.autoCheck);
    els.setBadge.classList.toggle("on", !!DATA.settings.showBadge);
    if (els.setStartText) {
      els.setStartText.textContent =
        startLabels[DATA.settings.startState] || startLabels.remember;
    }
    if (els.setCache) els.setCache.value = DATA.settings.cacheMinutes;
    if (els.setDelay) els.setDelay.value = DATA.settings.requestDelay;
    if (els.setNotify) els.setNotify.value = DATA.settings.notifyHideSec || 5;
    if (els.setLbGap) els.setLbGap.value = DATA.settings.lbGapRefresh || 2;
    if (els.setInactive) els.setInactive.value = DATA.settings.inactiveDays;
    if (els.setFreeSuper) els.setFreeSuper.classList.toggle("on", !!DATA.settings.freeSuper);
  }

  /** Обновляет UI после смены аккаунта (тема, позиция, списки). */
  /** Список аккаунтов в блоке «Мой аккаунт». */
  function renderAccounts() {
    const box = shadow && shadow.querySelector("#dh-acc-list");
    if (!box) return;
    const store = DATA._store || { accounts: {} };
    const accounts = store.accounts || {};
    const curId = DATA._accountId || currentAccountId();
    const ids = Object.keys(accounts).filter((k) => k !== "anon");
    box.innerHTML = "";
    if (!ids.length) {
      box.innerHTML = '<div class="dh-muted">Нет сохранённых аккаунтов</div>';
      return;
    }
    for (const id of ids) {
      const a = accounts[id];
      const name = a.label || (a.me && a.me.username) || a.username || id;
      const isCur = id === curId;
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:8px;padding:5px 0";
      row.innerHTML = `
        <div style="flex:1;min-width:0;${isCur ? "font-weight:700" : ""}">
          <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px">${name}${isCur ? " ✓" : ""} <span style="opacity:0.5;font-weight:400;font-size:10px">· id: ${id}</span></div>
          ${isCur ? '<div id="dh-tg-link-status" style="font-size:10px;opacity:0.7;margin-top:1px"></div>' : ""}
        </div>
        ${isCur
          ? '<button class="dh-btn" id="dh-tg-link-btn" style="padding:3px 10px;font-size:10px;flex-shrink:0">…</button>'
          : '<button class="dh-btn" data-switch="' + id + '" style="padding:3px 10px;font-size:10px;flex-shrink:0">Переключить</button>'}`;
      const b = row.querySelector("[data-switch]");
      if (b) {
        b.addEventListener("click", () => switchToAccount(id));
      }
      box.appendChild(row);

      // обработчик кнопки Telegram — только у активного профиля
      if (isCur) {
        const linkBtn = row.querySelector("#dh-tg-link-btn");
        const linkStatus = row.querySelector("#dh-tg-link-status");
        if (linkBtn) {
          linkBtn.addEventListener("click", () => {
            if (linkBtn.dataset.mode === "unlink") {
              unlinkTelegram(id, linkBtn, linkStatus);
            } else {
              startTelegramLink(linkBtn, linkStatus);
            }
          });
        }
        checkLinkStatus(id, linkBtn, linkStatus);
      }
    }
    renderDashboard();
  }

  // ========== Приватность ==========
  // ========== Приватность ==========
  const PRIVACY_SETTINGS = [
    { id: "disable_social", label: "Скрыть профиль", desc: "Подписки и активность не видны другим" },
    { id: "disable_leaderboards", label: "Скрыть из лидербордов", desc: "Не показывать в таблицах" },
    { id: "disable_friends_quests", label: "Без квестов с друзьями", desc: "Отключить совместные квесты" },
    { id: "disable_shared_streak", label: "Без общего streak", desc: "Отключить общий streak с друзьями" },
    { id: "disable_kudos", label: "Без лайков", desc: "Отключить получение kudos" },
    { id: "disable_clubs", label: "Без клубов", desc: "Отключить функцию клубов" },
    { id: "disable_personalized_ads", label: "Без персональной рекламы", desc: "Отключить таргетинг" },
    { id: "disable_third_party_tracking", label: "Без сторонней аналитики", desc: "Отключить трекинг третьих лиц" },
    { id: "disable_stream", label: "Скрыть стрим", desc: "Не показывать ленту активности" },
    { id: "disable_profile_country", label: "Скрыть страну", desc: "Страна не видна в профиле" },
    { id: "disable_mature_words", label: "Взрослые слова", desc: "Показывать лексику для взрослых" },
    { id: "disable_feed_card_public_visibility", label: "Скрыть карточки в ленте", desc: "Профиль не в публичной ленте" },
  ];

  async function loadPrivacyStatus() {
    const myId = getMyId();
    if (!myId || !els.privacyList) return;
    try {
      const res = await new Promise((resolve) => {
        GM_xmlhttpRequest({
          method: "GET",
          url: `https://www.duolingo.com/2023-05-23/users/${myId}/privacy-settings?fields=privacySettings`,
          headers: { accept: "application/json" },
          timeout: 10000,
          onload(r) { try { resolve(JSON.parse(r.responseText || "{}")); } catch { resolve(null); } },
          onerror() { resolve(null); },
          ontimeout() { resolve(null); },
        });
      });
      const list = (res && (res.privacySettings || (res.body && res.body.privacySettings))) || [];
      const map = {};
      if (Array.isArray(list)) {
        for (const x of list) map[x.id] = !!x.enabled;
      }
      DATA.privacySnapshot = map;
      renderPrivacyList(map);
    } catch {
      els.privacyList.innerHTML = '<div class="dh-muted">Не удалось загрузить настройки</div>';
    }
  }

  function renderPrivacyList(stateMap) {
    if (!els.privacyList) return;
    els.privacyList.innerHTML = "";
    for (const item of PRIVACY_SETTINGS) {
      const isOn = !!stateMap[item.id];
      const row = document.createElement("div");
      row.className = "dh-setting-row";
      row.style.borderBottom = "none";
      row.style.padding = "3px 0";
      row.innerHTML = `
        <div class="dh-setting-label" style="min-width:0">
          <div style="font-size:11px">${item.label}</div>
          <small>${item.desc}</small>
        </div>
        <div class="dh-switch${isOn ? " on" : ""}" data-privacy="${item.id}"></div>`;
      const sw = row.querySelector("[data-privacy]");
      if (sw) {
        sw.addEventListener("click", async () => {
          const currentlyOn = sw.classList.contains("on");
          const newVal = !currentlyOn;
          sw.style.opacity = "0.5";
          const ok = await setPrivacyValue(item.id, newVal);
          sw.style.opacity = "";
          if (ok) {
            sw.classList.toggle("on", newVal);
            showToast(item.label + (newVal ? " — включено" : " — выключено"));
          } else {
            showToast("Не удалось сохранить: " + item.label, true);
          }
        });
      }
      els.privacyList.appendChild(row);
    }
  }

  async function setPrivacyValue(settingId, enabled) {
    const myId = getMyId();
    if (!myId) return false;
    try {
      const status = await new Promise((resolve) => {
        GM_xmlhttpRequest({
          method: "PATCH",
          url: `https://www.duolingo.com/2023-05-23/users/${myId}/privacy-settings?fields=privacySettings`,
          headers: { accept: "application/json", "content-type": "application/json" },
          data: JSON.stringify({ [settingId.toUpperCase()]: enabled }),
          timeout: 10000,
          onload(r) { resolve(r.status); },
          onerror() { resolve(0); },
          ontimeout() { resolve(0); },
        });
      });
      return status === 200 || status === 201;
    } catch {
      return false;
    }
  }

  // ========== Статистика аккаунта ==========
  async function collectStats() {
    const myId = getMyId();
    if (!myId) return;
    try {
      const res = await new Promise((resolve) => {
        GM_xmlhttpRequest({
          method: "GET",
          url: `https://www.duolingo.com/2017-06-30/users/${myId}?fields=totalXp,streak`,
          headers: { accept: "application/json" },
          timeout: 10000,
          onload(r) { try { resolve(JSON.parse(r.responseText || "{}")); } catch { resolve(null); } },
          onerror() { resolve(null); },
          ontimeout() { resolve(null); },
        });
      });
      if (!res) return;
      const totalXp = res.totalXp ?? (res.body && res.body.totalXp) ?? null;
      const streak = res.streak ?? (res.body && res.body.streak) ?? null;
      if (totalXp === null) return;

      const stats = DATA.stats || { xpLog: [], leagueLog: [], lastSnapshot: null };
      const now = Date.now();
      const today = localDateStr(new Date(now));
      const last = stats.lastSnapshot;

      // записываем XP за день (накапливаем разницу)
      if (last && last.totalXp != null) {
        const delta = totalXp - last.totalXp;
        const existing = stats.xpLog.find((e) => e.date === today);
        if (existing) {
          existing.xp = Math.max(0, existing.xp + Math.max(0, delta));
        } else {
          stats.xpLog.push({ date: today, xp: Math.max(0, delta) });
        }
        // обрезаем до 90 дней
        const cutoff = localDateStr(new Date(now - 90 * 86400000));
        stats.xpLog = stats.xpLog.filter((e) => e.date >= cutoff);
      }

      stats.lastSnapshot = { ts: now, totalXp, streak: streak ?? (last && last.streak) };
      DATA.stats = stats;
      saveData();
      if (typeof renderStats === "function") renderStats();
      // синхронизируем xpLog с сервером бота
      try {
        GM_xmlhttpRequest({
          method: "POST",
          url: BOT_API + "/api/sync-stats",
          headers: { "content-type": "application/json" },
          data: JSON.stringify({
            duolingoUserId: myId,
            duolingoUsername: (DATA.me && DATA.me.username) || "",
            xpLog: stats.xpLog,
            totalXp,
            streak,
            excludeList: DATA.excludeList || [],
            scriptVersion: (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "",
          }),
          timeout: 5000,
          onload(r) {
            // действия бота → в историю (undo там), события подписок → в «Изменения»
            try {
              const d = JSON.parse(r.responseText || "null");
              if (d && Array.isArray(d.pendingActions)) mergeBotActions(d.pendingActions);
              if (d && Array.isArray(d.pendingChanges)) mergeBotChanges(d.pendingChanges);
            } catch {}
          },
          onerror() {},
          ontimeout() {},
        });
      } catch {}
    } catch {}
  }

  function renderStats() {
    const stats = DATA.stats || { xpLog: [], leagueLog: [], lastSnapshot: null };
    const today = localDateStr();

    // сегодня / неделя
    const todayXp = stats.xpLog.find((e) => e.date === today);
    const weekAgo = localDateStr(new Date(Date.now() - 7 * 86400000));
    const weekXp = stats.xpLog.filter((e) => e.date >= weekAgo).reduce((s, e) => s + (e.xp || 0), 0);
    const streak = (stats.lastSnapshot && stats.lastSnapshot.streak) ?? "—";

    if (els.statToday) els.statToday.textContent = "+" + (todayXp ? todayXp.xp : 0).toLocaleString("ru");
    if (els.statWeek) els.statWeek.textContent = "+" + weekXp.toLocaleString("ru");
    if (els.statStreak) els.statStreak.textContent = streak;

    // график 7 дней
    if (els.statChart) {
      const days = [];
      for (let i = 6; i >= 0; i--) {
        const d = localDateStr(new Date(Date.now() - i * 86400000));
        const entry = stats.xpLog.find((e) => e.date === d);
        days.push({ date: d, xp: entry ? entry.xp : 0 });
      }
      const maxXp = Math.max(1, ...days.map((d) => d.xp));
      els.statChart.innerHTML = days.map((d) => {
        const pct = Math.round((d.xp / maxXp) * 100);
        const label = d.date.slice(8, 10);
        return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">
          <div style="width:100%;height:${Math.max(3, pct * 0.3)}px;background:#58CC02;border-radius:2px 2px 0 0;opacity:${d.xp > 0 ? 1 : 0.2}"></div>
          <div style="font-size:8px;opacity:0.5">${label}</div>
        </div>`;
      }).join("");
    }

  }

  /** Линковка Telegram: генерация кода и показ ссылки. */
  async function startTelegramLink(btn, statusEl) {
    const myId = getMyId();
    if (!myId) { showToast("Не удалось определить аккаунт", true); return; }
    const jwt = getToken();
    console.log("[TG-LINK] getToken() =", jwt ? "YES len=" + jwt.length : "NULL");
    btn.disabled = true;
    btn.textContent = "…";
    try {
      const res = await new Promise((resolve) => {
        GM_xmlhttpRequest({
          method: "POST",
          url: BOT_API + "/api/link-code",
          headers: { "content-type": "application/json" },
          data: JSON.stringify({ duolingoUserId: myId, duolingoUsername: (DATA.me && DATA.me.username) || "", jwt: jwt }),
          timeout: 10000,
          onload(r) {
            try { resolve(JSON.parse(r.responseText || "{}")); } catch { resolve(null); }
          },
          onerror() { resolve(null); },
          ontimeout() { resolve(null); },
        });
      });
      if (!res || !res.deepLink) {
        btn.disabled = false;
        btn.textContent = "Привязать Telegram";
        if (statusEl) statusEl.textContent = "Сервер недоступен";
        showToast("Сервер линковки недоступен", true);
        return;
      }
      // показываем ссылку и начинаем поллинг статуса
      if (statusEl) {
        statusEl.innerHTML =
          `<a href="${res.deepLink}" target="_blank" style="color:#58cc02;text-decoration:underline">Нажми для привязки →</a>`;
      }
      btn.textContent = "Ожидание…";
      showToast("Открой ссылку в Telegram для привязки");
      // поллинг статуса
      pollLinkStatus(myId, btn, statusEl);
    } catch {
      btn.disabled = false;
      btn.textContent = "Привязать Telegram";
      showToast("Ошибка генерации кода", true);
    }
  }

  /** Разовая проверка статуса привязки Telegram. */
  async function checkLinkStatus(duoId, btn, statusEl) {
    try {
      const res = await new Promise((resolve) => {
        GM_xmlhttpRequest({
          method: "GET",
          url: BOT_API + "/api/link-status?duolingoUserId=" + encodeURIComponent(duoId),
          timeout: 10000,
          onload(r) { try { resolve(JSON.parse(r.responseText || "{}")); } catch { resolve(null); } },
          onerror() { resolve(null); },
          ontimeout() { resolve(null); },
        });
      });
      if (res && res.linked) {
        if (btn) {
          btn.textContent = "Отвязать";
          btn.disabled = false;
          btn.dataset.mode = "unlink";
          btn.classList.add("dh-btn-danger");
        }
        if (statusEl) statusEl.textContent = "Telegram привязан: @" + (res.tgUsername || "telegram") + (res.tgUserId ? " · id: " + res.tgUserId : "");
      } else {
        if (btn) {
          btn.textContent = "🔗 Привязать";
          btn.disabled = false;
          btn.dataset.mode = "link";
          btn.classList.remove("dh-btn-danger");
        }
        if (statusEl) statusEl.textContent = "";
      }
    } catch {
      if (btn) { btn.textContent = "🔗 Привязать"; btn.disabled = false; btn.dataset.mode = "link"; }
    }
  }

  /** Отвязка Telegram. */
  async function unlinkTelegram(duoId, btn, statusEl) {
    const ok = await showConfirm(
      "Отвязать Telegram?\nСвязь между Duolingo и Telegram будет удалена.\nВсе данные и настройки на сервере бота тоже будут удалены (статистика, уведомления, друзья, история действий).",
      "Отвязка Telegram",
    );
    if (!ok) return;
    btn.disabled = true;
    btn.textContent = "…";
    try {
      const res = await new Promise((resolve) => {
        GM_xmlhttpRequest({
          method: "POST",
          url: BOT_API + "/api/unlink",
          headers: { "content-type": "application/json" },
          data: JSON.stringify({ duolingoUserId: duoId }),
          timeout: 10000,
          onload(r) { try { resolve(JSON.parse(r.responseText || "{}")); } catch { resolve(null); } },
          onerror() { resolve(null); },
          ontimeout() { resolve(null); },
        });
      });
      if (res && res.ok) {
        btn.textContent = "🔗 Привязать";
        btn.disabled = false;
        btn.dataset.mode = "link";
        btn.classList.remove("dh-btn-danger");
        if (statusEl) statusEl.textContent = "";
        showToast("✓ Telegram отвязан, данные удалены");
      } else {
        btn.textContent = "Отвязать";
        btn.disabled = false;
        showToast("Ошибка отвязки", true);
      }
    } catch {
      btn.textContent = "Отвязать";
      btn.disabled = false;
      showToast("Ошибка отвязки", true);
    }
  }

  /** Поллинг статуса привязки Telegram. */
  function pollLinkStatus(duoId, btn, statusEl, attempts) {
    attempts = attempts || 0;
    if (attempts > 60) {
      if (btn) { btn.textContent = "Привязать Telegram"; btn.disabled = false; }
      if (statusEl) statusEl.textContent = "Время ожидания истекло";
      return;
    }
    setTimeout(async () => {
      try {
        const res = await new Promise((resolve) => {
          GM_xmlhttpRequest({
            method: "GET",
            url: BOT_API + "/api/link-status?duolingoUserId=" + encodeURIComponent(duoId),
            timeout: 10000,
            onload(r) { try { resolve(JSON.parse(r.responseText || "{}")); } catch { resolve(null); } },
            onerror() { resolve(null); },
            ontimeout() { resolve(null); },
          });
        });
        if (res && res.linked) {
          if (btn) {
            btn.textContent = "Отвязать";
            btn.disabled = false;
            btn.dataset.mode = "unlink";
            btn.classList.add("dh-btn-danger");
          }
          if (statusEl) statusEl.textContent = "Telegram привязан: @" + (res.tgUsername || "telegram") + (res.tgUserId ? " · id: " + res.tgUserId : "");
          showToast("✓ Telegram привязан");
          return;
        }
      } catch {}
      pollLinkStatus(duoId, btn, statusEl, attempts + 1);
    }, 3000);
  }

  /** Дашборд аккаунтов: карточки с информацией и удалением. */
  function renderDashboard() {
    const box = shadow && shadow.querySelector("#dh-acc-dashboard");
    if (!box) return;
    const store = DATA._store || { accounts: {} };
    const accounts = store.accounts || {};
    const curId = DATA._accountId || currentAccountId();
    const ids = Object.keys(accounts).filter((k) => k !== "anon");
    box.innerHTML = "";
    if (!ids.length) {
      box.innerHTML = '<div class="dh-muted">Нет аккаунтов</div>';
      return;
    }
    for (const id of ids) {
      const a = accounts[id];
      const label = a.label || "";
      const name = label || (a.me && a.me.username) || a.username || "—";
      const displayName = (a.me && a.me.name) || "";
      const isCur = id === curId;
      const updated = a.updatedAt ? fmtTime(a.updatedAt) : "—";
      const hasJwt = !!a.jwt;
      // цветовая полоса: зелёная = активен (JWT есть и обновлён недавно), жёлтая = есть JWT но давно, красная = нет JWT
      const age = a.updatedAt ? (Date.now() - a.updatedAt) / 86400000 : 999;
      const statusColor = !hasJwt ? "#c0392b" : age < 7 ? "#58CC02" : age < 30 ? "#f39c12" : "#c0392b";
      const statusText = !hasJwt ? "Нет JWT" : age < 7 ? "Активен" : age < 30 ? "Давно не заходил" : "Неактивен";

      const card = document.createElement("div");
      card.className = "dh-shop-card";
      card.style.height = "auto";
      card.style.padding = "0";
      card.style.alignItems = "flex-start";
      card.style.textAlign = "left";
      card.style.flexDirection = "column";
      card.style.overflow = "hidden";
      card.innerHTML = `
        <div style="width:100%;height:3px;background:${statusColor};flex-shrink:0"></div>
        <div style="width:100%;padding:10px;display:flex;flex-direction:column;gap:6px">
          <div style="display:flex;align-items:center;gap:8px;width:100%">
            <div style="width:34px;height:34px;border-radius:50%;background:${isCur ? "#58CC02" : "#888"};color:#fff;display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0">
              ${name.charAt(0).toUpperCase()}
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-size:12px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${name}${isCur ? " ✓" : ""}</div>
              ${displayName && displayName !== name ? `<div style="font-size:10px;opacity:0.6">${displayName}</div>` : ""}
            </div>
            ${isCur ? "" : `<button class="dh-btn dh-btn-danger" data-del="${id}" style="padding:3px 8px;font-size:10px;flex-shrink:0">✕</button>`}
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;width:100%">
            <div style="flex:1;min-width:55px;background:rgba(128,128,128,0.08);border-radius:6px;padding:4px 6px">
              <div style="font-size:9px;opacity:0.6">🔥 Streak</div>
              <div style="font-size:13px;font-weight:700" data-streak="${id}">…</div>
            </div>
            <div style="flex:1;min-width:55px;background:rgba(128,128,128,0.08);border-radius:6px;padding:4px 6px">
              <div style="font-size:9px;opacity:0.6">⚡ XP</div>
              <div style="font-size:13px;font-weight:700" data-xp="${id}">…</div>
            </div>
            <div style="flex:1;min-width:55px;background:rgba(128,128,128,0.08);border-radius:6px;padding:4px 6px">
              <div style="font-size:9px;opacity:0.6">📅 Обновлён</div>
              <div style="font-size:10px;font-weight:600">${updated}</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;width:100%;flex-wrap:wrap">
            <div style="font-size:9px;opacity:0.6;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">ID: ${id} · JWT: ${hasJwt ? "✓" : "✗"} · ${statusText}</div>
            <button class="dh-btn" data-open="${id}" style="padding:3px 8px;font-size:10px;flex-shrink:0" title="Открыть профиль Duolingo">👤</button>
            <button class="dh-btn" data-rename="${id}" style="padding:3px 8px;font-size:10px;flex-shrink:0" title="Переименовать">✏</button>
            <button class="dh-btn" data-export="${id}" style="padding:3px 8px;font-size:10px;flex-shrink:0" title="Статистика (HTML)">📥</button>
            <button class="dh-btn" data-refresh="${id}" style="padding:3px 8px;font-size:10px;flex-shrink:0" title="Обновить данные">🔄</button>
          </div>
        </div>`;
      box.appendChild(card);
      // подгрузка streak / XP
      loadAccountStats(id, card);
      // кнопки
      card.querySelector("[data-open]")?.addEventListener("click", () => {
        window.open("https://www.duolingo.com/profile/" + name, "_blank");
      });
      card.querySelector("[data-rename]")?.addEventListener("click", async () => {
        const newLabel = await showPromptPrompt("Ярлык аккаунта", a.label || name);
        if (newLabel === null) return;
        const store2 = DATA._store || {};
        if (!store2.accounts[id]) return;
        store2.accounts[id].label = newLabel.trim() || undefined;
        GM_setValue(STORAGE_KEY, JSON.stringify(store2));
        renderAccounts();
        showToast("Ярлык обновлён");
      });
      card.querySelector("[data-refresh]")?.addEventListener("click", (e) => {
        e.target.textContent = "…";
        loadAccountStats(id, card, true);
      });
      card.querySelector("[data-export]")?.addEventListener("click", async (e) => {
        e.target.textContent = "…";
        await exportVocabHtml(id, name);
        e.target.textContent = "📥";
      });
      const delBtn = card.querySelector("[data-del]");
      if (delBtn) {
        delBtn.addEventListener("click", async () => {
          const ok = await showConfirm(
            `Удалить аккаунт ${name} (${id})?\nДанные и JWT будут стёрты.`,
            "Удаление аккаунта",
          );
          if (!ok) return;
          delete store.accounts[id];
          DATA._store = store;
          GM_setValue(STORAGE_KEY, JSON.stringify(store));
          renderAccounts();
          showToast("Аккаунт удалён");
        });
      }
    }
  }

  /** Загружает streak / XP аккаунта в карточку дашборда. */
  async function loadAccountStats(id, card, force) {
    const streakEl = card.querySelector(`[data-streak="${id}"]`);
    const xpEl = card.querySelector(`[data-xp="${id}"]`);
    try {
      const res = await new Promise((resolve) => {
        GM_xmlhttpRequest({
          method: "GET",
          url: `https://www.duolingo.com/2017-06-30/users/${id}?fields=streak,totalXp`,
          headers: { accept: "application/json" },
          timeout: 10000,
          onload(r) {
            try { resolve(JSON.parse(r.responseText || "{}")); } catch { resolve(null); }
          },
          onerror() { resolve(null); },
          ontimeout() { resolve(null); },
        });
      });
      if (!res) throw new Error("no data");
      const streak = res.streak ?? (res.body && res.body.streak) ?? "—";
      const xp = res.totalXp ?? (res.body && res.body.totalXp) ?? "—";
      if (streakEl) streakEl.textContent = streak;
      if (xpEl) xpEl.textContent = typeof xp === "number" ? xp.toLocaleString("ru") : xp;
    } catch {
      if (streakEl) streakEl.textContent = "—";
      if (xpEl) xpEl.textContent = "—";
    }
  }

  /** HTML-экспорт словаря и прогресса аккаунта. */
  /** HTML-экспорт статистики и прогресса аккаунта. */
  async function exportVocabHtml(accId, accName) {
    showToast("Загрузка данных…");
    const fetchJson = (url) => new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "GET", url,
        headers: { accept: "application/json" },
        timeout: 15000,
        onload(r) { try { resolve(JSON.parse(r.responseText || "{}")); } catch { resolve(null); } },
        onerror() { resolve(null); },
        ontimeout() { resolve(null); },
      });
    });
    const d = await fetchJson("https://www.duolingo.com/2017-06-30/users/" + accId + "?fields=totalXp,streak,name,username") || {};
    const totalXp = d.totalXp ?? 0;
    const streak = d.streak ?? 0;
    const displayName = d.name || accName || "";
    const username = d.username || "";
    const today = new Date().toLocaleDateString("ru", { day: "numeric", month: "long", year: "numeric" });

    const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Duolingo — Статистика · ${displayName}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Segoe UI',system-ui,sans-serif; background:#F3F3F3; color:#1A1A1A; }
  .page { max-width:700px; margin:0 auto; padding:32px 20px 60px; }
  .header { text-align:center; margin-bottom:32px; }
  .header h1 { font-size:28px; font-weight:800; color:#58CC02; margin-bottom:4px; }
  .header .sub { font-size:14px; color:#888; }
  .section { background:#fff; border-radius:12px; padding:24px; margin-bottom:20px; box-shadow:0 1px 4px rgba(0,0,0,0.06); }
  .section h2 { font-size:18px; font-weight:700; margin-bottom:16px; }
  .stats-grid { display:flex; gap:12px; }
  .stat-box { flex:1; background:#F8F8F8; border-radius:10px; padding:20px 16px; text-align:center; }
  .stat-box .value { font-size:32px; font-weight:800; color:#58CC02; }
  .stat-box .label { font-size:12px; color:#888; margin-top:6px; }
  .footer { text-align:center; font-size:11px; color:#AAA; margin-top:32px; }
  .save-btn { display:inline-block; margin:24px auto 0; padding:12px 32px; background:#58CC02; color:#fff; border:none; border-radius:10px; font-size:15px; font-weight:700; cursor:pointer; }
  .save-btn:hover { background:#4CAF00; }
  .print-btn { display:inline-block; margin:24px auto 0 8px; padding:12px 32px; background:#E5E5E5; color:#333; border:none; border-radius:10px; font-size:15px; font-weight:700; cursor:pointer; }
  .print-btn:hover { background:#D0D0D0; }
  .center { text-align:center; }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <h1>🦉 Duolingo — Статистика</h1>
    <div class="sub">${displayName}${username ? " · @" + username : ""} · ${today}</div>
  </div>
  <div class="section">
    <h2>📊 Общая статистика</h2>
    <div class="stats-grid">
      <div class="stat-box">
        <div class="value">${Number(totalXp).toLocaleString("ru")}</div>
        <div class="label">⚡ Всего XP</div>
      </div>
      <div class="stat-box">
        <div class="value">🔥 ${streak}</div>
        <div class="label">Серия дней</div>
      </div>
    </div>
  </div>
  <div class="center">
    <button class="save-btn" onclick="savePage()">💾 Сохранить страницу</button>
    <button class="print-btn" onclick="window.print()">🖨 Печать</button>
  </div>
  <div class="footer">
    Создано Duolingo Helper · Лицензия CC BY-NC-ND 4.0
  </div>
</div>
<script>
function savePage() {
  var blob = new Blob(['<!DOCTYPE html>\\n' + document.documentElement.outerHTML], { type: 'text/html' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'duolingo-stats-${(username || accName || "export").replace(/[^a-zA-Z0-9_-]/g, "")}-${new Date().toISOString().slice(0, 10)}.html';
  a.click();
  setTimeout(function() { URL.revokeObjectURL(a.href); }, 1000);
}
</script>
</body>
</html>`;

    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    showToast("✓ Статистика открыта в новой вкладке");
  }

  /** Переключение на другой аккаунт (JWT swap + reload). */
  async function switchToAccount(id) {
    const store = DATA._store || {};
    const acc = (store.accounts || {})[id];
    if (!acc) { showToast("Аккаунт не найден", true); return; }
    if (!acc.jwt) {
      showToast("Нет JWT для этого аккаунта — войди заново", true);
      return;
    }
    const ok = await showConfirm(
      `Переключиться на ${((acc.me && acc.me.username) || acc.username || id)}?`,
      "Смена аккаунта",
    );
    if (!ok) return;
    saveToSlot(DATA._accountId || currentAccountId());
    // подменяем JWT cookie
    try {
      document.cookie = "jwt_token=" + encodeURIComponent(acc.jwt) + "; path=/; domain=.duolingo.com; max-age=31536000; secure; samesite=none";
      localStorage.setItem("jwt_token", acc.jwt);
    } catch {}
    showToast("Переключение…");
    location.reload();
  }

  var uiReady = false;

  function refreshUiForAccount() {
    if (!uiReady) return;
    try {
      applyTheme();
      applyWinPos();
      applyFabPos();
      syncPageFlags();
      if (typeof syncSwitches === "function") syncSwitches();
      if (typeof syncHeartsFlag === "function") syncHeartsFlag();
      if (typeof syncLessonFlags === "function") syncLessonFlags();
      if (typeof updateChangesBadge === "function") updateChangesBadge();
      if (typeof updateListBadges === "function") updateListBadges();
      if (typeof updateTagsBadge === "function") updateTagsBadge();
      if (typeof renderFriends === "function" && els.friendsList) {
        renderFriends();
      }
      if (typeof renderAccounts === "function") renderAccounts();
      if (typeof renderStats === "function") renderStats();
      if (typeof collectStats === "function") collectStats();
      if (typeof loadPrivacyStatus === "function") loadPrivacyStatus();
      if (typeof updateCloudBlock === "function") updateCloudBlock();
    } catch (e) {
      console.warn("[DuoHelper] refreshUiForAccount", e);
    }
  }

  /** Синхронизирует page-context флаги (localStorage) с настройками аккаунта. */
  function syncPageFlags() {
    try {
      const s = DATA.settings || {};
      localStorage.setItem("dh_protect_hearts", s.protectHearts ? "true" : "false");
      localStorage.setItem("dh_lesson_short", s.lessonShortener ? "true" : "false");
      localStorage.setItem("dh_stories_short", s.storiesShortener ? "true" : "false");
      localStorage.setItem("dh_free_super", s.freeSuper ? "true" : "false");
      localStorage.setItem("dh_lesson_solver", s.autoSolver ? "true" : "false");
      localStorage.setItem("dh_fake_xpboost", s.fakeXpBoost ? "true" : "false");
      localStorage.setItem("dh_xpboost_mins", String(s.xpBoostMins || 15));
    } catch {}
    if (els.setFreeSuper) els.setFreeSuper.classList.toggle("on", !!DATA.settings.freeSuper);
  }
  let friendFilter = "all";

  function setFriendsStatus(t, onClear) {
    if (!els.friendsStatus) return;
    if (!onClear) {
      els.friendsStatus.textContent = t;
      els.friendsStatus.style.cssText = "";
      return;
    }
    els.friendsStatus.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px";
    els.friendsStatus.innerHTML =
      `<span>${t}</span><button class="dh-btn dh-btn-ghost" id="dh-clear-list" style="padding:2px 8px;font-size:10px;text-decoration:underline;background:none;border:none;cursor:pointer;color:inherit;opacity:0.7">Очистить</button>`;
    const btn = els.friendsStatus.querySelector("#dh-clear-list");
    if (btn) btn.addEventListener("click", onClear);
  }

  function openUserProfile(username, userId) {
    const u = username || "";
    if (u) {
      window.open(
        "https://www.duolingo.com/profile/" + encodeURIComponent(u),
        "_blank",
      );
    }
  }

  function wireProfileRow(row, user) {
    row.style.cursor = "pointer";
    row.addEventListener("click", (e) => {
      if (e.target && e.target.closest && e.target.closest("button")) return;
      openUserProfile(user && user.username, user && user.userId);
    });
  }

  async function unfollowUser(targetId) {
    const myId = getMyId();
    if (!myId || !targetId) return false;
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "DELETE",
        url: `https://www.duolingo.com/2017-06-30/friends/users/${myId}/follow/${targetId}`,
        headers: {
          accept: "application/json",
          authorization: "Bearer " + (getToken() || ""),
        },
        timeout: 15000,
        onload(resp) {
          resolve(resp.status === 200 || resp.status === 201 || resp.status === 204);
        },
        onerror() {
          resolve(false);
        },
        ontimeout() {
          resolve(false);
        },
      });
    });
  }

  async function followUser(targetId) {
    const myId = getMyId();
    if (!myId || !targetId) return false;
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: `https://www.duolingo.com/2017-06-30/friends/users/${myId}/follow/${targetId}`,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: "Bearer " + (getToken() || ""),
        },
        data: JSON.stringify({ component: "profile_header_button" }),
        timeout: 15000,
        onload(resp) {
          resolve(resp.status === 200 || resp.status === 201);
        },
        onerror() {
          resolve(false);
        },
        ontimeout() {
          resolve(false);
        },
      });
    });
  }

  function logAction(entry) {
    const item = {
      id: "a" + Date.now() + "_" + Math.floor(Math.random() * 1000),
      ts: Date.now(),
      undone: false,
      ...entry,
    };
    DATA.actionLog = DATA.actionLog || [];
    DATA.actionLog.unshift(item);
    // держим последние 200
    if (DATA.actionLog.length > 200) DATA.actionLog.length = 200;
    saveData();
    return item;
  }

  /** Действия, сделанные ботом, — в историю, чтобы работал откат (Вернуть). */
  function mergeBotActions(list) {
    if (!Array.isArray(list) || !list.length) return;
    DATA.actionLog = DATA.actionLog || [];
    let changed = false;
    for (const p of list) {
      if (!p || !p.type || !Array.isArray(p.ids)) continue;
      // дедуп по ts: одно действие приходит один раз
      if (DATA.actionLog.some((a) => a.ts === p.ts && a.type === p.type)) continue;
      DATA.actionLog.unshift({
        id: "b" + p.ts,
        ts: p.ts,
        undone: false,
        type: p.type,
        ids: p.ids,
        name: p.name || "",
        via: "bot",
      });
      changed = true;
    }
    if (changed) {
      if (DATA.actionLog.length > 200) DATA.actionLog.length = 200;
      saveData();
      if (typeof renderHistory === "function") renderHistory();
    }
  }

  /** Единая запись в «Изменения» с дедупом: одно событие — одна строка за сутки. */
  function addChangeEntry(entry) {
    DATA.friendChanges = DATA.friendChanges || [];
    const ts = entry.ts || Date.now();
    const dup = DATA.friendChanges.some(
      (c) =>
        c.kind === entry.kind &&
        String(c.userId) === String(entry.userId) &&
        Math.abs((c.ts || 0) - ts) < 24 * 60 * 60 * 1000,
    );
    if (dup) return false;
    DATA.friendChanges.unshift({ ...entry, ts, seen: false });
    if (DATA.friendChanges.length > 300) DATA.friendChanges.length = 300;
    DATA.friendChangesUnread = (DATA.friendChangesUnread || 0) + 1;
    return true;
  }

  /** События подписок, замеченные ботом, — в «Изменения» (с дедупом). */
  function mergeBotChanges(list) {
    if (!Array.isArray(list) || !list.length) return;
    let changed = false;
    for (const p of list) {
      if (!p || !p.kind || !p.userId) continue;
      const ok = addChangeEntry({
        ts: p.ts || Date.now(),
        kind: p.kind,
        dir: p.kind === "unfollowed_me" ? "minus" : "plus",
        userId: String(p.userId),
        username: p.username || "",
        name: p.name || p.username || String(p.userId),
        via: "bot",
      });
      if (ok) changed = true;
    }
    if (changed) {
      saveData();
      if (typeof renderChanges === "function") renderChanges();
    }
  }

  function isExcluded(userId) {
    const id = String(userId);
    return (DATA.excludeList || []).some((x) => String(x.userId) === id);
  }

  function addExclude(user) {
    DATA.excludeList = DATA.excludeList || [];
    const id = String(user.userId);
    if (!isExcluded(id)) {
      DATA.excludeList.unshift({
        userId: id,
        username: user.username || "",
        name: user.name || user.username || id,
        ts: Date.now(),
      });
      saveData();
    }
  }

  function removeExclude(userId) {
    const id = String(userId);
    DATA.excludeList = (DATA.excludeList || []).filter(
      (x) => String(x.userId) !== id,
    );
    saveData();
  }

  function getTag(userId) {
    if (!userId) return null;
    const t = (DATA.userTags || {})[String(userId)];
    return t && !t.deleted ? t : null;
  }

  function findTagByUser(userId, username) {
    const byId = getTag(userId);
    if (byId && !byId.deleted) return byId;
    const uname = String(username || "").toLowerCase().replace(/^@/, "");
    if (!uname) return null;
    const tags = DATA.userTags || {};
    for (const key of Object.keys(tags)) {
      const t = tags[key];
      if (
        t &&
        !t.deleted &&
        t.username &&
        String(t.username).toLowerCase().replace(/^@/, "") === uname
      ) {
        return t;
      }
    }
    return null;
  }

  function setTag(userId, patch) {
    if (!userId) return;
    DATA.userTags = DATA.userTags || {};
    const id = String(userId);
    const prev = DATA.userTags[id] || {};
    const now = Date.now();
    const next = { ...prev, ...patch, updatedAt: now };
    if (!next.label && !next.note) {
      // tombstone — помечаем удалённым, чтобы мерж не воскресил тег
      next.deleted = true;
      next.deletedAt = now;
      DATA.userTags[id] = next;
    } else {
      delete next.deleted;
      delete next.deletedAt;
      DATA.userTags[id] = next;
    }
    saveData();
    if (els.tagsBadge) updateTagsBadge();
  }

  /** Сохраняет метку по userId (или username), не плодя дубликаты ключей. */
  function upsertTag(user, patch) {
    if (!user) return;
    DATA.userTags = DATA.userTags || {};
    const uid = user.userId ? String(user.userId) : "";
    const uname = String(user.username || "").toLowerCase().replace(/^@/, "");
    // ищем существующий ключ
    let key = uid;
    if (!getTag(key) && uname) {
      const keys = Object.keys(DATA.userTags);
      for (const k of keys) {
        const t = DATA.userTags[k];
        if (
          (uid && String(k) === uid) ||
          (t &&
            t.username &&
            String(t.username).toLowerCase().replace(/^@/, "") === uname)
        ) {
          key = k;
          break;
        }
      }
    }
    if (!key) key = uname || uid;
    setTag(key, {
      ...patch,
      username: user.username || (getTag(key) && getTag(key).username) || uname,
      name: user.name || (getTag(key) && getTag(key).name) || uname,
    });
    // удаляем дубль по username, если он отличается от key
    if (uname && uname !== key && DATA.userTags[uname] && uid) {
      delete DATA.userTags[uname];
      saveData();
    }
  }

  function tagListUsers() {
    // строим индекс username -> displayName из кешей
    const nameMap = {};
    try {
      const rows = (friendsCache && friendsCache.rows) || [];
      for (const r of rows) {
        const un = (r.username || "").toLowerCase();
        const dn = r.displayName || r.name || "";
        if (un && dn && dn.toLowerCase() !== un) nameMap[un] = dn;
      }
    } catch {}
    // также из followCache (theirName)
    try {
      const fc = DATA.followCache || {};
      for (const key of Object.keys(fc)) {
        const entry = fc[key];
        if (entry && entry.theirName) {
          const un = key.toLowerCase();
          const dn = entry.theirName;
          if (un && dn && dn.toLowerCase() !== un && !nameMap[un]) nameMap[un] = dn;
        }
      }
    } catch {}
    return Object.entries(DATA.userTags || {}).filter(([, t]) => !t.deleted).map(([userId, t]) => {
      const uname = t.username || "";
      // если name совпадает с username — ищем реальное имя в кеше
      let name = t.name || uname || userId;
      if (uname && name.toLowerCase().replace(/^@/, "") === uname.toLowerCase().replace(/^@/, "")) {
        const real = nameMap[uname.toLowerCase().replace(/^@/, "")];
        if (real) name = real;
      }
      return {
        userId,
        username: uname,
        name,
        label: t.label || "",
        color: t.color || "#58cc02",
        note: t.note || "",
      };
    });
  }

  function updateTagsBadge() {
    if (!els.tagsBadge) return;
    const n = Object.values(DATA.userTags || {}).filter((t) => !t.deleted).length;
    if (n > 0) {
      els.tagsBadge.style.display = "inline";
      els.tagsBadge.textContent = "(" + (n > 99 ? "99+" : n) + ")";
    } else {
      els.tagsBadge.style.display = "none";
      els.tagsBadge.textContent = "";
    }
  }

  function isBlocked(userId) {
    const id = String(userId);
    return (DATA.blockList || []).some((x) => String(x.userId) === id);
  }

  function addBlock(user) {
    DATA.blockList = DATA.blockList || [];
    const id = String(user.userId);
    if (!isBlocked(id)) {
      DATA.blockList.unshift({
        userId: id,
        username: user.username || "",
        name: user.name || user.username || id,
        ts: Date.now(),
      });
      saveData();
    }
  }

  function removeBlock(userId) {
    const id = String(userId);
    DATA.blockList = (DATA.blockList || []).filter(
      (x) => String(x.userId) !== id,
    );
    saveData();
  }

  function updateListBadges() {
    if (els.excludeBadge) {
      const n = (DATA.excludeList || []).length;
      if (n > 0) {
        els.excludeBadge.style.display = "inline";
        els.excludeBadge.textContent = "(" + (n > 99 ? "99+" : n) + ")";
      } else {
        els.excludeBadge.style.display = "none";
        els.excludeBadge.textContent = "";
      }
    }
    if (els.blocksBadge) {
      const n = (DATA.blockList || []).length;
      if (n > 0) {
        els.blocksBadge.style.display = "inline";
        els.blocksBadge.textContent = "(" + (n > 99 ? "99+" : n) + ")";
      } else {
        els.blocksBadge.style.display = "none";
        els.blocksBadge.textContent = "";
      }
    }
  }

  function renderExclusions() {
    if (!els.excludeList) return;
    const list = DATA.excludeList || [];
    els.excludeList.innerHTML = "";
    updateListBadges();
    if (!list.length) {
      els.excludeList.innerHTML = '<div class="dh-muted">Исключений нет</div>';
      setFriendsStatus("Исключений: 0");
      return;
    }
    for (const u of list) {
      const row = document.createElement("div");
      row.className = "dh-setting-row";
      row.style.borderBottom = "none";
      row.style.padding = "5px 2px";
      row.innerHTML = `<div class="dh-setting-label" style="min-width:0">
          <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            🛡 ${u.name || u.username || u.userId}
          </div>
          <small>${u.username ? "@" + u.username : ""}</small>
        </div>`;
      wireProfileRow(row, u);
      const b = document.createElement("button");
      b.className = "dh-btn";
      b.style.cssText = "padding:4px 8px;font-size:11px;flex-shrink:0";
      b.textContent = "Убрать";
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        removeExclude(u.userId);
        renderExclusions();
        showToast("Убран из исключений");
      });
      row.appendChild(b);
      els.excludeList.appendChild(row);
    }
    setFriendsStatus("Исключений: " + list.length);
  }

  function renderBlockList() {
    if (!els.blocksList) return;
    const list = DATA.blockList || [];
    els.blocksList.innerHTML = "";
    updateListBadges();
    if (!list.length) {
      els.blocksList.innerHTML = '<div class="dh-muted">Блок-лист пуст</div>';
      setFriendsStatus("Заблокировано: 0");
      return;
    }
    for (const u of list) {
      const row = document.createElement("div");
      row.className = "dh-setting-row";
      row.style.borderBottom = "none";
      row.style.padding = "5px 2px";
      row.innerHTML = `<div class="dh-setting-label" style="min-width:0">
          <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            🚫 ${u.name || u.username || u.userId}
          </div>
          <small>${u.username ? "@" + u.username : ""} · ${fmtTime(u.ts)}</small>
        </div>`;
      wireProfileRow(row, u);
      const b = document.createElement("button");
      b.className = "dh-btn";
      b.style.cssText = "padding:4px 8px;font-size:11px;flex-shrink:0";
      b.textContent = "Разблокировать";
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        b.disabled = true;
        b.textContent = "…";
        const ok = await unblockUser(u.userId);
        if (ok) {
          removeBlock(u.userId);
          renderBlockList();
          showToast("Разблокирован " + (u.name || u.username || u.userId));
        } else {
          b.disabled = false;
          b.textContent = "Разблокировать";
          showToast("Не удалось разблокировать", true);
        }
      });
      row.appendChild(b);
      els.blocksList.appendChild(row);
    }
    setFriendsStatus("Заблокировано: " + list.length);
  }

  function hideFriendsSubViews() {
    if (els.friendsList) els.friendsList.style.display = "none";
    if (els.historyList) els.historyList.style.display = "none";
    if (els.changesList) els.changesList.style.display = "none";
    if (els.excludeList) els.excludeList.style.display = "none";
    if (els.blocksList) els.blocksList.style.display = "none";
    if (els.friendsFiltersWrap) els.friendsFiltersWrap.style.display = "none";
    if (els.historyOpen) els.historyOpen.style.display = "none";
    if (els.changesOpen) els.changesOpen.style.display = "none";
    if (els.excludeOpen) els.excludeOpen.style.display = "none";
    if (els.blocksOpen) els.blocksOpen.style.display = "none";
    if (els.inactiveTools) els.inactiveTools.style.display = "none";
    if (els.nobodyTools) els.nobodyTools.style.display = "none";
    if (els.allTools) els.allTools.style.display = "none";
    if (els.activitySort) els.activitySort.style.display = "none";
    if (els.historyBack) els.historyBack.style.display = "";
    updateListBadges();
  }

  function showExcludeView() {
    hideFriendsSubViews();
    if (els.excludeList) els.excludeList.style.display = "flex";
    renderExclusions();
  }

  function showBlocksView() {
    hideFriendsSubViews();
    if (els.blocksList) els.blocksList.style.display = "flex";
    renderBlockList();
  }

  function renderHistory() {
    if (!els.historyList) return;
    const log = DATA.actionLog || [];
    els.historyList.innerHTML = "";
    if (!log.length) {
      els.historyList.innerHTML =
        '<div class="dh-muted">История пуста</div>';
      return;
    }
    for (const item of log) {
      const row = document.createElement("div");
      row.className = "dh-setting-row";
      row.style.borderBottom = "none";
      row.style.padding = "5px 2px";
      const when = fmtTime(item.ts);
      const massLabel = (fallback) =>
        item.name
          ? item.name.charAt(0).toUpperCase() + item.name.slice(1)
          : `${fallback} (${(item.ids || []).length})`;
      const label =
        item.type === "unfollow_mass"
          ? massLabel("Отписка от неподписанных") + " ❌"
          : item.type === "block_mass"
            ? massLabel("Блокировка неактивных")
            : item.type === "unfollow"
              ? "Отписка от " + (item.name || item.userId)
              : item.type === "block"
                ? "Блокировка " + (item.name || item.userId)
                : item.type || "действие";
      row.innerHTML = `<div class="dh-setting-label" style="min-width:0">
          <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            ${item.undone ? "↩ " : ""}${label}
          </div>
          <small>${when}</small>
        </div>`;
      if (item.userId || item.username) {
        wireProfileRow(row, item);
      }
      if (!item.undone) {
        const b = document.createElement("button");
        b.className = "dh-btn";
        b.style.cssText = "padding:4px 8px;font-size:11px;flex-shrink:0";
        b.textContent = "Вернуть";
        b.addEventListener("click", async (e) => {
          e.stopPropagation();
          b.disabled = true;
          b.textContent = "…";
          const ok = await undoAction(item);
          if (ok) {
            showToast("Возвращено");
            renderHistory();
          } else {
            b.disabled = false;
            b.textContent = "Вернуть";
            showToast("Не удалось вернуть", true);
          }
        });
        row.appendChild(b);
      }
      els.historyList.appendChild(row);
    }
  }

  async function undoAction(item) {
    try {
      if (item.type === "unfollow") {
        const ok = await followUser(item.userId);
        if (!ok) return false;
        item.undone = true;
        saveData();
        return true;
      }
      if (item.type === "block") {
        const ok = await unblockUser(item.userId);
        if (!ok) return false;
        removeBlock(item.userId);
        item.undone = true;
        saveData();
        return true;
      }
      if (item.type === "unfollow_mass") {
        let ok = 0;
        for (const id of item.ids || []) {
          if (await followUser(id)) ok++;
          await new Promise((r) => setTimeout(r, 250));
        }
        item.undone = true;
        saveData();
        return ok > 0;
      }
      if (item.type === "block_mass") {
        let ok = 0;
        for (const id of item.ids || []) {
          if (await unblockUser(id)) {
            ok++;
            removeBlock(id);
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        item.undone = true;
        saveData();
        return ok > 0;
      }
    } catch {}
    return false;
  }

  function showFriendsView() {
    if (els.friendsList) els.friendsList.style.display = "flex";
    if (els.historyList) els.historyList.style.display = "none";
    if (els.changesList) els.changesList.style.display = "none";
    if (els.excludeList) els.excludeList.style.display = "none";
    if (els.blocksList) els.blocksList.style.display = "none";
    if (els.friendsFiltersWrap) els.friendsFiltersWrap.style.display = "flex";
    if (els.historyOpen) els.historyOpen.style.display = "";
    if (els.changesOpen) els.changesOpen.style.display = "";
    if (els.excludeOpen) els.excludeOpen.style.display = "";
    if (els.blocksOpen) els.blocksOpen.style.display = "";
    if (els.historyBack) els.historyBack.style.display = "none";
    if (els.inactiveTools) {
      els.inactiveTools.style.display =
        friendFilter === "activity" ? "flex" : "none";
    }
    if (els.inactiveMass) {
      els.inactiveMass.style.display =
        friendFilter === "activity" ? "flex" : "none";
    }
    if (els.nobodyTools) {
      els.nobodyTools.style.display = friendFilter === "nobody" ? "flex" : "none";
    }
    if (els.allTools) {
      els.allTools.style.display = friendFilter === "all" ? "flex" : "none";
    }
    if (els.activitySort) {
      els.activitySort.style.display = friendFilter === "activity" ? "flex" : "none";
    if (friendFilter === "activity") syncActivitySortState();
    }
    updateListBadges();
    renderFriends();
  }

  function showHistoryView() {
    if (els.friendsList) els.friendsList.style.display = "none";
    if (els.historyList) els.historyList.style.display = "flex";
    if (els.changesList) els.changesList.style.display = "none";
    if (els.excludeList) els.excludeList.style.display = "none";
    if (els.blocksList) els.blocksList.style.display = "none";
    if (els.friendsFiltersWrap) els.friendsFiltersWrap.style.display = "none";
    if (els.historyOpen) els.historyOpen.style.display = "none";
    if (els.changesOpen) els.changesOpen.style.display = "none";
    if (els.excludeOpen) els.excludeOpen.style.display = "none";
    if (els.blocksOpen) els.blocksOpen.style.display = "none";
    if (els.inactiveTools) els.inactiveTools.style.display = "none";
    if (els.nobodyTools) els.nobodyTools.style.display = "none";
    if (els.allTools) els.allTools.style.display = "none";
    if (els.activitySort) els.activitySort.style.display = "none";
    if (els.historyBack) els.historyBack.style.display = "";
    updateListBadges();
    renderHistory();
    setFriendsStatus("История действий", async () => {
      const ok = await showConfirm("Очистить всю историю действий?", "История");
      if (!ok) return;
      DATA.actionLog = [];
      saveData();
      renderHistory();
      showToast("История очищена");
    });
  }

  function updateChangesBadge() {
    if (!els.changesBadge) return;
    const n = DATA.friendChangesUnread || 0;
    if (n > 0) {
      els.changesBadge.style.display = "inline-block";
      els.changesBadge.textContent = n > 99 ? "99+" : String(n);
    } else {
      els.changesBadge.style.display = "none";
      els.changesBadge.textContent = "";
    }
  }

  function renderChanges() {
    if (!els.changesList) return;
    const changes = DATA.friendChanges || [];
    els.changesList.innerHTML = "";
    if (!changes.length) {
      els.changesList.innerHTML =
        '<div class="dh-muted">Изменений пока нет — обнови список друзей ещё раз, чтобы появилось сравнение</div>';
      return;
    }
    for (const c of changes) {
      const row = document.createElement("div");
      row.className = "dh-setting-row" + (c.seen ? "" : " dh-change-new");
      row.style.borderBottom = "none";
      row.style.padding = "5px 2px";
      const sign = c.dir === "plus" ? "+" : "−";
      const label =
        c.kind === "unfollowed_me"
          ? "отписался от тебя"
          : c.kind === "followed_me"
            ? "подписался на тебя"
            : c.kind === "i_unfollowed"
              ? "ты отписался"
              : c.kind === "i_blocked"
                ? "ты заблокировал"
                : c.kind === "i_followed"
                  ? "ты подписался"
                  : c.kind === "renamed_user"
                    ? `username: ${c.from || "?"} → ${c.to || "?"}`
                    : c.kind === "renamed_name"
                      ? `имя: ${c.from || "?"} → ${c.to || "?"}`
                      : c.kind || "";
      row.innerHTML = `<div class="dh-setting-label" style="min-width:0">
          <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            ${sign} ${c.name || c.username || c.userId} · ${label}
          </div>
          <small>${fmtTime(c.ts)}</small>
        </div>`;
      row.style.cursor = "pointer";
      // наведение — снять «новизну» строки
      row.addEventListener("mouseenter", () => {
        if (!c.seen) {
          c.seen = true;
          row.classList.remove("dh-change-new");
          saveData();
        }
      });
      row.addEventListener("click", () => {
        const u = c.username || c.name;
        if (u) {
          window.open(
            "https://www.duolingo.com/profile/" + encodeURIComponent(u),
            "_blank",
          );
        }
      });
      els.changesList.appendChild(row);
    }
    setFriendsStatus("Изменений: " + changes.length, async () => {
      const ok = await showConfirm("Очистить все изменения?", "Изменения");
      if (!ok) return;
      DATA.friendChanges = [];
      DATA.friendChangesUnread = 0;
      saveData();
      renderChanges();
      updateChangesBadge();
      showToast("Изменения очищены");
    });
  }

  function showChangesView() {
    if (els.friendsList) els.friendsList.style.display = "none";
    if (els.historyList) els.historyList.style.display = "none";
    if (els.changesList) els.changesList.style.display = "flex";
    if (els.excludeList) els.excludeList.style.display = "none";
    if (els.blocksList) els.blocksList.style.display = "none";
    if (els.friendsFiltersWrap) els.friendsFiltersWrap.style.display = "none";
    if (els.historyOpen) els.historyOpen.style.display = "none";
    if (els.changesOpen) els.changesOpen.style.display = "none";
    if (els.excludeOpen) els.excludeOpen.style.display = "none";
    if (els.blocksOpen) els.blocksOpen.style.display = "none";
    if (els.inactiveTools) els.inactiveTools.style.display = "none";
    if (els.nobodyTools) els.nobodyTools.style.display = "none";
    if (els.allTools) els.allTools.style.display = "none";
    if (els.activitySort) els.activitySort.style.display = "none";
    if (els.historyBack) els.historyBack.style.display = "";
    // счётчик гасим по клику
    DATA.friendChangesUnread = 0;
    saveData();
    updateChangesBadge();
    renderChanges();
  }

  /** Сравнивает снапшоты и пишет изменения. */
  function diffFriendSnapshots(following, followers) {
    // защита: не сравниваем, если данные могли быть от другого аккаунта
    if (DATA._accountId && DATA._accountId !== currentAccountId()) return;
    const now = Date.now();
    DATA.friendSnapshots = DATA.friendSnapshots || [];
    DATA.friendChanges = DATA.friendChanges || [];

    const prev = DATA.friendSnapshots[DATA.friendSnapshots.length - 1];
    const prevFollowing = new Set(((prev && prev.following) || []).map(String));
    const prevFollowers = new Set(((prev && prev.followers) || []).map(String));
    const curFollowing = new Map(following.map((u) => [String(u.userId), u]));
    const curFollowers = new Map(followers.map((u) => [String(u.userId), u]));

    const myUnfollowIds = new Set(
      (DATA.actionLog || [])
        .filter((a) => a.type === "unfollow" && a.userId)
        .map((a) => String(a.userId)),
    );
    const myBlockIds = new Set(
      (DATA.actionLog || [])
        .filter((a) => a.type === "block" && a.userId)
        .map((a) => String(a.userId)),
    );
    (DATA.actionLog || [])
      .filter((a) => a.type === "block_mass" && a.ids)
      .forEach((a) => a.ids.forEach((id) => myBlockIds.add(String(id))));
    (DATA.blockList || []).forEach((b) => myBlockIds.add(String(b.userId)));

    const add = (kind, dir, id, meta, extra) => {
      addChangeEntry({
        ts: now,
        kind,
        dir,
        userId: id,
        username: (meta && meta.username) || (extra && extra.username) || "",
        name: (meta && (meta.displayName || meta.name || meta.username)) || id,
        ...(extra || {}),
      });
    };

    const metaOf = (map, id) => map && map[id] ? map[id] : null;
    const userNameOf = (m) =>
      (m && (m.username || m.displayName || m.name)) || "";

    if (prev) {
      // 1) кто-то отписался от меня (только если это НЕ моя блокировка/отписка)
      for (const id of prevFollowers) {
        if (curFollowers.has(id)) continue;
        if (myBlockIds.has(id) || myUnfollowIds.has(id)) continue;
        const meta = metaOf(prev.followersMeta, id);
        add("unfollowed_me", "minus", id, meta);
      }
      // подписался на меня
      for (const [id, u] of curFollowers) {
        if (!prevFollowers.has(id)) add("followed_me", "plus", id, u);
      }
      // 2) исчез из моих подписок — классифицируем по действиям
      for (const id of prevFollowing) {
        if (curFollowing.has(id)) continue;
        const meta = metaOf(prev.followingMeta, id);
        if (myBlockIds.has(id)) {
          add("i_blocked", "minus", id, meta);
        } else if (myUnfollowIds.has(id)) {
          add("i_unfollowed", "minus", id, meta);
        } else if (!prevFollowers.has(id)) {
          // не был подписан на меня — явно я убрал из подписок
          add("i_unfollowed", "minus", id, meta);
        }
        // если был подписчиком и уже помечен как unfollowed_me выше — не дублируем
      }
      // я подписался
      for (const [id, u] of curFollowing) {
        if (!prevFollowing.has(id)) add("i_followed", "plus", id, u);
      }

      // 3) смена имени / username (id тот же)
      const checkRename = (prevMetaMap, curMap) => {
        for (const [id, u] of curMap) {
          const pm = metaOf(prevMetaMap, id);
          if (!pm) continue;
          const prevUser = pm.username || "";
          const curUser = u.username || "";
          const prevName = pm.displayName || pm.name || "";
          const curName = u.displayName || u.name || "";
          if (prevUser && curUser && prevUser.toLowerCase() !== curUser.toLowerCase()) {
            add("renamed_user", "edit", id, {
              username: curUser,
              displayName: curName || curUser,
            }, {
              from: prevUser,
              to: curUser,
              fromName: prevName,
              toName: curName,
            });
          } else if (
            prevName &&
            curName &&
            prevName !== curName &&
            (!prevUser || !curUser || prevUser.toLowerCase() === curUser.toLowerCase())
          ) {
            add("renamed_name", "edit", id, {
              username: curUser,
              displayName: curName,
            }, {
              from: prevName,
              to: curName,
              fromName: prevName,
              toName: curName,
            });
          }
        }
      };
      checkRename(prev.followingMeta, curFollowing);
      checkRename(prev.followersMeta, curFollowers);
    }

    if (DATA.friendChanges.length > 300) DATA.friendChanges.length = 300;

    DATA.friendSnapshots.push({
      ts: now,
      following: [...curFollowing.keys()],
      followers: [...curFollowers.keys()],
      followingMeta: Object.fromEntries(
        [...curFollowing.entries()].map(([id, u]) => [
          id,
          {
            username: u.username || "",
            displayName: u.displayName || u.name || "",
          },
        ]),
      ),
      followersMeta: Object.fromEntries(
        [...curFollowers.entries()].map(([id, u]) => [
          id,
          {
            username: u.username || "",
            displayName: u.displayName || u.name || "",
          },
        ]),
      ),
    });
    if (DATA.friendSnapshots.length > 10) DATA.friendSnapshots.shift();
    saveData();
  }

  async function massUnfollowNonFollowers() {
    const rows = (friendsCache && friendsCache.rows) || [];
    const targets = rows.filter((r) => !r.followsMe && !isExcluded(r.userId));
    if (!targets.length) {
      showToast("Нет «неподписанных» в списке");
      return;
    }
    const okGo = await showConfirm(
      `Отписаться от ${targets.length} пользователей, которые не подписаны на вас?`,
      "Отписка от неподписанных",
    );
    if (!okGo) return;

    const ids = [];
    let ok = 0;
    for (let i = 0; i < targets.length; i++) {
      setFriendsStatus(`Отписка ${i + 1}/${targets.length}…`);
      const success = await unfollowUser(targets[i].userId);
      if (success) {
        ok++;
        ids.push(targets[i].userId);
      }
      await new Promise((r) => setTimeout(r, 300 + Math.floor(Math.random() * 250)));
    }
    logAction({
      type: "unfollow_mass",
      ids,
      name: `отписка от ${ok} неподписанных`,
    });
    if (friendsCache) {
      const idSet = new Set(ids.map(String));
      friendsCache.rows = friendsCache.rows.filter((r) => !idSet.has(String(r.userId)));
    }
    renderFriends();
    setFriendsStatus(`Отписался от ${ok} / ${targets.length}`);
    showToast("✓ Отписка завершена: " + ok);
  }

  /** Отписка от всех подписок (кроме исключений). Двойное подтверждение. */
  async function massUnfollowAnyone() {
    const rows = (friendsCache && friendsCache.rows) || [];
    const targets = rows.filter((r) => !isExcluded(r.userId));
    if (!targets.length) {
      showToast("Нет подписок для отписки");
      return;
    }
    const okGo = await showConfirm(
      `Отписаться от ${targets.length} пользователей? Исключения (🛡) не тронем.`,
      "Отписка от всех",
    );
    if (!okGo) return;
    const okGo2 = await showConfirm(
      `Точно отписаться от ${targets.length} человек? Это действие нельзя отменить одной кнопкой (undo есть в «Истории»).`,
      "Подтверждение",
    );
    if (!okGo2) return;

    const delay = Math.max(0, DATA.settings.requestDelay || 350);
    const ids = [];
    let ok = 0;
    for (let i = 0; i < targets.length; i++) {
      setFriendsStatus(`Отписка от всех ${i + 1}/${targets.length}…`);
      const success = await unfollowUser(targets[i].userId);
      if (success) {
        ok++;
        ids.push(targets[i].userId);
      }
      if (delay) await new Promise((r) => setTimeout(r, delay));
    }
    logAction({
      type: "unfollow_mass",
      ids,
      name: `отписка от ${ok} пользователей`,
    });
    if (friendsCache) {
      const idSet = new Set(ids.map(String));
      friendsCache.rows = friendsCache.rows.filter((r) => !idSet.has(String(r.userId)));
    }
    renderFriends();
    setFriendsStatus(`Отписался от всех: ${ok} / ${targets.length}`);
    showToast("✓ Отписка завершена: " + ok);
  }

  /** Отписка от неактивных среди моих подписок (не подписчиков). */
  async function massUnfollowInactive() {
    const rows = (friendsCache && friendsCache.rows) || [];
    const daysLimit = DATA.settings.inactiveDays || 7;
    const targets = rows.filter(
      (r) =>
        (r.inactive === true || (r.inactiveDays || 0) >= daysLimit) &&
        !isExcluded(r.userId),
    );
    if (!targets.length) {
      showToast("Сначала проверь активность");
      return;
    }
    const okGo = await showConfirm(
      `Отписаться от ${targets.length} неактивных подписок (порог ${daysLimit} дн.)?`,
      "Отписка от неактивных",
    );
    if (!okGo) return;

    const delay = Math.max(0, DATA.settings.requestDelay || 350);
    const ids = [];
    let ok = 0;
    for (let i = 0; i < targets.length; i++) {
      setFriendsStatus(`Отписка от неактивных ${i + 1}/${targets.length}…`);
      const success = await unfollowUser(targets[i].userId);
      if (success) {
        ok++;
        ids.push(targets[i].userId);
      }
      if (delay) await new Promise((r) => setTimeout(r, delay));
    }
    logAction({
      type: "unfollow_mass",
      ids,
      name: `отписка от ${ok} неактивных`,
    });
    if (friendsCache) {
      const idSet = new Set(ids.map(String));
      friendsCache.rows = friendsCache.rows.filter((r) => !idSet.has(String(r.userId)));
      if (friendsCache.scanUsers) {
        friendsCache.scanUsers = friendsCache.scanUsers.map((u) =>
          idSet.has(String(u.userId)) ? { ...u, iFollow: false } : u,
        );
      }
    }
    renderFriends();
    setFriendsStatus(`Отписался от неактивных: ${ok} / ${targets.length}`);
    showToast("✓ Отписка от неактивных: " + ok);
  }

  async function blockUser(targetId) {
    const myId = getMyId();
    if (!myId || !targetId) return false;
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: `https://www.duolingo.com/2017-06-30/friends/users/${myId}/block/${targetId}`,
        headers: {
          accept: "application/json",
          authorization: "Bearer " + (getToken() || ""),
        },
        timeout: 15000,
        onload(resp) {
          resolve(resp.status === 200 || resp.status === 201);
        },
        onerror() {
          resolve(false);
        },
        ontimeout() {
          resolve(false);
        },
      });
    });
  }

  async function unblockUser(targetId) {
    const myId = getMyId();
    if (!myId || !targetId) return false;
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "DELETE",
        url: `https://www.duolingo.com/2017-06-30/friends/users/${myId}/block/${targetId}`,
        headers: {
          accept: "application/json",
          authorization: "Bearer " + (getToken() || ""),
        },
        timeout: 15000,
        onload(resp) {
          resolve(resp.status === 200 || resp.status === 201 || resp.status === 204);
        },
        onerror() {
          resolve(false);
        },
        ontimeout() {
          resolve(false);
        },
      });
    });
  }

  async function massBlockInactive() {
    const rows = (friendsCache && friendsCache.rows) || [];
    const daysLimit = DATA.settings.inactiveDays || 7;
    const targets = rows.filter(
      (r) =>
        (r.inactive === true || (r.inactiveDays || 0) >= daysLimit) &&
        !isExcluded(r.userId),
    );
    if (!targets.length) {
      showToast("Сначала проверь активность");
      return;
    }
    const okGo = await showConfirm(
      `Заблокировать ${targets.length} неактивных подписок (порог ${daysLimit} дн.)?`,
      "Блокировка неактивных",
    );
    if (!okGo) return;

    const delay = Math.max(0, DATA.settings.requestDelay || 350);
    const ids = [];
    let ok = 0;
    for (let i = 0; i < targets.length; i++) {
      setFriendsStatus(`Блокировка ${i + 1}/${targets.length}…`);
      const success = await blockUser(targets[i].userId);
      if (success) {
        ok++;
        ids.push(targets[i].userId);
      }
      if (delay) await new Promise((r) => setTimeout(r, delay));
    }
    logAction({
      type: "block_mass",
      ids,
      name: `блокировка ${ok} неактивных`,
    });
    for (const t of targets) {
      if (ids.map(String).includes(String(t.userId))) addBlock(t);
    }
    if (friendsCache) {
      const idSet = new Set(ids.map(String));
      friendsCache.rows = friendsCache.rows.filter((r) => !idSet.has(String(r.userId)));
    }
    renderFriends();
    setFriendsStatus(`Заблокировано: ${ok} / ${targets.length}`);
    showToast("✓ Блокировка: " + ok);
  }

  function friendsCountLabel(shown) {
    const cache = friendsCache || {};
    const following = cache.followingCount != null ? cache.followingCount : (cache.rows || []).length;
    const followers = cache.followersCount != null ? cache.followersCount : 0;
    if (friendFilter === "inactive") {
      const base = (cache.scanUsers || []).length || following + followers;
      return `Показано: ${shown} · проверяется: ${base} (подписки ∪ подписчики)`;
    }
    return `Показано: ${shown} · всего: ${following} подписок`;
  }

  function sortActivityRows(rows) {
    const mode = DATA.settings.activitySort || "xp_desc";
    const out = rows.slice();
    const nameOf = (r) => (r.name || r.username || "").toLowerCase();
    if (mode === "xp_desc") {
      out.sort((a, b) => Number(b.lastXp || 0) - Number(a.lastXp || 0));
    } else if (mode === "xp_asc") {
      out.sort((a, b) => Number(a.lastXp || 0) - Number(b.lastXp || 0));
    } else if (mode === "streak_desc") {
      out.sort((a, b) => Number(b.streakDays || 0) - Number(a.streakDays || 0));
    } else if (mode === "streak_asc") {
      out.sort((a, b) => Number(a.streakDays || 0) - Number(b.streakDays || 0));
    } else if (mode === "name_asc") {
      out.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    } else if (mode === "name_desc") {
      out.sort((a, b) => nameOf(b).localeCompare(nameOf(a)));
    }
    return out;
  }

  function renderFriends() {
    if (!els.friendsList) return;
    const q = (els.friendsSearch && els.friendsSearch.value || "")
      .trim()
      .toLowerCase();
    let rows = (friendsCache && friendsCache.rows) || [];

    if (friendFilter === "mutual") rows = rows.filter((r) => r.followsMe);
    if (friendFilter === "nobody") rows = rows.filter((r) => !r.followsMe);
    if (friendFilter === "activity") {
      // все, кого проверяли (rows + scanUsers)
      const seen = new Set();
      const all = [];
      for (const r of (friendsCache && friendsCache.rows) || []) {
        seen.add(String(r.userId));
        all.push(r);
      }
      for (const u of (friendsCache && friendsCache.scanUsers) || []) {
        if (!seen.has(String(u.userId))) all.push(u);
      }
      rows = all;
      if (els.inactiveTools) els.inactiveTools.style.display = "flex";
      if (els.inactiveMass) els.inactiveMass.style.display = "flex";
      if (els.activitySort) {
        els.activitySort.style.display = "flex";
        syncActivitySortState();
      }
    } else {
      if (els.inactiveTools) els.inactiveTools.style.display = "none";
      if (els.inactiveMass) els.inactiveMass.style.display = "none";
      if (els.activitySort) els.activitySort.style.display = "none";
    }
    if (els.nobodyTools) {
      els.nobodyTools.style.display = friendFilter === "nobody" ? "flex" : "none";
    }
    if (els.allTools) {
      els.allTools.style.display = friendFilter === "all" ? "flex" : "none";
    }
    if (q) {
      rows = rows.filter((r) => {
        return (
          (r.name || "").toLowerCase().includes(q) ||
          (r.username || "").toLowerCase().includes(q)
        );
      });
    }

    if (friendFilter === "activity") {
      rows = sortActivityRows(rows);
    }

    els.friendsList.innerHTML = "";
    if (!rows.length) {
      els.friendsList.innerHTML = '<div class="dh-muted">Пусто</div>';
      setFriendsStatus(friendsCountLabel(0));
      return;
    }

    for (const r of rows) {
      const row = document.createElement("div");
      row.className = "dh-setting-row";
      row.style.borderBottom = "none";
      row.style.padding = "5px 2px";
      row.style.cursor = "pointer";
      const sub = r.username ? "@" + r.username : String(r.userId || "");

      if (friendFilter === "activity") {
        const streak = Number(r.streakDays || 0);
        const xp = Number(r.lastXp || 0);
        const idle = Number(r.inactiveDays || 0);
        const streakTxt = streak > 0 ? `🔥 ${streak} дн.` : "💤 0";
        const idleTxt = idle > 0 && idle < 999 ? `${idle} дн.` : idle >= 999 ? "∞" : "0 дн.";
        row.innerHTML = `<div class="dh-setting-label" style="min-width:0">
            <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              ${r.name || sub}
            </div>
            <small>${streakTxt} · XP ${xp} · без активности ${idleTxt}</small>
          </div>`;
        row.addEventListener("click", () => {
          const u = r.username || r.name;
          if (u) window.open("https://www.duolingo.com/profile/" + encodeURIComponent(u), "_blank");
        });
        els.friendsList.appendChild(row);
        continue;
      }

      const icon = r.followsMe ? "✅" : "❌";
      const deadIcon = r.inactive ? " · 💤" : "";
      const excludedIcon = isExcluded(r.userId) ? " · 🛡" : "";
      const tagInfo = findTagByUser(r.userId, r.username);
      const tagIcon =
        tagInfo && tagInfo.label
          ? ` · <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${tagInfo.color || "#58cc02"};margin:0 2px"></span>`
          : "";
      row.innerHTML = `<div class="dh-setting-label" style="min-width:0">
          <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            ${icon} ${r.name || sub}${tagIcon}${deadIcon}${excludedIcon}
          </div>
          <small>${sub}</small>
        </div>
        <button class="dh-btn" data-tag-edit="1" title="Метка" style="padding:4px 7px;font-size:11px;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center">✏</button>
        <button class="dh-btn" data-exclude="1" title="${isExcluded(r.userId) ? "Убрать из исключений" : "В исключения (не трогать при массовых действиях)"}" style="padding:4px 7px;font-size:11px;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center">${isExcluded(r.userId) ? "🛡✓" : "🛡"}</button>
        <button class="dh-btn" data-block="1" title="Заблокировать" style="padding:4px 8px;font-size:13px;line-height:1;flex-shrink:0;width:30px;display:inline-flex;align-items:center;justify-content:center">🚫</button>
        <button class="dh-btn" data-unfollow="1" title="Отписаться" style="padding:4px 8px;font-size:13px;line-height:1;flex-shrink:0;width:30px;display:inline-flex;align-items:center;justify-content:center">×</button>`;
      row.addEventListener("click", (e) => {
        if (e.target && e.target.closest && e.target.closest("[data-unfollow],[data-exclude],[data-block],[data-tag-edit]")) return;
        const u = r.username || r.name;
        if (u) window.open("https://www.duolingo.com/profile/" + encodeURIComponent(u), "_blank");
      });
      const tagBtn = row.querySelector("[data-tag-edit]");
      if (tagBtn) {
        tagBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          showTagEditor(r);
        });
      }
      const unBtn = row.querySelector("[data-unfollow]");
      if (unBtn) {
        unBtn.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          unBtn.disabled = true;
          unBtn.textContent = "…";
          const ok = await unfollowUser(r.userId);
          if (ok) {
            logAction({
              type: "unfollow",
              userId: r.userId,
              name: r.name || sub,
              username: r.username || "",
            });
            // после одиночной отписки убираем из исключений
            removeExclude(r.userId);
            showToast("Отписался от " + (r.name || sub));
            if (friendsCache) {
              friendsCache.rows = friendsCache.rows.filter((x) => String(x.userId) !== String(r.userId));
            }
            renderFriends();
          } else {
            unBtn.disabled = false;
            unBtn.textContent = "×";
            showToast("Не удалось отписаться", true);
          }
        });
      }
      const blBtn = row.querySelector("[data-block]");
      if (blBtn) {
        blBtn.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const okGo = await showConfirm(
            `Заблокировать ${r.name || sub}?`,
            "Блокировка",
          );
          if (!okGo) return;
          blBtn.disabled = true;
          blBtn.textContent = "…";
          const ok = await blockUser(r.userId);
          if (ok) {
            logAction({
              type: "block",
              userId: r.userId,
              name: r.name || sub,
              username: r.username || "",
            });
            addBlock(r);
            removeExclude(r.userId);
            showToast("Заблокирован " + (r.name || sub));
            if (friendsCache) {
              friendsCache.rows = friendsCache.rows.filter((x) => String(x.userId) !== String(r.userId));
            }
            renderFriends();
          } else {
            blBtn.disabled = false;
            blBtn.textContent = "🚫";
            showToast("Не удалось заблокировать", true);
          }
        });
      }
      const exBtn = row.querySelector("[data-exclude]");
      if (exBtn) {
        exBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (isExcluded(r.userId)) {
            removeExclude(r.userId);
            showToast("Убран из исключений");
          } else {
            addExclude(r);
            showToast("В исключениях");
          }
          renderFriends();
        });
      }
      els.friendsList.appendChild(row);
    }
    setFriendsStatus(friendsCountLabel(rows.length));
  }

  async function loadFriends() {
    const btn = els.friendsLoad;
    if (btn) btn.disabled = true;
    setFriendsStatus("Загрузка друзей…");
    try {
      const me = await getMe();
      if (!me || !me.id) throw new Error("Не выполнен вход");

      const [following, followers] = await Promise.all([
        fetchUserList(me.id, "following"),
        fetchUserList(me.id, "followers"),
      ]);

      const followersSet = new Map();
      for (const f of followers) {
        followersSet.set(String(f.userId), f);
      }

      const rows = following.map((u) => {
        const hit = followersSet.get(String(u.userId));
        return {
          userId: String(u.userId),
          name: u.displayName || u.username || u.userId,
          username: u.username || (hit && hit.username) || "",
          followsMe: !!hit,
        };
      });

      // сортировка: сначала не подписаны, потом взаимные
      rows.sort((a, b) => {
        if (a.followsMe !== b.followsMe) return a.followsMe ? 1 : -1;
        return String(a.name).localeCompare(String(b.name));
      });

      const rowIds = new Set(rows.map((r) => String(r.userId)));
      const scanUsers = rows.map((r) => ({ ...r })).concat(
        followers
          .filter((f) => !rowIds.has(String(f.userId)))
          .map((f) => ({
            userId: String(f.userId),
            name: f.displayName || f.username || f.userId,
            username: f.username || "",
            followsMe: true,
            iFollow: false,
          })),
      );

      friendsCache = {
        rows,
        scanUsers,
        followingCount: following.length,
        followersCount: followers.length,
        scannedAt: null,
      };
      syncUnfollowInactiveButton();
      // синхронизируем аккаунт перед diff, чтобы не смешать снапшоты
      try { switchAccount(currentAccountId()); } catch {}
      diffFriendSnapshots(following, followers);
      updateChangesBadge();
      renderFriends();
    } catch (e) {
      setFriendsStatus("Ошибка: " + (e && e.message));
      showToast("Не удалось загрузить друзей", true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  let scanRunning = false;

  function syncUnfollowInactiveButton() {
    const scanned = !!(friendsCache && friendsCache.scannedAt);
    const tip = scanned
      ? ""
      : "Кнопка заработает после полной проверки активности";
    if (els.unfollowInactive) {
      els.unfollowInactive.disabled = !scanned;
      els.unfollowInactive.title = tip;
    }
    if (els.blockInactive) {
      els.blockInactive.disabled = !scanned;
      els.blockInactive.title = tip;
    }
    syncActivitySortState();
  }

  function syncActivitySortState() {
    if (!els.activitySort) return;
    const scanned = !!(friendsCache && friendsCache.scannedAt);
    els.activitySort.style.opacity = scanned ? "1" : "0.45";
    els.activitySort.dataset.ready = scanned ? "1" : "0";
    els.activitySort.title = scanned
      ? ""
      : "Сортировка заработает после полной проверки активности";
  }

  /** Опрашивает друзей и помечает неактивных. */
  async function scanFriendActivity() {
    const cache = friendsCache;
    const targets = (cache && (cache.scanUsers || cache.rows)) || [];
    if (!targets.length) {
      showToast("Сначала обнови список друзей");
      return;
    }
    if (scanRunning) return;
    scanRunning = true;
    const btn = els.scanActivity;
    if (btn) btn.disabled = true;
    const delay = Math.max(0, DATA.settings.requestDelay || 350);
    const daysLimit = DATA.settings.inactiveDays || 7;
    let scanned = 0;

    setFriendsStatus(`Проверка активности 0/${targets.length}…`);
    for (const r of targets) {
      if (!scanRunning) break;
      try {
        const data = await apiGet(
          `${API.users}/${r.userId}?fields=totalXp,streak,streakData`,
        );
        const streakData = data && data.streakData;
        const cur = streakData && streakData.currentStreak;
        const daysLimit = DATA.settings.inactiveDays || 7;

        // дата последней активности
        let activityTs = NaN;
        if (cur) {
          const lastExt = cur.lastExtendedDate ? Date.parse(cur.lastExtendedDate) : NaN;
          const start = cur.startDate ? Date.parse(cur.startDate) : NaN;
          activityTs = Number.isFinite(lastExt) ? lastExt : start;
        }
        if (!Number.isFinite(activityTs) && streakData && streakData.previousStreak && streakData.previousStreak.endDate) {
          activityTs = Date.parse(streakData.previousStreak.endDate);
        }

        let inactive = false;
        let inactiveDays = 999;
        if (Number.isFinite(activityTs)) {
          inactiveDays = Math.floor((Date.now() - activityTs) / 86400000);
          inactive = inactiveDays >= daysLimit;
        } else {
          // нет даты активности — серия отсутствует
          inactive = !cur || !cur.startDate;
          inactiveDays = inactive ? 999 : 0;
        }

        r.inactive = inactive;
        r.inactiveDays = inactiveDays;
        r.lastXp = data.totalXp != null ? Number(data.totalXp) : r.lastXp || 0;
        r.streakDays = data.streak != null ? Number(data.streak) : r.streakDays || 0;
        r.scannedAt = Date.now();
      } catch {
        // не помечаем при ошибке
      }
      scanned++;
      if (scanned % 5 === 0 || scanned === targets.length) {
        setFriendsStatus(`Проверка активности ${scanned}/${targets.length}…`);
      }
      if (delay) {
        await new Promise((res) => setTimeout(res, delay));
      }
    }

    if (friendsCache) {
      // синхронизируем флаги в rows по userId
      const byId = new Map(targets.map((t) => [String(t.userId), t]));
      friendsCache.rows = (friendsCache.rows || []).map((r) => {
        const t = byId.get(String(r.userId));
        return t
          ? {
              ...r,
              inactive: t.inactive,
              inactiveDays: t.inactiveDays,
              lastXp: t.lastXp,
              streakDays: t.streakDays,
              scannedAt: t.scannedAt,
            }
          : r;
      });
      friendsCache.scanUsers = targets;
      friendsCache.scannedAt = Date.now();
    }
    syncUnfollowInactiveButton();
    renderFriends();
    const dead = targets.filter((r) => r.inactive).length;
    setFriendsStatus(
      scanRunning
        ? `Проверено: ${targets.length} · неактивных: ${dead} (порог ${daysLimit} дн.)`
        : `Проверка остановлена на ${scanned}/${targets.length} · неактивных: ${dead}`,
    );
    showToast(scanRunning ? "✓ Активность проверена: " + dead + " неактивных" : "Проверка остановлена");
    scanRunning = false;
    if (btn) btn.disabled = false;
  }

  function stopActivityScan() {
    scanRunning = false;
    showToast("Проверка активности остановлена");
  }

  // ========== XP: фейк-буст + накрутка ==========
  // ⚠️ Читы, на свой страх и риск.
  let xpRunning = false;

  function setXpStatus(t) {
    if (els.xpStatus) els.xpStatus.textContent = t;
  }

  function syncXpBoostFlag() {
    const on = !!DATA.settings.fakeXpBoost;
    try {
      localStorage.setItem("dh_fake_xpboost", on ? "true" : "false");
      localStorage.setItem(
        "dh_xpboost_mins",
        String(DATA.settings.xpBoostMins || 15),
      );
    } catch {}
    if (els.setXpBoost) els.setXpBoost.classList.toggle("on", on);
    if (els.xpBoost15 && els.xpBoost60) {
      const m = DATA.settings.xpBoostMins || 15;
      els.xpBoost15.classList.toggle("dh-btn-primary", on && m === 15);
      els.xpBoost60.classList.toggle("dh-btn-primary", on && m === 60);
    }
    setXpStatus(
      on
        ? "фейк-буст: x2 · " + (DATA.settings.xpBoostMins || 15) + " мин"
        : "",
    );
  }

  // ========== Leaderboard: показать разрыв XP ==========
  function installLeaderboardGaps() {
    if (window.__dhLbGaps) return;
    window.__dhLbGaps = true;

    function injectGaps() {
      if (location.pathname.indexOf("/leaderboard") === -1) return;
      if (!window.__dhLbDebug) {
        window.__dhLbDebug = true;
      }
      // строки лидерборда: A._3kvGS с h=64, текст вида "N...Name...XP очков"
      var rows = document.querySelectorAll("a._3kvGS, a[class*='_3kvGS']");
      if (rows.length < 3) return;

      var entries = [];
      for (var i = 0; i < rows.length; i++) {
        var el = rows[i];
        var t = (el.textContent || "").replace(/\s+/g, " ").trim();
        // XP — число перед "очков"
        var xpM = t.match(/(\d[\d\s]*)\s*очк/);
        if (!xpM) continue;
        var xp = parseInt(xpM[1].replace(/\s/g, ""), 10);
        if (isNaN(xp)) continue;
        // «я» — класс MytTp
        var isMe = (el.className || "").indexOf("MytTp") !== -1;
        entries.push({ el: el, xp: xp, isMe: isMe });
      }

      if (entries.length < 2) return;

      var myXp = null;
      for (var j = 0; j < entries.length; j++) {
        if (entries[j].isMe) { myXp = entries[j].xp; break; }
      }
      if (myXp === null) return;

      // убираем старые
      var old = document.querySelectorAll(".dh-lb-gap");
      for (var b = 0; b < old.length; b++) old[b].remove();

      // вставляем бейджи
      for (var m = 0; m < entries.length; m++) {
        var e = entries[m];
        if (e.isMe) continue;
        var gap = e.xp - myXp;
        if (gap === 0) continue;
        var badge = document.createElement("span");
        badge.className = "dh-lb-gap";
        badge.textContent = (gap > 0 ? "+" : "") + gap.toLocaleString("ru");
        badge.style.cssText = "margin-left:8px;padding:1px 6px;border-radius:8px;font-size:11px;font-weight:700;white-space:nowrap;vertical-align:middle;pointer-events:none;" +
          (gap > 0
            ? "background:rgba(88,204,2,0.15);color:#1F7A1F;"
            : "background:rgba(192,57,43,0.12);color:#B02A1E;");
        e.el.appendChild(badge);
      }
    }

    var gapMs = Math.max(1, Math.min(60, (DATA.settings && DATA.settings.lbGapRefresh) || 2)) * 1000;
    setInterval(function() {
      try { injectGaps(); } catch (e) { console.warn("[DH-LB] error", e); }
    }, gapMs);
    setTimeout(injectGaps, 1000);
  }

  function installXpBoostHook() {
    if (document.getElementById("dh-xpboost-hook")) return;
    const s = document.createElement("script");
    s.id = "dh-xpboost-hook";
    s.textContent = `(function() {
      if (window.__dhXpBoostHooked) return;
      window.__dhXpBoostHooked = true;

      function active() {
        try { return localStorage.getItem('dh_fake_xpboost') === 'true'; } catch (e) { return false; }
      }
      function mins() {
        try { return parseInt(localStorage.getItem('dh_xpboost_mins') || '15', 10) || 15; } catch (e) { return 15; }
      }
      function isUserUrl(url) {
        return /\\/\\d{4}-\\d{2}-\\d{2}\\/users\\//.test(String(url)) ||
          /\\/2023-05-23\\/users\\//.test(String(url));
      }
      function modUser(text) {
        try {
          var d = JSON.parse(text);
          if (!active()) return text;
          var exp = Date.now() + mins() * 60 * 1000;
          d.hasPlus = d.hasPlus || true;
          d.shopItems = Object.assign({}, d.shopItems, {
            xp_boost_15: { itemName: 'xp_boost_15', expirationTime: exp, quantity: 1 },
            xp_boost_60: { itemName: 'xp_boost_60', expirationTime: exp, quantity: 1 },
            general_xp_boost: { itemName: 'general_xp_boost', expirationTime: exp, quantity: 1 },
            xp_boost_stackable: { itemName: 'xp_boost_stackable', expirationTime: exp, quantity: 1 }
          });
          if (!d.trackingProperties || typeof d.trackingProperties !== 'object') d.trackingProperties = {};
          d.trackingProperties.has_item_xp_boost_15 = true;
          d.trackingProperties.has_item_xp_boost_60 = true;
          d.trackingProperties.has_item_general_xp_boost = true;
          if (d.activeXpBoost == null) {
            d.activeXpBoost = { multiplier: 2, expirationTime: exp };
          }
          return JSON.stringify(d);
        } catch (e) { return text; }
      }
      function makeResponse(text, orig) {
        var hdrs = {};
        try {
          orig.headers.forEach(function(v, k) { hdrs[k] = v; });
        } catch (e) {}
        hdrs['content-type'] = 'application/json';
        return new Response(text, {
          status: orig.status,
          statusText: orig.statusText,
          headers: hdrs
        });
      }

      var origFetch = window.fetch;
      window.fetch = function(resource, options) {
        var url = resource instanceof Request ? resource.url : String(resource || '');
        var method = options && options.method ? String(options.method).toUpperCase() : 'GET';
        if (method === 'GET' && active() && isUserUrl(url) && url.indexOf('shop-items') === -1) {
          return origFetch.apply(this, arguments).then(function(r) {
            return r.clone().text().then(function(t) {
              return makeResponse(modUser(t), r);
            }).catch(function() { return r; });
          });
        }
        return origFetch.apply(this, arguments);
      };
      window.fetch.__dhXpBoost = true;

      var origOpen = XMLHttpRequest.prototype.open;
      var origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url) {
        this.__dhXpUser = String(method || '').toUpperCase() === 'GET' && isUserUrl(url) && String(url).indexOf('shop-items') === -1;
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function() {
        var xhr = this;
        if (xhr.__dhXpUser) {
          var origChange = xhr.onreadystatechange;
          xhr.onreadystatechange = function() {
            if (xhr.readyState === 4 && xhr.status >= 200 && xhr.status < 300 && active()) {
              try {
                var raw = modUser(xhr.responseText);
                Object.defineProperty(xhr, 'responseText', { writable: true, configurable: true, value: raw });
                Object.defineProperty(xhr, 'response', { writable: true, configurable: true, value: raw });
              } catch (e) {}
            }
            if (origChange) origChange.apply(this, arguments);
          };
        }
        return origSend.apply(this, arguments);
      };
    })();`;
    (document.documentElement || document.body).appendChild(s);
    s.remove();
    syncXpBoostFlag();
  }

  const STORY_SLUG = "fr-en-le-passeport";

  async function getMyTotalXp() {
    const myId = getMyId();
    if (!myId) return null;
    try {
      const u = await apiGet(`${API.users}/${myId}?fields=totalXp`);
      const v = Number(u && u.totalXp);
      return Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  }

  async function farmXp(mode) {
    if (xpRunning) return;
    const target = Math.max(1, Math.min(99999, parseInt(els.xpAmount && els.xpAmount.value, 10) || 500));
    xpRunning = true;
    if (els.xpStories) els.xpStories.disabled = true;
    if (els.xpSessions) els.xpSessions.disabled = true;
    setXpStatus(`Накрутка (${mode})… 0 / ${target}`);

    const langs = await getMeLanguages();
    const myId = getMyId();
    let earned = 0;
    let fails = 0;

    try {
      while (xpRunning && earned < target) {
        let got = 0;
        if (mode === "stories") {
          const res = await new Promise((resolve) => {
            GM_xmlhttpRequest({
              method: "POST",
              url: `https://stories.duolingo.com/api2/stories/${STORY_SLUG}/complete`,
              headers: {
                "Content-Type": "application/json",
                accept: "application/json",
                authorization: "Bearer " + (getToken() || ""),
              },
              data: JSON.stringify({
                awardXp: true,
                completedBonusChallenge: true,
                fromLanguage: langs.fromLanguage === "en" ? "fr" : langs.fromLanguage,
                learningLanguage: "en",
                hasXpBoost: true,
                illustrationFormat: "svg",
                isFeaturedStoryInPracticeHub: true,
                isLegendaryMode: true,
                isV2Redo: false,
              }),
              timeout: 20000,
              onload(r) {
                let body = null;
                try {
                  body = JSON.parse(r.responseText || "null");
                } catch {}
                resolve({ status: r.status, body });
              },
              onerror() {
                resolve({ status: 0, body: null });
              },
              ontimeout() {
                resolve({ status: 0, body: null });
              },
            });
          });
          if (res.status === 200) {
            got = Number((res.body && (res.body.awardedXp || res.body.xpGain)) || 499);
          }
        } else {
          // sessions: создать UNIT_TEST, закрыть с бонусами, проверить прирост XP
          const xpBefore = await getMyTotalXp();
          const sr = await sessionRequest("POST", "https://www.duolingo.com/2017-06-30/sessions", {
            challengeTypes: [],
            fromLanguage: langs.fromLanguage,
            learningLanguage: langs.learningLanguage,
            type: "UNIT_TEST",
            isFinalLevel: false,
            isV2: true,
            juicy: true,
            smartTipsVersion: 2,
          });
          if (sr.status === 200 && sr.body && sr.body.id) {
            const now = Math.floor(Date.now() / 1000);
            const ur = await sessionRequest(
              "PUT",
              `https://www.duolingo.com/2017-06-30/sessions/${sr.body.id}`,
              {
                id: sr.body.id,
                metadata: sr.body.metadata,
                type: "UNIT_TEST",
                fromLanguage: langs.fromLanguage,
                learningLanguage: langs.learningLanguage,
                challenges: [],
                adaptiveChallenges: [],
                sessionExperimentRecord: [],
                experiments_with_treatment_contexts: [],
                adaptiveInterleavedChallenges: [],
                sessionStartExperiments: [],
                trackingProperties: [],
                ttsAnnotations: [],
                heartsLeft: 5,
                startTime: now,
                enableBonusPoints: true,
                endTime: now + 60,
                failed: false,
                maxInLessonStreak: 9,
                shouldLearnThings: true,
                hasBoost: true,
                happyHourBonusXp: 10,
                pathLevelSpecifics: { unitIndex: 0 },
              },
            );
            if (ur.status === 200) {
              const b = ur.body || {};
              got = Number(
                b.awardedXp || b.xpGain || b.xp || b.totalXp || 0,
              );
              // если тело не дало XP — проверяем реальный баланс
              if (!got) {
                await new Promise((r) => setTimeout(r, 800));
                const xpAfter = await getMyTotalXp();
                if (xpBefore != null && xpAfter != null && xpAfter > xpBefore) {
                  got = xpAfter - xpBefore;
                }
              }
            }
          }
        }

        if (got > 0) {
          earned += got;
          fails = 0;
          setXpStatus(`+${earned} XP (цель ${target})`);
        } else {
          fails++;
          if (fails >= 5) {
            setXpStatus("Слишком много ошибок, стоп");
            break;
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        await new Promise((r) => setTimeout(r, 350 + Math.floor(Math.random() * 350)));
      }
      setXpStatus(earned ? `Готово: +${earned} XP` : "Ничего не начислено");
      showToast(earned ? "✓ +" + earned + " XP" : "XP не начислены", !earned);
    } catch (e) {
      setXpStatus("Ошибка: " + (e && e.message));
      showToast("Ошибка накрутки XP", true);
    } finally {
      xpRunning = false;
      if (els.xpStories) els.xpStories.disabled = false;
      if (els.xpSessions) els.xpSessions.disabled = false;
    }
  }

  function stopXpFarm() {
    xpRunning = false;
    showToast("Накрутка XP остановлена");
  }

  // ========== Confirm dialog ==========
  function showConfirm(message, title = "Подтверждение") {
    return new Promise((resolve) => {
      if (!shadow) {
        resolve(window.confirm(message));
        return;
      }
      const theme = DATA.settings.theme || "win95";
      const overlay = document.createElement("div");
      overlay.className = "dh-confirm-overlay dh-theme-" + theme;
      overlay.innerHTML = `
        <div class="dh-confirm-box">
          <div class="dh-confirm-title">${title}</div>
          <div class="dh-confirm-body"></div>
          <div class="dh-confirm-actions">
            <button class="dh-btn" data-cf="no">Отмена</button>
            <button class="dh-btn dh-btn-primary" data-cf="yes">Да</button>
          </div>
        </div>
      `;
      overlay.querySelector(".dh-confirm-body").textContent = message;
      const done = (val) => {
        overlay.remove();
        resolve(val);
      };
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) done(false);
      });
      overlay.querySelector('[data-cf="no"]').addEventListener("click", () => done(false));
      overlay.querySelector('[data-cf="yes"]').addEventListener("click", () => done(true));
      shadow.appendChild(overlay);
    });
  }

  function showAbout() {
    if (!shadow) return;
    const theme = DATA.settings.theme || "win95";
    const ver = (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || CURRENT_VERSION;
    const overlay = document.createElement("div");
    overlay.className = "dh-confirm-overlay dh-theme-" + theme;
    overlay.innerHTML = `
      <div class="dh-confirm-box" style="width:420px">
        <div class="dh-confirm-title">Справка</div>
        <div class="dh-confirm-body" style="max-height:55vh;overflow-y:auto;line-height:1.55">
          <p style="margin:0 0 10px">
            Userscript для Tampermonkey — расширение для Duolingo.
            Помогает следить за подписками, чистить друзей, держать серию
            и ускорять рутину в аккаунте.
          </p>
          <p style="margin:0 0 8px"><strong>Что умеет:</strong></p>
          <ul style="margin:0 0 10px;padding-left:18px">
            <li>Проверка взаимной подписки на профиле и в списке друзей</li>
            <li>Кто подписался / отписался, история действий с откатом</li>
            <li>Отписка, блокировка, исключения (🛡), блок-лист</li>
            <li>Неактивные друзья: streak, XP, массовые действия</li>
            <li>Защита сердец, короткие уроки, автосолвер</li>
            <li>Квесты, магазин, гемы, streak, лига, XP-буст</li>
            <li>Темы: Win95 / WinXP / Vista / Win11 / Material 3 / iOS Liquid Glass / MacOS / iOS old / Die my Darling</li>
          </ul>
          <p style="margin:0 0 10px">
            Часть механик (уроки, квесты, магазин, гемы, лига, XP)
            написана с нуля, вдохновившись проектом пользователя
            <strong>DuoHacker</strong>.
          </p>
          <p style="margin:0 0 10px">
            Идея меток на пользователей взята из
            <a href="https://github.com/Vidrimers/Universal-eblan-marker" target="_blank" rel="noopener"
               style="color:#58cc02;text-decoration:underline">💀 Universal Eblan Marker</a>.
          </p>
          <p style="margin:0;color:#888;font-size:11px">
            Массовые действия и читы — на свой страх и риск.
            JWT-токен никуда не отправляется.
          </p>
		  <p style="margin:0;color:#888;font-size:11px">
            Помните, что используя читерские функции, вы не выучите язык: они сделаны для развлечения!
          </p>
        </div>
        <div class="dh-confirm-actions">
          <button class="dh-btn dh-btn-primary" data-about="close">Понятно</button>
        </div>
      </div>
    `;
    const close = () => overlay.remove();
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('[data-about="close"]').addEventListener("click", close);
    shadow.appendChild(overlay);
  }

  function showLicense() {
    if (!shadow) return;
    const theme = DATA.settings.theme || "win95";
    const overlay = document.createElement("div");
    overlay.className = "dh-confirm-overlay dh-theme-" + theme;
    overlay.innerHTML = `
      <div class="dh-confirm-box" style="width:400px">
        <div class="dh-confirm-title">Лицензия</div>
        <div class="dh-confirm-body" style="line-height:1.55">
          <p style="margin:0 0 10px">
            <strong>CC BY-NC-ND 4.0</strong><br/>
            Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International
          </p>
          <div style="margin:0 0 10px;font-size:12px">
            <div style="margin:3px 0">✅ Использовать бесплатно</div>
            <div style="margin:3px 0">✅ Делиться с указанием автора</div>
            <div style="margin:3px 0">❌ Коммерческое использование</div>
            <div style="margin:3px 0">❌ Переделки и производные</div>
          </div>
          <p style="margin:0 0 10px;font-size:11px;color:#888">
            Для коммерческого использования свяжитесь с автором для получения лицензии.
          </p>
        </div>
        <div class="dh-confirm-actions">
          <button class="dh-btn" data-license="full">Полный текст</button>
          <button class="dh-btn dh-btn-primary" data-license="close">Понятно</button>
        </div>
      </div>`;
    shadow.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('[data-license="close"]').addEventListener("click", close);
    overlay.querySelector('[data-license="full"]').addEventListener("click", () => {
      window.open("https://github.com/Vidrimers/Duolingo-helper/blob/master/LICENSE", "_blank");
    });
  }

  function showTagEditor(user) {
    if (!shadow) return;
    const theme = DATA.settings.theme || "win95";
    const id = String(user.userId || "");
    const cur = findTagByUser(user.userId, user.username) || {};
    const saveKey = id || String(user.username || "").toLowerCase().replace(/^@/, "");
    const overlay = document.createElement("div");
    overlay.className = "dh-confirm-overlay dh-theme-" + theme;
    overlay.innerHTML = `
      <div class="dh-confirm-box" style="width:380px">
        <div class="dh-confirm-title">🏷 Метка</div>
        <div class="dh-confirm-body">
          <div class="dh-muted" style="margin-bottom:10px;font-size:11px">
            ${user.name || user.username || id}
          </div>
          <div style="margin-bottom:8px">
            <div style="font-size:10px;opacity:0.6;margin-bottom:3px">Текст</div>
            <input class="dh-input" data-tag="label" maxlength="40" style="width:100%" />
          </div>
          <div style="margin-bottom:8px">
            <div style="font-size:10px;opacity:0.6;margin-bottom:3px">Цвет</div>
            <input type="hidden" data-tag="color" value="#58CC02" />
            <div data-tag="palette" style="display:flex;flex-wrap:wrap;gap:5px">
              <button type="button" data-color="#58CC02" style="width:22px;height:22px;border-radius:50%;background:#58CC02;border:2px solid #fff;box-shadow:0 0 0 1.5px #58CC02;cursor:pointer;padding:0"></button>
              <button type="button" data-color="#1CB0F6" style="width:22px;height:22px;border-radius:50%;background:#1CB0F6;border:2px solid #fff;box-shadow:0 0 0 1.5px transparent;cursor:pointer;padding:0"></button>
              <button type="button" data-color="#CE82FF" style="width:22px;height:22px;border-radius:50%;background:#CE82FF;border:2px solid #fff;box-shadow:0 0 0 1.5px transparent;cursor:pointer;padding:0"></button>
              <button type="button" data-color="#FF4B4B" style="width:22px;height:22px;border-radius:50%;background:#FF4B4B;border:2px solid #fff;box-shadow:0 0 0 1.5px transparent;cursor:pointer;padding:0"></button>
              <button type="button" data-color="#FF9600" style="width:22px;height:22px;border-radius:50%;background:#FF9600;border:2px solid #fff;box-shadow:0 0 0 1.5px transparent;cursor:pointer;padding:0"></button>
              <button type="button" data-color="#FFC800" style="width:22px;height:22px;border-radius:50%;background:#FFC800;border:2px solid #fff;box-shadow:0 0 0 1.5px transparent;cursor:pointer;padding:0"></button>
              <button type="button" data-color="#FF6482" style="width:22px;height:22px;border-radius:50%;background:#FF6482;border:2px solid #fff;box-shadow:0 0 0 1.5px transparent;cursor:pointer;padding:0"></button>
              <button type="button" data-color="#00CCAA" style="width:22px;height:22px;border-radius:50%;background:#00CCAA;border:2px solid #fff;box-shadow:0 0 0 1.5px transparent;cursor:pointer;padding:0"></button>
              <button type="button" data-color="#0078D4" style="width:22px;height:22px;border-radius:50%;background:#0078D4;border:2px solid #fff;box-shadow:0 0 0 1.5px transparent;cursor:pointer;padding:0"></button>
              <button type="button" data-color="#8B5CF6" style="width:22px;height:22px;border-radius:50%;background:#8B5CF6;border:2px solid #fff;box-shadow:0 0 0 1.5px transparent;cursor:pointer;padding:0"></button>
              <button type="button" data-color="#6B7280" style="width:22px;height:22px;border-radius:50%;background:#6B7280;border:2px solid #fff;box-shadow:0 0 0 1.5px transparent;cursor:pointer;padding:0"></button>
              <button type="button" data-color="#1A1A1A" style="width:22px;height:22px;border-radius:50%;background:#1A1A1A;border:2px solid #fff;box-shadow:0 0 0 1.5px transparent;cursor:pointer;padding:0"></button>
            </div>
          </div>
          <div style="margin-bottom:4px">
            <div style="font-size:10px;opacity:0.6;margin-bottom:3px">Заметка</div>
            <input class="dh-input" data-tag="note" maxlength="120" style="width:100%" />
          </div>
        </div>
        <div class="dh-confirm-actions">
          <button class="dh-btn" data-tag="clear">Убрать</button>
          <button class="dh-btn" data-tag="cancel">Отмена</button>
          <button class="dh-btn dh-btn-primary" data-tag="save">Сохранить</button>
        </div>
      </div>
    `;
    const labelIn = overlay.querySelector('[data-tag="label"]');
    const colorIn = overlay.querySelector('[data-tag="color"]');
    const noteIn = overlay.querySelector('[data-tag="note"]');
    const paletteEl = overlay.querySelector('[data-tag="palette"]');
    labelIn.value = cur.label || "";
    colorIn.value = cur.color || "#58CC02";
    noteIn.value = cur.note || "";

    // синхронизация палитры
    function syncPal() {
      if (!paletteEl) return;
      paletteEl.querySelectorAll("[data-color]").forEach((s) => {
        const isActive = s.dataset.color === colorIn.value;
        s.style.boxShadow = isActive ? `0 0 0 1.5px ${colorIn.value}` : "0 0 0 1.5px transparent";
      });
    }
    syncPal();
    if (paletteEl) {
      paletteEl.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-color]");
        if (!btn) return;
        colorIn.value = btn.dataset.color;
        syncPal();
      });
    }

    const close = () => overlay.remove();
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('[data-tag="cancel"]').addEventListener("click", close);
    overlay.querySelector('[data-tag="clear"]').addEventListener("click", () => {
      upsertTag({ userId: user.userId, username: user.username, name: user.name }, { label: "", note: "", color: colorIn.value });
      close();
      renderFriends();
      if (els.tagsList && els.tagsList.style.display !== "none") renderTagsList();
      showToast("Метка убрана");
    });
    overlay.querySelector('[data-tag="save"]').addEventListener("click", () => {
      upsertTag({ userId: user.userId, username: user.username, name: user.name }, {
        label: labelIn.value.trim(),
        note: noteIn.value.trim(),
        color: colorIn.value,
      });
      close();
      renderFriends();
      if (els.tagsList && els.tagsList.style.display !== "none") renderTagsList();
      showToast("Метка сохранена");
    });
    shadow.appendChild(overlay);
  }

  function renderTagsList() {
    if (!els.tagsList) return;
    const list = tagListUsers();
    els.tagsList.innerHTML = "";
    updateTagsBadge();
    if (!list.length) {
      els.tagsList.innerHTML = '<div class="dh-muted">Меток пока нет</div>';
      return;
    }
    for (const u of list) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:flex-start;gap:8px;padding:8px;border-radius:8px;background:rgba(128,128,128,0.06);cursor:pointer;transition:background 0.15s";
      row.addEventListener("mouseenter", () => { row.style.background = "rgba(128,128,128,0.12)"; });
      row.addEventListener("mouseleave", () => { row.style.background = "rgba(128,128,128,0.06)"; });
      const swatch = u.color || "#58cc02";
      row.innerHTML = `
        <div style="width:28px;height:28px;border-radius:50%;background:${swatch};color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;margin-top:1px">
          ${(u.name || u.username || "?").charAt(0).toUpperCase()}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${u.name || "—"}${u.username ? ` · <span style="opacity:0.6;font-weight:400">@${u.username}</span>` : ""}</div>
          ${u.label ? `<div style="font-size:11px;margin-top:2px">${u.label}</div>` : ""}
          ${u.note ? `<div style="font-size:10px;opacity:0.6;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📝 ${u.note}</div>` : ""}
        </div>
        <div style="display:flex;flex-direction:column;gap:3px;flex-shrink:0">
          <button class="dh-btn" data-tag-edit="1" title="Изменить метку" style="padding:3px 7px;font-size:10px">✏</button>
          <button class="dh-btn dh-btn-danger" data-tag-del="1" title="Удалить метку" style="padding:3px 7px;font-size:10px">✕</button>
        </div>`;
      row.addEventListener("click", (e) => {
        if (e.target && e.target.closest && e.target.closest("[data-tag-edit],[data-tag-del]")) return;
        if (u.username) {
          window.open("https://www.duolingo.com/profile/" + encodeURIComponent(u.username), "_blank");
        }
      });
      const editBtn = row.querySelector("[data-tag-edit]");
      if (editBtn) {
        editBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          showTagEditor(u);
        });
      }
      const delBtn = row.querySelector("[data-tag-del]");
      if (delBtn) {
        delBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const ok = await showConfirm(
            `Удалить метку с ${u.name || u.username || "?"}?`,
            "Удаление метки",
          );
          if (!ok) return;
          upsertTag({ userId: u.userId, username: u.username, name: u.name }, { label: "", note: "", color: "#58cc02" });
          renderFriends();
          renderTagsList();
          showToast("Метка удалена");
        });
      }
      els.tagsList.appendChild(row);
    }
  }

  function showTagsListOnly() {
    if (els.tagsList) els.tagsList.style.display = "flex";
    if (els.tagsForm) els.tagsForm.style.display = "none";
    if (els.tagsOpen) els.tagsOpen.style.display = "none";
    if (els.tagsBack) els.tagsBack.style.display = "";
    if (els.tagSave) els.tagSave.style.display = "none";
    renderTagsList();
  }

  function showTagsForm() {
    if (els.tagsList) els.tagsList.style.display = "none";
    if (els.tagsForm) els.tagsForm.style.display = "";
    if (els.tagsOpen) els.tagsOpen.style.display = "";
    if (els.tagsBack) els.tagsBack.style.display = "none";
    if (els.tagSave) els.tagSave.style.display = "";
    syncTagFormFromProfile();
  }

  function syncTagFormFromProfile() {
    const uname = getProfileUsername();
    if (!els.tagLabel) return;
    if (!uname) {
      if (els.tagsUser) els.tagsUser.textContent = "Метка для профиля";
      els.tagLabel.value = "";
      els.tagNote.value = "";
      els.tagColor.value = "#58CC02";
      syncTagPalette("#58CC02");
      return;
    }
    const tag = findTagByUser(null, uname) || {};
    if (els.tagsUser) els.tagsUser.textContent = "Метка для @" + uname;
    els.tagLabel.value = tag.label || "";
    els.tagNote.value = tag.note || "";
    els.tagColor.value = tag.color || "#58CC02";
    syncTagPalette(els.tagColor.value);
  }

  /** Подсвечивает активный цвет в палитре. */
  function syncTagPalette(color) {
    const palette = shadow && shadow.querySelector("#dh-tag-palette");
    if (!palette) return;
    palette.querySelectorAll(".dh-swatch").forEach((s) => {
      const isActive = s.dataset.color === color;
      s.classList.toggle("active", isActive);
      s.style.boxShadow = isActive
        ? `0 0 0 1.5px ${color}`
        : "0 0 0 1.5px transparent";
    });
  }

  function saveTagFromForm() {
    const uname = getProfileUsername();
    if (!uname) {
      showToast("Сначала открой профиль пользователя", true);
      return;
    }
    // ищем реальное имя из кеша друзей / подписок
    let realName = uname;
    try {
      const rows = (friendsCache && friendsCache.rows) || [];
      const found = rows.find((r) => (r.username || "").toLowerCase() === uname.toLowerCase());
      if (found) realName = found.displayName || found.name || found.username || uname;
    } catch {}
    upsertTag({ username: uname, name: realName }, {
      label: (els.tagLabel && els.tagLabel.value.trim()) || "",
      note: (els.tagNote && els.tagNote.value.trim()) || "",
      color: (els.tagColor && els.tagColor.value) || "#58cc02",
    });
    showToast("Метка сохранена");
    renderFriends();
    updateTagsBadge();
    mountInlineTag(uname);
  }

  function showTagsView() {
    showTagsListOnly();
  }

  function openBugReport() {
    const theme = DATA.settings.theme || "win95";
    const overlay = document.createElement("div");
    overlay.className = "dh-confirm-overlay dh-theme-" + theme;
    overlay.innerHTML = `
      <div class="dh-confirm-box" style="width:340px">
        <div class="dh-confirm-title">🐛 Багрепорт</div>
        <div class="dh-confirm-body">
          <p style="margin:0 0 12px">Как хотите отправить багрепорт?</p>
        </div>
        <div class="dh-confirm-actions" style="justify-content:center;gap:10px">
          <button class="dh-btn dh-btn-primary" data-bug="github">GitHub</button>
          <button class="dh-btn" data-bug="telegram">Telegram</button>
          <button class="dh-btn" data-bug="cancel">Отмена</button>
        </div>
      </div>`;
    shadow.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('[data-bug="cancel"]').addEventListener("click", close);
    overlay.querySelector('[data-bug="github"]').addEventListener("click", () => {
      close();
      openGitHubBugReport();
    });
    overlay.querySelector('[data-bug="telegram"]').addEventListener("click", () => {
      close();
      openTelegramBugReport();
    });
  }

  function openGitHubBugReport() {
    const ver = (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || CURRENT_VERSION;
    const body = encodeURIComponent(
      [
        "**Версия скрипта:** " + ver,
        "**Браузер:** ",
        "**Тема окна:** " + (DATA.settings.theme || "win95"),
        "",
        "**Шаги воспроизведения:**",
        "1. ",
        "2. ",
        "",
        "**Ожидаемое поведение:**",
        "",
        "**Фактическое поведение:**",
        "",
        "**Дополнительно:**",
        "- ",
      ].join("\n"),
    );
    window.open(
      "https://github.com/Vidrimers/Duolingo-helper/issues/new?title=" +
        encodeURIComponent("[Bug] ") +
        "&body=" +
        body,
      "_blank",
    );
  }

  async function openTelegramBugReport() {
    const myId = getMyId();
    if (!myId) {
      showToast("Не удалось определить аккаунт", true);
      return;
    }
    // проверяем привязку TG
    try {
      const res = await new Promise((resolve) => {
        GM_xmlhttpRequest({
          method: "GET",
          url: BOT_API + "/api/link-status?duolingoUserId=" + encodeURIComponent(myId),
          timeout: 10000,
          onload(r) { try { resolve(JSON.parse(r.responseText || "{}")); } catch { resolve(null); } },
          onerror() { resolve(null); },
          ontimeout() { resolve(null); },
        });
      });
      if (!res || !res.linked) {
        showToast("Привязать Telegram можно в блоке «Аккаунты»", true);
        return;
      }
    } catch {
      showToast("Не удалось проверить привязку", true);
      return;
    }
    // открываем бота с /bugreport
    window.open("https://t.me/Duolingo_Helperbot?start=bugreport_" + myId, "_blank");
  }

  // ========== Toast ==========
  function showToast(msg, isError = false) {
    notify(isError ? "error" : "ok", msg);
  }

  /** Стак уведомлений. kind: ok | error | info | warn */
  function notify(kind, msg) {
    if (!shadow) return;
    let box = shadow.querySelector(".dh-notifs");
    if (!box) {
      box = document.createElement("div");
      box.className = "dh-notifs dh-theme-" + (DATA.settings.theme || "win95");
      shadow.appendChild(box);
    }
    const n = document.createElement("div");
    n.className = "dh-notif " + (kind || "info");
    const icon =
      kind === "error" ? "❌" : kind === "ok" ? "✅" : kind === "warn" ? "⚠️" : "ℹ️";
    n.innerHTML =
      `<span class="dh-notif-icon">${icon}</span><span class="dh-notif-text"></span>`;
    n.querySelector(".dh-notif-text").textContent = String(msg);
    box.appendChild(n);
    requestAnimationFrame(() => n.classList.add("show"));

    const hideSec = Math.max(
      1,
      Math.min(30, (DATA.settings && DATA.settings.notifyHideSec) || 5),
    );
    const remove = () => {
      n.classList.remove("show");
      setTimeout(() => n.remove(), 250);
    };
    const timer = setTimeout(remove, hideSec * 1000);
    n.addEventListener("click", () => {
      clearTimeout(timer);
      remove();
    });

    // не даём стеку вылезти за экран
    while (box.children.length > 6) {
      box.removeChild(box.firstElementChild);
    }
  }

  // ========== Badge (inline, glued to the username element) ==========
  const INLINE_BADGE_ID = "dh-inline-badge";
  const INLINE_STYLE_ID = "dh-inline-style";

  function ensureInlineStyle() {
    if (document.getElementById(INLINE_STYLE_ID)) return;
    const st = document.createElement("style");
    st.id = INLINE_STYLE_ID;
    st.textContent = `
      #${INLINE_BADGE_ID} {
        display: inline-flex !important;
        align-items: center !important;
        gap: 5px !important;
        vertical-align: middle !important;
        margin-left: 8px !important;
        padding: 2px 9px !important;
        border-radius: 999px !important;
        font: 700 11px/1.3 Tahoma, "Segoe UI", sans-serif !important;
        cursor: pointer !important;
        border: 1px solid rgba(0,0,0,0.12) !important;
        box-shadow: 0 1px 3px rgba(0,0,0,0.12) !important;
        white-space: nowrap !important;
        max-width: 220px !important;
        position: static !important;
        box-sizing: border-box !important;
        text-transform: none !important;
        letter-spacing: normal !important;
      }
      #${INLINE_BADGE_ID}:hover { filter: brightness(1.06); }
      #${INLINE_BADGE_ID}.yes {
        background: linear-gradient(to bottom, #6EC27A, #3D8F4A) !important;
        color: #fff !important;
        border-color: #2D6B36 !important;
      }
      #${INLINE_BADGE_ID}.no {
        background: linear-gradient(to bottom, #E9847A, #D6483A) !important;
        color: #fff !important;
        border-color: #8B2A20 !important;
      }
      #${INLINE_BADGE_ID}.checking {
        background: linear-gradient(to bottom, #E8E4D4, #C8C4A8) !important;
        color: #333 !important;
        border-color: #919B9C !important;
      }
      #${INLINE_BADGE_ID}.error {
        background: linear-gradient(to bottom, #F0C48A, #D08A2A) !important;
        color: #fff !important;
        border-color: #A06A1A !important;
      }
      #${INLINE_BADGE_ID} .dh-inline-icon {
        font-size: 12px !important;
        line-height: 1 !important;
        font-style: normal !important;
      }
      #${INLINE_BADGE_ID} .dh-inline-text {
        overflow: hidden !important;
        text-overflow: ellipsis !important;
      }
    `;
    (document.head || document.documentElement).appendChild(st);
  }

  /** Ищем в DOM элемент с именем пользователя (то, что в URL профиля). */
  function findNameEl(username) {
    if (!username) return null;
    const uname = username.toLowerCase();
    const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "INPUT", "TEXTAREA"]);

    const isMatch = (text) => {
      const t = (text || "").trim().toLowerCase().replace(/^@/, "");
      return t === uname;
    };

    const candidates = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walk.nextNode())) {
      if (skip.has(node.tagName)) continue;
      if (node.id === INLINE_BADGE_ID) continue;
      if (node.closest && (node.closest("#" + HOST_ID) || node.closest("#" + INLINE_BADGE_ID))) {
        continue;
      }
      if (node.childElementCount > 3) continue;
      if (!isMatch(node.textContent)) continue;

      const rect = node.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 8) continue;

      const cs = getComputedStyle(node);
      if (cs.visibility === "hidden" || cs.display === "none") continue;

      const fontSize = parseFloat(cs.fontSize) || 12;
      const isHeading = /^H[1-3]$/.test(node.tagName) || node.getAttribute("role") === "heading";
      candidates.push({
        el: node,
        score: (isHeading ? 100 : 0) + fontSize + (rect.top < 280 ? 40 : 0),
      });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].el;
  }

  function removeInlineBadge() {
    const old = document.getElementById(INLINE_BADGE_ID);
    if (old) old.remove();
    const oldTag = document.getElementById("dh-inline-tag");
    if (oldTag) oldTag.remove();
  }

  /**
   * Вставляет плашку прямо в DOM рядом с именем.
   * Она живёт в вёрстке профиля — едет вместе с именем, как его часть.
   */
  function mountInlineBadge(username, state, title) {
    ensureInlineStyle();
    const nameEl = findNameEl(username);
    if (!nameEl || !nameEl.parentNode) return false;

    // уже стоит рядом с нужным именем — только обновляем контент
    let badge = document.getElementById(INLINE_BADGE_ID);
    if (badge && badge.dataset.for === String(username).toLowerCase()) {
      // ok
    } else {
      removeInlineBadge();
      badge = document.createElement("span");
      badge.id = INLINE_BADGE_ID;
      badge.dataset.for = String(username).toLowerCase();
      badge.innerHTML =
        `<span class="dh-inline-icon"></span><span class="dh-inline-text"></span>`;
      // сразу после элемента имени
      nameEl.insertAdjacentElement("afterend", badge);
    }

    badge.className = state;
    badge.title = "Duolingo Helper — нажми, чтобы открыть панель";
    badge.querySelector(".dh-inline-icon").textContent =
      state === "yes" ? "✅" : state === "no" ? "❌" : state === "checking" ? "⏳" : "⚠️";
    badge.querySelector(".dh-inline-text").textContent = title;

    if (!badge.dataset.bound) {
      badge.dataset.bound = "1";
      badge.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (els.modal) els.modal.classList.add("open");
        if (typeof refreshMeInfo === "function") refreshMeInfo();
      });
    }

    // отдельная плашка метки (не входит в статус подписки)
    mountInlineTag(username);
    return true;
  }

  var tagRetryTimer = null;
  function mountInlineTag(username) {
    const old = document.getElementById("dh-inline-tag");
    const tag = findTagByUser(null, username);
    if (old) old.remove();
    if (!tag || !tag.label) return;

    const nameEl = findNameEl(username);
    if (!nameEl) {
      // имя ещё не отрисовано — пробуем снова
      if (tagRetryTimer) clearInterval(tagRetryTimer);
      var attempts = 0;
      tagRetryTimer = setInterval(() => {
        attempts++;
        const el2 = findNameEl(username);
        if (el2 || attempts > 20) {
          clearInterval(tagRetryTimer);
          tagRetryTimer = null;
          if (el2) mountInlineTag(username);
        }
      }, 500);
      return;
    }

    const el = document.createElement("span");
    el.id = "dh-inline-tag";
    el.textContent = tag.label;
    el.title = tag.note || "Метка";
    el.style.cssText =
      "display:inline-flex;align-items:center;margin-left:8px;padding:2px 10px;" +
      "border-radius:999px;font:700 11px/1.3 Tahoma,sans-serif;white-space:nowrap;" +
      "background:" +
      (tag.color || "#58cc02") +
      ";color:#fff;border:1px solid rgba(0,0,0,0.12);box-shadow:0 1px 3px rgba(0,0,0,0.12);cursor:pointer;";
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (els.modal) {
        els.modal.classList.add("open");
        if (typeof showTagsForm === "function") showTagsForm();
      }
    });

    // после плашки подписки, если она есть; иначе после имени
    const followBadge = document.getElementById(INLINE_BADGE_ID);
    if (followBadge && followBadge.parentNode) {
      followBadge.insertAdjacentElement("afterend", el);
    } else {
      nameEl.insertAdjacentElement("afterend", el);
    }
  }

  let lastBadge = null;

  function setBadge(state, title, sub) {
    const s = DATA.settings;
    if (!s.showBadge || !isProfilePage()) {
      removeInlineBadge();
      if (els.badge) els.badge.classList.remove("visible");
      return;
    }

    const uname = getProfileUsername();
    lastBadge = { state, title, sub, username: uname };

    const inlined = mountInlineBadge(uname, state, title);
    if (inlined) {
      // плашка в вёрстке — угловой слой скрываем
      if (els.badge) els.badge.classList.remove("visible");
      return;
    }

    // имя ещё не найдено — временный fallback в углу
    removeInlineBadge();
    if (!els.badge) return;
    els.badge.className = "dh-badge visible " + state;
    els.badgeIcon.textContent =
      state === "yes" ? "✅" : state === "no" ? "❌" : state === "checking" ? "⏳" : "⚠️";
    els.badgeText.textContent = title;
    els.badgeSub.textContent = sub || "нажми, чтобы открыть панель";
  }

  /** SPA может убрать/перерисовать шапку — вернуть плашку к имени. */
  function ensureBadge() {
    if (!DATA.settings.showBadge || !isProfilePage()) return;
    const u = getProfileUsername();
    if (!u || isOwnProfile(u)) return;

    const existing = document.getElementById(INLINE_BADGE_ID);
    const nameEl = findNameEl(u);

    if (existing && nameEl) {
      // если имя перерисовали и плашка осталась не рядом — вставляем заново
      const isNextToName =
        nameEl.nextElementSibling === existing ||
        nameEl.parentNode === existing.parentNode;
      if (!isNextToName) {
        existing.remove();
        const cached = getCached(u);
        if (cached && cached.theirId !== undefined) applyResult(u, cached);
        else if (lastBadge && lastBadge.username === u) {
          setBadge(lastBadge.state, lastBadge.title, lastBadge.sub);
        }
      }
      mountInlineTag(u);
      return;
    }

    if (existing) return; // есть плашка, имя пока не нашли — не трогаем

    const cached = getCached(u);
    if (cached && cached.theirId !== undefined) {
      applyResult(u, cached);
      return;
    }
    if (lastBadge && lastBadge.username === u) {
      setBadge(lastBadge.state, lastBadge.title, lastBadge.sub);
    }
    mountInlineTag(u);
  }

  function hideBadge() {
    removeInlineBadge();
    if (els.badge) els.badge.classList.remove("visible");
  }

  // ========== Status card ==========
  function setStatus(kind, title, sub) {
    if (!els.status) return;
    const map = {
      yes: ["✅", "dh-status-yes"],
      no: ["❌", "dh-status-no"],
      checking: ["⏳", "dh-status-checking"],
      error: ["⚠️", "dh-status-error"],
      idle: ["👤", ""],
    };
    const [icon, cls] = map[kind] || map.idle;
    els.status.className = "dh-status-line " + cls;
    els.status.innerHTML =
      `<span class="icon">${icon}</span><span class="text"></span>`;
    els.status.querySelector(".text").textContent = title;
    els.statusSub.textContent = sub || "";
  }

  function setManualStatus(kind, title, sub) {
    if (!els.manualStatus) return;
    const map = {
      yes: ["✅", "dh-status-yes"],
      no: ["❌", "dh-status-no"],
      checking: ["⏳", "dh-status-checking"],
      error: ["⚠️", "dh-status-error"],
      idle: ["👤", ""],
    };
    const [icon, cls] = map[kind] || map.idle;
    els.manualStatus.className = "dh-status-line " + cls;
    els.manualStatus.innerHTML =
      `<span class="icon">${icon}</span><span class="text"></span>`;
    els.manualStatus.querySelector(".text").textContent = title;
    els.manualSub.textContent = sub || "";
  }

  // ========== Core: check ==========
  let checking = false;

  async function runCheck(username, { manual = false } = {}) {
    if (!username) {
      showToast("Укажи username", true);
      return;
    }
    if (checking) return;
    checking = true;

    const setStatusFn = manual ? setManualStatus : setStatus;
    const setBadgeState = (state, title, sub) => {
      if (!manual) setBadge(state, title, sub);
    };

    setStatusFn("checking", `Проверяем @${username}…`, "Запрос к API Duolingo");
    setBadgeState("checking", `Проверка @${username}…`);

    try {
      // свой профиль — не проверяем
      const me0 = await getMe();
      if (me0 && me0.username && isOwnProfile(username)) {
        hideBadge();
        setStatus(
          "idle",
          "Это твой профиль",
          "Нельзя быть подписанным на самого себя — проверка не нужна.",
        );
        showToast("Это твой профиль");
        return;
      }

      const cached = getCached(username);
      if (cached && cached.theirId) {
        applyResult(username, cached, { manual });
        checking = false;
        return;
      }

      const me = await getMe();
      if (!me || !me.id) {
        throw new Error("Не удалось определить твой аккаунт. Выполнен вход?");
      }

      const target = await resolveUser(username);
      if (!target) {
        throw new Error(`Пользователь @${username} не найден`);
      }

      const followsMe = await checkFollowsMe(target.username, target.id);
      const entry = {
        followsMe,
        theirId: target.id,
        theirName: target.name,
        theirUsername: target.username,
        checkedAt: Date.now(),
      };
      setCached(username, entry);
      applyResult(username, entry, { manual });
    } catch (e) {
      console.warn("[DuoHelper] check failed", e);
      const msg = e && e.message ? e.message : "Ошибка проверки";
      setStatusFn("error", "Ошибка", msg);
      setBadgeState("error", "Ошибка проверки", msg);
      showToast(msg, true);
    } finally {
      checking = false;
    }
  }

  function applyResult(username, entry, { manual = false } = {}) {
    const setStatusFn = manual ? setManualStatus : setStatus;
    const who = entry.theirName || entry.theirUsername || username;

    if (entry.followsMe) {
      setStatusFn(
        "yes",
        `${who} ПОДПИСАН(А) на вас`,
        `@${username} · проверено ${fmtTime(entry.checkedAt)}`,
      );
      if (!manual) {
        // без эмодзи в тексте — иконка ставится отдельно в .dh-inline-icon
        setBadge("yes", "Подписан(а) на вас", `@${username}`);
      }
    } else {
      setStatusFn(
        "no",
        `${who} НЕ подписан(а) на вас`,
        `@${username} · проверено ${fmtTime(entry.checkedAt)}`,
      );
      if (!manual) {
        setBadge("no", "Не подписан(а) на вас", `@${username}`);
      }
    }
  }

  function fmtTime(ts) {
    if (!ts) return "—";
    try {
      return new Date(ts).toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "—";
    }
  }

  // ========== Me info ==========
  async function refreshMeInfo() {
    if (!els.meInfo) return;
    const myId = getMyId();
    if (!myId) {
      els.meInfo.textContent = "Не выполнен вход (нет jwt_token)";
      return;
    }
    els.meInfo.textContent = "Загрузка…";
    const me = await getMe();
    if (me && me.username) {
      els.meInfo.textContent = `@${me.username} · id ${me.id}`;
    } else {
      els.meInfo.textContent = `id ${myId} · username не получен`;
    }
  }

  // ========== SPA watcher ==========
  let lastPath = location.pathname;

  async function onNavigate() {
    const path = location.pathname;
    if (path === lastPath) return;
    lastPath = path;

    // смена аккаунта в SPA / после логина
    const curAcc = getMyId();
    if (curAcc && DATA._accountId !== curAcc) {
      switchAccount(curAcc);
    }

    syncTagFormFromProfile();

    if (isProfilePage()) {
      const u = getProfileUsername();
      els.userInput.value = u || "";
      // обновляем DATA.me перед проверкой — username мог смениться
      if (u && !isOwnProfile(u)) {
        try { await getMe(true); } catch {}
      }
      if (u && isOwnProfile(u)) {
        hideBadge();
        mountInlineTag(u);
        setStatus(
          "idle",
          "Это твой профиль",
          "Нельзя быть подписанным на самого себя — проверка не нужна.",
        );
        return;
      }
      if (DATA.settings.autoCheck) {
        runCheck(u);
      } else {
        const cached = getCached(u);
        if (cached) applyResult(u, cached);
        else {
          setStatus("idle", `@${u}`, "Автопроверка выключена — нажми «Проверить»");
          setBadge("checking", `@${u}`, "автопроверка выключена");
        }
      }
      mountInlineTag(u);
    } else {
      hideBadge();
      setStatus(
        "idle",
        "Открой профиль пользователя",
        "Скрипт покажет, подписан ли он на тебя в ответ.",
      );
    }
  }

  function hookHistory() {
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function () {
      origPush.apply(this, arguments);
      setTimeout(onNavigate, 50);
    };
    history.replaceState = function () {
      origReplace.apply(this, arguments);
      setTimeout(onNavigate, 50);
    };
    window.addEventListener("popstate", () => setTimeout(onNavigate, 50));
  }

  // ========== ПРОВЕРКА ОБНОВЛЕНИЙ ==========
  // версия из Tampermonkey — не расходится с @version в шапке
  const CURRENT_VERSION =
    (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) ||
    "0.3.5";
  // запасная ссылка установки, если API не дал download_url
  let installUrl =
    "https://raw.githubusercontent.com/Vidrimers/Duolingo-helper/refs/heads/master/duo-helper.user.js";

  // Источники версии. GitHub API — всегда свежий (без CDN-кеша).
  // jsDelivr @master кеширует до ~12 часов, raw CDN — тоже может быть stale.
  // Поэтому API первый; остальные — только если API недоступен.
  const UPDATE_SOURCES = [
    {
      name: "github-api",
      // всегда актуальное содержимое из git + sha коммита
      url: "https://api.github.com/repos/Vidrimers/Duolingo-helper/contents/duo-helper.user.js",
      parse: (text) => {
        try {
          const data = JSON.parse(text);
          const b64 = String(data.content || "").replace(/\n/g, "");
          const decoded = decodeURIComponent(
            atob(b64)
              .split("")
              .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
              .join(""),
          );
          const m = decoded.match(/\/\/ @version\s+([^\s]+)/);
          if (!m) return null;
          // download_url указывает на raw-файл (branch/sha) — рабочая ссылка
          // для установки. data.sha здесь — blob SHA файла, он НЕ подходит
          // для raw.githubusercontent.com (нужен commit SHA).
          if (data.download_url) {
            installUrl = String(data.download_url).split("#")[0];
          }
          return m[1];
        } catch {
          return null;
        }
      },
    },
    {
      name: "jsdelivr",
      url: "https://cdn.jsdelivr.net/gh/Vidrimers/Duolingo-helper@master/duo-helper.user.js",
      parse: (text) => {
        const m = text.match(/\/\/ @version\s+([^\s]+)/);
        return m ? m[1] : null;
      },
    },
    {
      name: "raw",
      url: "https://raw.githubusercontent.com/Vidrimers/Duolingo-helper/refs/heads/master/duo-helper.user.js",
      parse: (text) => {
        const m = text.match(/\/\/ @version\s+([^\s]+)/);
        return m ? m[1] : null;
      },
    },
  ];
  const UPDATE_CHECK_KEY = "dh_update_last_check";
  const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000;

  function parseVersion(str) {
    return String(str).trim().split(".").map(Number);
  }

  function isNewer(remote, current) {
    const r = parseVersion(remote);
    const c = parseVersion(current);
    for (let i = 0; i < Math.max(r.length, c.length); i++) {
      const rv = r[i] || 0;
      const cv = c[i] || 0;
      if (rv > cv) return true;
      if (rv < cv) return false;
    }
    return false;
  }

  function showUpdateBanner(remoteVersion) {
    try {
      if (!els.updateBanner || !els.updateText || !els.updateBtn) return;
      els.updateText.textContent = `🆕 Доступно обновление: v${CURRENT_VERSION} → v${remoteVersion}`;
      els.updateBanner.style.display = "flex";
      els.updateBtn.onclick = () => startUpdateReload();
    } catch (e) {
      console.warn("[DuoHelper] update banner error", e);
    }
  }

  /** Открывает установку в Tampermonkey и перезагружает страницу с отсчётом. */
  function startUpdateReload() {
    window.open(installUrl, "_blank");
    let left = 8;
    showToast(`Установка обновления… перезагрузка через ${left}…`);
    const tick = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(tick);
        location.reload();
        return;
      }
      showToast(`Установка обновления… перезагрузка через ${left}…`);
    }, 1000);
  }

  function gmFetch(url) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: url + (url.includes("?") ? "&" : "?") + "_=" + Date.now(),
        timeout: 8000,
        headers: { accept: "application/json,text/plain,*/*" },
        onload(resp) {
          resolve({ ok: resp.status === 200, text: resp.responseText || "" });
        },
        onerror() {
          resolve({ ok: false, text: "" });
        },
        ontimeout() {
          resolve({ ok: false, text: "" });
        },
      });
    });
  }

  /**
   * Проверка обновлений.
   * @returns {Promise<"update"|"current"|"error">}
   */
  async function checkForUpdates(force = false) {
    const lastCheck = GM_getValue(UPDATE_CHECK_KEY, 0);
    const now = Date.now();
    if (!force && now - lastCheck < UPDATE_CHECK_INTERVAL) return "skipped";

    let sawVersion = false;
    for (const source of UPDATE_SOURCES) {
      const res = await gmFetch(source.url);
      if (!res.ok) continue;
      const remoteVersion = source.parse(res.text);
      if (!remoteVersion) continue;
      sawVersion = true;

      if (isNewer(remoteVersion, CURRENT_VERSION)) {
        GM_setValue(UPDATE_CHECK_KEY, now);
        showUpdateBanner(remoteVersion);
        return "update";
      }
      // GitHub API всегда свежий — ему верим, fallback-кеш дальше не смотрим
      if (source.name === "github-api") {
        GM_setValue(UPDATE_CHECK_KEY, now);
        return "current";
      }
      // кешированный источник: мог быть stale — пробуем следующий
    }

    if (sawVersion) {
      GM_setValue(UPDATE_CHECK_KEY, now);
      return "current";
    }
    return "error";
  }

  function initUpdateCheck() {
    const verLabel = "v" + CURRENT_VERSION;
    if (els.currentVersion) els.currentVersion.textContent = verLabel;
    if (els.versionChip) els.versionChip.textContent = verLabel;
    if (els.checkUpdateBtn) {
      els.checkUpdateBtn.addEventListener("click", async () => {
        const btn = els.checkUpdateBtn;
        btn.textContent = "⏳ Проверяем...";
        btn.disabled = true;
        GM_setValue(UPDATE_CHECK_KEY, 0);
        try {
          const result = await checkForUpdates(true);
          if (result === "update") {
            showToast("Найдено обновление — см. плашку вверху панели");
          } else if (result === "current") {
            showToast("✓ Обновлений нет, версия актуальна");
          } else {
            showToast("Не удалось проверить обновления", true);
          }
        } finally {
          btn.textContent = "🔍 Проверить обновления";
          btn.disabled = false;
        }
      });
    }
    // тихая проверка при старте — не чаще раза в сутки
    checkForUpdates(false);
  }

  // ========== Window drag + position ==========
  function clampWinPos(x, y) {
    const w = els.modal ? els.modal.offsetWidth || 420 : 420;
    const h = els.modal ? els.modal.offsetHeight || 300 : 300;
    const maxX = Math.max(8, window.innerWidth - w - 8);
    const maxY = Math.max(8, window.innerHeight - h - 8);
    return {
      x: Math.min(Math.max(8, x), maxX),
      y: Math.min(Math.max(8, y), maxY),
    };
  }

  function applyWinPos() {
    if (!els.modal) return;
    const saved = DATA.settings.winPos;
    if (saved && saved.xPct != null) {
      // проценты от размера окна браузера
      const x = Math.round((saved.xPct / 100) * window.innerWidth);
      const y = Math.round((saved.yPct / 100) * window.innerHeight);
      const pos = clampWinPos(x, y);
      els.modal.style.left = pos.x + "px";
      els.modal.style.top = pos.y + "px";
      return;
    }
    const pos = saved
      ? clampWinPos(saved.x, saved.y)
      : clampWinPos(
          window.innerWidth - 420 - 120,
          Math.round(window.innerHeight * 0.12),
        );
    els.modal.style.left = pos.x + "px";
    els.modal.style.top = pos.y + "px";
  }

  function saveWinPos() {
    if (!els.modal) return;
    const x = parseInt(els.modal.style.left, 10) || 0;
    const y = parseInt(els.modal.style.top, 10) || 0;
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    DATA.settings.winPos = {
      xPct: (x / w) * 100,
      yPct: (y / h) * 100,
    };
    saveData();
  }

  function currentWindowState() {
    if (!els.modal || !els.modal.classList.contains("open")) return "closed";
    return els.modal.classList.contains("dh-min") ? "min" : "open";
  }

  function saveWindowState() {
    DATA.settings.windowState = currentWindowState();
    saveData();
  }

  function applyStartState() {
    if (!els.modal) return;
    const mode = DATA.settings.startState || "remember";
    let state = DATA.settings.windowState || "closed";
    if (mode !== "remember") state = mode;

    els.modal.classList.remove("dh-min");
    if (els.minBtn) {
      els.minBtn.textContent = "–";
      els.minBtn.title = "Свернуть";
    }

    if (state === "closed") {
      els.modal.classList.remove("open");
      return;
    }
    els.modal.classList.add("open");
    if (state === "min") {
      toggleMinimize();
    }
  }

  let preMinPos = null;

  function toggleMinimize() {
    if (!els.modal) return;
    const isMin = els.modal.classList.contains("dh-min");
    els.modal.classList.add("dh-anim");

    if (!isMin) {
      preMinPos = {
        x: parseInt(els.modal.style.left, 10) || els.modal.offsetLeft || 0,
        y: parseInt(els.modal.style.top, 10) || els.modal.offsetTop || 0,
        width: els.modal.offsetWidth || 420,
      };
      const fromW = preMinPos.width;
      // сброс inline-width, иначе fit-content не сработает
      els.modal.style.width = "";
      els.modal.classList.add("dh-min");
      // меряем по содержимому titlebar, без ellipsis
      let toW = els.modal.offsetWidth || 300;
      if (els.titlebar) {
        toW = Math.max(toW, els.titlebar.scrollWidth);
      }
      toW = Math.min(toW, window.innerWidth - 16);
      els.modal.style.width = fromW + "px";
      requestAnimationFrame(() => {
        els.modal.style.width = toW + "px";
        els.modal.style.left = "8px";
        els.modal.style.top = Math.max(8, window.innerHeight - 56) + "px";
      });
      if (els.minBtn) {
        els.minBtn.textContent = "▢";
        els.minBtn.title = "Развернуть";
      }
    } else {
      const pos = preMinPos
        ? clampWinPos(preMinPos.x, preMinPos.y)
        : clampWinPos(window.innerWidth - 420 - 120, Math.round(window.innerHeight * 0.12));
      const w = (preMinPos && preMinPos.width) || 420;
      els.modal.classList.remove("dh-min");
      requestAnimationFrame(() => {
        els.modal.style.width = w + "px";
        els.modal.style.left = pos.x + "px";
        els.modal.style.top = pos.y + "px";
      });
      preMinPos = null;
      if (els.minBtn) {
        els.minBtn.textContent = "–";
        els.minBtn.title = "Свернуть";
      }
    }

    setTimeout(() => {
      els.modal.classList.remove("dh-anim");
      saveWinPos();
      saveWindowState();
    }, 320);
  }

  /** Анимация «втягивания» окна в FAB и закрытие. */
  function closeToFab() {
    if (!els.modal) return;
    const fab = els.fab;
    els.modal.classList.add("dh-anim");
    if (fab) {
      const mr = els.modal.getBoundingClientRect();
      const fr = fab.getBoundingClientRect();
      const dx = fr.left + fr.width / 2 - (mr.left + mr.width / 2);
      const dy = fr.top + fr.height / 2 - (mr.top + mr.height / 2);
      els.modal.style.transformOrigin = "center center";
      els.modal.style.transform = `translate(${dx}px, ${dy}px) scale(0.08)`;
      els.modal.style.opacity = "0";
    } else {
      els.modal.style.opacity = "0";
      els.modal.style.transform = "scale(0.9)";
    }
    setTimeout(() => {
      els.modal.classList.remove("open", "dh-min");
      els.modal.classList.remove("dh-anim");
      els.modal.style.transform = "";
      els.modal.style.opacity = "";
      els.modal.style.width = "";
      preMinPos = null;
      if (els.minBtn) {
        els.minBtn.textContent = "–";
        els.minBtn.title = "Свернуть";
      }
      saveWindowState();
    }, 300);
  }

  function initDrag() {
    const bar = els.titlebar;
    const modal = els.modal;
    if (!bar || !modal) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let origX = 0;
    let origY = 0;

    const onMove = (e) => {
      if (!dragging) return;
      e.preventDefault();
      const p = clampWinPos(origX + (e.clientX - startX), origY + (e.clientY - startY));
      modal.style.left = p.x + "px";
      modal.style.top = p.y + "px";
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      saveWinPos();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    bar.addEventListener("pointerdown", (e) => {
      // не тащить по кнопкам окна
      if (e.target.closest(".dh-win-btn")) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      origX = parseInt(modal.style.left, 10) || modal.offsetLeft || 0;
      origY = parseInt(modal.style.top, 10) || modal.offsetTop || 0;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  function clampFabPos(x, y) {
    const w = els.fab ? els.fab.offsetWidth || 34 : 34;
    const h = els.fab ? els.fab.offsetHeight || 24 : 24;
    return {
      x: Math.min(Math.max(4, x), window.innerWidth - w - 4),
      y: Math.min(Math.max(4, y), window.innerHeight - h - 4),
    };
  }

  function applyFabPos() {
    if (!els.fab) return;
    const saved = DATA.settings.fabPos;
    if (!saved) {
      els.fab.style.left = "24px";
      els.fab.style.top = "auto";
      els.fab.style.bottom = "24px";
      return;
    }
    let x, y;
    if (saved.xPct != null) {
      x = Math.round((saved.xPct / 100) * window.innerWidth);
      y = Math.round((saved.yPct / 100) * window.innerHeight);
    } else {
      x = saved.x;
      y = saved.y;
    }
    const p = clampFabPos(x, y);
    els.fab.style.left = p.x + "px";
    els.fab.style.top = p.y + "px";
    els.fab.style.bottom = "auto";
  }

  function saveFabPos() {
    if (!els.fab) return;
    const x = parseInt(els.fab.style.left, 10) || 0;
    const y = parseInt(els.fab.style.top, 10) || 0;
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    DATA.settings.fabPos = {
      xPct: (x / w) * 100,
      yPct: (y / h) * 100,
    };
    saveData();
  }

  function initFabDrag() {
    const fab = els.fab;
    if (!fab) return;

    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let origX = 0;
    let origY = 0;

    const onMove = (e) => {
      if (!dragging) return;
      e.preventDefault();
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      const p = clampFabPos(origX + dx, origY + dy);
      fab.style.left = p.x + "px";
      fab.style.top = p.y + "px";
      fab.style.bottom = "auto";
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      if (moved) saveFabPos();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    fab.addEventListener("pointerdown", (e) => {
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      origX = parseInt(fab.style.left, 10) || fab.offsetLeft || 24;
      origY =
        fab.style.top !== "auto" && fab.style.top
          ? parseInt(fab.style.top, 10) || 24
          : window.innerHeight - (fab.offsetHeight || 24) - 24;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });

    fab.addEventListener("click", (e) => {
      // если тащили — клик не открывает
      if (moved) {
        e.preventDefault();
        e.stopPropagation();
        moved = false;
      }
    }, true);
  }

  // ========== Экспорт (модалка) ==========
  /** Собирает аккаунты в формате v2 (общий для файла и облачного бэкапа). */
  function buildExportAccounts(ids, includeJwt) {
    const accounts = (DATA._store && DATA._store.accounts) || {};
    const out = [];
    for (const id of ids) {
      const a = accounts[id] || {};
      const entry = {
        id,
        username: (a.me && a.me.username) || a.username || "",
        displayName: (a.me && a.me.name) || (a.me && a.me.displayName) || "",
        label: a.label || "",
        updatedAt: a.updatedAt || 0,
        data: {
          settings: a.settings || {},
          followCache: a.followCache || {},
          me: a.me || null,
          actionLog: a.actionLog || [],
          excludeList: a.excludeList || [],
          blockList: a.blockList || [],
          friendSnapshots: a.friendSnapshots || [],
          friendChanges: a.friendChanges || [],
          friendChangesUnread: a.friendChangesUnread || 0,
          userTags: a.userTags || {},
          stats: a.stats || { xpLog: [], leagueLog: [], lastSnapshot: null },
          privacySnapshot: a.privacySnapshot || {},
        },
      };
      if (includeJwt && a.jwt) entry.jwt = a.jwt;
      out.push(entry);
    }
    return out;
  }

  function showExportModal() {
    if (!shadow) return;
    const theme = DATA.settings.theme || "win95";
    const store = DATA._store || { accounts: {} };
    const accounts = store.accounts || {};
    const accIds = Object.keys(accounts).filter((k) => k !== "anon");
    const curId = DATA._accountId || currentAccountId();

    const overlay = document.createElement("div");
    overlay.className = "dh-confirm-overlay dh-theme-" + theme;
    overlay.innerHTML = `
      <div class="dh-confirm-box" style="width:420px">
        <div class="dh-confirm-title">Экспорт данных</div>
        <div class="dh-confirm-body" style="max-height:55vh;overflow-y:auto;line-height:1.5">
          <div style="margin-bottom:10px"><strong>Аккаунты:</strong></div>
          <div id="dh-exp-accounts" style="margin-bottom:12px;display:flex;flex-direction:column;gap:4px">
            ${accIds.map((id) => {
              const a = accounts[id];
              const name = (a.me && a.me.username) || a.username || id;
              const me = id === curId ? " — текущий" : "";
              return `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px">
                <input type="checkbox" data-exp-acc="${id}" checked style="margin:0" />
                ${name} (${id})${me}
              </label>`;
            }).join("")}
          </div>
          <div style="margin-bottom:10px;font-size:11px;color:#888">
            <strong>Данные:</strong> настройки, кеш, история, исключения, блоки, метки, изменения, позиция окна
          </div>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;margin-bottom:6px">
            <input type="checkbox" id="dh-exp-jwt" checked style="margin:0" />
            Включить JWT аккаунтов
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;margin-bottom:10px">
            <input type="checkbox" id="dh-exp-encrypt" checked style="margin:0" />
            Шифровать паролем
          </label>
          <div id="dh-exp-pass-fields">
            <div class="dh-setting-row" style="border-bottom:none;padding:3px 0">
              <div class="dh-setting-label">Пароль</div>
              <input class="dh-input" id="dh-exp-pass" type="password" style="width:160px" />
            </div>
            <div class="dh-setting-row" style="border-bottom:none;padding:3px 0">
              <div class="dh-setting-label">Повтор</div>
              <input class="dh-input" id="dh-exp-pass2" type="password" style="width:160px" />
            </div>
          </div>
          <div id="dh-exp-warn" style="display:none;font-size:11px;color:#c0392b;margin-top:6px">
            ⚠️ JWT без шифрования — не передавайте файл другим.
          </div>
        </div>
        <div class="dh-confirm-actions">
          <button class="dh-btn" data-exp="cancel">Отмена</button>
          <button class="dh-btn dh-btn-primary" data-exp="download">Скачать</button>
        </div>
      </div>`;
    shadow.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('[data-exp="cancel"]').addEventListener("click", close);

    // показ/скрытие полей пароля и предупреждения
    const jwtCb = overlay.querySelector("#dh-exp-jwt");
    const encCb = overlay.querySelector("#dh-exp-encrypt");
    const passFields = overlay.querySelector("#dh-exp-pass-fields");
    const warn = overlay.querySelector("#dh-exp-warn");
    const syncVis = () => {
      const withJwt = jwtCb.checked;
      const enc = encCb.checked;
      passFields.style.display = withJwt && enc ? "" : "none";
      warn.style.display = withJwt && !enc ? "" : "none";
    };
    jwtCb.addEventListener("change", syncVis);
    encCb.addEventListener("change", syncVis);
    syncVis();

    overlay.querySelector('[data-exp="download"]').addEventListener("click", async () => {
      const includeJwt = jwtCb.checked;
      const doEncrypt = encCb.checked;
      let password = "";

      if (includeJwt && doEncrypt) {
        password = (overlay.querySelector("#dh-exp-pass") || {}).value || "";
        const pass2 = (overlay.querySelector("#dh-exp-pass2") || {}).value || "";
        if (!password || password !== pass2) {
          showToast("Пароли не совпадают или пустые", true);
          return;
        }
      }

      const selected = [];
      overlay.querySelectorAll("[data-exp-acc]").forEach((cb) => {
        if (cb.checked) selected.push(cb.dataset.expAcc);
      });
      if (!selected.length) {
        showToast("Выбери хотя бы один аккаунт", true);
        return;
      }

      const outAccounts = buildExportAccounts(selected, includeJwt);
      if (includeJwt && doEncrypt) {
        for (const entry of outAccounts) {
          if (entry.jwt) {
            entry.jwt_encrypted = await encryptJWT(entry.jwt, password);
            delete entry.jwt;
          }
        }
      }

      const payload = {
        type: "duolingo-helper-accounts",
        version: 2,
        exportedAt: new Date().toISOString(),
        encrypted: includeJwt && doEncrypt,
        accounts: outAccounts,
      };

      const fname = `duolingo-helper-accounts-${new Date().toISOString().slice(0, 10)}.json`;
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const aEl = document.createElement("a");
      aEl.href = URL.createObjectURL(blob);
      aEl.download = fname;
      aEl.click();
      setTimeout(() => URL.revokeObjectURL(aEl.href), 1000);
      close();
      showToast("✓ Экспорт: " + outAccounts.length + " акк.");
    });
  }

  // ========== Events ==========
  function bindEvents() {
    // колесо внутри окна не должно прокручивать страницу Duolingo
    if (els.modal) {
      els.modal.addEventListener(
        "wheel",
        (e) => {
          e.stopPropagation();
        },
        { passive: true },
      );
    }
    if (els.fab) {
      els.fab.addEventListener("click", () => {
        if (els.modal.classList.contains("dh-min")) {
          toggleMinimize();
          els.modal.classList.add("open");
        } else {
          els.modal.classList.toggle("open");
        }
        if (els.modal.classList.contains("open")) {
          refreshMeInfo();
          const u = getProfileUsername() || els.userInput.value;
          if (u && !els.userInput.value) els.userInput.value = u;
        }
        saveWindowState();
      });
    }

    els.badge.addEventListener("click", () => {
      if (els.modal.classList.contains("dh-min")) toggleMinimize();
      els.modal.classList.add("open");
      refreshMeInfo();
      saveWindowState();
    });

    els.closeBtn.addEventListener("click", () => closeToFab());
    els.minBtn.addEventListener("click", () => toggleMinimize());

    if (els.resetPosBtn) {
      els.resetPosBtn.addEventListener("click", () => {
        DATA.settings.winPos = null;
        saveData();
        applyWinPos();
        showToast("Позиция окна сброшена");
      });
    }

    if (els.aboutBtn) {
      els.aboutBtn.addEventListener("click", () => showAbout());
    }
    if (els.bugBtn) {
      els.bugBtn.addEventListener("click", () => openBugReport());
    }

    els.tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const name = tab.dataset.tab;
        els.tabs.forEach((t) => t.classList.toggle("active", t === tab));
        els.tabContents.forEach((c) =>
          c.classList.toggle("active", c.dataset.tab === name),
        );
        if (name === "friends") {
          // автозагрузка при открытии вкладки
          if (!friendsCache) {
            loadFriends();
          } else {
            renderFriends();
          }
        }
      });
    });

    els.checkBtn.addEventListener("click", () => {
      const u = (els.userInput.value || "").trim().replace(/^@/, "");
      if (!u) {
        showToast("Укажи username", true);
        return;
      }
      els.manualCard.style.display = "block";
      runCheck(u, { manual: true });
    });

    els.userInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") els.checkBtn.click();
    });

    els.recheckBtn.addEventListener("click", () => {
      const u = (
        getProfileUsername() ||
        els.userInput.value ||
        ""
      )
        .trim()
        .replace(/^@/, "");
      if (!u) {
        showToast("Нет username для проверки", true);
        return;
      }
      // сброс кеша по этому юзеру
      delete DATA.followCache[u.toLowerCase()];
      saveData();
      els.manualCard.style.display = "none";
      runCheck(u);
    });

    els.copyBtn.addEventListener("click", () => {
      const u = (
        getProfileUsername() ||
        els.userInput.value ||
        ""
      )
        .trim()
        .replace(/^@/, "");
      const entry = u ? DATA.followCache[u.toLowerCase()] : null;
      const text = entry
        ? `@${u}: ${entry.followsMe ? "подписан(а) на вас" : "НЕ подписан(а) на вас"} (проверено ${fmtTime(entry.checkedAt)})`
        : "Нет данных проверки";
      navigator.clipboard
        .writeText(text)
        .then(() => showToast("Скопировано"))
        .catch(() => showToast("Не удалось скопировать", true));
    });

    // settings
    syncSwitches();
    try { captureJWT(); } catch {}
    renderAccounts();
    try { loadPrivacyStatus(); } catch {}
    setTimeout(() => { try { loadPrivacyStatus(); } catch {} }, 3000);

    els.setAuto.addEventListener("click", () => {
      DATA.settings.autoCheck = !DATA.settings.autoCheck;
      saveData();
      syncSwitches();
      showToast(DATA.settings.autoCheck ? "Автопроверка включена" : "Автопроверка выключена");
    });

    els.setBadge.addEventListener("click", () => {
      DATA.settings.showBadge = !DATA.settings.showBadge;
      saveData();
      syncSwitches();
      if (!DATA.settings.showBadge) hideBadge();
      else onNavigate();
      showToast(DATA.settings.showBadge ? "Бейдж включён" : "Бейдж выключен");
    });

    if (els.setStart) {
      els.setStart.addEventListener("click", (e) => {
        e.stopPropagation();
        els.setStart.classList.toggle("open");
      });
      if (els.setStartOpts && els.setStartOpts.length) {
        els.setStartOpts.forEach((opt) => {
          opt.addEventListener("click", (e) => {
            e.stopPropagation();
            DATA.settings.startState = opt.dataset.start || "remember";
            saveData();
            syncSwitches();
            els.setStart.classList.remove("open");
            showToast("Стартовое состояние: " + startLabels[DATA.settings.startState]);
          });
        });
      }
      document.addEventListener("click", () => {
        if (els.setStart) els.setStart.classList.remove("open");
      });
    }

    if (els.setTheme) {
      els.setTheme.addEventListener("click", (e) => {
        e.stopPropagation();
        els.setTheme.classList.toggle("open");
      });
      if (els.setThemeOpts && els.setThemeOpts.length) {
        els.setThemeOpts.forEach((opt) => {
          opt.addEventListener("click", (e) => {
            e.stopPropagation();
            DATA.settings.theme = opt.dataset.theme || "win95";
            saveData();
            applyTheme();
            els.setTheme.classList.remove("open");
          });
        });
      }
      document.addEventListener("click", () => {
        if (els.setTheme) els.setTheme.classList.remove("open");
      });
    }

    if (els.setHearts) {
      els.setHearts.addEventListener("click", () => {
        DATA.settings.protectHearts = !DATA.settings.protectHearts;
        saveData();
        syncHeartsFlag();
        showToast(
          DATA.settings.protectHearts
            ? "Защита сердец включена"
            : "Защита сердец выключена",
        );
      });
    }

    if (els.setShort) {
      els.setShort.addEventListener("click", () => {
        DATA.settings.lessonShortener = !DATA.settings.lessonShortener;
        saveData();
        syncLessonFlags();
        showToast(
          DATA.settings.lessonShortener
            ? "Короткие уроки включены"
            : "Короткие уроки выключены",
        );
      });
    }
    if (els.setSolver) {
      els.setSolver.addEventListener("click", () => {
        DATA.settings.autoSolver = !DATA.settings.autoSolver;
        saveData();
        syncLessonFlags();
        showToast(
          DATA.settings.autoSolver
            ? "Автосолвер включён"
            : "Автосолвер выключен",
        );
      });
    }
    if (els.setStories) {
      els.setStories.addEventListener("click", () => {
        DATA.settings.storiesShortener = !DATA.settings.storiesShortener;
        saveData();
        syncLessonFlags();
        showToast(
          DATA.settings.storiesShortener
            ? "Короткие stories включены"
            : "Короткие stories выключены",
        );
      });
    }
    if (els.setFreeSuper) {
      els.setFreeSuper.addEventListener("click", () => {
        DATA.settings.freeSuper = !DATA.settings.freeSuper;
        saveData();
        syncPageFlags();
        if (els.setFreeSuper) els.setFreeSuper.classList.toggle("on", DATA.settings.freeSuper);
        showToast(
          DATA.settings.freeSuper
            ? "Free Max / Super включён"
            : "Free Max / Super выключен",
        );
      });
    }
    if (els.solveNow) {
      els.solveNow.addEventListener("click", () => solveNow());
    }
    if (els.apStart) {
      els.apStart.addEventListener("click", () => {
        const n = Math.max(1, Math.min(999, parseInt(els.apCount.value, 10) || 10));
        els.apCount.value = n;
        startAutoPractice(n);
      });
    }
    if (els.apStop) {
      els.apStop.addEventListener("click", () => stopAutoPractice(false));
    }

    // аккордеон: один открыт
    if (els.accs && els.accs.length) {
      els.accs.forEach((acc) => {
        const head = acc.querySelector(".dh-acc-head");
        if (!head) return;
        head.addEventListener("click", () => {
          const isOpen = acc.classList.contains("open");
          els.accs.forEach((a) => a.classList.remove("open"));
          if (!isOpen) acc.classList.add("open");
        });
      });
    }

    if (els.setXpBoost) {
      els.setXpBoost.addEventListener("click", () => {
        DATA.settings.fakeXpBoost = !DATA.settings.fakeXpBoost;
        saveData();
        syncXpBoostFlag();
        showToast(
          DATA.settings.fakeXpBoost
            ? "Фейк XP-буст включён"
            : "Фейк XP-буст выключен",
        );
      });
    }
    if (els.xpBoost15) {
      els.xpBoost15.addEventListener("click", () => {
        DATA.settings.xpBoostMins = 15;
        DATA.settings.fakeXpBoost = true;
        saveData();
        syncXpBoostFlag();
        showToast("Фейк x2 · 15 мин");
      });
    }
    if (els.xpBoost60) {
      els.xpBoost60.addEventListener("click", () => {
        DATA.settings.xpBoostMins = 60;
        DATA.settings.fakeXpBoost = true;
        saveData();
        syncXpBoostFlag();
        showToast("Фейк x2 · 60 мин");
      });
    }
    if (els.xpStories) {
      els.xpStories.addEventListener("click", () => farmXp("stories"));
    }
    if (els.xpSessions) {
      els.xpSessions.addEventListener("click", () => farmXp("sessions"));
    }
    if (els.xpStop) {
      els.xpStop.addEventListener("click", () => stopXpFarm());
    }

    if (els.questDaily) {
      els.questDaily.addEventListener("click", () => runDailyQuests());
    if (els.questWeekly) {
      els.questWeekly.addEventListener("click", () =>
        runQuestsByKind("weekly", "Weekly", els.questWeekly),
      );
    }
    if (els.questFriends) {
      els.questFriends.addEventListener("click", () =>
        runQuestsByKind("friends", "Friends", els.questFriends),
      );
    }
    if (els.questFamily) {
      els.questFamily.addEventListener("click", () =>
        runQuestsByKind("family", "Family", els.questFamily),
      );
    }
    }
    if (els.questLoad) {
      els.questLoad.addEventListener("click", () => loadMonthlyQuests());
    }
    if (els.questClaimAll) {
      els.questClaimAll.addEventListener("click", () => claimAllMonthly());
    }

    if (els.shopLoad) {
      els.shopLoad.addEventListener("click", () => loadShop());
    }
    if (els.shopSearch) {
      els.shopSearch.addEventListener("input", () => renderShopFiltered());
    }
    if (els.shopSuper) {
      els.shopSuper.addEventListener("click", () => buySuper3Days());
    }

    if (els.gemsOnce) {
      els.gemsOnce.addEventListener("click", () => claimGemsOnce());
    }
    if (els.gemsFarm) {
      els.gemsFarm.addEventListener("click", () => farmGems());
    }
    if (els.gemsFarmFast) {
      els.gemsFarmFast.addEventListener("click", () => farmGemsFast());
    }
    if (els.gemsStop) {
      els.gemsStop.addEventListener("click", () => stopGemsFarm());
    }

    if (els.streakRun) {
      els.streakRun.addEventListener("click", () => runStreakFarm());
    }
    if (els.streakStop) {
      els.streakStop.addEventListener("click", () => stopStreakFarm());
    }

    if (els.lbLoad) {
      els.lbLoad.addEventListener("click", () => loadLeague());
    }
    if (els.lbJoin) {
      els.lbJoin.addEventListener("click", () => joinLeague());
    }
    if (els.lbFarm) {
      els.lbFarm.addEventListener("click", () => farmLeague());
    }
    if (els.lbStop) {
      els.lbStop.addEventListener("click", () => stopLeagueFarm());
    }

    if (els.friendsLoad) {
      els.friendsLoad.addEventListener("click", () => loadFriends());
    }
    if (els.friendsSearch) {
      els.friendsSearch.addEventListener("input", () => renderFriends());
    }
    if (els.friendFilters && els.friendFilters.length) {
      els.friendFilters.forEach((b) => {
        b.addEventListener("click", () => {
          friendFilter = b.dataset.friendFilter || "all";
          els.friendFilters.forEach((x) =>
            x.classList.toggle("active", x === b),
          );
          renderFriends();
        });
      });
    }

    // кастомный селект сортировки «Активность»
    if (els.activitySort && els.activitySortOpts) {
      const sortLabels = {
        xp_desc: "Больше XP",
        xp_asc: "Меньше XP",
        streak_desc: "Больше дней",
        streak_asc: "Меньше дней",
        name_asc: "По имени A→Z",
        name_desc: "По имени Z→A",
      };
      if (els.activitySortText) {
        els.activitySortText.textContent =
          sortLabels[DATA.settings.activitySort] || "Больше XP";
      }
      els.activitySort.addEventListener("click", (e) => {
        if (els.activitySort.dataset.ready !== "1") return;
        e.stopPropagation();
        els.activitySort.classList.toggle("open");
      });
      els.activitySortOpts.forEach((opt) => {
        opt.addEventListener("click", (e) => {
          e.stopPropagation();
          const mode = opt.dataset.sort || "xp_desc";
          DATA.settings.activitySort = mode;
          saveData();
          if (els.activitySortText) {
            els.activitySortText.textContent = sortLabels[mode] || mode;
          }
          els.activitySort.classList.remove("open");
          if (friendFilter === "activity") renderFriends();
        });
      });
      document.addEventListener("click", () => {
        if (els.activitySort) els.activitySort.classList.remove("open");
      });
    }

    if (els.unfollowAll) {
      els.unfollowAll.addEventListener("click", () => massUnfollowNonFollowers());
    }
    if (els.unfollowAnyone) {
      els.unfollowAnyone.addEventListener("click", () => massUnfollowAnyone());
    }
    if (els.unfollowInactive) {
      els.unfollowInactive.addEventListener("click", () => massUnfollowInactive());
    }
    if (els.blockInactive) {
      els.blockInactive.addEventListener("click", () => massBlockInactive());
    }
    if (els.excludeOpen) {
      els.excludeOpen.addEventListener("click", () => showExcludeView());
    }
    if (els.blocksOpen) {
      els.blocksOpen.addEventListener("click", () => showBlocksView());
    }
    if (els.tagsOpen) {
      els.tagsOpen.addEventListener("click", () => showTagsListOnly());
    }
    if (els.tagsBack) {
      els.tagsBack.addEventListener("click", () => showTagsForm());
    }
    if (els.tagSave) {
      els.tagSave.addEventListener("click", () => saveTagFromForm());
    }
    // палитра цветов метки
    const palette = shadow && shadow.querySelector("#dh-tag-palette");
    if (palette) {
      palette.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-color]");
        if (!btn) return;
        const color = btn.dataset.color;
        if (els.tagColor) els.tagColor.value = color;
        palette.querySelectorAll(".dh-swatch").forEach((s) => {
          const isActive = s === btn;
          s.classList.toggle("active", isActive);
          s.style.boxShadow = isActive
            ? `0 0 0 1.5px ${color}`
            : "0 0 0 1.5px transparent";
        });
      });
    }
    if (els.historyOpen) {
      els.historyOpen.addEventListener("click", () => showHistoryView());
    }
    if (els.changesOpen) {
      els.changesOpen.addEventListener("click", () => showChangesView());
    }
    if (els.historyBack) {
      els.historyBack.addEventListener("click", () => showFriendsView());
    }

    // числовые настройки: пишем и на input, и на change (иначе теряется при F5)
    const bindNumSetting = (el, apply) => {
      if (!el) return;
      const commit = () => {
        apply(el);
        saveData();
      };
      el.addEventListener("change", commit);
      el.addEventListener("input", commit);
    };
    bindNumSetting(els.setCache, (el) => {
      const v = Math.max(1, Math.min(1440, parseInt(el.value, 10) || 30));
      DATA.settings.cacheMinutes = v;
      el.value = v;
    });
    bindNumSetting(els.setDelay, (el) => {
      const v = Math.max(0, Math.min(5000, parseInt(el.value, 10) || 0));
      DATA.settings.requestDelay = v;
      el.value = v;
    });
    bindNumSetting(els.setInactive, (el) => {
      const v = Math.max(1, Math.min(365, parseInt(el.value, 10) || 7));
      DATA.settings.inactiveDays = v;
      el.value = v;
      if (typeof renderFriends === "function") renderFriends();
    });
    bindNumSetting(els.setNotify, (el) => {
      const v = Math.max(1, Math.min(30, parseInt(el.value, 10) || 5));
      DATA.settings.notifyHideSec = v;
      el.value = v;
    });
    bindNumSetting(els.setLbGap, (el) => {
      const v = Math.max(1, Math.min(60, parseInt(el.value, 10) || 2));
      DATA.settings.lbGapRefresh = v;
      el.value = v;
    });
    if (els.scanActivity) {
      els.scanActivity.addEventListener("click", () => scanFriendActivity());
    }
    if (els.scanStop) {
      els.scanStop.addEventListener("click", () => stopActivityScan());
    }

    els.clearCache.addEventListener("click", () => {
      DATA.followCache = {};
      saveData();
      showToast("Кеш очищен");
    });

    els.refreshPage.addEventListener("click", () => location.reload());

    els.exportBtn.addEventListener("click", () => showExportModal());
  if (els.cloudSave) els.cloudSave.addEventListener("click", () => cloudSave());
  if (els.cloudLoad) els.cloudLoad.addEventListener("click", () => cloudLoad());
  if (els.cloudDelete) els.cloudDelete.addEventListener("click", () => cloudDelete());
    if (els.licenseLink) {
      els.licenseLink.addEventListener("click", (e) => {
        e.preventDefault();
        showLicense();
      });
    }

    // вложенные секции: Статистика / Дашборд / Аккаунты / Приватность
    // один открытый, плавное открытие через grid-template-rows
    const subToggles = [
      { btn: els.statsToggle, body: els.statsBody, onOpen: () => { try { renderStats(); collectStats(); } catch {} } },
      { btn: els.dashToggle, body: els.dashBody },
      { btn: els.accToggle, body: els.accListWrap },
      { btn: els.privacyToggle, body: els.privacyBody, onOpen: () => { try { loadPrivacyStatus(); } catch {} } },
    ];
    for (const item of subToggles) {
      if (!item.btn || !item.body) continue;
      item.btn.addEventListener("click", () => {
        const wasOpen = item.body.classList.contains("open");
        // закрываем все
        for (const s of subToggles) {
          if (s.body) s.body.classList.remove("open");
          if (s.btn) { const a = s.btn.querySelector(".dh-sub-arrow"); if (a) a.textContent = "▸"; }
        }
        // открываем эту, если была закрыта
        if (!wasOpen) {
          item.body.classList.add("open");
          const arrow = item.btn.querySelector(".dh-sub-arrow");
          if (arrow) arrow.textContent = "▾";
          if (item.onOpen) item.onOpen();
        }
      });
    }

    // ===== Import =====
    if (els.importBtn && els.importFile) {
      els.importBtn.addEventListener("click", () => els.importFile.click());
      els.importFile.addEventListener("change", () => {
        const file = els.importFile.files && els.importFile.files[0];
        els.importFile.value = "";
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const parsed = JSON.parse(String(reader.result || ""));
            if (!parsed || typeof parsed !== "object") throw new Error("bad format");

            // === формат v2: мультиаккаунт ===
            if (parsed.type === "duolingo-helper-accounts" && Array.isArray(parsed.accounts)) {
              await importAccountsV2(parsed);
              return;
            }

            // === формат v1 / плоский: один аккаунт ===
            let incoming = null;
            let fileAccId = null;
            let fileAccName = "";
            if (parsed.data && typeof parsed.data === "object") {
              incoming = parsed.data;
              fileAccId = parsed.accountId != null ? String(parsed.accountId) : null;
              fileAccName = parsed.accountName || "";
            } else {
              incoming = parsed;
            }

            const curId = currentAccountId();
            if (fileAccId && fileAccId !== curId) {
              const okGo = await showConfirm(
                `Файл от другого аккаунта (${fileAccName || "?"} · id ${fileAccId}).\nЗагрузить в текущий (${curId})?`,
                "Импорт данных",
              );
              if (!okGo) { showToast("Импорт отменён"); return; }
            }

            if (incoming.settings && typeof incoming.settings === "object") {
              DATA.settings = { ...DATA.settings, ...incoming.settings };
            }
            if (incoming.followCache && typeof incoming.followCache === "object") DATA.followCache = incoming.followCache;
            if (incoming.me && typeof incoming.me === "object") DATA.me = incoming.me;
            if (Array.isArray(incoming.actionLog)) DATA.actionLog = incoming.actionLog;
            if (Array.isArray(incoming.excludeList)) DATA.excludeList = incoming.excludeList;
            if (Array.isArray(incoming.blockList)) DATA.blockList = incoming.blockList;
            if (Array.isArray(incoming.friendSnapshots)) DATA.friendSnapshots = incoming.friendSnapshots;
            if (Array.isArray(incoming.friendChanges)) DATA.friendChanges = incoming.friendChanges;
            if (incoming.friendChangesUnread != null) DATA.friendChangesUnread = Number(incoming.friendChangesUnread) || 0;
            if (incoming.userTags && typeof incoming.userTags === "object") DATA.userTags = incoming.userTags;

            saveData();
            syncSwitches();
            updateListBadges();
            updateTagsBadge();
            updateChangesBadge();
            showToast("✓ Данные импортированы");
          } catch (e) {
            console.warn("[DuoHelper] import failed", e);
            showToast("Ошибка импорта: неверный JSON", true);
          }
        };
        reader.onerror = () => showToast("Не удалось прочитать файл", true);
        reader.readAsText(file);
      });
    }
  }

  /** Бэкап данных на сервере бота (один на аккаунт). Управление только из скрипта. */
  function cloudRequest(url, options) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: options.method,
        url,
        headers: options.headers,
        data: options.data,
        timeout: 20000,
        onload(r) {
          try { resolve(JSON.parse(r.responseText || "{}")); } catch { resolve(null); }
        },
        onerror() { resolve(null); },
        ontimeout() { resolve(null); },
      });
    });
  }

  /** Обновляет блок «Облачные сохранения»: доступность кнопок и дату бэкапа. */
  async function updateCloudBlock() {
    const saveBtn = els.cloudSave;
    const loadBtn = els.cloudLoad;
    const delBtn = els.cloudDelete;
    const status = els.cloudStatus;
    if (!saveBtn || !loadBtn) return;
    const myId = getMyId();
    const lock = () => {
      saveBtn.disabled = true;
      loadBtn.disabled = true;
      saveBtn.title = "Сначала привяжите Telegram";
      loadBtn.title = "Сначала привяжите Telegram";
      if (delBtn) { delBtn.disabled = true; delBtn.title = "Сначала привяжите Telegram"; }
      if (status) status.textContent = "Привяжите Telegram, чтобы сохранять в облаке";
    };
    if (!myId) { lock(); return; }
    const linked = await cloudRequest(
      BOT_API + "/api/link-status?duolingoUserId=" + encodeURIComponent(myId),
      { method: "GET" }
    );
    if (!linked || !linked.linked) { lock(); return; }
    saveBtn.disabled = false;
    loadBtn.disabled = false;
    saveBtn.title = "";
    loadBtn.title = "";
    const meta = await cloudRequest(
      BOT_API + "/api/backup?duolingoUserId=" + encodeURIComponent(myId) + "&meta=1",
      { method: "GET", headers: { authorization: "Bearer " + (getToken() || "") } }
    );
    const has = !!(meta && meta.hasBackup);
    if (delBtn) {
      delBtn.disabled = !has;
      delBtn.title = has ? "" : "Нет бэкапа для удаления";
    }
    if (status) {
      status.textContent = has
        ? "Последний бэкап: " + fmtTime(meta.savedAt)
        : "Бэкапов пока нет · один на аккаунт";
    }
  }

  /** Сохраняет все аккаунты в облако (тот же формат, что и экспорт). */
  async function cloudSave() {
    const myId = getMyId();
    const jwt = getToken();
    if (!myId || !jwt) { showToast("Сначала привяжите Telegram", true); return; }
    // показываем предупреждение о перезаписи только если бэкап уже есть
    const meta = await cloudRequest(
      BOT_API + "/api/backup?duolingoUserId=" + encodeURIComponent(myId) + "&meta=1",
      { method: "GET", headers: { authorization: "Bearer " + jwt } }
    );
    const ok = await showConfirm(
      meta && meta.hasBackup
        ? `Сохранить данные в облако? Существующий бэкап будет перезаписан (сейчас там от ${fmtTime(meta.savedAt)}).`
        : "Сохранить данные в облако?",
      "Облачное сохранение",
    );
    if (!ok) return;
    showToast("Сохраняю в облако…");
    const ids = Object.keys((DATA._store && DATA._store.accounts) || {});
    const payload = {
      type: "duolingo-helper-accounts",
      version: 2,
      exportedAt: new Date().toISOString(),
      encrypted: false,
      accounts: buildExportAccounts(ids, true),
    };
    const res = await cloudRequest(BOT_API + "/api/backup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      data: JSON.stringify({ duolingoUserId: myId, jwt, data: payload }),
    });
    if (res && res.ok) {
      showToast("✓ Бэкап сохранён в облаке");
      updateCloudBlock();
    } else {
      showToast("Ошибка сохранения: " + ((res && res.error) || "сервер недоступен"), true);
    }
  }

  /** Восстанавливает аккаунты из облачного бэкапа. */
  async function cloudLoad() {
    const myId = getMyId();
    const jwt = getToken();
    if (!myId || !jwt) { showToast("Сначала привяжите Telegram", true); return; }
    const res = await cloudRequest(
      BOT_API + "/api/backup?duolingoUserId=" + encodeURIComponent(myId),
      { method: "GET", headers: { authorization: "Bearer " + jwt } }
    );
    if (!res || !res.ok) {
      showToast("Ошибка загрузки: " + ((res && res.error) || "сервер недоступен"), true);
      return;
    }
    if (!res.hasBackup || !res.data) {
      showToast("В облаке пока нет бэкапа", true);
      return;
    }
    const when = res.savedAt ? fmtTime(res.savedAt) : "—";
    const ok = await showConfirm(
      `Восстановить бэкап от ${when}? Данные аккаунтов из бэкапа заменят текущие.`,
      "Облачное сохранение",
    );
    if (!ok) return;
    await importAccountsV2(res.data, { fromCloud: true });
  }

  /** Удаляет облачный бэкап с сервера (действие необратимо). */
  async function cloudDelete() {
    const myId = getMyId();
    const jwt = getToken();
    if (!myId || !jwt) { showToast("Сначала привяжите Telegram", true); return; }
    const ok = await showConfirm(
      "Удалить облачный бэкап? Это действие нельзя отменить.",
      "Облачное сохранение",
    );
    if (!ok) return;
    showToast("Удаляю бэкап…");
    const res = await cloudRequest(
      BOT_API + "/api/backup?duolingoUserId=" + encodeURIComponent(myId),
      { method: "DELETE", headers: { authorization: "Bearer " + jwt } }
    );
    if (res && res.ok) {
      showToast("✓ Бэкап удалён");
      updateCloudBlock();
    } else {
      showToast("Ошибка удаления: " + ((res && res.error) || "сервер недоступен"), true);
    }
  }

  /** Импорт формата v2: мультиаккаунт с опциональным шифрованием JWT. */
  async function importAccountsV2(parsed, opts = {}) {
    const accounts = parsed.accounts || [];
    if (!accounts.length) {
      showToast("Файл не содержит аккаунтов", true);
      return;
    }

    const hasEncrypted = accounts.some((a) => a.jwt_encrypted);
    const hasPlainJwt = accounts.some((a) => a.jwt);
    let password = "";

    if (hasEncrypted) {
      password = await showPasswordPrompt("Введите пароль для расшифровки JWT");
      if (password === null) {
        showToast("Импорт отменён");
        return;
      }
    } else if (hasPlainJwt && !opts.fromCloud) {
      const ok = await showConfirm(
        "Файл содержит JWT без шифрования. Продолжить импорт?",
        "Импорт данных",
      );
      if (!ok) { showToast("Импорт отменён"); return; }
    }

    const store = DATA._store || {};
    store.accounts = store.accounts || {};
    let imported = 0;
    let errors = 0;

    for (const entry of accounts) {
      const id = String(entry.id || "");
      if (!id) continue;
      const acc = store.accounts[id] || emptyAccount();

      // данные
      const d = entry.data || {};
      if (d.settings && typeof d.settings === "object") acc.settings = { ...(acc.settings || {}), ...d.settings };
      if (d.followCache && typeof d.followCache === "object") acc.followCache = d.followCache;
      if (d.me && typeof d.me === "object") acc.me = d.me;
      if (Array.isArray(d.actionLog)) acc.actionLog = d.actionLog;
      if (Array.isArray(d.excludeList)) acc.excludeList = d.excludeList;
      if (Array.isArray(d.blockList)) acc.blockList = d.blockList;
      if (Array.isArray(d.friendSnapshots)) acc.friendSnapshots = d.friendSnapshots;
      if (Array.isArray(d.friendChanges)) acc.friendChanges = d.friendChanges;
      if (d.friendChangesUnread != null) acc.friendChangesUnread = Number(d.friendChangesUnread) || 0;
      if (d.userTags && typeof d.userTags === "object") acc.userTags = d.userTags;
      if (d.stats && typeof d.stats === "object") acc.stats = d.stats;
      if (d.privacySnapshot && typeof d.privacySnapshot === "object") acc.privacySnapshot = d.privacySnapshot;
      acc.username = entry.username || acc.username || "";
      acc.label = entry.label || acc.label || "";
      acc.updatedAt = entry.updatedAt || Date.now();

      // JWT
      if (entry.jwt_encrypted && password) {
        const jwt = await decryptJWT(entry.jwt_encrypted, password);
        if (jwt) acc.jwt = jwt;
        else errors++;
      } else if (entry.jwt) {
        acc.jwt = entry.jwt;
      }

      store.accounts[id] = acc;
      imported++;
    }

    DATA._store = store;
    GM_setValue(STORAGE_KEY, JSON.stringify(store));

    // подгружаем текущий аккаунт если попал в импорт
    const curId = currentAccountId();
    if (store.accounts[curId]) switchAccount(curId);

    saveData();
    syncSwitches();
    refreshUiForAccount();
    showToast(
      errors
        ? `✓ Импортировано ${imported} акк., ${errors} JWT не расшифрованы`
        : `✓ Импортировано ${imported} акк.`,
      errors > 0,
    );
  }

  /** Модалка ввода пароля. Возвращает строку или null (отмена). */
  /** Модалка ввода текста. Возвращает строку или null (отмена). */
  function showPromptPrompt(title, defaultValue) {
    return new Promise((resolve) => {
      if (!shadow) return resolve(null);
      const theme = DATA.settings.theme || "win95";
      const overlay = document.createElement("div");
      overlay.className = "dh-confirm-overlay dh-theme-" + theme;
      overlay.innerHTML = `
        <div class="dh-confirm-box" style="width:340px">
          <div class="dh-confirm-title">${title}</div>
          <div class="dh-confirm-body">
            <input class="dh-input" id="dh-prompt-input" type="text" style="width:100%" value="${(defaultValue || "").replace(/"/g, "&quot;")}" />
          </div>
          <div class="dh-confirm-actions">
            <button class="dh-btn" data-prompt="cancel">Отмена</button>
            <button class="dh-btn dh-btn-primary" data-prompt="ok">OK</button>
          </div>
        </div>`;
      shadow.appendChild(overlay);
      const input = overlay.querySelector("#dh-prompt-input");
      if (input) { input.focus(); input.select(); }
      const close = (val) => { overlay.remove(); resolve(val); };
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
      overlay.querySelector('[data-prompt="cancel"]').addEventListener("click", () => close(null));
      overlay.querySelector('[data-prompt="ok"]').addEventListener("click", () => close(input ? input.value : ""));
      if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") close(input.value); });
    });
  }

  function showPasswordPrompt(title) {
    return new Promise((resolve) => {
      if (!shadow) return resolve(null);
      const theme = DATA.settings.theme || "win95";
      const overlay = document.createElement("div");
      overlay.className = "dh-confirm-overlay dh-theme-" + theme;
      overlay.innerHTML = `
        <div class="dh-confirm-box" style="width:340px">
          <div class="dh-confirm-title">${title}</div>
          <div class="dh-confirm-body">
            <input class="dh-input" id="dh-pass-input" type="password" style="width:100%" />
          </div>
          <div class="dh-confirm-actions">
            <button class="dh-btn" data-pass="cancel">Отмена</button>
            <button class="dh-btn dh-btn-primary" data-pass="ok">OK</button>
          </div>
        </div>`;
      shadow.appendChild(overlay);
      const input = overlay.querySelector("#dh-pass-input");
      if (input) input.focus();
      const close = (val) => { overlay.remove(); resolve(val); };
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
      overlay.querySelector('[data-pass="cancel"]').addEventListener("click", () => close(null));
      overlay.querySelector('[data-pass="ok"]').addEventListener("click", () => close(input ? input.value : ""));
      if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") close(input.value); });
    });
  }

  // ========== FAB recovery (SPA) ==========
  function ensureUI() {
    if (!document.getElementById(HOST_ID) && document.documentElement) {
      createUI();
    }
    ensureBadge();
  }

  // ========== ЗАПУСК ==========
  function init() {
    createUI();
    // sync-stats к боту не должен зависеть от открытия «📊 Статистика»: при заходе и каждые 30 минут
    try { collectStats(); } catch {}
    setInterval(() => { try { collectStats(); } catch {} }, 30 * 60 * 1000);
    hookHistory();
    installHeartsHook();
    syncHeartsFlag();
    installLessonTools();
    syncLessonFlags();
    try { installLeaderboardGaps(); } catch (e) { console.warn("[DH-LB] install failed", e); }
    installXpBoostHook();
    syncXpBoostFlag();
    updateChangesBadge();
    updateListBadges();
    updateTagsBadge();
    syncTagFormFromProfile();
    try {
      const _u = getProfileUsername();
      if (_u && isProfilePage()) mountInlineTag(_u);
    } catch {}
    watchHeartsUi();

    // страховка: сохранить настройки при уходе со страницы
    window.addEventListener("pagehide", () => saveData());
    window.addEventListener("beforeunload", () => saveData());

    // стартовое состояние окна
    applyStartState();

    // продолжение автопрактики после перезагрузки страницы
    try { resumeAutoPractice(); } catch {}

    // SPA может перерисовать body — следим за host и плашкой (с дебаунсом)
    let ensureTimer = null;
    const mo = new MutationObserver(() => {
      if (ensureTimer) return;
      ensureTimer = setTimeout(() => {
        ensureTimer = null;
        ensureUI();
      }, 150);
    });
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    if (isProfilePage()) {
      const u = getProfileUsername();
      if (u) els.userInput.value = u;
      if (u && isOwnProfile(u)) {
        hideBadge();
        setStatus(
          "idle",
          "Это твой профиль",
          "Нельзя быть подписанным на самого себя — проверка не нужна.",
        );
      } else if (DATA.settings.autoCheck) {
        // небольшая задержка — дать странице прогрузиться
        setTimeout(() => runCheck(u), 600);
      }
    } else {
      setStatus(
        "idle",
        "Открой профиль пользователя",
        "Скрипт покажет, подписан ли он на тебя в ответ.",
      );
    }

    refreshMeInfo();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
