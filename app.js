// ---------------------------------------------------------------------------
// Omoidebako — personal anime & manga log
// Data lives in Supabase (your own free project, see README.md for setup).
// Metadata comes from the Jikan API (a free, public MyAnimeList API).
// ---------------------------------------------------------------------------

const STATUS_LABELS = {
  anime: { watching: "Watching", completed: "Completed", plan: "Plan to watch", on_hold: "On hold", dropped: "Dropped" },
  manga: { watching: "Reading", completed: "Completed", plan: "Plan to read", on_hold: "On hold", dropped: "Dropped" },
};

const state = {
  supabase: null,
  session: null,
  authMode: "signin", // or "signup"
  entries: [],
  mediaType: "anime",
  statusFilter: "all",
  editingId: null,   // id of entry being edited, or null when creating
  pendingResult: null, // search result chosen but not yet saved
};

const $ = (id) => document.getElementById(id);

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("visible");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("visible"), 2200);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  if (!window.SUPABASE_URL || window.SUPABASE_URL.startsWith("PASTE_")) {
    document.body.innerHTML =
      '<div class="auth-screen"><div class="auth-card"><p class="auth-mark">Omoidebako</p>' +
      '<p class="auth-sub">config.js still has placeholder values. Open config.js and paste in ' +
      "your Supabase project URL and anon key (see README.md), then reload.</p></div></div>";
    return;
  }

  state.supabase = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  wireAuthUI();
  wireAppUI();

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
  $("authScreen").style.display = signedIn ? "none" : "flex";
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
  document.querySelectorAll(".type-switch button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".type-switch button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.mediaType = btn.dataset.type;
      applyStatusLabels();
      loadEntries();
    });
  });

  $("statusList").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-status]");
    if (!btn) return;
    document.querySelectorAll("#statusList button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.statusFilter = btn.dataset.status;
    renderGrid();
  });

  $("openAddModal").addEventListener("click", () => openSearchModal());
  $("closeSearch").addEventListener("click", () => $("searchOverlay").classList.remove("visible"));
  $("searchOverlay").addEventListener("click", (e) => {
    if (e.target.id === "searchOverlay") $("searchOverlay").classList.remove("visible");
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

  $("closeEntry").addEventListener("click", closeEntryModal);
  $("entryOverlay").addEventListener("click", (e) => {
    if (e.target.id === "entryOverlay") closeEntryModal();
  });
  $("saveEntryBtn").addEventListener("click", saveEntry);
  $("deleteEntryBtn").addEventListener("click", deleteEntry);

  $("signOutBtn").addEventListener("click", async () => {
    await state.supabase.auth.signOut();
  });

  $("exportBtn").addEventListener("click", exportLibrary);
  $("importBtn").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", importLibrary);

  applyStatusLabels();
}

function applyStatusLabels() {
  const labels = STATUS_LABELS[state.mediaType];
  document.querySelectorAll("#statusList button[data-status]").forEach((btn) => {
    const status = btn.dataset.status;
    if (status === "all") return;
    const countSpan = btn.querySelector(".count");
    btn.firstChild.textContent = labels[status];
    btn.appendChild(countSpan);
  });
  // form status dropdown labels
  const sel = $("entryStatus");
  [...sel.options].forEach((opt) => {
    if (labels[opt.value]) opt.textContent = labels[opt.value];
  });
  $("mainSubtitle").parentElement.firstChild.textContent =
    (state.statusFilter === "all" ? "All " : labels[state.statusFilter] + " ") +
    (state.mediaType === "anime" ? "anime" : "manga");
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
  state.entries = data || [];
  renderCounts();
  renderGrid();
}

function renderCounts() {
  const counts = { all: state.entries.length, watching: 0, completed: 0, plan: 0, on_hold: 0, dropped: 0 };
  state.entries.forEach((e) => { counts[e.status] = (counts[e.status] || 0) + 1; });
  Object.keys(counts).forEach((k) => {
    const el = $("count-" + k);
    if (el) el.textContent = counts[k];
  });
}

function renderGrid() {
  applyStatusLabels();
  const list =
    state.statusFilter === "all" ? state.entries : state.entries.filter((e) => e.status === state.statusFilter);

  const wrap = $("gridWrap");
  if (list.length === 0) {
    wrap.innerHTML =
      '<div class="empty-state"><h3>Nothing here yet</h3><p>Use "+ Add" to search titles and start your shelf.</p></div>';
    return;
  }

  wrap.innerHTML = '<div class="grid">' +
    list.map((e) => {
      const pct = e.total_units ? Math.min(100, Math.round((e.progress / e.total_units) * 100)) : 0;
      return `
        <div class="card" data-id="${e.id}">
          <div class="card-cover" style="background-image:url('${escapeAttr(e.image_url || "")}')">
            ${e.score ? `<span class="card-score">★ ${e.score}</span>` : ""}
          </div>
          <div class="card-body">
            <p class="card-title">${escapeHtml(e.title)}</p>
            <p class="card-progress">${e.progress || 0}${e.total_units ? " / " + e.total_units : ""}</p>
            ${e.total_units ? `<div class="card-progress-bar"><div style="width:${pct}%"></div></div>` : ""}
          </div>
        </div>`;
    }).join("") +
    "</div>";

  wrap.querySelectorAll(".card").forEach((card) => {
    card.addEventListener("click", () => openEntryModal(card.dataset.id));
  });
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/'/g, "&#39;"); }

// ---------------------------------------------------------------------------
// Search (Jikan API — free, no key required)
// ---------------------------------------------------------------------------
async function runSearch(query) {
  const resultsEl = $("searchResults");
  resultsEl.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:8px;">Searching...</p>';
  try {
    const endpoint = state.mediaType === "anime" ? "anime" : "manga";
    const res = await fetch(
      `https://api.jikan.moe/v4/${endpoint}?q=${encodeURIComponent(query)}&limit=8&sfw`
    );
    if (!res.ok) throw new Error("Search failed (rate limited? try again in a moment)");
    const json = await res.json();
    const items = json.data || [];
    if (items.length === 0) {
      resultsEl.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:8px;">No results.</p>';
      return;
    }
    resultsEl.innerHTML = items.map((it, i) => {
      const img = it.images?.jpg?.image_url || "";
      const meta = state.mediaType === "anime"
        ? [it.type, it.episodes ? it.episodes + " eps" : null, it.year].filter(Boolean).join(" · ")
        : [it.type, it.chapters ? it.chapters + " ch" : null, it.published?.prop?.from?.year].filter(Boolean).join(" · ");
      return `<div class="result-row" data-index="${i}">
        <img src="${escapeAttr(img)}" alt="" />
        <div><p class="r-title">${escapeHtml(it.title)}</p><p class="r-meta">${escapeHtml(meta)}</p></div>
      </div>`;
    }).join("");

    resultsEl.querySelectorAll(".result-row").forEach((row) => {
      row.addEventListener("click", () => {
        const item = items[Number(row.dataset.index)];
        pickSearchResult(item);
      });
    });
  } catch (err) {
    resultsEl.innerHTML = `<p style="color:var(--red);font-size:13px;padding:8px;">${escapeHtml(err.message)}</p>`;
  }
}

function openSearchModal() {
  $("searchInput").value = "";
  $("searchResults").innerHTML = "";
  $("searchOverlay").classList.add("visible");
  setTimeout(() => $("searchInput").focus(), 50);
}

function pickSearchResult(item) {
  $("searchOverlay").classList.remove("visible");
  state.editingId = null;
  state.pendingResult = item;

  const totalUnits = state.mediaType === "anime" ? item.episodes : item.chapters;

  $("entryModalTitle").textContent = "Add to your shelf";
  $("entryImg").src = item.images?.jpg?.image_url || "";
  $("entryTitle").textContent = item.title;
  $("entryMeta").textContent = [item.type, item.year || item.published?.prop?.from?.year].filter(Boolean).join(" · ");
  $("entryStatus").value = "plan";
  $("entryScore").value = "";
  $("entryProgress").value = 0;
  $("entryTotal").value = totalUnits || "";
  $("entryTotal").disabled = !!totalUnits;
  $("entryNotes").value = "";
  $("deleteEntryBtn").style.display = "none";

  $("entryOverlay").classList.add("visible");
}

// ---------------------------------------------------------------------------
// Entry modal: edit existing
// ---------------------------------------------------------------------------
function openEntryModal(id) {
  const entry = state.entries.find((e) => e.id === id);
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
  $("entryNotes").value = entry.notes || "";
  $("deleteEntryBtn").style.display = "inline-flex";

  $("entryOverlay").classList.add("visible");
}

function closeEntryModal() {
  $("entryOverlay").classList.remove("visible");
  state.editingId = null;
  state.pendingResult = null;
}

async function saveEntry() {
  const status = $("entryStatus").value;
  const score = $("entryScore").value === "" ? null : Number($("entryScore").value);
  const progress = $("entryProgress").value === "" ? 0 : Number($("entryProgress").value);
  const totalRaw = $("entryTotal").value;
  const total_units = totalRaw === "" ? null : Number(totalRaw);
  const notes = $("entryNotes").value.trim() || null;

  $("saveEntryBtn").disabled = true;
  try {
    if (state.editingId) {
      const { error } = await state.supabase
        .from("entries")
        .update({ status, score, progress, total_units, notes })
        .eq("id", state.editingId);
      if (error) throw error;
      toast("Saved.");
    } else if (state.pendingResult) {
      const item = state.pendingResult;
      const { error } = await state.supabase.from("entries").insert({
        user_id: state.session.user.id,
        media_type: state.mediaType,
        mal_id: item.mal_id,
        title: item.title,
        image_url: item.images?.jpg?.image_url || null,
        status, score, progress, total_units, notes,
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
// Backup: export / import as JSON (extra portability beyond the cloud copy)
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
