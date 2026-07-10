# Translation Provider Toggle — Design Spec
**Date:** 2026-07-10
**Project:** sw-nemotron-asr

---

## Overview

Add three interchangeable translation backends — NVIDIA Nemotron (existing), Ollama (local LAN LLM), and Whisper built-in translate — with a 3-way toggle button group in the live transcript panel header. Provider choice persists to `settings.json`.

---

## Architecture

### New Settings Fields (`settings.json`)

| Field | Type | Default |
|---|---|---|
| `translation_provider` | string | `"nemotron"` |
| `ollama_host` | string | `"http://192.168.1.230:11433"` |
| `ollama_model` | string | `""` |

### New Rust Endpoint

`GET /api/ollama/models` — proxies `{ollama_host}/api/tags` through the Rust backend. Returns the raw Ollama tags JSON. Proxying avoids browser CORS issues when calling a LAN IP.

Requires adding `reqwest = { version = "0.12", features = ["json"] }` to `Cargo.toml`.

---

## Components

### 1. Python Worker (`scripts/asr_translate_worker.py`)

`cmd_translate` receives an extended JSON payload:

```json
{
  "cmd": "translate",
  "text": "...",
  "source_lang": "zh",
  "target_lang": "en",
  "provider": "nemotron | ollama | whisper",
  "api_key": "...",
  "audio_path": "/path/to/audio.wav",
  "ollama_host": "http://192.168.1.230:11433",
  "ollama_model": "llama3.2:3b"
}
```

**Provider branches:**

- **`nemotron`** — existing behaviour: OpenAI client at `https://integrate.api.nvidia.com/v1`, model `nvidia/llama-3.1-nemotron-70b-instruct`, requires `api_key`.
- **`ollama`** — OpenAI-compat client at `{ollama_host}/v1`, `api_key="ollama"`, model from `ollama_model`. Falls back to `"llama3.2:3b"` if `ollama_model` is empty.
- **`whisper`** — re-runs `_model.transcribe(audio_path, task="translate")` on the already-saved temp WAV. Returns English text. Requires `audio_path` to exist; returns error if missing.

### 2. Rust Backend (`src/main.rs`)

**`AppSettings` additions (all `#[serde(default)]`):**
- `translation_provider: String` → default `"nemotron"`
- `ollama_host: String` → default `"http://192.168.1.230:11433"`
- `ollama_model: String` → default `""`

**`get_settings_handler`** — include the three new fields in the masked response JSON.

**`update_settings_handler`** — merge the three new fields from the PATCH body; `translation_provider` and `ollama_host` are updated when present; `ollama_model` updated when present.

**`get_ollama_models_handler`** — new async handler:
1. Read `ollama_host` from `AppState.settings`
2. `GET {ollama_host}/api/tags` via `reqwest` (5s timeout)
3. Return the response JSON as-is, or `502` with error message on failure

**Translate call sites** (REST `/api/transcribe` handler + WS `ws_transcribe_loop`):
- Read `translation_provider`, `ollama_host`, `ollama_model`, `api_key` from settings
- Pass all four plus `audio_path` (the temp/session WAV path) in the translate command JSON to the Python worker
- For `whisper` provider, the translate step is skipped if `target_lang != "en"` with no API call — return empty translation instead (Whisper can only translate to English)

**Route added:**
```
GET /api/ollama/models
```

### 3. Frontend (`static/index.html` + `static/app.js`)

**Live panel header** — add a provider toggle group between the lang row and the meta row:

```
[Nemotron] [Ollama] [Whisper→EN]
```

Active provider button has a highlighted style. `Whisper→EN` button disables the target language selector and shows a tooltip/note "Translates to English only."

**Settings panel additions:**
- Ollama Host: text input, bound to `ollama_host`
- Ollama Model: `<select>` populated from `GET /api/ollama/models`; "Refresh Models" button triggers fetch
- Translation Provider radio/select mirrors the live toggle (both stay in sync)

**JS behaviour:**
- `setProvider(p)` — updates active button style, POSTs `{ translation_provider: p }` to `/api/settings`, disables target-lang selector if `p === "whisper"`
- `fetchOllamaModels()` — GETs `/api/ollama/models`, populates the model `<select>`, auto-selects current `ollama_model` from settings
- On `DOMContentLoaded`: `fetchSettings()` → set active toggle button, call `fetchOllamaModels()` if provider is `ollama`
- Changing settings Ollama Host field triggers `fetchOllamaModels()` on blur

---

## Data Flow (per utterance)

```
Browser VAD → WS binary frame
  → Rust: save temp WAV
  → Python: transcribe (always task="transcribe")
  → Rust: read provider from settings
  → if provider=="whisper" && target!="en": skip translate (return "")
  → else: send translate cmd with provider + params
  → Python: branch on provider → return translation
  → Rust: send JSON response back over WS
  → Browser: displayLiveResult() → show Original | Translation columns
```

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Ollama server unreachable | Python returns `{"status":"error","message":"..."}` → Rust logs warn, returns empty translation (graceful degradation) |
| `ollama_model` empty | Python falls back to `"llama3.2:3b"` |
| `audio_path` missing for whisper | Python returns error → Rust logs warn, empty translation |
| Whisper→EN with non-EN target selected | Rust skips translate call entirely, returns empty translation with no error |
| `/api/ollama/models` timeout | Returns 502 with message; JS shows "Could not reach Ollama server" in model dropdown |

---

## Files Changed

| File | Change |
|---|---|
| `Cargo.toml` | Add `reqwest` dependency |
| `src/main.rs` | 3 new settings fields, `get_ollama_models_handler`, extend translate call sites |
| `scripts/asr_translate_worker.py` | Extend `cmd_translate` with provider branching |
| `static/index.html` | Provider toggle group, Ollama settings fields |
| `static/app.js` | `setProvider()`, `fetchOllamaModels()`, settings sync |

---

## Out of Scope

- Automatic model health-check on startup
- Per-utterance provider override (toggle applies globally)
- Streaming translation output
