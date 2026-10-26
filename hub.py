#!/usr/bin/env python3
"""
Moodle Hub — your own replacement for the Moodle website.

Runs on one computer, syncs with Moodle every few minutes, keeps everything
in a local database, sends phone notifications, and serves a phone-friendly
web interface.

Start it:   python3 hub.py          (Windows: py hub.py)
Then open:  http://localhost:8765   on this computer to finish setup.

Only the Python standard library is required. Optional: `pip install pypdf`
lets the Hub read PDFs so it can write summaries (needs an Anthropic API key).
"""
import base64, hashlib, html, http.server, json, mimetypes, os, re, secrets, socket
import socketserver, sqlite3, sys, threading, time, traceback, urllib.error
import urllib.parse, urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("HUB_DATA") or os.path.join(HERE, "data")
STATIC = os.path.join(HERE, "static")
CONFIG_PATH = os.path.join(DATA, "config.json")
DB_PATH = os.path.join(DATA, "hub.db")
FILES = os.path.join(DATA, "files")
VERSION = "1.0"

DEFAULT_CONFIG = {
    "moodle_url": "https://moodle.runi.ac.il/2027",
    "token": "",
    "passcode_hash": "",
    "passcode_salt": "",
    "ntfy_server": "https://ntfy.sh",
    "ntfy_topic": "",
    "anthropic_api_key": "",
    "summary_model": "claude-haiku-5-5",
    "sync_minutes": 15,
    "quiet_hours": [0, 7],          # no non-urgent pushes between 00:00 and 07:00
    "public_url": "",               # how your phone reaches the Hub (shown in notifications)
    "port": 8765,
}

def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)

# ───────────────────────────── config ─────────────────────────────

_cfg_lock = threading.Lock()

def load_config():
    os.makedirs(DATA, exist_ok=True)
    cfg = dict(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, encoding="utf-8") as f:
            cfg.update(json.load(f))
    if not cfg["ntfy_topic"]:
        cfg["ntfy_topic"] = "moodle-hub-" + secrets.token_hex(6)
        save_config(cfg)
    return cfg

def save_config(cfg):
    with _cfg_lock:
        os.makedirs(DATA, exist_ok=True)
        tmp = CONFIG_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
        os.replace(tmp, CONFIG_PATH)
        try: os.chmod(CONFIG_PATH, 0o600)
        except OSError: pass

def hash_pass(p, salt):
    return hashlib.pbkdf2_hmac("sha256", p.encode(), salt.encode(), 200_000).hex()

def parse_token(text):
    """Accept a raw token, or the moodlemobile://token=... link from the sign-in step."""
    text = (text or "").strip().strip('"\'')
    m = re.search(r"token=([A-Za-z0-9+/=_-]+)", text)
    if m:
        b = m.group(1)
        b += "=" * (-len(b) % 4)
        try:
            decoded = base64.b64decode(b.replace("-", "+").replace("_", "/")).decode()
        except Exception:
            raise ValueError("לא נמצא טוקן תקין בקישור. העתיקו את כל הערך שמתחיל ב-moodlemobile://token=")
        parts = decoded.split(":::")
        if len(parts) >= 2 and re.fullmatch(r"[a-f0-9]{32}", parts[1]):
            return parts[1]
        raise ValueError("לא נמצא טוקן תקין בקישור.")
    if re.fullmatch(r"[a-f0-9]{32}", text):
        return text
    raise ValueError("הדביקו את הערך שמתחיל ב-moodlemobile://token=")

# ───────────────────────────── database ─────────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS items(
  id TEXT PRIMARY KEY, kind TEXT, course_id INTEGER, course TEXT, data TEXT,
  first_seen REAL, updated REAL, gone INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS done(task_id TEXT PRIMARY KEY, at REAL);
CREATE TABLE IF NOT EXISTS reminders(task_id TEXT, win TEXT, PRIMARY KEY(task_id, win));
CREATE TABLE IF NOT EXISTS summaries(file_id TEXT PRIMARY KEY, text TEXT, at REAL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, created REAL, label TEXT);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL, kind TEXT, text TEXT, item_id TEXT);
"""

_db_lock = threading.RLock()

def db():
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.row_factory = sqlite3.Row
    return con

_con = None
def con():
    global _con
    if _con is None:
        os.makedirs(DATA, exist_ok=True)
        _con = db()
        _con.executescript(SCHEMA)
        _con.commit()
    return _con

def q(sql, args=(), one=False):
    with _db_lock:
        cur = con().execute(sql, args)
        rows = cur.fetchall()
        con().commit()
    return (rows[0] if rows else None) if one else rows

def meta_get(k, default=None):
    r = q("SELECT v FROM meta WHERE k=?", (k,), one=True)
    return json.loads(r["v"]) if r else default

def meta_set(k, v):
    q("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, json.dumps(v)))

# ───────────────────────────── Moodle client ─────────────────────────────

class MoodleError(Exception):
    def __init__(self, msg, code=""):
        super().__init__(msg); self.code = code

def _flatten(prefix, value, out):
    if isinstance(value, dict):
        for k, v in value.items():
            _flatten(f"{prefix}[{k}]" if prefix else k, v, out)
    elif isinstance(value, (list, tuple)):
        for i, v in enumerate(value):
            _flatten(f"{prefix}[{i}]", v, out)
    elif isinstance(value, bool):
        out.append((prefix, "1" if value else "0"))
    elif value is not None:
        out.append((prefix, str(value)))

class Moodle:
    def __init__(self, base, token):
        self.base = base.rstrip("/")
        self.token = token

    def call(self, fn, **params):
        pairs = [("wstoken", self.token), ("wsfunction", fn), ("moodlewsrestformat", "json")]
        _flatten("", params, pairs)
        body = urllib.parse.urlencode(pairs).encode()
        req = urllib.request.Request(self.base + "/webservice/rest/server.php", data=body,
                                     headers={"User-Agent": "MoodleHub/" + VERSION})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read().decode("utf-8"))
        except urllib.error.URLError as e:
            raise MoodleError(f"אין חיבור למודל ({e.reason if hasattr(e,'reason') else e})", "network")
        if isinstance(data, dict) and data.get("exception"):
            raise MoodleError(data.get("message", "Moodle error"), data.get("errorcode", ""))
        return data

    def download(self, fileurl):
        sep = "&" if "?" in fileurl else "?"
        url = fileurl + sep + "token=" + urllib.parse.quote(self.token)
        req = urllib.request.Request(url, headers={"User-Agent": "MoodleHub/" + VERSION})
        r = urllib.request.urlopen(req, timeout=120)
        ctype = r.headers.get("Content-Type", "")
        if "application/json" in ctype:
            data = json.loads(r.read().decode())
            raise MoodleError(data.get("error") or data.get("message") or "Download refused", "download")
        return r

def launch_url(base):
    return (base.rstrip("/") + "/admin/tool/mobile/launch.php?service=moodle_mobile_app"
            f"&passport={secrets.randbelow(10**6)}&urlscheme=moodlemobile")

def html_to_text(s):
    s = re.sub(r"(?is)<(script|style).*?</\1>", " ", s or "")
    s = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>", "\n", s)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    s = re.sub(r"[ \t\r\f\v]+", " ", s)
    s = re.sub(r"\n\s*\n+", "\n\n", s)
    return s.strip()

# Moodle names written in two languages arrive glued together with no space between the halves
# ("Complexity Theoryתורת הסיבוכיות"). Notifications are in Hebrew, so keep only the Hebrew half.
# Anything else, including a Hebrew sentence that mentions an English word, is left as it is.
_HE, _LAT = re.compile(r"[\u0590-\u05FF]"), re.compile(r"[A-Za-z]")
def _is_he(s):
    return len(_HE.findall(s)) > len(_LAT.findall(s))

def heb(s):
    s = s or ""
    seams = []
    for i in range(1, len(s)):
        a, b = s[i - 1], s[i]
        if _HE.match(b) and (_LAT.match(a) or (a in "?!.)" and i > 1 and _LAT.match(s[i - 2]))):
            seams.append(i)
        elif _HE.match(a) and _LAT.match(b):
            word = re.search(r"[\u0590-\u05FF]+$", s[:i]).group()
            # a Hebrew prefix letter on an English word ("מProblemChat") is not a seam
            if len(word) >= 2 and not (re.fullmatch(r"[משהוכלב]{1,3}", word) and (i - len(word) == 0 or s[i - len(word) - 1] in " -")):
                seams.append(i)
    if len(seams) != 1:
        return s
    edge = r"^[\s\-–—|/\\:·,.?!_]+|[\s\-–—|/\\:·,_]+$"
    halves = [re.sub(edge, "", x).strip() for x in (s[:seams[0]], s[seams[0]:])]
    if not all(halves) or _is_he(halves[0]) == _is_he(halves[1]):
        return s
    return halves[0] if _is_he(halves[0]) else halves[1]

def short(s, n):
    s = re.sub(r"\s+", " ", s or "").strip()
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"

# ───────────────────────────── notifications ─────────────────────────────

def notify(cfg, title, message, url=None, priority=3, tags=None):
    if not cfg.get("ntfy_topic"):
        return False
    # JSON publishing keeps Hebrew and other non-Latin text intact
    payload = {"topic": cfg["ntfy_topic"], "title": title, "message": message, "priority": int(priority)}
    if tags: payload["tags"] = list(tags)
    click = url or cfg.get("public_url")
    if click: payload["click"] = click
    req = urllib.request.Request(cfg["ntfy_server"].rstrip("/") + "/", method="POST",
                                 data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                                 headers={"Content-Type": "application/json; charset=utf-8"})
    try:
        urllib.request.urlopen(req, timeout=20).read()
        q("INSERT INTO events(at,kind,text) VALUES(?,?,?)", (time.time(), "push", f"{title}: {message}"))
        return True
    except Exception as e:
        log("notification failed:", e)
        return False

def in_quiet_hours(cfg):
    a, b = cfg.get("quiet_hours") or [0, 0]
    h = datetime.now().hour
    return (a <= h < b) if a <= b else (h >= a or h < b)

# ───────────────────────────── summaries ─────────────────────────────

def pdf_text(path, limit=20000):
    try:
        import pypdf  # optional
    except ImportError:
        return None
    try:
        reader = pypdf.PdfReader(path)
        out = []
        for page in reader.pages[:30]:
            out.append(page.extract_text() or "")
            if sum(map(len, out)) > limit: break
        return "\n".join(out)[:limit]
    except Exception:
        return None

def claude_summary(cfg, title, course, text):
    key = cfg.get("anthropic_api_key")
    if not key or not text or len(text.strip()) < 80:
        return None
    body = json.dumps({
        "model": cfg.get("summary_model") or "claude-haiku-5-5",
        "max_tokens": 300,
        "messages": [{"role": "user", "content":
            f"This is course material titled '{title}' from the university course '{course}'. "
            "Summarize what it covers in 2-3 plain sentences for a student deciding what to study. "
            "If it's an assignment, say what is being asked. Reply in Hebrew, no preamble.\n\n" + text}],
    }).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, headers={
        "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            data = json.loads(r.read())
        return "".join(b.get("text", "") for b in data.get("content", [])).strip() or None
    except Exception as e:
        log("summary failed:", e)
        return None

def safe_name(s):
    return re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", s).strip() or "file"

def cached_file(item):
    d = item["data"]
    folder = os.path.join(FILES, safe_name(item["course"] or "misc"))
    return os.path.join(folder, f"{item['id']}-{safe_name(d.get('filename') or d['title'])}")

def fetch_file(cfg, item):
    path = cached_file(item)
    d = item["data"]
    if os.path.exists(path) and (not d.get("timemodified") or os.path.getmtime(path) >= d["timemodified"]):
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    r = Moodle(cfg["moodle_url"], cfg["token"]).download(d["fileurl"])
    tmp = path + ".part"
    with open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 16)
            if not chunk: break
            f.write(chunk)
    os.replace(tmp, path)
    return path

def summarize_item(cfg, item):
    d = item["data"]
    text = None
    if d.get("fileurl") and (d.get("filename", "").lower().endswith(".pdf") or "pdf" in d.get("mimetype", "")):
        if (d.get("filesize") or 0) > 40 * 1024 * 1024:
            return None
        text = pdf_text(fetch_file(cfg, item))
    elif d.get("description"):
        text = d["description"]
    s = claude_summary(cfg, d["title"], item["course"], text)
    if s:
        q("INSERT OR REPLACE INTO summaries(file_id,text,at) VALUES(?,?,?)", (item["id"], s, time.time()))
    return s

# ───────────────────────────── sync ─────────────────────────────

sync_state = {"running": False, "last": None, "error": None, "next": None}
_sync_lock = threading.Lock()

def collect(m):
    """Pull everything from Moodle into a dict of items keyed by id."""
    site = m.call("core_webservice_get_site_info")
    uid = site["userid"]
    now = time.time()
    courses = [c for c in m.call("core_enrol_get_users_courses", userid=uid)
               if c.get("visible", 1) and (not c.get("enddate") or c["enddate"] > now - 45 * 86400)]
    cmap = {c["id"]: c.get("fullname") or c.get("shortname") for c in courses}
    items = {}

    def add(id_, kind, cid, data):
        items[id_] = {"id": id_, "kind": kind, "course_id": cid, "course": cmap.get(cid, ""), "data": data}

    for c in courses:
        add(f"course-{c['id']}", "course", c["id"], {"title": cmap[c["id"]], "shortname": c.get("shortname"),
            "url": f"{m.base}/course/view.php?id={c['id']}", "progress": c.get("progress"),
            "about": short(html_to_text(c.get("summary") or ""), 3000)})

    # Course contents: sections, files, links, activities
    for cid in cmap:
        try:
            sections = m.call("core_course_get_contents", courseid=cid)
        except MoodleError as e:
            log(f"contents for course {cid} failed: {e}"); continue
        for si, sec in enumerate(sections):
            sname = sec.get("name") or f"יחידה {si}"
            for mod in sec.get("modules", []):
                if mod.get("visible") == 0 or mod.get("uservisible") is False:
                    continue
                mname = html.unescape(mod.get("name") or "")
                link = mod.get("url") or f"{m.base}/mod/{mod.get('modname')}/view.php?id={mod['id']}"
                base = {"section": sname, "section_index": si, "module": mod.get("modname"),
                        "cmid": mod["id"], "link": link}
                if mod.get("modname") == "label":
                    continue
                files = [f for f in (mod.get("contents") or []) if f.get("type") == "file"]
                if mod.get("modname") == "resource" and files:
                    f = files[0]
                    add(f"file-{mod['id']}", "file", cid, {**base, "title": mname, "filename": f.get("filename"),
                        "fileurl": f.get("fileurl"), "filesize": f.get("filesize"), "mimetype": f.get("mimetype", ""),
                        "timemodified": f.get("timemodified")})
                elif mod.get("modname") == "folder" and files:
                    for f in files:
                        fid = f"file-{mod['id']}-{hashlib.md5((f.get('filepath','')+f.get('filename','')).encode()).hexdigest()[:8]}"
                        add(fid, "file", cid, {**base, "title": f.get("filename"), "folder": mname,
                            "filename": f.get("filename"), "fileurl": f.get("fileurl"), "filesize": f.get("filesize"),
                            "mimetype": f.get("mimetype", ""), "timemodified": f.get("timemodified")})
                else:
                    add(f"mod-{mod['id']}", "material", cid, {**base, "title": mname,
                        "description": short(html_to_text(mod.get("description", "")), 600)})

    # Assignments with submission status
    try:
        res = m.call("mod_assign_get_assignments", courseids=list(cmap))
        for course in res.get("courses", []):
            for a in course.get("assignments", []):
                data = {"title": html.unescape(a["name"]), "due": a.get("duedate") or None,
                        "cutoff": a.get("cutoffdate") or None, "cmid": a.get("cmid"),
                        "link": f"{m.base}/mod/assign/view.php?id={a.get('cmid')}",
                        "description": short(html_to_text(a.get("intro", "")), 1500), "source": "Moodle",
                        "attachments": [{"name": f.get("filename"), "fileurl": f.get("fileurl")}
                                        for f in a.get("introattachments", []) or []]}
                try:
                    st = m.call("mod_assign_get_submission_status", assignid=a["id"])
                    sub = (st.get("lastattempt") or {}).get("submission") or \
                          (st.get("lastattempt") or {}).get("teamsubmission") or {}
                    data["submitted"] = sub.get("status") == "submitted"
                    fb = st.get("feedback") or {}
                    if fb.get("gradefordisplay"):
                        data["grade"] = html_to_text(fb["gradefordisplay"])
                except MoodleError:
                    data["submitted"] = None
                add(f"assign-{a['id']}", "task", course["id"], data)
    except MoodleError as e:
        log("assignments failed:", e)

    # Other deadlines (quizzes closing, etc.) from the timeline
    try:
        ev = m.call("core_calendar_get_action_events_by_timesort", timesortfrom=int(now - 7 * 86400), limitnum=50)
        known = {it["data"].get("cmid") for it in items.values() if it["kind"] == "task"}
        for e in ev.get("events", []):
            if e.get("instance") and e.get("modulename") == "assign":
                continue
            cmid = e.get("instance") and e.get("url") and re.search(r"id=(\d+)", e["url"] or "")
            cmid = int(cmid.group(1)) if cmid else None
            if cmid in known: continue
            cid = (e.get("course") or {}).get("id")
            add(f"event-{e['id']}", "task", cid, {"title": html.unescape(e.get("name", "")),
                "due": e.get("timesort"), "link": e.get("url"), "cmid": cmid,
                "source": "Moodle", "submitted": False if (e.get("action") or {}).get("actionable") else None,
                "description": short(html_to_text(e.get("description", "")), 800)})
    except MoodleError as e:
        log("timeline failed:", e)

    # The whole Moodle calendar: exam dates, course and site events, quiz windows, your own events
    try:
        cal = m.call("core_calendar_get_calendar_events", events={"courseids": list(cmap)},
                     options={"userevents": 1, "siteevents": 1, "timestart": int(now - 45 * 86400),
                              "timeend": int(now + 200 * 86400), "ignorehidden": 1})
        for e in cal.get("events", []):
            # deadlines are already tasks (from assignments or the timeline above)
            if f"event-{e['id']}" in items or (e.get("modulename") == "assign" and e.get("eventtype") == "due"):
                continue
            cid = e.get("courseid") if e.get("courseid") in cmap else None
            add(f"cal-{e['id']}", "calevent", cid, {"title": html.unescape(e.get("name", "")),
                "start": e.get("timestart"), "duration": e.get("timeduration") or 0,
                "type": e.get("eventtype"), "module": e.get("modulename") or None, "location": e.get("location") or "",
                "description": short(html_to_text(e.get("description", "")), 800),
                "link": e.get("url") or (f"{m.base}/calendar/view.php?view=day&time={e.get('timestart')}")})
    except MoodleError as e:
        log("calendar failed:", e)

    # Announcements (news forums) and other forum discussions
    try:
        forums = m.call("mod_forum_get_forums_by_courses", courseids=list(cmap))
        for fo in forums:
            if fo.get("type") not in ("news", "general", "blog"):
                continue
            try:
                d = m.call("mod_forum_get_forum_discussions", forumid=fo["id"], sortorder=-1, page=0, perpage=15)
                discs = d.get("discussions", [])
            except MoodleError:
                try:
                    discs = m.call("mod_forum_get_forum_discussions_paginated", forumid=fo["id"],
                                   sortdirection="DESC", page=0, perpage=15).get("discussions", [])
                except MoodleError:
                    continue
            for di in discs:
                did = di.get("discussion") or di.get("id")
                add(f"news-{did}", "news", fo["course"], {
                    "title": html.unescape(di.get("name") or di.get("subject") or ""),
                    "author": di.get("userfullname", ""), "time": di.get("created") or di.get("timemodified"),
                    "text": short(html_to_text(di.get("message", "")), 4000),
                    "forum": html.unescape(fo.get("name", "")), "announcement": fo.get("type") == "news",
                    "link": f"{m.base}/mod/forum/discuss.php?d={did}"})
    except MoodleError as e:
        log("forums failed:", e)

    # Grades
    try:
        ov = m.call("gradereport_overview_get_course_grades", userid=uid)
        for g in ov.get("grades", []):
            if g.get("courseid") in cmap and g.get("grade") not in (None, "", "-"):
                add(f"cgrade-{g['courseid']}", "coursegrade", g["courseid"], {"title": "ציון סופי",
                    "grade": g.get("grade")})
    except MoodleError:
        pass
    for cid in cmap:
        try:
            gi = m.call("gradereport_user_get_grade_items", courseid=cid, userid=uid)
            for ug in gi.get("usergrades", []):
                for it in ug.get("gradeitems", []):
                    if it.get("itemtype") == "course" or not it.get("gradeformatted") or it["gradeformatted"] in ("-", ""):
                        continue
                    add(f"grade-{it['id']}", "grade", cid, {"title": html.unescape(it.get("itemname") or ""),
                        "grade": html_to_text(it.get("gradeformatted")), "range": html_to_text(it.get("rangeformatted") or ""),
                        "percent": html_to_text(it.get("percentageformatted") or ""),
                        "feedback": short(html_to_text(it.get("feedback") or ""), 600),
                        "time": it.get("gradedategraded")})
        except MoodleError:
            pass

    return site, items

HE_DAYS = ["שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת", "ראשון"]

def fmt_due(ts):
    if not ts: return "ללא תאריך"
    d = datetime.fromtimestamp(ts)
    return f"יום {HE_DAYS[d.weekday()]} {d.day}.{d.month} בשעה {d:%H:%M}"

def sync(cfg, reason="scheduled"):
    if not cfg.get("token"):
        return
    if not _sync_lock.acquire(blocking=False):
        return
    sync_state["running"] = True
    started = time.time()
    try:
        m = Moodle(cfg["moodle_url"], cfg["token"])
        site, items = collect(m)
        meta_set("site", {"name": site.get("sitename"), "user": site.get("fullname"),
                          "userpicture": site.get("userpictureurl")})
        first = not meta_get("synced_once", False)
        now = time.time()
        old = {r["id"]: dict(r) for r in q("SELECT * FROM items WHERE id NOT LIKE 'manual-%'")}
        changes = []
        with _db_lock:
            for it in items.values():
                o = old.get(it["id"])
                data = json.dumps(it["data"], ensure_ascii=False)
                if o is None:
                    con().execute("INSERT INTO items(id,kind,course_id,course,data,first_seen,updated,gone) "
                                  "VALUES(?,?,?,?,?,?,?,0)",
                                  (it["id"], it["kind"], it["course_id"], it["course"], data, now, now))
                    if not first: changes.append(("new", it, None))
                else:
                    od = json.loads(o["data"])
                    if o["data"] != data or o["gone"]:
                        con().execute("UPDATE items SET kind=?,course_id=?,course=?,data=?,updated=?,gone=0 WHERE id=?",
                                      (it["kind"], it["course_id"], it["course"], data, now, it["id"]))
                        if it["kind"] == "task" and od.get("due") != it["data"].get("due"):
                            changes.append(("due", it, od.get("due")))
                            con().execute("DELETE FROM reminders WHERE task_id=?", (it["id"],))
                        if it["kind"] == "calevent" and od.get("start") != it["data"].get("start"):
                            changes.append(("moved", it, od.get("start")))
                        if it["kind"] in ("grade",) and od.get("grade") != it["data"].get("grade"):
                            changes.append(("grade", it, od.get("grade")))
            gone = [i for i in old if i not in items and not old[i]["gone"]]
            for i in gone:
                con().execute("UPDATE items SET gone=1 WHERE id=?", (i,))
            con().commit()
        meta_set("synced_once", True)

        if first:
            n_tasks = sum(1 for i in items.values() if i["kind"] == "task")
            n_files = sum(1 for i in items.values() if i["kind"] == "file")
            notify(cfg, "Moodle Hub מחובר",
                   f"סונכרנו {len([i for i in items.values() if i['kind']=='course'])} קורסים, "
                   f"{n_tasks} מטלות ו-{n_files} קבצים. תקבלו התראה כשמשהו חדש יעלה.",
                   tags=["white_check_mark"])
        else:
            send_change_notifications(cfg, changes)
            # Summaries for newly posted material
            for kind, it, _ in changes:
                if kind == "new" and it["kind"] in ("file", "task"):
                    try: summarize_item(cfg, it)
                    except Exception as e: log("auto-summary failed:", e)
        send_reminders(cfg)
        sync_state.update(last=now, error=None)
        meta_set("last_sync", now)
        meta_set("last_error", None)
        log(f"sync ok ({reason}) in {time.time()-started:.1f}s: {len(items)} items, {len(changes)} changes")
    except MoodleError as e:
        msg = str(e)
        if e.code in ("invalidtoken", "accessexception") or "token" in msg.lower():
            msg = "ההתחברות למודל פגה. פתחו את ה-Hub במחשב והתחברו מחדש למודל (בהגדרות)."
            if meta_get("token_alert_sent") != cfg["token"]:
                notify(cfg, "Moodle Hub צריך אותך", msg, priority=4, tags=["warning"])
                meta_set("token_alert_sent", cfg["token"])
        sync_state["error"] = msg
        meta_set("last_error", msg)
        log("sync failed:", msg)
    except Exception as e:
        sync_state["error"] = f"שגיאה לא צפויה: {e}"
        meta_set("last_error", sync_state["error"])
        traceback.print_exc()
    finally:
        sync_state["running"] = False
        _sync_lock.release()

def send_change_notifications(cfg, changes):
    lines = []
    urgent = False
    for kind, it, prev in changes:
        d, c = it["data"], short(heb(it["course"]), 28)
        if kind == "new" and it["kind"] == "task":
            lines.append(f"📝 מטלה חדשה ב{c}: {heb(d['title'])} — להגשה {fmt_due(d.get('due'))}")
            urgent = True
        elif kind == "due":
            lines.append(f"📅 מועד ההגשה השתנה ({c}): {heb(d['title'])} — עכשיו {fmt_due(d.get('due'))}")
            urgent = True
        elif kind == "new" and it["kind"] == "news":
            lines.append(f"📣 {c}: {heb(d['title'])} — {short(d.get('text'), 110)}")
        elif kind == "new" and it["kind"] == "calevent" and (d.get("start") or 0) > time.time():
            lines.append(f"🗓️ חדש בלוח השנה{f' ({c})' if c else ''}: {heb(d['title'])} — {fmt_due(d.get('start'))}")
        elif kind == "moved":
            lines.append(f"🗓️ התאריך השתנה{f' ({c})' if c else ''}: {heb(d['title'])} — עכשיו {fmt_due(d.get('start'))}")
            urgent = True
        elif kind == "new" and it["kind"] in ("file", "material"):
            lines.append(f"📄 חדש ב{c}: {heb(d['title'])}")
        elif kind in ("grade",) or (kind == "new" and it["kind"] == "grade"):
            lines.append(f"🎓 פורסם ציון ({c}): {heb(d['title'])} — {d.get('grade')}")
            urgent = True
    if not lines:
        return
    for l in lines:
        q("INSERT INTO events(at,kind,text) VALUES(?,?,?)", (time.time(), "change", l))
    if in_quiet_hours(cfg) and not urgent:
        pending = meta_get("pending_push", []) + lines
        meta_set("pending_push", pending[-30:])
        return
    lines = meta_get("pending_push", []) + lines
    meta_set("pending_push", [])
    title = "עדכון ממודל" if len(lines) == 1 else f"{len(lines)} עדכונים ממודל"
    body = "\n".join(lines[:8]) + (f"\nועוד {len(lines)-8}" if len(lines) > 8 else "")
    notify(cfg, title, body, priority=4 if urgent else 3, tags=["books"])

def send_reminders(cfg):
    now = time.time()
    done = {r["task_id"] for r in q("SELECT task_id FROM done")}
    for r in q("SELECT * FROM items WHERE kind='task' AND gone=0"):
        d = json.loads(r["data"])
        due = d.get("due")
        if not due or d.get("submitted") or r["id"] in done:
            continue
        left = due - now
        if left <= 0 or left > 24 * 3600:
            continue
        win = "3h" if left <= 3 * 3600 else "24h"
        if q("SELECT 1 FROM reminders WHERE task_id=? AND win=?", (r["id"], win), one=True):
            continue
        q("INSERT OR IGNORE INTO reminders(task_id,win) VALUES(?,?)", (r["id"], win))
        if win == "3h":  # inside 3h the 24h reminder is no longer useful
            q("INSERT OR IGNORE INTO reminders(task_id,win) VALUES(?,?)", (r["id"], "24h"))
        hrs = int(left // 3600)
        when = f"בעוד {hrs} שעות" if hrs >= 1 else f"בעוד {int(left//60)} דקות"
        notify(cfg, f"להגשה {when}: {heb(d['title'])}",
               f"{heb(r['course'])} · {fmt_due(due)}" + ("" if d.get("source") != "Moodle" else " · עדיין לא הוגש"),
               url=d.get("link"), priority=5 if win == "3h" else 4, tags=["alarm_clock"])

def sync_loop():
    while True:
        cfg = load_config()
        if cfg.get("token"):
            sync(cfg)
        mins = max(5, int(cfg.get("sync_minutes") or 15))
        sync_state["next"] = time.time() + mins * 60
        # wake early if someone asks for a sync
        for _ in range(mins * 60):
            if _wake.is_set():
                _wake.clear(); break
            time.sleep(1)

_wake = threading.Event()

# ───────────────────────────── API state ─────────────────────────────

def state():
    cfg = load_config()
    done = {r["task_id"]: r["at"] for r in q("SELECT * FROM done")}
    sums = {r["file_id"]: r["text"] for r in q("SELECT * FROM summaries")}
    rows = q("SELECT * FROM items WHERE gone=0")
    out = {"tasks": [], "courses": {}, "news": [], "grades": {}, "events": [], "calendar": []}
    for r in rows:
        d = json.loads(r["data"])
        base = {"id": r["id"], "course": r["course"], "course_id": r["course_id"], "first_seen": r["first_seen"], **d}
        if r["id"] in sums: base["summary"] = sums[r["id"]]
        k = r["kind"]
        if k == "course":
            out["courses"].setdefault(str(r["course_id"]), {"materials": []}).update(
                {"id": r["course_id"], "title": d["title"], "url": d["url"], "about": d.get("about", "")})
        elif k == "task":
            base.pop("fileurl", None)
            base["done"] = r["id"] in done
            out["tasks"].append(base)
        elif k in ("file", "material"):
            base.pop("fileurl", None)
            base["kind"] = k
            out["courses"].setdefault(str(r["course_id"]), {"materials": []})["materials"].append(base)
        elif k == "news":
            out["news"].append(base)
        elif k == "calevent":
            out["calendar"].append(base)
        elif k in ("grade", "coursegrade"):
            g = out["grades"].setdefault(str(r["course_id"]), {"course": r["course"], "items": [], "total": None})
            if k == "coursegrade": g["total"] = d["grade"]
            else: g["items"].append(base)
    for t in out["tasks"]:
        for a in t.get("attachments", []):
            a.pop("fileurl", None)
    out["tasks"].sort(key=lambda t: (t.get("due") is None, t.get("due") or 0))
    out["news"].sort(key=lambda n: -(n.get("time") or 0))
    for c in out["courses"].values():
        c["materials"].sort(key=lambda m: (m.get("section_index", 0), m["id"]))
    out["events"] = [dict(e) for e in q("SELECT at,kind,text FROM events ORDER BY id DESC LIMIT 40")]
    out["meta"] = {"last_sync": meta_get("last_sync"), "error": meta_get("last_error"),
                   "running": sync_state["running"], "next": sync_state["next"],
                   "site": meta_get("site"), "moodle_url": cfg["moodle_url"],
                   "can_summarize": bool(cfg.get("anthropic_api_key")), "now": time.time()}
    return out

def _private(ip):
    p = [int(x) for x in ip.split(".")]
    return p[0] == 10 or (p[0] == 192 and p[1] == 168) or (p[0] == 172 and 16 <= p[1] <= 31)

def _vpn(ip):
    # 100.64.0.0/10 is used by VPNs and tunnels (Tailscale, Zscaler, carrier networks), never by a home Wi-Fi router
    p = [int(x) for x in ip.split(".")]
    return p[0] == 100 and 64 <= p[1] <= 127

_lan_cache = {"at": 0.0, "ips": None}

def lan_ips():
    """Addresses a phone on the same Wi-Fi can use. Looking them up can take seconds on a Mac, so answer from
    the last lookup and refresh it in the background once it's a minute old."""
    c = _lan_cache
    if c["ips"] is None:
        c["ips"], c["at"] = _find_lan_ips(), time.time()
    elif time.time() - c["at"] > 60:
        c["at"] = time.time()
        threading.Thread(target=lambda: c.update(ips=_find_lan_ips()), daemon=True).start()
    return c["ips"]

def _find_lan_ips():
    """Wi-Fi/Ethernet first; VPN addresses left out."""
    import subprocess
    found = []
    if sys.platform == "darwin":
        # Every Wi-Fi/Ethernet adapter (en0, en1, ... a dock or USB adapter can be en7 or higher); VPN adapters are utun*
        try:
            out = subprocess.run(["/sbin/ifconfig"], capture_output=True, text=True, timeout=3).stdout
            for block in re.split(r"\n(?=\S)", out):
                if re.match(r"en\d+:", block) and "status: active" in block:
                    found += re.findall(r"\binet (\d+\.\d+\.\d+\.\d+)", block)
        except Exception:
            pass
    elif sys.platform.startswith("linux"):
        try:
            out = subprocess.run(["hostname", "-I"], capture_output=True, text=True, timeout=3).stdout.split()
            found += [ip for ip in out if ":" not in ip]
        except Exception:
            pass
    if not found:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("10.255.255.255", 1)); found.append(s.getsockname()[0]); s.close()
        except OSError:
            pass
        try:
            for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
                found.append(info[4][0])
        except OSError:
            pass
    seen, out = set(), []
    for ip in found:
        if ip in seen or ip.startswith("127.") or ip.startswith("169.254.") or _vpn(ip):
            continue
        seen.add(ip); out.append(ip)
    # Home-network addresses first
    out.sort(key=lambda ip: (not _private(ip),))
    return out

# ───────────────────────────── HTTP server ─────────────────────────────

def is_local(addr):
    return addr in ("127.0.0.1", "::1", "::ffff:127.0.0.1")

class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "MoodleHub/" + VERSION

    def log_message(self, fmt, *args):
        pass

    # helpers
    def send_json(self, obj, code=200, headers=None):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items(): self.send_header(k, v)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 1_000_000: raise ValueError("too large")
        raw = self.rfile.read(n) if n else b"{}"
        return json.loads(raw or b"{}")

    def session_ok(self):
        cfg = load_config()
        if not cfg.get("passcode_hash"):
            return is_local(self.client_address[0])
        ck = self.headers.get("Cookie", "")
        m = re.search(r"hub_session=([A-Za-z0-9_-]+)", ck)
        return bool(m and q("SELECT 1 FROM sessions WHERE token=?", (m.group(1),), one=True))

    def static(self, rel):
        path = os.path.normpath(os.path.join(STATIC, rel))
        if not path.startswith(STATIC) or not os.path.isfile(path):
            return self.send_error(404)
        with open(path, "rb") as f: b = f.read()
        self.send_response(200)
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)

    # routes
    def do_GET(self):
        p = urllib.parse.urlparse(self.path)
        path = p.path
        if path in ("/", "/index.html"):
            return self.static("index.html")
        if path.startswith("/static/"):
            return self.static(path[len("/static/"):])
        if path in ("/manifest.json", "/sw.js", "/icon.svg"):
            return self.static(path[1:])
        if path == "/api/status":
            cfg = load_config()
            return self.send_json({"configured": bool(cfg.get("token")), "has_passcode": bool(cfg.get("passcode_hash")),
                                   "authed": self.session_ok(), "local": is_local(self.client_address[0])})
        if not self.session_ok():
            return self.send_json({"error": "login"}, 401)
        if path == "/api/state":
            return self.send_json(state())
        if path == "/api/settings":
            cfg = load_config()
            return self.send_json({k: cfg[k] for k in ("moodle_url", "ntfy_server", "ntfy_topic", "sync_minutes",
                                   "quiet_hours", "public_url", "summary_model")} |
                                  {"has_token": bool(cfg["token"]), "has_api_key": bool(cfg["anthropic_api_key"]),
                                   "launch_url": launch_url(cfg["moodle_url"]), "lan": lan_ips(), "port": cfg["port"],
                                   "local": is_local(self.client_address[0])})
        m = re.fullmatch(r"/api/file/([\w.-]+)", path)
        if m:
            return self.serve_file(m.group(1), urllib.parse.parse_qs(p.query).get("dl") == ["1"])
        self.send_error(404)

    def serve_file(self, item_id, download):
        cfg = load_config()
        r = q("SELECT * FROM items WHERE id=?", (item_id,), one=True)
        if not r or r["kind"] != "file":
            return self.send_error(404)
        item = {"id": r["id"], "course": r["course"], "data": json.loads(r["data"])}
        try:
            path = fetch_file(cfg, item)
        except Exception as e:
            return self.send_json({"error": f"ההורדה ממודל נכשלה: {e}"}, 502)
        name = item["data"].get("filename") or "file"
        ctype = item["data"].get("mimetype") or mimetypes.guess_type(name)[0] or "application/octet-stream"
        size = os.path.getsize(path)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        disp = "attachment" if download else "inline"
        self.send_header("Content-Disposition", f"{disp}; filename*=UTF-8''{urllib.parse.quote(name)}")
        self.end_headers()
        with open(path, "rb") as f:
            while True:
                chunk = f.read(1 << 16)
                if not chunk: break
                self.wfile.write(chunk)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            data = self.body()
        except Exception:
            return self.send_json({"error": "bad request"}, 400)
        cfg = load_config()

        if path == "/api/login":
            if not cfg.get("passcode_hash"):
                return self.send_json({"error": "סיימו קודם את ההגדרה במחשב."}, 400)
            time.sleep(0.4)
            if hash_pass(str(data.get("passcode", "")), cfg["passcode_salt"]) != cfg["passcode_hash"]:
                return self.send_json({"error": "קוד גישה שגוי."}, 403)
            tok = secrets.token_urlsafe(32)
            q("INSERT INTO sessions(token,created,label) VALUES(?,?,?)",
              (tok, time.time(), self.headers.get("User-Agent", "")[:120]))
            return self.send_json({"ok": True}, headers={
                "Set-Cookie": f"hub_session={tok}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax"})

        # Setup & settings changes: only from this computer, or from a signed-in device
        if not self.session_ok():
            return self.send_json({"error": "login"}, 401)

        if path == "/api/setup":
            local = is_local(self.client_address[0])
            if not cfg.get("passcode_hash") and not data.get("passcode"):
                # without a passcode only this computer can get in, so the phone would be locked out
                return self.send_json({"error": "בחרו קוד גישה (לפחות 4 תווים), כדי שהטלפון יוכל להתחבר."}, 400)
            if "token" in data and data["token"]:
                try:
                    tok = parse_token(data["token"])
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
                url = (data.get("moodle_url") or cfg["moodle_url"]).strip().rstrip("/")
                try:
                    site = Moodle(url, tok).call("core_webservice_get_site_info")
                except MoodleError as e:
                    return self.send_json({"error": f"מודל לא קיבל את ההתחברות: {e}"}, 400)
                cfg["token"], cfg["moodle_url"] = tok, url
                meta_set("site", {"name": site.get("sitename"), "user": site.get("fullname")})
            if data.get("passcode"):
                if len(str(data["passcode"])) < 4:
                    return self.send_json({"error": "קוד הגישה צריך להיות לפחות 4 תווים."}, 400)
                if cfg.get("passcode_hash") and not local:
                    return self.send_json({"error": "אפשר לשנות את קוד הגישה רק מהמחשב שמריץ את ה-Hub."}, 403)
                cfg["passcode_salt"] = secrets.token_hex(8)
                cfg["passcode_hash"] = hash_pass(str(data["passcode"]), cfg["passcode_salt"])
                q("DELETE FROM sessions")
            for k in ("ntfy_server", "ntfy_topic", "public_url", "summary_model"):
                if isinstance(data.get(k), str) and data[k].strip():
                    cfg[k] = data[k].strip()
            if "public_url" in data and not str(data.get("public_url")).strip():
                cfg["public_url"] = ""
            if data.get("anthropic_api_key") is not None:
                cfg["anthropic_api_key"] = str(data["anthropic_api_key"]).strip()
            if data.get("sync_minutes"):
                cfg["sync_minutes"] = max(5, min(240, int(data["sync_minutes"])))
            if isinstance(data.get("quiet_hours"), list) and len(data["quiet_hours"]) == 2:
                cfg["quiet_hours"] = [int(x) % 24 for x in data["quiet_hours"]]
            save_config(cfg)
            headers = {}
            if data.get("passcode"):
                tok = secrets.token_urlsafe(32)
                q("INSERT INTO sessions(token,created,label) VALUES(?,?,?)", (tok, time.time(), "this computer"))
                headers["Set-Cookie"] = f"hub_session={tok}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax"
            if data.get("token"):
                _wake.set()
            return self.send_json({"ok": True}, headers=headers)

        if path == "/api/sync":
            _wake.set()   # the background loop picks this up within a second
            return self.send_json({"ok": True})

        if path == "/api/test-notify":
            ok = notify(cfg, "בדיקה מ-Moodle Hub", "ההתראות עובדות. כאן יגיעו מטלות חדשות, שינויים במועדי הגשה, הודעות ותזכורות.", tags=["tada"])
            return self.send_json({"ok": ok} if ok else {"error": "שירות ההתראות לא זמין."}, 200 if ok else 502)

        if path == "/api/task":
            title = short(str(data.get("title", "")), 200)
            if not title:
                return self.send_json({"error": "תנו למטלה שם."}, 400)
            due = data.get("due")
            due = int(due) if due else None
            tid = data.get("id") if str(data.get("id", "")).startswith("manual-") else "manual-" + secrets.token_hex(5)
            course = short(str(data.get("course", "")), 120)
            row = q("SELECT course_id FROM items WHERE kind='course' AND course=?", (course,), one=True)
            payload = {"title": title, "due": due, "source": "Added by you", "link": data.get("link") or None,
                       "description": short(str(data.get("notes", "")), 1500), "submitted": None}
            q("INSERT OR REPLACE INTO items(id,kind,course_id,course,data,first_seen,updated,gone) VALUES(?,?,?,?,?,?,?,0)",
              (tid, "task", row["course_id"] if row else None, course, json.dumps(payload, ensure_ascii=False),
               time.time(), time.time()))
            q("DELETE FROM reminders WHERE task_id=?", (tid,))
            return self.send_json({"ok": True, "id": tid})

        m = re.fullmatch(r"/api/task/([\w.-]+)/(done|undone|delete)", path)
        if m:
            tid, act = m.groups()
            if act == "done": q("INSERT OR REPLACE INTO done(task_id,at) VALUES(?,?)", (tid, time.time()))
            elif act == "undone": q("DELETE FROM done WHERE task_id=?", (tid,))
            elif act == "delete" and tid.startswith("manual-"): q("DELETE FROM items WHERE id=?", (tid,))
            return self.send_json({"ok": True})

        m = re.fullmatch(r"/api/summarize/([\w.-]+)", path)
        if m:
            if not cfg.get("anthropic_api_key"):
                return self.send_json({"error": "כדי לקבל תקצירים, הוסיפו מפתח API של Anthropic בהגדרות."}, 400)
            r = q("SELECT * FROM items WHERE id=?", (m.group(1),), one=True)
            if not r: return self.send_json({"error": "not found"}, 404)
            item = {"id": r["id"], "course": r["course"], "data": json.loads(r["data"])}
            try:
                s = summarize_item(cfg, item)
            except Exception as e:
                return self.send_json({"error": f"יצירת התקציר נכשלה: {e}"}, 502)
            if not s:
                hint = "" if _has_pypdf() else " (צריך להתקין: pip install pypdf)"
                return self.send_json({"error": "לא הצלחתי לקרוא מספיק טקסט מהקובץ" + hint}, 422)
            return self.send_json({"ok": True, "summary": s})

        if path == "/api/logout":
            ck = self.headers.get("Cookie", "")
            mm = re.search(r"hub_session=([A-Za-z0-9_-]+)", ck)
            if mm: q("DELETE FROM sessions WHERE token=?", (mm.group(1),))
            return self.send_json({"ok": True}, headers={"Set-Cookie": "hub_session=; Path=/; Max-Age=0"})

        self.send_error(404)

def _has_pypdf():
    try:
        import pypdf  # noqa
        return True
    except ImportError:
        return False

class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

def hub_already_running(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/status", timeout=3) as r:
            return r.headers.get("Server", "").startswith("MoodleHub") or "configured" in json.loads(r.read())
    except Exception:
        return False

def main():
    for stream in (sys.stdout, sys.stderr):
        try: stream.reconfigure(errors="replace")
        except Exception: pass
    cfg = load_config()
    con()
    port = int(os.environ.get("HUB_PORT") or cfg.get("port") or 8765)
    srv = None
    for candidate in range(port, port + 20):
        try:
            srv = Server(("0.0.0.0", candidate), Handler)
            break
        except OSError:
            if hub_already_running(candidate):
                print(f"\n  Moodle Hub is already running at http://localhost:{candidate}")
                print("  Nothing to do: you can close this window.\n")
                return
            print(f"  Port {candidate} is used by another app, trying {candidate + 1}…")
    if srv is None:
        print(f"\n  Couldn't find a free port between {port} and {port + 19}. "
              "Set a different \"port\" in data/config.json and try again.\n")
        sys.exit(1)
    if candidate != cfg.get("port"):
        cfg["port"] = candidate   # keep the same address from now on
        save_config(cfg)
    port = candidate
    threading.Thread(target=sync_loop, daemon=True).start()
    print()
    print("  Moodle Hub is running.")
    print(f"  On this computer:  http://localhost:{port}")
    for ip in lan_ips():
        print(f"  On your phone (same Wi-Fi):  http://{ip}:{port}")
    if not cfg.get("token"):
        print("\n  First time? Open http://localhost:%d on this computer to connect Moodle." % port)
    print("  Leave this window open. Press Ctrl+C to stop.\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")

if __name__ == "__main__":
    main()
