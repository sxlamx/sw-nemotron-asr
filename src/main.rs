use axum::{
    extract::{DefaultBodyLimit, Multipart, State},
    http::{header, Method, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;
use parakeet_rs::Nemotron;
use uuid::Uuid;

struct AppState {
    model: Mutex<Nemotron>,
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

#[tokio::main]
async fn main() {
    println!("Loading Nemotron ASR model from ./models...");
    // Load Nemotron model
    // Loader auto-detects english/multilingual based on files in folder
    let model = match Nemotron::from_pretrained("models", None) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("Failed to load Nemotron model: {:?}", e);
            eprintln!("Ensure encoder.onnx, decoder_joint.onnx, and tokenizer.model are present in ./models");
            return;
        }
    };
    println!("Nemotron ASR model loaded successfully!");

    let shared_state = Arc::new(AppState {
        model: Mutex::new(model),
    });

    // Create directories
    std::fs::create_dir_all("data/sessions").unwrap();
    std::fs::create_dir_all("data/speakers").unwrap();

    let cors = tower_http::cors::CorsLayer::new()
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE])
        .allow_origin(tower_http::cors::Any);

    // Setup routes
    let app = Router::new()
        .route("/api/transcribe", post(transcribe_handler))
        .route("/api/speakers/enroll", post(enroll_handler))
        .route("/api/speakers/aliases", get(get_aliases_handler).post(update_aliases_handler))
        .layer(DefaultBodyLimit::max(20 * 1024 * 1024)) // limit payload to 20MB
        .layer(cors)
        .nest_service("/", tower_http::services::ServeDir::new("static"))
        .with_state(shared_state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:3007").await.unwrap();
    println!("AuraNemotron ASR backend is running on http://127.0.0.1:3007");
    axum::serve(listener, app).await.unwrap();
}

// Subprocess python path resolver
fn get_python_path() -> &'static str {
    if cfg!(target_os = "windows") {
        ".venv/Scripts/python.exe"
    } else {
        ".venv/bin/python"
    }
}

// Handle voice transcription request
async fn transcribe_handler(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Result<Json<TranscribeResponse>, (StatusCode, String)> {
    let mut audio_bytes = Vec::new();

    while let Ok(Some(field)) = multipart.next_field().await {
        if let Some(name) = field.name() {
            if name == "audio" {
                if let Ok(bytes) = field.bytes().await {
                    audio_bytes = bytes.to_vec();
                }
            }
        }
    }

    if audio_bytes.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Missing audio file field".to_string()));
    }

    // Session setup
    let session_id = Uuid::new_v4().to_string();
    let session_dir = format!("data/sessions/{}", session_id);
    std::fs::create_dir_all(&session_dir)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let audio_path = format!("{}/audio.wav", session_dir);
    std::fs::write(&audio_path, &audio_bytes)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Run ASR transcription directly on the file (Mutex locked)
    let mut model = state.model.lock().await;
    let transcript = model.transcribe_file(&audio_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("ASR transcription failed: {:?}", e)))?;

    let transcript_trimmed = transcript.trim().to_string();
    
    // Save transcript to disk
    let transcript_path = format!("{}/transcript.txt", session_dir);
    let _ = std::fs::write(transcript_path, &transcript_trimmed);


    // Run speaker identification subprocess
    let python_path = get_python_path();
    let speaker_id = match tokio::process::Command::new(python_path)
        .args(["scripts/speaker_id.py", "identify", &audio_path])
        .output()
        .await
    {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stdout_trimmed = stdout.trim();
            println!("Speaker ID output: {}", stdout_trimmed);
            
            if stdout_trimmed.starts_with("IDENTIFIED:") {
                let parts: Vec<&str> = stdout_trimmed.split(':').collect();
                if parts.len() >= 2 {
                    parts[1].to_string()
                } else {
                    "Unknown".to_string()
                }
            } else {
                "Unknown".to_string()
            }
        }
        Err(e) => {
            eprintln!("Failed to run speaker identification python script: {:?}", e);
            "Unknown".to_string()
        }
    };

    Ok(Json(TranscribeResponse {
        session_id,
        transcript: transcript_trimmed,
        speaker_id,
    }))
}

// Enroll new speaker profile
async fn enroll_handler(
    mut multipart: Multipart,
) -> Result<StatusCode, (StatusCode, String)> {
    let mut audio_bytes = Vec::new();
    let mut speaker_id = String::new();
    let mut display_name = String::new();
    let mut aliases_str = String::new();

    while let Ok(Some(field)) = multipart.next_field().await {
        if let Some(name) = field.name() {
            match name {
                "audio" => {
                    if let Ok(bytes) = field.bytes().await {
                        audio_bytes = bytes.to_vec();
                    }
                }
                "id" => {
                    if let Ok(text) = field.text().await {
                        speaker_id = text.trim().to_string();
                    }
                }
                "name" => {
                    if let Ok(text) = field.text().await {
                        display_name = text.trim().to_string();
                    }
                }
                "aliases" => {
                    if let Ok(text) = field.text().await {
                        aliases_str = text.trim().to_string();
                    }
                }
                _ => {}
            }
        }
    }

    if audio_bytes.is_empty() || speaker_id.is_empty() || display_name.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Missing required fields (audio, id, name)".to_string()));
    }

    // Save temporary audio file for embedding extraction
    let temp_audio_path = format!("data/speakers/{}_temp.wav", speaker_id);
    std::fs::write(&temp_audio_path, &audio_bytes)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Invoke python script to extract embedding and save
    let python_path = get_python_path();
    let status = match tokio::process::Command::new(python_path)
        .args(["scripts/speaker_id.py", "enroll", &speaker_id, &temp_audio_path])
        .status()
        .await
    {
        Ok(s) => s,
        Err(e) => {
            let _ = std::fs::remove_file(&temp_audio_path);
            return Err((StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to run speaker enrollment script: {:?}", e)));
        }
    };

    // Clean up temporary WAV file
    let _ = std::fs::remove_file(&temp_audio_path);

    if !status.success() {
        return Err((StatusCode::INTERNAL_SERVER_ERROR, "Python enrollment script returned an error code".to_string()));
    }

    // Update aliases.json
    let aliases: Vec<String> = aliases_str
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let aliases_path = "data/speakers/aliases.json";
    let mut map: serde_json::Value = if std::path::Path::new(aliases_path).exists() {
        let content = std::fs::read_to_string(aliases_path).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    map[speaker_id] = serde_json::json!({
        "name": display_name,
        "aliases": aliases
    });

    let updated_content = serde_json::to_string_pretty(&map).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    std::fs::write(aliases_path, updated_content).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(StatusCode::OK)
}

// Retrieve speaker aliases map
async fn get_aliases_handler() -> impl IntoResponse {
    let path = "data/speakers/aliases.json";
    if std::path::Path::new(path).exists() {
        match std::fs::read_to_string(path) {
            Ok(content) => (StatusCode::OK, [("content-type", "application/json")], content),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, [("content-type", "text/plain")], e.to_string()),
        }
    } else {
        (StatusCode::OK, [("content-type", "application/json")], "{}".to_string())
    }
}

// Update speaker aliases metadata directly
async fn update_aliases_handler(
    Json(payload): Json<SpeakerUpdate>,
) -> Result<StatusCode, (StatusCode, String)> {
    let path = "data/speakers/aliases.json";
    let mut map: serde_json::Value = if std::path::Path::new(path).exists() {
        let content = std::fs::read_to_string(path).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    map[payload.id] = serde_json::json!({
        "name": payload.name,
        "aliases": payload.aliases
    });

    let updated_content = serde_json::to_string_pretty(&map).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    std::fs::write(path, updated_content).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(StatusCode::OK)
}
