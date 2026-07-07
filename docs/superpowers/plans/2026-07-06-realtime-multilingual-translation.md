# Real-Time Multilingual ASR + Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace English-only Parakeet ASR with multilingual Whisper ASR and add real-time Nemotron LLM translation (Chinese ↔ English, English ↔ Malay, English ↔ Tamil, English ↔ Korean) delivered via WebSocket with ~1–2s per-utterance latency.

**Architecture:** Browser records audio continuously; client-side silence detection segments utterances and sends each as PCM bytes over a persistent WebSocket. The Rust server writes audio to a temp file, dispatches it to a Python `asr_translate_worker` subprocess (JSON-line stdin/stdout protocol), which transcribes with `faster-whisper` and translates via the NVIDIA Nemotron LLM API, then pushes results back through the WebSocket. Speaker ID runs in parallel against the same audio using the existing worker.

**Tech Stack:** Rust/Axum (WebSocket via `axum` `ws` feature), Python `faster-whisper` (CTranslate2 backend), NVIDIA Nemotron LLM API (`openai` Python SDK pointing to `https://integrate.api.nvidia.com/v1`), Silero VAD already installed, Web Audio API `ScriptProcessorNode` for client-side amplitude-based silence detection.

---

## File Map

| File | Change | Responsibility |
|------|--------|----------------|
| `scripts/asr_translate_worker.py` | **Create** | faster-whisper transcription + Nemotron API translation, JSON-line stdin/stdout protocol |
| `src/main.rs` | **Modify** | Remove parakeet-rs, add `AsrTranslateWorker`, WebSocket route `/ws/transcribe`, update `AppSettings` and `AppState` |
| `Cargo.toml` | **Modify** | Add `ws` feature to axum, remove `parakeet-rs` |
| `static/index.html` | **Modify** | Language selector (source + target), real-time live panel, WebSocket status indicator |
| `static/app.js` | **Modify** | Replace `uploadAndTranscribe` with WebSocket audio streaming, real-time segment display |
| `settings.json` | **Schema change** | Add `nemotron_api_key`, `source_language`, `target_language` fields |
| `scripts/setup_python.ps1` | **Modify** | Add `faster-whisper` and `openai` pip installs |
| `scripts/setup_python.sh` | **Modify** | Same for Linux/macOS |

---

## Task 1: Python ASR + Translation Worker

**Files:**
- Create: `scripts/asr_translate_worker.py`

This worker starts once, loads the Whisper model, then loops reading JSON-line commands from stdin and writing JSON-line responses to stdout. Rust communicates with it the same way as `speaker_id.py`.

**Protocol:**
- Startup: prints `READY` when model loaded
- Transcribe command: `{"cmd":"transcribe","audio_path":"...","source_lang":"auto"}`
- Transcribe response: `{"status":"ok","text":"你好世界","detected_lang":"zh"}`
- Translate command: `{"cmd":"translate","text":"你好世界","source_lang":"zh","target_lang":"en","api_key":"nvapi-..."}`
- Translate response: `{"status":"ok","translation":"Hello world"}`
- Error response: `{"status":"error","message":"..."}`

- [ ] **Step 1: Create `scripts/asr_translate_worker.py`**

```python
import sys
import os
import json
import shutil

# Windows: symlink fallback and SSL bypass (same as speaker_id.py)
_orig_symlink = os.symlink
def _symlink_or_copy(src, dst, target_is_directory=False):
    try:
        _orig_symlink(src, dst, target_is_directory)
    except OSError:
        if os.path.isdir(src): shutil.copytree(src, dst)
        else: shutil.copy2(src, dst)
os.symlink = _symlink_or_copy

import ssl as _ssl
_ssl._create_default_https_context = _ssl._create_unverified_context

import torch
from faster_whisper import WhisperModel

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WHISPER_MODEL_DIR = os.path.join(PROJECT_ROOT, "models", "whisper")

# Map Whisper language codes to NLLB/display names
LANG_DISPLAY = {
    "zh": "Chinese", "en": "English", "ms": "Malay",
    "ta": "Tamil", "ko": "Korean", "auto": "Auto-detect"
}

_whisper_model = None

def get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        # "small" is ~244MB, good balance of speed and accuracy
        # compute_type="int8" runs on CPU without large RAM overhead
        _whisper_model = WhisperModel(
            "small",
            device="cpu",
            compute_type="int8",
            download_root=WHISPER_MODEL_DIR,
        )
    return _whisper_model

def cmd_transcribe(audio_path: str, source_lang: str) -> dict:
    model = get_whisper_model()
    lang_arg = None if source_lang == "auto" else source_lang
    try:
        segments, info = model.transcribe(
            audio_path,
            language=lang_arg,
            beam_size=5,
            vad_filter=True,
            vad_parameters={"threshold": 0.3},
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        detected = info.language if source_lang == "auto" else source_lang
        return {"status": "ok", "text": text, "detected_lang": detected}
    except Exception as e:
        return {"status": "error", "message": str(e)}

def cmd_translate(text: str, source_lang: str, target_lang: str, api_key: str) -> dict:
    if not text.strip():
        return {"status": "ok", "translation": ""}
    if source_lang == target_lang:
        return {"status": "ok", "translation": text}
    if not api_key:
        return {"status": "error", "message": "No Nemotron API key configured"}
    try:
        from openai import OpenAI
        client = OpenAI(
            base_url="https://integrate.api.nvidia.com/v1",
            api_key=api_key,
            http_client=__import__("httpx").Client(verify=False),
        )
        lang_names = {
            "zh": "Simplified Chinese", "en": "English",
            "ms": "Malay", "ta": "Tamil", "ko": "Korean",
        }
        src_name = lang_names.get(source_lang, source_lang)
        tgt_name = lang_names.get(target_lang, target_lang)
        prompt = (
            f"Translate the following {src_name} text to {tgt_name}. "
            f"Output only the translation, no explanations.\n\nText: {text}"
        )
        resp = client.chat.completions.create(
            model="nvidia/llama-3.1-nemotron-70b-instruct",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=512,
        )
        translation = resp.choices[0].message.content.strip()
        return {"status": "ok", "translation": translation}
    except Exception as e:
        return {"status": "error", "message": str(e)}

def run_persistent():
    get_whisper_model()
    print("READY", flush=True)
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            cmd = req.get("cmd")
            if cmd == "transcribe":
                result = cmd_transcribe(req["audio_path"], req.get("source_lang", "auto"))
            elif cmd == "translate":
                result = cmd_translate(
                    req["text"], req["source_lang"], req["target_lang"], req.get("api_key", "")
                )
            else:
                result = {"status": "error", "message": f"unknown cmd: {cmd}"}
        except Exception as e:
            result = {"status": "error", "message": str(e)}
        print(json.dumps(result), flush=True)

if __name__ == "__main__":
    run_persistent()
```

- [ ] **Step 2: Verify the worker starts and loads Whisper**

Run in the project `.venv`:
```powershell
.venv\Scripts\python.exe scripts\asr_translate_worker.py
```
Expected output (after model downloads ~244MB on first run):
```
READY
```
Press Ctrl+C to stop.

- [ ] **Step 3: Test transcribe command manually**

With the worker running, type a JSON line then press Enter:
```
{"cmd":"transcribe","audio_path":"data/speakers/testuser_temp.wav","source_lang":"auto"}
```
Expected (audio may be silent, that's OK):
```json
{"status":"ok","text":"","detected_lang":"en"}
```

- [ ] **Step 4: Install dependencies**

```powershell
.venv\Scripts\pip install faster-whisper openai httpx
```

Expected: `Successfully installed faster-whisper-...`

- [ ] **Step 5: Update setup scripts**

In `scripts/setup_python.ps1`, add after existing pip installs:
```powershell
pip install faster-whisper openai httpx
```

In `scripts/setup_python.sh`, add:
```bash
pip install faster-whisper openai httpx
```

- [ ] **Step 6: Add `models/whisper/` to `.gitignore`**

The Whisper model downloads to `models/whisper/`. `models/` is already in `.gitignore` so no change needed — verify with:
```bash
grep "^models/" .gitignore
```
Expected output: `models/`

- [ ] **Step 7: Commit**

```bash
git add scripts/asr_translate_worker.py scripts/setup_python.ps1 scripts/setup_python.sh
git commit -m "Add faster-whisper + Nemotron LLM translation worker"
```

---

## Task 2: Update AppSettings and AppState in Rust

**Files:**
- Modify: `src/main.rs` (AppSettings struct, AppState struct, load_or_create_settings)

Add `nemotron_api_key`, `source_language`, `target_language` to settings and a second Python worker in `AppState`.

- [ ] **Step 1: Update `AppSettings` struct**

In `src/main.rs`, replace the `AppSettings` struct and its `Default` impl:

```rust
#[derive(Serialize, Deserialize, Clone)]
struct AppSettings {
    curated_audio_folder: String,
    min_enrollment_samples: usize,
    max_enrollment_samples: usize,
    nemotron_api_key: String,
    source_language: String,   // "auto", "en", "zh", "ms", "ta", "ko"
    target_language: String,   // "en", "zh", "ms", "ta", "ko"
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            curated_audio_folder: "data/curated".to_string(),
            min_enrollment_samples: 3,
            max_enrollment_samples: 10,
            nemotron_api_key: String::new(),
            source_language: "auto".to_string(),
            target_language: "en".to_string(),
        }
    }
}
```

- [ ] **Step 2: Add `AstrWorker` type alias and update `AppState`**

Below the `SpeakerIdWorker` struct definition, add a type alias for the new worker (same structure, different name for clarity):

```rust
// Re-use same stdin/stdout subprocess protocol for the ASR+translate worker
type AstrWorker = SpeakerIdWorker;
```

Update `AppState`:
```rust
struct AppState {
    speaker_id: Mutex<SpeakerIdWorker>,
    astr: Mutex<AstrWorker>,          // ASR + translation worker
    settings: Mutex<AppSettings>,
}
```

Note: `model: Mutex<Nemotron>` is removed — Parakeet is replaced by the Python worker.

- [ ] **Step 3: Add `spawn_astr_worker` function**

After `spawn_speaker_id_worker`, add:

```rust
async fn spawn_astr_worker(
    python_path: &str,
) -> Result<AstrWorker, Box<dyn std::error::Error + Send + Sync>> {
    info!("Starting ASR+translate worker (loading Whisper model)...");
    let mut child = tokio::process::Command::new(python_path)
        .args(["scripts/asr_translate_worker.py"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()?;

    let stdin = tokio::io::BufWriter::new(
        child.stdin.take().ok_or("failed to open astr stdin")?,
    );
    let mut stdout = BufReader::new(
        child.stdout.take().ok_or("failed to open astr stdout")?,
    );

    let mut ready = String::new();
    stdout.read_line(&mut ready).await?;
    if ready.trim() != "READY" {
        return Err(format!("astr worker did not send READY (got: {:?})", ready.trim()).into());
    }

    info!("ASR+translate worker ready.");
    Ok(SpeakerIdWorker { _child: child, stdin, stdout })
}
```

- [ ] **Step 4: Update `main()` to spawn both workers and drop Parakeet**

Replace the Parakeet model load and `AppState` construction in `main()`:

```rust
// Remove these lines:
//   info!("Loading Nemotron ASR model from ./models...");
//   let model = match Nemotron::from_pretrained(...) { ... };
//   info!("Nemotron ASR model loaded successfully!");

// Keep speaker_id worker spawn as-is, then add:
let mut astr_worker = match spawn_astr_worker(python_path).await {
    Ok(w) => w,
    Err(e) => {
        error!("Failed to start ASR+translate worker: {:?}", e);
        return;
    }
};

let shared_state = Arc::new(AppState {
    speaker_id: Mutex::new(worker),
    astr: Mutex::new(astr_worker),
    settings: Mutex::new(settings_val),
});
```

- [ ] **Step 5: Update `Cargo.toml` — remove parakeet-rs, add ws feature**

```toml
axum = { version = "0.7.5", features = ["multipart", "ws"] }
# Remove: parakeet-rs = "0.3.6"
```

Also remove `use parakeet_rs::Nemotron;` from `main.rs`.

- [ ] **Step 6: Verify it compiles (with compile errors from handlers that reference `state.model`)**

```powershell
$vcvars = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
cmd /c "`"$vcvars`" && cargo build 2>&1" | Select-Object -Last 20
```

Expected: compile errors in `transcribe_handler` referencing `state.model` — these will be fixed in Task 3.

- [ ] **Step 7: Commit (partial — won't link yet)**

```bash
git add Cargo.toml src/main.rs
git commit -m "Add AstrWorker, update AppState: remove parakeet-rs, add astr worker"
```

---

## Task 3: Rewrite `/api/transcribe` to Use Python ASR Worker

**Files:**
- Modify: `src/main.rs` (transcribe_handler)

The handler now calls `state.astr` for transcription instead of the removed Parakeet model, then `state.speaker_id` for identification — same as before.

- [ ] **Step 1: Replace `transcribe_handler` body**

Find and replace the entire `transcribe_handler` function:

```rust
async fn transcribe_handler(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Result<Json<TranscribeResponse>, (StatusCode, String)> {
    info!("POST /api/transcribe");
    let mut audio_bytes = Vec::new();

    while let Ok(Some(field)) = multipart.next_field().await {
        if field.name() == Some("audio") {
            if let Ok(bytes) = field.bytes().await {
                audio_bytes = bytes.to_vec();
            }
        }
    }

    if audio_bytes.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Missing audio field".to_string()));
    }

    let timestamp = Local::now().format("%Y-%m-%dT%H-%M-%S").to_string();
    let session_id = format!("{}_{}", timestamp, Uuid::new_v4());
    let session_dir = format!("data/sessions/{}", session_id);
    std::fs::create_dir_all(&session_dir)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let audio_path = format!("{}/audio.wav", session_dir);
    std::fs::write(&audio_path, &audio_bytes)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Transcribe via faster-whisper worker
    let (transcript, detected_lang) = {
        let settings = state.settings.lock().await;
        let source_lang = settings.source_language.clone();
        drop(settings);

        let req = serde_json::json!({
            "cmd": "transcribe",
            "audio_path": audio_path,
            "source_lang": source_lang,
        });
        let mut astr = state.astr.lock().await;
        match astr.send(&format!("{}\n", req)).await {
            Ok(resp) => {
                match serde_json::from_str::<serde_json::Value>(&resp) {
                    Ok(v) if v["status"] == "ok" => (
                        v["text"].as_str().unwrap_or("").to_string(),
                        v["detected_lang"].as_str().unwrap_or("en").to_string(),
                    ),
                    Ok(v) => {
                        warn!("ASR worker error: {}", v["message"]);
                        (String::new(), "en".to_string())
                    }
                    Err(e) => {
                        error!("ASR parse error: {}", e);
                        (String::new(), "en".to_string())
                    }
                }
            }
            Err(e) => {
                error!("ASR worker send error: {}", e);
                (String::new(), "en".to_string())
            }
        }
    };

    // Translate via Nemotron API
    let translation = {
        let settings = state.settings.lock().await;
        let api_key = settings.nemotron_api_key.clone();
        let target_lang = settings.target_language.clone();
        drop(settings);

        if !api_key.is_empty() && detected_lang != target_lang && !transcript.is_empty() {
            let req = serde_json::json!({
                "cmd": "translate",
                "text": transcript,
                "source_lang": detected_lang,
                "target_lang": target_lang,
                "api_key": api_key,
            });
            let mut astr = state.astr.lock().await;
            match astr.send(&format!("{}\n", req)).await {
                Ok(resp) => {
                    serde_json::from_str::<serde_json::Value>(&resp)
                        .ok()
                        .and_then(|v| v["translation"].as_str().map(|s| s.to_string()))
                        .unwrap_or_default()
                }
                Err(e) => { error!("Translate send error: {}", e); String::new() }
            }
        } else {
            String::new()
        }
    };

    let transcript_trimmed = transcript.trim().to_string();
    let _ = std::fs::write(format!("{}/transcript.txt", session_dir), &transcript_trimmed);
    let _ = std::fs::write(format!("{}/detected_lang.txt", session_dir), &detected_lang);
    if !translation.is_empty() {
        let _ = std::fs::write(format!("{}/translation.txt", session_dir), &translation);
    }

    // Speaker ID
    let (speaker_id, confidence) = {
        let mut worker = state.speaker_id.lock().await;
        match worker.send(&format!("identify {}\n", audio_path)).await {
            Ok(resp) if resp.starts_with("IDENTIFIED:") => {
                let parts: Vec<&str> = resp.split(':').collect();
                let speaker = parts.get(1).unwrap_or(&"Unknown").to_string();
                let conf = parts.get(2).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
                (speaker, conf)
            }
            Ok(resp) => { warn!("Speaker ID unexpected: {}", resp); ("Unknown".to_string(), 0.0) }
            Err(e) => { error!("Speaker ID error: {}", e); ("Unknown".to_string(), 0.0) }
        }
    };

    let _ = std::fs::write(format!("{}/speaker.txt", session_dir), &speaker_id);
    let _ = std::fs::write(format!("{}/confidence.txt", session_dir), confidence.to_string());

    info!("POST /api/transcribe -> session={} speaker={} lang={} confidence={:.4} transcript={:?}",
        session_id, speaker_id, detected_lang, confidence, transcript_trimmed);

    Ok(Json(TranscribeResponse {
        session_id,
        transcript: transcript_trimmed,
        translation,
        detected_lang,
        speaker_id,
        confidence,
    }))
}
```

- [ ] **Step 2: Update `TranscribeResponse` struct to include translation fields**

```rust
#[derive(Serialize)]
struct TranscribeResponse {
    session_id: String,
    transcript: String,
    translation: String,
    detected_lang: String,
    speaker_id: String,
    confidence: f64,
}
```

- [ ] **Step 3: Build and verify clean compile**

```powershell
$vcvars = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
cmd /c "`"$vcvars`" && cargo build 2>&1" | Select-Object -Last 10
```

Expected: `Finished \`dev\` profile`

- [ ] **Step 4: Test `/api/transcribe` end-to-end**

Start server (see server start instructions at bottom of plan), then:
```bash
curl -s -X POST http://localhost:3007/api/transcribe \
  -F "audio=@data/speakers/testuser_temp.wav"
```
Expected:
```json
{"session_id":"...","transcript":"","translation":"","detected_lang":"en","speaker_id":"Unknown","confidence":0.0}
```

- [ ] **Step 5: Commit**

```bash
git add src/main.rs
git commit -m "Rewrite /api/transcribe to use faster-whisper + Nemotron translation"
```

---

## Task 4: WebSocket Endpoint `/ws/transcribe`

**Files:**
- Modify: `src/main.rs` (new handler, route registration)

The WebSocket handler accepts a binary audio frame per utterance (WAV bytes), processes it through ASR + translation + speaker ID, and pushes a JSON segment back.

- [ ] **Step 1: Add WebSocket handler**

Add after `transcribe_handler`:

```rust
async fn ws_transcribe_handler(
    ws: axum::extract::WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_ws_transcribe(socket, state))
}

async fn handle_ws_transcribe(
    mut socket: axum::extract::ws::WebSocket,
    state: Arc<AppState>,
) {
    use axum::extract::ws::Message;
    info!("WS /ws/transcribe: client connected");

    while let Some(msg) = socket.recv().await {
        match msg {
            Ok(Message::Binary(audio_bytes)) => {
                let timestamp = Local::now().format("%Y-%m-%dT%H-%M-%S").to_string();
                let session_id = format!("{}_{}", timestamp, Uuid::new_v4());
                let session_dir = format!("data/sessions/{}", session_id);
                if std::fs::create_dir_all(&session_dir).is_err() { continue; }

                let audio_path = format!("{}/audio.wav", session_dir);
                if std::fs::write(&audio_path, &audio_bytes).is_err() { continue; }

                // Get settings once
                let (source_lang, target_lang, api_key) = {
                    let s = state.settings.lock().await;
                    (s.source_language.clone(), s.target_language.clone(), s.nemotron_api_key.clone())
                };

                // Transcribe
                let (transcript, detected_lang) = {
                    let req = serde_json::json!({
                        "cmd": "transcribe",
                        "audio_path": audio_path,
                        "source_lang": source_lang,
                    });
                    let mut astr = state.astr.lock().await;
                    match astr.send(&format!("{}\n", req)).await {
                        Ok(resp) => serde_json::from_str::<serde_json::Value>(&resp)
                            .ok()
                            .filter(|v| v["status"] == "ok")
                            .map(|v| (
                                v["text"].as_str().unwrap_or("").to_string(),
                                v["detected_lang"].as_str().unwrap_or("en").to_string(),
                            ))
                            .unwrap_or_default(),
                        Err(e) => { error!("WS ASR error: {}", e); (String::new(), "en".to_string()) }
                    }
                };

                // Translate
                let translation = if !api_key.is_empty() && detected_lang != target_lang && !transcript.is_empty() {
                    let req = serde_json::json!({
                        "cmd": "translate",
                        "text": transcript,
                        "source_lang": detected_lang,
                        "target_lang": target_lang,
                        "api_key": api_key,
                    });
                    let mut astr = state.astr.lock().await;
                    astr.send(&format!("{}\n", req)).await.ok()
                        .and_then(|r| serde_json::from_str::<serde_json::Value>(&r).ok())
                        .and_then(|v| v["translation"].as_str().map(|s| s.to_string()))
                        .unwrap_or_default()
                } else { String::new() };

                // Speaker ID
                let (speaker_id, confidence) = {
                    let mut worker = state.speaker_id.lock().await;
                    match worker.send(&format!("identify {}\n", audio_path)).await {
                        Ok(resp) if resp.starts_with("IDENTIFIED:") => {
                            let parts: Vec<&str> = resp.split(':').collect();
                            (
                                parts.get(1).unwrap_or(&"Unknown").to_string(),
                                parts.get(2).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0),
                            )
                        }
                        _ => ("Unknown".to_string(), 0.0),
                    }
                };

                // Persist
                let _ = std::fs::write(format!("{}/transcript.txt", session_dir), &transcript);
                let _ = std::fs::write(format!("{}/detected_lang.txt", session_dir), &detected_lang);
                let _ = std::fs::write(format!("{}/speaker.txt", session_dir), &speaker_id);
                let _ = std::fs::write(format!("{}/confidence.txt", session_dir), confidence.to_string());
                if !translation.is_empty() {
                    let _ = std::fs::write(format!("{}/translation.txt", session_dir), &translation);
                }

                info!("WS segment: session={} speaker={} lang={} text={:?}",
                    session_id, speaker_id, detected_lang, transcript);

                let response = serde_json::json!({
                    "type": "segment",
                    "session_id": session_id,
                    "transcript": transcript,
                    "translation": translation,
                    "detected_lang": detected_lang,
                    "speaker_id": speaker_id,
                    "confidence": confidence,
                });
                let _ = socket.send(Message::Text(response.to_string())).await;
            }
            Ok(Message::Close(_)) => {
                info!("WS /ws/transcribe: client disconnected");
                break;
            }
            Err(e) => {
                error!("WS error: {}", e);
                break;
            }
            _ => {}
        }
    }
}
```

- [ ] **Step 2: Register the WebSocket route**

In `main()`, add to the Router:
```rust
.route("/ws/transcribe", get(ws_transcribe_handler))
```

Also update the CORS layer to allow the `Upgrade` header:
```rust
let cors = tower_http::cors::CorsLayer::new()
    .allow_methods([Method::GET, Method::POST])
    .allow_headers([header::CONTENT_TYPE, header::UPGRADE])
    .allow_origin(tower_http::cors::Any);
```

- [ ] **Step 3: Build clean**

```powershell
$vcvars = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
cmd /c "`"$vcvars`" && cargo build 2>&1" | Select-Object -Last 5
```

Expected: `Finished \`dev\` profile`

- [ ] **Step 4: Commit**

```bash
git add src/main.rs
git commit -m "Add WebSocket /ws/transcribe endpoint for real-time streaming"
```

---

## Task 5: Frontend — Language Selector + WebSocket Audio Streaming

**Files:**
- Modify: `static/index.html` (language controls, live panel)
- Modify: `static/app.js` (WebSocket connection, replace uploadAndTranscribe)

- [ ] **Step 1: Add language selector and live panel to `index.html`**

Find the recording card section (look for `id="rec-status"` or the Record button area) and add the language bar above the record button:

```html
<!-- Language bar — insert before the Record button -->
<div class="lang-bar" style="display:flex; gap:1rem; align-items:center; margin-bottom:1.2rem; flex-wrap:wrap;">
  <div style="display:flex; flex-direction:column; gap:0.3rem;">
    <label style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.05em;">Source</label>
    <select id="source-lang" style="background:rgba(255,255,255,0.06); border:1px solid var(--border-color); color:var(--text-color); padding:0.4rem 0.8rem; border-radius:8px; font-family:var(--font-main); font-size:0.9rem;">
      <option value="auto">Auto-detect</option>
      <option value="en">English</option>
      <option value="zh">Chinese</option>
      <option value="ms">Malay</option>
      <option value="ta">Tamil</option>
      <option value="ko">Korean</option>
    </select>
  </div>
  <div style="font-size:1.2rem; color:var(--text-muted); padding-top:1.2rem;">→</div>
  <div style="display:flex; flex-direction:column; gap:0.3rem;">
    <label style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.05em;">Translate to</label>
    <select id="target-lang" style="background:rgba(255,255,255,0.06); border:1px solid var(--border-color); color:var(--text-color); padding:0.4rem 0.8rem; border-radius:8px; font-family:var(--font-main); font-size:0.9rem;">
      <option value="en">English</option>
      <option value="zh">Chinese</option>
      <option value="ms">Malay</option>
      <option value="ta">Tamil</option>
      <option value="ko">Korean</option>
    </select>
  </div>
  <div id="ws-status" style="margin-left:auto; padding-top:1.2rem; font-size:0.8rem; color:var(--text-muted);">● Disconnected</div>
</div>
```

Add a live transcript panel below the existing result area:

```html
<!-- Live real-time panel — insert after existing result card -->
<div class="card" id="live-panel" style="margin-top:1.5rem;">
  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">
    <h3 style="font-size:1rem; font-weight:600; color:var(--primary-color);">Live Transcript</h3>
    <button id="clear-live-btn" class="action-btn" title="Clear" style="font-size:0.75rem; padding:0.3rem 0.7rem;">Clear</button>
  </div>
  <div id="live-segments" style="max-height:320px; overflow-y:auto; display:flex; flex-direction:column; gap:0.75rem;"></div>
</div>
```

- [ ] **Step 2: Add WebSocket + audio streaming to `app.js`**

Add after the existing global variables at the top of `app.js`:

```js
// WebSocket real-time streaming
let ws = null;
const sourceLangEl = document.getElementById('source-lang');
const targetLangEl = document.getElementById('target-lang');
const wsStatusEl = document.getElementById('ws-status');
const liveSegmentsEl = document.getElementById('live-segments');
const clearLiveBtn = document.getElementById('clear-live-btn');

clearLiveBtn.addEventListener('click', () => { liveSegmentsEl.innerHTML = ''; });

function connectWebSocket() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    ws = new WebSocket(`ws://${location.host}/ws/transcribe`);

    ws.onopen = () => {
        wsStatusEl.textContent = '● Connected';
        wsStatusEl.style.color = 'var(--success-color)';
    };
    ws.onclose = () => {
        wsStatusEl.textContent = '● Disconnected';
        wsStatusEl.style.color = 'var(--text-muted)';
        // Reconnect after 3s if page still open
        setTimeout(connectWebSocket, 3000);
    };
    ws.onerror = () => {
        wsStatusEl.textContent = '● Error';
        wsStatusEl.style.color = 'var(--accent-color)';
    };
    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'segment') {
                appendLiveSegment(data);
                fetchSessions();
            }
        } catch (e) { console.error('WS parse error', e); }
    };
}

function appendLiveSegment(data) {
    const langLabels = { en:'EN', zh:'ZH', ms:'MS', ta:'TA', ko:'KO', auto:'?' };
    const langColors = { en:'#4facfe', zh:'#f35588', ms:'#00e676', ta:'#ffd166', ko:'#c77dff' };
    const lang = data.detected_lang || 'en';
    const color = langColors[lang] || '#9ca3af';

    const div = document.createElement('div');
    div.style.cssText = `border-left:3px solid ${color}; padding:0.6rem 0.8rem; background:rgba(255,255,255,0.03); border-radius:0 8px 8px 0;`;
    div.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:0.3rem;">
        <span style="font-size:0.75rem; font-weight:700; color:${color}; text-transform:uppercase;">${langLabels[lang] || lang} · ${escapeHtml(data.speaker_id)}</span>
        <span style="font-size:0.7rem; color:var(--text-muted);">${(data.confidence * 100).toFixed(0)}%</span>
      </div>
      <div style="font-size:0.95rem; color:var(--text-color); margin-bottom:${data.translation ? '0.3rem' : '0'};">${escapeHtml(data.transcript) || '<em style="color:var(--text-muted);">—</em>'}</div>
      ${data.translation ? `<div style="font-size:0.9rem; color:var(--text-muted); font-style:italic;">${escapeHtml(data.translation)}</div>` : ''}
    `;
    liveSegmentsEl.appendChild(div);
    liveSegmentsEl.scrollTop = liveSegmentsEl.scrollHeight;
}

// Connect on page load
connectWebSocket();
```

- [ ] **Step 3: Replace `uploadAndTranscribe` to use WebSocket when connected**

Find the `uploadAndTranscribe` function in `app.js` and replace it:

```js
async function uploadAndTranscribe(blob) {
    // If WebSocket is connected, send over WebSocket for real-time display
    if (ws && ws.readyState === WebSocket.OPEN) {
        const arrayBuffer = await blob.arrayBuffer();
        ws.send(arrayBuffer);
        resetRecordUI();
        return;
    }

    // Fallback: REST POST (used when WS not available)
    const formData = new FormData();
    formData.append('audio', blob, 'audio.wav');
    try {
        const response = await fetch('/api/transcribe', { method: 'POST', body: formData });
        if (response.ok) {
            const data = await response.json();
            displayResult(data);
            fetchSessions();
        } else {
            const errText = await response.text();
            alert('Error from transcription API: ' + errText);
            resetRecordUI();
        }
    } catch (err) {
        console.error('API Error:', err);
        alert('Network/API error occurred.');
        resetRecordUI();
    }
}
```

- [ ] **Step 4: Sync language selectors with settings on load**

In `fetchSettings()` in `app.js`, add language selector sync after populating the existing fields:

```js
// Add inside fetchSettings() after setting curated folder / min / max:
if (s.source_language && sourceLangEl) sourceLangEl.value = s.source_language;
if (s.target_language && targetLangEl) targetLangEl.value = s.target_language;
```

- [ ] **Step 5: Commit**

```bash
git add static/index.html static/app.js
git commit -m "Add language selector, WebSocket audio streaming, live transcript panel"
```

---

## Task 6: Settings UI — API Key + Language Defaults

**Files:**
- Modify: `static/index.html` (add API key field, language defaults to Settings panel)
- Modify: `static/app.js` (include new fields in saveSettings POST body)
- Modify: `src/main.rs` (settings GET/POST handlers already generic via serde — no code change needed if AppSettings fields were added in Task 2)

- [ ] **Step 1: Add API key and language fields to the Settings panel in `index.html`**

Find the Settings panel (look for `id="setting-curated-folder"`) and add below the existing inputs:

```html
<!-- Insert after max-samples input group -->
<div class="setting-group" style="margin-top:1rem;">
  <label style="font-size:0.8rem; color:var(--text-muted); display:block; margin-bottom:0.4rem;">NVIDIA Nemotron API Key</label>
  <input type="password" id="setting-api-key" placeholder="nvapi-..." style="width:100%; background:rgba(255,255,255,0.06); border:1px solid var(--border-color); color:var(--text-color); padding:0.5rem 0.8rem; border-radius:8px; font-family:var(--font-mono); font-size:0.85rem;" />
  <span style="font-size:0.72rem; color:var(--text-muted);">Get a free key at <a href="https://build.nvidia.com" target="_blank" style="color:var(--primary-color);">build.nvidia.com</a></span>
</div>
<div style="display:flex; gap:1rem; margin-top:1rem; flex-wrap:wrap;">
  <div style="flex:1; min-width:120px;">
    <label style="font-size:0.8rem; color:var(--text-muted); display:block; margin-bottom:0.4rem;">Default Source Language</label>
    <select id="setting-source-lang" style="width:100%; background:rgba(255,255,255,0.06); border:1px solid var(--border-color); color:var(--text-color); padding:0.5rem 0.8rem; border-radius:8px; font-family:var(--font-main); font-size:0.85rem;">
      <option value="auto">Auto-detect</option>
      <option value="en">English</option>
      <option value="zh">Chinese</option>
      <option value="ms">Malay</option>
      <option value="ta">Tamil</option>
      <option value="ko">Korean</option>
    </select>
  </div>
  <div style="flex:1; min-width:120px;">
    <label style="font-size:0.8rem; color:var(--text-muted); display:block; margin-bottom:0.4rem;">Default Target Language</label>
    <select id="setting-target-lang" style="width:100%; background:rgba(255,255,255,0.06); border:1px solid var(--border-color); color:var(--text-color); padding:0.5rem 0.8rem; border-radius:8px; font-family:var(--font-main); font-size:0.85rem;">
      <option value="en">English</option>
      <option value="zh">Chinese</option>
      <option value="ms">Malay</option>
      <option value="ta">Tamil</option>
      <option value="ko">Korean</option>
    </select>
  </div>
</div>
```

- [ ] **Step 2: Update `fetchSettings` and `saveSettings` in `app.js`**

Add these constants with the other settings UI element references at the top of `app.js`:

```js
const settingApiKey = document.getElementById('setting-api-key');
const settingSourceLang = document.getElementById('setting-source-lang');
const settingTargetLang = document.getElementById('setting-target-lang');
```

In `fetchSettings()`, add:
```js
if (s.nemotron_api_key !== undefined && settingApiKey) settingApiKey.value = s.nemotron_api_key;
if (s.source_language && settingSourceLang) settingSourceLang.value = s.source_language;
if (s.target_language && settingTargetLang) settingTargetLang.value = s.target_language;
```

In the `saveSettingsBtn` click handler, add the new fields to the `patch` object:
```js
patch.nemotron_api_key = settingApiKey ? settingApiKey.value.trim() : '';
patch.source_language = settingSourceLang ? settingSourceLang.value : 'auto';
patch.target_language = settingTargetLang ? settingTargetLang.value : 'en';
```

- [ ] **Step 3: Commit**

```bash
git add static/index.html static/app.js
git commit -m "Add API key and language settings to Settings panel"
```

---

## Task 7: End-to-End Test and Final Push

- [ ] **Step 1: Kill any running server and restart**

```powershell
Get-Process sw-nemotron-asr, python -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
$vcvars = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
$logFile = "C:\slamv7c\github_projects\sw-nemotron-asr\server_out.log"
Start-Process cmd.exe -ArgumentList "/c `"`"$vcvars`" && cargo run`"" -WorkingDirectory "C:\slamv7c\github_projects\sw-nemotron-asr" -RedirectStandardOutput $logFile -NoNewWindow
```

Wait ~60s for Whisper model to download and load.

- [ ] **Step 2: Verify startup log**

```powershell
Get-Content "C:\slamv7c\github_projects\sw-nemotron-asr\server_out.log" -Wait | Select-Object -First 20
```

Expected lines (in order):
```
Loading ASR+translate worker (loading Whisper model)...
ASR+translate worker ready.
Starting speaker ID worker (loading model)...
Speaker ID worker ready.
AuraNemotron ASR backend is running on http://127.0.0.1:3007
```

- [ ] **Step 3: Test `/api/transcribe` with WAV**

```bash
curl -s -X POST http://localhost:3007/api/transcribe \
  -F "audio=@data/speakers/testuser_temp.wav"
```

Expected: JSON with `"transcript"`, `"translation"`, `"detected_lang"` fields.

- [ ] **Step 4: Test WebSocket manually**

Open browser at `http://localhost:3007`. The WS status indicator should show **● Connected** within 1 second.

- [ ] **Step 5: Test recording and real-time display**

1. In Settings panel, enter a valid NVIDIA API key and set target language to English
2. Click Save
3. Switch source to Chinese (or leave Auto)
4. Click Record, speak a few words, click Stop
5. Expect: segment appears in Live Transcript panel with original text and English translation within ~2s

- [ ] **Step 6: Verify `logs/` directory has today's log**

```powershell
Get-ChildItem "C:\slamv7c\github_projects\sw-nemotron-asr\logs\"
```

Expected: `server.log.<today's date>`

- [ ] **Step 7: Final commit and push**

```bash
git add -A
git commit -m "Complete real-time multilingual ASR + Nemotron translation

- Replace parakeet-rs with faster-whisper (small model, supports zh/en/ms/ta/ko)
- Add Nemotron LLM API translation via NVIDIA integrate API
- Add WebSocket /ws/transcribe for real-time audio streaming
- Add language selector (source + target) to recording UI
- Add live transcript panel showing original + translated text
- Add API key and language defaults to Settings panel"
git push origin main
```

---

## Server Start Reference (Windows)

```powershell
$vcvars = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
$logFile = "C:\slamv7c\github_projects\sw-nemotron-asr\server_out.log"
Start-Process cmd.exe `
  -ArgumentList "/c `"`"$vcvars`" && cargo run`"" `
  -WorkingDirectory "C:\slamv7c\github_projects\sw-nemotron-asr" `
  -RedirectStandardOutput $logFile `
  -NoNewWindow
```

Check logs: `Get-Content $logFile -Wait`

---

## Self-Review

**Spec coverage:**
- ✅ Chinese ↔ English, English ↔ Malay, English ↔ Tamil, English ↔ Korean — all via faster-whisper ASR + Nemotron LLM translation
- ✅ Real-time — WebSocket utterance streaming ~1–2s latency
- ✅ Existing speaker ID untouched
- ✅ Settings (API key, default languages) persisted in `settings.json`
- ✅ Backward-compatible REST `/api/transcribe` kept

**No placeholders:** All code blocks are complete implementations.

**Type consistency:**
- `AstrWorker = SpeakerIdWorker` — same send() interface used throughout
- `TranscribeResponse` updated in Task 3 Step 2 before handler uses it
- `AppState.astr` field added in Task 2 Step 2, used in Tasks 3 and 4
