"use strict";
// Moodle Hub — phone interface. All data comes from the Hub running on your computer.

const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
let S = null;               // last state from the server
let tab = "today";
let courseOpen = null;
let showDone = false;
let baseline = 0;           // when the first sync happened (items older than this aren't "new")

// ── tiny DOM helper: never uses innerHTML for data ──
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
const T = (s) => h("span", { dir: "auto", text: s ?? "" });

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined });
  let data = {};
  try { data = await r.json(); } catch { }
  if (r.status === 401) { boot(); throw new Error("login"); }
  if (!r.ok || data.error) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600);
}

// ── time helpers ──
const now = () => Date.now() / 1000;
function left(due) {
  const s = due - now();
  if (s < 0) { const d = Math.floor(-s / 86400); return d >= 1 ? `${d}d overdue` : "Overdue"; }
  const hrs = Math.floor(s / 3600);
  if (hrs < 1) return `${Math.max(1, Math.floor(s / 60))} min left`;
  if (hrs < 24) return `${hrs}h left`;
  const d = Math.floor(hrs / 24);
  return d === 1 ? "Tomorrow" : `${d} days`;
}
const fmtDate = (ts, o) => new Date(ts * 1000).toLocaleString(undefined, o);
const fmtDue = (ts) => fmtDate(ts, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
function ago(ts) {
  const s = now() - ts;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return fmtDate(ts, { day: "numeric", month: "short" });
}
const isNew = (it) => baseline && it.first_seen > baseline + 120 && now() - it.first_seen < 7 * 86400;

// ── boot: login / setup / app ──
async function boot() {
  let st;
  try { st = await (await fetch("/api/status", { credentials: "same-origin" })).json(); }
  catch { return renderMessage("Can't reach the Hub", "Make sure the computer running Moodle Hub is on and connected."); }
  if (!st.authed) return st.has_passcode ? renderLogin() :
    renderMessage("Almost there", "Finish setup on the computer that runs Moodle Hub, then come back here.");
  if (!st.configured) return renderSetup();
  chrome(true);
  await refresh();
  clearInterval(boot._i);
  boot._i = setInterval(() => refresh(true), 60000);
}

function chrome(on) {
  $("#tabbar").hidden = !on;
  $(".top").hidden = !on;
}

function renderMessage(title, text) {
  chrome(false);
  view.replaceChildren(h("div", { class: "center" }, h("p", { class: "big", text: title }), h("p", { class: "hint", text })));
}

function renderLogin() {
  chrome(false);
  const err = h("div", { class: "err" });
  const inp = h("input", { type: "password", inputmode: "numeric", autocomplete: "current-password", placeholder: "Passcode" });
  const go = async (e) => {
    e.preventDefault();
    try { await api("/api/login", { method: "POST", body: { passcode: inp.value } }); boot(); }
    catch (x) { err.textContent = x.message; }
  };
  view.replaceChildren(h("form", { class: "center", onsubmit: go },
    h("p", { class: "big", text: "Moodle Hub" }),
    h("p", { class: "hint", text: "Enter the passcode you set on your computer." }),
    h("div", { class: "field" }, inp), h("button", { class: "btn", type: "submit", text: "Open" }), err));
  inp.focus();
}

// ── data refresh ──
async function refresh(quiet) {
  try {
    S = await api("/api/state");
  } catch (e) { if (!quiet && e.message !== "login") toast(e.message); return; }
  const all = [...S.tasks, ...S.news, ...Object.values(S.courses).flatMap((c) => c.materials)];
  baseline = all.length ? Math.min(...all.map((i) => i.first_seen || Infinity)) : 0;
  header();
  render();
}

function header() {
  const m = S.meta, user = m.site && m.site.user ? m.site.user.split(" ")[0] : "";
  const hr = new Date().getHours();
  $("#hello").textContent = (hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening") + (user ? `, ${user}` : "");
  const sy = $("#sync");
  sy.className = "sync" + (m.error ? " err" : "");
  sy.textContent = m.running ? "Syncing…" : m.error ? "Sync problem" : m.last_sync ? `Updated ${ago(m.last_sync)}` : "Waiting for first sync…";
  $("#btn-sync").classList.toggle("spin", !!m.running);
  const b = $("#banner");
  if (m.error) { b.hidden = false; b.replaceChildren(T(m.error)); } else b.hidden = true;
  let seen = 0; try { seen = +localStorage.getItem("seenNews") || 0; } catch { }
  $("#dot-updates").hidden = !S.news.some((n) => (n.first_seen || 0) > seen && isNew(n));
}

function render() {
  document.querySelectorAll("#tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  if (!S) return;
  ({ today: renderToday, courses: renderCourses, updates: renderUpdates, grades: renderGrades })[tab]();
}

// ── Today ──
function taskRow(t) {
  const finished = t.done || t.submitted;
  const soon = t.due && !finished && t.due - now() < 3 * 86400;
  const chip = finished ? h("span", { class: "chip ok", text: t.submitted ? "Submitted" : "Done" })
    : t.due ? h("span", { class: "chip" + (soon ? " soon" : ""), text: left(t.due) })
    : isNew(t) ? h("span", { class: "chip new", text: "New" }) : null;
  const check = h("button", { class: "check" + (finished ? " on" : ""), "aria-label": "Mark done",
    onclick: async (e) => {
      e.stopPropagation();
      if (t.submitted) return toast("Already submitted in Moodle");
      await api(`/api/task/${t.id}/${t.done ? "undone" : "done"}`, { method: "POST" });
      refresh(true);
    } }, finished ? "✓" : "");
  return h("div", { class: "card task" + (finished ? " isdone" : ""), onclick: () => taskSheet(t) },
    h("div", { class: "date" },
      h("div", { class: "d", text: t.due ? fmtDate(t.due, { day: "numeric" }) : "—" }),
      h("div", { class: "m", text: t.due ? fmtDate(t.due, { month: "short" }) : "no date" })),
    h("div", { class: "body" }, h("div", { class: "t", dir: "auto", text: t.title }),
      h("div", { class: "c" }, ...[t.course, t.source && t.source !== "Moodle" ? t.source : null].filter(Boolean)
        .flatMap((x, i) => i ? [" · ", T(x)] : [T(x)]))),
    chip, check);
}

function renderToday() {
  const n = now();
  const open = S.tasks.filter((t) => !t.done && !t.submitted);
  const finished = S.tasks.filter((t) => (t.done || t.submitted) && (!t.due || t.due > n - 14 * 86400));
  const overdue = open.filter((t) => t.due && t.due < n && t.due > n - 14 * 86400);
  const week = open.filter((t) => t.due && t.due >= n && t.due < n + 7 * 86400);
  const later = open.filter((t) => t.due && t.due >= n + 7 * 86400);
  const nodate = open.filter((t) => !t.due);
  const out = [];
  const group = (label, list) => list.length && out.push(h("div", { class: "label", text: label }), ...list.map(taskRow));
  group("Overdue", overdue);
  group("This week", week);
  group("Later", later);
  group("No due date", nodate);
  if (!overdue.length && !week.length && !later.length && !nodate.length)
    out.push(h("div", { class: "label", text: "This week" }),
      h("div", { class: "empty", text: S.meta.last_sync ? "Nothing due. Enjoy it." : "Your tasks will appear after the first sync." }));
  out.push(h("button", { class: "add", onclick: () => taskForm(), text: "+ Add a task (e.g. ProblemChat homework)" }));
  if (finished.length) {
    out.push(h("button", { class: "more", onclick: () => { showDone = !showDone; render(); },
      text: showDone ? "Hide completed" : `Show ${finished.length} completed` }));
    if (showDone) out.push(...finished.map(taskRow));
  }
  const fresh = S.news.filter(isNew).slice(0, 2);
  if (fresh.length) {
    out.push(h("div", { class: "label", text: "New updates" }), ...fresh.map(newsCard));
  }
  view.replaceChildren(...out);
}

function openSheet(...kids) {
  const w = $("#sheet-wrap");
  $("#sheet").replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  w.hidden = false;
  document.body.style.overflow = "hidden";
}
function closeSheet() { $("#sheet-wrap").hidden = true; document.body.style.overflow = ""; }
$("#sheet-bg").addEventListener("click", closeSheet);

function summaryBlock(item) {
  if (item.summary) return h("div", { class: "sum" }, h("b", { text: "Summary" }), T(item.summary));
  return null;
}
function summarizeBtn(item, after) {
  if (!S.meta.can_summarize || item.summary) return null;
  const b = h("button", { class: "btn soft", text: "Summarize", onclick: async () => {
    b.disabled = true; b.textContent = "Reading…";
    try { const r = await api(`/api/summarize/${item.id}`, { method: "POST" }); item.summary = r.summary; after(); refresh(true); }
    catch (e) { toast(e.message); b.disabled = false; b.textContent = "Summarize"; }
  } });
  return b;
}

function taskSheet(t) {
  const draw = () => openSheet(
    h("h3", { dir: "auto", text: t.title }),
    h("div", { class: "sub", dir: "auto", text: [t.course, t.due ? `Due ${fmtDue(t.due)}` : "No due date",
      t.submitted ? "Submitted" : null, t.grade ? `Grade: ${t.grade}` : null].filter(Boolean).join(" · ") }),
    summaryBlock(t),
    t.description ? h("div", { class: "txt", dir: "auto", text: t.description }) : null,
    t.attachments && t.attachments.length ? h("div", { class: "hint", style: "margin-top:12px" },
      "Attached in Moodle: ", T(t.attachments.map((a) => a.name).join(", "))) : null,
    h("div", { class: "btns" },
      t.link ? h("a", { class: "btn", href: t.link, target: "_blank", rel: "noopener",
        text: t.source === "Moodle" ? (t.submitted ? "Open in Moodle" : "Submit in Moodle") : "Open link" }) : null,
      t.submitted ? null : h("button", { class: "btn soft", text: t.done ? "Mark not done" : "Mark done", onclick: async () => {
        await api(`/api/task/${t.id}/${t.done ? "undone" : "done"}`, { method: "POST" }); closeSheet(); refresh(true); } }),
      summarizeBtn(t, draw),
      t.id.startsWith("manual-") ? h("button", { class: "btn soft", text: "Edit", onclick: () => taskForm(t) }) : null,
      t.id.startsWith("manual-") ? h("button", { class: "btn danger", text: "Delete", onclick: async () => {
        await api(`/api/task/${t.id}/delete`, { method: "POST" }); closeSheet(); refresh(true); } }) : null));
  draw();
}

function taskForm(t = {}) {
  const courses = Object.values(S.courses).map((c) => c.title).filter(Boolean);
  const title = h("input", { value: t.title || "", placeholder: "e.g. Probability — Exercise 3", dir: "auto" });
  const course = h("select", {}, h("option", { value: "", text: "No course" }),
    ...courses.map((c) => h("option", { value: c, text: c, selected: c === t.course })));
  const pad = (n) => String(n).padStart(2, "0");
  const toLocal = (ts) => { const d = new Date(ts * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const due = h("input", { type: "datetime-local", value: t.due ? toLocal(t.due) : "" });
  const link = h("input", { type: "url", value: t.link || "", placeholder: "https://problemchat.azurewebsites.net" });
  const notes = h("textarea", { dir: "auto" }); notes.value = t.description || "";
  const err = h("div", { class: "err" });
  openSheet(h("h3", { text: t.id ? "Edit task" : "Add a task" }),
    h("div", { class: "hint", text: "For deadlines that aren't in Moodle. You'll get reminders 24 hours and 3 hours before." }),
    h("div", { class: "field" }, h("label", { text: "Task" }), title),
    h("div", { class: "field" }, h("label", { text: "Course" }), course),
    h("div", { class: "field" }, h("label", { text: "Due" }), due),
    h("div", { class: "field" }, h("label", { text: "Link (optional)" }), link),
    h("div", { class: "field" }, h("label", { text: "Notes (optional)" }), notes),
    err,
    h("div", { class: "btns" }, h("button", { class: "btn", text: "Save", onclick: async () => {
      try {
        await api("/api/task", { method: "POST", body: { id: t.id, title: title.value, course: course.value,
          due: due.value ? Math.floor(new Date(due.value).getTime() / 1000) : null, link: link.value, notes: notes.value } });
        closeSheet(); refresh(true);
      } catch (e) { err.textContent = e.message; }
    } }), h("button", { class: "btn soft", text: "Cancel", onclick: closeSheet })));
  title.focus();
}

// ── Courses ──
function renderCourses() {
  const courses = Object.values(S.courses).filter((c) => c.title);
  if (courseOpen && S.courses[courseOpen]) return renderCourse(S.courses[courseOpen]);
  courseOpen = null;
  if (!courses.length) return view.replaceChildren(h("div", { class: "empty", text: "Your courses will appear after the first sync." }));
  view.replaceChildren(h("div", { class: "label", text: "Your courses" }), ...courses.map((c) => {
    const files = c.materials.filter((m) => m.kind === "file").length;
    const fresh = c.materials.filter(isNew).length;
    const due = S.tasks.filter((t) => t.course_id === c.id && !t.done && !t.submitted && t.due && t.due > now()).length;
    return h("div", { class: "card course", onclick: () => { courseOpen = String(c.id); render(); window.scrollTo(0, 0); } },
      h("div", {}, h("div", { class: "t", dir: "auto", text: c.title }),
        h("div", { class: "c", text: [`${files} files`, due ? `${due} due` : null].filter(Boolean).join(" · ") })),
      fresh ? h("span", { class: "chip new", text: `${fresh} new` }) : h("span", { class: "c", text: "›" }));
  }));
}

const extOf = (m) => (m.kind === "file" ? (m.filename || "").split(".").pop().slice(0, 4).toUpperCase() :
  ({ quiz: "QUIZ", assign: "TASK", url: "LINK", page: "PAGE", forum: "FORUM", lti: "VIDEO", hvp: "VIDEO", folder: "DIR" })[m.module] || "•");

function renderCourse(c) {
  const secs = new Map();
  c.materials.forEach((m) => { if (!secs.has(m.section)) secs.set(m.section, []); secs.get(m.section).push(m); });
  const summarized = c.materials.filter((m) => m.summary);
  const newest = [...secs.entries()].reduce((best, [name, items]) => {
    const t = Math.max(...items.map((i) => i.timemodified || i.first_seen || 0));
    return !best || t > best[1] ? [name, t] : best; }, null);
  const out = [
    h("button", { class: "back", text: "‹ All courses", onclick: () => { courseOpen = null; render(); } }),
    h("div", { class: "ctitle", dir: "auto", text: c.title }),
    h("a", { class: "clink", href: c.url, target: "_blank", rel: "noopener", text: "Open course in Moodle" }),
  ];
  const tasks = S.tasks.filter((t) => t.course_id === c.id && !t.done && !t.submitted);
  if (tasks.length) out.push(h("div", { class: "label", text: "Due" }), ...tasks.map(taskRow));
  if (summarized.length) {
    out.push(h("div", { class: "label", text: "In short" }));
    summarized.slice(0, 6).forEach((m) => out.push(h("div", { class: "card", onclick: () => matSheet(m), style: "cursor:pointer" },
      h("div", { class: "t", dir: "auto", style: "font-weight:500;margin-bottom:4px", text: m.title }),
      h("div", { class: "hint", dir: "auto", text: m.summary }))));
  }
  out.push(h("div", { class: "label", text: "Materials" }));
  for (const [name, items] of secs) {
    const nNew = items.filter(isNew).length;
    out.push(h("details", { class: "sec", open: newest && name === newest[0] },
      h("summary", {}, T(name), h("span", { class: "n", text: nNew ? `${nNew} new` : `${items.length}` })),
      ...items.map((m) => h("div", { class: "mat", onclick: () => matSheet(m) },
        h("div", { class: "ic", text: extOf(m) }),
        h("div", { class: "t" }, h("div", { dir: "auto", text: m.title }),
          m.folder ? h("div", { class: "s", dir: "auto", text: m.folder }) : null),
        isNew(m) ? h("span", { class: "chip new", text: "New" }) : null))));
  }
  view.replaceChildren(...out);
}

function matSheet(m) {
  const isFile = m.kind === "file";
  const size = m.filesize ? (m.filesize > 1e6 ? `${(m.filesize / 1e6).toFixed(1)} MB` : `${Math.ceil(m.filesize / 1e3)} KB`) : null;
  const draw = () => openSheet(
    h("h3", { dir: "auto", text: m.title }),
    h("div", { class: "sub", dir: "auto", text: [m.course, m.section, size].filter(Boolean).join(" · ") }),
    summaryBlock(m),
    m.description ? h("div", { class: "txt", dir: "auto", text: m.description }) : null,
    h("div", { class: "btns" },
      isFile ? h("a", { class: "btn", href: `/api/file/${m.id}`, target: "_blank", text: "Open" }) : null,
      isFile ? h("a", { class: "btn soft", href: `/api/file/${m.id}?dl=1`, text: "Download" }) : null,
      summarizeBtn(m, draw),
      h("a", { class: isFile ? "btn soft" : "btn", href: m.link, target: "_blank", rel: "noopener", text: "Open in Moodle" })));
  draw();
}

// ── Updates ──
function newsCard(n) {
  const x = h("div", { class: "x clip", dir: "auto", text: n.text });
  return h("div", { class: "card news", onclick: () => x.classList.toggle("clip"), style: "cursor:pointer" },
    h("div", { class: "t", dir: "auto" }, T(n.title), isNew(n) ? h("span", { class: "chip new", style: "margin-inline-start:8px", text: "New" }) : null),
    h("div", { class: "c", dir: "auto", text: [n.course, n.author, n.time ? ago(n.time) : null].filter(Boolean).join(" · ") }),
    x);
}
function renderUpdates() {
  try { localStorage.setItem("seenNews", String(now())); } catch { }
  $("#dot-updates").hidden = true;
  if (!S.news.length) return view.replaceChildren(h("div", { class: "empty", text: "No announcements yet." }));
  view.replaceChildren(h("div", { class: "label", text: "Announcements" }), ...S.news.map(newsCard));
}

// ── Grades ──
function renderGrades() {
  const gs = Object.values(S.grades);
  if (!gs.length) return view.replaceChildren(h("div", { class: "label", text: "Grades" }),
    h("div", { class: "empty", text: "No grades yet. You'll get a notification when one is posted." }));
  view.replaceChildren(h("div", { class: "label", text: "Grades" }), ...gs.map((g) => h("div", { class: "card" },
    h("div", { style: "display:flex;justify-content:space-between;gap:10px;margin-bottom:6px" },
      h("div", { dir: "auto", style: "font-weight:500", text: g.course }), g.total ? h("b", { text: g.total }) : null),
    ...g.items.map((i) => h("div", { class: "grade" }, h("span", { dir: "auto", text: i.title }),
      h("b", { text: i.grade + (i.range ? ` / ${String(i.range).split("–").pop().split("-").pop()}` : "") }))))));
}

// ── Setup (on the computer) & settings ──
async function renderSetup() {
  chrome(false);
  const st = await api("/api/settings");
  const err = h("div", { class: "err" });
  const url = h("input", { value: st.moodle_url });
  const tok = h("textarea", { placeholder: "moodlemobile://token=…", style: "min-height:70px" });
  const pass = h("input", { type: "password", placeholder: "At least 4 characters", autocomplete: "new-password" });
  const save = async () => {
    err.textContent = "";
    try {
      await api("/api/setup", { method: "POST", body: { moodle_url: url.value, token: tok.value, passcode: pass.value } });
      notifyStep(await api("/api/settings"));
    } catch (e) { err.textContent = e.message; }
  };
  view.replaceChildren(
    h("p", { class: "big", style: "margin-top:40px", text: "Set up Moodle Hub" }),
    h("p", { class: "hint", text: "One-time setup on this computer. After this, everything syncs on its own." }),
    h("div", { class: "label", text: "1 · Connect your Moodle" }),
    h("div", { class: "field" }, h("label", { text: "Moodle address" }), url),
    h("ol", { class: "steps" },
      h("li", {}, "Sign in to ", h("a", { href: st.moodle_url + "/my/", target: "_blank", rel: "noopener", text: "your Moodle" }),
        " in ", h("b", { text: "Chrome or Edge" }), " if you aren't already."),
      h("li", {}, h("button", { class: "btn soft", style: "padding:8px 12px", text: "Copy sign-in link", onclick: async () => {
          try { await navigator.clipboard.writeText(st.launch_url); toast("Copied"); }
          catch { prompt("Copy this link:", st.launch_url); } } })),
      h("li", {}, "Open a ", h("b", { text: "new empty tab" }), ", press ", h("b", { text: "F12" }), " (Mac: ⌥⌘J) to open the console, ",
        "then paste the link into that tab's address bar and press Enter. The page stays blank — that's expected."),
      h("li", {}, "The console shows a red line: ", h("code", { text: "Failed to launch 'moodlemobile://token=…'" }),
        ". Copy the moodlemobile://token=… part and paste it below. No red line? Open the Network tab, click ",
        h("code", { text: "launch.php" }), " and copy the ", h("b", { text: "location" }), " response header instead.")),
    h("div", { class: "field" }, h("label", { text: "Paste the link" }), tok),
    h("div", { class: "label", text: "2 · Choose a passcode" }),
    h("p", { class: "hint", text: "You'll type this once on your phone. It keeps others on your Wi-Fi out." }),
    h("div", { class: "field" }, pass),
    err,
    h("div", { class: "btns" }, h("button", { class: "btn", text: "Connect", onclick: save })));
}

function notifyStep(st) {
  const err = h("div", { class: "err" });
  view.replaceChildren(
    h("p", { class: "big", style: "margin-top:40px", text: "Connected ✓" }),
    h("p", { class: "hint", text: "Your first sync is running. Two more things, both on your phone:" }),
    h("div", { class: "label", text: "3 · Get notifications" }),
    h("ol", { class: "steps" },
      h("li", {}, "Install the free ", h("b", { text: "ntfy" }), " app (App Store / Google Play)."),
      h("li", {}, "Tap + and subscribe to this topic: ", h("code", { text: st.ntfy_topic }), ". Keep it private, it works like a password."),
      h("li", {}, h("button", { class: "btn soft", text: "Send a test notification", onclick: async () => {
        try { await api("/api/test-notify", { method: "POST" }); toast("Sent — check your phone"); } catch (e) { err.textContent = e.message; } } }))),
    err,
    h("div", { class: "label", text: "4 · Open the Hub on your phone" }),
    h("p", { class: "hint", text: "With your phone on the same Wi-Fi, open:" }),
    ...st.lan.map((ip) => h("p", {}, h("code", { text: `http://${ip}:${st.port}` }))),
    h("p", { class: "hint", text: "Then use “Add to Home Screen” so it opens like an app. To use it away from home, see “Use it anywhere” in the README." }),
    h("div", { class: "btns" }, h("button", { class: "btn", text: "Go to my Hub", onclick: boot })));
}

async function settingsSheet() {
  const st = await api("/api/settings");
  const err = h("div", { class: "err" });
  const f = (label, el, hint) => h("div", { class: "field" }, h("label", { text: label }), el, hint ? h("div", { class: "hint", style: "margin-top:6px", text: hint }) : null);
  const tok = h("textarea", { placeholder: "moodlemobile://token=…", style: "min-height:60px" });
  const topic = h("input", { value: st.ntfy_topic });
  const pub = h("input", { value: st.public_url, placeholder: "e.g. http://my-pc.tail1234.ts.net:8765" });
  const mins = h("select", {}, ...[10, 15, 30, 60].map((m) => h("option", { value: m, text: `Every ${m} minutes`, selected: m === st.sync_minutes })));
  const qs = h("input", { type: "number", min: 0, max: 23, value: st.quiet_hours[0], style: "width:45%" });
  const qe = h("input", { type: "number", min: 0, max: 23, value: st.quiet_hours[1], style: "width:45%" });
  const key = h("input", { type: "password", placeholder: st.has_api_key ? "Saved — type to replace" : "sk-ant-…" });
  openSheet(h("h3", { text: "Settings" }),
    h("div", { class: "sub", text: st.has_token ? `Connected to ${st.moodle_url}` : "Not connected" }),
    f("Notifications topic (ntfy app)", topic, "Subscribe to this topic in the ntfy app on your phone."),
    h("div", { class: "btns", style: "margin-top:0" }, h("button", { class: "btn soft", text: "Send test notification",
      onclick: async () => { try { await api("/api/test-notify", { method: "POST" }); toast("Sent"); } catch (e) { toast(e.message); } } })),
    f("Check Moodle", mins),
    h("div", { class: "field" }, h("label", { text: "Quiet hours (only urgent pushes)" }),
      h("div", { style: "display:flex;gap:10%;align-items:center" }, qs, qe)),
    f("Hub address for notifications", pub, "Tapping a notification opens this. Leave empty if you only use home Wi-Fi."),
    f("Summaries — Anthropic API key (optional)", key, "Lets the Hub write 2–3 sentence summaries of new material."),
    h("div", { class: "label", text: "Reconnect Moodle" }),
    h("p", { class: "hint" }, "If sync says your sign-in expired: on the computer, open ",
      h("code", { text: st.launch_url }),
      ": copy it, open a new tab, press F12, paste the link into the address bar, and paste the moodlemobile://token=… line from the console here."),
    f("Sign-in link", tok),
    err,
    h("div", { class: "btns" },
      h("button", { class: "btn", text: "Save", onclick: async () => {
        try {
          await api("/api/setup", { method: "POST", body: { token: tok.value || undefined, ntfy_topic: topic.value, public_url: pub.value,
            sync_minutes: +mins.value, quiet_hours: [+qs.value, +qe.value], anthropic_api_key: key.value ? key.value : undefined } });
          closeSheet(); toast("Saved"); refresh(true);
        } catch (e) { err.textContent = e.message; }
      } }),
      h("button", { class: "btn soft", text: "Sign out of this device", onclick: async () => {
        await api("/api/logout", { method: "POST" }); closeSheet(); boot(); } })),
    h("p", { class: "hint", style: "margin-top:18px" }, "Phone address on your Wi-Fi: ",
      ...st.lan.map((ip) => h("code", { text: `http://${ip}:${st.port}` }))));
}

// ── wiring ──
document.querySelectorAll("#tabbar button").forEach((b) => b.addEventListener("click", () => {
  if (tab === b.dataset.tab && tab === "courses") courseOpen = null;
  tab = b.dataset.tab; render(); window.scrollTo(0, 0);
}));
$("#btn-sync").addEventListener("click", async () => {
  $("#btn-sync").classList.add("spin");
  try { await api("/api/sync", { method: "POST" }); } catch (e) { toast(e.message); }
  setTimeout(() => refresh(true), 1500);
  const poll = setInterval(async () => { await refresh(true); if (S && !S.meta.running) clearInterval(poll); }, 3000);
});
$("#btn-settings").addEventListener("click", settingsSheet);
document.addEventListener("visibilitychange", () => { if (!document.hidden && S) refresh(true); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
boot();
