"use strict";
// Moodle Hub — ממשק לטלפון. כל הנתונים מגיעים מה-Hub שרץ על המחשב שלך.

const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
let S = null;               // last state from the server
let tab = "today";
let courseOpen = null;
let showDone = false;
let baseline = 0;           // when the first sync happened (items older than this aren't "new")
const LOCALE = "he-IL";

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
// Isolate a piece of text (a course name, a title) so its direction never scrambles the line around it
const B = (s) => h("bdi", { text: s ?? "" });
const LTR = (s) => h("code", { dir: "ltr", text: s });
// Join pieces with " · ", each isolated
const line = (...parts) => parts.filter(Boolean).flatMap((p, i) => (i ? [" · ", B(p)] : [B(p)]));

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined });
  let data = {};
  try { data = await r.json(); } catch { }
  if (r.status === 401) { boot(); throw new Error("login"); }
  if (!r.ok || data.error) throw new Error(data.error || `הבקשה נכשלה (${r.status})`);
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
  if (s < 0) { const d = Math.floor(-s / 86400); return d >= 1 ? `באיחור ${d} ימים` : "באיחור"; }
  const hrs = Math.floor(s / 3600);
  if (hrs < 1) return `עוד ${Math.max(1, Math.floor(s / 60))} דק׳`;
  if (hrs < 24) return `עוד ${hrs} שע׳`;
  const d = Math.floor(hrs / 24);
  return d === 1 ? "מחר" : `עוד ${d} ימים`;
}
const fmtDate = (ts, o) => new Date(ts * 1000).toLocaleString(LOCALE, o);
const fmtDue = (ts) => fmtDate(ts, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
function ago(ts) {
  const s = now() - ts;
  if (s < 90) return "עכשיו";
  if (s < 3600) return `לפני ${Math.floor(s / 60)} דק׳`;
  if (s < 86400) return `לפני ${Math.floor(s / 3600)} שע׳`;
  return fmtDate(ts, { day: "numeric", month: "short" });
}
const isNew = (it) => baseline && it.first_seen > baseline + 120 && now() - it.first_seen < 7 * 86400;

// ── boot: login / setup / app ──
async function boot() {
  let st;
  try { st = await (await fetch("/api/status", { credentials: "same-origin" })).json(); }
  catch { return renderMessage("אין חיבור ל-Hub", "ודאו שהמחשב שמריץ את Moodle Hub דולק ומחובר."); }
  if (!st.authed) return st.has_passcode ? renderLogin() :
    renderMessage("כמעט שם", "סיימו את ההגדרה במחשב שמריץ את Moodle Hub, ואז חזרו לכאן.");
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
  const inp = h("input", { type: "password", inputmode: "numeric", autocomplete: "current-password", placeholder: "קוד גישה" });
  const go = async (e) => {
    e.preventDefault();
    try { await api("/api/login", { method: "POST", body: { passcode: inp.value } }); boot(); }
    catch (x) { err.textContent = x.message; }
  };
  view.replaceChildren(h("form", { class: "center", onsubmit: go },
    h("p", { class: "big", text: "Moodle Hub" }),
    h("p", { class: "hint", text: "הקלידו את קוד הגישה שבחרתם במחשב." }),
    h("div", { class: "field" }, inp), h("button", { class: "btn wide", type: "submit", text: "כניסה" }), err));
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
  const m = S.meta;
  const hr = new Date().getHours();
  $("#hello").textContent = hr < 5 ? "לילה טוב" : hr < 12 ? "בוקר טוב" : hr < 17 ? "צהריים טובים" : hr < 21 ? "ערב טוב" : "לילה טוב";
  const sy = $("#sync");
  sy.className = "sync" + (m.error ? " err" : "");
  sy.textContent = m.running ? "מסנכרן…" : m.error ? "בעיה בסנכרון" : m.last_sync ? `עודכן ${ago(m.last_sync)}` : "ממתין לסנכרון הראשון…";
  $("#btn-sync").classList.toggle("spin", !!m.running);
  const b = $("#banner");
  if (m.error) { b.hidden = false; b.replaceChildren(B(m.error)); } else b.hidden = true;
  let seen = 0; try { seen = +localStorage.getItem("seenNews") || 0; } catch { }
  $("#dot-updates").hidden = !S.news.some((n) => (n.first_seen || 0) > seen && isNew(n));
}

function render() {
  document.querySelectorAll("#tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  if (!S) return;
  ({ today: renderToday, courses: renderCourses, updates: renderUpdates, grades: renderGrades })[tab]();
}

// ── היום ──
function taskRow(t) {
  const finished = t.done || t.submitted;
  const soon = t.due && !finished && t.due - now() < 3 * 86400;
  const chip = finished ? h("span", { class: "chip ok", text: t.submitted ? "הוגש" : "בוצע" })
    : t.due ? h("span", { class: "chip" + (soon ? " soon" : ""), text: left(t.due) })
    : isNew(t) ? h("span", { class: "chip new", text: "חדש" }) : null;
  const check = h("button", { class: "check" + (finished ? " on" : ""), "aria-label": "סימון כבוצע",
    onclick: async (e) => {
      e.stopPropagation();
      if (t.submitted) return toast("כבר הוגש במודל");
      await api(`/api/task/${t.id}/${t.done ? "undone" : "done"}`, { method: "POST" });
      refresh(true);
    } }, finished ? "✓" : "");
  return h("div", { class: "card task" + (finished ? " isdone" : ""), onclick: () => taskSheet(t) },
    h("div", { class: "date" },
      h("div", { class: "d", text: t.due ? fmtDate(t.due, { day: "numeric" }) : "—" }),
      h("div", { class: "m", text: t.due ? fmtDate(t.due, { month: "short" }) : "ללא" })),
    h("div", { class: "body" }, h("div", { class: "t" }, B(t.title)),
      h("div", { class: "c" }, ...line(t.course))),
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
  group("באיחור", overdue);
  group("השבוע", week);
  group("בהמשך", later);
  group("ללא תאריך הגשה", nodate);
  if (!overdue.length && !week.length && !later.length && !nodate.length)
    out.push(h("div", { class: "label", text: "השבוע" }),
      h("div", { class: "empty", text: S.meta.last_sync ? "אין שום דבר להגשה. תיהנו." : "המטלות יופיעו כאן אחרי הסנכרון הראשון." }));
  out.push(h("button", { class: "add", onclick: () => taskForm(), text: "+ הוספת מטלה" }));
  if (finished.length) {
    out.push(h("button", { class: "more", onclick: () => { showDone = !showDone; render(); },
      text: showDone ? "הסתרת מטלות שהושלמו" : `הצגת ${finished.length} מטלות שהושלמו` }));
    if (showDone) out.push(...finished.map(taskRow));
  }
  const fresh = S.news.filter(isNew).slice(0, 2);
  if (fresh.length) {
    out.push(h("div", { class: "label", text: "הודעות חדשות" }), ...fresh.map(newsCard));
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
  if (item.summary) return h("div", { class: "sum" }, h("b", { text: "תקציר" }), h("div", { dir: "auto", text: item.summary }));
  return null;
}
function summarizeBtn(item, after) {
  if (!S.meta.can_summarize || item.summary) return null;
  const b = h("button", { class: "btn soft", text: "תקציר", onclick: async () => {
    b.disabled = true; b.textContent = "קורא…";
    try { const r = await api(`/api/summarize/${item.id}`, { method: "POST" }); item.summary = r.summary; after(); refresh(true); }
    catch (e) { toast(e.message); b.disabled = false; b.textContent = "תקציר"; }
  } });
  return b;
}

function taskSheet(t) {
  const draw = () => openSheet(
    h("h3", {}, B(t.title)),
    h("div", { class: "sub" }, ...line(t.course, t.due ? `להגשה ${fmtDue(t.due)}` : "ללא תאריך הגשה",
      t.submitted ? "הוגש" : null, t.grade ? `ציון: ${t.grade}` : null)),
    summaryBlock(t),
    t.description ? h("div", { class: "txt", dir: "auto", text: t.description }) : null,
    t.attachments && t.attachments.length ? h("div", { class: "hint", style: "margin-top:12px" },
      "קבצים מצורפים במודל: ", B(t.attachments.map((a) => a.name).join(", "))) : null,
    h("div", { class: "btns" },
      t.link ? h("a", { class: "btn", href: t.link, target: "_blank", rel: "noopener",
        text: t.source === "Moodle" ? (t.submitted ? "פתיחה במודל" : "הגשה במודל") : "פתיחת הקישור" }) : null,
      t.submitted ? null : h("button", { class: "btn soft", text: t.done ? "ביטול סימון" : "סימון כבוצע", onclick: async () => {
        await api(`/api/task/${t.id}/${t.done ? "undone" : "done"}`, { method: "POST" }); closeSheet(); refresh(true); } }),
      summarizeBtn(t, draw),
      t.id.startsWith("manual-") ? h("button", { class: "btn soft", text: "עריכה", onclick: () => taskForm(t) }) : null,
      t.id.startsWith("manual-") ? h("button", { class: "btn danger", text: "מחיקה", onclick: async () => {
        await api(`/api/task/${t.id}/delete`, { method: "POST" }); closeSheet(); refresh(true); } }) : null));
  draw();
}

function taskForm(t = {}) {
  const courses = Object.values(S.courses).map((c) => c.title).filter(Boolean);
  const title = h("input", { value: t.title || "", placeholder: "למשל: הסתברות — תרגיל 3", dir: "auto" });
  const course = h("select", {}, h("option", { value: "", text: "ללא קורס" }),
    ...courses.map((c) => h("option", { value: c, text: c, selected: c === t.course })));
  const pad = (n) => String(n).padStart(2, "0");
  const toLocal = (ts) => { const d = new Date(ts * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const due = h("input", { type: "datetime-local", value: t.due ? toLocal(t.due) : "" });
  const link = h("input", { type: "url", dir: "ltr", value: t.link || "", placeholder: "https://problemchat.azurewebsites.net" });
  const notes = h("textarea", { dir: "auto" }); notes.value = t.description || "";
  const err = h("div", { class: "err" });
  openSheet(h("h3", { text: t.id ? "עריכת מטלה" : "הוספת מטלה" }),
    h("div", { class: "hint", text: "למועדי הגשה שלא מופיעים במודל. תקבלו תזכורת 24 שעות ו-3 שעות לפני." }),
    h("div", { class: "field" }, h("label", { text: "מטלה" }), title),
    h("div", { class: "field" }, h("label", { text: "קורס" }), course),
    h("div", { class: "field" }, h("label", { text: "מועד הגשה" }), due),
    h("div", { class: "field" }, h("label", { text: "קישור (לא חובה)" }), link),
    h("div", { class: "field" }, h("label", { text: "הערות (לא חובה)" }), notes),
    err,
    h("div", { class: "btns" }, h("button", { class: "btn", text: "שמירה", onclick: async () => {
      try {
        await api("/api/task", { method: "POST", body: { id: t.id, title: title.value, course: course.value,
          due: due.value ? Math.floor(new Date(due.value).getTime() / 1000) : null, link: link.value, notes: notes.value } });
        closeSheet(); refresh(true);
      } catch (e) { err.textContent = e.message; }
    } }), h("button", { class: "btn soft", text: "ביטול", onclick: closeSheet })));
  title.focus();
}

// ── קורסים ──
function renderCourses() {
  const courses = Object.values(S.courses).filter((c) => c.title);
  if (courseOpen && S.courses[courseOpen]) return renderCourse(S.courses[courseOpen]);
  courseOpen = null;
  if (!courses.length) return view.replaceChildren(h("div", { class: "empty", text: "הקורסים יופיעו כאן אחרי הסנכרון הראשון." }));
  view.replaceChildren(h("div", { class: "label", text: "הקורסים שלי" }), ...courses.map((c) => {
    const files = c.materials.filter((m) => m.kind === "file").length;
    const fresh = c.materials.filter(isNew).length;
    const due = S.tasks.filter((t) => t.course_id === c.id && !t.done && !t.submitted && t.due && t.due > now()).length;
    return h("div", { class: "card course", onclick: () => { courseOpen = String(c.id); render(); window.scrollTo(0, 0); } },
      h("div", {}, h("div", { class: "t" }, B(c.title)),
        h("div", { class: "c", text: [`${files} קבצים`, due ? `${due} להגשה` : null].filter(Boolean).join(" · ") })),
      fresh ? h("span", { class: "chip new", text: `${fresh} חדשים` }) : h("span", { class: "arrow", text: "‹" }));
  }));
}

const KIND_LABEL = { quiz: "בוחן", assign: "מטלה", url: "קישור", page: "דף", forum: "פורום", lti: "וידאו", hvp: "וידאו", folder: "תיקייה" };
const extOf = (m) => (m.kind === "file" ? (m.filename || "").split(".").pop().slice(0, 4).toUpperCase() : KIND_LABEL[m.module] || "•");

function renderCourse(c) {
  const secs = new Map();
  c.materials.forEach((m) => { if (!secs.has(m.section)) secs.set(m.section, []); secs.get(m.section).push(m); });
  const summarized = c.materials.filter((m) => m.summary);
  const newest = [...secs.entries()].reduce((best, [name, items]) => {
    const t = Math.max(...items.map((i) => i.timemodified || i.first_seen || 0));
    return !best || t > best[1] ? [name, t] : best; }, null);
  const out = [
    h("button", { class: "back", text: "→ כל הקורסים", onclick: () => { courseOpen = null; render(); } }),
    h("div", { class: "ctitle" }, B(c.title)),
    h("a", { class: "clink", href: c.url, target: "_blank", rel: "noopener", text: "פתיחת הקורס במודל" }),
  ];
  const tasks = S.tasks.filter((t) => t.course_id === c.id && !t.done && !t.submitted);
  if (tasks.length) out.push(h("div", { class: "label", text: "להגשה" }), ...tasks.map(taskRow));
  if (summarized.length) {
    out.push(h("div", { class: "label", text: "בקצרה" }));
    summarized.slice(0, 6).forEach((m) => out.push(h("div", { class: "card", onclick: () => matSheet(m), style: "cursor:pointer" },
      h("div", { class: "t", style: "font-weight:500;margin-bottom:4px" }, B(m.title)),
      h("div", { class: "hint", dir: "auto", text: m.summary }))));
  }
  out.push(h("div", { class: "label", text: "חומרי הקורס" }));
  for (const [name, items] of secs) {
    const nNew = items.filter(isNew).length;
    out.push(h("details", { class: "sec", open: newest && name === newest[0] },
      h("summary", {}, B(name), h("span", { class: "n", text: nNew ? `${nNew} חדשים` : `${items.length}` })),
      ...items.map((m) => h("div", { class: "mat", onclick: () => matSheet(m) },
        h("div", { class: "ic", text: extOf(m) }),
        h("div", { class: "t" }, h("div", {}, B(m.title)),
          m.folder ? h("div", { class: "s" }, B(m.folder)) : null),
        isNew(m) ? h("span", { class: "chip new", text: "חדש" }) : null))));
  }
  view.replaceChildren(...out);
}

function matSheet(m) {
  const isFile = m.kind === "file";
  const size = m.filesize ? (m.filesize > 1e6 ? `${(m.filesize / 1e6).toFixed(1)} MB` : `${Math.ceil(m.filesize / 1e3)} KB`) : null;
  const draw = () => openSheet(
    h("h3", {}, B(m.title)),
    h("div", { class: "sub" }, ...line(m.course, m.section, size)),
    summaryBlock(m),
    m.description ? h("div", { class: "txt", dir: "auto", text: m.description }) : null,
    h("div", { class: "btns" },
      isFile ? h("a", { class: "btn", href: `/api/file/${m.id}`, target: "_blank", text: "פתיחה" }) : null,
      isFile ? h("a", { class: "btn soft", href: `/api/file/${m.id}?dl=1`, text: "הורדה" }) : null,
      summarizeBtn(m, draw),
      h("a", { class: isFile ? "btn soft" : "btn", href: m.link, target: "_blank", rel: "noopener", text: "פתיחה במודל" })));
  draw();
}

// ── עדכונים ──
function newsCard(n) {
  const x = h("div", { class: "x clip", dir: "auto", text: n.text });
  return h("div", { class: "card news", onclick: () => x.classList.toggle("clip"), style: "cursor:pointer" },
    h("div", { class: "t" }, B(n.title), isNew(n) ? h("span", { class: "chip new", style: "margin-inline-start:8px", text: "חדש" }) : null),
    h("div", { class: "c" }, ...line(n.course, n.author, n.time ? ago(n.time) : null)),
    x);
}
function renderUpdates() {
  try { localStorage.setItem("seenNews", String(now())); } catch { }
  $("#dot-updates").hidden = true;
  if (!S.news.length) return view.replaceChildren(h("div", { class: "empty", text: "אין עדיין הודעות." }));
  view.replaceChildren(h("div", { class: "label", text: "הודעות" }), ...S.news.map(newsCard));
}

// ── ציונים ──
function renderGrades() {
  const gs = Object.values(S.grades);
  if (!gs.length) return view.replaceChildren(h("div", { class: "label", text: "ציונים" }),
    h("div", { class: "empty", text: "אין עדיין ציונים. תקבלו התראה כשיתפרסם ציון." }));
  view.replaceChildren(h("div", { class: "label", text: "ציונים" }), ...gs.map((g) => h("div", { class: "card" },
    h("div", { style: "display:flex;justify-content:space-between;gap:10px;margin-bottom:6px" },
      h("div", { style: "font-weight:500" }, B(g.course)), g.total ? h("b", {}, B(g.total)) : null),
    ...g.items.map((i) => h("div", { class: "grade" }, B(i.title),
      h("b", { dir: "ltr", text: i.grade + (i.range ? ` / ${String(i.range).split("–").pop().split("-").pop().trim()}` : "") }))))));
}

// ── הגדרה ראשונית (במחשב) והגדרות ──
async function renderSetup() {
  chrome(false);
  const st = await api("/api/settings");
  const err = h("div", { class: "err" });
  const url = h("input", { value: st.moodle_url, dir: "ltr" });
  const tok = h("textarea", { placeholder: "moodlemobile://token=…", dir: "ltr", style: "min-height:70px" });
  const pass = h("input", { type: "password", placeholder: "לפחות 4 תווים", autocomplete: "new-password" });
  const save = async () => {
    err.textContent = "";
    try {
      await api("/api/setup", { method: "POST", body: { moodle_url: url.value, token: tok.value, passcode: pass.value } });
      notifyStep(await api("/api/settings"));
    } catch (e) { err.textContent = e.message; }
  };
  view.replaceChildren(
    h("p", { class: "big", style: "margin-top:40px", text: "הגדרת Moodle Hub" }),
    h("p", { class: "hint", text: "הגדרה חד-פעמית במחשב הזה. אחריה הכול מסתנכרן לבד." }),
    h("div", { class: "label", text: "1 · חיבור למודל" }),
    h("div", { class: "field" }, h("label", { text: "כתובת המודל" }), url),
    h("ol", { class: "steps" },
      h("li", {}, "היכנסו ל", h("a", { href: st.moodle_url + "/my/", target: "_blank", rel: "noopener", text: "מודל" }),
        " בכרום (אם אתם לא מחוברים כבר)."),
      h("li", {}, h("button", { class: "btn soft", style: "padding:8px 12px", text: "העתקת קישור ההתחברות", onclick: async () => {
          try { await navigator.clipboard.writeText(st.launch_url); toast("הועתק"); }
          catch { prompt("העתיקו את הקישור:", st.launch_url); } } })),
      h("li", {}, "פתחו לשונית חדשה וריקה, לחצו ", LTR("⌥⌘I"), " (ב-Windows: ", LTR("F12"),
        "), עברו ללשונית ", LTR("Network"), " וסמנו ", LTR("Preserve log"), "."),
      h("li", {}, "הדביקו את הקישור בשורת הכתובת של אותה לשונית ולחצו Enter. הדף יישאר ריק, וזה תקין."),
      h("li", {}, "ברשימה לחצו על ", LTR("launch.php"), ", ותחת ", LTR("Response Headers"),
        " העתיקו את הערך של ", LTR("location"), " (מתחיל ב-", LTR("moodlemobile://token="), ") והדביקו כאן:")),
    h("div", { class: "field" }, h("label", { text: "הדביקו כאן" }), tok),
    h("div", { class: "label", text: "2 · קוד גישה" }),
    h("p", { class: "hint", text: "תקלידו אותו פעם אחת בטלפון. הוא מונע מאחרים ברשת להיכנס." }),
    h("div", { class: "field" }, pass),
    err,
    h("div", { class: "btns" }, h("button", { class: "btn", text: "התחברות", onclick: save })));
}

function phoneLinks(st) {
  return st.lan.length ? st.lan.map((ip) => h("p", {}, LTR(`http://${ip}:${st.port}`)))
    : [h("p", { class: "hint", text: "לא נמצאה רשת Wi-Fi פעילה במחשב." })];
}

function notifyStep(st) {
  const err = h("div", { class: "err" });
  view.replaceChildren(
    h("p", { class: "big", style: "margin-top:40px", text: "מחובר ✓" }),
    h("p", { class: "hint", text: "הסנכרון הראשון רץ. עוד שני דברים, שניהם בטלפון:" }),
    h("div", { class: "label", text: "3 · התראות" }),
    h("ol", { class: "steps" },
      h("li", {}, "התקינו את האפליקציה החינמית ", LTR("ntfy"), " (App Store / Google Play)."),
      h("li", {}, "לחצו + והירשמו לנושא הזה: ", LTR(st.ntfy_topic), ". שמרו אותו לעצמכם, הוא כמו סיסמה."),
      h("li", {}, h("button", { class: "btn soft", text: "שליחת התראת בדיקה", onclick: async () => {
        try { await api("/api/test-notify", { method: "POST" }); toast("נשלח, בדקו בטלפון"); } catch (e) { err.textContent = e.message; } } }))),
    err,
    h("div", { class: "label", text: "4 · פתיחה בטלפון" }),
    h("p", { class: "hint", text: "כשהטלפון מחובר לאותה רשת Wi-Fi, פתחו:" }),
    ...phoneLinks(st),
    h("p", { class: "hint", text: "ואז ״הוספה למסך הבית״, כדי שייפתח כמו אפליקציה." }),
    h("div", { class: "btns" }, h("button", { class: "btn", text: "ל-Hub שלי", onclick: boot })));
}

async function settingsSheet() {
  const st = await api("/api/settings");
  const err = h("div", { class: "err" });
  const f = (label, el, hint) => h("div", { class: "field" }, h("label", { text: label }), el, hint ? h("div", { class: "hint", style: "margin-top:6px", text: hint }) : null);
  const tok = h("textarea", { placeholder: "moodlemobile://token=…", dir: "ltr", style: "min-height:60px" });
  const topic = h("input", { value: st.ntfy_topic, dir: "ltr" });
  const pub = h("input", { value: st.public_url, dir: "ltr", placeholder: "http://my-mac.tail1234.ts.net:8765" });
  const mins = h("select", {}, ...[10, 15, 30, 60].map((m) => h("option", { value: m, text: `כל ${m} דקות`, selected: m === st.sync_minutes })));
  const qs = h("input", { type: "number", min: 0, max: 23, value: st.quiet_hours[0], style: "width:45%" });
  const qe = h("input", { type: "number", min: 0, max: 23, value: st.quiet_hours[1], style: "width:45%" });
  const key = h("input", { type: "password", dir: "ltr", placeholder: st.has_api_key ? "שמור, הקלידו כדי להחליף" : "sk-ant-…" });
  openSheet(h("h3", { text: "הגדרות" }),
    h("div", { class: "sub", text: st.has_token ? "מחובר למודל" : "לא מחובר" }),
    f("נושא ההתראות (באפליקציית ntfy)", topic, "הירשמו לנושא הזה באפליקציית ntfy בטלפון."),
    h("div", { class: "btns", style: "margin-top:0" }, h("button", { class: "btn soft", text: "שליחת התראת בדיקה",
      onclick: async () => { try { await api("/api/test-notify", { method: "POST" }); toast("נשלח"); } catch (e) { toast(e.message); } } })),
    f("בדיקת עדכונים במודל", mins),
    h("div", { class: "field" }, h("label", { text: "שעות שקטות (רק התראות דחופות): משעה עד שעה" }),
      h("div", { style: "display:flex;gap:10%;align-items:center" }, qs, qe)),
    f("כתובת ה-Hub מחוץ לבית", pub, "לחיצה על התראה תפתח את הכתובת הזו. השאירו ריק אם אתם משתמשים רק ב-Wi-Fi של הבית."),
    f("תקצירים: מפתח API של Anthropic (לא חובה)", key, "מאפשר ל-Hub לכתוב תקציר קצר לכל חומר חדש."),
    h("div", { class: "label", text: "חיבור מחדש למודל" }),
    h("p", { class: "hint", text: "אם הסנכרון אומר שההתחברות פגה: במחשב, חזרו על שלב החיבור עם הקישור הזה והדביקו כאן את הערך החדש." }),
    h("p", {}, LTR(st.launch_url)),
    f("ערך ה-location", tok),
    err,
    h("div", { class: "btns" },
      h("button", { class: "btn", text: "שמירה", onclick: async () => {
        try {
          await api("/api/setup", { method: "POST", body: { token: tok.value || undefined, ntfy_topic: topic.value, public_url: pub.value,
            sync_minutes: +mins.value, quiet_hours: [+qs.value, +qe.value], anthropic_api_key: key.value ? key.value : undefined } });
          closeSheet(); toast("נשמר"); refresh(true);
        } catch (e) { err.textContent = e.message; }
      } }),
      h("button", { class: "btn soft", text: "התנתקות מהמכשיר הזה", onclick: async () => {
        await api("/api/logout", { method: "POST" }); closeSheet(); boot(); } })),
    h("div", { class: "label", text: "כתובת לטלפון ברשת הביתית" }),
    ...phoneLinks(st));
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
