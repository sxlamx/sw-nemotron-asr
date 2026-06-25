# Sessions Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Timestamp every recorded session directory and add a Recordings panel to the UI for listing and playing back all captured audio.

**Architecture:** Session dirs rename to `{YYYY-MM-DDTHH-MM-SS}_{uuid}` for filesystem browsability. A new `GET /api/sessions` endpoint reads those dirs and returns metadata. A full-width Recordings panel in the existing HTML uses a shared `<audio>` player for playback.

**Tech Stack:** Rust/Axum (chrono for timestamps), vanilla JS + HTML5 audio, tower-http ServeDir for static audio serving.

## Global Constraints

- Session dir timestamp format: `YYYY-MM-DDTHH-MM-SS` (hyphens in time, not colons — filesystem safe)
- Audio served at `/data/sessions/{dir}/audio.wav` via `ServeDir("data")`
- Old UUID-only session dirs (no underscore at index 19) must be silently skipped
- Frontend matches existing dark glassmorphism card style (CSS vars: `--card-bg`, `--border-color`, `--primary-color`, `--text-muted`, `--font-mono`, `--font-main`)
- No pagination — listing all sessions is acceptable for local dev use

---

## File Map

| File | Change |
|---|---|
| `Cargo.toml` | Add `chrono = { version = "0.4", features = ["local-offset"] }` |
| `src/main.rs` | Timestamp session dirs, save `speaker.txt`, add `SessionInfo` struct, add `get_sessions_handler`, add `/api/sessions` route, add `/data` ServeDir |
| `static/index.html` | Add Recordings panel HTML + CSS below existing grid |
| `static/app.js` | Add `fetchSessions()`, `populateRecordingsTable()`, `playSession()`, wire into DOMContentLoaded + displayResult |

---

## Task 1: Timestamped Session Dirs + speaker.txt

**Files:**
- Modify: `Cargo.toml`
- Modify: `src/main.rs` — `transcribe_handler` and `enroll_handler`

**Interfaces:**
- Produces: session dirs named `{YYYY-MM-DDTHH-MM-SS}_{uuid}` with `speaker.txt` inside

- [ ] **Step 1: Add chrono to Cargo.toml**

Open `Cargo.toml` and add to `[dependencies]`:
```toml
chrono = { version = "0.4", features = ["local-offset"] }
```

- [ ] **Step 2: Add chrono import to main.rs**

At the top of `src/main.rs`, add:
```rust
use chrono::Local;
```

- [ ] **Step 3: Update session dir creation in transcribe_handler**

In `transcribe_handler`, replace:
```rust
let session_id = Uuid::new_v4().to_string();
```
With:
```rust
let timestamp = Local::now().format("%Y-%m-%dT%H-%M-%S").to_string();
let session_id = format!("{}_{}", timestamp, Uuid::new_v4());
```

- [ ] **Step 4: Save speaker.txt after speaker_id is resolved**

In `transcribe_handler`, after the `speaker_id` binding is set and before the final `Ok(Json(...))`, add:
```rust
let _ = std::fs::write(format!("{}/speaker.txt", session_dir), &speaker_id);
```

- [ ] **Step 5: Verify build compiles**

```bash
source ~/.cargo/env && cargo build --release 2>&1 | grep -E "error|Finished"
```
Expected: `Finished \`release\` profile`

- [ ] **Step 6: Smoke-test with curl**

Kill existing server and restart:
```bash
kill $(lsof -ti :3007) 2>/dev/null; ./target/release/sw-nemotron-asr &> /tmp/aura.log &
until grep -q "running on" /tmp/aura.log; do sleep 2; done
```

Post a test recording:
```bash
curl -s -X POST http://127.0.0.1:3007/api/transcribe \
  -F "audio=@/tmp/test_audio.wav" | python3 -m json.tool
```

Check the new session dir exists with timestamp prefix and speaker.txt:
```bash
ls data/sessions/ | head -3
ls data/sessions/$(ls -t data/sessions/ | head -1)/
```
Expected: dir named like `2026-06-25T09-03-15_550e8400-...`, containing `audio.wav`, `transcript.txt`, `speaker.txt`.

- [ ] **Step 7: Commit**

```bash
git add Cargo.toml Cargo.lock src/main.rs
git commit -m "Add timestamp prefix to session dirs and persist speaker.txt"
```

---

## Task 2: GET /api/sessions Endpoint + /data ServeDir

**Files:**
- Modify: `src/main.rs` — add `SessionInfo` struct, `get_sessions_handler`, routes

**Interfaces:**
- Consumes: `data/sessions/{YYYY-MM-DDTHH-MM-SS}_{uuid}/` dirs from Task 1
- Produces: `GET /api/sessions` → `[SessionInfo]` JSON; audio accessible at `/data/sessions/{dir}/audio.wav`

```rust
// SessionInfo shape (for frontend reference)
struct SessionInfo {
    session_id: String,   // full dir name e.g. "2026-06-25T09-03-15_550e8400-..."
    timestamp: String,    // ISO display e.g. "2026-06-25T09:03:15"
    transcript: String,   // content of transcript.txt (may be empty)
    speaker_id: String,   // content of speaker.txt (default "Unknown")
    audio_url: String,    // "/data/sessions/{dir}/audio.wav"
}
```

- [ ] **Step 1: Add SessionInfo struct to main.rs**

After the existing `TranscribeResponse` struct, add:
```rust
#[derive(Serialize)]
struct SessionInfo {
    session_id: String,
    timestamp: String,
    transcript: String,
    speaker_id: String,
    audio_url: String,
}
```

- [ ] **Step 2: Add get_sessions_handler**

Add this function to `src/main.rs`:
```rust
async fn get_sessions_handler() -> impl IntoResponse {
    let mut sessions: Vec<SessionInfo> = Vec::new();

    if let Ok(entries) = std::fs::read_dir("data/sessions") {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            // Skip non-timestamped dirs (old UUID-only sessions)
            if name.len() < 20 || name.chars().nth(19) != Some('_') {
                continue;
            }
            if !entry.path().is_dir() {
                continue;
            }

            // Parse "YYYY-MM-DDTHH-MM-SS" → "YYYY-MM-DDTHH:MM:SS" for display
            let ts_raw = &name[..19];
            let timestamp = format!(
                "{}T{}:{}:{}",
                &ts_raw[..10],
                &ts_raw[11..13],
                &ts_raw[14..16],
                &ts_raw[17..19]
            );

            let transcript = std::fs::read_to_string(entry.path().join("transcript.txt"))
                .unwrap_or_default()
                .trim()
                .to_string();
            let speaker_id = std::fs::read_to_string(entry.path().join("speaker.txt"))
                .unwrap_or_else(|_| "Unknown".to_string())
                .trim()
                .to_string();

            sessions.push(SessionInfo {
                audio_url: format!("/data/sessions/{}/audio.wav", name),
                session_id: name,
                timestamp,
                transcript,
                speaker_id,
            });
        }
    }

    // Newest first
    sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Json(sessions)
}
```

- [ ] **Step 3: Register route and /data ServeDir in main()**

In `main()`, update the router. Add `/api/sessions` route and the `/data` ServeDir **before** the `"/"` wildcard:
```rust
let app = Router::new()
    .route("/api/transcribe", post(transcribe_handler))
    .route("/api/speakers/enroll", post(enroll_handler))
    .route("/api/speakers/aliases", get(get_aliases_handler).post(update_aliases_handler))
    .route("/api/sessions", get(get_sessions_handler))
    .layer(DefaultBodyLimit::max(20 * 1024 * 1024))
    .layer(cors)
    .nest_service("/data", tower_http::services::ServeDir::new("data"))
    .nest_service("/", tower_http::services::ServeDir::new("static"))
    .with_state(shared_state);
```

- [ ] **Step 4: Build and restart server**

```bash
source ~/.cargo/env && cargo build --release 2>&1 | grep -E "error|Finished"
kill $(lsof -ti :3007) 2>/dev/null
./target/release/sw-nemotron-asr &> /tmp/aura.log &
until grep -q "running on" /tmp/aura.log; do sleep 2; done
echo "Server ready"
```

- [ ] **Step 5: Test GET /api/sessions**

First record a session if none exist with timestamp prefix (run Task 1 Step 6 if needed). Then:
```bash
curl -s http://127.0.0.1:3007/api/sessions | python3 -m json.tool
```
Expected: JSON array with at least one entry containing `session_id`, `timestamp`, `transcript`, `speaker_id`, `audio_url`.

- [ ] **Step 6: Test audio serving**

```bash
AUDIO_URL=$(curl -s http://127.0.0.1:3007/api/sessions | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['audio_url'])")
curl -sI "http://127.0.0.1:3007${AUDIO_URL}" | head -5
```
Expected: `HTTP/1.1 200 OK` with `content-type: audio/wav` or `application/octet-stream`.

- [ ] **Step 7: Commit**

```bash
git add src/main.rs
git commit -m "Add GET /api/sessions endpoint and /data ServeDir for audio playback"
```

---

## Task 3: Recordings Panel — HTML + CSS

**Files:**
- Modify: `static/index.html`

**Interfaces:**
- Consumes: nothing from backend yet (JS wired in Task 4)
- Produces: DOM elements `#recordings-table-body`, `#audio-player`, `#refresh-recordings-btn`

- [ ] **Step 1: Add CSS for recordings section**

Inside the `<style>` block in `index.html`, add before the closing `</style>`:
```css
.recordings-section {
    max-width: 1400px;
    margin: 0 auto 2rem;
    padding: 0 2rem;
}

#audio-player {
    width: 100%;
    margin-bottom: 1.25rem;
    border-radius: 10px;
    accent-color: var(--primary-color);
    display: none;
}

.recordings-table-container {
    overflow-x: auto;
}

.ts-badge {
    font-family: var(--font-mono);
    font-size: 0.8rem;
    color: var(--text-muted);
}

.play-btn {
    padding: 0.35rem 0.75rem;
    font-size: 0.82rem;
    border-radius: 8px;
}

tr.playing-row {
    background: rgba(0, 242, 254, 0.05);
}
```

- [ ] **Step 2: Add Recordings panel HTML**

After the closing `</div>` of the `.container` div (just before `<!-- Edit Aliases Modal -->`), add:
```html
<!-- Recordings Panel -->
<div class="recordings-section">
    <div class="card">
        <h2 style="justify-content: space-between;">
            <span style="display:flex; align-items:center; gap:0.5rem;">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polygon points="10 8 16 12 10 16 10 8"></polygon></svg>
                Recordings
            </span>
            <button class="btn btn-secondary play-btn" id="refresh-recordings-btn" style="font-size:0.8rem; padding:0.35rem 0.75rem;">↺ Refresh</button>
        </h2>
        <audio id="audio-player" controls></audio>
        <div class="recordings-table-container">
            <table>
                <thead>
                    <tr>
                        <th>Timestamp</th>
                        <th>Speaker</th>
                        <th>Transcript</th>
                        <th>Play</th>
                    </tr>
                </thead>
                <tbody id="recordings-table-body">
                    <tr><td colspan="4" style="text-align:center; color:var(--text-muted);">Loading recordings...</td></tr>
                </tbody>
            </table>
        </div>
    </div>
</div>
```

- [ ] **Step 3: Verify page loads without JS errors**

Restart server if needed and open `http://127.0.0.1:3007`. Open browser DevTools console — no errors. The Recordings panel should appear below the main grid with "Loading recordings..." placeholder.

- [ ] **Step 4: Commit**

```bash
git add static/index.html
git commit -m "Add Recordings panel HTML and CSS to index.html"
```

---

## Task 4: Recordings Panel — JavaScript

**Files:**
- Modify: `static/app.js`

**Interfaces:**
- Consumes: `GET /api/sessions` → `SessionInfo[]` from Task 2
- Consumes: DOM elements `#recordings-table-body`, `#audio-player`, `#refresh-recordings-btn` from Task 3
- Consumes: `escapeHtml()` — already defined in app.js

- [ ] **Step 1: Add element references at top of app.js**

After the existing `// Modal Elements` block, add:
```javascript
// Recordings Panel
const audioPlayer = document.getElementById('audio-player');
const recordingsTableBody = document.getElementById('recordings-table-body');
const refreshRecordingsBtn = document.getElementById('refresh-recordings-btn');
```

- [ ] **Step 2: Add fetchSessions()**

Add after the existing `fetchSpeakers()` function:
```javascript
async function fetchSessions() {
    try {
        const response = await fetch('/api/sessions');
        if (response.ok) {
            const sessions = await response.json();
            populateRecordingsTable(sessions);
        }
    } catch (err) {
        console.error('Error fetching sessions:', err);
        recordingsTableBody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">Failed to load recordings.</td></tr>`;
    }
}
```

- [ ] **Step 3: Add populateRecordingsTable()**

Add immediately after `fetchSessions()`:
```javascript
function populateRecordingsTable(sessions) {
    recordingsTableBody.innerHTML = '';
    if (!sessions || sessions.length === 0) {
        recordingsTableBody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">No recordings yet. Record something above!</td></tr>`;
        return;
    }
    sessions.forEach(s => {
        const displayTime = s.timestamp
            ? new Date(s.timestamp).toLocaleString()
            : s.session_id;
        const isUnknown = !s.speaker_id || s.speaker_id === 'Unknown';
        const snippet = s.transcript
            ? (s.transcript.length > 80 ? s.transcript.slice(0, 80) + '…' : s.transcript)
            : '(No speech detected)';
        const row = document.createElement('tr');
        row.dataset.audioUrl = s.audio_url;
        row.innerHTML = `
            <td class="ts-badge">${escapeHtml(displayTime)}</td>
            <td><span class="speaker-badge ${isUnknown ? 'unknown' : ''}">${escapeHtml(s.speaker_id || 'Unknown')}</span></td>
            <td style="font-size:0.88rem; color:var(--text-muted);">${escapeHtml(snippet)}</td>
            <td><button class="btn btn-secondary play-btn" onclick="playSession('${escapeHtml(s.audio_url)}', this)">▶ Play</button></td>
        `;
        recordingsTableBody.appendChild(row);
    });
}
```

- [ ] **Step 4: Add playSession()**

Add immediately after `populateRecordingsTable()`:
```javascript
function playSession(audioUrl, btn) {
    audioPlayer.style.display = 'block';
    audioPlayer.src = audioUrl;
    audioPlayer.play();
    // Highlight playing row, clear others
    document.querySelectorAll('#recordings-table-body tr').forEach(r => r.classList.remove('playing-row'));
    btn.closest('tr').classList.add('playing-row');
}
```

- [ ] **Step 5: Call fetchSessions() on page load**

Update the existing `DOMContentLoaded` listener to also call `fetchSessions()`:
```javascript
document.addEventListener('DOMContentLoaded', () => {
    fetchSpeakers();
    fetchSessions();
    drawVisualizerIdle();
});
```

- [ ] **Step 6: Refresh recordings after successful transcription**

In the `displayResult()` function, add a `fetchSessions()` call at the end:
```javascript
function displayResult(data) {
    // ... existing code unchanged ...
    resultBox.style.display = 'block';
    fetchSessions(); // refresh recordings list
}
```

- [ ] **Step 7: Wire refresh button**

After the modal event listeners, add:
```javascript
refreshRecordingsBtn.addEventListener('click', fetchSessions);
```

- [ ] **Step 8: End-to-end browser test**

Open `http://127.0.0.1:3007`. Verify:
1. Recordings panel loads and shows existing timestamped sessions
2. Click ▶ Play on a row — audio player appears and plays the WAV
3. Playing row highlights in cyan tint
4. Click ↺ Refresh — list reloads
5. Record a new clip — after transcription result appears, Recordings list automatically refreshes with the new entry at top

- [ ] **Step 9: Commit**

```bash
git add static/app.js
git commit -m "Add Recordings panel JS: fetchSessions, playSession, auto-refresh after transcription"
```

---

## Task 5: Push to Remote

- [ ] **Step 1: Final check**

```bash
git log --oneline -5
```
Expected: 4 new commits from Tasks 1–4 on top of `41a869b`.

- [ ] **Step 2: Push**

```bash
git push origin main
```

---

## Self-Review

**Spec coverage:**
- ✅ Timestamp in session dir name — Task 1
- ✅ `speaker.txt` persistence — Task 1 Step 4
- ✅ `GET /api/sessions` endpoint — Task 2
- ✅ `/data/` ServeDir for audio — Task 2 Step 3
- ✅ Recordings panel HTML — Task 3
- ✅ Shared audio player — Task 3 Step 2
- ✅ `fetchSessions()` on DOMContentLoaded — Task 4 Step 5
- ✅ Auto-refresh after transcription — Task 4 Step 6
- ✅ Old UUID-only dirs skipped — Task 2 Step 2 (guard on index 19)

**Placeholder scan:** No TBD, TODO, or vague steps found.

**Type consistency:** `SessionInfo` defined in Task 2 Step 1; `audio_url`, `session_id`, `timestamp`, `transcript`, `speaker_id` fields used consistently in Task 2 Step 2 (handler) and Task 4 Steps 3–4 (JS).
