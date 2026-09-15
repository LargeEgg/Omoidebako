// ---------------------------------------------------------------------------
// Omoidebako — personal anime & manga log
// ---------------------------------------------------------------------------

const STATUS_LABELS = {
  anime: { watching: "Watching", completed: "Completed", plan: "Plan to watch", on_hold: "On hold", dropped: "Dropped" },
  manga: { watching: "Reading", completed: "Completed", plan: "Plan to read", on_hold: "On hold", dropped: "Dropped" },
};
const MEDIA_LABEL = { anime: "Anime", manga: "Manga" };
const UNIT_LABEL = { anime: "episodes", manga: "chapters" };
const STATUS_COLOR = { watching: "var(--cyan)", completed: "var(--green)", plan: "var(--violet)", on_hold: "var(--amber)", dropped: "var(--magenta)" };
const THEME_COLORS = { cyan: "var(--cyan)", green: "var(--green)", amber: "var(--amber)", magenta: "var(--magenta)", violet: "var(--violet)", red: "var(--red)", blue: "var(--blue)" };
const THEME_HEX = { cyan: "#00E9FF", green: "#3CFF8A", amber: "#FFB020", magenta: "#FF2E7A", violet: "#B14EFF", red: "#FF4545", blue: "#4D8CFF" };
const ALL_TRACKERS = ["watching", "completed", "plan", "on_hold", "dropped"];
const PREFS_KEY = "omoidebako:prefs:v1";
const PAGE_SIZE = 120;

const state = {
  supabase: null,
  session: null,
  authMode: "signin",
  entries: [],
  mediaType: "anime",
  statusFilter: "all",
  folderFilter: null,
  pendingResult: null,
  detailId: null,
  detailTab: "overview",
  rendered: 0,

  theme: { anime: "cyan", manga: "magenta" },
  enabledTrackers: new Set(ALL_TRACKERS),
  view: "grid",
  sort: "recent",
  librarySearch: "",
  activeTags: new Set(),
};

const metaCache = {};
const galleryCache = {};
const charCache = {};

const $ = (id) => document.getElementById(id);

function toast(msg, sticky) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("visible");
  clearTimeout(toast._t);
  if (!sticky) toast._t = setTimeout(() => el.classList.remove("visible"), 2400);
}
function hideToast() {
  clearTimeout(toast._t);
  $("toast").classList.remove("visible");
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------
function loadPrefs() {
  try {
    const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    if (prefs.theme) state.theme = { ...state.theme, ...prefs.theme };
    if (Array.isArray(prefs.enabledTrackers)) state.enabledTrackers = new Set(prefs.enabledTrackers);
    if (prefs.view === "grid" || prefs.view === "list") state.view = prefs.view;
  } catch { /* ignore */ }
}
function savePrefs() {
  localStorage.setItem(PREFS_KEY, JSON.stringify({
    theme: state.theme,
    enabledTrackers: [...state.enabledTrackers],
    view: state.view,
  }));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  if (!window.SUPABASE_URL || window.SUPABASE_URL.startsWith("PASTE_")) {
    document.body.innerHTML =
      '<div class="auth-screen"><div class="auth-wrap" style="grid-template-columns:1fr;max-width:480px;">' +
      '<div class="wordmark"><h1>OMOIDE<span>BAKO</span></h1><p class="auth-sub">config.js still has placeholder ' +
      "values. Open config.js and paste in your Supabase project URL and anon key, then reload.</p></div></div></div>";
    return;
  }

  loadPrefs();
  state.supabase = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  wireAuthUI();
  wireAppUI();
  applyAccent();
  renderSwatches();
  applyTrackerVisibility();

  const { data } = await state.supabase.auth.getSession();
  state.session = data.session;
  state.supabase.auth.onAuthStateChange((_e, session) => {
    state.session = session;
    updateAuthVisibility();
    if (session) loadEntries();
  });
  updateAuthVisibility();
  if (state.session) loadEntries();
}

function updateAuthVisibility() {
  const signedIn = !!state.session;
  $("authScreen").classList.toggle("hidden", signedIn);
  $("app").classList.toggle("visible", signedIn);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function wireAuthUI() {
  $("authToggleBtn").addEventListener("click", () => {
    state.authMode = state.authMode === "signin" ? "signup" : "signin";
    $("authSubmit").textContent = state.authMode === "signin" ? "Sign in" : "Create account";
    $("authToggleText").textContent = state.authMode === "signin" ? "New here?" : "Already have an account?";
    $("authToggleBtn").textContent = state.authMode === "signin" ? "Create an account" : "Sign in";
    $("authError").textContent = "";
  });

  $("authSubmit").addEventListener("click", async () => {
    const email = $("authEmail").value.trim();
    const password = $("authPassword").value;
    $("authError").textContent = "";
    if (!email || !password) { $("authError").textContent = "Enter an email and password."; return; }
    $("authSubmit").disabled = true;
    try {
      if (state.authMode === "signin") {
        const { error } = await state.supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { error } = await state.supabase.auth.signUp({ email, password });
        if (error) throw error;
        toast("Account created — you're signed in.");
      }
    } catch (err) {
      $("authError").textContent = err.message || "Something went wrong.";
    } finally {
      $("authSubmit").disabled = false;
    }
  });

  $("authPassword").addEventListener("keydown", (e) => { if (e.key === "Enter") $("authSubmit").click(); });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function wireAppUI() {
  document.querySelectorAll("#typeSwitch button[data-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.type === state.mediaType) return;
      state.mediaType = btn.dataset.type;
      state.statusFilter = "all";
      state.folderFilter = null;
      state.activeTags.clear();
      state.librarySearch = "";
      $("librarySearch").value = "";
      $("typeSwitch").dataset.active = state.mediaType;
      document.querySelectorAll("#typeSwitch button[data-type]").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll("#statusList button[data-status]").forEach((b) => b.classList.toggle("active", b.dataset.status === "all"));
      applyAccent();
      loadEntries();
    });
  });

  $("statusList").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-status]");
    if (!btn) return;
    document.querySelectorAll("#statusList button[data-status]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.statusFilter = btn.dataset.status;
    renderGrid();
  });

  document.querySelectorAll(".tracker-eye").forEach((eye) => {
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      const status = eye.dataset.trackerToggle;
      const wasVisible = state.enabledTrackers.has(status);
      if (wasVisible) state.enabledTrackers.delete(status);
      else state.enabledTrackers.add(status);
      if (wasVisible && state.statusFilter === status) {
        state.statusFilter = "all";
        document.querySelectorAll("#statusList button[data-status]").forEach((b) => b.classList.toggle("active", b.dataset.status === "all"));
      }
      savePrefs();
      applyTrackerVisibility();
      renderCounts(); renderFolders(); renderTagChips(); renderGrid();
    });
  });

  $("openAddModal").addEventListener("click", () => openSearchModal());
  $("closeSearch").addEventListener("click", () => closeOverlay("searchOverlay"));
  $("searchOverlay").addEventListener("click", (e) => { if (e.target.id === "searchOverlay") closeOverlay("searchOverlay"); });

  let debounceTimer;
  $("searchInput").addEventListener("input", () => {
    clearTimeout(debounceTimer);
    const q = $("searchInput").value.trim();
    if (q.length < 2) { $("searchResults").innerHTML = ""; return; }
    debounceTimer = setTimeout(() => runSearch(q), 350);
  });

  $("closeEntry").addEventListener("click", () => closeOverlay("entryOverlay"));
  $("entryOverlay").addEventListener("click", (e) => { if (e.target.id === "entryOverlay") closeOverlay("entryOverlay"); });
  $("saveEntryBtn").addEventListener("click", saveNewEntry);

  $("openSettings").addEventListener("click", () => openOverlay("settingsOverlay"));
  $("closeSettings").addEventListener("click", () => closeOverlay("settingsOverlay"));
  $("settingsOverlay").addEventListener("click", (e) => { if (e.target.id === "settingsOverlay") closeOverlay("settingsOverlay"); });
  $("signOutBtn").addEventListener("click", () => state.supabase.auth.signOut());
  $("exportBtn").addEventListener("click", exportLibrary);
  $("importBtn").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", importLibrary);
  $("mihonBtn").addEventListener("click", () => $("mihonFile").click());
  $("mihonFile").addEventListener("change", handleMihonFile);
  $("mihonConfirm").addEventListener("click", runMihonImport);
  $("closeMihon").addEventListener("click", () => closeOverlay("mihonOverlay"));
  $("mihonOverlay").addEventListener("click", (e) => { if (e.target.id === "mihonOverlay") closeOverlay("mihonOverlay"); });
  $("enrichBtn").addEventListener("click", enrichLibrary);

  $("closeDetail").addEventListener("click", () => closeOverlay("detailOverlay"));
  $("detailOverlay").addEventListener("click", (e) => { if (e.target.id === "detailOverlay") closeOverlay("detailOverlay"); });
  $("detailTabs").addEventListener("click", (e) => {
    const t = e.target.closest("button[data-tab]");
    if (t) switchDetailTab(t.dataset.tab);
  });
  $("progMinus").addEventListener("click", () => bumpProgress(-1));
  $("progPlus").addEventListener("click", () => bumpProgress(1));
  $("progComplete").addEventListener("click", completeFromDetail);
  $("edSave").addEventListener("click", saveEditTab);
  $("edDelete").addEventListener("click", deleteFromDetail);
  $("edRefetchTags").addEventListener("click", refetchTagsInEdit);

  $("surpriseBtn").addEventListener("click", surpriseMe);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      ["mihonOverlay", "detailOverlay", "entryOverlay", "searchOverlay", "settingsOverlay"].forEach((id) => {
        if ($(id).classList.contains("visible")) closeOverlay(id);
      });
      return;
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
    if (typing || !state.session) return;
    if (e.key === "/") { e.preventDefault(); $("librarySearch").focus(); }
    if (e.key === "n") { e.preventDefault(); openSearchModal(); }
  });

  $("librarySearch").addEventListener("input", (e) => { state.librarySearch = e.target.value; renderGrid(); });
  $("sortSelect").addEventListener("change", (e) => { state.sort = e.target.value; renderGrid(); });
  $("filterToggle").addEventListener("click", () => $("filterPanel").classList.toggle("open"));

  $("viewGrid").addEventListener("click", () => {
    state.view = "grid";
    $("viewGrid").classList.add("active"); $("viewList").classList.remove("active");
    savePrefs(); renderGrid();
  });
  $("viewList").addEventListener("click", () => {
    state.view = "list";
    $("viewList").classList.add("active"); $("viewGrid").classList.remove("active");
    savePrefs(); renderGrid();
  });

  applyStatusLabels();
}

function openOverlay(id) { $(id).classList.add("visible"); }
function closeOverlay(id) {
  const el = $(id);
  el.classList.add("closing");
  setTimeout(() => {
    el.classList.remove("visible", "closing");
    if (id === "detailOverlay") {
      state.detailId = null;
      $("trailerFrame").removeAttribute("src");
      $("trailerFrame").dataset.vid = "";
    }
    if (id === "entryOverlay") state.pendingResult = null;
  }, 140);
}

function applyTrackerVisibility() {
  document.querySelectorAll("#statusList li[data-tracker]").forEach((li) => {
    const status = li.dataset.tracker;
    if (status === "all") return;
    const hidden = !state.enabledTrackers.has(status);
    li.classList.toggle("tracker-hidden", hidden);
    const eye = li.querySelector(".tracker-eye");
    if (eye) { eye.title = hidden ? "Show this tracker" : "Hide this tracker"; eye.textContent = hidden ? "🚫" : "👁"; }
  });
}

function applyAccent() {
  document.documentElement.style.setProperty("--accent", THEME_COLORS[state.theme[state.mediaType]]);
}

function renderSwatches() {
  document.querySelectorAll(".swatches").forEach((wrap) => {
    const target = wrap.dataset.themeTarget;
    wrap.innerHTML = Object.keys(THEME_HEX).map((name) =>
      `<span class="swatch ${state.theme[target] === name ? "selected" : ""}" data-theme-name="${name}" data-theme-target-color="${target}" style="background:${THEME_HEX[name]}; color:${THEME_HEX[name]}"></span>`
    ).join("");
  });
  document.querySelectorAll(".swatch").forEach((sw) => {
    sw.addEventListener("click", () => {
      const target = sw.dataset.themeTargetColor;
      state.theme[target] = sw.dataset.themeName;
      savePrefs(); renderSwatches();
      if (target === state.mediaType) { applyAccent(); renderGrid(); }
    });
  });
}

function applyStatusLabels() {
  const labels = STATUS_LABELS[state.mediaType];
  document.querySelectorAll("#statusList li[data-tracker]").forEach((li) => {
    const status = li.dataset.tracker;
    if (status === "all") return;
    const span = li.querySelector(".label");
    if (span) span.textContent = labels[status];
  });
  [$("entryStatus"), $("edStatus")].forEach((sel) => {
    if (!sel) return;
    [...sel.options].forEach((opt) => { if (labels[opt.value]) opt.textContent = labels[opt.value]; });
  });
  const base = (state.statusFilter === "all" ? "All " : labels[state.statusFilter] + " ") + MEDIA_LABEL[state.mediaType];
  $("mainTitle").textContent = state.folderFilter && state.folderFilter !== "__none__"
    ? `${base} · ${state.folderFilter}`
    : state.folderFilter === "__none__" ? `${base} · Unfiled` : base;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
async function loadEntries() {
  const { data, error } = await state.supabase
    .from("entries").select("*")
    .eq("media_type", state.mediaType)
    .order("updated_at", { ascending: false });

  if (error) {
    if (/column .* does not exist/i.test(error.message)) {
      toast("Run migration-v2.sql in Supabase — some new columns are missing.", true);
      return;
    }
    toast("Couldn't load your library: " + error.message);
    return;
  }
  state.entries = (data || []).map((e) => ({ ...e, tags: e.tags || [] }));
  renderCounts(); renderFolders(); renderTagChips(); renderGrid();
}

function visibleEntries() {
  return state.entries.filter((e) => state.enabledTrackers.has(e.status));
}

function renderCounts() {
  const counts = { all: visibleEntries().length, watching: 0, completed: 0, plan: 0, on_hold: 0, dropped: 0 };
  state.entries.forEach((e) => { counts[e.status] = (counts[e.status] || 0) + 1; });
  Object.keys(counts).forEach((k) => {
    const el = $("count-" + k);
    if (el) el.textContent = counts[k];
  });
}

function allFolders() {
  const freq = {};
  visibleEntries().forEach((e) => { if (e.folder) freq[e.folder] = (freq[e.folder] || 0) + 1; });
  return Object.keys(freq).sort((a, b) => a.localeCompare(b)).map((name) => ({ name, count: freq[name] }));
}

function renderFolders() {
  const folders = allFolders();
  const unfiled = visibleEntries().filter((e) => !e.folder).length;
  const wrap = $("folderList");
  const section = $("folderSection");

  if (folders.length === 0) { section.style.display = "none"; return; }
  section.style.display = "";

  const row = (key, label, count, icon) =>
    `<li><button class="folder-btn ${state.folderFilter === key ? "active" : ""}" data-folder="${key === null ? "" : escapeAttr(key)}">
      <span class="folder-icon">${icon}</span><span class="label">${escapeHtml(label)}</span><span class="count">${count}</span>
    </button></li>`;

  wrap.innerHTML =
    row(null, "All folders", visibleEntries().length, "▣") +
    folders.map((f) => row(f.name, f.name, f.count, "▸")).join("") +
    (unfiled ? row("__none__", "Unfiled", unfiled, "·") : "");

  wrap.querySelectorAll(".folder-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const val = btn.dataset.folder;
      state.folderFilter = val === "" ? null : val;
      renderFolders(); renderGrid();
    });
  });
}

function renderTagChips() {
  const freq = {};
  visibleEntries().forEach((e) => (e.tags || []).forEach((t) => { freq[t] = (freq[t] || 0) + 1; }));
  const sorted = Object.keys(freq).sort((a, b) => freq[b] - freq[a] || a.localeCompare(b));
  [...state.activeTags].forEach((t) => { if (!freq[t]) state.activeTags.delete(t); });

  const wrap = $("tagChips");
  wrap.innerHTML = sorted.map((t) =>
    `<button class="tag-chip ${state.activeTags.has(t) ? "active" : ""}" data-tag="${escapeAttr(t)}">${escapeHtml(t)}</button>`
  ).join("");

  requestAnimationFrame(() => {
    const limit = wrap.clientHeight;
    [...wrap.querySelectorAll(".tag-chip")].forEach((chip) => {
      if (chip.offsetTop + chip.offsetHeight > limit + 2) chip.remove();
    });
  });

  wrap.querySelectorAll(".tag-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const t = chip.dataset.tag;
      if (state.activeTags.has(t)) state.activeTags.delete(t);
      else state.activeTags.add(t);
      renderTagChips(); renderGrid();
    });
  });
}

function currentList() {
  let list = state.statusFilter === "all"
    ? visibleEntries()
    : state.entries.filter((e) => e.status === state.statusFilter && state.enabledTrackers.has(e.status));

  if (state.folderFilter === "__none__") list = list.filter((e) => !e.folder);
  else if (state.folderFilter) list = list.filter((e) => e.folder === state.folderFilter);

  if (state.librarySearch.trim()) {
    const q = state.librarySearch.trim().toLowerCase();
    list = list.filter((e) =>
      e.title.toLowerCase().includes(q) ||
      (e.folder || "").toLowerCase().includes(q) ||
      (e.tags || []).some((t) => t.toLowerCase().includes(q)));
  }
  if (state.activeTags.size) list = list.filter((e) => (e.tags || []).some((t) => state.activeTags.has(t)));

  if (state.sort !== "recent") {
    list = [...list].sort((a, b) => {
      if (state.sort === "score") return (b.score || 0) - (a.score || 0);
      if (state.sort === "progress") return (b.progress || 0) - (a.progress || 0);
      return a.title.localeCompare(b.title);
    });
  }
  return list;
}

function fallbackStyle(e) {
  const color = STATUS_COLOR[e.status];
  let hash = 0;
  for (const ch of e.title || "x") hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  return `background:
    radial-gradient(circle at 30% 20%, rgba(255,255,255,.08), transparent 60%),
    repeating-linear-gradient(135deg, ${color} 0 1px, transparent 1px 18px),
    radial-gradient(circle, rgba(255,255,255,.08) 1px, transparent 1.4px),
    linear-gradient(160deg, hsl(${hue} 30% 8%), #000);
    background-size:cover,auto,6px 6px,auto;`;
}

// a real <img> so a broken link can remove itself and reveal the gradient
function coverImg(url, cls) {
  if (!url) return "";
  return `<img class="${cls}" src="${escapeAttr(url)}" alt="" loading="lazy" onerror="this.remove()" />`;
}

let gridObserver = null;

function renderGrid() {
  applyStatusLabels();
  const list = currentList();
  $("mainCount").textContent = list.length;
  state.rendered = 0;

  const wrap = $("gridWrap");
  if (gridObserver) { gridObserver.disconnect(); gridObserver = null; }

  if (list.length === 0) {
    const allHidden = state.enabledTrackers.size === 0;
    wrap.innerHTML = allHidden
      ? '<div class="empty-state"><h3>Every tracker is hidden</h3><p>Click the eye next to a status in the sidebar to bring it back.</p></div>'
      : '<div class="empty-state"><h3>Nothing here yet</h3><p>Use "+ Add" to search titles and start your shelf.</p></div>';
    return;
  }

  wrap.innerHTML = `<div class="grid ${state.view === "list" ? "list-mode" : ""}" id="grid"></div><div id="gridSentinel"></div>`;
  appendChunk(list);

  if (list.length > PAGE_SIZE) {
    gridObserver = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) appendChunk(list);
    }, { rootMargin: "600px" });
    gridObserver.observe($("gridSentinel"));
  }
}

function appendChunk(list) {
  const grid = $("grid");
  if (!grid) return;
  const labels = STATUS_LABELS[state.mediaType];
  const slice = list.slice(state.rendered, state.rendered + PAGE_SIZE);
  if (!slice.length) { if (gridObserver) gridObserver.disconnect(); return; }

  const html = slice.map((e, idx) => {
    const color = STATUS_COLOR[e.status];
    const pct = e.total_units ? Math.min(100, Math.round((e.progress / e.total_units) * 100)) : 0;
    const metaLine = e.total_units ? `${e.progress || 0}/${e.total_units}` : (e.progress ? `${e.progress}` : "not started");
    const scoreLine = e.score ? `score ${e.score}` : "—";
    return `
      <div class="card holo" style="--glow:${color}; --i:${Math.min(idx, 24)}" data-id="${e.id}">
        <div class="card-cover" style="${fallbackStyle(e)}">
          ${coverImg(e.image_url, "cover-img")}
          <div class="scan"></div>
          <div class="card-badge" style="--glow:${color}">${labels[e.status]}</div>
          ${e.score ? `<span class="card-score">★ ${e.score}</span>` : ""}
          ${e.folder ? `<span class="card-folder">${escapeHtml(e.folder)}</span>` : ""}
          <div class="card-reveal"><span>${metaLine}</span><span>${scoreLine}</span></div>
        </div>
        <div class="card-body">
          <p class="card-title">${escapeHtml(e.title)}</p>
          <div class="card-meta"><span>${metaLine}</span><span>${labels[e.status]}</span></div>
          <div class="list-meta"><span>${metaLine}</span><span>${scoreLine}</span></div>
          ${e.total_units ? `<div class="card-progress-bar" style="--glow:${color}"><div style="width:${pct}%"></div></div>` : ""}
        </div>
      </div>`;
  }).join("");

  grid.insertAdjacentHTML("beforeend", html);
  state.rendered += slice.length;

  grid.querySelectorAll(".card:not([data-wired])").forEach((card) => {
    card.dataset.wired = "1";
    card.addEventListener("click", () => {
      card.classList.remove("pressed");
      void card.offsetWidth;
      card.classList.add("pressed");
      setTimeout(() => card.classList.remove("pressed"), 420);
      setTimeout(() => openDetail(card.dataset.id), 120);
    });
  });
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/'/g, "&#39;"); }

function surpriseMe() {
  const pool = state.entries.filter((e) => e.status === "plan" && state.enabledTrackers.has("plan"));
  const source = pool.length ? pool : visibleEntries();
  if (!source.length) { toast("Nothing on the shelf to pick from."); return; }
  const pick = source[Math.floor(Math.random() * source.length)];
  toast(pool.length ? "From your backlog: " + pick.title : "Picked: " + pick.title);
  openDetail(pick.id);
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------
function currentEntry() {
  return state.entries.find((x) => String(x.id) === String(state.detailId));
}

function openDetail(id) {
  const e = state.entries.find((x) => String(x.id) === String(id));
  if (!e) return;
  state.detailId = e.id;
  renderDetailHeader(e);
  switchDetailTab("overview");
  openOverlay("detailOverlay");
  $("detailPanel").scrollTop = 0;
  hydrateDetail(e);
}

function switchDetailTab(tab) {
  state.detailTab = tab;
  document.querySelectorAll("#detailTabs button[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".detail-tabpane").forEach((p) => p.classList.toggle("visible", p.dataset.pane === tab));
  $("detailBody").classList.toggle("wide", tab !== "overview");

  const e = currentEntry();
  if (!e) return;
  if (tab === "overview") renderOverview(e);
  if (tab === "edit") fillEditTab(e);
  if (tab === "gallery") loadGallery(e);
  if (tab === "characters") loadCharacters(e);
}

function renderDetailHeader(e) {
  const color = STATUS_COLOR[e.status];
  const labels = STATUS_LABELS[state.mediaType];
  const meta = metaCache[e.id];

  $("detailPanel").style.setProperty("--glow", color);

  const wide = e.banner_url || meta?.banner;
  const banner = wide || e.image_url || "";
  $("detailHeroBg").className = "detail-hero-bg" + (wide ? " is-banner" : "");
  $("detailHeroBg").setAttribute("style", banner ? `background-image:url('${escapeAttr(banner)}')` : "");

  $("detailCover").setAttribute("style", `--glow:${color}; ${fallbackStyle(e)}`);
  $("detailCover").innerHTML = coverImg(e.image_url, "cover-img");

  $("detailKicker").textContent = MEDIA_LABEL[state.mediaType].toUpperCase() + (e.folder ? " · " + e.folder.toUpperCase() : "");
  $("detailTitle").textContent = e.title;
  $("detailAlt").textContent = meta && meta.altTitle && meta.altTitle !== e.title ? meta.altTitle : "";

  $("detailChips").innerHTML = [
    `<span class="chip chip-status" style="--glow:${color}">${labels[e.status]}</span>`,
    meta && meta.type ? `<span class="chip">${escapeHtml(meta.type)}</span>` : "",
    meta && meta.year ? `<span class="chip">${meta.year}</span>` : "",
    meta && meta.airing ? `<span class="chip">${escapeHtml(meta.airing)}</span>` : "",
    e.score ? `<span class="chip chip-score">★ ${e.score}/10</span>` : "",
  ].filter(Boolean).join("");
}

function renderOverview(e) {
  const meta = metaCache[e.id];
  const labels = STATUS_LABELS[state.mediaType];
  const loading = meta === undefined;

  const total = e.total_units;
  const prog = e.progress || 0;
  const pct = total ? Math.min(100, Math.round((prog / total) * 100)) : 0;
  $("progNow").textContent = prog;
  $("progTotal").textContent = total ? "/ " + total : "";
  $("progUnit").textContent = UNIT_LABEL[state.mediaType];
  $("progFill").style.width = (total ? pct : 0) + "%";
  $("progPct").textContent = total ? pct + "%" : "no total known";
  $("progMinus").disabled = prog <= 0;
  $("progPlus").disabled = !!(total && prog >= total);
  $("progComplete").style.display = total && e.status !== "completed" ? "inline-flex" : "none";

  const stats = [
    ["Your score", e.score ? e.score + " / 10" : "—"],
    ["Status", labels[e.status]],
    ["Progress", total ? `${prog} / ${total}` : String(prog)],
    ["Folder", e.folder || "Unfiled"],
    ["Added", e.created_at ? new Date(e.created_at).toLocaleDateString() : "—"],
    ["Updated", e.updated_at ? new Date(e.updated_at).toLocaleDateString() : "—"],
  ];
  $("detailStatGrid").innerHTML = stats.map(([k, v]) =>
    `<div class="stat"><span class="stat-k">${k}</span><b class="stat-v">${escapeHtml(String(v))}</b></div>`).join("");

  const facts = [];
  if (meta) {
    if (meta.communityScore) facts.push(["Community score", meta.communityScore + " / 10"]);
    if (meta.rank) facts.push(["Ranked", "#" + meta.rank]);
    if (meta.popularity) facts.push(["Popularity", "#" + meta.popularity]);
    if (meta.episodes) facts.push([state.mediaType === "anime" ? "Episodes" : "Chapters", meta.episodes]);
    if (meta.volumes) facts.push(["Volumes", meta.volumes]);
    if (meta.duration) facts.push(["Runtime", meta.duration]);
    if (meta.season) facts.push(["Season", meta.season]);
    if (meta.studios) facts.push([state.mediaType === "anime" ? "Studio" : "Author", meta.studios]);
    if (meta.source) facts.push(["Source", meta.source]);
    if (meta.rating) facts.push(["Rating", meta.rating]);
  }
  $("detailFacts").innerHTML = facts.length
    ? facts.map(([k, v]) => `<div class="fact"><span>${k}</span><b>${escapeHtml(String(v))}</b></div>`).join("")
    : `<p class="muted-line">${loading ? "Loading details…" : "No extra details found."}</p>`;

  const syn = meta && meta.synopsis;
  $("detailSynopsis").textContent = syn || (loading ? "Loading…" : "No synopsis available from the source.");
  $("detailSynopsis").classList.toggle("muted-line", !syn);

  $("detailNotes").textContent = e.notes || "Nothing written down yet.";
  $("detailNotes").classList.toggle("muted-line", !e.notes);

  $("detailTags").innerHTML = (e.tags || []).length
    ? e.tags.map((t) => `<span class="dtag">${escapeHtml(t)}</span>`).join("")
    : '<span class="muted-line">No tags yet.</span>';

  const tr = meta && meta.trailerId;
  $("trailerBlock").style.display = tr ? "" : "none";
  if (tr && $("trailerFrame").dataset.vid !== tr) {
    $("trailerFrame").dataset.vid = tr;
    $("trailerFrame").src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(tr)}`;
  }

  const rel = (meta && meta.relations) || [];
  $("relatedBlock").style.display = rel.length ? "" : "none";
  if (rel.length) {
    $("relatedList").innerHTML = rel.map((r) =>
      `<button class="rel-item" data-title="${escapeAttr(r.name)}">
        <span class="rel-kind">${escapeHtml(r.relation)}</span>
        <span class="rel-name">${escapeHtml(r.name)}</span>
        <span class="rel-type">${escapeHtml(r.type || "")}</span>
      </button>`).join("");
    $("relatedList").querySelectorAll(".rel-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const title = btn.dataset.title;
        closeOverlay("detailOverlay");
        setTimeout(() => {
          openSearchModal();
          $("searchInput").value = title;
          runSearch(title);
        }, 180);
      });
    });
  }

  const q = encodeURIComponent(e.title);
  const malLink = e.mal_id ? `https://myanimelist.net/${state.mediaType}/${e.mal_id}` : `https://myanimelist.net/search/all?q=${q}`;
  let links = `<a href="${malLink}" target="_blank" rel="noopener">MyAnimeList ↗</a>`;
  links += `<a href="https://anilist.co/search/${state.mediaType}?search=${q}" target="_blank" rel="noopener">AniList ↗</a>`;
  if (state.mediaType === "manga") links += `<a href="https://mangadex.org/search?q=${q}" target="_blank" rel="noopener">MangaDex ↗</a>`;
  $("detailLinks").innerHTML = links;
}

function refreshDetail() {
  const e = currentEntry();
  if (!e) return;
  renderDetailHeader(e);
  if (state.detailTab === "overview") renderOverview(e);
}

async function hydrateDetail(entry) {
  if (metaCache[entry.id] !== undefined) return;
  try {
    const meta = await fetchFullMeta(entry);
    metaCache[entry.id] = meta;

    if (meta.malId && !entry.mal_id) {
      entry.mal_id = meta.malId;
      state.supabase.from("entries").update({ mal_id: meta.malId }).eq("id", entry.id).then(() => {});
    }
    if (String(state.detailId) === String(entry.id)) refreshDetail();

    if (meta.genres && meta.genres.length && !(entry.tags || []).length) {
      const tags = meta.genres.slice(0, 12);
      const { error } = await state.supabase.from("entries").update({ tags }).eq("id", entry.id);
      if (!error) {
        entry.tags = tags;
        renderTagChips();
        if (String(state.detailId) === String(entry.id)) refreshDetail();
      }
    }
  } catch {
    metaCache[entry.id] = false;
    if (String(state.detailId) === String(entry.id)) refreshDetail();
  }
}

async function bumpProgress(delta) {
  const e = currentEntry();
  if (!e) return;
  let next = (e.progress || 0) + delta;
  if (next < 0) next = 0;
  if (e.total_units && next > e.total_units) next = e.total_units;
  if (next === e.progress) return;

  const patch = { progress: next };
  if (e.total_units && next >= e.total_units && e.status !== "completed") patch.status = "completed";
  else if (next > 0 && e.status === "plan") patch.status = "watching";

  const { error } = await state.supabase.from("entries").update(patch).eq("id", e.id);
  if (error) { toast("Couldn't update: " + error.message); return; }
  Object.assign(e, patch);
  refreshDetail(); renderCounts(); renderGrid();
}

async function completeFromDetail() {
  const e = currentEntry();
  if (!e) return;
  const patch = { status: "completed", progress: e.total_units || e.progress || 0 };
  const { error } = await state.supabase.from("entries").update(patch).eq("id", e.id);
  if (error) { toast("Couldn't update: " + error.message); return; }
  Object.assign(e, patch);
  toast("Marked as completed.");
  refreshDetail(); renderCounts(); renderGrid();
}

// ---------------------------------------------------------------------------
// Edit tab
// ---------------------------------------------------------------------------
function fillEditTab(e) {
  $("edTitle").value = e.title || "";
  $("edStatus").value = e.status;
  $("edScore").value = e.score == null ? "" : e.score;
  $("edProgress").value = e.progress == null ? 0 : e.progress;
  $("edTotal").value = e.total_units == null ? "" : e.total_units;
  $("edTags").value = (e.tags || []).join(", ");
  $("edNotes").value = e.notes || "";
  $("edFolder").value = e.folder || "";
  $("folderOptions").innerHTML = allFolders().map((f) => `<option value="${escapeAttr(f.name)}"></option>`).join("");
}

async function saveEditTab() {
  const e = currentEntry();
  if (!e) return;
  const patch = {
    title: $("edTitle").value.trim() || e.title,
    status: $("edStatus").value,
    score: $("edScore").value === "" ? null : Number($("edScore").value),
    progress: $("edProgress").value === "" ? 0 : Number($("edProgress").value),
    total_units: $("edTotal").value === "" ? null : Number($("edTotal").value),
    notes: $("edNotes").value.trim() || null,
    folder: $("edFolder").value.trim() || null,
    tags: $("edTags").value.split(",").map((t) => t.trim()).filter(Boolean),
  };
  $("edSave").disabled = true;
  const { error } = await state.supabase.from("entries").update(patch).eq("id", e.id);
  $("edSave").disabled = false;
  if (error) { toast("Couldn't save: " + error.message); return; }
  Object.assign(e, patch);
  toast("Saved.");
  renderCounts(); renderFolders(); renderTagChips(); renderGrid();
  switchDetailTab("overview");
  renderDetailHeader(e);
}

async function deleteFromDetail() {
  const e = currentEntry();
  if (!e) return;
  if (!confirm(`Remove "${e.title}" from your shelf?`)) return;
  const { error } = await state.supabase.from("entries").delete().eq("id", e.id);
  if (error) { toast("Couldn't remove: " + error.message); return; }
  closeOverlay("detailOverlay");
  toast("Removed.");
  loadEntries();
}

async function refetchTagsInEdit() {
  const e = currentEntry();
  if (!e) return;
  const btn = $("edRefetchTags");
  btn.disabled = true; btn.textContent = "…";
  try {
    const meta = metaCache[e.id] || await fetchFullMeta(e);
    metaCache[e.id] = meta;
    const existing = $("edTags").value.split(",").map((t) => t.trim()).filter(Boolean);
    $("edTags").value = [...new Set([...existing, ...(meta.genres || [])])].join(", ");
    toast(`Tags refreshed from ${meta.sourceName}.`);
  } catch {
    toast("Couldn't reach the source for tags.");
  } finally {
    btn.disabled = false; btn.textContent = "⟳ from source";
  }
}

// ---------------------------------------------------------------------------
// Gallery tab
// ---------------------------------------------------------------------------
async function loadGallery(e) {
  const wrap = $("galleryGrid");
  if (galleryCache[e.id]) { paintGallery(e, galleryCache[e.id]); return; }
  wrap.innerHTML = '<p class="muted-line">Looking for artwork…</p>';

  const images = [];
  const banner = metaCache[e.id] && metaCache[e.id].banner;
  if (banner) images.push({ url: banner, label: "Banner art" });

  const malId = e.mal_id || (metaCache[e.id] && metaCache[e.id].malId);
  if (malId) {
    try {
      const pics = await jikan(`/${state.mediaType}/${malId}/pictures`);
      (pics.data || []).forEach((p) => {
        const url = p.jpg?.large_image_url || p.jpg?.image_url || p.webp?.large_image_url;
        if (url) images.push({ url, label: "MyAnimeList" });
      });
    } catch { /* keep whatever we have */ }
  }

  // per-volume covers — only MangaDex publishes these
  if (state.mediaType === "manga") {
    try {
      (await mangaDexCovers(e.title)).forEach((v) => images.push(v));
    } catch { /* keep whatever we have */ }
  }

  const seen = new Set();
  const deduped = images.filter((i) => (seen.has(i.url) ? false : seen.add(i.url)));
  galleryCache[e.id] = deduped;
  paintGallery(e, deduped);
}

function paintGallery(e, images) {
  const wrap = $("galleryGrid");
  if (!images.length) {
    wrap.innerHTML = '<p class="muted-line">No artwork found. If this came from a Mihon import, run "Fetch covers &amp; details" in Settings to link it to MyAnimeList first.</p>';
    return;
  }
  wrap.innerHTML = images.map((img, i) => `
    <figure class="gal-item">
      <img src="${escapeAttr(img.url)}" alt="" loading="lazy" onerror="this.closest('.gal-item').remove()" />
      <figcaption>${escapeHtml(img.label)}</figcaption>
      <div class="gal-actions">
        <button class="mini-btn" data-act="banner" data-i="${i}">Set banner</button>
        <button class="mini-btn" data-act="cover" data-i="${i}">Set cover</button>
      </div>
    </figure>`).join("");

  wrap.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const url = images[Number(btn.dataset.i)].url;
      const field = btn.dataset.act === "banner" ? "banner_url" : "image_url";
      const { error } = await state.supabase.from("entries").update({ [field]: url }).eq("id", e.id);
      if (error) { toast("Couldn't save: " + error.message); return; }
      e[field] = url;
      toast(btn.dataset.act === "banner" ? "Banner updated." : "Cover updated.");
      renderDetailHeader(e); renderGrid();
    });
  });
}

// ---------------------------------------------------------------------------
// Characters tab
// ---------------------------------------------------------------------------
async function loadCharacters(e) {
  const wrap = $("charGrid");
  if (charCache[e.id]) { paintCharacters(charCache[e.id]); return; }
  wrap.innerHTML = '<p class="muted-line">Loading cast…</p>';

  const malId = e.mal_id || (metaCache[e.id] && metaCache[e.id].malId);
  if (!malId) {
    wrap.innerHTML = '<p class="muted-line">No MyAnimeList match for this entry yet, so there is no cast to show. Try "Fetch covers &amp; details" in Settings.</p>';
    return;
  }
  try {
    const res = await jikan(`/${state.mediaType}/${malId}/characters`);
    const list = (res.data || []).map((c) => ({
      name: c.character?.name || "Unknown",
      image: c.character?.images?.jpg?.image_url || "",
      role: c.role || "",
      favorites: c.favorites || 0,
      va: (c.voice_actors || []).find((v) => v.language === "Japanese")?.person?.name || "",
      url: c.character?.url || "#",
    })).sort((a, b) => {
      if (a.role === b.role) return b.favorites - a.favorites;
      if (a.role === "Main") return -1;
      if (b.role === "Main") return 1;
      return 0;
    });
    charCache[e.id] = list;
    paintCharacters(list);
  } catch {
    wrap.innerHTML = '<p class="muted-line">Couldn\'t reach MyAnimeList for the cast. Try again in a moment.</p>';
  }
}

function paintCharacters(list) {
  const wrap = $("charGrid");
  if (!list.length) { wrap.innerHTML = '<p class="muted-line">No characters listed for this entry.</p>'; return; }
  wrap.innerHTML = list.map((c) => `
    <a class="char-card" href="${escapeAttr(c.url)}" target="_blank" rel="noopener">
      <div class="char-img">${coverImg(c.image, "cover-img")}</div>
      <div class="char-meta">
        <p class="char-name">${escapeHtml(c.name)}</p>
        <p class="char-role">${escapeHtml(c.role)}</p>
        ${c.va ? `<p class="char-va">${escapeHtml(c.va)}</p>` : ""}
      </div>
    </a>`).join("");
}

// ---------------------------------------------------------------------------
// Metadata layer
// ---------------------------------------------------------------------------

// Jikan allows roughly 3 requests a second. Everything funnels through one
// queue so a long enrich run can't rate-limit the rest of the app.
let jikanChain = Promise.resolve();
let lastJikanCall = 0;
function jikan(path) {
  const run = async () => {
    const wait = Math.max(0, 400 - (Date.now() - lastJikanCall));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastJikanCall = Date.now();
    let res = await fetch("https://api.jikan.moe/v4" + path);
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 2000));
      lastJikanCall = Date.now();
      res = await fetch("https://api.jikan.moe/v4" + path);
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  };
  jikanChain = jikanChain.then(run, run);
  return jikanChain;
}

async function anilistExtra(title, mediaType) {
  const gql = `query ($search: String, $type: MediaType) {
    Media(search: $search, type: $type) {
      bannerImage description(asHtml: false) genres averageScore popularity format
      episodes chapters volumes duration season seasonYear status source
      title { romaji english native }
      studios(isMain: true) { nodes { name } }
      trailer { id site }
      startDate { year }
    }
  }`;
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: gql, variables: { search: title, type: mediaType === "anime" ? "ANIME" : "MANGA" } }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const json = await res.json();
  if (!json.data || !json.data.Media) throw new Error("no anilist match");
  return json.data.Media;
}

async function fetchFullMeta(entry) {
  const type = state.mediaType;
  let raw = null;
  let malId = entry.mal_id || null;

  if (malId) {
    try { raw = (await jikan(`/${type}/${malId}/full`)).data; } catch { /* fall through */ }
  }
  if (!raw) {
    try {
      const s = await jikan(`/${type}?q=${encodeURIComponent(entry.title)}&limit=1&sfw`);
      raw = (s.data || [])[0] || null;
      if (raw && raw.mal_id) malId = raw.mal_id;
    } catch { /* fall through */ }
  }

  // AniList runs alongside purely for the wide banner art and trailer id
  let al = null;
  try { al = await anilistExtra(entry.title, type); } catch { /* optional */ }

  if (raw) {
    const genres = [...(raw.genres || []), ...(raw.themes || []), ...(raw.demographics || [])].map((g) => g.name).filter(Boolean);
    const people = type === "anime" ? (raw.studios || []).map((s) => s.name) : (raw.authors || []).map((a) => a.name);
    const relations = (raw.relations || []).flatMap((r) =>
      (r.entry || []).map((x) => ({ relation: r.relation, name: x.name, type: x.type, url: x.url }))).slice(0, 14);
    return {
      sourceName: "MyAnimeList",
      malId,
      banner: (al && al.bannerImage) || null,
      trailerId: (raw.trailer && raw.trailer.youtube_id) || (al && al.trailer && al.trailer.site === "YouTube" ? al.trailer.id : null),
      relations,
      synopsis: raw.synopsis || ((al && al.description) || "").replace(/<[^>]+>/g, "").trim(),
      genres: [...new Set(genres.length ? genres : ((al && al.genres) || []))],
      altTitle: raw.title_english || raw.title_japanese || "",
      type: raw.type || "",
      year: type === "anime" ? (raw.year || raw.aired?.prop?.from?.year || null) : (raw.published?.prop?.from?.year || null),
      airing: raw.status || "",
      communityScore: raw.score || null,
      rank: raw.rank || null,
      popularity: raw.popularity || null,
      episodes: type === "anime" ? raw.episodes : raw.chapters,
      volumes: type === "manga" ? raw.volumes : null,
      duration: raw.duration || null,
      season: raw.season ? `${raw.season[0].toUpperCase() + raw.season.slice(1)} ${raw.year || ""}`.trim() : null,
      studios: people.join(", ") || null,
      source: raw.source || null,
      rating: raw.rating || null,
    };
  }

  if (!al) throw new Error("no metadata");
  return {
    sourceName: "AniList",
    malId: null,
    banner: al.bannerImage || null,
    trailerId: al.trailer && al.trailer.site === "YouTube" ? al.trailer.id : null,
    relations: [],
    synopsis: (al.description || "").replace(/<[^>]+>/g, "").trim(),
    genres: al.genres || [],
    altTitle: (al.title && (al.title.english || al.title.native)) || "",
    type: al.format || "",
    year: al.seasonYear || (al.startDate && al.startDate.year) || null,
    airing: al.status || "",
    communityScore: al.averageScore ? (al.averageScore / 10).toFixed(1) : null,
    rank: null, popularity: null,
    episodes: type === "anime" ? al.episodes : al.chapters,
    volumes: type === "manga" ? al.volumes : null,
    duration: al.duration ? al.duration + " min" : null,
    season: al.season ? `${al.season[0] + al.season.slice(1).toLowerCase()} ${al.seasonYear || ""}`.trim() : null,
    studios: ((al.studios && al.studios.nodes) || []).map((s) => s.name).join(", ") || null,
    source: al.source || null, rating: null,
  };
}

async function mangaDexCovers(title) {
  const s = await fetch(`https://api.mangadex.org/manga?title=${encodeURIComponent(title)}&limit=1`);
  if (!s.ok) return [];
  const found = ((await s.json()).data || [])[0];
  if (!found) return [];
  const c = await fetch(`https://api.mangadex.org/cover?manga%5B%5D=${found.id}&limit=100&order%5Bvolume%5D=asc`);
  if (!c.ok) return [];
  return ((await c.json()).data || []).map((cv) => ({
    url: `https://uploads.mangadex.org/covers/${found.id}/${cv.attributes.fileName}.512.jpg`,
    label: cv.attributes.volume ? `Volume ${cv.attributes.volume}` : "Cover",
  }));
}

// ---------------------------------------------------------------------------
// Add flow
// ---------------------------------------------------------------------------
function openSearchModal() {
  $("searchInput").value = "";
  $("searchResults").innerHTML = "";
  openOverlay("searchOverlay");
  setTimeout(() => $("searchInput").focus(), 50);
}

function pickSearchResult(item) {
  if (!item) return;
  closeOverlay("searchOverlay");
  state.pendingResult = item;

  $("entryImg").src = item.image || "";
  $("entryTitle").textContent = item.title;
  $("entryMeta").textContent = [item.sourceName, item.type, item.year].filter(Boolean).join(" · ");
  $("entryStatus").value = "plan";
  $("entryScore").value = "";
  $("entryProgress").value = 0;
  $("entryTotal").value = item.units || "";
  $("entryTotal").disabled = !!item.units;
  $("entryTags").value = (item.tags || []).join(", ");
  $("entryFolder").value = "";
  $("entryNotes").value = "";
  $("folderOptionsAdd").innerHTML = allFolders().map((f) => `<option value="${escapeAttr(f.name)}"></option>`).join("");

  openOverlay("entryOverlay");
  if (item.tags && item.tags.length) toast(`Pulled ${item.tags.length} tags from ${item.sourceName}.`);
}

async function saveNewEntry() {
  const item = state.pendingResult;
  if (!item) return;
  $("saveEntryBtn").disabled = true;
  try {
    const { error } = await state.supabase.from("entries").insert({
      user_id: state.session.user.id,
      media_type: state.mediaType,
      mal_id: item.malId,
      title: item.title,
      image_url: item.image || null,
      status: $("entryStatus").value,
      score: $("entryScore").value === "" ? null : Number($("entryScore").value),
      progress: $("entryProgress").value === "" ? 0 : Number($("entryProgress").value),
      total_units: $("entryTotal").value === "" ? null : Number($("entryTotal").value),
      notes: $("entryNotes").value.trim() || null,
      folder: $("entryFolder").value.trim() || null,
      source_name: item.sourceName || null,
      tags: $("entryTags").value.split(",").map((t) => t.trim()).filter(Boolean),
    });
    if (error) throw error;
    toast("Added to your shelf.");
    closeOverlay("entryOverlay");
    loadEntries();
  } catch (err) {
    toast("Couldn't save: " + err.message);
  } finally {
    $("saveEntryBtn").disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Search sources
// ---------------------------------------------------------------------------
async function fetchJikanSearch(query, mediaType) {
  const endpoint = mediaType === "anime" ? "anime" : "manga";
  const json = await jikan(`/${endpoint}?q=${encodeURIComponent(query)}&limit=8&sfw`);
  return (json.data || []).map((it) => ({
    source: "jikan", sourceName: "MyAnimeList (Jikan)",
    extId: "jikan-" + it.mal_id, malId: it.mal_id == null ? null : it.mal_id,
    title: it.title, image: it.images?.jpg?.image_url || "",
    type: it.type || null,
    year: mediaType === "anime" ? (it.year || null) : (it.published?.prop?.from?.year || null),
    units: mediaType === "anime" ? (it.episodes || null) : (it.chapters || null),
    tags: [...new Set([...(it.genres || []), ...(it.themes || []), ...(it.demographics || [])].map((g) => g.name).filter(Boolean))],
  }));
}

async function fetchAniListSearch(query, mediaType) {
  const gql = `query ($search: String, $type: MediaType) {
    Page(perPage: 8) { media(search: $search, type: $type) {
      id title { romaji english } coverImage { large }
      format episodes chapters startDate { year } genres tags { name rank isGeneralSpoiler }
    } }
  }`;
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: gql, variables: { search: query, type: mediaType === "anime" ? "ANIME" : "MANGA" } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors && json.errors.length) throw new Error(json.errors[0].message || "AniList error");
  return ((json.data && json.data.Page && json.data.Page.media) || []).map((it) => {
    const topTags = (it.tags || []).filter((t) => !t.isGeneralSpoiler && t.rank >= 60)
      .sort((a, b) => b.rank - a.rank).slice(0, 6).map((t) => t.name);
    return {
      source: "anilist", sourceName: "AniList", extId: "anilist-" + it.id, malId: null,
      title: (it.title && (it.title.english || it.title.romaji)) || "Untitled",
      image: (it.coverImage && it.coverImage.large) || "", type: it.format || null,
      year: (it.startDate && it.startDate.year) || null,
      units: mediaType === "anime" ? (it.episodes || null) : (it.chapters || null),
      tags: [...new Set([...(it.genres || []), ...topTags])],
    };
  });
}

async function fetchKitsuSearch(query, mediaType) {
  const endpoint = mediaType === "anime" ? "anime" : "manga";
  const res = await fetch(`https://kitsu.io/api/edge/${endpoint}?filter[text]=${encodeURIComponent(query)}&page[limit]=8&include=categories`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const catById = {};
  (json.included || []).forEach((inc) => { if (inc.type === "categories") catById[inc.id] = inc.attributes && inc.attributes.title; });
  return (json.data || []).map((it) => {
    const a = it.attributes || {};
    return {
      source: "kitsu", sourceName: "Kitsu", extId: "kitsu-" + it.id, malId: null,
      title: a.canonicalTitle || (a.titles && (a.titles.en || a.titles.en_jp)) || "Untitled",
      image: (a.posterImage && (a.posterImage.small || a.posterImage.medium)) || "",
      type: a.subtype || null,
      year: a.startDate ? Number(String(a.startDate).slice(0, 4)) : null,
      units: mediaType === "anime" ? (a.episodeCount || null) : (a.chapterCount || null),
      tags: ((it.relationships && it.relationships.categories && it.relationships.categories.data) || [])
        .map((c) => catById[c.id]).filter(Boolean).slice(0, 10),
    };
  });
}

async function fetchMangaDexSearch(query) {
  const res = await fetch(`https://api.mangadex.org/manga?title=${encodeURIComponent(query)}&limit=8&includes%5B%5D=cover_art`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (json.data || []).map((it) => {
    const attrs = it.attributes || {};
    const titles = attrs.title || {};
    const title = titles.en || Object.values(titles)[0] || "Untitled";
    const coverRel = (it.relationships || []).find((r) => r.type === "cover_art");
    return {
      source: "mangadex", sourceName: "MangaDex", extId: "mangadex-" + it.id, malId: null, title,
      image: coverRel && coverRel.attributes && coverRel.attributes.fileName
        ? `https://uploads.mangadex.org/covers/${it.id}/${coverRel.attributes.fileName}.256.jpg` : "",
      type: "Manga", year: attrs.year || null,
      units: attrs.lastChapter ? Number(attrs.lastChapter) || null : null,
      tags: (attrs.tags || []).map((t) => t.attributes && t.attributes.name && t.attributes.name.en).filter(Boolean).slice(0, 10),
    };
  });
}

const SEARCH_SOURCES = {
  anime: [fetchJikanSearch, fetchAniListSearch, fetchKitsuSearch],
  manga: [fetchJikanSearch, fetchAniListSearch, fetchKitsuSearch, fetchMangaDexSearch],
};

let searchResultIndex = {};

async function runSearch(query) {
  $("searchResults").innerHTML = '<p class="muted-line" style="padding:8px;">Searching…</p>';
  const fetchers = SEARCH_SOURCES[state.mediaType];
  const settled = await Promise.allSettled(fetchers.map((fn) => fn(query, state.mediaType)));
  const sections = settled.map((o) => (o.status === "fulfilled" ? o.value : [])).filter((i) => i.length > 0);
  renderSearchSections(sections, settled.filter((o) => o.status === "rejected").length, settled.length);
}

function renderSearchSections(sections, failedCount, totalCount) {
  const resultsEl = $("searchResults");
  searchResultIndex = {};
  if (sections.length === 0) {
    resultsEl.innerHTML = failedCount === totalCount
      ? '<p style="color:var(--red);font-size:13px;padding:8px;">All sources failed to respond. Try again in a moment.</p>'
      : '<p class="muted-line" style="padding:8px;">No results.</p>';
    return;
  }
  resultsEl.innerHTML = sections.map((items) => {
    const rows = items.map((it) => {
      searchResultIndex[it.extId] = it;
      const meta = [it.type, it.units ? it.units + (state.mediaType === "anime" ? " eps" : " ch") : null, it.year].filter(Boolean).join(" · ");
      const tagLine = (it.tags || []).slice(0, 4).join(" · ");
      return `<div class="result-row" data-ext-id="${escapeAttr(it.extId)}">
        <div class="result-thumb">${coverImg(it.image, "cover-img")}</div>
        <div><p class="r-title">${escapeHtml(it.title)}</p><p class="r-meta">${escapeHtml(meta)}</p>
        ${tagLine ? `<p class="r-tags">${escapeHtml(tagLine)}</p>` : ""}</div>
      </div>`;
    }).join("");
    return `<div class="result-section"><p class="result-section-title">${escapeHtml(items[0].sourceName)}</p>${rows}</div>`;
  }).join("") + (failedCount > 0 ? `<p class="result-source-note">${failedCount} of ${totalCount} sources didn't respond.</p>` : "");

  resultsEl.querySelectorAll(".result-row").forEach((row) => {
    row.addEventListener("click", () => pickSearchResult(searchResultIndex[row.dataset.extId]));
  });
}

// ---------------------------------------------------------------------------
// Mihon / Tachiyomi import
// ---------------------------------------------------------------------------
let mihonParsed = null;

async function handleMihonFile(ev) {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;

  closeOverlay("settingsOverlay");
  $("mihonSummary").innerHTML = '<p class="muted-line">Reading backup…</p>';
  $("mihonPreview").innerHTML = "";
  $("mihonConfirm").disabled = true;
  $("mihonConfirm").textContent = "Import";
  openOverlay("mihonOverlay");

  try {
    mihonParsed = await window.OmoideMihon.parseMihonBackup(file);
  } catch (err) {
    $("mihonSummary").innerHTML = `<p style="color:var(--red);font-size:13px;line-height:1.6;">${escapeHtml(err.message)}</p>`;
    return;
  }

  const { series, categories } = mihonParsed;
  const existing = new Set(state.entries.filter((e) => e.media_type === "manga").map((e) => e.title.toLowerCase().trim()));
  const fresh = series.filter((s) => !existing.has(s.title.toLowerCase().trim()));
  mihonParsed.fresh = fresh;

  const labels = STATUS_LABELS.manga;
  const byStatus = {};
  fresh.forEach((s) => {
    const st = window.OmoideMihon.mihonStatus(s);
    byStatus[st] = (byStatus[st] || 0) + 1;
  });

  $("mihonSummary").innerHTML = `
    <div class="mihon-stats">
      <div class="stat"><span class="stat-k">In backup</span><b class="stat-v">${series.length}</b></div>
      <div class="stat"><span class="stat-k">New to you</span><b class="stat-v">${fresh.length}</b></div>
      <div class="stat"><span class="stat-k">Already here</span><b class="stat-v">${series.length - fresh.length}</b></div>
      <div class="stat"><span class="stat-k">Folders</span><b class="stat-v">${categories.length}</b></div>
    </div>
    <p class="muted-line" style="margin-top:12px;line-height:1.6;">
      Mapped to ${Object.keys(byStatus).map((k) => `${byStatus[k]} ${labels[k].toLowerCase()}`).join(", ") || "nothing"}.
      Reading position is the highest chapter number you'd marked read, so duplicate scanlator releases of the same chapter don't inflate it.
      Mihon categories become folders.</p>`;

  $("mihonPreview").innerHTML = fresh.length
    ? `<p class="mihon-preview-title">First 12 — check these look right before importing</p>` +
      fresh.slice(0, 12).map((s) => `
        <div class="mihon-row">
          <span class="m-title">${escapeHtml(s.title)}</span>
          <span class="m-status">${labels[window.OmoideMihon.mihonStatus(s)]}</span>
          <span class="m-prog">ch. ${s.progress}${s.highestChapter ? " / " + s.highestChapter : ""}</span>
          <span class="m-folder">${escapeHtml(s.folder || "—")}</span>
        </div>`).join("")
    : '<p class="muted-line">Everything in this backup is already on your shelf.</p>';

  $("mihonConfirm").disabled = fresh.length === 0;
  if (fresh.length) $("mihonConfirm").textContent = `Import ${fresh.length} series`;
}

async function runMihonImport() {
  if (!mihonParsed || !mihonParsed.fresh || !mihonParsed.fresh.length) return;
  const rows = mihonParsed.fresh.map((s) => ({
    user_id: state.session.user.id,
    media_type: "manga",
    mal_id: s.malId || null,
    title: s.title,
    image_url: s.thumbnailUrl || null,
    status: window.OmoideMihon.mihonStatus(s),
    score: s.trackScore && s.trackScore > 0 ? Math.round(Math.min(10, s.trackScore)) : null,
    progress: s.progress || 0,
    total_units: s.highestChapter || null,
    notes: null,
    folder: s.folder || null,
    source_name: "Mihon",
    tags: (s.genres || []).slice(0, 12),
  }));

  $("mihonConfirm").disabled = true;
  let done = 0;
  try {
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { error } = await state.supabase.from("entries").insert(chunk);
      if (error) throw error;
      done += chunk.length;
      $("mihonConfirm").textContent = `Importing… ${done}/${rows.length}`;
    }
  } catch (err) {
    toast("Import stopped after " + done + ": " + err.message);
    $("mihonConfirm").disabled = false;
    $("mihonConfirm").textContent = "Retry import";
    return;
  }

  closeOverlay("mihonOverlay");
  toast(`Imported ${done} series. Run "Fetch covers & details" in Settings to pull artwork.`, true);
  setTimeout(hideToast, 7000);

  if (state.mediaType !== "manga") {
    state.mediaType = "manga";
    $("typeSwitch").dataset.active = "manga";
    document.querySelectorAll("#typeSwitch button[data-type]").forEach((b) => b.classList.toggle("active", b.dataset.type === "manga"));
    applyAccent();
  }
  loadEntries();
}

// ---------------------------------------------------------------------------
// Background enrichment
// ---------------------------------------------------------------------------
async function enrichLibrary() {
  const targets = state.entries.filter((e) => !e.mal_id || !e.image_url || e.source_name === "Mihon");
  if (!targets.length) { toast("Everything already has artwork and a MyAnimeList link."); return; }
  const secs = Math.ceil(targets.length * 0.45);
  if (!confirm(`Look up ${targets.length} entries on MyAnimeList? That takes roughly ${secs < 60 ? secs + " seconds" : Math.ceil(secs / 60) + " minutes"}. You can keep using the app while it runs.`)) return;

  closeOverlay("settingsOverlay");
  let done = 0, fixed = 0;

  for (const e of targets) {
    done++;
    toast(`Fetching details… ${done}/${targets.length} — ${fixed} updated`, true);
    try {
      const res = await jikan(`/${e.media_type}?q=${encodeURIComponent(e.title)}&limit=1&sfw`);
      const hit = (res.data || [])[0];
      if (!hit) continue;

      const patch = {};
      if (!e.mal_id && hit.mal_id) patch.mal_id = hit.mal_id;
      const img = hit.images?.jpg?.large_image_url || hit.images?.jpg?.image_url;
      if (img && (!e.image_url || e.source_name === "Mihon")) patch.image_url = img;
      if (!(e.tags || []).length) {
        const g = [...(hit.genres || []), ...(hit.themes || []), ...(hit.demographics || [])].map((x) => x.name).filter(Boolean);
        if (g.length) patch.tags = [...new Set(g)].slice(0, 12);
      }
      if (!e.total_units) {
        const units = e.media_type === "anime" ? hit.episodes : hit.chapters;
        if (units) patch.total_units = units;
      }
      if (e.source_name === "Mihon") patch.source_name = "Mihon+MAL";
      if (!Object.keys(patch).length) continue;

      const { error } = await state.supabase.from("entries").update(patch).eq("id", e.id);
      if (!error) { Object.assign(e, patch); fixed++; }
    } catch { /* skip and keep going */ }
  }

  hideToast();
  toast(`Done — updated ${fixed} of ${done}.`);
  renderTagChips(); renderGrid();
}

// ---------------------------------------------------------------------------
// JSON backup
// ---------------------------------------------------------------------------
async function exportLibrary() {
  const { data, error } = await state.supabase.from("entries").select("*").order("updated_at", { ascending: false });
  if (error) { toast("Export failed: " + error.message); return; }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `omoidebako-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Backup downloaded.");
}

async function importLibrary(ev) {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  try {
    const rows = JSON.parse(await file.text());
    if (!Array.isArray(rows)) throw new Error("That doesn't look like an Omoidebako backup file.");
    const cleaned = rows.map((r) => ({
      user_id: state.session.user.id,
      media_type: r.media_type, mal_id: r.mal_id == null ? null : r.mal_id, title: r.title,
      image_url: r.image_url == null ? null : r.image_url,
      banner_url: r.banner_url == null ? null : r.banner_url,
      status: r.status || "plan", score: r.score == null ? null : r.score,
      progress: r.progress == null ? 0 : r.progress,
      total_units: r.total_units == null ? null : r.total_units,
      notes: r.notes == null ? null : r.notes,
      folder: r.folder == null ? null : r.folder,
      source_name: r.source_name == null ? null : r.source_name,
      tags: Array.isArray(r.tags) ? r.tags : [],
    }));
    const { error } = await state.supabase.from("entries").insert(cleaned);
    if (error) throw error;
    toast(`Imported ${cleaned.length} entries.`);
    loadEntries();
  } catch (err) {
    toast("Import failed: " + err.message);
  }
}

boot();
