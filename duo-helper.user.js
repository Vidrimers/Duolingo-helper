// ==UserScript==
// @name         Duolingo Helper
// @namespace    https://github.com/Vidrimers/Duolingo-helper
// @version      0.5.15
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

  // ========== ХРАНИЛИЩЕ ==========
  function loadData() {
    const raw = GM_getValue(STORAGE_KEY, null);
    const def = {
      settings: {
        autoCheck: true,
        cacheMinutes: 30,
        requestDelay: 350, // мс между запросами (rate limit)
        inactiveDays: 3, // порог «неактивных» друзей
        activitySort: "xp_desc", // сортировка в «Активности»
        showBadge: true,
        badgePos: "top-right",
        accent: "#58cc02",
        winPos: null, // { x, y } — позиция окна после drag
        fabPos: null, // { x, y } — позиция FAB после drag
        openOnStart: false, // открывать панель при загрузке сайта
        theme: "xp", // xp | vista | win95
        protectHearts: true, // блокировать списание сердец
        lessonShortener: false, // укорачивать урок до 1-2 заданий (по умолчанию выкл)
        autoSolver: false, // автосолвер в уроках (по умолчанию выкл)
        fakeXpBoost: false, // фейк XP-буста
        xpBoostMins: 15,
      },
      // username -> { followsMe: true/false, checkedAt: ts, theirId, theirName }
      followCache: {},
      me: null, // { id, username, name }
      actionLog: [], // история отписок/действий для undo
      excludeList: [], // исключения от массовых операций [{userId,username,name}]
      blockList: [], // локальный блок-лист [{userId,username,name,ts}]
      friendSnapshots: [], // [{ ts, following:[ids], followers:[ids] }]
      friendChanges: [], // [{ ts, type, userId, username, name, seen }]
      friendChangesUnread: 0,
    };
    if (!raw) return def;
    try {
      const parsed = JSON.parse(raw);
      return {
        settings: { ...def.settings, ...(parsed.settings || {}) },
        followCache: parsed.followCache || {},
        me: parsed.me || null,
        actionLog: Array.isArray(parsed.actionLog) ? parsed.actionLog : [],
        excludeList: Array.isArray(parsed.excludeList) ? parsed.excludeList : [],
        blockList: Array.isArray(parsed.blockList) ? parsed.blockList : [],
        friendSnapshots: Array.isArray(parsed.friendSnapshots)
          ? parsed.friendSnapshots
          : [],
        friendChanges: Array.isArray(parsed.friendChanges)
          ? parsed.friendChanges
          : [],
        friendChangesUnread: Number(parsed.friendChangesUnread) || 0,
      };
    } catch {
      return def;
    }
  }

  function saveData() {
    GM_setValue(STORAGE_KEY, JSON.stringify(DATA));
  }

  let DATA = loadData();

  // ========== API ==========
  function getToken() {
    const m = document.cookie.match(/(^| )jwt_token=([^;]+)/);
    if (m) {
      try {
        return decodeURIComponent(m[2]);
      } catch {
        return m[2];
      }
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
    const meName = (DATA.me && DATA.me.username ? String(DATA.me.username) : "")
      .toLowerCase()
      .replace(/^@/, "");
    return !!meName && meName === u;
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

            /* ===== Toast ===== */
            .dh-toast {
                position: fixed;
                bottom: 80px;
                left: 50%;
                transform: translateX(-50%) translateY(20px);
                background: linear-gradient(135deg, #1e1e2e, #2a2a3e);
                color: #fff;
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 12px;
                padding: 12px 24px;
                font: 600 14px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                z-index: 2147483647;
                box-shadow: 0 8px 32px rgba(0,0,0,0.4);
                opacity: 0;
                transition: opacity 0.3s, transform 0.3s;
                backdrop-filter: blur(10px);
                max-width: 340px;
                text-align: center;
                pointer-events: none;
            }
            .dh-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
            .dh-toast.error { border-color: #ff4444; }
            .dh-toast.ok { border-color: #58cc02; }

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

            .dh-placeholder {
                color: #666;
                font-size: 11px;
                text-align: center;
                padding: 16px 10px;
                border: 1px dashed #B0A98C;
                border-radius: 2px;
                background: #F5F2E2;
                font-family: Tahoma, sans-serif;
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
            .dh-modal.dh-theme-win95 .dh-placeholder {
                background: #C0C0C0;
                border: 2px solid;
                border-color: #808080 #FFF #FFF #808080;
                border-radius: 0;
                color: #000;
                font-family: inherit;
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

                <div class="dh-card" id="dh-me-card">
                    <div class="dh-card-title">Твой аккаунт</div>
                    <div class="dh-muted" id="dh-me-info">Определение…</div>
                </div>

                <div class="dh-row">
                    <button class="dh-btn dh-btn-ghost" id="dh-recheck-btn">🔄 Перепроверить</button>
                    <button class="dh-btn dh-btn-ghost" id="dh-copy-btn">📋 Копировать</button>
                    <button class="dh-btn dh-btn-ghost" id="dh-refresh-page">🔄 Обновить</button>
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
                        <div class="dh-row" style="margin-top:6px">
                            <button class="dh-btn dh-btn-primary" id="dh-solve-now">Решить сейчас</button>
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
                        <div class="dh-setting-row" style="border-bottom:none;padding:4px 0">
                            <div class="dh-setting-label">
                                Фейк XP-буст (x2)
                                <small>Подмешивает активный буст в ответ API — UI показывает множитель</small>
                            </div>
                            <div class="dh-switch" id="dh-set-xpboost"></div>
                        </div>
                        <div class="dh-row" style="margin:6px 0">
                            <button class="dh-btn" id="dh-xpboost-15">x2 · 15м</button>
                            <button class="dh-btn" id="dh-xpboost-60">x2 · 60м</button>
                        </div>
                        <div class="dh-muted" style="margin-bottom:8px">
                            Накрутка XP (реальное начисление, чит):
                        </div>
                        <div class="dh-row" style="margin-bottom:6px">
                            <input class="dh-num-input" id="dh-xp-amount" type="number" min="1" max="99999" value="500" style="width:72px" />
                            <button class="dh-btn dh-btn-primary" id="dh-xp-stories">Stories</button>
                            <button class="dh-btn dh-btn-danger" id="dh-xp-sessions">Sessions</button>
                            <button class="dh-btn" id="dh-xp-stop">Стоп</button>
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
                            Инъекция прогресса в daily/monthly квесты. Нарушает правила Duolingo.
                        </div>
                        <div class="dh-row" style="margin-bottom:6px">
                            <button class="dh-btn dh-btn-primary" id="dh-quest-daily">Daily</button>
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
                        <div class="dh-muted dh-op-status" id="dh-shop-status"></div>
                        <div id="dh-shop-list" style="margin-top:8px;display:flex;flex-direction:column;gap:6px;max-height:260px;overflow-y:auto"></div>
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
                            <button class="dh-btn" id="dh-gems-stop">Стоп</button>
                        </div>
                        <div class="dh-muted dh-op-status" id="dh-gems-status"></div>
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

                <div class="dh-placeholder">
                    🔜 Дальше: Free Max,<br/>
                    аккаунты, privacy
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
                        Открывать панель при загрузке
                        <small>UI будет раскрыт сразу при заходе на Duolingo</small>
                    </div>
                    <div class="dh-switch" id="dh-set-open"></div>
                </div>
                <div class="dh-setting-row">
                    <div class="dh-setting-label">
                        Тема окна
                        <small>WinXP / Vista / Win95</small>
                    </div>
                    <div class="dh-theme-picker" id="dh-theme-picker">
                        <button class="dh-theme-btn" data-theme="xp">WinXP</button>
                        <button class="dh-theme-btn" data-theme="vista">Vista</button>
                        <button class="dh-theme-btn" data-theme="win95">Win95</button>
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
            </div>
        </div>
        <div class="dh-footer">
            <a class="dh-donate-link" href="https://vidrimers.online/donate" target="_blank" rel="noopener">Поддержать проект</a>
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
      themePicker: modal.querySelector("#dh-theme-picker"),
      themeBtns: [...modal.querySelectorAll(".dh-theme-btn")],
      setHearts: modal.querySelector("#dh-set-hearts"),
      heartsStatus: modal.querySelector("#dh-hearts-status"),
      setShort: modal.querySelector("#dh-set-short"),
      setSolver: modal.querySelector("#dh-set-solver"),
      solveNow: modal.querySelector("#dh-solve-now"),
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
      questLoad: modal.querySelector("#dh-quest-load"),
      questClaimAll: modal.querySelector("#dh-quest-claim-all"),
      questStatus: modal.querySelector("#dh-quest-status"),
      questList: modal.querySelector("#dh-quest-list"),
      shopLoad: modal.querySelector("#dh-shop-load"),
      shopSuper: modal.querySelector("#dh-shop-super"),
      shopStatus: modal.querySelector("#dh-shop-status"),
      shopList: modal.querySelector("#dh-shop-list"),
      gemsOnce: modal.querySelector("#dh-gems-once"),
      gemsFarm: modal.querySelector("#dh-gems-farm"),
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
      blocksList: modal.querySelector("#dh-blocks-list"),
      blocksBadge: modal.querySelector("#dh-blocks-badge"),
      clearCache: modal.querySelector("#dh-clear-cache"),
      refreshPage: modal.querySelector("#dh-refresh-page"),
      exportBtn: modal.querySelector("#dh-export"),
      importBtn: modal.querySelector("#dh-import"),
      importFile: modal.querySelector("#dh-import-file"),
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
    initUpdateCheck();
  }

  // ========== Theme ==========
  function applyTheme() {
    if (!els.modal) return;
    const theme = DATA.settings.theme || "xp";
    els.modal.classList.remove("dh-theme-xp", "dh-theme-vista", "dh-theme-win95");
    els.modal.classList.add("dh-theme-" + theme);
    if (els.themeBtns) {
      els.themeBtns.forEach((b) => {
        b.classList.toggle("active", b.dataset.theme === theme);
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

  function syncLessonFlags() {
    const shortOn = !!DATA.settings.lessonShortener;
    const solveOn = !!DATA.settings.autoSolver;
    try {
      localStorage.setItem(LESSON_LS_SHORT, shortOn ? "true" : "false");
      localStorage.setItem(LESSON_LS_SOLVER, solveOn ? "true" : "false");
    } catch {}
    if (els.setShort) els.setShort.classList.toggle("on", shortOn);
    if (els.setSolver) els.setSolver.classList.toggle("on", solveOn);
    if (els.lessonStatus) {
      els.lessonStatus.textContent =
        "короткие уроки: " +
        (shortOn ? "вкл" : "выкл") +
        " · автосолвер: " +
        (solveOn ? "вкл" : "выкл");
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

  /** Daily: закидываем недостающие метрики. */
  async function runDailyQuests() {
    const btn = els.questDaily;
    if (btn) btn.disabled = true;
    setQuestStatus("Загрузка daily…");
    try {
      const { schema, progressRes, tz, myId } = await fetchQuestData();
      const earned = new Set(
        (progressRes.badges && progressRes.badges.earned) || [],
      );
      const daily = (schema.goals || []).filter(
        (g) => g.category && g.category.includes("DAILY"),
      );
      const metrics = [
        ...new Set(
          daily
            .filter(
              (g) =>
                !earned.has(g.badgeId) &&
                !earned.has(g.goalId) &&
                g.metric &&
                g.metric !== "QUESTS",
            )
            .map((g) => g.metric),
        ),
      ];
      if (!metrics.length) {
        setQuestStatus("Daily уже выполнены");
        showToast("Daily квесты уже выполнены");
        return;
      }
      setQuestStatus("Инъекция " + metrics.length + " метрик…");
      const updates = metrics.map((m) => ({ metric: m, quantity: 2000 }));
      updates.push({ metric: "QUESTS", quantity: 1 });
      const res = await postGoalBatch(updates, new Date().toISOString(), tz, myId);
      if (res.status === 200) {
        setQuestStatus("Daily: готово (" + metrics.length + ")");
        showToast("✓ Daily квесты выполнены");
      } else {
        setQuestStatus("Daily: ошибка " + res.status);
        showToast("Ошибка daily: HTTP " + res.status, true);
      }
    } catch (e) {
      setQuestStatus("Ошибка: " + (e && e.message));
      showToast(e && e.message ? e.message : "Ошибка квестов", true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function renderMonthlyList(items) {
    if (!els.questList) return;
    els.questList.innerHTML = "";
    if (!items.length) {
      els.questList.innerHTML =
        '<div class="dh-muted">Нет незакрытых monthly-квестов</div>';
      return;
    }
    for (const it of items) {
      const row = document.createElement("div");
      row.className = "dh-setting-row";
      row.style.borderBottom = "none";
      row.style.padding = "4px 0";
      row.innerHTML =
        `<div class="dh-setting-label" style="min-width:0">
            <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${it.title}</div>
            <small>${it.progress} / ${it.target} · ${it.metric}</small>
        </div>
        <button class="dh-btn" style="padding:4px 10px;font-size:11px">GET</button>`;
      const b = row.querySelector("button");
      b.addEventListener("click", async () => {
        b.disabled = true;
        b.textContent = "…";
        const ok = await claimMonthlyOne(it);
        b.textContent = ok ? "✓" : "ERR";
        if (ok) {
          showToast("✓ " + it.title);
          setTimeout(() => loadMonthlyQuests(), 900);
        }
      });
      els.questList.appendChild(row);
    }
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

  let monthlyCache = null;

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
    const payload = {
      metric_updates: [{ metric: item.metric, quantity: item.amount }],
      timestamp: ts,
      timezone: tz,
    };
    // Duolingo иногда требует второй вызов для выдачи бейджа
    const r1 = await postGoalBatch(payload.metric_updates, ts, tz, myId);
    if (r1.status !== 200) return false;
    await new Promise((r) => setTimeout(r, 800));
    const r2 = await postGoalBatch(payload.metric_updates, ts, tz, myId);
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

  function renderShopItems(items) {
    if (!els.shopList) return;
    els.shopList.innerHTML = "";
    const valid = items.filter(
      (i) => (i.currencyType === "XGM" || !i.currencyType) && !(i.id || "").includes("gift"),
    );
    if (!valid.length) {
      els.shopList.innerHTML = '<div class="dh-muted">Нет предметов</div>';
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
      const group = valid.filter((i) => {
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
      for (const item of group) {
        const info = describeShopItem(item);
        const row = document.createElement("div");
        row.className = "dh-setting-row";
        row.style.borderBottom = "none";
        row.style.padding = "3px 0";
        row.innerHTML = `<div class="dh-setting-label" style="min-width:0">
            <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${info.name}</div>
            <small>${info.desc}</small>
        </div>
        <button class="dh-btn" style="padding:4px 10px;font-size:11px">GET</button>`;
        const b = row.querySelector("button");
        b.addEventListener("click", async () => {
          b.disabled = true;
          b.textContent = "…";
          const ok = await buyShopItem(item.id);
          b.textContent = ok ? "✓" : "ERR";
          showToast(ok ? "✓ " + info.name : "Не удалось: " + info.name, !ok);
          setTimeout(() => {
            b.disabled = false;
            b.textContent = "GET";
          }, 2500);
        });
        els.shopList.appendChild(row);
      }
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
      row.className = "dh-setting-row";
      row.style.borderBottom = "none";
      row.style.padding = "3px 0";
      row.style.background = me ? "rgba(88,204,2,0.12)" : "transparent";
      row.style.borderRadius = "6px";
      const gap = Number(u.score || 0) - myScore;
      const gapTxt = me
        ? "это ты"
        : gap > 0
          ? "+" + gap
          : String(gap);
      row.innerHTML = `<div class="dh-setting-label" style="min-width:0">
          <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            #${i + 1} ${u.display_name || u.name || u.username || u.user_id}
          </div>
          <small>${Number(u.score || 0)} XP · ${gapTxt}${u.is_promoted ? " · ↑" : ""}${u.is_demoted ? " · ↓" : ""}</small>
        </div>`;
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
        const above = targetRank >= 2 ? rankings[targetRank - 2] : null;
        const targetScore = above ? Number(above.score || 0) + 50 : 50;
        const myScore = me ? Number(me.score || 0) : 0;

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
  let friendsCache = null;
  let friendFilter = "all";

  function setFriendsStatus(t) {
    if (els.friendsStatus) els.friendsStatus.textContent = t;
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
      const label =
        item.type === "unfollow_mass"
          ? `Отписка от неподписанных ❌ (${(item.ids || []).length})`
          : item.type === "block_mass"
            ? `Блокировка неактивных (${(item.ids || []).length})`
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
    setFriendsStatus("История действий");
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
    setFriendsStatus("Изменений: " + changes.length);
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

    const add = (kind, dir, id, meta) => {
      DATA.friendChanges.unshift({
        ts: now,
        kind,
        dir,
        userId: id,
        username: (meta && meta.username) || "",
        name: (meta && (meta.displayName || meta.name || meta.username)) || id,
        seen: false,
      });
      DATA.friendChangesUnread = (DATA.friendChangesUnread || 0) + 1;
    };

    if (prev) {
      // 1) кто-то отписался от меня (только если это НЕ моя блокировка/отписка)
      for (const id of prevFollowers) {
        if (curFollowers.has(id)) continue;
        if (myBlockIds.has(id) || myUnfollowIds.has(id)) continue;
        const meta = prev.followersMeta && prev.followersMeta[id];
        add("unfollowed_me", "minus", id, meta);
      }
      // подписался на меня
      for (const [id, u] of curFollowers) {
        if (!prevFollowers.has(id)) add("followed_me", "plus", id, u);
      }
      // 2) исчез из моих подписок — классифицируем по действиям
      for (const id of prevFollowing) {
        if (curFollowing.has(id)) continue;
        const meta = prev.followingMeta && prev.followingMeta[id];
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
    const daysLimit = DATA.settings.inactiveDays || 3;
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
    const daysLimit = DATA.settings.inactiveDays || 3;
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
      row.innerHTML = `<div class="dh-setting-label" style="min-width:0">
          <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            ${icon} ${r.name || sub}${deadIcon}${excludedIcon}
          </div>
          <small>${sub}</small>
        </div>
        <button class="dh-btn" data-exclude="1" title="${isExcluded(r.userId) ? "Убрать из исключений" : "В исключения (не трогать при массовых действиях)"}" style="padding:4px 7px;font-size:11px;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center">${isExcluded(r.userId) ? "🛡✓" : "🛡"}</button>
        <button class="dh-btn" data-block="1" title="Заблокировать" style="padding:4px 8px;font-size:13px;line-height:1;flex-shrink:0;width:30px;display:inline-flex;align-items:center;justify-content:center">🚫</button>
        <button class="dh-btn" data-unfollow="1" title="Отписаться" style="padding:4px 8px;font-size:13px;line-height:1;flex-shrink:0;width:30px;display:inline-flex;align-items:center;justify-content:center">×</button>`;
      row.addEventListener("click", (e) => {
        if (e.target && e.target.closest && e.target.closest("[data-unfollow],[data-exclude],[data-block]")) return;
        const u = r.username || r.name;
        if (u) window.open("https://www.duolingo.com/profile/" + encodeURIComponent(u), "_blank");
      });
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
    const daysLimit = DATA.settings.inactiveDays || 3;
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
        const daysLimit = DATA.settings.inactiveDays || 3;

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
          const sr = await sessionRequest("POST", "https://www.duolingo.com/2017-06-30/sessions", {
            challengeTypes: [],
            fromLanguage: langs.fromLanguage,
            learningLanguage: langs.learningLanguage,
            type: "UNIT_TEST",
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
                heartsLeft: 0,
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
              got = Number((ur.body && (ur.body.awardedXp || ur.body.xpGain)) || 110);
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
      const theme = DATA.settings.theme || "xp";
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

  // ========== Toast ==========
  function showToast(msg, isError = false) {
    if (!shadow) return;
    const t = document.createElement("div");
    t.className = "dh-toast" + (isError ? " error" : " ok");
    t.textContent = msg;
    shadow.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => t.remove(), 350);
    }, 2800);
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
    return true;
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

  function onNavigate() {
    const path = location.pathname;
    if (path === lastPath) return;
    lastPath = path;

    if (isProfilePage()) {
      const u = getProfileUsername();
      els.userInput.value = u || "";
      if (u && isOwnProfile(u)) {
        hideBadge();
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
    DATA.settings.winPos = {
      x: parseInt(els.modal.style.left, 10) || 0,
      y: parseInt(els.modal.style.top, 10) || 0,
    };
    saveData();
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
    const p = clampFabPos(saved.x, saved.y);
    els.fab.style.left = p.x + "px";
    els.fab.style.top = p.y + "px";
    els.fab.style.bottom = "auto";
  }

  function saveFabPos() {
    if (!els.fab) return;
    DATA.settings.fabPos = {
      x: parseInt(els.fab.style.left, 10) || 0,
      y: parseInt(els.fab.style.top, 10) || 0,
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
        els.modal.classList.toggle("open");
        if (els.modal.classList.contains("open")) {
          refreshMeInfo();
          const u = getProfileUsername() || els.userInput.value;
          if (u && !els.userInput.value) els.userInput.value = u;
        }
      });
    }

    els.badge.addEventListener("click", () => {
      els.modal.classList.add("open");
      refreshMeInfo();
    });

    els.closeBtn.addEventListener("click", () => els.modal.classList.remove("open"));
    els.minBtn.addEventListener("click", () => els.modal.classList.remove("open"));

    if (els.resetPosBtn) {
      els.resetPosBtn.addEventListener("click", () => {
        DATA.settings.winPos = null;
        saveData();
        applyWinPos();
        showToast("Позиция окна сброшена");
      });
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
    const syncSwitches = () => {
      els.setAuto.classList.toggle("on", !!DATA.settings.autoCheck);
      els.setBadge.classList.toggle("on", !!DATA.settings.showBadge);
      if (els.setOpen) els.setOpen.classList.toggle("on", !!DATA.settings.openOnStart);
      els.setCache.value = DATA.settings.cacheMinutes;
      if (els.setDelay) els.setDelay.value = DATA.settings.requestDelay;
      if (els.setInactive) els.setInactive.value = DATA.settings.inactiveDays;
    };
    syncSwitches();

    els.setAuto.addEventListener("click", () => {
      DATA.settings.autoCheck = !DATA.settings.autoCheck;
      saveData();
      syncSwitches();
    });

    els.setBadge.addEventListener("click", () => {
      DATA.settings.showBadge = !DATA.settings.showBadge;
      saveData();
      syncSwitches();
      if (!DATA.settings.showBadge) hideBadge();
      else onNavigate();
    });

    if (els.setOpen) {
      els.setOpen.addEventListener("click", () => {
        DATA.settings.openOnStart = !DATA.settings.openOnStart;
        saveData();
        syncSwitches();
        showToast(
          DATA.settings.openOnStart
            ? "Панель будет открываться при загрузке"
            : "Панель будет закрытой при загрузке",
        );
      });
    }

    if (els.themeBtns && els.themeBtns.length) {
      els.themeBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
          DATA.settings.theme = btn.dataset.theme || "xp";
          saveData();
          applyTheme();
        });
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
    if (els.solveNow) {
      els.solveNow.addEventListener("click", () => solveNow());
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
    if (els.shopSuper) {
      els.shopSuper.addEventListener("click", () => buySuper3Days());
    }

    if (els.gemsOnce) {
      els.gemsOnce.addEventListener("click", () => claimGemsOnce());
    }
    if (els.gemsFarm) {
      els.gemsFarm.addEventListener("click", () => farmGems());
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
    if (els.historyOpen) {
      els.historyOpen.addEventListener("click", () => showHistoryView());
    }
    if (els.changesOpen) {
      els.changesOpen.addEventListener("click", () => showChangesView());
    }
    if (els.historyBack) {
      els.historyBack.addEventListener("click", () => showFriendsView());
    }

    els.setCache.addEventListener("change", () => {
      const v = Math.max(1, Math.min(1440, parseInt(els.setCache.value, 10) || 30));
      DATA.settings.cacheMinutes = v;
      els.setCache.value = v;
      saveData();
    });

    if (els.setDelay) {
      els.setDelay.addEventListener("change", () => {
        const v = Math.max(0, Math.min(5000, parseInt(els.setDelay.value, 10) || 0));
        DATA.settings.requestDelay = v;
        els.setDelay.value = v;
        saveData();
      });
    }
    if (els.setInactive) {
      els.setInactive.addEventListener("change", () => {
        const v = Math.max(1, Math.min(365, parseInt(els.setInactive.value, 10) || 3));
        DATA.settings.inactiveDays = v;
        els.setInactive.value = v;
        saveData();
        renderFriends();
      });
    }
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

    els.exportBtn.addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(DATA, null, 2)], {
        type: "application/json",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "duolingo-helper-data.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });

    // ===== Import =====
    if (els.importBtn && els.importFile) {
      els.importBtn.addEventListener("click", () => els.importFile.click());
      els.importFile.addEventListener("change", () => {
        const file = els.importFile.files && els.importFile.files[0];
        els.importFile.value = "";
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const parsed = JSON.parse(String(reader.result || ""));
            if (!parsed || typeof parsed !== "object") {
              throw new Error("bad format");
            }
            // мержим: настройки поверх текущих, кеш — заменой
            if (parsed.settings && typeof parsed.settings === "object") {
              DATA.settings = { ...DATA.settings, ...parsed.settings };
            }
            if (parsed.followCache && typeof parsed.followCache === "object") {
              DATA.followCache = parsed.followCache;
            }
            if (parsed.me && typeof parsed.me === "object") {
              DATA.me = parsed.me;
            }
            saveData();
            syncSwitches();
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
    hookHistory();
    installHeartsHook();
    syncHeartsFlag();
    installLessonTools();
    syncLessonFlags();
    installXpBoostHook();
    syncXpBoostFlag();
    updateChangesBadge();
    updateListBadges();
    watchHeartsUi();

    // открыть панель сразу, если включено в настройках
    if (DATA.settings.openOnStart && els.modal) {
      els.modal.classList.add("open");
    }

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
