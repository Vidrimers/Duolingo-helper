// ==UserScript==
// @name         Duolingo Helper
// @namespace    https://github.com/Vidrimers/Duolingo-helper
// @version      0.2.9
// @description  Проверка взаимной подписки на профилях Duolingo. Панель, бейджи, кеш.
// @author       Vidrimers
// @match        *://*.duolingo.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_listValues
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @connect      cdn.jsdelivr.net
// @connect      api.github.com
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
        showBadge: true,
        badgePos: "top-right",
        accent: "#58cc02",
        winPos: null, // { x, y } — позиция окна после drag
        openOnStart: false, // открывать панель при загрузке сайта
      },
      // username -> { followsMe: true/false, checkedAt: ts, theirId, theirName }
      followCache: {},
      me: null, // { id, username, name }
    };
    if (!raw) return def;
    try {
      const parsed = JSON.parse(raw);
      return {
        settings: { ...def.settings, ...(parsed.settings || {}) },
        followCache: parsed.followCache || {},
        me: parsed.me || null,
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
            }
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
                overflow-y: auto;
                padding: 10px 12px 12px;
                background: #ECE9D8;
                display: flex;
                flex-direction: column;
                gap: 10px;
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

            .dh-tab-content { display: none; flex-direction: column; gap: 10px; }
            .dh-tab-content.active { display: flex; }

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
            }
            .dh-footer .dh-btn { flex: 1; text-align: center; padding: 6px 10px; }

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
            <span class="dh-chip">v0.2</span>
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

            <div class="dh-tab-content" data-tab="tools">
                <div class="dh-placeholder">
                    🔜 Здесь появятся функции:<br/>
                    • защита сердец<br/>
                    • массовое удаление друзей<br/>
                    • массовая отписка от тех, кто не подписан в ответ<br/>
                    • и другие инструменты
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
                        Кеш (минут)
                        <small>Не перезапрашивать API, пока результат свежий</small>
                    </div>
                    <input class="dh-num-input" id="dh-set-cache" type="number" min="1" max="1440" />
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
      tabs: [...modal.querySelectorAll(".dh-tab")],
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
      setCache: modal.querySelector("#dh-set-cache"),
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
    };

    bindEvents();
    initDrag();
    applyWinPos();
    initUpdateCheck();
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
    if (!u) return;

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
  const CURRENT_VERSION = "0.2.9";
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
    showToast(`Установи обновление в Tampermonkey. Перезагрузка через ${left}…`);
    const tick = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(tick);
        location.reload();
        return;
      }
      showToast(`Перезагрузка через ${left}… (установи обновление в Tampermonkey)`);
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
    if (els.currentVersion) els.currentVersion.textContent = "v" + CURRENT_VERSION;
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

  // ========== Events ==========
  function bindEvents() {
    els.fab.addEventListener("click", () => {
      els.modal.classList.toggle("open");
      if (els.modal.classList.contains("open")) {
        refreshMeInfo();
        const u = getProfileUsername() || els.userInput.value;
        if (u && !els.userInput.value) els.userInput.value = u;
      }
    });

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

    els.setCache.addEventListener("change", () => {
      const v = Math.max(1, Math.min(1440, parseInt(els.setCache.value, 10) || 30));
      DATA.settings.cacheMinutes = v;
      els.setCache.value = v;
      saveData();
    });

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
      if (DATA.settings.autoCheck) {
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
