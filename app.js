// ---------------------------------------------------------------------------
// Omoidebako — personal anime & manga log
// Data lives in Supabase. Metadata comes from Jikan (MyAnimeList), AniList,
// Kitsu and MangaDex.
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

const state = {
  supabase: null,
  session: null,
  authMode: "signin",
  entries: [],
  mediaType: "anime",
  statusFilter: "all",
  editingId: null,
  pendingResult: null,
  detailId: null,

  theme: { anime: "cyan", manga: "magenta" },
  enabledTrackers: new Set(ALL_TRACKERS),
  view: "grid",
  sort: "recent",
  librarySearch: "",
  activeTags: new Set(),
};

// full metadata fetched on demand for the detail panel, keyed by entry id
const metaCache = {};

const $ = (id) => document.getElementById(id);

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("visible");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("visible"), 2200);
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------
function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const prefs = JSON.parse(raw);
    if (prefs.theme) state.theme = { ...state.theme, ...prefs.theme };
    if (Array.isArray(prefs.enabledTrackers)) state.enabledTrackers = new Set(prefs.enabledTrackers);
    if (prefs.view === "grid" || prefs.view === "list") state.view = prefs.view;
  } catch {
    /* ignore malformed prefs */
  }
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

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  wireAuthUI();
  wireAppUI();
  applyAccent();
  renderSwatches();
  applyTrackerVisibility();

  const { data } = await state.supabase.auth.getSession();
  state.session = data.session;
  state.supabase.auth.onAuthStateChange((_event, session) => {
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
    if (!email || !password) {
      $("authError").textContent = "Enter an email and password.";
      return;
    }
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

  $("authPassword").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("authSubmit").click();
  });
}

// ---------------------------------------------------------------------------
// App UI wiring
// ---------------------------------------------------------------------------
function wireAppUI() {
  document.querySelectorAll("#typeSwitch button[data-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.type === state.mediaType) return;
      state.mediaType = btn.dataset.type;
      state.statusFilter = "all";
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

  // status filter
  $("statusList").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-status]");
    if (!btn) return;
    document.querySelectorAll("#statusList button[data-status]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.statusFilter = btn.dataset.status;
    renderGrid();
  });

  // tracker show/hide eyes — these genuinely remove the entries from the shelf
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
      renderCounts();
      renderTagChips();
      renderGrid();
    });
  });

  // add modal
  $("openAddModal").addEventListener("click", () => openSearchModal());
  $("closeSearch").addEventListener("click", () => closeOverlay("searchOverlay"));
  $("searchOverlay").addEventListener("click", (e) => {
    if (e.target.id === "searchOverlay") closeOverlay("searchOverlay");
  });

  let debounceTimer;
  $("searchInput").addEventListener("input", () => {
    clearTimeout(debounceTimer);
    const q = $("searchInput").value.trim();
    if (q.length < 2) {
      $("searchResults").innerHTML = "";
      return;
    }
    debounceTimer = setTimeout(() => runSearch(q), 350);
  });

  // entry modal
  $("closeEntry").addEventListener("click", closeEntryModal);
  $("entryOverlay").addEventListener("click", (e) => {
    if (e.target.id === "entryOverlay") closeEntryModal();
  });
  $("saveEntryBtn").addEventListener("click", saveEntry);
  $("deleteEntryBtn").addEventListener("click", deleteEntry);
  $("refetchTagsBtn").addEventListener("click", refetchTagsIntoForm);

  // settings
  $("openSettings").addEventListener("click", () => openOverlay("settingsOverlay"));
  $("closeSettings").addEventListener("click", () => closeOverlay("settingsOverlay"));
  $("settingsOverlay").addEventListener("click", (e) => {
    if (e.target.id === "settingsOverlay") closeOverlay("settingsOverlay");
  });
  $("signOutBtn").addEventListener("click", async () => {
    await state.supabase.auth.signOut();
  });
  $("exportBtn").addEventListener("click", exportLibrary);
  $("importBtn").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", importLibrary);

  // detail overlay
  $("closeDetail").addEventListener("click", () => closeOverlay("detailOverlay"));
  $("detailOverlay").addEventListener("click", (e) => {
    if (e.target.id === "detailOverlay") closeOverlay("detailOverlay");
  });
  $("detailEditBtn").addEventListener("click", () => {
    closeOverlay("detailOverlay");
    if (state.detailId) openEntryModal(state.detailId);
  });
  $("detailDeleteBtn").addEventListener("click", async () => {
    if (!state.detailId) return;
    if (!confirm("Remove this from your shelf?")) return;
    const { error } = await state.supabase.from("entries").delete().eq("id", state.detailId);
    if (error) { toast("Couldn't remove: " + error.message); return; }
    closeOverlay("detailOverlay");
    toast("Removed.");
    loadEntries();
  });
  $("progMinus").addEventListener("click", () => bumpProgress(-1));
  $("progPlus").addEventListener("click", () => bumpProgress(1));
  $("progComplete").addEventListener("click", completeFromDetail);

  // esc closes whatever is open
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    ["detailOverlay", "entryOverlay", "searchOverlay", "settingsOverlay"].forEach((id) => {
      if ($(id).classList.contains("visible")) closeOverlay(id);
    });
  });

  // library search / sort / filter panel
  $("librarySearch").addEventListener("input", (e) => {
    state.librarySearch = e.target.value;
    renderGrid();
  });
  $("sortSelect").addEventListener("change", (e) => {
    state.sort = e.target.value;
    renderGrid();
  });
  $("filterToggle").addEventListener("click", () => {
    $("filterPanel").classList.toggle("open");
  });

  // grid / list view
  $("viewGrid").addEventListener("click", () => {
    state.view = "grid";
    $("viewGrid").classList.add("active");
    $("viewList").classList.remove("active");
    savePrefs();
    renderGrid();
  });
  $("viewList").addEventListener("click", () => {
    state.view = "list";
    $("viewList").classList.add("active");
    $("viewGrid").classList.remove("active");
    savePrefs();
    renderGrid();
  });

  applyStatusLabels();
}

function openOverlay(id) {
  $(id).classList.add("visible");
}
function closeOverlay(id) {
  const el = $(id);
  el.classList.add("closing");
  setTimeout(() => {
    el.classList.remove("visible", "closing");
    if (id === "detailOverlay") state.detailId = null;
  }, 140);
}

function applyTrackerVisibility() {
  document.querySelectorAll("#statusList li[data-tracker]").forEach((li) => {
    const status = li.dataset.tracker;
    if (status === "all") return;
    const hidden = !state.enabledTrackers.has(status);
    li.classList.toggle("tracker-hidden", hidden);
    const eye = li.querySelector(".tracker-eye");
    if (eye) {
      eye.title = hidden ? "Show this tracker" : "Hide this tracker";
      eye.textContent = hidden ? "🚫" : "👁";
    }
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
      savePrefs();
      renderSwatches();
      if (target === state.mediaType) {
        applyAccent();
        renderGrid();
      }
    });
  });
}

function applyStatusLabels() {
  const labels = STATUS_LABELS[state.mediaType];
  document.querySelectorAll("#statusList li[data-tracker]").forEach((li) => {
    const status = li.dataset.tracker;
    if (status === "all") return;
    const labelSpan = li.querySelector(".label");
    if (labelSpan) labelSpan.textContent = labels[status];
  });
  const sel = $("entryStatus");
  [...sel.options].forEach((opt) => {
    if (labels[opt.value]) opt.textContent = labels[opt.value];
  });
  $("mainTitle").textContent =
    (state.statusFilter === "all" ? "All " : labels[state.statusFilter] + " ") + MEDIA_LABEL[state.mediaType];
}

// ---------------------------------------------------------------------------
// Data: load / render
// ---------------------------------------------------------------------------
async function loadEntries() {
  const { data, error } = await state.supabase
    .from("entries")
    .select("*")
    .eq("media_type", state.mediaType)
    .order("updated_at", { ascending: false });

  if (error) {
    toast("Couldn't load your library: " + error.message);
    return;
  }
  state.entries = (data || []).map((e) => ({ ...e, tags: e.tags || [] }));
  renderCounts();
  renderTagChips();
  renderGrid();
}

// entries belonging to trackers that are currently switched on
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

function renderTagChips() {
  const freq = {};
  visibleEntries().forEach((e) => (e.tags || []).forEach((t) => { freq[t] = (freq[t] || 0) + 1; }));
  const sorted = Object.keys(freq).sort((a, b) => freq[b] - freq[a] || a.localeCompare(b));
  // drop any active tag that no longer exists in the visible set
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
      state.activeTags.has(t) ? state.activeTags.delete(t) : state.activeTags.add(t);
      renderTagChips();
      renderGrid();
    });
  });
}

function currentList() {
  // hidden trackers are hidden everywhere, not just dimmed in the sidebar
  let list = state.statusFilter === "all"
    ? visibleEntries()
    : state.entries.filter((e) => e.status === state.statusFilter && state.enabledTrackers.has(e.status));

  if (state.librarySearch.trim()) {
    const q = state.librarySearch.trim().toLowerCase();
    list = list.filter((e) => e.title.toLowerCase().includes(q) || (e.tags || []).some((t) => t.toLowerCase().includes(q)));
  }
  if (state.activeTags.size) {
    list = list.filter((e) => (e.tags || []).some((t) => state.activeTags.has(t)));
  }
  if (state.sort !== "recent") {
    list = [...list].sort((a, b) => {
      if (state.sort === "score") return (b.score || 0) - (a.score || 0);
      if (state.sort === "progress") return (b.progress || 0) - (a.progress || 0);
      return a.title.localeCompare(b.title);
    });
  }
  return list;
}

function coverStyle(e) {
  if (e.image_url) return `background-image:url('${escapeAttr(e.image_url)}')`;
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

function renderGrid() {
  applyStatusLabels();
  const list = currentList();
  $("mainCount").textContent = list.length;

  const wrap = $("gridWrap");
  if (list.length === 0) {
    const allHidden = state.enabledTrackers.size === 0;
    wrap.innerHTML = allHidden
      ? '<div class="empty-state"><h3>Every tracker is hidden</h3><p>Click the eye next to a status in the sidebar to bring it back.</p></div>'
      : '<div class="empty-state"><h3>Nothing here yet</h3><p>Use "+ Add" to search titles and start your shelf.</p></div>';
    return;
  }

  const labels = STATUS_LABELS[state.mediaType];
  wrap.innerHTML = `<div class="grid ${state.view === "list" ? "list-mode" : ""}" id="grid">` +
    list.map((e, i) => {
      const color = STATUS_COLOR[e.status];
      const pct = e.total_units ? Math.min(100, Math.round((e.progress / e.total_units) * 100)) : 0;
      const metaLine = e.total_units ? `${e.progress || 0}/${e.total_units}` : (e.progress ? `${e.progress}` : "not started");
      const scoreLine = e.score ? `score ${e.score}` : "—";
      return `
        <div class="card holo" style="--glow:${color}; --i:${Math.min(i, 24)}" data-id="${e.id}">
          <div class="card-cover" style="${coverStyle(e)}">
            <div class="scan"></div>
            <div class="card-badge" style="--glow:${color}">${labels[e.status]}</div>
            ${e.score ? `<span class="card-score">★ ${e.score}</span>` : ""}
            <div class="card-reveal"><span>${metaLine}</span><span>${scoreLine}</span></div>
          </div>
          <div class="card-body">
            <p class="card-title">${escapeHtml(e.title)}</p>
            <div class="card-meta"><span>${metaLine}</span><span>${labels[e.status]}</span></div>
            <div class="list-meta"><span>${metaLine}</span><span>${scoreLine}</span></div>
            ${e.total_units ? `<div class="card-progress-bar" style="--glow:${color}"><div style="width:${pct}%"></div></div>` : ""}
          </div>
        </div>`;
    }).join("") +
    "</div>";

  wrap.querySelectorAll(".card").forEach((card) => {
    card.addEventListener("click", () => {
      card.classList.remove("pressed");
      void card.offsetWidth;          // restart the animation if clicked twice
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

// ---------------------------------------------------------------------------
// Detail panel — the big information view
// ---------------------------------------------------------------------------
function openDetail(id) {
  const e = state.entries.find((x) => String(x.id) === String(id));
  if (!e) return;
  state.detailId = e.id;
  renderDetail(e);
  openOverlay("detailOverlay");

  // pull the rich metadata in the background
  hydrateDetail(e);
}

function renderDetail(e) {
  const color = STATUS_COLOR[e.status];
  const labels = STATUS_LABELS[state.mediaType];
  const meta = metaCache[e.id] || null;

  $("detailPanel").style.setProperty("--glow", color);
  $("detailHeroBg").setAttribute("style", e.image_url ? `background-image:url('${escapeAttr(e.image_url)}')` : "");
  $("detailCover").setAttribute("style", `--glow:${color}; ${coverStyle(e)}`);
  $("detailKicker").textContent = MEDIA_LABEL[state.mediaType].toUpperCase();
  $("detailTitle").textContent = e.title;
  $("detailAlt").textContent = meta?.altTitle && meta.altTitle !== e.title ? meta.altTitle : "";

  // chips under the title
  const chips = [
    `<span class="chip chip-status" style="--glow:${color}">${labels[e.status]}</span>`,
    meta?.type ? `<span class="chip">${escapeHtml(meta.type)}</span>` : "",
    meta?.year ? `<span class="chip">${meta.year}</span>` : "",
    meta?.airing ? `<span class="chip">${escapeHtml(meta.airing)}</span>` : "",
    e.score ? `<span class="chip chip-score">★ ${e.score}/10</span>` : "",
  ].filter(Boolean).join("");
  $("detailChips").innerHTML = chips;

  // progress block
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

  // stats
  const stats = [
    ["Your score", e.score ? e.score + " / 10" : "—"],
    ["Status", labels[e.status]],
    ["Progress", total ? `${prog} / ${total}` : String(prog)],
    ["Added", e.created_at ? new Date(e.created_at).toLocaleDateString() : "—"],
    ["Updated", e.updated_at ? new Date(e.updated_at).toLocaleDateString() : "—"],
  ];
  $("detailStatGrid").innerHTML = stats.map(([k, v]) =>
    `<div class="stat"><span class="stat-k">${k}</span><b class="stat-v">${escapeHtml(String(v))}</b></div>`
  ).join("");

  // source facts
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
    : `<p class="muted-line" id="factsPending">${meta === null ? "Loading details…" : "No extra details found."}</p>`;

  // synopsis
  const syn = meta?.synopsis;
  $("detailSynopsis").textContent = syn || (meta === null ? "Loading…" : "No synopsis available from the source.");
  $("detailSynopsis").classList.toggle("muted-line", !syn);

  // notes
  $("detailNotes").textContent = e.notes || "Nothing written down yet.";
  $("detailNotes").classList.toggle("muted-line", !e.notes);

  // tags
  $("detailTags").innerHTML = (e.tags || []).length
    ? e.tags.map((t) => `<span class="dtag">${escapeHtml(t)}</span>`).join("")
    : '<span class="muted-line">No tags yet.</span>';

  // links
  const q = encodeURIComponent(e.title);
  const malLink = e.mal_id
    ? `https://myanimelist.net/${state.mediaType}/${e.mal_id}`
    : `https://myanimelist.net/search/all?q=${q}`;
  let links = `<a href="${malLink}" target="_blank" rel="noopener">MyAnimeList ↗</a>`;
  links += `<a href="https://anilist.co/search/${state.mediaType}?search=${q}" target="_blank" rel="noopener">AniList ↗</a>`;
  if (state.mediaType === "manga") {
    links += `<a href="https://mangadex.org/search?q=${q}" target="_blank" rel="noopener">MangaDex ↗</a>`;
  }
  $("detailLinks").innerHTML = links;
}

async function hydrateDetail(entry) {
  if (metaCache[entry.id]) return;
  try {
    const meta = await fetchFullMeta(entry);
    metaCache[entry.id] = meta;
    if (String(state.detailId) === String(entry.id)) renderDetail(entry);

    // "tags should be grabbed automatically" — if this entry has none, fill
    // them in from the source the first time it's opened.
    if (meta && meta.genres?.length && !(entry.tags || []).length) {
      const tags = meta.genres.slice(0, 12);
      const { error } = await state.supabase.from("entries").update({ tags }).eq("id", entry.id);
      if (!error) {
        entry.tags = tags;
        toast("Tags pulled from " + meta.sourceName + ".");
        renderTagChips();
        if (String(state.detailId) === String(entry.id)) renderDetail(entry);
      }
    }
  } catch {
    metaCache[entry.id] = false;
    if (String(state.detailId) === String(entry.id)) renderDetail(entry);
  }
}

async function bumpProgress(delta) {
  const e = state.entries.find((x) => String(x.id) === String(state.detailId));
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
  renderDetail(e);
  renderCounts();
  renderGrid();
}

async function completeFromDetail() {
  const e = state.entries.find((x) => String(x.id) === String(state.detailId));
  if (!e) return;
  const patch = { status: "completed", progress: e.total_units || e.progress || 0 };
  const { error } = await state.supabase.from("entries").update(patch).eq("id", e.id);
  if (error) { toast("Couldn't update: " + error.message); return; }
  Object.assign(e, patch);
  toast("Marked as completed.");
  renderDetail(e);
  renderCounts();
  renderGrid();
}

// ---------------------------------------------------------------------------
// Full metadata lookup (Jikan first, AniList as a fallback)
// ---------------------------------------------------------------------------
async function fetchFullMeta(entry) {
  const type = state.mediaType;
  let raw = null;

  if (entry.mal_id) {
    const res = await fetch(`https://api.jikan.moe/v4/${type}/${entry.mal_id}/full`);
    if (res.ok) raw = (await res.json()).data;
  }
  if (!raw) {
    const res = await fetch(`https://api.jikan.moe/v4/${type}?q=${encodeURIComponent(entry.title)}&limit=1&sfw`);
    if (res.ok) raw = ((await res.json()).data || [])[0] || null;
  }

  if (raw) {
    const genres = [
      ...(raw.genres || []), ...(raw.themes || []), ...(raw.demographics || []),
    ].map((g) => g.name).filter(Boolean);
    const people = type === "anime"
      ? (raw.studios || []).map((s) => s.name)
      : (raw.authors || []).map((a) => a.name);
    return {
      sourceName: "MyAnimeList",
      synopsis: raw.synopsis || "",
      genres: [...new Set(genres)],
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

  // AniList fallback
  const gql = `query ($search: String, $type: MediaType) {
    Media(search: $search, type: $type) {
      description(asHtml: false) genres averageScore popularity format
      episodes chapters volumes duration season seasonYear status
      title { romaji english native }
      studios(isMain: true) { nodes { name } }
      source startDate { year }
    }
  }`;
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: gql, variables: { search: entry.title, type: type === "anime" ? "ANIME" : "MANGA" } }),
  });
  const json = await res.json();
  const m = json.data?.Media;
  if (!m) throw new Error("no metadata");
  return {
    sourceName: "AniList",
    synopsis: (m.description || "").replace(/<[^>]+>/g, "").trim(),
    genres: m.genres || [],
    altTitle: m.title?.english || m.title?.native || "",
    type: m.format || "",
    year: m.seasonYear || m.startDate?.year || null,
    airing: m.status || "",
    communityScore: m.averageScore ? (m.averageScore / 10).toFixed(1) : null,
    rank: null,
    popularity: null,
    episodes: type === "anime" ? m.episodes : m.chapters,
    volumes: type === "manga" ? m.volumes : null,
    duration: m.duration ? m.duration + " min" : null,
    season: m.season ? `${m.season[0] + m.season.slice(1).toLowerCase()} ${m.seasonYear || ""}`.trim() : null,
    studios: (m.studios?.nodes || []).map((s) => s.name).join(", ") || null,
    source: m.source || null,
    rating: null,
  };
}

// ---------------------------------------------------------------------------
// Search modal
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
  state.editingId = null;
  state.pendingResult = item;

  $("entryModalTitle").textContent = "Add to your shelf";
  $("entryImg").src = item.image || "";
  $("entryTitle").textContent = item.title;
  $("entryMeta").textContent = [item.sourceName, item.type, item.year].filter(Boolean).join(" · ");
  $("entryStatus").value = "plan";
  $("entryScore").value = "";
  $("entryProgress").value = 0;
  $("entryTotal").value = item.units || "";
  $("entryTotal").disabled = !!item.units;
  // tags come straight from whichever source the result came from
  $("entryTags").value = (item.tags || []).join(", ");
  $("entryNotes").value = "";
  $("deleteEntryBtn").style.display = "none";

  openOverlay("entryOverlay");
  if (item.tags?.length) toast(`Pulled ${item.tags.length} tags from ${item.sourceName}.`);
}

// ---------------------------------------------------------------------------
// Entry modal
// ---------------------------------------------------------------------------
function openEntryModal(id) {
  const entry = state.entries.find((e) => String(e.id) === String(id));
  if (!entry) return;
  state.editingId = id;
  state.pendingResult = null;

  $("entryModalTitle").textContent = "Edit entry";
  $("entryImg").src = entry.image_url || "";
  $("entryTitle").textContent = entry.title;
  $("entryMeta").textContent = entry.mal_id ? "MAL #" + entry.mal_id : "";
  $("entryStatus").value = entry.status;
  $("entryScore").value = entry.score ?? "";
  $("entryProgress").value = entry.progress ?? 0;
  $("entryTotal").value = entry.total_units ?? "";
  $("entryTotal").disabled = entry.total_units != null;
  $("entryTags").value = (entry.tags || []).join(", ");
  $("entryNotes").value = entry.notes || "";
  $("deleteEntryBtn").style.display = "inline-flex";

  openOverlay("entryOverlay");
}

function closeEntryModal() {
  closeOverlay("entryOverlay");
  state.editingId = null;
  state.pendingResult = null;
}

// pull genres/themes from the source into the tag field, keeping anything
// the user typed themselves
async function refetchTagsIntoForm() {
  const btn = $("refetchTagsBtn");
  const title = $("entryTitle").textContent;
  if (!title) return;
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const stub = state.editingId
      ? state.entries.find((e) => String(e.id) === String(state.editingId))
      : { title, mal_id: state.pendingResult?.malId || null };
    const meta = await fetchFullMeta(stub || { title, mal_id: null });
    const existing = parseTags();
    const merged = [...new Set([...existing, ...(meta.genres || [])])];
    $("entryTags").value = merged.join(", ");
    toast(`Tags refreshed from ${meta.sourceName}.`);
  } catch {
    toast("Couldn't reach the source for tags.");
  } finally {
    btn.disabled = false;
    btn.textContent = "⟳ from source";
  }
}

function parseTags() {
  return $("entryTags").value.split(",").map((t) => t.trim()).filter(Boolean);
}

async function saveEntry() {
  const status = $("entryStatus").value;
  const score = $("entryScore").value === "" ? null : Number($("entryScore").value);
  const progress = $("entryProgress").value === "" ? 0 : Number($("entryProgress").value);
  const totalRaw = $("entryTotal").value;
  const total_units = totalRaw === "" ? null : Number(totalRaw);
  const notes = $("entryNotes").value.trim() || null;
  const tags = parseTags();

  $("saveEntryBtn").disabled = true;
  try {
    if (state.editingId) {
      const { error } = await state.supabase
        .from("entries")
        .update({ status, score, progress, total_units, notes, tags })
        .eq("id", state.editingId);
      if (error) throw error;
      toast("Saved.");
    } else if (state.pendingResult) {
      const item = state.pendingResult;
      const { error } = await state.supabase.from("entries").insert({
        user_id: state.session.user.id,
        media_type: state.mediaType,
        mal_id: item.malId,
        title: item.title,
        image_url: item.image || null,
        status, score, progress, total_units, notes, tags,
      });
      if (error) throw error;
      toast("Added to your shelf.");
    }
    closeEntryModal();
    loadEntries();
  } catch (err) {
    toast("Couldn't save: " + err.message);
  } finally {
    $("saveEntryBtn").disabled = false;
  }
}

async function deleteEntry() {
  if (!state.editingId) return;
  if (!confirm("Remove this from your shelf?")) return;
  const { error } = await state.supabase.from("entries").delete().eq("id", state.editingId);
  if (error) {
    toast("Couldn't remove: " + error.message);
    return;
  }
  closeEntryModal();
  toast("Removed.");
  loadEntries();
}

// ---------------------------------------------------------------------------
// Search sources — each returns { source, sourceName, extId, malId, title,
// image, type, year, units, tags }
// ---------------------------------------------------------------------------
async function fetchJikan(query, mediaType) {
  const endpoint = mediaType === "anime" ? "anime" : "manga";
  const res = await fetch(`https://api.jikan.moe/v4/${endpoint}?q=${encodeURIComponent(query)}&limit=8&sfw`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (json.data || []).map((it) => ({
    source: "jikan",
    sourceName: "MyAnimeList (Jikan)",
    extId: "jikan-" + it.mal_id,
    malId: it.mal_id ?? null,
    title: it.title,
    image: it.images?.jpg?.image_url || "",
    type: it.type || null,
    year: mediaType === "anime" ? (it.year || null) : (it.published?.prop?.from?.year || null),
    units: mediaType === "anime" ? (it.episodes || null) : (it.chapters || null),
    tags: [...new Set([...(it.genres || []), ...(it.themes || []), ...(it.demographics || [])].map((g) => g.name).filter(Boolean))],
  }));
}

async function fetchAniList(query, mediaType) {
  const gql = `query ($search: String, $type: MediaType) {
    Page(perPage: 8) {
      media(search: $search, type: $type) {
        id title { romaji english } coverImage { large }
        format episodes chapters startDate { year } genres tags { name rank isGeneralSpoiler }
      }
    }
  }`;
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: gql, variables: { search: query, type: mediaType === "anime" ? "ANIME" : "MANGA" } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message || "AniList error");
  const media = json.data?.Page?.media || [];
  return media.map((it) => {
    const topTags = (it.tags || [])
      .filter((t) => !t.isGeneralSpoiler && t.rank >= 60)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 6)
      .map((t) => t.name);
    return {
      source: "anilist",
      sourceName: "AniList",
      extId: "anilist-" + it.id,
      malId: null,
      title: it.title?.english || it.title?.romaji || "Untitled",
      image: it.coverImage?.large || "",
      type: it.format || null,
      year: it.startDate?.year || null,
      units: mediaType === "anime" ? (it.episodes || null) : (it.chapters || null),
      tags: [...new Set([...(it.genres || []), ...topTags])],
    };
  });
}

async function fetchKitsu(query, mediaType) {
  const endpoint = mediaType === "anime" ? "anime" : "manga";
  const res = await fetch(`https://kitsu.io/api/edge/${endpoint}?filter[text]=${encodeURIComponent(query)}&page[limit]=8&include=categories`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const catById = {};
  (json.included || []).forEach((inc) => {
    if (inc.type === "categories") catById[inc.id] = inc.attributes?.title;
  });
  return (json.data || []).map((it) => {
    const a = it.attributes || {};
    const catIds = it.relationships?.categories?.data || [];
    return {
      source: "kitsu",
      sourceName: "Kitsu",
      extId: "kitsu-" + it.id,
      malId: null,
      title: a.canonicalTitle || a.titles?.en || a.titles?.en_jp || "Untitled",
      image: a.posterImage?.small || a.posterImage?.medium || "",
      type: a.subtype || null,
      year: a.startDate ? Number(String(a.startDate).slice(0, 4)) : null,
      units: mediaType === "anime" ? (a.episodeCount || null) : (a.chapterCount || null),
      tags: catIds.map((c) => catById[c.id]).filter(Boolean).slice(0, 10),
    };
  });
}

async function fetchMangaDex(query) {
  const res = await fetch(
    `https://api.mangadex.org/manga?title=${encodeURIComponent(query)}&limit=8&includes[]=cover_art`
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (json.data || []).map((it) => {
    const attrs = it.attributes || {};
    const titles = attrs.title || {};
    const title = titles.en || Object.values(titles)[0] || Object.values(attrs.altTitles?.[0] || {})[0] || "Untitled";
    const coverRel = (it.relationships || []).find((r) => r.type === "cover_art");
    const image = coverRel?.attributes?.fileName
      ? `https://uploads.mangadex.org/covers/${it.id}/${coverRel.attributes.fileName}.256.jpg`
      : "";
    const tags = (attrs.tags || [])
      .map((t) => t.attributes?.name?.en)
      .filter(Boolean)
      .slice(0, 10);
    return {
      source: "mangadex",
      sourceName: "MangaDex",
      extId: "mangadex-" + it.id,
      malId: null,
      title,
      image,
      type: "Manga",
      year: attrs.year || null,
      units: attrs.lastChapter ? Number(attrs.lastChapter) || null : null,
      tags,
    };
  });
}

const SEARCH_SOURCES = {
  anime: [fetchJikan, fetchAniList, fetchKitsu],
  manga: [fetchJikan, fetchAniList, fetchKitsu, fetchMangaDex],
};

let searchResultIndex = {};

async function runSearch(query) {
  const resultsEl = $("searchResults");
  resultsEl.innerHTML = '<p class="muted-line" style="padding:8px;">Searching…</p>';

  const fetchers = SEARCH_SOURCES[state.mediaType];
  const settled = await Promise.allSettled(fetchers.map((fn) => fn(query, state.mediaType)));

  const sections = settled
    .map((outcome) => (outcome.status === "fulfilled" ? outcome.value : []))
    .filter((items) => items.length > 0);
  const failedCount = settled.filter((o) => o.status === "rejected").length;

  renderSearchSections(sections, failedCount, settled.length);
}

function renderSearchSections(sections, failedCount, totalCount) {
  const resultsEl = $("searchResults");
  searchResultIndex = {};

  if (sections.length === 0) {
    resultsEl.innerHTML =
      failedCount === totalCount
        ? '<p style="color:var(--red);font-size:13px;padding:8px;">All sources failed to respond. Try again in a moment.</p>'
        : '<p class="muted-line" style="padding:8px;">No results.</p>';
    return;
  }

  resultsEl.innerHTML = sections.map((items) => {
    const rows = items.map((it) => {
      searchResultIndex[it.extId] = it;
      const meta = [it.type, it.units ? it.units + (state.mediaType === "anime" ? " eps" : " ch") : null, it.year]
        .filter(Boolean).join(" · ");
      const tagLine = (it.tags || []).slice(0, 4).join(" · ");
      return `<div class="result-row" data-ext-id="${escapeAttr(it.extId)}">
        <img src="${escapeAttr(it.image)}" alt="" />
        <div><p class="r-title">${escapeHtml(it.title)}</p><p class="r-meta">${escapeHtml(meta)}</p>
        ${tagLine ? `<p class="r-tags">${escapeHtml(tagLine)}</p>` : ""}</div>
      </div>`;
    }).join("");
    return `<div class="result-section">
      <p class="result-section-title">${escapeHtml(items[0].sourceName)}</p>
      ${rows}
    </div>`;
  }).join("") + (failedCount > 0
    ? `<p class="result-source-note">${failedCount} of ${totalCount} sources didn't respond.</p>`
    : "");

  resultsEl.querySelectorAll(".result-row").forEach((row) => {
    row.addEventListener("click", () => {
      pickSearchResult(searchResultIndex[row.dataset.extId]);
    });
  });
}

// ---------------------------------------------------------------------------
// Backup
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

async function importLibrary(e) {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const rows = JSON.parse(text);
    if (!Array.isArray(rows)) throw new Error("That doesn't look like an Omoidebako backup file.");
    const cleaned = rows.map((r) => ({
      user_id: state.session.user.id,
      media_type: r.media_type,
      mal_id: r.mal_id ?? null,
      title: r.title,
      image_url: r.image_url ?? null,
      status: r.status || "plan",
      score: r.score ?? null,
      progress: r.progress ?? 0,
      total_units: r.total_units ?? null,
      notes: r.notes ?? null,
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
