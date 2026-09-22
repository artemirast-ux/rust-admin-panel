const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

let currentView = "dashboard";
let currentUser = null;
let pollTimer = null;

const REPORT_REASONS = ["Cheat", "Macros", "Abuse"];

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btnLogin").addEventListener("click", doLogin);
  document.getElementById("btnLogout").addEventListener("click", doLogout);
  document.getElementById("password").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin();
  });

  document.querySelectorAll(".nav-link").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      switchView(link.dataset.view);
    });
  });

  document.getElementById("modal").addEventListener("click", (e) => {
    if (e.target.id === "modal") closeModal();
  });

  document.getElementById("btnCheckIp").addEventListener("click", () => {
    const ip = document.getElementById("ipInput").value.trim();
    if (ip) checkIp(ip);
  });

  const ps = document.getElementById("playersSearch");
  if (ps) {
    ps.addEventListener("input", (e) => {
      playersQuery = e.target.value;
      renderPlayers();
    });
  }

  document.querySelectorAll("[data-htab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.dataset.htab;
      document.querySelectorAll("[data-htab]").forEach((t) => t.classList.toggle("active", t === tab));
      document.querySelectorAll(".htab").forEach((h) => h.classList.toggle("active", h.id === "hist-" + name));
      loadHistoryTab(name);
    });
  });

  document.getElementById("btnCheckSend").addEventListener("click", sendCheckMessage);
  document.getElementById("btnCheckClose").addEventListener("click", closeCheckModal);
  document.getElementById("btnCheckShow").addEventListener("click", showCheckTable);
  document.getElementById("btnCheckClean").addEventListener("click", () => checkVerdict("clean"));
  document.getElementById("btnCheckBan").addEventListener("click", () => checkVerdict("banned"));
  document.getElementById("checkInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendCheckMessage();
  });

  document.getElementById("btnBroadcast").addEventListener("click", () => {
    const msg = document.getElementById("broadcastInput").value.trim();
    if (msg) sendBroadcast(msg);
  });
  document.getElementById("broadcastInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const msg = e.target.value.trim();
      if (msg) sendBroadcast(msg);
    }
  });

  document.querySelectorAll("[data-ctab]").forEach((tab) => {
    tab.addEventListener("click", () => setChatTab(tab.dataset.ctab));
  });

  const cs = document.getElementById("chatSearch");
  if (cs) {
    cs.addEventListener("input", (e) => {
      chatSearchQuery = e.target.value;
      renderChatPeers();
    });
  }

  const btnPmChat = document.getElementById("btnPmChatSend");
  if (btnPmChat) {
    btnPmChat.addEventListener("click", sendPmChat);
  }
  const pmChatIn = document.getElementById("pmChatInput");
  if (pmChatIn) {
    pmChatIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendPmChat();
    });
  }

  document.getElementById("btnPmSend").addEventListener("click", sendPm);

  const ec = document.getElementById("btnExportChat");
  if (ec) {
    ec.addEventListener("click", exportChatLogs);
  }

  const bind = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", fn);
  };
  bind("btnFlagPlayer", () => switchView("players"));
  bind("btnCreateReport", () => alert("Репорты создаются игроками в игре (команда /report или клавиша F7). Здесь они появляются автоматически."));
  bind("btnStartCheck", () => switchView("players"));
  bind("btnAddBan", () => switchView("players"));
  bind("btnAddMute", () => switchView("players"));
  bind("btnConnectServer", () => alert("Установите плагин RustAdminPanel.cs на сервер и пропишите URL проекта и секретный ключ в oxide/config/RustAdminPanel.json — сервер появится здесь автоматически."));
  bind("btnInviteStaff", () => alert("Добавьте сотрудника в Supabase: Authentication → Users → Add user, затем вставьте его email в таблицу admins (role: owner/admin/moderator/support)."));
  bind("btnExportAudit", exportAudit);

  // Any <th class="sortable" data-view data-key data-label> re-sorts its table.
  document.addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (th && th.dataset.view) toggleSort(th.dataset.view, th.dataset.key);
  });

  document.querySelectorAll("#playersChips .chip").forEach((c) => {
    c.addEventListener("click", () => {
      playersFilter = c.dataset.pf;
      document.querySelectorAll("#playersChips .chip").forEach((x) => x.classList.toggle("active", x === c));
      renderPlayers();
    });
  });

  document.querySelectorAll("#reportsChips .chip").forEach((c) => {
    c.addEventListener("click", () => {
      reportsFilter = c.dataset.rf;
      document.querySelectorAll("#reportsChips .chip").forEach((x) => x.classList.toggle("active", x === c));
      renderReports();
    });
  });

  [["mtOnline", "online"], ["mtOffline", "offline"], ["mtSleepers", "sleepers"]].forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => { mapToggles[key] = el.checked; renderMap(); });
  });
  const mapSizeSel = document.getElementById("mapSize");
  if (mapSizeSel) {
    const saved = loadSettings().mapSize || 6000;
    mapSizeSel.value = String(saved);
    WORLD_SIZE = saved;
    mapSizeSel.addEventListener("change", () => {
      WORLD_SIZE = parseInt(mapSizeSel.value, 10) || 6000;
      saveSettings({ mapSize: WORLD_SIZE });
      renderMap();
    });
  }

  bindAnticheatSettings();
  const acSave = document.getElementById("btnAcSave");
  if (acSave) acSave.addEventListener("click", saveAnticheatSettings);
  const acReset = document.getElementById("btnAcReset");
  if (acReset) {
    acReset.addEventListener("click", () => {
      saveSettings({ anticheat: JSON.parse(JSON.stringify(AC_DEFAULTS)) });
      bindAnticheatSettings();
      loadAnticheat();
    });
  }

  bindSettings();
  document.getElementById("pmText").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendPm();
  });
  document.getElementById("btnMuteConfirm").addEventListener("click", confirmMute);

  checkSession();
});

async function checkSession() {
  const { data, error } = await sb.auth.getSession();
  if (error || !data.session) {
    showLogin();
    return;
  }
  currentUser = data.session.user;
  showApp();
}

async function doLogin() {
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const errEl = document.getElementById("loginError");
  errEl.textContent = "";

  if (!email || !password) {
    errEl.textContent = "Введите email и пароль";
    return;
  }

  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    errEl.textContent = "Ошибка входа: " + error.message;
    return;
  }
  currentUser = data.user;
  showApp();
}

async function doLogout() {
  await sb.auth.signOut();
  currentUser = null;
  showLogin();
}

function showLogin() {
  document.getElementById("loginScreen").classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
  document.getElementById("email").value = "";
  document.getElementById("password").value = "";
}

function showApp() {
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  document.getElementById("userEmail").textContent = currentUser.email;
  switchView("dashboard");
  startPolling();
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  refreshAll();
  pollTimer = setInterval(refreshAll, 10000);
}

function switchView(view) {
  currentView = view;
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  const section = document.getElementById("view-" + view);
  if (section) section.classList.add("active");

  document.querySelectorAll(".nav-link").forEach((l) => {
    l.classList.toggle("active", l.dataset.view === view);
  });
  refreshAll();
}

async function refreshAll() {
  loadServerStatus();
  loadDashboard();

  if (currentView === "players") loadPlayers();
  if (currentView === "reports") loadReports();
  if (currentView === "checks") loadChecks();
  if (currentView === "bans") loadBans();
  if (currentView === "mutes") loadMutes();
  if (currentView === "chat") loadChat();
  if (currentView === "killanalysis") loadKillAnalysis();
  if (currentView === "anticheat") loadAnticheat();
  if (currentView === "history") loadHistoryTab();
  if (currentView === "ipchecks") loadIpChecks();
  if (currentView === "map") loadMap();
  if (currentView === "sleepers") loadSleepers();
  if (currentView === "alerts") loadAlerts();
  if (currentView === "stats") loadStats();
  if (currentView === "audit") loadAudit();
  if (currentView === "staff") loadStaff();
  if (currentView === "servers") loadServers();
}

/* ---------- Sortable tables ---------- */

// viewKey -> { key, dir }
const tableSorts = {};
// viewKey -> raw rows as fetched from Supabase (before sorting / filtering)
const tableCache = {};
// viewKey -> { columnKey: row => comparable value }
const SORT_GETTERS = {};
// viewKey -> () => re-renders tableCache[viewKey] back into the DOM
const SORT_RENDER = {};

// Returns rows re-ordered by the active sort for that view (or unchanged).
function sortedRows(viewKey, rows) {
  const st = tableSorts[viewKey];
  if (!st) return rows;
  const get = (SORT_GETTERS[viewKey] || {})[st.key];
  if (!get) return rows;
  const dir = st.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = get(a);
    const vb = get(b);
    if (va === vb) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
    return String(va).localeCompare(String(vb), "ru", { numeric: true, sensitivity: "base" }) * dir;
  });
}

// Click on a <th class="sortable"> flips the sort (or picks a new column) and
// re-renders the table from cache, without hitting Supabase again.
function toggleSort(viewKey, key) {
  const st = tableSorts[viewKey];
  if (st && st.key === key) {
    st.dir = st.dir === "asc" ? "desc" : "asc";
  } else {
    tableSorts[viewKey] = { key, dir: "desc" };
  }
  paintSortArrows(viewKey);
  if (SORT_RENDER[viewKey]) SORT_RENDER[viewKey]();
}

// Writes ▲/▼ into the headers of one table so the active sort is visible.
function paintSortArrows(viewKey) {
  const st = tableSorts[viewKey];
  document.querySelectorAll('th.sortable[data-view="' + viewKey + '"]').forEach((th) => {
    const active = st && st.key === th.dataset.key;
    th.classList.toggle("sorted", !!active);
    th.textContent = active
      ? th.dataset.label + " " + (st.dir === "asc" ? "▲" : "▼")
      : th.dataset.label;
  });
}

/* ---------- Server status ---------- */

async function loadServerStatus() {
  const { data } = await sb.from("server_status").select("*").eq("id", 1).maybeSingle();
  const el = document.getElementById("serverInfo");
  if (!data) {
    el.innerHTML = '<span class="tag muted">сервер не в сети</span>';
    return;
  }
  const ago = Math.round((Date.now() - new Date(data.last_heartbeat).getTime()) / 1000);
  const online = ago < 90;
  el.innerHTML = `
    <span class="dot ${online ? "on" : "off"}"></span>
    <b>${esc(data.hostname) || "Rust Server"}</b>
    <span class="sep">·</span> игроков: <b>${data.players_online}/${data.max_players}</b>
    <span class="sep">·</span> FPS: <b>${data.fps}</b>
    ${online ? "" : `<span class="tag warn" style="margin-left:8px">нет связи ${ago}с</span>`}`;
}

/* ---------- Dashboard ---------- */

async function loadDashboard() {  // NOTE: with head:true the count comes back NEXT TO data (as .count),
  // not inside it. Reading data?.count always yields 0.
  // NOTE: players/sleepers have no "id" column (primary key is steamid), so a
  // count via select("id") would 400 and silently return 0.
  const [
    { count: cOnline },
    { count: cBans },
    { count: cReports },
    { count: cMutes },
  ] = await Promise.all([
    sb.from("players").select("steamid", { count: "exact", head: true }).eq("online", true),
    sb.from("bans").select("id", { count: "exact", head: true }).eq("active", true),
    sb.from("reports").select("id", { count: "exact", head: true }).eq("status", "pending"),
    sb.from("mutes").select("id", { count: "exact", head: true }).eq("active", true),
  ]);

  const { count: cVpn } = await sb.from("players").select("steamid", { count: "exact", head: true }).eq("online", true).eq("is_vpn", true);
  const { count: cChecks } = await sb.from("checks").select("id", { count: "exact", head: true }).eq("status", "active");

  const cards = [
    { label: "Игроков онлайн", value: cOnline ?? 0, cls: "" },
    { label: "С VPN", value: cVpn ?? 0, cls: "vpn" },
    { label: "Активных банов", value: cBans ?? 0, cls: "danger" },
    { label: "Репортов в очереди", value: cReports ?? 0, cls: "warn" },
    { label: "Активных мутов", value: cMutes ?? 0, cls: "" },
    { label: "Идёт проверок", value: cChecks ?? 0, cls: "warn" },
  ];

  document.getElementById("statCards").innerHTML = cards
    .map(
      (c) =>
        `<div class="stat-card"><div class="label ${c.cls}">${c.label}</div><div class="value">${c.value}</div></div>`
    )
    .join("");

  const badge = document.getElementById("reportsBadge");
  const pending = cReports ?? 0;
  badge.textContent = pending;
  badge.classList.toggle("hidden", pending === 0);

  const chkBadge = document.getElementById("checksBadge");
  const activeCount = cChecks ?? 0;
  chkBadge.textContent = activeCount;
  chkBadge.classList.toggle("hidden", activeCount === 0);

  const { count: cAlerts } = await sb.from("alerts").select("created_at", { count: "exact", head: true });
  const alBadge = document.getElementById("alertsBadge");
  const alCount = cAlerts ?? 0;
  alBadge.textContent = alCount;
  alBadge.classList.toggle("hidden", alCount === 0);

  loadOnlineChart();

  // Live feed: latest alerts (VPN, reports, bans, checks).
  const { data: feed } = await sb
    .from("alerts")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(10);

  document.getElementById("liveFeed").innerHTML = feed?.length
    ? feed
        .map((a) => {
          const m = ALERT_META[a.kind] || { icon: "ℹ", cls: "muted" };
          return `<div class="chat-line"><span class="who">${m.icon} ${esc(a.kind)}</span>${esc(a.text)}<span class="time">${fmtTime(a.created_at)}</span></div>`;
        })
        .join("")
    : '<div class="empty">Событий пока нет</div>';

  const { data: recentReports } = await sb
    .from("reports")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(8);

  document.getElementById("recentReports").innerHTML = recentReports?.length
    ? recentReports
        .map(
          (r) =>
            `<div class="chat-line"><span class="who">${esc(r.target_name) || r.target_steamid}</span>${esc(r.reason)}<span class="time">${fmtTime(r.created_at)}</span></div>`
        )
        .join("")
    : '<div class="empty">Нет репортов</div>';

  const { data: recentConn } = await sb
    .from("connection_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(8);

  document.getElementById("recentConnections").innerHTML = recentConn?.length
    ? recentConn
        .map(
          (c) =>
            `<div class="chat-line"><span class="tag ${c.type === "join" ? "ok" : "muted"}">${c.type === "join" ? "зашёл" : "вышел"}</span> ${esc(c.name)} <span class="mono">${esc(c.ip)}</span><span class="time">${fmtTime(c.created_at)}</span></div>`
        )
        .join("")
    : '<div class="empty">Нет подключений</div>';
}

/* ---------- Players ---------- */

let allPlayers = []; // every known player (incl. offline), used for multi-account lookup
let playersQuery = "";
let playersFilter = "all"; // all | online | offline

// How many risk factors a player carries (drives the "Риск" column sort).
function playerRiskScore(p) {
  let n = 0;
  if (p.is_vpn) n++;
  if (p.is_pirate === true) n += 2;
  if ((p.vac_bans ?? 0) >= 1) n += 3;
  if ((p.game_bans ?? 0) >= 1) n++;
  if (p.rust_hours_total && p.rust_hours_total < (loadSettings().hoursLimit || 100)) n++;
  if (p.steam_profile_public === false) n++;
  return n;
}

SORT_GETTERS.players = {
  name: (p) => p.name,
  steamid: (p) => p.steamid,
  risk: (p) => playerRiskScore(p),
  hours: (p) => p.rust_hours_total ?? null,
  status: (p) => (p.online ? 1 : 0),
  last_seen: (p) => (p.last_seen ? new Date(p.last_seen).getTime() : 0),
};
SORT_RENDER.players = renderPlayers;

async function loadPlayers() {
  const [{ data, error }] = await Promise.all([
    sb.from("players").select("*").order("last_seen", { ascending: false }).limit(300),
    sb.from("players").select("steamid,name,ip,hwid,online,last_seen"),
  ]);
  allPlayers = data || [];

  if (error) {
    const el = document.getElementById("playersBody");
    if (el) el.innerHTML = `<tr><td colspan="7" class="empty">Ошибка загрузки: ${esc(error?.message || "")}</td></tr>`;
    return;
  }
  tableCache.players = data || [];
  renderPlayers();
}

function renderPlayers() {
  const el = document.getElementById("playersBody");
  if (!el) return;
  const all = tableCache.players || [];

  const q = playersQuery.trim().toLowerCase();
  let list = q ? all.filter((p) => String(p.name || "").toLowerCase().includes(q) || String(p.steamid || "").includes(q) || String(p.ip || "").includes(q)) : all;
  if (playersFilter === "online") list = list.filter((p) => p.online);
  if (playersFilter === "offline") list = list.filter((p) => !p.online);

  const nOnline = all.filter((p) => p.online).length;
  const cnt = document.getElementById("playersCount");
  if (cnt) cnt.innerHTML = `Онлайн: <b>${nOnline}</b> · Оффлайн: ${all.length - nOnline} · Всего: ${all.length}`;

  if (!all.length) {
    el.innerHTML = '<tr><td colspan="7" class="empty">Игроков пока не было</td></tr>';
    return;
  }
  if (!list.length) {
    el.innerHTML = `<tr><td colspan="7" class="empty">Никого не найдено по запросу «${esc(playersQuery)}»</td></tr>`;
    return;
  }

  const sorted = sortedRows("players", list);

  // Group players by IP / HWID to find shared accounts
  const byKey = (list2, key) => {
    const m = {};
    list2.forEach((p) => {
      const v = p[key];
      if (v) (m[v] = m[v] || []).push(p.steamid);
    });
    return m;
  };
  const byIp = byKey(allPlayers, "ip");
  const byHwid = byKey(allPlayers, "hwid");

  const dupCount = (p) => {
    const ipN = p.ip ? (byIp[p.ip] || []).filter((s) => s !== p.steamid).length : 0;
    const hwN = p.hwid ? (byHwid[p.hwid] || []).filter((s) => s !== p.steamid).length : 0;
    return ipN + hwN;
  };

  el.innerHTML = sorted
    .map((p) => {
      const dups = dupCount(p);
      const risks = [];
      if (p.is_vpn) risks.push('<span class="tag vpn">VPN</span>');
      if (p.is_pirate === true) risks.push('<span class="tag danger">Пират</span>');
      if ((p.vac_bans ?? 0) >= 1) risks.push('<span class="tag danger">VAC</span>');
      if (p.rust_hours_total && p.rust_hours_total < (loadSettings().hoursLimit || 100)) risks.push('<span class="tag warn">Мало часов</span>');
      if (dups) risks.push(`<button class="tag dup" title="Другие аккаунты с таким же IP или компьютером" onclick="event.stopPropagation();showDuplicates('${p.steamid}')">${dups + 1} акк.</button>`);
      const playtime = p.rust_hours_total != null ? p.rust_hours_total + " ч" : "—";
      const status = p.online
        ? '<span class="tag ok">Онлайн</span>'
        : '<span class="tag muted">Оффлайн</span>';

      return `
      <tr style="cursor:pointer" data-sid="${esc(p.steamid)}" data-name="${esc(p.name)}">
        <td>
          <span class="avatar small" style="background:${avatarColor(p.name)}">${initials(p.name)}</span>
          <b>${esc(p.name) || "—"}</b>
        </td>
        <td class="mono small">${esc(p.steamid)}</td>
        <td>${risks.length ? risks.join(" ") : '<span class="tag ok">Clean</span>'}</td>
        <td>${playtime}</td>
        <td>${status}</td>
        <td class="muted small">${p.online ? "сейчас играет" : fmtTime(p.last_seen)}</td>
        <td class="row-actions">
          <button class="btn small warn" onclick="event.stopPropagation();startCheck('${esc(p.steamid)}','${esc(p.name)}')">Проверка</button>
          <button class="btn small danger" onclick="event.stopPropagation();openBanModal('${esc(p.steamid)}','${esc(p.name)}')">Бан</button>
        </td>
      </tr>`;
    })
    .join("");

  // Click anywhere on a row -> full player details, right click -> quick menu
  el.querySelectorAll("tr[data-sid]").forEach((row) => {
    row.addEventListener("click", () => openPlayerCard(row.dataset.sid));
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      playerCtxMenu(e.clientX, e.clientY, row.dataset.sid, row.dataset.name);
    });
  });
}

function playerCtxMenu(x, y, steamid, name) {
  showCtxMenu(x, y, [
    { label: "Профиль игрока", fn: () => openPlayerCard(steamid) },
    { label: "Начать проверку", fn: () => startCheck(steamid, name) },
    { label: "Ответить в ЛС", fn: () => openPmModal(steamid, name) },
    { label: "Замутить", fn: () => openMuteModal(steamid, name) },
    { label: "Игнорировать жалобы", fn: () => ignoreReports(steamid, name) },
    { label: "Заблокировать", fn: () => openBanModal(steamid, name) },
    { label: "Копировать SteamID", fn: () => copyText(steamid, "SteamID скопирован") },
  ]);
}

// Stops new reports against this player from surfacing (mirrors the "ignore
// reports" tag). Empty answer = permanent, like the reference panel's forever tag.
async function ignoreReports(steamid, name) {
  if (!steamid) return;
  const days = prompt(`Сколько дней игнорировать жалобы на «${name}»?\nОставьте поле пустым — навсегда.`, "");
  if (days === null) return;

  const n = parseInt(days, 10);
  const mins = days === "" || !(n > 0) ? null : n * 24 * 60;

  const sent = await sendCommand({ command: "ignorereports", steamid, name, duration_minutes: mins });
  if (!sent) return;

  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = mins ? `Жалобы на «${name}» игнорируются ${n} дн.` : `Жалобы на «${name}» игнорируются навсегда`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

// Downloads the global chat log as a plain-text file (the "Export logs" button).
async function exportChatLogs() {
  const { data, error } = await sb
    .from("chat_logs")
    .select("created_at,name,message")
    .order("created_at", { ascending: false })
    .limit(5000);

  if (error || !data) {
    alert("Не удалось выгрузить лог чата: " + (error?.message || ""));
    return;
  }

  const lines = data.map((m) => `[${fmtTime(m.created_at)}] ${m.name}: ${m.message}`);
  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `chat-log-${new Date().toISOString().slice(0, 10)}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// Shows players that share an IP or HWID with the given player (multi-account check)
function showDuplicates(steamid) {
  const p = allPlayers.find((x) => x.steamid === steamid);
  if (!p) return;

  const linked = allPlayers.filter(
    (x) =>
      x.steamid !== steamid &&
      ((p.ip && x.ip === p.ip) || (!!p.hwid && x.hwid === p.hwid))
  );

  const card = document.getElementById("modalCard");
  card.classList.add("wide");
  card.innerHTML = `
    <h3>Аккаунты с тем же IP / HWID</h3>
    <p class="muted">${esc(p.name)} — IP <span class="mono">${esc(p.ip) || "—"}</span>, HWID <span class="mono">${shortHwid(p.hwid)}</span></p>
    ${
      linked.length
        ? linked
            .map(
              (x) => `
          <div class="chat-line">
            <b>${esc(x.name)}</b> <span class="mono muted">${esc(x.steamid)}</span>
            <span class="tag ${x.online ? "ok" : "muted"}">${x.online ? "онлайн" : "оффлайн"}</span>
            <span class="time">${fmtTime(x.last_seen)}</span>
          </div>`
            )
            .join("")
        : '<div class="empty">Совпадений не найдено</div>'
    }
    <div class="row"><button class="btn" onclick="closeModal()">Закрыть</button></div>
  `;
  document.getElementById("modal").classList.remove("hidden");
}

// Full player profile (RustApp-style): everything about one player in one window.
async function openPlayerCard(steamid) {
  const p = allPlayers.find((x) => x.steamid === steamid);
  if (!p) return;

  const card = document.getElementById("modalCard");
  card.classList.add("wide");
  const linked = allPlayers.filter(
    (x) => x.steamid !== steamid && ((p.ip && x.ip === p.ip) || (!!p.hwid && x.hwid === p.hwid))
  );

  // Status badges, like the reference panel shows under a player's name
  const rules = riskRules();
  const badges = [];
  if (p.is_vpn && rules.vpn) badges.push('<span class="tag vpn">VPN</span>');
  if (p.vpn_checked && !p.is_vpn) badges.push('<span class="tag ok">без VPN</span>');
  if (p.muted) badges.push('<span class="tag warn">Мут</span>');
  if (p.is_banned) badges.push('<span class="tag danger">Заблокирован</span>');
  if (p.being_checked) badges.push('<span class="tag warn">На проверке</span>');
  if (p.is_pirate === true && rules.pirate) badges.push('<span class="tag danger">Пират</span>');
  if ((p.vac_bans ?? 0) >= 1 && rules.vac) badges.push('<span class="tag danger">VAC</span>');
  if ((p.game_bans ?? 0) >= 1 && rules.vac) badges.push('<span class="tag danger">Gameban</span>');
  if (p.rust_hours_total && p.rust_hours_total < rules.hoursLimit) badges.push('<span class="tag warn">Мало часов</span>');
  if (p.steam_profile_public === false && rules.private) badges.push('<span class="tag muted">Профиль скрыт</span>');
  if (p.online && p.is_alive === false) badges.push('<span class="tag muted">Мёртв</span>');
  if (p.raid_blocked) badges.push('<span class="tag warn">Рейдблок</span>');
  if (p.ignore_reports_until && new Date(p.ignore_reports_until) > new Date()) {
    badges.push('<span class="tag muted">Игнор жалоб</span>');
  }
  if (p.language) badges.push(`<span class="tag muted">${esc(p.language.toUpperCase())}</span>`);
  if (linked.length) badges.push(`<span class="tag dup" onclick="event.stopPropagation()">${linked.length + 1} аккаунт${linked.length > 1 ? "а" : ""}</span>`);

  // Last finished verification: a "clean" verdict earns the "checked" badge.
  let lastCheck = null;
  try {
    const { data: ck } = await sb
      .from("checks")
      .select("status,created_at")
      .eq("steamid", steamid)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    lastCheck = ck;
  } catch {}
  if (lastCheck && lastCheck.status === "clean") badges.push('<span class="tag ok">Проверен</span>');

  const country = p.country_code
    ? `${countryFlag(p.country_code)} ${esc(p.country || p.country_code.toUpperCase())}`
    : "—";
  const provider = esc(p.isp) || "—";
  const firstSeen = p.first_seen ? fmtDate(p.first_seen) : "—";
  const accountType =
    p.is_pirate === true ? "Пират" : p.is_pirate === false ? "Лицензия" : "Не удалось определить";
  const steamBlock = p.steam_checked_at
    ? `
    <h4>Steam</h4>
    <div class="pgrid">
      <div class="prow"><span class="pkey">Тип аккаунта</span><span>${accountType}${p.is_pirate == null ? ' <span class="muted small">(Steam не отдал часы в Rust/Spacewar — часто бывает при family sharing или скрытых деталях игр)</span>' : ""}</span></div>
      <div class="prow"><span class="pkey">Аккаунт создан</span><span>${p.steam_created ? fmtDate(p.steam_created) : '<span class="muted">скрыт</span>'}</span></div>
      <div class="prow"><span class="pkey">Часы в Rust</span><span>${p.rust_hours_total != null ? p.rust_hours_total + " ч" : "—"}</span></div>
      <div class="prow"><span class="pkey">Часы в Spacewar</span><span>${p.spacewar_hours_total != null ? p.spacewar_hours_total + " ч" : "—"}</span></div>
      <div class="prow"><span class="pkey">За 2 недели</span><span>${p.steam_hours_2week != null ? p.steam_hours_2week + " ч" : "—"}</span></div>
      <div class="prow"><span class="pkey">VAC-баны</span><span>${(p.vac_bans ?? 0) > 0 ? `<span class="tag danger">${p.vac_bans}</span>` : "0"}</span></div>
      <div class="prow"><span class="pkey">Game-баны</span><span>${(p.game_bans ?? 0) > 0 ? `<span class="tag danger">${p.game_bans}</span>` : "0"}</span></div>
      <div class="prow"><span class="pkey">Профиль</span><span>${p.steam_profile_public ? "открыт" : '<span class="muted">скрыт</span>'}</span></div>
    </div>`
    : "";

  card.innerHTML = `
    <div class="phead">
      <span class="avatar" style="background:${avatarColor(p.name)}">${initials(p.name)}</span>
      <div style="flex:1;min-width:0">
        <h3 style="margin:0">${esc(p.name) || "—"}</h3>
        <span class="muted small">${p.online ? "сейчас на сервере" : "не в сети"} · последний раз ${fmtTime(p.last_seen)}</span>
        ${badges.length ? `<div class="pbadges">${badges.join("")}</div>` : ""}
      </div>
    </div>

    <h4>Об игроке</h4>
    <div class="pgrid">
      <div class="prow"><span class="pkey">Страна</span><span>${country}</span></div>
      <div class="prow"><span class="pkey">Провайдер</span><span>${provider}</span></div>
      <div class="prow"><span class="pkey">IP адрес</span><span class="mono small">${esc(p.ip) || "—"}</span></div>
      <div class="prow"><span class="pkey">SteamID</span><span class="mono small">${esc(p.steamid)}</span></div>
      <div class="prow"><span class="pkey">Впервые замечен</span><span>${firstSeen}</span></div>
      <div class="prow"><span class="pkey">Пинг</span><span>${p.ping ?? 0} мс</span></div>
      <div class="prow"><span class="pkey">HWID</span><span class="mono small">${esc(p.hwid) || "—"}</span></div>
      <div class="prow"><span class="pkey">Аккаунт</span><span>${p.connections_count ? p.connections_count + " заходов" : "—"}</span></div>
    </div>

    <h4>Игровая информация</h4>
    <div class="pgrid">
      <div class="prow"><span class="pkey">Состояние</span><span>${p.online ? '<span class="tag ok">в сети</span>' : '<span class="tag muted">не в сети</span>'}</span></div>
      <div class="prow"><span class="pkey">На сервере</span><span>${p.online ? "сейчас играет" : fmtTime(p.last_seen)}</span></div>
      <div class="prow"><span class="pkey">Двигался</span><span>${p.pos_x != null ? fmtTime(p.last_seen) : "—"}</span></div>
      <div class="prow"><span class="pkey">Квадрат</span><span class="mono small">${mapSquare(p.pos_x, p.pos_z)}</span></div>
    </div>

    ${steamBlock}

    ${linked.length ? `
      <h4>Связанные аккаунты (${linked.length})</h4>
      ${linked.map((x) => `
        <div class="linked-row">
          <span class="avatar small" style="background:${avatarColor(x.name)}">${initials(x.name)}</span>
          <div class="linked-info">
            <b>${esc(x.name)}</b>
            <span class="muted small">${x.steamid} · ${x.ip ? "общий IP" : ""}${x.hwid && p.hwid === x.hwid ? " · общий HWID" : ""}</span>
          </div>
          <span class="tag ${x.online ? "ok" : "muted"}">${x.online ? "онлайн" : "оффлайн"}</span>
          <button class="btn small" onclick="closeModal();startCheck('${esc(x.steamid)}','${esc(x.name)}')">Проверка</button>
        </div>`).join("")}
    ` : ""}

    <div class="check-actions">
      <button class="btn" onclick="closeModal()">Закрыть</button>
      <button class="btn" onclick="copyText('${esc(p.steamid)}','SteamID скопирован')">SteamID</button>
      <button class="btn" onclick="closeModal();recheckSteam('${esc(p.steamid)}','${esc(p.name)}')">Перепроверить Steam</button>
      ${p.ip ? `<button class="btn" onclick="closeModal();document.getElementById('ipInput').value='${esc(p.ip)}';checkIp('${esc(p.ip)}')">Проверить IP</button>` : ""}
      <button class="btn" onclick="closeModal();openPmModal('${esc(p.steamid)}','${esc(p.name)}')">Написать в ЛС</button>
      <button class="btn warn" onclick="closeModal();startCheck('${esc(p.steamid)}','${esc(p.name)}')">Проверка</button>
      <button class="btn danger" onclick="closeModal();openBanModal('${esc(p.steamid)}','${esc(p.name)}')">Бан</button>
    </div>
  `;
  document.getElementById("modal").classList.remove("hidden");
}

// Asks the plugin to re-query the Steam Web API for this player right now
// (bypassing the 24h re-check interval). Used when the profile could not tell
// a license from a pirate.
async function recheckSteam(steamid, name) {
  if (!steamid) return;
  const ok = await sendCommand({ command: "steamcheck", steamid, name });
  if (!ok) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = "Запросил Steam повторно — обнови профиль через минуту";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// Copies text to the clipboard (fallback for older browsers).
function copyText(text, okMsg) {
  const done = () => { const el = document.createElement("div"); el.className = "toast"; el.textContent = okMsg; document.body.appendChild(el); setTimeout(() => el.remove(), 2000); };
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(done, () => prompt("Скопируйте вручную:", text));
  } else {
    prompt("Скопируйте вручную:", text);
  }
}

/* ---------- Reports ---------- */

let reportsFilter = "pending"; // pending | all

SORT_GETTERS.reports = {
  id: (r) => r.id,
  target_name: (r) => r.target_name,
  online: (r) => (isPlayerOnline(r.target_steamid) ? 1 : 0),
  reason: (r) => r.reason,
  status: (r) => r.status,
  created_at: (r) => (r.created_at ? new Date(r.created_at).getTime() : 0),
};
SORT_RENDER.reports = renderReports;

// Looks a report target up in the cached player list to tell whether he is
// currently on the server.
function isPlayerOnline(steamid) {
  if (!steamid) return false;
  const p = allPlayers.find((x) => x.steamid === steamid);
  return !!(p && p.online);
}

async function loadReports() {
  const [rep, pl] = await Promise.all([
    sb.from("reports").select("*").order("created_at", { ascending: false }).limit(200),
    // The report target's online status is read from the player list, so keep
    // it fresh alongside the reports themselves.
    sb.from("players").select("steamid,online").limit(500),
  ]);
  const { data, error } = rep;

  if (error) {
    document.getElementById("reportsBody").innerHTML = `<tr><td colspan="7" class="empty">Ошибка загрузки: ${esc(error?.message || "")}</td></tr>`;
    return;
  }
  allPlayers = pl.data || [];
  tableCache.reports = data || [];
  renderReports();
}

function renderReports() {
  const body = document.getElementById("reportsBody");
  const all = tableCache.reports || [];
  const pending = all.filter((r) => r.status === "pending");

  const cnt = document.getElementById("reportsCount");
  if (cnt) {
    const onlineN = all.filter((r) => isPlayerOnline(r.target_steamid)).length;
    cnt.innerHTML = `Активных репортов: <b>${pending.length}</b> · Всего: ${all.length} · Цель в сети: ${onlineN}`;
  }

  if (!all.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">Нет репортов</td></tr>';
    return;
  }

  const sorted = sortedRows("reports", all);
  const list = reportsFilter === "pending" ? sorted.filter((r) => r.status === "pending") : sorted;
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">Активных репортов нет — все жалобы обработаны</td></tr>';
    return;
  }

  body.innerHTML = list
    .map(
      (r) => {
        const on = isPlayerOnline(r.target_steamid);
        return `
      <tr data-sid="${esc(r.target_steamid || "")}" data-name="${esc(r.target_name || "")}">
        <td class="mono">#${r.id}</td>
        <td><b>${esc(r.target_name) || r.target_steamid}</b><br><span class="mono muted">${esc(r.target_steamid)}</span></td>
        <td><span class="tag ${on ? "ok" : "muted"}">${on ? "В сети" : "Не в сети"}</span></td>
        <td>${esc(r.reason)}</td>
        <td><span class="tag ${r.status === "pending" ? "warn" : r.status === "banned" ? "danger" : "ok"}">${r.status}</span></td>
        <td>${fmtTime(r.created_at)}</td>
        <td style="white-space:nowrap" class="row-actions">
          <button class="btn small warn" title="Открыть чат проверки" onclick="startCheck('${esc(r.target_steamid)}', '${esc(r.target_name)}')">Проверка</button>
          <button class="btn small" title="Последние сообщения игрока" onclick="showPlayerMessages('${esc(r.target_steamid)}', '${esc(r.target_name)}')">Сообщения</button>
          <button class="btn small danger" onclick="openBanModal('${esc(r.target_steamid)}', '${esc(r.target_name)}')">Забанить</button>
          <button class="btn small" onclick="markReportReviewed(${r.id})">Проверен</button>
        </td>
      </tr>`;
      }
    )
    .join("");

  // Right-click on a report row: "Вызвать на проверку" (RustApp-style context menu)
  body.querySelectorAll("tr[data-sid]").forEach((tr) => {
    tr.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      reportCtxMenu(e.clientX, e.clientY, tr.dataset.sid, tr.dataset.name);
    });
  });
}

function reportCtxMenu(x, y, steamid, name) {
  showCtxMenu(x, y, [
    { label: "Начать проверку", fn: () => startCheck(steamid, name) },
    { label: "Заблокировать", fn: () => openBanModal(steamid, name) },
    { label: "Кикнуть", fn: () => quickAction("kick", steamid, name) },
    { label: "Показать сообщения", fn: () => showPlayerMessages(steamid, name) },
    { label: "Копировать SteamID", fn: () => copyText(steamid, "SteamID скопирован") },
  ]);
}

// Shows the recent chat messages of one player.
async function showPlayerMessages(steamid, name) {
  const { data } = await sb
    .from("chat_logs")
    .select("message,created_at")
    .eq("steamid", steamid)
    .order("created_at", { ascending: false })
    .limit(50);

  const card = document.getElementById("modalCard");
  card.classList.add("wide");
  card.innerHTML = `
    <h3>Сообщения игрока</h3>
    <p class="muted small">${esc(name)} · ${steamid}</p>
    ${
      data && data.length
        ? data
            .map(
              (m) => `
          <div class="chat-line">
            ${esc(m.message)}
            <span class="time">${fmtTime(m.created_at)}</span>
          </div>`
            )
            .join("")
        : '<div class="empty">Этот игрок ещё ничего не писал в чат</div>'
    }
    <div class="row"><button class="btn" onclick="closeModal()">Закрыть</button></div>
  `;
  document.getElementById("modal").classList.remove("hidden");
}

function showCtxMenu(x, y, items) {
  const menu = document.getElementById("ctxMenu");
  menu.innerHTML = items
    .map((it, i) => `<div class="ctx-item" data-i="${i}">${esc(it.label)}</div>`)
    .join("");
  menu.classList.remove("hidden");

  const rect = menu.getBoundingClientRect();
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
  menu.style.left = x + "px";
  menu.style.top = y + "px";

  menu.querySelectorAll(".ctx-item").forEach((el) => {
    el.addEventListener("click", () => {
      const item = items[parseInt(el.dataset.i, 10)];
      hideCtxMenu();
      if (item && item.fn) item.fn();
    });
  });
}

function hideCtxMenu() {
  document.getElementById("ctxMenu").classList.add("hidden");
}

document.addEventListener("click", (e) => {
  const menu = document.getElementById("ctxMenu");
  if (!menu.classList.contains("hidden") && !e.target.closest(".ctx-menu")) {
    hideCtxMenu();
  }
});

/* ---------- Checks (verification sessions) ---------- */

SORT_GETTERS.checks = {
  name: (c) => c.name,
  steamid: (c) => c.steamid,
  status: (c) => c.status,
  reason: (c) => c.reason,
  created_at: (c) => (c.closed_at || c.created_at ? new Date(c.closed_at || c.created_at).getTime() : 0),
};
SORT_RENDER.checks = renderChecks;

async function loadChecks() {
  const { data, error } = await sb
    .from("checks")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    document.getElementById("checksBody").innerHTML = `<tr><td colspan="6" class="empty">Ошибка загрузки: ${esc(error?.message || "")}</td></tr>`;
    return;
  }
  tableCache.checks = data || [];
  renderChecks();
}

function renderChecks() {
  const body = document.getElementById("checksBody");
  const all = tableCache.checks || [];
  const active = all.filter((c) => c.status === "active");
  const cnt = document.getElementById("checksCount");
  if (cnt) cnt.innerHTML = `Идёт проверок: <b>${active.length}</b> · Всего: ${all.length}`;

  if (!all.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">Проверок ещё не было. Откройте любую жалобу и нажмите «Проверка».</td></tr>';
    return;
  }

  body.innerHTML = sortedRows("checks", all)
    .map(
      (c) => `
      <tr>
        <td><b>${esc(c.name) || c.steamid}</b></td>
        <td class="mono">${esc(c.steamid)}</td>
        <td><span class="tag ${c.status === "active" ? "warn" : c.status === "banned" ? "danger" : "ok"}">${c.status === "active" ? "идётся" : c.status === "banned" ? "нарушение" : "чист"}</span></td>
        <td>${c.shown ? "Табличка показана" : esc(c.reason || "Проверка по жалобе")}</td>
        <td>${fmtTime(c.closed_at || c.created_at)}</td>
        <td style="white-space:nowrap">
          ${c.status === "active" ? `<button class="btn small primary" onclick="reopenCheck(${c.id})">Открыть чат</button>` : `<button class="btn small" onclick="reopenCheck(${c.id})">История</button>`}
        </td>
      </tr>`
    )
    .join("");
}

// Starts a verification session: sends the "check" command and waits for the
// plugin to create the checks row, then opens the chat.
async function startCheck(steamid, name) {
  if (!steamid) return;

  const sent = await sendCommand({ command: "check", steamid, name });
  if (!sent) return;

  let tries = 0;
  const tick = async () => {
    tries++;
    const { data } = await sb
      .from("checks")
      .select("*")
      .eq("steamid", steamid)
      .eq("status", "active")
      .order("id", { ascending: false })
      .limit(1);

    if (data && data.length) {
      openCheckChat(data[0]);
      return;
    }

    if (tries < 10) {
      setTimeout(tick, 1500);
    } else {
      const { data: cmds } = await sb
        .from("commands")
        .select("status,result")
        .eq("command", "check")
        .eq("steamid", steamid)
        .order("id", { ascending: false })
        .limit(1);
      const why = cmds && cmds[0] ? cmds[0].result : "нет ответа от сервера";
      alert("Не удалось начать проверку: " + why);
    }
  };
  setTimeout(tick, 1500);
}

let activeCheck = null;
let checkPollTimer = null;

function openCheckChat(check) {
  if (!check) return;
  activeCheck = check;

  document.getElementById("checkHeader").innerHTML = `
    <div><span class="who">${esc(check.name) || esc(check.steamid)}</span>
      <span class="mono muted small" style="margin-left:8px">${esc(check.steamid)}</span></div>
    <span class="tag ${check.status === "active" ? "warn" : check.status === "banned" ? "danger" : "ok"}">
      ${check.status === "active" ? "проверка идёт" : check.status === "banned" ? "забанен" : "чист"}</span>
  `;

  const closed = check.status !== "active";
  document.getElementById("checkInput").disabled = closed;
  document.getElementById("btnCheckSend").disabled = closed;
  document.getElementById("btnCheckShow").disabled = closed;
  document.getElementById("btnCheckClean").disabled = closed;
  document.getElementById("btnCheckBan").disabled = closed;

  document.getElementById("checkEvents").innerHTML = '<div class="empty">Загрузка истории…</div>';
  document.getElementById("checkModal").classList.remove("hidden");

  loadCheckEvents();
  if (checkPollTimer) clearInterval(checkPollTimer);
  if (!closed) checkPollTimer = setInterval(loadCheckEvents, 3000);

  setTimeout(() => document.getElementById("checkInput").focus(), 60);
}

async function reopenCheck(id) {
  const { data } = await sb.from("checks").select("*").eq("id", id).maybeSingle();
  if (data) openCheckChat(data);
}

async function loadCheckEvents() {
  if (!activeCheck) return;
  const id = activeCheck.id;

  const { data } = await sb
    .from("check_events")
    .select("*")
    .eq("check_id", id)
    .order("created_at", { ascending: true })
    .limit(300);

  const el = document.getElementById("checkEvents");
  if (!data) return;

  if (!data.length) {
    el.innerHTML = '<div class="empty">Событий пока нет — напишите игроку первым</div>';
    return;
  }

  el.innerHTML = data
    .map((ev) => {
      const t = fmtTime(ev.created_at);
      if (ev.kind === "msg_admin") {
        return `<div class="ev admin">${esc(ev.text)}<span class="time">${t}</span></div>`;
      }
      if (ev.kind === "chat" || ev.kind === "msg_player") {
        return `<div class="ev player">${esc(ev.text)}<span class="time">игрок · ${t}</span></div>`;
      }
      if (ev.kind === "kill") {
        return `<div class="ev sys kill">⚔ ${esc(ev.text)} <span class="time">${t}</span></div>`;
      }
      if (ev.kind === "death") {
        return `<div class="ev sys death">💀 ${esc(ev.text)} <span class="time">${t}</span></div>`;
      }
      if (ev.kind === "contact") {
        return `<div class="ev sys contact">📨 ${esc(ev.text)} <span class="time">игрок · ${t}</span></div>`;
      }
      return `<div class="ev sys">${esc(ev.text)} <span class="time">${t}</span></div>`;
    })
    .join("");

  el.scrollTop = el.scrollHeight;
}

function closeCheckModal() {
  document.getElementById("checkModal").classList.add("hidden");
  if (checkPollTimer) {
    clearInterval(checkPollTimer);
    checkPollTimer = null;
  }
  activeCheck = null;
  if (currentView === "checks") loadChecks();
}

async function sendCheckMessage() {
  if (!activeCheck) return;
  const input = document.getElementById("checkInput");
  const msg = input.value.trim();
  if (!msg) return;

  const ok = await sendCommand({
    command: "checkmsg",
    steamid: activeCheck.steamid,
    name: activeCheck.name,
    message: msg,
  });
  if (ok) {
    input.value = "";
    setTimeout(loadCheckEvents, 900);
  }
}

async function showCheckTable() {
  if (!activeCheck) return;
  await sendCommand({ command: "checkshow", steamid: activeCheck.steamid, name: activeCheck.name });
}

async function checkVerdict(verdict) {
  if (!activeCheck) return;
  const banned = verdict === "banned";

  let reason = null;
  if (banned) {
    reason = prompt("Причина бана:", "Читы / стороннее ПО");
    if (reason === null) return;
    if (!confirm(`Забанить ${activeCheck.name || activeCheck.steamid}?`)) return;
  } else {
    if (!confirm(`Признать игрока ${activeCheck.name || activeCheck.steamid} чистым и закрыть проверку?`)) return;
  }

  await sendCommand({
    command: "checkverdict",
    steamid: activeCheck.steamid,
    name: activeCheck.name,
    message: verdict,
    reason: banned ? (reason || "Читы / стороннее ПО") : null,
  });

  // A closed verdict resolves every pending report against that player, so the
  // report queue clears instead of piling up on the same person.
  await deletePendingReports(activeCheck.steamid);

  closeCheckModal();
  if (currentView === "reports") loadReports();
  refreshAll();
}

async function deletePendingReports(steamid) {
  if (!steamid) return;
  try {
    await sb.from("reports").delete().eq("target_steamid", steamid).eq("status", "pending");
  } catch {}
}

async function markReportReviewed(id) {
  await sb.from("reports").update({ status: "reviewed" }).eq("id", id);
  loadReports();
}

/* ---------- Bans ---------- */

SORT_GETTERS.bans = {
  name: (b) => b.name,
  scope: (b) => (b.hwid ? "SteamID + HWID" : "SteamID + IP"),
  reason: (b) => b.reason,
  active: (b) => (b.active ? 1 : 0),
  expires_at: (b) => (b.expires_at ? new Date(b.expires_at).getTime() : 0),
  created_at: (b) => (b.created_at ? new Date(b.created_at).getTime() : 0),
};
SORT_RENDER.bans = renderBans;

async function loadBans() {
  const { data, error } = await sb
    .from("bans")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    document.getElementById("bansBody").innerHTML = `<tr><td colspan="6" class="empty">Ошибка загрузки</td></tr>`;
    return;
  }
  tableCache.bans = data || [];
  renderBans();
}

function renderBans() {
  const body = document.getElementById("bansBody");
  const all = tableCache.bans || [];
  const cnt = document.getElementById("bansCount");
  if (cnt) {
    const live = all.filter((b) => b.active && (!b.expires_at || new Date(b.expires_at) >= new Date()));
    cnt.innerHTML = `Активных банов: <b>${live.length}</b> · Всего: ${all.length}`;
  }

  if (!all.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">Банов нет</td></tr>';
    return;
  }

  body.innerHTML = sortedRows("bans", all)
    .map((b) => {
      const expired = b.expires_at && new Date(b.expires_at) < new Date();
      const statusTag = !b.active
        ? '<span class="tag muted">разбанен</span>'
        : expired
        ? '<span class="tag muted">истёк</span>'
        : b.expires_at
        ? '<span class="tag warn">временный</span>'
        : '<span class="tag danger">навсегда</span>';
      return `
      <tr>
        <td><b>${esc(b.name) || "—"}</b><br><span class="mono muted">${esc(b.steamid) || "—"}</span></td>
        <td>${b.hwid ? "SteamID + HWID" : "SteamID + IP"}</td>
        <td>${esc(b.reason)}</td>
        <td>${statusTag}</td>
        <td>${b.expires_at ? fmtTime(b.expires_at) : "Перманент"}</td>
        <td style="white-space:nowrap">${b.active ? `<button class="btn small" onclick="quickAction('unban','${esc(b.steamid)}','${esc(b.name)}')">Разбанить</button>` : ""}</td>
      </tr>`;
    })
    .join("");
}

/* ---------- Mutes ---------- */

SORT_GETTERS.mutes = {
  name: (m) => m.name,
  reason: (m) => m.reason,
  active: (m) => (m.active ? 1 : 0),
  expires_at: (m) => (m.expires_at ? new Date(m.expires_at).getTime() : 0),
  created_at: (m) => (m.created_at ? new Date(m.created_at).getTime() : 0),
};
SORT_RENDER.mutes = renderMutes;

async function loadMutes() {
  const { data, error } = await sb
    .from("mutes")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    document.getElementById("mutesBody").innerHTML = `<tr><td colspan="6" class="empty">Ошибка загрузки</td></tr>`;
    return;
  }
  tableCache.mutes = data || [];
  renderMutes();
}

function renderMutes() {
  const body = document.getElementById("mutesBody");
  const all = tableCache.mutes || [];
  const cnt = document.getElementById("mutesCount");
  if (cnt) {
    const live = all.filter((m) => m.active && (!m.expires_at || new Date(m.expires_at) >= new Date()));
    cnt.innerHTML = `Активных мутов: <b>${live.length}</b> · Всего: ${all.length}`;
  }

  if (!all.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">Мутов нет</td></tr>';
    return;
  }

  body.innerHTML = sortedRows("mutes", all)
    .map(
      (m) => `
      <tr>
        <td><b>${esc(m.name) || "—"}</b><br><span class="mono muted">${esc(m.steamid)}</span></td>
        <td>${esc(m.reason)}</td>
        <td>${m.active ? '<span class="tag warn">активен</span>' : '<span class="tag muted">снят</span>'}</td>
        <td>${m.expires_at ? fmtTime(m.expires_at) : "Перманент"}</td>
        <td>${m.active ? `<button class="btn small" onclick="quickAction('unmute','${esc(m.steamid)}','${esc(m.name)}')">Снять мут</button>` : ""}</td>
      </tr>`
    )
    .join("");
}

/* ---------- Kill analysis (cheat detection) ---------- */

// Distance limits (in meters) per weapon or weapon family. A kill above the
// limit is suspicious for that weapon. Snipers are naturally long-range, so
// their limits are much higher than rifles/SMGs.
const DISTANCE_LIMITS = {
  l96: 350, awm: 350, sniper: 350, m39: 250, bolt: 300,
  ak47: 150, ak: 150, lr300: 180, lr: 180, m4: 150, ar: 150,
  mp5: 60, mp5a4: 60, smg: 60, Thompson: 50, thompson: 50,
  shotgun: 25, pump: 25, spas: 25, m870: 25, dbl: 20,
  pistol: 60, revolver: 70, semi: 80, p250: 40, nailgun: 30,
};

// Anything longer than this for an unknown weapon is suspicious.
const DEFAULT_DISTANCE_LIMIT = 150;
// >= this many kills inside this window (ms) counts as an unreal kill streak.
const STREAK_KILLS = 5;
const STREAK_WINDOW_MS = 5000;
// A player whose last kills are ALL headshots and he has at least this many is flagged.
const HEADSHOT_MIN_KILLS = 5;

function weaponLimit(weapon) {
  const w = String(weapon || "").toLowerCase();
  for (const key of Object.keys(DISTANCE_LIMITS)) {
    if (w.includes(key)) return DISTANCE_LIMITS[key];
  }
  return DEFAULT_DISTANCE_LIMITS;
}

async function loadKillAnalysis() {
  const { data, error } = await sb
    .from("kills")
    .select("attacker_steamid,attacker_name,victim_name,weapon,distance,headshot,created_at")
    .order("created_at", { ascending: false })
    .limit(500);

  const el = document.getElementById("suspiciousList");
  if (error || !data) {
    el.innerHTML = `<div class="empty">Ошибка загрузки: ${esc(error?.message || "")}</div>`;
    return;
  }
  if (!data.length) {
    el.innerHTML = '<div class="empty">Убийств пока не записано</div>';
    return;
  }

  // group kills by attacker
  const byAttacker = {};
  data.forEach((k) => {
    const id = k.attacker_steamid || k.attacker_name;
    if (!id) return;
    (byAttacker[id] = byAttacker[id] || {
      steamid: k.attacker_steamid,
      name: k.attacker_name,
      kills: [],
    }).kills.push(k);
  });

  const flagged = [];
  Object.values(byAttacker).forEach((p) => {
    const issues = [];
    const kills = p.kills;
    if (kills.length < 3) return;

    // 1) unreal kill streak: many kills within a few seconds
    const times = kills.map((k) => new Date(k.created_at).getTime()).sort((a, b) => a - b);
    let bestStreak = 1;
    let streak = 1;
    for (let i = 1; i < times.length; i++) {
      if (times[i] - times[i - 1] <= STREAK_WINDOW_MS) {
        streak++;
        bestStreak = Math.max(bestStreak, streak);
      } else {
        streak = 1;
      }
    }
    if (bestStreak >= STREAK_KILLS) {
      issues.push({
        type: "streak",
        text: `Серия: ${bestStreak} убийств за ${STREAK_WINDOW_MS / 1000} сек`,
      });
    }

    // 2) headshot only
    const hsCount = kills.filter((k) => k.headshot).length;
    if (hsCount >= HEADSHOT_MIN_KILLS && hsCount === kills.length) {
      issues.push({
        type: "headshot",
        text: `Только в голову: ${hsCount}/${kills.length} убийств`,
      });
    }

    // 3) huge distances for the weapon used
    const farKills = kills.filter((k) => (k.distance || 0) > weaponLimit(k.weapon));
    if (farKills.length >= 2) {
      const worst = farKills.reduce((a, b) => (b.distance > a.distance ? b : a));
      issues.push({
        type: "distance",
        text: `${farKills.length} убийств с огромной дистанции (макс ${Math.round(worst.distance)}м, ${esc(worst.weapon)})`,
      });
    }

    if (issues.length) {
      flagged.push({ ...p, issues, kills });
    }
  });

  flagged.sort((a, b) => b.kills.length - a.kills.length);

  const badge = document.getElementById("suspiciousBadge");
  badge.textContent = flagged.length;
  badge.classList.toggle("hidden", flagged.length === 0);

  if (!flagged.length) {
    el.innerHTML = '<div class="empty">Подозрительной активности не обнаружено</div>';
    return;
  }

  el.innerHTML = flagged
    .map(
      (p, i) => `
      <div class="suspicious-card">
        <div class="susp-head">
          <span class="avatar" style="background:${avatarColor(p.name)}">${initials(p.name)}</span>
          <div class="susp-info">
            <div><b>${esc(p.name) || "—"}</b> <span class="mono muted small">${esc(p.steamid || "")}</span></div>
            <div class="muted small">всего убийств: ${p.kills.length}</div>
          </div>
          <div class="susp-flags">
            ${p.issues.map((x) => `<span class="tag danger">${esc(x.text)}</span>`).join(" ")}
          </div>
        </div>
        <div class="susp-actions">
          <button class="btn small" onclick="copySuspect(${i})">Скопировать статистику</button>
          <button class="btn small warn" onclick="startCheck('${esc(p.steamid)}', '${esc(p.name)}')">Проверка</button>
          <button class="btn small danger" onclick="openBanModal('${esc(p.steamid)}', '${esc(p.name)}')">Бан</button>
        </div>
      </div>`
    )
    .join("");

  window._suspects = flagged;
}

/* ---------- Anticheat (kill analysis table) ---------- */

SORT_GETTERS.anticheat = {
  name: (p) => p.name,
  total: (p) => p.total,
  hs: (p) => p.hsPct,
  avgDist: (p) => p.avgDist,
  streak: (p) => p.bestStreak,
  flags: (p) => p.flags.length,
};
SORT_RENDER.anticheat = renderAnticheat;

/* ---------- Anticheat autoban settings ---------- */

// Conservative defaults: it is far better to miss a cheater than to ban a
// legitimate player, so every threshold starts on the strict side.
const AC_DEFAULTS = {
  enabled: false,
  action: "alert",                       // alert | check | ban
  banDuration: "",                       // minutes; "" = permanent
  reason: "Автобан: подозрительная статистика убийств",
  cooldownMin: 60,                       // never touch the same player twice within this window
  maxPlaytime: 500,                      // veterans with this many hours are skipped
  whitelist: "",                         // steamids, comma separated
  minFlags: 2,                           // how many rules must fire at once
  streak: { enabled: true, minKills: 6, windowSec: 5 },
  headshot: { enabled: true, minKills: 8, minPercent: 100 },
  distance: { enabled: false, minKills: 3, multiplier: 2.5 },
};

function anticheatConfig() {
  const s = loadSettings().anticheat || {};
  return {
    ...AC_DEFAULTS,
    ...s,
    streak: { ...AC_DEFAULTS.streak, ...(s.streak || {}) },
    headshot: { ...AC_DEFAULTS.headshot, ...(s.headshot || {}) },
    distance: { ...AC_DEFAULTS.distance, ...(s.distance || {}) },
  };
}

// Recent autoban actions, kept locally so the admin can audit them later.
function abLog() {
  try { return JSON.parse(localStorage.getItem("rap_ab_log_v1")) || []; } catch { return []; }
}

function abLogAdd(entry) {
  const log = abLog();
  log.unshift(entry);
  localStorage.setItem("rap_ab_log_v1", JSON.stringify(log.slice(0, 30)));
  renderAbLog();
}

function abRecentlyFired(cfg, steamid) {
  const last = abLog().find((x) => x.steamid === steamid);
  return !!(last && Date.now() - last.ts < cfg.cooldownMin * 60000);
}

function renderAbLog() {
  const el = document.getElementById("autobanLog");
  if (!el) return;
  const log = abLog();
  el.innerHTML = log.length
    ? log.slice(0, 10).map((e) => `
        <div class="chat-line">
          <span class="tag ${e.action === "бан" ? "danger" : "warn"}">${esc(e.action)}</span>
          <b>${esc(e.name)}</b>
          <span class="mono muted small">${esc(e.steamid)}</span>
          <span class="muted small">${esc(e.reason || "")}</span>
          <span class="time">${fmtTime(new Date(e.ts).toISOString())}</span>
        </div>`).join("")
    : '<div class="empty">Автобаны ещё не срабатывали</div>';
}

function bindAnticheatSettings() {
  const cfg = anticheatConfig();
  const val = (id, v) => { const el = document.getElementById(id); if (el) el.value = v == null ? "" : v; };
  const chk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v; };

  chk("acEnabled", cfg.enabled);
  val("acAction", cfg.action);
  val("acBanDuration", cfg.banDuration);
  val("acReason", cfg.reason);
  val("acCooldown", cfg.cooldownMin);
  val("acMaxPlaytime", cfg.maxPlaytime);
  val("acWhitelist", cfg.whitelist);
  val("acMinFlags", cfg.minFlags);
  chk("acStreakOn", cfg.streak.enabled); val("acStreakKills", cfg.streak.minKills); val("acStreakWindow", cfg.streak.windowSec);
  chk("acHsOn", cfg.headshot.enabled); val("acHsKills", cfg.headshot.minKills); val("acHsPct", cfg.headshot.minPercent);
  chk("acDistOn", cfg.distance.enabled); val("acDistKills", cfg.distance.minKills); val("acDistMult", cfg.distance.multiplier);
  renderAbLog();
}

function readAnticheatSettings() {
  const g = (id) => document.getElementById(id);
  const num = (id, dflt) => { const n = parseFloat(g(id).value); return isNaN(n) ? dflt : n; };
  return {
    enabled: g("acEnabled").checked,
    action: g("acAction").value,
    banDuration: g("acBanDuration").value,
    reason: (g("acReason").value || "").trim() || AC_DEFAULTS.reason,
    cooldownMin: Math.max(0, num("acCooldown", 60)),
    maxPlaytime: Math.max(0, num("acMaxPlaytime", 500)),
    whitelist: g("acWhitelist").value,
    minFlags: Math.max(1, Math.min(3, num("acMinFlags", 2))),
    streak: { enabled: g("acStreakOn").checked, minKills: Math.max(2, num("acStreakKills", 6)), windowSec: Math.max(1, num("acStreakWindow", 5)) },
    headshot: { enabled: g("acHsOn").checked, minKills: Math.max(2, num("acHsKills", 8)), minPercent: Math.max(50, Math.min(100, num("acHsPct", 100))) },
    distance: { enabled: g("acDistOn").checked, minKills: Math.max(1, num("acDistKills", 3)), multiplier: Math.max(1, num("acDistMult", 2.5)) },
  };
}

function saveAnticheatSettings() {
  saveSettings({ anticheat: readAnticheatSettings() });
  const tag = document.getElementById("acSaved");
  tag.classList.remove("hidden");
  setTimeout(() => tag.classList.add("hidden"), 1500);
  loadAnticheat();
}

// Longest kill streak inside a rolling time window.
function bestStreakIn(times, windowMs) {
  const t = [...times].sort((a, b) => a - b);
  let best = 1;
  let streak = 1;
  for (let i = 1; i < t.length; i++) {
    if (t[i] - t[i - 1] <= windowMs) {
      streak++;
      best = Math.max(best, streak);
    } else {
      streak = 1;
    }
  }
  return best;
}

// Which configured rules this player actually broke right now.
function acViolations(p, cfg) {
  const v = [];
  if (cfg.streak.enabled) {
    const times = p.kills.map((k) => new Date(k.created_at).getTime());
    const s = bestStreakIn(times, cfg.streak.windowSec * 1000);
    if (s >= cfg.streak.minKills) v.push({ rule: "streak", text: `Серия ${s} за ${cfg.streak.windowSec}с` });
  }
  if (cfg.headshot.enabled && p.kills.length) {
    const hs = p.kills.filter((k) => k.headshot).length;
    const pct = Math.round((hs / p.kills.length) * 100);
    if (hs >= cfg.headshot.minKills && pct >= cfg.headshot.minPercent) v.push({ rule: "headshot", text: `Хедшоты ${hs}/${p.kills.length} (${pct}%)` });
  }
  if (cfg.distance.enabled) {
    const far = p.kills.filter((k) => (k.distance || 0) > weaponLimit(k.weapon) * cfg.distance.multiplier).length;
    if (far >= cfg.distance.minKills) v.push({ rule: "distance", text: `${far} убийств с дистанции ×${cfg.distance.multiplier}` });
  }
  return v;
}

// Fires the configured action (ban / check / alert) for a player who broke the
// rules. Guarded by a whitelist, a playtime ceiling and a per-player cooldown.
async function maybeAutoban(rows, cfg) {
  if (!cfg.enabled) return;

  const wl = (cfg.whitelist || "").split(/[,\s]+/).filter(Boolean);
  for (const p of rows) {
    if (!p.steamid || p.flags.length === 0) continue;

    const v = acViolations(p, cfg);
    if (v.length < Math.max(1, cfg.minFlags)) continue;
    if (wl.includes(p.steamid)) continue;

    const known = allPlayers.find((x) => x.steamid === p.steamid);
    if (known && known.rust_hours_total > cfg.maxPlaytime) continue;
    if (abRecentlyFired(cfg, p.steamid)) continue;

    const label = v.map((x) => x.text).join(", ");
    const action = cfg.action;

    if (action === "ban") {
      await sendCommand({
        command: "ban",
        steamid: p.steamid,
        name: p.name,
        reason: `${cfg.reason} (${label})`,
        duration_minutes: cfg.banDuration ? parseInt(cfg.banDuration, 10) : null,
      });
    } else if (action === "check") {
      await sendCommand({ command: "check", steamid: p.steamid, name: p.name });
    }

    try {
      await sb.from("alerts").insert([{
        kind: action === "ban" ? "ban" : "check",
        text: `Античит: ${p.name} (${p.steamid}) — ${label}`,
      }]);
    } catch {}

    abLogAdd({
      steamid: p.steamid,
      name: p.name || "—",
      action: action === "ban" ? "бан" : action === "check" ? "проверка" : "алерт",
      reason: label,
      ts: Date.now(),
    });

    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = `Античит: ${action === "ban" ? "бан" : action === "check" ? "проверка" : "алерт"} — ${p.name || p.steamid}`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }
}

async function loadAnticheat() {
  const { data, error } = await sb
    .from("kills")
    .select("attacker_steamid,attacker_name,victim_name,weapon,distance,headshot,created_at")
    .order("created_at", { ascending: false })
    .limit(1000);

  const body = document.getElementById("anticheatBody");
  if (error || !data) {
    body.innerHTML = '<tr><td colspan="7" class="empty">Ошибка загрузки</td></tr>';
    return;
  }
  if (!data.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">Убийств пока не записано</td></tr>';
    return;
  }

  const byAttacker = {};
  data.forEach((k) => {
    const id = k.attacker_steamid || k.attacker_name;
    if (!id) return;
    (byAttacker[id] = byAttacker[id] || {
      steamid: k.attacker_steamid,
      name: k.attacker_name,
      kills: [],
    }).kills.push(k);
  });

  const cfg = anticheatConfig();
  // Which rules can trigger the autoban right now (shown as ⚡ in the table).
  const autoRule = {
    streak: cfg.enabled && cfg.streak.enabled,
    headshot: cfg.enabled && cfg.headshot.enabled,
    distance: cfg.enabled && cfg.distance.enabled,
  };

  const rows = Object.values(byAttacker)
    .map((p) => {
      const kills = p.kills;
      const hs = kills.filter((k) => k.headshot).length;
      const dists = kills.map((k) => k.distance || 0);
      const avgDist = Math.round(dists.reduce((a, b) => a + b, 0) / dists.length);
      const maxDist = Math.round(Math.max.apply(null, dists));

      const times = kills.map((k) => new Date(k.created_at).getTime());
      const bestStreak = bestStreakIn(times, cfg.streak.windowSec * 1000);
      const hsPct = kills.length ? Math.round((hs / kills.length) * 100) : 0;

      const flags = [];
      if (cfg.streak.enabled && bestStreak >= cfg.streak.minKills) {
        flags.push({ rule: "streak", cls: "danger", text: `Серия ${bestStreak} за ${cfg.streak.windowSec}с` });
      }
      if (cfg.headshot.enabled && hs >= cfg.headshot.minKills && hsPct >= cfg.headshot.minPercent) {
        flags.push({ rule: "headshot", cls: "warn", text: `Хедшот ${hs}/${kills.length}` });
      }
      if (cfg.distance.enabled) {
        const farKills = kills.filter((k) => (k.distance || 0) > weaponLimit(k.weapon) * cfg.distance.multiplier);
        if (farKills.length >= cfg.distance.minKills) {
          flags.push({ rule: "distance", cls: "vpn", text: `Дистанция ×${farKills.length}` });
        }
      }

      return {
        ...p,
        total: kills.length,
        hs,
        hsPct,
        avgDist,
        maxDist,
        bestStreak,
        flags,
      };
    })
    .sort((a, b) => b.flags.length - a.flags.length || b.total - a.total);

  window._anticheat = rows;
  window._acAutoRule = autoRule;
  renderAnticheat();
  maybeAutoban(rows, cfg);
}

function renderAnticheat() {
  const body = document.getElementById("anticheatBody");
  const all = window._anticheat || [];
  const autoRule = window._acAutoRule || {};
  if (!all.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">Убийств пока не записано</td></tr>';
    return;
  }

  body.innerHTML = sortedRows("anticheat", all)
    .map((p, i) => {
      const sid = esc(p.steamid || "");
      const nm = esc(p.name || "");
      const flagsHtml = p.flags.length
        ? p.flags.map((f) => `<span class="tag ${f.cls}${autoRule[f.rule] ? " autoban" : ""}" title="${autoRule[f.rule] ? "может сработать автобан" : "просто пометка"}">${esc(f.text)}${autoRule[f.rule] ? " ⚡" : ""}</span>`).join(" ")
        : '<span class="muted">—</span>';
      return `
      <tr style="cursor:pointer" onclick="${sid ? `openPlayerCard('${sid}')` : ""}">
        <td>
          <span class="avatar small" style="background:${avatarColor(p.name)}">${initials(p.name)}</span>
          <b>${nm || "—"}</b>
          <div class="mono muted">${sid}</div>
        </td>
        <td>${p.total}</td>
        <td>${p.hs} <span class="muted">(${p.hsPct}%)</span></td>
        <td>${p.avgDist}м <span class="muted">макс ${p.maxDist}м</span></td>
        <td>${p.bestStreak}</td>
        <td>${flagsHtml}</td>
        <td class="row-actions">
          <button class="btn small warn" onclick="event.stopPropagation();startCheck('${sid}', '${nm}')">Проверка</button>
          <button class="btn small danger" onclick="event.stopPropagation();openBanModal('${sid}', '${nm}')">Бан</button>
        </td>
      </tr>`;
    })
    .join("");
}

// Builds a plain-text report of the suspicious player, ready to paste anywhere.
function copySuspect(i) {
  const p = (window._suspects || [])[i];
  if (!p) return;

  const lines = [
    `Игрок: ${p.name}`,
    `SteamID: ${p.steamid}`,
    `Всего убийств: ${p.kills.length}`,
    "",
    "Причины подозрения:",
    ...p.issues.map((x) => `- ${x.text.replace(/<[^>]*>/g, "")}`),
    "",
    "Последние убийства:",
    ...p.kills
      .slice(0, 10)
      .map(
        (k) =>
          `- ${fmtTime(k.created_at)} | ${k.weapon} | ${Math.round(k.distance || 0)}м${k.headshot ? " | в голову" : ""} | жертва: ${k.victim_name}`
      ),
  ];

  const text = lines.join("\n");
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => alert("Статистика скопирована"));
  } else {
    prompt("Скопируйте текст:", text);
  }
}

async function loadOnlineChart() {
  const { data } = await sb
    .from("online_history")
    .select("players_online,created_at")
    .order("created_at", { ascending: true })
    .limit(300);

  const el = document.getElementById("onlineChart");
  if (!el) return;

  if (!data || data.length < 2) {
    el.innerHTML = '<div class="empty">История онлайна ещё собирается (плагин пишет точку каждые 5 минут)</div>';
    return;
  }

  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const rows = data.filter((r) => new Date(r.created_at).getTime() >= dayAgo);
  if (rows.length < 2) {
    el.innerHTML = '<div class="empty">Слишком мало данных за 24 часа</div>';
    return;
  }

  const max = Math.max(1, ...rows.map((r) => r.players_online));

  // Draw a real line chart (SVG) instead of bars: x = time, y = players online.
  const W = 1000;
  const H = 140;
  const padX = 6;
  const padY = 10;

  const n = rows.length;
  const points = rows.map((r, i) => {
    const x = padX + (n === 1 ? W / 2 : (i / (n - 1)) * (W - padX * 2));
    const y = H - padY - (r.players_online / max) * (H - padY * 2);
    return { x, y, r };
  });

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");
  const areaPath =
    `M${points[0].x.toFixed(1)},${H - padY} ` +
    points.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") +
    ` L${points[n - 1].x.toFixed(1)},${H - padY} Z`;

  const peak = rows.reduce((a, b) => (b.players_online > a.players_online ? b : a));
  const peakIdx = rows.indexOf(peak);
  const peakX = points[peakIdx].x.toFixed(1);
  const peakY = points[peakIdx].y.toFixed(1);

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="online-svg" role="img" aria-label="Онлайн за 24 часа">
      <defs>
        <linearGradient id="onlineGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.35" />
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
        </linearGradient>
      </defs>
      <path d="${areaPath}" fill="url(#onlineGrad)" />
      <path d="${linePath}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke" />
      <circle cx="${peakX}" cy="${peakY}" r="3.5" fill="var(--warn)" vector-effect="non-scaling-stroke" />
      <text x="${peakX}" y="${Math.max(10, parseFloat(peakY) - 6).toFixed(1)}" text-anchor="middle" fill="var(--warn)" font-size="11">макс: ${peak.players_online}</text>
    </svg>
    <div class="chart-labels"><span>${fmtTime(rows[0].created_at)}</span><span>сейчас: ${rows[n - 1].players_online}</span></div>
  `;
}

/* ---------- Chat (messenger-style: players list + conversation) ---------- */

let chatPeers = []; // distinct players from chat logs
let chatPeerSid = null; // selected player in the DM tab
let chatTab = "general";
let chatSearchQuery = "";

async function loadChat() {
  const { data, error } = await sb
    .from("chat_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(300);

  const log = document.getElementById("chatLog");
  if (error || !data) {
    if (log) log.innerHTML = '<div class="empty">Ошибка загрузки</div>';
    return;
  }

  // Build the player list (peers) for the DM tab.
  const seen = {};
  chatPeers = [];
  data.forEach((m) => {
    if (!m.steamid || seen[m.steamid]) return;
    seen[m.steamid] = true;
    chatPeers.push({ steamid: m.steamid, name: m.name, last: m.created_at });
  });

  renderChatPeers();

  if (!data.length) {
    if (log) log.innerHTML = '<div class="empty">Сообщений пока нет</div>';
    return;
  }

  // General chat: newest at the bottom, like a real chat.
  if (log) {
    log.innerHTML = data
      .slice()
      .reverse()
      .map(
        (m) => `
        <div class="chat-msg" data-sid="${esc(m.steamid || "")}" data-name="${esc(m.name || "")}">
          <div class="avatar" style="background:${avatarColor(m.name)}">${initials(m.name)}</div>
          <div class="body">
            <div class="meta">
              <span class="nick">${esc(m.name) || "—"}</span>
              <span class="time">${fmtTime(m.created_at)}</span>
            </div>
            <div class="text">${esc(m.message)}</div>
          </div>
        </div>`
      )
      .join("");
    log.scrollTop = log.scrollHeight;

    // Right-click a message -> reply in DM / mute
    log.querySelectorAll(".chat-msg[data-sid]").forEach((row) => {
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        chatCtxMenu(e.clientX, e.clientY, row.dataset.sid, row.dataset.name);
      });
      row.addEventListener("click", () => {
        openDmWith(row.dataset.sid, row.dataset.name);
      });
    });
  }

  if (chatTab === "player" && chatPeerSid) {
    loadDmHistory(chatPeerSid);
  }
}

// Renders the left-hand player list (peers).
function renderChatPeers() {
  const el = document.getElementById("chatPeers");
  if (!el) return;

  const q = chatSearchQuery.trim().toLowerCase();
  const list = q ? chatPeers.filter((p) => String(p.name || "").toLowerCase().includes(q)) : chatPeers;

  if (!list.length) {
    el.innerHTML = '<div class="empty">Никого не найдено</div>';
    return;
  }

  el.innerHTML = list
    .map(
      (p) => `
      <div class="chat-peer ${p.steamid === chatPeerSid ? "active" : ""}" data-sid="${esc(p.steamid)}">
        <span class="avatar small" style="background:${avatarColor(p.name)}">${initials(p.name)}</span>
        <div class="chat-peer-info">
          <b>${esc(p.name) || "—"}</b>
          <span class="muted small">${fmtTime(p.last)}</span>
        </div>
      </div>`
    )
    .join("");

  el.querySelectorAll(".chat-peer").forEach((row) => {
    row.addEventListener("click", () => {
      const p = chatPeers.find((x) => x.steamid === row.dataset.sid);
      if (p) openDmWith(p.steamid, p.name);
    });
  });
}

// Opens the DM tab with a specific player.
function openDmWith(steamid, name) {
  chatPeerSid = steamid;
  switchView("chat");
  setChatTab("player");

  const h = document.getElementById("chatHeader");
  h.innerHTML = `
    <span class="avatar small" style="background:${avatarColor(name)}">${initials(name)}</span>
    <div>
      <b>${esc(name) || "—"}</b>
      <span class="mono muted small" style="margin-left:6px">${esc(steamid)}</span>
    </div>`;

  document.getElementById("pmChatInput").focus();
  renderChatPeers();
  loadDmHistory(steamid);
}

// Loads the DM history with the selected player.
async function loadDmHistory(steamid) {
  const el = document.getElementById("pmLog");
  if (!el || !steamid) return;

  const { data } = await sb
    .from("chat_logs")
    .select("*")
    .eq("steamid", steamid)
    .order("created_at", { ascending: false })
    .limit(100);

  if (!data || !data.length) {
    el.innerHTML = '<div class="empty">Этот игрок ещё ничего не писал в чат</div>';
    return;
  }

  el.innerHTML = data
    .slice()
    .reverse()
    .map(
      (m) => `
      <div class="chat-msg">
        <div class="avatar" style="background:${avatarColor(m.name)}">${initials(m.name)}</div>
        <div class="body">
          <div class="meta">
            <span class="nick">${esc(m.name) || "—"}</span>
            <span class="time">${fmtTime(m.created_at)}</span>
          </div>
          <div class="text">${esc(m.message)}</div>
        </div>
      </div>`
    )
    .join("");
  el.scrollTop = el.scrollHeight;
}

function setChatTab(name) {
  chatTab = name;
  document.querySelectorAll("[data-ctab]").forEach((t) => t.classList.toggle("active", t.dataset.ctab === name));
  document.querySelectorAll(".ctab").forEach((c) => c.classList.toggle("active", c.id === "ctab-" + name));
  if (name === "player" && chatPeerSid) {
    loadDmHistory(chatPeerSid);
  }
}

function chatCtxMenu(x, y, steamid, name) {
  showCtxMenu(x, y, [
    { label: "Ответить в ЛС", fn: () => openPmModal(steamid, name) },
    { label: "Замутить", fn: () => openMuteModal(steamid, name) },
  ]);
}

async function sendBroadcast(message) {
  const input = document.getElementById("broadcastInput");
  const ok = await sendCommand({ command: "broadcast", message });
  if (ok) {
    input.value = "";
    refreshAll();
  }
}

// Sends a private message from the chat tab.
async function sendPmChat() {
  if (!chatPeerSid) {
    alert("Сначала выберите игрока в списке слева");
    return;
  }
  const input = document.getElementById("pmChatInput");
  const text = input.value.trim();
  if (!text) return;

  const peer = chatPeers.find((x) => x.steamid === chatPeerSid);
  const ok = await sendCommand({
    command: "say",
    steamid: chatPeerSid,
    name: peer ? peer.name : null,
    message: text,
  });
  if (ok) {
    input.value = "";
    setTimeout(() => loadDmHistory(chatPeerSid), 900);
  }
}

/* ---------- PM modal ---------- */

let pmTarget = null;

function openPmModal(steamid, name) {
  pmTarget = { steamid, name };
  document.getElementById("pmTitle").textContent = "Личное сообщение";
  document.getElementById("pmTarget").textContent = name || steamid;
  document.getElementById("pmText").value = "";
  document.getElementById("pmModal").classList.remove("hidden");
  setTimeout(() => document.getElementById("pmText").focus(), 60);
}

function closePmModal() {
  document.getElementById("pmModal").classList.add("hidden");
  pmTarget = null;
}

async function sendPm() {
  if (!pmTarget) return;
  const text = document.getElementById("pmText").value.trim();
  if (!text) return;

  const ok = await sendCommand({
    command: "say",
    steamid: pmTarget.steamid,
    name: pmTarget.name,
    message: text,
  });
  if (ok) closePmModal();
}

/* ---------- Mute modal ---------- */

let muteTarget = null;

function openMuteModal(steamid, name) {
  if (!steamid) {
    alert("У сообщения нет SteamID — игрок, возможно, уже вышел");
    return;
  }
  muteTarget = { steamid, name };
  document.getElementById("muteTarget").textContent = name || steamid;
  document.getElementById("muteReason").value = "Спам / токсичность";
  document.getElementById("muteDuration").value = "60";
  document.getElementById("muteModal").classList.remove("hidden");
  setTimeout(() => document.getElementById("muteReason").focus(), 60);
}

function closeMuteModal() {
  document.getElementById("muteModal").classList.add("hidden");
  muteTarget = null;
}

async function confirmMute() {
  if (!muteTarget) return;
  const reason = document.getElementById("muteReason").value.trim() || "Спам / токсичность";
  const d = document.getElementById("muteDuration").value.trim();
  const duration = d && !isNaN(d) ? parseInt(d, 10) : null;

  const ok = await sendCommand({
    command: "mute",
    steamid: muteTarget.steamid,
    name: muteTarget.name,
    reason,
    duration_minutes: duration,
  });
  if (ok) {
    closeMuteModal();
    refreshAll();
  }
}

/* ---------- History (kills / connections / actions in tabs) ---------- */

function loadHistoryTab(name) {
  if (!name) {
    const active = document.querySelector("[data-htab].active");
    name = active ? active.dataset.htab : "kills";
  }
  if (name === "kills") loadKills();
  if (name === "connections") loadConnections();
  if (name === "actions") loadActions();
}

/* ---------- Kills ---------- */

SORT_GETTERS.kills = {
  attacker: (k) => k.attacker_name,
  victim: (k) => k.victim_name,
  weapon: (k) => k.weapon,
  distance: (k) => k.distance ?? null,
  created_at: (k) => (k.created_at ? new Date(k.created_at).getTime() : 0),
};
SORT_RENDER.kills = renderKills;

async function loadKills() {
  const { data, error } = await sb
    .from("kills")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    document.getElementById("killsBody").innerHTML = `<tr><td colspan="5" class="empty">Ошибка загрузки</td></tr>`;
    return;
  }
  tableCache.kills = data || [];
  renderKills();
}

function renderKills() {
  const body = document.getElementById("killsBody");
  const all = tableCache.kills || [];
  if (!all.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">Убийств нет</td></tr>';
    return;
  }

  body.innerHTML = sortedRows("kills", all)
    .map(
      (k) => `
      <tr>
        <td><b>${esc(k.attacker_name)}</b></td>
        <td>${esc(k.victim_name)}</td>
        <td>${esc(k.weapon)}</td>
        <td>${k.distance ? k.distance + " м" : "—"}</td>
        <td>${fmtTime(k.created_at)}</td>
      </tr>`
    )
    .join("");
}

/* ---------- Connections ---------- */

SORT_GETTERS.connections = {
  name: (c) => c.name,
  steamid: (c) => c.steamid,
  ip: (c) => c.ip,
  type: (c) => c.type,
  created_at: (c) => (c.created_at ? new Date(c.created_at).getTime() : 0),
};
SORT_RENDER.connections = renderConnections;

async function loadConnections() {
  const { data, error } = await sb
    .from("connection_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    document.getElementById("connectionsBody").innerHTML = `<tr><td colspan="5" class="empty">Ошибка загрузки</td></tr>`;
    return;
  }
  tableCache.connections = data || [];
  renderConnections();
}

function renderConnections() {
  const body = document.getElementById("connectionsBody");
  const all = tableCache.connections || [];
  if (!all.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">Подключений нет</td></tr>';
    return;
  }

  body.innerHTML = sortedRows("connections", all)
    .map(
      (c) => `
      <tr>
        <td><b>${esc(c.name)}</b></td>
        <td class="mono">${esc(c.steamid)}</td>
        <td class="mono">${esc(c.ip)}</td>
        <td><span class="tag ${c.type === "join" ? "ok" : "muted"}">${c.type === "join" ? "зашёл" : "вышел"}</span></td>
        <td>${fmtTime(c.created_at)}</td>
      </tr>`
    )
    .join("");
}

/* ---------- IP checks ---------- */

SORT_GETTERS.ipchecks = {
  ip: (c) => c.ip,
  name: (c) => c.name,
  country: (c) => c.country || c.country_code,
  isp: (c) => c.isp,
  is_vpn: (c) => (c.is_vpn ? 1 : 0),
  risk: (c) => c.risk ?? null,
  created_at: (c) => (c.created_at ? new Date(c.created_at).getTime() : 0),
};
SORT_RENDER.ipchecks = renderIpChecks;

async function loadIpChecks() {
  const { data, error } = await sb
    .from("ip_checks")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    document.getElementById("ipChecksBody").innerHTML = `<tr><td colspan="8" class="empty">Ошибка загрузки: ${esc(error?.message || "")}</td></tr>`;
    return;
  }
  tableCache.ipchecks = data || [];
  renderIpChecks();
}

function renderIpChecks() {
  const body = document.getElementById("ipChecksBody");
  const all = tableCache.ipchecks || [];
  if (!all.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty">IP ещё не проверялся. Игроки проверяются автоматически при заходе на сервер, либо введите любой IP выше.</td></tr>';
    return;
  }

  body.innerHTML = sortedRows("ipchecks", all)
    .map(
      (c) => `
      <tr>
        <td class="mono"><b>${esc(c.ip)}</b></td>
        <td>${c.name ? `<b>${esc(c.name)}</b>` : '<span class="muted">ручная</span>'}</td>
        <td>${countryFlag(c.country_code)} ${esc(c.country) || "—"}</td>
        <td>${esc(c.isp) || "—"}<br><span class="muted mono small">${esc(c.asn) || ""}</span></td>
        <td>${esc(c.proxy_type) || (c.is_vpn ? "VPN" : "—")}</td>
        <td>${c.is_vpn ? '<span class="tag vpn">VPN/PROXY</span>' : '<span class="tag ok">чисто</span>'}</td>
        <td>${riskTag(c.risk)}</td>
        <td>${fmtTime(c.created_at)}</td>
      </tr>`
    )
    .join("");
}

// Sends the "checkip" command to the plugin and waits for the fresh ip_checks row.
let lastCheckId = 0;

async function checkIp(ip) {
  const status = document.getElementById("checkIpStatus");
  status.textContent = "Отправлено на сервер, жду результат…";

  const sent = await sendCommand({ command: "checkip", ip });
  if (!sent) {
    status.textContent = "Не удалось отправить";
    return;
  }

  // The plugin executes the lookup (a few seconds), then inserts an ip_checks row
  // with source=manual. Poll a couple of times until it appears.
  const before = Date.now();
  let tries = 0;
  const tick = async () => {
    tries++;
    const { data } = await sb
      .from("ip_checks")
      .select("*")
      .eq("ip", ip)
      .order("created_at", { ascending: false })
      .limit(1);
    const row = data && data[0];
    if (row && new Date(row.created_at).getTime() >= before - 30000) {
      status.innerHTML = row.is_vpn
        ? `<span class="tag vpn">VPN/PROXY${row.proxy_type ? " (" + esc(row.proxy_type) + ")" : ""}</span> ${countryFlag(row.country_code)} ${esc(row.country)} · ${esc(row.isp)}`
        : `<span class="tag ok">чисто</span> ${countryFlag(row.country_code)} ${esc(row.country)} · ${esc(row.isp)}`;
      loadIpChecks();
      return;
    }
    if (tries < 8) {
      setTimeout(tick, 2000);
    } else {
      status.textContent = "Ответ не пришёл — проверь, что плагин запущен";
    }
  };
  setTimeout(tick, 2500);
}

/* ---------- Actions (commands) ---------- */

SORT_GETTERS.actions = {
  command: (c) => c.command,
  name: (c) => c.name || c.steamid,
  admin: (c) => c.admin,
  status: (c) => c.status,
  created_at: (c) => (c.created_at ? new Date(c.created_at).getTime() : 0),
};
SORT_RENDER.actions = renderActions;

async function loadActions() {
  const { data, error } = await sb
    .from("commands")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    document.getElementById("actionsBody").innerHTML = `<tr><td colspan="7" class="empty">Ошибка загрузки</td></tr>`;
    return;
  }
  tableCache.actions = data || [];
  renderActions();
}

function renderActions() {
  const body = document.getElementById("actionsBody");
  const all = tableCache.actions || [];
  if (!all.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">Действий пока не было</td></tr>';
    return;
  }

  body.innerHTML = sortedRows("actions", all)
    .map(
      (c) => `
      <tr>
        <td><span class="tag ${c.command === "ban" ? "danger" : c.command === "kick" ? "warn" : "muted"}">${c.command}</span></td>
        <td>${esc(c.name) || esc(c.steamid) || "—"}</td>
        <td>${esc(c.reason || c.message || "")}</td>
        <td>${esc(c.admin)}</td>
        <td><span class="tag ${c.status === "done" ? "ok" : c.status === "failed" ? "danger" : "warn"}">${c.status}</span></td>
        <td class="muted">${esc(c.result || "")}</td>
        <td>${fmtTime(c.created_at)}</td>
      </tr>`
    )
    .join("");
}

// Rust world size in Unity units. Full map = 6000; smaller maps are 4500/3500 etc.
// Positions are centered on (0,0), so x/z range roughly -WORLD_SIZE/2..WORLD_SIZE/2.
let WORLD_SIZE = 6000;

/* ---------- Map (players positions) ---------- */

const mapToggles = { online: true, offline: true, sleepers: true };

// A player only gets a dot once the server has reported real coordinates.
// Columns default to 0, so a fresh database would otherwise pile everyone in
// the centre of the map.
function hasPos(p) {
  return p.pos_x != null && p.pos_z != null && (p.pos_x !== 0 || p.pos_z !== 0);
}

function mapLeft(x) {
  const half = WORLD_SIZE / 2;
  return Math.max(0, Math.min(100, ((x + half) / WORLD_SIZE) * 100));
}
function mapTop(z) {
  const half = WORLD_SIZE / 2;
  // Unity z grows to the south; the in-game map north is -z.
  return Math.max(0, Math.min(100, ((-z + half) / WORLD_SIZE) * 100));
}

async function loadMap() {
  if (!window._mapAxisDone) {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    document.getElementById("mapAxisX").innerHTML = letters.map((l) => `<span>${l}</span>`).join("");
    document.getElementById("mapAxisY").innerHTML = letters.map((_, i) => `<span>${i + 1}</span>`).join("");
    window._mapAxisDone = true;
  }

  const [{ data: players, error }, { data: sleepers }] = await Promise.all([
    sb.from("players").select("steamid,name,pos_x,pos_z,is_vpn,online,last_seen").limit(500),
    sb.from("sleepers").select("steamid,name,pos_x,pos_z,last_seen").limit(500),
  ]);

  const el = document.getElementById("mapCanvas");
  if (!el) return;

  if (error) {
    el.innerHTML = `<div class="empty">Ошибка загрузки: ${esc(error?.message || "")}</div>`;
    return;
  }
  tableCache.mapPlayers = players || [];
  tableCache.mapSleepers = sleepers || [];
  renderMap();
}

function renderMap() {
  const el = document.getElementById("mapCanvas");
  if (!el) return;
  const players = tableCache.mapPlayers || [];
  const sleepers = tableCache.mapSleepers || [];

  const on = players.filter((p) => p.online && hasPos(p));
  const off = players.filter((p) => !p.online && hasPos(p));
  const sl = sleepers.filter(hasPos);
  const noPos = players.filter((p) => !hasPos(p)).length;

  const dots = [];
  if (mapToggles.online) {
    on.forEach((p) => {
      dots.push(`<div class="map-dot ${p.is_vpn ? "vpn" : ""}" style="left:${mapLeft(p.pos_x)}%;top:${mapTop(p.pos_z)}%;background:${avatarColor(p.name)}" title="${esc(p.name)} — онлайн (${Math.round(p.pos_x)}, ${Math.round(p.pos_z)})" data-sid="${esc(p.steamid)}" data-name="${esc(p.name)}">${initials(p.name)}</div>`);
    });
  }
  if (mapToggles.offline) {
    off.forEach((p) => {
      dots.push(`<div class="map-dot offline" style="left:${mapLeft(p.pos_x)}%;top:${mapTop(p.pos_z)}%;background:${avatarColor(p.name)}" title="${esc(p.name)} — последняя позиция (${Math.round(p.pos_x)}, ${Math.round(p.pos_z)})" data-sid="${esc(p.steamid)}" data-name="${esc(p.name)}">${initials(p.name)}</div>`);
    });
  }
  if (mapToggles.sleepers) {
    sl.forEach((s) => {
      dots.push(`<div class="map-dot sleeper" style="left:${mapLeft(s.pos_x)}%;top:${mapTop(s.pos_z)}%" title="${esc(s.name)} — спальник (${Math.round(s.pos_x)}, ${Math.round(s.pos_z)})" data-sid="${esc(s.steamid)}" data-name="${esc(s.name)}">Z</div>`);
    });
  }

  if (!dots.length) {
    el.innerHTML = noPos
      ? `<div class="empty">${noPos} игроков в базе, но сервер ещё не прислал ни одной позиции. Обнови плагин до версии с записью координат и дождись, пока зайдут игроки.</div>`
      : '<div class="empty">Нет позиций — точки появятся, когда игроки зайдут на сервер</div>';
  } else {
    el.innerHTML = dots.join("");
    el.querySelectorAll(".map-dot").forEach((d) => {
      d.addEventListener("click", () => openPlayerCard(d.dataset.sid));
      d.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        playerCtxMenu(e.clientX, e.clientY, d.dataset.sid, d.dataset.name);
      });
    });
  }

  document.getElementById("mapLegend").innerHTML =
    `Онлайн: <b>${on.length}</b> · последние позиции: ${off.length} · спальников: ${sl.length}` +
    (noPos ? ` · без координат: ${noPos}` : "") +
    " · клик — профиль, правый клик — меню";
}

/* ---------- Sleepers ---------- */

SORT_GETTERS.sleepers = {
  name: (s) => s.name,
  steamid: (s) => s.steamid,
  last_seen: (s) => (s.last_seen ? new Date(s.last_seen).getTime() : 0),
};
SORT_RENDER.sleepers = renderSleepers;

async function loadSleepers() {
  const { data, error } = await sb
    .from("sleepers")
    .select("*")
    .order("last_seen", { ascending: false })
    .limit(200);

  if (error) {
    document.getElementById("sleepersBody").innerHTML = `<tr><td colspan="5" class="empty">Ошибка загрузки</td></tr>`;
    return;
  }
  tableCache.sleepers = data || [];
  renderSleepers();
}

function renderSleepers() {
  const body = document.getElementById("sleepersBody");
  const all = tableCache.sleepers || [];
  const cnt = document.getElementById("sleepersCount");
  if (cnt) cnt.innerHTML = `Спальников на карте: <b>${all.length}</b>`;

  if (!all.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">Спящих игроков нет</td></tr>';
    return;
  }

  body.innerHTML = sortedRows("sleepers", all)
    .map(
      (s) => `
      <tr>
        <td><span class="avatar small" style="background:${avatarColor(s.name)}">${initials(s.name)}</span> ${esc(s.name) || "—"}</td>
        <td class="mono">${esc(s.steamid)}</td>
        <td class="mono">${s.pos_x ?? 0}, ${s.pos_z ?? 0} <span class="muted small">(${mapSquare(s.pos_x, s.pos_z)})</span></td>
        <td>${fmtTime(s.last_seen)}</td>
        <td>
          <button class="btn small" onclick="openPlayerCard('${esc(s.steamid)}')">Подробнее</button>
          <button class="btn small danger" onclick="openBanModal('${esc(s.steamid)}','${esc(s.name)}')">Бан</button>
        </td>
      </tr>`
    )
    .join("");
}

/* ---------- Servers ---------- */

async function loadServers() {
  const { data, error } = await sb.from("server_status").select("*").order("id", { ascending: true });

  const el = document.getElementById("serversList");
  if (error || !data) {
    el.innerHTML = '<div class="empty">Ошибка загрузки серверов</div>';
    return;
  }
  if (!data.length) {
    el.innerHTML = '<div class="empty">Серверы ещё не отправили первое сердцебиение</div>';
    return;
  }

  el.innerHTML = data
    .map((s) => {
      const ago = Math.round((Date.now() - new Date(s.last_heartbeat).getTime()) / 1000);
      const live = ago < 90;
      const loadPct = s.max_players ? Math.min(100, Math.round((s.players_online / s.max_players) * 100)) : 0;
      return `
      <div class="server-card">
        <div class="server-head">
          <span class="dot ${live ? "on" : "off"}"></span>
          <b>${esc(s.hostname) || "Rust Server"}</b>
          <span class="tag ${live ? "ok" : "danger"}">${live ? "онлайн" : `нет связи ${ago}с`}</span>
        </div>
        <div class="server-grid">
          <div class="server-cell"><span class="pkey">Игроки</span><span>${s.players_online ?? 0} / ${s.max_players ?? 0}</span></div>
          <div class="server-cell"><span class="pkey">FPS</span><span>${s.fps ?? 0}</span></div>
          <div class="server-cell"><span class="pkey">Обновление</span><span>${live ? "только что" : fmtTime(s.last_heartbeat)}</span></div>
        </div>
        <div class="server-bar"><div style="width:${loadPct}%"></div></div>
      </div>`;
    })
    .join("");
}

/* ---------- Settings ---------- */

const SETTINGS_KEY = "rap_settings_v1";

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

function saveSettings(patch) {
  const all = { ...loadSettings(), ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(all));
  return all;
}

// Default risk rules: everything flagged, matching the reference panel behaviour.
function riskRules() {
  const s = loadSettings();
  return {
    vpn: s.ruleVpn !== false,
    private: s.rulePrivate !== false,
    vac: s.ruleVac !== false,
    pirate: s.rulePirate !== false,
    hoursLimit: s.hoursLimit || 100,
  };
}

function bindSettings() {
  const s = loadSettings();
  const wh = document.getElementById("setWebhook");
  const hours = document.getElementById("setHoursLimit");
  if (wh) wh.value = s.webhook || "";
  if (hours) hours.value = s.hoursLimit || 100;
  ["ruleVpn", "rulePrivate", "ruleVac", "rulePirate"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.checked = s[id] !== false;
  });

  const okTag = document.getElementById("settingsSaved");
  const flash = () => {
    okTag.classList.remove("hidden");
    setTimeout(() => okTag.classList.add("hidden"), 1500);
  };

  const bw = document.getElementById("btnSaveWebhook");
  if (bw) {
    bw.addEventListener("click", () => {
      saveSettings({ webhook: (wh.value || "").trim() });
      flash();
    });
  }
  const bh = document.getElementById("btnSaveRules");
  if (bh) {
    bh.addEventListener("click", () => {
      saveSettings({
        hoursLimit: parseInt(hours.value, 10) > 0 ? parseInt(hours.value, 10) : 100,
        ruleVpn: document.getElementById("ruleVpn").checked,
        rulePrivate: document.getElementById("rulePrivate").checked,
        ruleVac: document.getElementById("ruleVac").checked,
        rulePirate: document.getElementById("rulePirate").checked,
      });
      flash();
    });
  }
}

/* ---------- Alerts ---------- */

const ALERT_META = {
  vpn: { icon: "🛡", label: "VPN-провайдер", rule: "Блокировка провайдеров", sev: "High", cls: "vpn" },
  report: { icon: "🚩", label: "Репорт", rule: "Жалобы игроков", sev: "Medium", cls: "warn" },
  ban: { icon: "🔨", label: "Бан", rule: "Действие администратора", sev: "Info", cls: "danger" },
  check: { icon: "🔍", label: "Проверка", rule: "Подозрительная активность", sev: "Medium", cls: "warn" },
};

const SEVERITY_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 };

SORT_GETTERS.alerts = {
  kind: (a) => (ALERT_META[a.kind] || {}).label || a.kind,
  player: (a) => alertPlayerName(a),
  rule: (a) => (ALERT_META[a.kind] || {}).rule || "—",
  sev: (a) => SEVERITY_RANK[(ALERT_META[a.kind] || {}).sev] ?? 5,
  created_at: (a) => (a.created_at ? new Date(a.created_at).getTime() : 0),
};
SORT_RENDER.alerts = renderAlerts;

// alerts.text is a free-form line like "VPN/proxy: PlayerName (1.2.3.4)";
// the player name is what follows the first colon, before the paren.
function alertPlayerName(a) {
  const cut = (a.text || "").indexOf(":");
  const rest = cut >= 0 ? (a.text || "").slice(cut + 1).trim() : (a.text || "");
  const paren = rest.indexOf("(");
  return paren > 0 ? rest.slice(0, paren).trim() : rest;
}

async function loadAlerts() {
  const { data, error } = await sb
    .from("alerts")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    document.getElementById("alertsBody").innerHTML = '<tr><td colspan="5" class="empty">Ошибка загрузки</td></tr>';
    return;
  }
  tableCache.alerts = data || [];
  renderAlerts();
}

function renderAlerts() {
  const body = document.getElementById("alertsBody");
  const all = tableCache.alerts || [];
  const cnt = document.getElementById("alertsCount");
  if (cnt) {
    const high = all.filter((a) => (SEVERITY_RANK[(ALERT_META[a.kind] || {}).sev] ?? 5) <= 1).length;
    cnt.innerHTML = `Всего алертов: <b>${all.length}</b> · критичных/высоких: ${high}`;
  }

  if (!all.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">Алертов пока нет</td></tr>';
    return;
  }

  body.innerHTML = sortedRows("alerts", all)
    .map((a) => {
      const m = ALERT_META[a.kind] || { icon: "ℹ", label: a.kind || "Событие", rule: "—", sev: "Info", cls: "muted" };
      return `
      <tr class="alert-row ${esc(a.kind)}">
        <td><span class="alert-ico">${m.icon}</span> ${m.label}</td>
        <td><b>${esc(alertPlayerName(a))}</b></td>
        <td class="small muted">${esc(m.rule)}</td>
        <td><span class="tag ${m.cls}">${m.sev}</span></td>
        <td>${fmtTime(a.created_at)}</td>
      </tr>`;
    })
    .join("");
}

/* ---------- Statistics ---------- */

async function loadStats() {
  const [
    { count: cPlayers },
    { count: cBans },
    { count: cReports },
    { count: cKills },
    { count: cSleepers },
    { count: cMutes },
  ] = await Promise.all([
    sb.from("players").select("steamid", { count: "exact", head: true }),
    sb.from("bans").select("id", { count: "exact", head: true }).eq("active", true),
    sb.from("reports").select("id", { count: "exact", head: true }),
    sb.from("kills").select("id", { count: "exact", head: true }),
    sb.from("sleepers").select("steamid", { count: "exact", head: true }),
    sb.from("mutes").select("id", { count: "exact", head: true }).eq("active", true),
  ]);

  document.getElementById("statsCards").innerHTML = [
    { label: "Всего игроков", value: cPlayers ?? 0 },
    { label: "Активных банов", value: cBans ?? 0, cls: "danger" },
    { label: "Репортов", value: cReports ?? 0, cls: "warn" },
    { label: "Убийств", value: cKills ?? 0 },
    { label: "Спальников", value: cSleepers ?? 0 },
    { label: "Активных мутов", value: cMutes ?? 0 },
  ]
    .map((c) => `<div class="stat-card"><div class="label ${c.cls || ""}">${c.label}</div><div class="value">${c.value}</div></div>`)
    .join("");

  // Top killers (client-side grouping over the last 500 kills)
  const { data: kills } = await sb
    .from("kills")
    .select("attacker_steamid,attacker_name")
    .order("created_at", { ascending: false })
    .limit(500);

  const counts = {};
  (kills || []).forEach((k) => {
    if (!k.attacker_steamid) return;
    counts[k.attacker_steamid] = counts[k.attacker_steamid] || { name: k.attacker_name || "—", n: 0 };
    counts[k.attacker_steamid].n++;
  });
  const top = Object.entries(counts)
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 8);

  document.getElementById("topKillers").innerHTML = top.length
    ? top
        .map(
          ([sid, v], i) => `
        <div class="top-row" style="cursor:pointer" onclick="openPlayerCard('${esc(sid)}')">
          <span class="top-num">${i + 1}</span>
          <span class="avatar small" style="background:${avatarColor(v.name)}">${initials(v.name)}</span>
          <span>${esc(v.name)}</span>
          <span class="top-count">${v.n}</span>
        </div>`
        )
        .join("")
    : '<div class="empty">Убийств пока не было</div>';

  // Server block
  const { data: st } = await sb.from("server_status").select("*").eq("id", 1).maybeSingle();
  const ago = st ? Math.round((Date.now() - new Date(st.last_heartbeat).getTime()) / 1000) : null;
  document.getElementById("statsServer").innerHTML = st
    ? `
      <div class="prow"><span class="pkey">Название</span><span>${esc(st.hostname) || "Rust Server"}</span></div>
      <div class="prow"><span class="pkey">Игроков онлайн</span><span><b>${st.players_online}</b> / ${st.max_players}</span></div>
      <div class="prow"><span class="pkey">FPS</span><span><b>${st.fps}</b></span></div>
      <div class="prow"><span class="pkey">Сервер</span><span>${ago !== null && ago < 90 ? '<span class="tag ok">в сети</span>' : `<span class="tag warn">нет связи ${ago}с</span>`}</span></div>`
    : '<div class="empty">Сервер не в сети</div>';
}

/* ---------- Audit log ---------- */

SORT_GETTERS.audit = {
  admin: (c) => c.admin,
  command: (c) => c.command,
  name: (c) => c.name || c.steamid,
  status: (c) => c.status,
  created_at: (c) => (c.created_at ? new Date(c.created_at).getTime() : 0),
};
SORT_RENDER.audit = renderAudit;

async function loadAudit() {
  const { data, error } = await sb
    .from("commands")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    document.getElementById("auditBody").innerHTML = '<tr><td colspan="5" class="empty">Ошибка загрузки</td></tr>';
    return;
  }
  tableCache.audit = data || [];
  renderAudit();
}

function renderAudit() {
  const body = document.getElementById("auditBody");
  const all = tableCache.audit || [];
  const cnt = document.getElementById("auditCount");
  if (cnt) cnt.innerHTML = `Действий в журнале: <b>${all.length}</b>`;

  if (!all.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">Действий пока не было</td></tr>';
    return;
  }

  body.innerHTML = sortedRows("audit", all)
    .map(
      (c) => `
      <tr>
        <td>${esc(c.admin) || "—"}</td>
        <td><span class="tag ${c.command === "ban" ? "danger" : c.command === "kick" ? "warn" : "muted"}">${esc(c.command)}</span></td>
        <td><b>${esc(c.name) || esc(c.steamid) || "—"}</b></td>
        <td><span class="tag ${c.status === "done" ? "ok" : c.status === "failed" ? "danger" : "warn"}">${esc(c.status)}</span></td>
        <td>${fmtTime(c.created_at)}</td>
      </tr>`
    )
    .join("");
}

/* ---------- Staff (admins) ---------- */

SORT_GETTERS.staff = {
  email: (a) => a.email,
  role: (a) => a.role,
  created_at: (a) => (a.created_at ? new Date(a.created_at).getTime() : 0),
};
SORT_RENDER.staff = renderStaff;

async function loadStaff() {
  const { data, error } = await sb.from("admins").select("*").order("created_at", { ascending: true });

  if (error) {
    document.getElementById("staffBody").innerHTML = '<tr><td colspan="5" class="empty">Ошибка загрузки</td></tr>';
    return;
  }
  tableCache.staff = data || [];
  renderStaff();
}

function renderStaff() {
  const body = document.getElementById("staffBody");
  const all = tableCache.staff || [];
  if (!all.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">Сотрудников нет</td></tr>';
    return;
  }

  const PERMS = {
    owner: "Все права",
    admin: "Репорты, баны, чат, проверки",
    moderator: "Репорты, чат, проверки",
    support: "Репорты, заметки",
  };

  body.innerHTML = sortedRows("staff", all)
    .map(
      (a) => `
      <tr>
        <td><b>${esc(a.email)}</b></td>
        <td><span class="tag ${a.role === "owner" ? "warn" : "muted"}">${esc(a.role)}</span></td>
        <td class="small">${PERMS[a.role] || "Репорты"}</td>
        <td><span class="tag ok">Активен</span></td>
        <td>${fmtDate(a.created_at)}</td>
      </tr>`
    )
    .join("");
}

/* ---------- Command dispatch ---------- */

async function sendCommand(payload) {
  const row = {
    command: payload.command,
    steamid: payload.steamid || null,
    ip: payload.ip || null,
    hwid: payload.hwid || null,
    name: payload.name || null,
    reason: payload.reason || null,
    message: payload.message || null,
    duration_minutes: payload.duration_minutes || null,
    admin: currentUser.email,
    status: "pending",
  };

  const { error } = await sb.from("commands").insert([row]);
  if (error) {
    alert("Не удалось отправить команду: " + error.message);
    return false;
  }
  return true;
}

// Downloads the audit log (dispatched commands) as a plain-text file.
async function exportAudit() {
  const { data, error } = await sb
    .from("commands")
    .select("created_at,admin,command,name,steamid,status,result")
    .order("created_at", { ascending: false })
    .limit(5000);

  if (error || !data) {
    alert("Не удалось выгрузить аудит: " + (error?.message || ""));
    return;
  }

  const lines = data.map(
    (c) => `[${fmtTime(c.created_at)}] ${c.admin || "-"} | ${c.command} | ${c.name || c.steamid || "-"} | ${c.status}`
  );
  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `audit-${new Date().toISOString().slice(0, 10)}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function quickAction(action, steamid, name) {
  if (action === "ban") {
    openBanModal(steamid, name);
    return;
  }

  let reason = "";
  let duration = null;

  if (action === "kick") {
    reason = prompt("Причина кика:", "Чит / нарушение правил");
    if (reason === null) return;
  } else if (action === "mute") {
    reason = prompt("Причина мута:", "Спам / токсичность");
    if (reason === null) return;
    const d = prompt("Длительность мута в минутах (пусто = навсегда):", "60");
    if (d === null) return;
    duration = d && !isNaN(d) ? parseInt(d) : null;
  } else if (action === "unban" || action === "unmute") {
    const verb = action === "unban" ? "разбанить" : "размутить";
    if (!confirm(`Точно ${verb} ${name || steamid}?`)) return;
  }

  await sendCommand({
    command: action,
    steamid,
    name,
    reason,
    duration_minutes: duration,
  });
  refreshAll();
}

/* ---------- Ban modal ---------- */

function openBanModal(steamid, name, ip, hwid) {
  const card = document.getElementById("modalCard");
  card.innerHTML = `
    <h3>Бан игрока</h3>
    ${name ? `<p class="muted">${esc(name)}</p>` : ""}
    <label>SteamID</label>
    <input id="banSteamid" value="${esc(steamid) || ""}" placeholder="76561198000000000" />

    <label>IP (необязательно)</label>
    <input id="banIp" value="${esc(ip) || ""}" placeholder="1.2.3.4" />

    <label>HWID (необязательно)</label>
    <input id="banHwid" value="${esc(hwid) || ""}" placeholder="hwid" />

    <label>Причина</label>
    <select id="banReason">
      ${REPORT_REASONS.map((r) => `<option>${r}</option>`).join("")}
      <option>Чит</option>
      <option>Макросы</option>
      <option>Токсичность</option>
      <option>Другое</option>
    </select>
    <input id="banReasonCustom" placeholder="Своя причина (переопределяет выбор)" style="margin-top:6px" />

    <label>Длительность</label>
    <select id="banDuration">
      <option value="">Навсегда</option>
      <option value="60">1 час</option>
      <option value="1440">1 день</option>
      <option value="10080">7 дней</option>
      <option value="43200">30 дней</option>
    </select>

    <div class="check-row">
      <label><input type="checkbox" id="banByIp" ${ip ? "checked" : ""} /> Бан по IP</label>
      <label><input type="checkbox" id="banByHwid" ${hwid ? "checked" : ""} /> Бан по HWID</label>
    </div>

    <div class="row">
      <button class="btn" onclick="closeModal()">Отмена</button>
      <button class="btn danger" id="btnConfirmBan">Забанить</button>
    </div>
  `;

  document.getElementById("btnConfirmBan").addEventListener("click", async () => {
    const byIp = document.getElementById("banByIp").checked;
    const byHwid = document.getElementById("banByHwid").checked;
    const custom = document.getElementById("banReasonCustom").value.trim();
    const duration = document.getElementById("banDuration").value;

    const ok = await sendCommand({
      command: "ban",
      steamid: document.getElementById("banSteamid").value.trim(),
      ip: byIp ? document.getElementById("banIp").value.trim() : null,
      hwid: byHwid ? document.getElementById("banHwid").value.trim() : null,
      name: name || null,
      reason: custom || document.getElementById("banReason").value,
      duration_minutes: duration ? parseInt(duration) : null,
    });

    if (ok) {
      closeModal();
      refreshAll();
    }
  });

  document.getElementById("modal").classList.remove("hidden");
}

function closeModal() {
  const card = document.getElementById("modalCard");
  card.classList.remove("wide");
  document.getElementById("modal").classList.add("hidden");
}

/* ---------- Utils ---------- */

function esc(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shortHwid(hwid) {
  if (!hwid) return "—";
  return hwid.length > 12 ? hwid.substring(0, 12) + "…" : hwid;
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// Turns a two-letter country code into an emoji flag (Regional Indicator Symbols)
function countryFlag(cc) {
  if (!cc || cc.length !== 2 || !/^[a-zA-Z]{2}$/.test(cc)) return "";
  const base = 0x1f1e6;
  const offset = (ch) => ch.toUpperCase().charCodeAt(0) - "A".charCodeAt(0);
  return String.fromCodePoint(base + offset(cc[0]), base + offset(cc[1]));
}

// proxycheck.io risk score: 0-32 low, 33-65 medium, 66+ high
function riskTag(risk) {
  if (risk === null || risk === undefined) return "—";
  const cls = risk >= 66 ? "vpn" : risk >= 33 ? "warn" : "ok";
  return `<span class="tag ${cls}">${risk}</span>`;
}

// Deterministic color from a nickname, so the same player always gets the same avatar color
function avatarColor(name) {
  const palette = ["#fbbf24", "#f43f5e", "#10b981", "#43a6f0", "#c084fc", "#84cc16", "#f97316", "#a6a09a"];
  let hash = 0;
  const s = String(name || "?");
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length];
}

function initials(name) {
  const s = String(name || "?").trim();
  if (!s) return "?";
  return s.charAt(0).toUpperCase();
}

// Turns world coordinates into a Rust map square, like "B3" or "F10".
// The map grid is a letter column (A..) for X and a number row for Z.
function mapSquare(x, z) {
  if (x === null || x === undefined || z === null || z === undefined) return "—";
  const half = WORLD_SIZE / 2;
  if (Math.abs(x) > half + 500 || Math.abs(z) > half + 500) return "—";
  const col = Math.max(0, Math.min(25, Math.floor((x + half) / (WORLD_SIZE / 26))));
  const row = Math.max(0, Math.min(25, Math.floor((-z + half) / (WORLD_SIZE / 26))));
  return String.fromCharCode(65 + col) + (row + 1);
}
