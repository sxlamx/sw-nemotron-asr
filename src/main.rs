use chrono::Local;
use tracing::{error, info, warn};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt};
use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, DefaultBodyLimit, Multipart, Path, State},
    http::{header, Method, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Child;
use tokio::sync::Mutex;
use uuid::Uuid;

struct SpeakerIdWorker {
    _child: Child,
    stdin: tokio::io::BufWriter<tokio::process::ChildStdin>,
    stdout: BufReader<tokio::process::ChildStdout>,
}

impl SpeakerIdWorker {
    async fn send(&mut self, cmd: &str) -> Result<String, std::io::Error> {
        self.stdin.write_all(cmd.as_bytes()).await?;
        self.stdin.flush().await?;
        let mut line = String::new();
        self.stdout.read_line(&mut line).await?;
        Ok(line.trim().to_string())
    }
}

// Re-use same stdin/stdout subprocess protocol for the ASR+translate worker
type AstrWorker = SpeakerIdWorker;

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
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

struct AppState {
    speaker_id: Mutex<SpeakerIdWorker>,
    astr: Mutex<AstrWorker>,
    settings: Mutex<AppSettings>,
}

#[derive(Deserialize, Serialize, Clone)]
struct SpeakerUpdate {
    id: String,
    name: String,
    aliases: Vec<String>,
}

#[derive(Serialize)]
struct TranscribeResponse {
    session_id: String,
    transcript: String,
    translation: String,
    detected_lang: String,
    speaker_id: String,
    confidence: f64,
}

#[derive(Serialize)]
struct SessionInfo {
    session_id: String,
    timestamp: String,
    transcript: String,
    speaker_id: String,
    confidence: f64,
    audio_url: String,
    confirmed: bool,
}

#[derive(Serialize)]
struct EnrollResponse {
    sample_count: usize,
}

fn get_python_path() -> &'static str {
    if cfg!(target_os = "windows") {
        ".venv/Scripts/python.exe"
    } else {
        ".venv/bin/python"
    }
}

async fn spawn_speaker_id_worker(
    python_path: &str,
) -> Result<SpeakerIdWorker, Box<dyn std::error::Error + Send + Sync>> {
    info!("Starting speaker ID worker (loading model)...");
    let mut child = tokio::process::Command::new(python_path)
        .args(["scripts/speaker_id.py", "persist"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()?;

    let stdin = tokio::io::BufWriter::new(
        child.stdin.take().ok_or("failed to open worker stdin")?,
    );
    let mut stdout = BufReader::new(
        child.stdout.take().ok_or("failed to open worker stdout")?,
    );

    let mut ready = String::new();
    stdout.read_line(&mut ready).await?;
    if ready.trim() != "READY" {
        return Err(format!("worker did not send READY (got: {:?})", ready.trim()).into());
    }

    info!("Speaker ID worker ready.");
    Ok(SpeakerIdWorker { _child: child, stdin, stdout })
}

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

fn load_or_create_settings() -> AppSettings {
    let path = "settings.json";
    if let Ok(content) = std::fs::read_to_string(path) {
        if let Ok(s) = serde_json::from_str::<AppSettings>(&content) {
            return s;
        }
    }
    let defaults = AppSettings::default();
    if let Ok(json) = serde_json::to_string_pretty(&defaults) {
        let _ = std::fs::write(path, json);
    }
    defaults
}

async fn scan_and_enroll_curated(worker: &mut SpeakerIdWorker, curated_folder: &str) {
    let manifest_path = format!("{}/.enrolled", curated_folder);
    let enrolled: std::collections::HashSet<String> = std::fs::read_to_string(&manifest_path)
        .unwrap_or_default()
        .lines()
        .map(|l| l.to_string())
        .collect();

    let mut manifest_file = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&manifest_path)
    {
        Ok(f) => f,
        Err(e) => {
            error!("Failed to open curated manifest: {}", e);
            return;
        }
    };

    if let Ok(speaker_dirs) = std::fs::read_dir(curated_folder) {
        for speaker_entry in speaker_dirs.flatten() {
            if !speaker_entry.path().is_dir() { continue; }
            let speaker_id = speaker_entry.file_name().to_string_lossy().to_string();
            if let Ok(wav_files) = std::fs::read_dir(speaker_entry.path()) {
                for wav_entry in wav_files.flatten() {
                    let wav_path = wav_entry.path().to_string_lossy().replace('\\', "/");
                    if !wav_path.ends_with(".wav") { continue; }
                    if enrolled.contains(&wav_path) { continue; }
                    let cmd = format!("enroll {} {}\n", speaker_id, wav_path);
                    match worker.send(&cmd).await {
                        Ok(resp) => {
                            info!("Curated enroll {}: {}", wav_path, resp);
                            let _ = writeln!(manifest_file, "{}", wav_path);
                        }
                        Err(e) => error!("Curated enroll error for {}: {}", wav_path, e),
                    }
                }
            }
        }
    }
}

#[tokio::main]
async fn main() {
    // Logs to terminal (with colour) AND logs/server.log.YYYY-MM-DD (plain text, date-rolled)
    std::fs::create_dir_all("logs").ok();
    let file_appender = tracing_appender::rolling::daily("logs", "server.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);
    tracing_subscriber::registry()
        .with(fmt::layer().with_writer(std::io::stdout))
        .with(fmt::layer().with_writer(non_blocking).with_ansi(false))
        .init();

    std::fs::create_dir_all("data/sessions").unwrap();
    std::fs::create_dir_all("data/speakers").unwrap();

    let settings_val = load_or_create_settings();
    std::fs::create_dir_all(&settings_val.curated_audio_folder).unwrap();

    let python_path = get_python_path();
    let mut worker = match spawn_speaker_id_worker(python_path).await {
        Ok(w) => w,
        Err(e) => {
            error!("Failed to start speaker ID worker: {:?}", e);
            return;
        }
    };

    let astr_worker = match spawn_astr_worker(python_path).await {
        Ok(w) => w,
        Err(e) => {
            error!("Failed to start ASR+translate worker: {:?}", e);
            return;
        }
    };

    // Auto-enroll any unprocessed curated WAVs before wrapping worker in Arc
    let settings_for_scan = settings_val.curated_audio_folder.clone();
    scan_and_enroll_curated(&mut worker, &settings_for_scan).await;

    let shared_state = Arc::new(AppState {
        speaker_id: Mutex::new(worker),
        astr: Mutex::new(astr_worker),
        settings: Mutex::new(settings_val),
    });

    let cors = tower_http::cors::CorsLayer::new()
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE])
        .allow_origin(tower_http::cors::Any);

    let app = Router::new()
        .route("/ws/transcribe", get(ws_transcribe_handler))
        .route("/api/transcribe", post(transcribe_handler))
        .route("/api/speakers/enroll", post(enroll_handler))
        .route("/api/speakers/aliases", get(get_aliases_handler).post(update_aliases_handler))
        .route("/api/speakers/learn", post(learn_from_curated_handler))
        .route("/api/sessions", get(get_sessions_handler))
        .route("/api/sessions/:session_id/confirm", post(confirm_session_handler))
        .route("/api/settings", get(get_settings_handler).post(update_settings_handler))
        .route("/api/translate", post(translate_handler))
        .layer(DefaultBodyLimit::max(20 * 1024 * 1024))
        .layer(cors)
        .nest_service("/data", tower_http::services::ServeDir::new("data"))
        .nest_service("/", tower_http::services::ServeDir::new("static"))
        .with_state(shared_state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:3007").await.unwrap();
    info!("AuraNemotron ASR backend is running on http://127.0.0.1:3007");
    axum::serve(listener, app).await.unwrap();
}

async fn get_sessions_handler(
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let mut sessions: Vec<SessionInfo> = Vec::new();

    let settings = state.settings.lock().await;
    let curated_folder = settings.curated_audio_folder.clone();
    drop(settings);

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
            let confidence = std::fs::read_to_string(entry.path().join("confidence.txt"))
                .unwrap_or_else(|_| "0.0".to_string())
                .trim()
                .parse::<f64>()
                .unwrap_or(0.0);

            let confirmed_path = format!("{}/{}/{}.wav", curated_folder, speaker_id, name);
            let confirmed = std::path::Path::new(&confirmed_path).exists();

            sessions.push(SessionInfo {
                audio_url: format!("/data/sessions/{}/audio.wav", name),
                session_id: name,
                timestamp,
                transcript,
                speaker_id,
                confidence,
                confirmed,
            });
        }
    }

    // Newest first
    sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Json(sessions)
}

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

    // Get settings once
    let (source_lang, target_lang, api_key) = {
        let s = state.settings.lock().await;
        (s.source_language.clone(), s.target_language.clone(), s.nemotron_api_key.clone())
    };

    // Transcribe via faster-whisper worker
    let (transcript, detected_lang) = {
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

    let transcript_trimmed = transcript.trim().to_string();

    // Translate via Nemotron API (skip if no key, same language, or empty transcript)
    let translation = {
        if !api_key.is_empty() && detected_lang != target_lang && !transcript_trimmed.is_empty() {
            let req = serde_json::json!({
                "cmd": "translate",
                "text": transcript_trimmed,
                "source_lang": detected_lang,
                "target_lang": target_lang,
                "api_key": api_key,
            });
            let mut astr = state.astr.lock().await;
            match astr.send(&format!("{}\n", req)).await {
                Ok(resp) => {
                    match serde_json::from_str::<serde_json::Value>(&resp) {
                        Ok(v) if v["status"] == "ok" => {
                            v["translation"].as_str().unwrap_or("").to_string()
                        }
                        Ok(v) => {
                            warn!("Translate worker error: {}", v["message"]);
                            String::new()
                        }
                        Err(e) => {
                            error!("Translate parse error: {}", e);
                            String::new()
                        }
                    }
                }
                Err(e) => { error!("Translate send error: {}", e); String::new() }
            }
        } else {
            String::new()
        }
    };

    // Persist session files
    let _ = std::fs::write(format!("{}/transcript.txt", session_dir), &transcript_trimmed);
    let _ = std::fs::write(format!("{}/detected_lang.txt", session_dir), &detected_lang);
    if !translation.is_empty() {
        let _ = std::fs::write(format!("{}/translation.txt", session_dir), &translation);
    }

    // Speaker ID (runs against same audio file)
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

async fn enroll_handler(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Result<Json<EnrollResponse>, (StatusCode, String)> {
    info!("POST /api/speakers/enroll");
    let mut audio_bytes = Vec::new();
    let mut speaker_id = String::new();
    let mut display_name = String::new();
    let mut aliases_str = String::new();

    while let Ok(Some(field)) = multipart.next_field().await {
        if let Some(name) = field.name() {
            match name {
                "audio"   => { if let Ok(b) = field.bytes().await { audio_bytes = b.to_vec(); } }
                "id"      => { if let Ok(t) = field.text().await  { speaker_id = t.trim().to_string(); } }
                "name"    => { if let Ok(t) = field.text().await  { display_name = t.trim().to_string(); } }
                "aliases" => { if let Ok(t) = field.text().await  { aliases_str = t.trim().to_string(); } }
                _ => {}
            }
        }
    }

    if audio_bytes.is_empty() || speaker_id.is_empty() || display_name.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Missing required fields (audio, id, name)".to_string()));
    }

    if !speaker_id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return Err((StatusCode::BAD_REQUEST, "speaker_id may only contain alphanumeric characters, hyphens, and underscores".to_string()));
    }

    let temp_path = format!("data/speakers/{}_temp.wav", speaker_id);
    std::fs::write(&temp_path, &audio_bytes)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let result = {
        let mut worker = state.speaker_id.lock().await;
        worker.send(&format!("enroll {} {}\n", speaker_id, temp_path)).await
            .unwrap_or_else(|e| format!("ERROR:{}", e))
    };

    let _ = std::fs::remove_file(&temp_path);

    if result.starts_with("ERROR") {
        return Err((StatusCode::INTERNAL_SERVER_ERROR, format!("Enrollment failed: {}", result)));
    }

    let sample_count = result
        .split(":count=")
        .nth(1)
        .and_then(|s| s.split(':').next()?.parse::<usize>().ok())
        .unwrap_or(0);

    let aliases: Vec<String> = aliases_str
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let aliases_path = "data/speakers/aliases.json";
    let mut map: serde_json::Value = if std::path::Path::new(aliases_path).exists() {
        let c = std::fs::read_to_string(aliases_path)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        serde_json::from_str(&c).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    map[&speaker_id] = serde_json::json!({ "name": display_name, "aliases": aliases });
    std::fs::write(aliases_path, serde_json::to_string_pretty(&map)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    info!("POST /api/speakers/enroll -> enrolled '{}' as '{}'", speaker_id, display_name);
    Ok(Json(EnrollResponse { sample_count }))
}

async fn get_aliases_handler() -> impl IntoResponse {
    let path = "data/speakers/aliases.json";
    if std::path::Path::new(path).exists() {
        match std::fs::read_to_string(path) {
            Ok(c) => (StatusCode::OK, [("content-type", "application/json")], c),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, [("content-type", "text/plain")], e.to_string()),
        }
    } else {
        (StatusCode::OK, [("content-type", "application/json")], "{}".to_string())
    }
}

async fn update_aliases_handler(
    Json(payload): Json<SpeakerUpdate>,
) -> Result<StatusCode, (StatusCode, String)> {
    let path = "data/speakers/aliases.json";
    let mut map: serde_json::Value = if std::path::Path::new(path).exists() {
        let c = std::fs::read_to_string(path)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        serde_json::from_str(&c).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    map[payload.id] = serde_json::json!({ "name": payload.name, "aliases": payload.aliases });
    std::fs::write(path, serde_json::to_string_pretty(&map)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(StatusCode::OK)
}

async fn translate_handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let text = body["text"].as_str().unwrap_or("").to_string();
    let source_lang = body["source_lang"].as_str().unwrap_or("auto").to_string();
    let target_lang = body["target_lang"].as_str().unwrap_or("en").to_string();
    if text.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "text is required".to_string()));
    }
    let api_key = state.settings.lock().await.nemotron_api_key.clone();
    if api_key.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "NVIDIA API key not configured in Settings".to_string()));
    }
    let req = serde_json::json!({
        "cmd": "translate",
        "text": text,
        "source_lang": source_lang,
        "target_lang": target_lang,
        "api_key": api_key,
    });
    let resp = {
        let mut astr = state.astr.lock().await;
        astr.send(&format!("{}\n", req)).await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    };
    let v: Value = serde_json::from_str(&resp)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if v["status"] == "ok" {
        Ok(Json(serde_json::json!({"translation": v["translation"]})))
    } else {
        Err((StatusCode::BAD_GATEWAY, v["message"].as_str().unwrap_or("translation failed").to_string()))
    }
}

async fn get_settings_handler(
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let settings = state.settings.lock().await.clone();
    // Mask the API key — never return the raw value to the browser
    let key_indicator = if settings.nemotron_api_key.is_empty() { "" } else { "****" };
    Json(serde_json::json!({
        "curated_audio_folder": settings.curated_audio_folder,
        "min_enrollment_samples": settings.min_enrollment_samples,
        "max_enrollment_samples": settings.max_enrollment_samples,
        "nemotron_api_key": key_indicator,
        "source_language": settings.source_language,
        "target_language": settings.target_language,
    }))
}

async fn update_settings_handler(
    State(state): State<Arc<AppState>>,
    Json(patch): Json<Value>,
) -> Result<Json<AppSettings>, (StatusCode, String)> {
    let mut settings = state.settings.lock().await;
    // Merge patch fields
    if let Some(v) = patch.get("curated_audio_folder").and_then(|v| v.as_str()) {
        settings.curated_audio_folder = v.to_string();
    }
    if let Some(v) = patch.get("min_enrollment_samples").and_then(|v| v.as_u64()) {
        settings.min_enrollment_samples = v as usize;
    }
    if let Some(v) = patch.get("max_enrollment_samples").and_then(|v| v.as_u64()) {
        settings.max_enrollment_samples = v as usize;
    }
    if let Some(v) = patch.get("nemotron_api_key").and_then(|v| v.as_str()) {
        settings.nemotron_api_key = v.to_string();
    }
    let valid_langs = ["auto", "en", "zh", "ms", "ta", "ko"];
    if let Some(v) = patch.get("source_language").and_then(|v| v.as_str()) {
        if valid_langs.contains(&v) {
            settings.source_language = v.to_string();
        }
    }
    let valid_target_langs = ["en", "zh", "ms", "ta", "ko"];
    if let Some(v) = patch.get("target_language").and_then(|v| v.as_str()) {
        if valid_target_langs.contains(&v) {
            settings.target_language = v.to_string();
        }
    }
    let updated = settings.clone();
    drop(settings);
    // Persist
    let json = serde_json::to_string_pretty(&updated)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    std::fs::write("settings.json", json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(updated))
}

async fn confirm_session_handler(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<EnrollResponse>, (StatusCode, String)> {
    // Reject session_id containing anything other than alphanumeric, hyphen, underscore
    if !session_id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return Err((StatusCode::BAD_REQUEST, "Invalid session_id".to_string()));
    }
    let session_dir = format!("data/sessions/{}", session_id);
    let speaker_id = std::fs::read_to_string(format!("{}/speaker.txt", session_dir))
        .map_err(|_| (StatusCode::NOT_FOUND, "Session not found".to_string()))?
        .trim()
        .to_string();
    if speaker_id == "Unknown" || speaker_id.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Cannot confirm session with unknown speaker".to_string()));
    }

    let curated_folder = state.settings.lock().await.curated_audio_folder.clone();
    let dest_dir = format!("{}/{}", curated_folder, speaker_id);
    std::fs::create_dir_all(&dest_dir)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let src = format!("{}/audio.wav", session_dir);
    let dest = format!("{}/{}.wav", dest_dir, session_id);
    std::fs::copy(&src, &dest)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Append to manifest
    let manifest_path = format!("{}/.enrolled", curated_folder);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&manifest_path) {
        let _ = writeln!(f, "{}", dest);
    }

    let result = {
        let mut worker = state.speaker_id.lock().await;
        worker.send(&format!("enroll {} {}\n", speaker_id, dest)).await
            .unwrap_or_else(|e| format!("ERROR:{}", e))
    };

    if result.starts_with("ERROR") {
        return Err((StatusCode::INTERNAL_SERVER_ERROR, format!("Enrollment failed: {}", result)));
    }

    let sample_count = result
        .split(":count=")
        .nth(1)
        .and_then(|s| s.split(':').next()?.parse::<usize>().ok())
        .unwrap_or(0);

    info!("Confirmed session {} -> enrolled into speaker '{}'", session_id, speaker_id);
    Ok(Json(EnrollResponse { sample_count }))
}

async fn learn_from_curated_handler(
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let curated_folder = state.settings.lock().await.curated_audio_folder.clone();
    let mut worker = state.speaker_id.lock().await;
    scan_and_enroll_curated(&mut worker, &curated_folder).await;
    StatusCode::OK
}

async fn ws_transcribe_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| ws_transcribe_loop(socket, state))
}

async fn ws_transcribe_loop(mut socket: WebSocket, state: Arc<AppState>) {
    loop {
        let msg = match socket.recv().await {
            Some(Ok(m)) => m,
            Some(Err(e)) => { error!("WS recv error: {}", e); break; }
            None => break,
        };

        let audio_bytes = match msg {
            Message::Binary(bytes) => bytes,
            Message::Close(_) => break,
            _ => continue, // ignore text, ping, pong
        };

        // Write audio to a flat temp file (no session directory)
        let audio_path = format!("data/sessions/ws_{}.wav", Uuid::new_v4());
        let _ = std::fs::create_dir_all("data/sessions");
        if let Err(e) = std::fs::write(&audio_path, &audio_bytes) {
            let errmsg = format!("Failed to write audio: {}", e);
            error!("WS: {}", errmsg);
            let _ = socket.send(Message::Text(
                serde_json::json!({"status":"error","message":errmsg}).to_string()
            )).await;
            continue;
        }

        // Read settings once; drop lock immediately
        let (source_lang, target_lang, api_key) = {
            let s = state.settings.lock().await;
            (s.source_language.clone(), s.target_language.clone(), s.nemotron_api_key.clone())
        };

        // Transcribe — acquire and release the astr lock before any further awaits
        let astr_req = serde_json::json!({
            "cmd": "transcribe",
            "audio_path": audio_path,
            "source_lang": source_lang,
        }).to_string();
        let astr_resp = {
            let mut astr = state.astr.lock().await;
            astr.send(&format!("{}\n", astr_req)).await
        };

        let (transcript_trimmed, detected_lang) = match astr_resp {
            Ok(resp) => match serde_json::from_str::<Value>(&resp) {
                Ok(v) if v["status"] == "ok" => (
                    v["text"].as_str().unwrap_or("").trim().to_string(),
                    v["detected_lang"].as_str().unwrap_or("en").to_string(),
                ),
                Ok(v) => {
                    let errmsg = v["message"].as_str().unwrap_or("ASR error").to_string();
                    warn!("WS ASR error: {}", errmsg);
                    let _ = socket.send(Message::Text(
                        serde_json::json!({"status":"error","message":errmsg}).to_string()
                    )).await;
                    let _ = std::fs::remove_file(&audio_path);
                    continue;
                }
                Err(e) => {
                    let errmsg = format!("ASR parse error: {}", e);
                    error!("WS {}", errmsg);
                    let _ = socket.send(Message::Text(
                        serde_json::json!({"status":"error","message":errmsg}).to_string()
                    )).await;
                    let _ = std::fs::remove_file(&audio_path);
                    continue;
                }
            },
            Err(e) => {
                let errmsg = format!("ASR error: {}", e);
                error!("WS {}", errmsg);
                let _ = socket.send(Message::Text(
                    serde_json::json!({"status":"error","message":errmsg}).to_string()
                )).await;
                let _ = std::fs::remove_file(&audio_path);
                continue;
            }
        };

        // Translate via Nemotron (skip if no key, same lang, or empty transcript)
        let translation = if !api_key.is_empty()
            && detected_lang != target_lang
            && !transcript_trimmed.is_empty()
        {
            let trans_req = serde_json::json!({
                "cmd": "translate",
                "text": transcript_trimmed,
                "source_lang": detected_lang,
                "target_lang": target_lang,
                "api_key": api_key,
            }).to_string();
            let trans_resp = {
                let mut astr = state.astr.lock().await;
                astr.send(&format!("{}\n", trans_req)).await
            };
            match trans_resp {
                Ok(resp) => match serde_json::from_str::<Value>(&resp) {
                    Ok(v) if v["status"] == "ok" => {
                        v["translation"].as_str().unwrap_or("").to_string()
                    }
                    Ok(v) => { warn!("WS translate error: {}", v["message"]); String::new() }
                    Err(e) => { error!("WS translate parse: {}", e); String::new() }
                },
                Err(e) => { error!("WS translate send: {}", e); String::new() }
            }
        } else {
            String::new()
        };

        // Speaker ID — acquire and release lock before cleanup
        let spk_resp = {
            let mut worker = state.speaker_id.lock().await;
            worker.send(&format!("identify {}\n", audio_path)).await
        };
        let (speaker_id, confidence) = match spk_resp {
            Ok(resp) if resp.starts_with("IDENTIFIED:") => {
                let parts: Vec<&str> = resp.split(':').collect();
                let speaker = parts.get(1).unwrap_or(&"Unknown").to_string();
                let conf = parts.get(2).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
                (speaker, conf)
            }
            Ok(resp) => { warn!("WS speaker ID unexpected: {}", resp); ("Unknown".to_string(), 0.0) }
            Err(e) => { error!("WS speaker ID error: {}", e); ("Unknown".to_string(), 0.0) }
        };

        // Delete the temp WAV
        let _ = std::fs::remove_file(&audio_path);

        // Send JSON response frame
        let response = serde_json::json!({
            "status": "ok",
            "transcript": transcript_trimmed,
            "translation": translation,
            "detected_lang": detected_lang,
            "speaker_id": speaker_id,
            "confidence": confidence,
        }).to_string();

        if let Err(e) = socket.send(Message::Text(response)).await {
            error!("WS send error: {}", e);
            break;
        }
        info!("WS frame processed: speaker={} lang={} confidence={:.4} transcript={:?}",
            speaker_id, detected_lang, confidence, transcript_trimmed);
    }
}
