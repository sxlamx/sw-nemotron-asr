use axum::{
    extract::{DefaultBodyLimit, Multipart, State},
    http::{header, Method, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Child;
use tokio::sync::Mutex;
use parakeet_rs::Nemotron;
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

struct AppState {
    model: Mutex<Nemotron>,
    speaker_id: Mutex<SpeakerIdWorker>,
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
    speaker_id: String,
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
    println!("Starting speaker ID worker (loading model)...");
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

    println!("Speaker ID worker ready.");
    Ok(SpeakerIdWorker { _child: child, stdin, stdout })
}

#[tokio::main]
async fn main() {
    println!("Loading Nemotron ASR model from ./models...");
    let model = match Nemotron::from_pretrained("models", None) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("Failed to load Nemotron model: {:?}", e);
            eprintln!("Ensure encoder.onnx, decoder_joint.onnx, and tokenizer.model are present in ./models");
            return;
        }
    };
    println!("Nemotron ASR model loaded successfully!");

    std::fs::create_dir_all("data/sessions").unwrap();
    std::fs::create_dir_all("data/speakers").unwrap();

    let python_path = get_python_path();
    let worker = match spawn_speaker_id_worker(python_path).await {
        Ok(w) => w,
        Err(e) => {
            eprintln!("Failed to start speaker ID worker: {:?}", e);
            return;
        }
    };

    let shared_state = Arc::new(AppState {
        model: Mutex::new(model),
        speaker_id: Mutex::new(worker),
    });

    let cors = tower_http::cors::CorsLayer::new()
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE])
        .allow_origin(tower_http::cors::Any);

    let app = Router::new()
        .route("/api/transcribe", post(transcribe_handler))
        .route("/api/speakers/enroll", post(enroll_handler))
        .route("/api/speakers/aliases", get(get_aliases_handler).post(update_aliases_handler))
        .layer(DefaultBodyLimit::max(20 * 1024 * 1024))
        .layer(cors)
        .nest_service("/", tower_http::services::ServeDir::new("static"))
        .with_state(shared_state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:3007").await.unwrap();
    println!("AuraNemotron ASR backend is running on http://127.0.0.1:3007");
    axum::serve(listener, app).await.unwrap();
}

async fn transcribe_handler(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Result<Json<TranscribeResponse>, (StatusCode, String)> {
    println!("POST /api/transcribe");
    let mut audio_bytes = Vec::new();

    while let Ok(Some(field)) = multipart.next_field().await {
        if field.name() == Some("audio") {
            if let Ok(bytes) = field.bytes().await {
                audio_bytes = bytes.to_vec();
            }
        }
    }

    if audio_bytes.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Missing audio file field".to_string()));
    }

    let session_id = Uuid::new_v4().to_string();
    let session_dir = format!("data/sessions/{}", session_id);
    std::fs::create_dir_all(&session_dir)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let audio_path = format!("{}/audio.wav", session_dir);
    std::fs::write(&audio_path, &audio_bytes)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let transcript = {
        let mut model = state.model.lock().await;
        model.transcribe_file(&audio_path)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("ASR failed: {:?}", e)))?
    };
    let transcript_trimmed = transcript.trim().to_string();
    let _ = std::fs::write(format!("{}/transcript.txt", session_dir), &transcript_trimmed);

    let speaker_id = {
        let mut worker = state.speaker_id.lock().await;
        match worker.send(&format!("identify {}\n", audio_path)).await {
            Ok(resp) => {
                println!("Speaker ID: {}", resp);
                if resp.starts_with("IDENTIFIED:") {
                    resp.split(':').nth(1).unwrap_or("Unknown").to_string()
                } else {
                    eprintln!("Speaker ID error: {}", resp);
                    "Unknown".to_string()
                }
            }
            Err(e) => {
                eprintln!("Speaker ID worker error: {}", e);
                "Unknown".to_string()
            }
        }
    };

    println!("POST /api/transcribe -> session={} speaker={} transcript={:?}",
        session_id, speaker_id, transcript_trimmed);
    Ok(Json(TranscribeResponse { session_id, transcript: transcript_trimmed, speaker_id }))
}

async fn enroll_handler(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Result<StatusCode, (StatusCode, String)> {
    println!("POST /api/speakers/enroll");
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

    println!("POST /api/speakers/enroll -> enrolled '{}' as '{}'", speaker_id, display_name);
    Ok(StatusCode::OK)
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
