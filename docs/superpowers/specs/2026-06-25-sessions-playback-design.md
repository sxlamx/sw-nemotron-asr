# Sessions Playback — Design Spec
Date: 2026-06-25

## Goal
Timestamp every recorded session on disk for filesystem browsability, and add a full-width "Recordings" panel to the UI so users can list and play back all captured audio to review transcription quality.

## Storage (Approach A)

Session directories rename from `{uuid}` to `{YYYY-MM-DDTHH-MM-SS}_{uuid}`:

```
data/sessions/
  2026-06-25T09-03-15_2ec40d3b-2e2d-4fef-8985-4464dc6387fc/
    audio.wav        — raw 16kHz mono WAV
    transcript.txt   — ASR output (may be empty for silence)
    speaker.txt      — speaker_id string (new, persisted to disk)
```

Timestamp format uses hyphens in the time component (`HH-MM-SS`) so directory names are valid on all OSes. The UUID suffix guarantees uniqueness for simultaneous requests.

The Rust server adds a second `ServeDir` mounting `./data/` at `/data/`, making audio playable at `/data/sessions/{dir}/audio.wav` without a streaming endpoint.

## Backend Changes (src/main.rs)

### Session directory creation
Replace `Uuid::new_v4().to_string()` with `{timestamp}_{uuid}` using `chrono::Local::now()`.

### New file: speaker.txt
After speaker identification, write `speaker_id` to `{session_dir}/speaker.txt`.

### New endpoint: GET /api/sessions
- Reads all entries in `data/sessions/`
- Skips non-directory entries
- Parses timestamp from dirname prefix (first 19 chars: `YYYY-MM-DDTHH-MM-SS`)
- Reads `transcript.txt` and `speaker.txt` from each dir
- Returns JSON array sorted newest-first:

```json
[
  {
    "session_id": "2026-06-25T09-03-15_2ec40d3b-...",
    "timestamp": "2026-06-25T09:03:15",
    "transcript": "It's a me so both of us...",
    "speaker_id": "Unknown",
    "audio_url": "/data/sessions/2026-06-25T09-03-15_2ec40d3b-.../audio.wav"
  }
]
```

### Static file serving
Add `.nest_service("/data", ServeDir::new("data"))` before the existing `"/"` route.

### Cargo.toml
Add `chrono = { version = "0.4", features = ["local-offset"] }` for timestamp generation.

## Frontend Changes

### index.html
Add a full-width "Recordings" card below the existing 2-column grid:
- Shared `<audio>` player at top (controls visible, hidden until first play)
- Table: Timestamp · Speaker · Transcript · Actions columns
- "Refresh" button to manually reload

### app.js
Add `fetchSessions()`:
- Calls `GET /api/sessions`
- Populates recordings table
- Called on `DOMContentLoaded` and after each successful transcription

Add `playSession(audioUrl)`:
- Sets `audio.src = audioUrl` and calls `audio.play()`
- Highlights active row

## Error Handling
- Missing `transcript.txt` or `speaker.txt`: use empty string / `"Unknown"` — don't skip the session
- Empty `data/sessions/` dir: show "No recordings yet" in table
- Audio playback failure: browser `<audio>` error event → show inline error on that row

## Out of Scope
- Deleting sessions from the UI
- Pagination (acceptable for local dev use with dozens of sessions)
- LLM refinement (separate feature)
