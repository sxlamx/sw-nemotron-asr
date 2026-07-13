# Project Checkpoint — NUH Multilingual Physiotherapy POC

**Checkpoint date:** 2026-07-13 · **Branch:** `main` @ `0cbed11` (pushed to origin)
**Purpose:** resumption point for the NUH/IMDA Call 29 POC work (submission deadline **14 Aug 2026, 1600 SGT**).

---

## 1. Where the project stands

All five phases of the approved implementation plan
(`docs/superpowers/plans/2026-07-12-nuh-multilingual-physio-poc.md`) are
**implemented, verified and merged to main**, plus the OIP proposal draft.

| Phase | Commit | Status |
|---|---|---|
| 1. Two-way conversation, on-device TTS, languages (id/yue/my), privacy mode | `ae4d9ff` | ✅ Done |
| 2. Physio glossary KB, correction learning, simpler-English suggestions | `31f3a7b` | ✅ Done |
| 3. User accounts, sessions, clinician/admin roles | `18bfabe` | ✅ Done |
| 4. PWA install, AudioWorklet capture, wake lock, mobile hardening | `06dc126` | ✅ Done |
| 5. Docs: data architecture, telehealth, roadmap, demo runbook | `6a36440` | ✅ Done |
| OIP proposal draft | `0cbed11` | ✅ Drafted (placeholders pending) |

**Verification:** `python test_e2e.py` against a running server = **85/85 checks**
(settings, auth/roles incl. WS cookie refusal, user-account CRUD + last-admin
guard, conversation direction routing, glossary CRUD + correction-applied-on-
repeat, privacy no-persistence, PWA assets). Note: run the suite against a
*warm* server — the very first utterance after startup can time out checks.

**Measured performance (dev machine, RTX 3050):** ~1.1 s ASR (whisper
large-v3-turbo, CUDA) → ~1.9–3 s end-of-speech to translated text incl. local
LLM; spoken output starts immediately after (on-device synthesis).
CPU-only ASR is ~12 s/utterance — GPU is effectively required.

## 2. How to resume / run

```powershell
ollama serve                # translation LLM: qwen2.5:3b on 127.0.0.1:11434
cargo run                   # server on 127.0.0.1:3007 (~25s model load)
caddy run                   # optional: HTTPS for phones (Caddyfile, tls internal)
python test_e2e.py          # 76-check verification (needs running server)
```

- Logins (seeded to `data/users.json` on first run): `admin/nuh-admin-poc`, `sarah/nuh-demo-poc`.
- Demo script: `docs/demo-runbook.md`. Architecture/retention: `docs/data-processing-architecture.md`.
- Machine-local artifacts NOT in git (gitignored, must exist to run):
  `models/whisper/` (large-v3-turbo ~1.6 GB, auto-downloads on first run),
  `data/` (glossary auto-seeds from `scripts/seeds/glossary.json`),
  `.venv` with `piper-less` stack + `nvidia-cublas-cu12`/`nvidia-cudnn-cu12`
  (pip wheels; worker auto-registers their DLLs when `whisper_device=cuda`).
- `settings.json` currently: `translation_provider=ollama`,
  `ollama_host=http://127.0.0.1:11434`, `ollama_model=qwen2.5:3b`,
  `whisper_model=large-v3-turbo`, `whisper_device=cuda`, `privacy_mode=true`,
  `conversation_mode=true`, `auth_enabled=true`.

## 3. Known deviations from the approved plan (deliberate, documented)

1. **TTS = Web Speech API (device OS voices), not sherpa-onnx WASM.** No
   off-the-shelf multi-language WASM TTS bundles exist; single-model builds
   can't coexist on one page. `static/tts.js` is a provider chain — a WASM
   provider activates when `/tts/manifest.json` + bundles are served
   (requires building sherpa-onnx MODULARIZE'd per voice). Roadmap item.
2. **Translation quality floor = qwen2.5:3b** (fully local). Verified working,
   but conservative on the simpler-English suggestion and weak on dense
   jargon. Demo recommendation: Nemotron cloud provider or larger local model.
3. **Dead Parakeet ONNX artifacts** left in `models/` (untracked, ~2 GB) — safe
   to delete manually.

## 4. Open items (next session's backlog, in priority order)

1. **Real-phone verification** (needs a human + iPhone/Android): Caddy cert
   install, PWA install, mic permission, speaker output, echo-gating,
   screen-lock behaviour. Runbook §"Phone setup". *No code known-broken;
   simply unverified on physical devices.*
2. **Patient→clinician direction with real speech** — routing logic is
   test-covered, but no genuine Malay/Tamil speaker has exercised it yet.
3. **Proposal placeholders** (`docs/nuh-oip-proposal-draft.md` §8–9): company
   profile/UEN, team bios, traction, pricing `[X]` figures. Only the submitter
   can fill these. Optional: convert to .docx for OIP upload.
4. **Demo LLM tier decision** — qwen2.5:3b vs NVIDIA cloud vs larger local
   model (affects jargon + simpler-English demo quality).
5. **WASM voice bundles** (roadmap next step): build sherpa-onnx TTS
   MODULARIZE'd for ms/id/ta/yue/my, serve under `static/tts/`, implement the
   `SherpaWasmProvider.speak()` loader in `static/tts.js`.
6. **Nice-to-haves not started:** Silero-VAD (WASM) replacing energy VAD;
   LLM-assisted extraction of glossary entries from corrections; rate
   limiting / audit logging (listed in data-architecture backlog).
   ~~User-management UI~~ — done 2026-07-13: admin-only User Accounts card
   + `/api/users` CRUD (argon2, last-admin guard, session revocation).

## 5. Key file map (for orientation after a break)

| Area | Files |
|---|---|
| Server (routes, WS conversation loop, auth, privacy, glossary injection) | `src/main.rs` (single file) |
| ASR + translation worker (whisper, LLM providers, prompt builder, CUDA DLLs) | `scripts/asr_translate_worker.py` |
| Speaker-ID worker (optional in conversation mode) | `scripts/speaker_id.py` |
| Client logic (VAD, WS, conversation UI, glossary UI, auth redirect, PWA reg) | `static/app.js` |
| On-device TTS provider chain | `static/tts.js` |
| Page + all CSS | `static/index.html`; login: `static/login.html` |
| Capture worklet / PWA shell | `static/worklet/pcm-capture.js`, `static/sw.js`, `static/manifest.json` |
| Glossary seed | `scripts/seeds/glossary.json` |
| Verification suite | `test_e2e.py` (needs running server) |
| Plan of record | `docs/superpowers/plans/2026-07-12-nuh-multilingual-physio-poc.md` |
| Proposal draft | `docs/nuh-oip-proposal-draft.md` |
