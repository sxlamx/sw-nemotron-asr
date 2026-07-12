# Demo Runbook

## Start the stack

```powershell
# 1. Local LLM (translation) — needs qwen2.5:3b pulled once
ollama serve          # if not already running on 127.0.0.1:11434

# 2. App server (loads whisper large-v3-turbo; ~25 s to READY)
cargo run

# 3. HTTPS for phones (optional, LAN demo)
caddy run             # uses ./Caddyfile, tls internal
```

Mock accounts (seeded on first run into `data/users.json`):

| user | password | role |
|---|---|---|
| `admin` | `nuh-admin-poc` | admin (settings, glossary delete) |
| `sarah` | `nuh-demo-poc` | clinician |

## Phone setup (once per phone)

1. Install Caddy's local root CA on the phone (`caddy trust` exports it;
   AirDrop/email the cert, install + trust in OS settings).
2. Browse to `https://<laptop-LAN-IP>/`, log in, "Add to Home Screen".
3. Grant microphone permission on first record.

## Demo script (two people, ~5 minutes)

1. **Login** as `sarah` → point out the disclaimer banner ("communication aid
   only") and the user/role in the header.
2. **Conversation**: patient language = Bahasa Melayu. Tap record once.
   - Clinician (EN): "Please bend your knee slowly and hold for five seconds."
     → bubble right, Malay text + spoken Malay.
   - Patient (MS) replies → bubble left, English text + spoken English.
   - Show the direction pill (Auto ↔ forced) for noisy rooms.
3. **Glossary in action**: say "We will begin quadriceps strengthening and
   balance training to improve your range of motion." → translation uses the
   approved terms (otot hadapan peha / latihan imbangan / julat pergerakan sendi).
4. **Continuous learning**: tap ✎ on a bubble, correct the translation, add a
   note → repeat the same sentence → corrected phrasing comes back.
5. **Privacy**: show Settings (privacy mode ON), `data/sessions/` empty, and
   the data-processing one-pager (`docs/data-processing-architecture.md`).
6. **Telehealth**: phone next to a laptop playing the "patient" — see
   `docs/telehealth-mode.md`.

## Known demo caveats

- Burmese: use scripted, clearly-spoken phrases (ASR quality risk).
- Hokkien: demo the Mandarin-fallback disclaimer, don't promise Hokkien.
- Simpler-English chip: fires reliably with the Nemotron/large-model provider;
  the local 3B model is conservative.
- First utterance after startup is slower (model warm-up) — send a throwaway
  phrase before the audience one.

## Verification

`python test_e2e.py` against a running server — 76 checks covering settings,
auth/roles, conversation routing, glossary/corrections learning, privacy
no-persistence, and PWA assets.
