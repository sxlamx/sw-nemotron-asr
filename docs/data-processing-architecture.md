# Data Processing Architecture & Retention

*NUH AI Multilingual Physiotherapy POC — answers the brief's Security and Data
Management requirement: where processing happens, what is stored, and for how long.*

## Processing topology

```
Clinician's phone (browser / PWA)                On-prem server (clinic LAN)
┌──────────────────────────────┐   HTTPS/WSS    ┌──────────────────────────────────┐
│ Mic capture (AudioWorklet)   │  ───────────►  │ Rust/Axum server (127.0.0.1:3007)│
│ Energy VAD (utterance cut)   │  16kHz WAV,    │  ├─ faster-whisper ASR (local)   │
│ TTS synthesis (device voices)│  per utterance │  ├─ LLM translation:             │
│ Conversation UI              │  ◄───────────  │  │    Ollama (local/LAN) default │
│                              │  JSON text     │  │    NVIDIA cloud (optional,    │
│                              │                │  │      clearly flagged in UI)   │
│                              │                │  └─ Speaker-ID (local, optional) │
└──────────────────────────────┘                └──────────────────────────────────┘
                                                  Caddy reverse proxy (tls internal)
                                                  terminates HTTPS on the same host
```

- **Audio never leaves the clinic network.** ASR runs on the on-prem server.
  Translated speech is synthesized **on the phone itself** (OS/browser voices;
  WASM voices on the roadmap) — no audio is sent to any external service.
- **Text**: with the default **Ollama** provider, translation also stays fully
  on-prem. The optional **NVIDIA cloud** provider sends *transcript text only*
  (never audio, never identifiers by design of the workflow) to
  `integrate.api.nvidia.com`; it is clearly labelled in the UI and off by default.
- Transport is HTTPS/WSS via Caddy with a local CA (`Caddyfile`); the app
  itself binds to loopback only.

## Data at rest and retention

| Data | Location | Privacy mode ON (default) | Privacy mode OFF (dev only) |
|---|---|---|---|
| Utterance audio | server temp file | deleted immediately after processing | kept under `data/sessions/` |
| Transcripts / translations | — | **never written to disk**; server logs record only language + character count | kept under `data/sessions/` |
| Conversation log (bubbles) | browser memory | cleared on page close / Clear button; never persisted | same |
| Glossary terms | `data/glossary.json` | kept — **clinician-typed text only** | same |
| Corrections | `data/corrections.json` | kept — clinician-typed corrections of *phrasing*, capped at 500 | same |
| User accounts | `data/users.json` | argon2id password hashes only | same |
| Login sessions | server memory | 12 h TTL, lost on restart | same |
| Voice-ID profiles | `data/speakers/` | only if a user explicitly enrolls (off in conversation mode) | same |

## No patient identifiers in learning (brief requirement)

The continuous-learning mechanism (glossary + corrections) stores **only text
typed by the clinician** into the glossary/correction forms. Conversation
audio and transcripts are not used for any learning, model training, or
fine-tuning, and in privacy mode they are never persisted at all. Clinic SOP
should instruct clinicians not to include patient names in glossary notes.

## Access control

- All API, WebSocket and data routes require an authenticated session
  (HttpOnly cookie, argon2id-verified login).
- Roles: `clinician` (use the app, add glossary terms, submit corrections) and
  `admin` (settings, glossary deletion, account management).
- Failed logins are logged; sessions expire after 12 hours.

## Residual risks / production hardening backlog

- Session tokens are in-memory (restart logs everyone out) — acceptable for POC.
- `settings.json` stores the optional NVIDIA API key in plaintext on the
  server host — move to OS keyring or env var for production.
- Web Speech TTS on some Android devices may route through the device's
  configured speech engine; production replaces this with bundled on-device
  WASM voices (see roadmap).
- Rate limiting and audit logging are not implemented for the POC.
