"""
E2E test suite for sw-nemotron-asr
Covers: settings CRUD, REST transcribe, WebSocket transcribe, sessions API
"""
import sys, json, asyncio, pathlib, urllib.request, urllib.error

BASE = "http://localhost:3007"
TEST_WAV = pathlib.Path("data/speakers/testuser_temp.wav")
SESSION_WAV = pathlib.Path("data/sessions/2026-07-06T12-34-09_16aa4633-8798-429a-a4c6-7e5064abb3d1/audio.wav")

PASS = "\033[32mPASS\033[0m"
FAIL = "\033[31mFAIL\033[0m"
results = []

def check(name, condition, detail=""):
    status = PASS if condition else FAIL
    print(f"  [{status}] {name}" + (f"  ({detail})" if detail else ""))
    results.append((name, condition))
    return condition

COOKIE = ""  # set by login() when auth is enabled

def _headers(extra=None):
    h = dict(extra or {})
    if COOKIE:
        h["Cookie"] = COOKIE
    return h

def get(path, cookie=None):
    req = urllib.request.Request(f"{BASE}{path}",
        headers={"Cookie": cookie} if cookie else _headers())
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())

def post_json(path, body, cookie=None):
    data = json.dumps(body).encode()
    h = {"Cookie": cookie} if cookie else _headers()
    h["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{BASE}{path}", data=data, headers=h, method="POST")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())

def post_multipart(path, field, filepath):
    import urllib.request, uuid
    boundary = uuid.uuid4().hex
    wav = filepath.read_bytes()
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"audio.wav\"\r\n"
        f"Content-Type: audio/wav\r\n\r\n"
    ).encode() + wav + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"{BASE}{path}", data=body,
        headers=_headers({"Content-Type": f"multipart/form-data; boundary={boundary}"}), method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())

def status_of(fn):
    try:
        fn()
        return 200
    except urllib.error.HTTPError as e:
        return e.code

def login(username, password):
    """Returns (status, cookie_header_value_or_empty)."""
    data = json.dumps({"username": username, "password": password}).encode()
    req = urllib.request.Request(f"{BASE}/api/login", data=data,
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            set_cookie = r.headers.get("Set-Cookie", "")
            return r.status, set_cookie.split(";")[0] if set_cookie else ""
    except urllib.error.HTTPError as e:
        return e.code, ""

# ── 0. Auth ───────────────────────────────────────────────────────────────────
print("\n=== 0. Auth ===")
auth_enabled = status_of(lambda: get("/api/settings", cookie="none")) == 401
if auth_enabled:
    check("Unauthenticated /api/settings returns 401", True)
    st, _ = login("admin", "wrong-password")
    check("Bad password rejected (401)", st == 401, str(st))
    st, clinician_cookie = login("sarah", "nuh-demo-poc")
    check("Clinician login succeeds", st == 200 and clinician_cookie, str(st))
    st, admin_cookie = login("admin", "nuh-admin-poc")
    check("Admin login succeeds", st == 200 and admin_cookie, str(st))
    check("Clinician can read settings",
          status_of(lambda: get("/api/settings", cookie=clinician_cookie)) == 200)
    check("Clinician cannot write settings (403)",
          status_of(lambda: post_json("/api/settings", {}, cookie=clinician_cookie)) == 403)
    check("Admin can write settings",
          status_of(lambda: post_json("/api/settings", {}, cookie=admin_cookie)) == 200)
    COOKIE = admin_cookie  # rest of the suite runs as admin
else:
    print("  [SKIP] auth_enabled=false — skipping auth checks")

# ── 1. Settings ───────────────────────────────────────────────────────────────
print("\n=== 1. Settings ===")
s = get("/api/settings")
check("GET /api/settings returns core fields",
      all(k in s for k in ["curated_audio_folder","min_enrollment_samples",
                            "max_enrollment_samples","nemotron_api_key",
                            "source_language","target_language"]),
      str(list(s.keys())))
check("GET /api/settings returns conversation-mode fields",
      all(k in s for k in ["patient_language","conversation_mode","tts_enabled",
                            "privacy_mode","whisper_model","whisper_device",
                            "use_speaker_direction"]),
      str([k for k in ["patient_language","conversation_mode","tts_enabled",
                        "privacy_mode","whisper_model","whisper_device",
                        "use_speaker_direction"] if k not in s]))
PRIVACY_MODE = bool(s.get("privacy_mode", False))
check("nemotron_api_key is masked (empty or ****)",
      s["nemotron_api_key"] in ("", "****"),
      repr(s["nemotron_api_key"]))
check("source_language default is 'auto'", s["source_language"] == "auto", s["source_language"])
check("target_language default is 'en'", s["target_language"] == "en", s["target_language"])

# Patch language settings
s2 = post_json("/api/settings", {"source_language": "zh", "target_language": "ms"})
check("POST /api/settings updates source_language", s2["source_language"] == "zh", s2.get("source_language"))
check("POST /api/settings updates target_language", s2["target_language"] == "ms", s2.get("target_language"))

# Set API key, verify it's masked on GET
post_json("/api/settings", {"nemotron_api_key": "nvapi-test-e2e-key"})
s3 = get("/api/settings")
check("API key set then GET returns ****", s3["nemotron_api_key"] == "****", repr(s3["nemotron_api_key"]))

# POST empty key should NOT clear stored key
post_json("/api/settings", {})
s4 = get("/api/settings")
check("POST without nemotron_api_key does not clear key", s4["nemotron_api_key"] == "****", repr(s4["nemotron_api_key"]))

# Conversation-mode settings round-trip
s5 = post_json("/api/settings", {"patient_language": "ta", "conversation_mode": True})
check("POST updates patient_language", s5.get("patient_language") == "ta", s5.get("patient_language"))
s6 = post_json("/api/settings", {"patient_language": "xx"})
check("Invalid patient_language rejected", s6.get("patient_language") == "ta", s6.get("patient_language"))
post_json("/api/settings", {"patient_language": "ms"})

# Restore defaults
post_json("/api/settings", {"source_language": "auto", "target_language": "en", "nemotron_api_key": ""})

# ── 2. REST /api/transcribe ───────────────────────────────────────────────────
print("\n=== 2. REST /api/transcribe ===")
wav = SESSION_WAV if SESSION_WAV.exists() else TEST_WAV
print(f"  Using: {wav}")
sessions_dir = pathlib.Path("data/sessions")
dirs_before = {p.name for p in sessions_dir.iterdir() if p.is_dir()} if sessions_dir.exists() else set()
try:
    r = post_multipart("/api/transcribe", "audio", wav)
    check("Response has session_id", "session_id" in r, r.get("session_id","missing"))
    check("Response has transcript field", "transcript" in r)
    check("Response has detected_lang", "detected_lang" in r, r.get("detected_lang"))
    check("Response has translation field", "translation" in r)
    check("Response has speaker_id", "speaker_id" in r, r.get("speaker_id"))
    check("Response has confidence", "confidence" in r, str(r.get("confidence")))
    check("session_id not empty", bool(r.get("session_id")))
    check("Response has direction field", "direction" in r, r.get("direction"))
    check("Response has target_lang field", "target_lang" in r, r.get("target_lang"))
    check("Response has tts field", "tts" in r, str(r.get("tts")))
    if PRIVACY_MODE:
        dirs_after = {p.name for p in sessions_dir.iterdir() if p.is_dir()} if sessions_dir.exists() else set()
        check("Privacy mode: no new session dir persisted", dirs_after == dirs_before,
              f"{len(dirs_after - dirs_before)} new")
        leftovers = list(sessions_dir.glob("rest_*.wav")) if sessions_dir.exists() else []
        check("Privacy mode: temp REST wav deleted", not leftovers, str(leftovers[:2]))
    print(f"  transcript: {repr(r.get('transcript',''))}")
    print(f"  detected_lang: {r.get('detected_lang')}  direction: {r.get('direction')}")
    print(f"  speaker_id: {r.get('speaker_id')}  confidence: {r.get('confidence')}")
except Exception as e:
    check("REST transcribe request succeeded", False, str(e))

# ── 3. WebSocket /ws/transcribe ───────────────────────────────────────────────
print("\n=== 3. WebSocket /ws/transcribe ===")
async def ws_test():
    try:
        import websockets
    except ImportError:
        print("  [SKIP] websockets package not installed — skipping WS test")
        return None
    wav_bytes = wav.read_bytes()
    try:
        async with websockets.connect("ws://localhost:3007/ws/transcribe",
                                      additional_headers=_headers()) as websocket:
            await websocket.send(wav_bytes)
            resp = await asyncio.wait_for(websocket.recv(), timeout=60)
            return json.loads(resp)
    except Exception as e:
        return {"error": str(e)}

ws_result = asyncio.run(ws_test())
if ws_result is None:
    pass  # skipped
elif "error" in ws_result:
    check("WebSocket frame received", False, ws_result["error"])
else:
    check("WS response has status:ok", ws_result.get("status") == "ok", ws_result.get("status"))
    check("WS response has transcript", "transcript" in ws_result)
    check("WS response has detected_lang", "detected_lang" in ws_result, ws_result.get("detected_lang"))
    check("WS response has speaker_id", "speaker_id" in ws_result, ws_result.get("speaker_id"))
    check("WS response has confidence", "confidence" in ws_result)
    print(f"  transcript: {repr(ws_result.get('transcript',''))}")

# ── 3b. Conversation mode over WS (config frame + direction routing) ─────────
print("\n=== 3b. WS conversation mode ===")
async def ws_convo_test():
    try:
        import websockets
    except ImportError:
        print("  [SKIP] websockets package not installed — skipping")
        return None
    # Unauthenticated WS upgrade must be refused when auth is on
    if auth_enabled:
        try:
            async with websockets.connect("ws://localhost:3007/ws/transcribe"):
                check("WS refuses connection without cookie", False, "connected!")
        except Exception:
            check("WS refuses connection without cookie", True)
    try:
        async with websockets.connect("ws://localhost:3007/ws/transcribe",
                                      additional_headers=_headers()) as w:
            await w.send(json.dumps({"type": "config", "conversation": True,
                                     "patient_lang": "ms", "direction": "auto"}))
            ack = json.loads(await asyncio.wait_for(w.recv(), timeout=10))
            await w.send(wav.read_bytes())
            resp = json.loads(await asyncio.wait_for(w.recv(), timeout=120))
            return ack, resp
    except Exception as e:
        return {"error": str(e)}, None

convo = asyncio.run(ws_convo_test())
if convo is None:
    pass  # skipped
elif isinstance(convo[0], dict) and "error" in convo[0]:
    check("WS conversation round-trip", False, convo[0]["error"])
else:
    ack, resp = convo
    check("Config frame acknowledged", ack.get("type") == "config_ack", str(ack))
    check("Ack echoes patient_lang", ack.get("patient_lang") == "ms", str(ack.get("patient_lang")))
    check("Conversation response has direction",
          resp.get("direction") in ("to_patient", "to_clinician"), resp.get("direction"))
    check("Direction consistent with detected_lang",
          (resp.get("detected_lang") == "en") == (resp.get("direction") == "to_patient"),
          f"detected={resp.get('detected_lang')} direction={resp.get('direction')}")
    check("target_lang matches direction",
          resp.get("target_lang") == ("ms" if resp.get("direction") == "to_patient" else "en"),
          resp.get("target_lang"))
    check("Response has tts flag", "tts" in resp, str(resp.get("tts")))
    print(f"  detected: {resp.get('detected_lang')}  direction: {resp.get('direction')}  "
          f"target: {resp.get('target_lang')}")
    print(f"  translation: {repr((resp.get('translation') or '')[:80])}")

# ── 3c. Glossary + continuous learning ───────────────────────────────────────
print("\n=== 3c. Glossary & corrections ===")
def delete_req(path):
    req = urllib.request.Request(f"{BASE}{path}", method="DELETE", headers=_headers())
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status

try:
    gl = get("/api/glossary")
    check("GET /api/glossary returns a list", isinstance(gl, list), f"{len(gl)} entries")
    check("Seed glossary loaded", any(e.get("term_en") == "weight-bearing" for e in gl),
          f"{len(gl)} entries")

    entry = post_json("/api/glossary", {
        "term_en": "e2e-test-term", "translations": {"ms": "ujian-e2e"},
        "simpler_en": "a test"})
    check("POST /api/glossary creates entry", bool(entry.get("id")), entry.get("id"))
    gl2 = get("/api/glossary")
    check("New term appears in glossary",
          any(e.get("term_en") == "e2e-test-term" for e in gl2))

    # Duplicate term_en replaces, not duplicates
    post_json("/api/glossary", {"term_en": "E2E-Test-Term", "translations": {"ms": "ujian-e2e-v2"}})
    gl3 = get("/api/glossary")
    dups = [e for e in gl3 if (e.get("term_en") or "").lower() == "e2e-test-term"]
    check("Same term updates instead of duplicating", len(dups) == 1, f"{len(dups)} entries")

    status = delete_req(f"/api/glossary/{dups[0]['id']}")
    check("DELETE /api/glossary/:id works", status == 200, str(status))

    fb = post_json("/api/feedback", {
        "src_lang": "en", "tgt_lang": "ms",
        "source_text": "Please bend your knee slowly and hold for 5 seconds.",
        "wrong_translation": "x",
        "corrected_translation": "Sila bengkokkan lutut anda perlahan-lahan dan tahan selama lima saat.",
        "note": "polite clinical phrasing"})
    check("POST /api/feedback stores correction", bool(fb.get("id")))

    # The stored correction should be applied to a repeat translation
    tr = post_json("/api/translate", {
        "text": "Please bend your knee slowly and hold for 5 seconds.",
        "source_lang": "en", "target_lang": "ms"})
    applied = "lutut" in (tr.get("translation") or "").lower()
    check("Correction context reaches translator (mentions 'lutut')",
          applied, repr(tr.get("translation", ""))[:90])
except Exception as e:
    check("Glossary/corrections API succeeded", False, str(e))

# ── 4. Sessions API ───────────────────────────────────────────────────────────
print("\n=== 4. GET /api/sessions ===")
try:
    sessions = get("/api/sessions")
    check("Response is a list", isinstance(sessions, list), f"{len(sessions)} sessions")
    if sessions:
        s0 = sessions[0]
        check("Session has session_id", "session_id" in s0)
        check("Session has speaker_id", "speaker_id" in s0)
        check("Session has transcript", "transcript" in s0)
        check("Session has confidence", "confidence" in s0)
except Exception as e:
    check("GET /api/sessions succeeded", False, str(e))

# ── 5. Page load ──────────────────────────────────────────────────────────────
print("\n=== 5. Static page ===")
try:
    req = urllib.request.Request(f"{BASE}/")
    with urllib.request.urlopen(req, timeout=10) as r:
        html = r.read().decode()
    check("Page loads (HTTP 200)", True)
    for elem in ["settings-nemotron-api-key", "live-transcript-panel",
                 "source-lang", "target-lang", "settings-source-lang", "settings-target-lang",
                 "convo-mode-toggle", "patient-lang", "direction-pills", "convo-log",
                 "tts-toggle", "clear-convo-btn",
                 "glossary-card", "glossary-add-btn", "glossary-table-body",
                 "correction-modal", "correction-save-btn"]:
        check(f"  element #{elem} present", elem in html)
    check("  tts.js referenced", 'src="tts.js"' in html)
    req = urllib.request.Request(f"{BASE}/login.html")
    with urllib.request.urlopen(req, timeout=10) as r:
        login_html = r.read().decode()
    check("  login page loads publicly", "login-form" in login_html)
except Exception as e:
    check("Page loads", False, str(e))

# ── Summary ───────────────────────────────────────────────────────────────────
print("\n=== Summary ===")
passed = sum(1 for _, ok in results if ok)
total = len(results)
print(f"  {passed}/{total} checks passed")
if passed < total:
    print("  Failed:")
    for name, ok in results:
        if not ok:
            print(f"    - {name}")
sys.exit(0 if passed == total else 1)
