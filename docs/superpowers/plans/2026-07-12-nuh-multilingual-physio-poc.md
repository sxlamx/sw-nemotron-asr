# NUH Multilingual Physiotherapy POC — Customization Plan (Hybrid WASM)

## Context

Adapt **sw-nemotron-asr** to the NUH/IMDA challenge "AI-Powered Multilingual Communication for Physiotherapy" (SGD50k POC, submission 14 Aug 2026). The brief demands real-time **two-way** clinician↔patient speech translation with **text + spoken audio** output, six POC languages (Bahasa Indonesia, Malay, Tamil, Hokkien, Cantonese, Burmese), a clinician-maintained **physiotherapy glossary with continuous learning**, **user accounts/permissions**, **hands-free mobile-first** operation on clinicians' phones, and a defensible **privacy/no-retention** posture.

Today the app is a one-directional utterance-batched transcriber: Rust/Axum server (`src/main.rs`, ~980 lines) driving two Python workers over stdin/stdout (`scripts/speaker_id.py`, `scripts/asr_translate_worker.py` — faster-whisper *small* INT8 CPU + LLM translation via Nemotron cloud / Ollama / Whisper→EN), vanilla-JS frontend (`static/index.html` + `static/app.js`) with client-side energy VAD. Languages limited to en/zh/ms/ta/ko. **No TTS, no auth, no glossary, sessions always persisted to disk.**

### Locked decisions
- **Architecture = Hybrid WASM**: on-prem server keeps the heavy models (whisper `large-v3-turbo` ASR — required for Cantonese/Burmese — and LLM translation for clinical accuracy); the **browser runs on-device WASM TTS** (sherpa-onnx) and, in Phase 4, a **WASM audio front-end** (AudioWorklet + Silero VAD). Full on-device operation is the documented roadmap differentiator (Solution Advantage, 20% of scoring). Privacy line: *audio never leaves the hospital network; translated speech is synthesized on the phone itself.*
- **Mobile = PWA over HTTPS** (harden existing web UI; Caddy `tls internal` reverse proxy for demo phones)
- **Hokkien = best-effort + documented roadmap** (no Whisper token, no viable TTS — Mandarin fallback + disclaimer; not a Phase-1 blocker)
- **Keep current stack** (Rust + Python workers + vanilla JS; no rewrite)
- **Default translation provider for NUH = Ollama (on-prem)**; Nemotron cloud clearly flagged in UI + docs

### Key design choices
- **Two-way routing:** conversation mode with clinician lang fixed `en`, patient lang picked at session start. Per utterance, Whisper detects language constrained to `{en, patient_lang}` (argmax over `info.all_language_probs`) → direction decides translation target + TTS voice. Manual direction pill (AUTO / EN→XX / XX→EN) as tap fallback. Optional speaker-ID tiebreaker behind a settings flag (off by default — costs ~0.5–1s).
- **TTS in the browser (sherpa-onnx WASM):** one WASM runtime handles all VITS voices. Server WS response stays a **single JSON frame** (text + translation + direction); the browser synthesizes and plays locally — zero TTS round-trip, works through network hiccups. Voices lazy-loaded per language and cached in Cache Storage (download only `en` + patient language, with a progress UI). Playback via gesture-unlocked `AudioContext` (created in record-button handler — satisfies iOS/Android autoplay). **Client VAD gated during TTS playback** (+~300ms tail) to stop the speaker re-triggering transcription.
- **Contingency:** if a language's WASM TTS is too slow/poor on target phones, fall back to a server-side `scripts/tts_worker.py` cloning the existing worker line-protocol pattern (documented, not built up-front).
- **ASR model bump is mandatory:** whisper *small* has no Cantonese (`yue`) token — move to `large-v3-turbo` INT8 on the server, configurable via new `whisper_model`/`whisper_device` settings passed as env vars at worker spawn.
- **Glossary/KB:** JSON files (matches the project's zero-DB pattern) + **prompt-time term injection** into the existing `_llm_translate` prompt. Corrections feedback loop stores clinician fixes applied to future prompts. Simpler-term suggestions come free in the same LLM call via JSON output `{"translation","simpler_english"}`.

### Browser TTS voice map (sherpa-onnx WASM, all on-device)
| Lang | Model | Size | Note |
|---|---|---|---|
| en | Piper-class VITS (`vits-piper-en_US-lessac-medium`) | ~65MB | good |
| id / ms / ta / my | MMS VITS (`vits-mms-ind` / `-zlm`* / `-tam` / `-mya`) | ~40MB ea | intelligible, flat prosody; *verify `zlm` vs `zsm` checkpoint day one |
| yue | sherpa-onnx Cantonese VITS | ~60MB | mediocre voice; upgrade path = server CosyVoice2 on GPU |
| Hokkien | none viable → Mandarin TTS + on-screen disclaimer | — | roadmap: SuiSiann/ITRI Taiwanese TTS |

---

## Phase 1 — Two-way conversation + languages + browser TTS (end-to-end demo)

**Goal:** alternate speakers on one device; each utterance auto-routes direction, shows original+translation in a two-pane conversation UI, and the phone speaks the translation aloud via on-device WASM TTS. Privacy mode ON. Demoable for en↔{id, ms, ta, yue, my}.

- **`src/main.rs`**
  - `AppSettings` + validation (`valid_langs` at :724, targets at :730): add `patient_language`, `conversation_mode`, `privacy_mode` (default **true**), `whisper_model` (`large-v3-turbo`), `whisper_device`, `use_speaker_direction`; expand langs to `["auto","en","id","ms","ta","yue","my","zh","ko"]`.
  - Rewrite WS loop (:827): accept `Message::Text` config frames (patient lang, direction override); constrained-language transcribe (`allowed_langs`); direction decision; translate to computed target; skip speaker-ID in conversation mode unless flagged. Response stays one JSON frame (adds `direction`, `tts_lang`).
  - **Privacy mode:** no session dirs/transcripts written, `/api/sessions` → `[]`, stop logging transcript text (:503, :976).
- **`scripts/asr_translate_worker.py`**: `cmd_transcribe` (:59) accepts `allowed_langs` (argmax `info.all_language_probs`); model/device from env; `_LANG_NAMES` (:76) add id/yue/my/nan.
- **`static/tts/`** (new): sherpa-onnx WASM runtime (`sherpa-onnx-tts.js` + `.wasm`) + voice model files served locally; `static/tts.js` module: lazy-load voice for a language, Cache Storage caching, download-progress UI, synthesize→play through the shared AudioContext, VAD-gate hook.
- **`static/index.html` / `static/app.js`**: conversation panel (Clinician EN | Patient XX chat bubbles with direction), patient-language picker (triggers voice download), direction pill, TTS toggle + per-bubble replay, AudioContext unlock in record handler, VAD gating during playback, hide Recordings when privacy mode; drop `SILENCE_GAP_MS` 800→600 (:574).
- **`scripts/download_models.py`**: prefetch whisper turbo + sherpa-onnx voice bundles into `static/tts/models/` (offline demo).
- **`settings.json`**: new fields; **`Caddyfile`** (new, ~5 lines) for phone HTTPS — WASM TTS + mic both require secure context.

Deps: none new in Rust/Python beyond the whisper model bump (turbo INT8 ~1.6GB); sherpa-onnx WASM is static assets. Server RAM ~4–6GB.
**Verify:** extend `test_ws.py` — config frame + en & ms WAV fixtures assert `direction`; manual two-person EN↔TA round trip — text <3.5s, audio starts <1s after text (local synth); `data/sessions/` stays empty in privacy mode; **test on a real iPhone via Caddy in week 1** (WASM memory, autoplay, echo-loop are the risk items).

## Phase 2 — Glossary/KB + continuous learning + simpler-term suggestions

- **`data/glossary.json`** `[{id, term_en, translations:{...}, simpler_en, notes, created_by, source}]`; **`data/corrections.json`** `[{src_lang, tgt_lang, source_text, corrected_translation, note, created_by}]`. Seed ~20 real physio terms ("weight-bearing", "range of motion", "dorsiflexion"…).
- **`src/main.rs`**: load both into `AppState`; routes `GET/POST/DELETE /api/glossary`, `POST /api/feedback`; case-insensitive term match on utterance (cap 15) + recent corrections for the lang pair → `"glossary"` array in translate request (both call sites ~:454, ~:916).
- **`scripts/asr_translate_worker.py`**: prompt builder consumes glossary/corrections ("Use these approved translations… Apply these corrections…"); clinician→patient direction requests JSON `{"translation","simpler_english"}` with parse-fallback to plain text.
- **`static/`**: glossary management panel, flag/correct modal on bubbles, "Simpler: …" chip.

**Verify:** correct a translation → repeat sentence → correction applied; unit-test term matching; demo the simpler-term chip on jargon. KB policy: only clinician-typed text stored (no patient identifiers).

## Phase 3 — Auth + roles

- **`src/main.rs`**: `data/users.json` with argon2 hashes, roles `admin`/`clinician`; `POST /api/login` → UUID token in memory map, `HttpOnly; Secure; SameSite=Lax` cookie (rides the WS upgrade); `middleware::from_fn_with_state` guard on `/api/*`, `/ws/*`, `/data/*`; admin-only settings/glossary-delete/user management; `auth_enabled` flag so Phases 1–2 keep working.
- **`static/login.html`** (new) + 401→redirect in `app.js`. Seed two mock accounts.

Deps: Rust `argon2`, `rand`, `axum-extra` (cookies).
**Verify:** extend `test_e2e.py` — 401 unauthenticated; clinician can't write settings, admin can; WS refuses without cookie; test cookie flow through Caddy.

## Phase 4 — WASM audio front-end + PWA hardening

- **`static/worklet/`** (new): AudioWorklet capture replacing deprecated `ScriptProcessorNode`; capture at native rate → downsample to 16k (iOS ignores `sampleRate:16000` requests).
- **Silero VAD in the browser** via the same sherpa-onnx WASM runtime (or a small Rust→WASM module if we want shared Rust core) replacing the crude energy VAD (`app.js:571-601`) — cleaner utterance boundaries → better ASR, less audio shipped.
- **`static/manifest.json`** + icons + minimal **`static/sw.js`** (cache app shell + TTS voice models, network-first APIs); wake-lock; bigger touch targets; phone cert-install runbook.

**Verify:** install to home screen on iPhone + Android; full two-way conversation on both; screen-lock/resume; VAD comparison on noisy-clinic audio sample.

## Phase 5 — Polish, docs, telehealth story

- **`docs/data-processing-architecture.md`** — on-prem diagram, per-component data flows (mic → LAN server ASR/LLM → text back → **on-device TTS**), retention table, PDPA notes, cloud-provider caveat. Directly answers the brief's Security & Data Management requirement.
- **`docs/telehealth-mode.md`**: clinician's phone on speaker next to telehealth device; tune `VAD_THRESHOLD` for laptop-speaker audio; rehearsed demo step.
- **`docs/roadmap.md`**: Hokkien (NUTN/ITRI Taiwanese Whisper fine-tunes via the `whisper_model` mechanism; SuiSiann TTS); Arabic/Bengali (natively supported by Whisper+MMS → config-level); **full on-device WASM mode** (whisper-base WASM + WebLLM as models mature — the Rust core compiles to WASM) as the innovation differentiator.
- Latency tuning pass (beam_size 5→3 for turbo); GPU deployment notes; remove dead `models/*.onnx` Parakeet artifacts.

---

## Requirements traceability

| Brief requirement | Plan item |
|---|---|
| Real-time two-way speech → text + audio | Phase 1 (direction routing, conversation UI, browser WASM TTS) |
| Communication aid only (disclaimer) | Phase 1 UI banner + Phase 5 docs |
| Clinician-refined translations, physio KB | Phase 2 |
| Simpler alternatives for technical terms | Phase 2 (same LLM call) |
| id/ms/ta/yue/my + Hokkien best-effort; Arabic/Bengali scalable | Phase 1 + Phase 5 roadmap |
| User management + permissions | Phase 3 |
| No conversation retention for POC | Phase 1 `privacy_mode` (default on) |
| Hands-free, mobile-first, device speaker, low latency | Phase 1 auto-direction + on-device TTS + VAD gating; Phase 4 WASM front-end + PWA |
| No patient identifiers in learning; documented data architecture | Phase 2 KB policy + Phase 5 doc; on-device TTS + Ollama default |
| Innovation / scalability story (evaluation criteria) | Hybrid WASM architecture + Phase 5 on-device roadmap |

## Risk register

1. **WASM TTS on phones** — voice downloads (40–65MB/lang), iOS Safari WASM memory limits, synth speed on older phones. Mitigate: only 2 voices loaded, Cache Storage, test on real iPhone week 1; fallback = server `tts_worker.py` (pattern already exists).
2. **Burmese** — high Whisper WER, robotic MMS voice → scripted demo phrases; flag fine-tuning for production.
3. **Hokkien** — zh fallback + disclaimer only; do not promise in demo.
4. **Cantonese** — hard dependency on server model bump; WASM VITS voice mediocre (upgrade path: server CosyVoice2 on GPU); colloquial-yue↔written-zh mismatch in LLM output.
5. **Mobile autoplay + echo loop** — gesture-unlocked AudioContext AND VAD gating both required.
6. **CPU latency** — ~2–3.5s to text on server CPU; GPU is the honest production recommendation.
7. **Checkpoint availability** — verify sherpa-onnx `vits-mms-zlm`/`zsm` and Cantonese VITS bundles on day one.
8. **Cloud leakage** — Nemotron provider sends text to NVIDIA cloud; default Ollama and document.

## Verification (end-to-end)

1. `cargo run` + workers start; run `test_e2e.py` + extended `test_ws.py`.
2. Two-person demo script: EN clinician ↔ Malay/Tamil patient on a phone via Caddy HTTPS — text <3.5s, spoken audio within ~1s of text, no echo re-trigger, `data/sessions/` empty.
3. Glossary demo: mistranslate → correct → repeat → fixed; simpler-term chip fires on jargon.
4. Auth: login as clinician vs admin, verify permission boundaries.
5. PWA: home-screen install on iOS + Android, full conversation both platforms, voices served from cache offline-of-WAN.
