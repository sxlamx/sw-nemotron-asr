# Roadmap — Beyond the POC

## Language expansion

| Language | Status | Path |
|---|---|---|
| Bahasa Melayu, Bahasa Indonesia, Tamil, Mandarin | **Working now** | whisper large-v3-turbo + LLM translation + device TTS voices |
| Cantonese (yue) | Working (ASR requires large-v3 family — already default) | LLM output is written Chinese; colloquial Cantonese phrasing improves with a Cantonese-tuned LLM; TTS via `yue-HK` device voices |
| Burmese (my) | Best-effort | Whisper WER is high for Burmese; demo with scripted phrases; production needs a fine-tuned ASR model. Device TTS coverage on Android is decent, iOS patchy |
| **Hokkien** | Fallback + roadmap | Whisper has no Hokkien token. POC routes via Mandarin with an on-screen disclaimer. Production path: Taiwanese-Hokkien Whisper fine-tunes (e.g. NUTN/ITRI models) loadable through the existing `whisper_model` setting; TTS via SuiSiann/ITRI Taiwanese engines. Needs evaluation against Singaporean Hokkien specifically |
| Arabic, Bengali (full implementation) | Config-level | Both natively supported by Whisper; add to the language whitelist + `_LANG_NAMES` + UI selects; device TTS voices exist on both platforms |

## On-device (WASM) mode — innovation differentiator

The hybrid architecture is designed to migrate progressively into the browser:

1. **Done:** on-device TTS (device voices), client-side VAD, AudioWorklet capture.
2. **Next:** bundled WASM VITS voices (sherpa-onnx built MODULARIZE'd so several
   languages coexist) replacing OS voices — consistent quality, fully offline
   (`static/tts.js` already has the provider slot; `/tts/manifest.json` activates it).
3. **Next:** Silero VAD (WASM) replacing the energy VAD for clinic-noise robustness.
4. **Later:** whisper-base/small WASM (WebGPU) for an offline English↔Indonesian
   mode on capable phones — proof-point that the same product runs with zero
   server infrastructure as on-device models mature.

## Model upgrades

- **Translation LLM**: POC uses local qwen2.5:3b (fully on-prem). A larger
  on-prem model (qwen2.5:32b / Llama 3.3 70B on a GPU server) materially
  improves clinical phrasing and makes the simpler-English suggestions fire
  reliably; the cloud Nemotron provider demonstrates that quality today.
- **ASR**: GPU inference is the production recommendation (measured: 1.1 s vs
  12 s per utterance on CPU for large-v3-turbo).
- **TTS**: per-language quality ladder — device voices (now) → WASM VITS
  (offline) → CosyVoice2 on the GPU server (premium Cantonese).

## Integration potential (brief: optional, viewed favourably)

- The server is a small REST/WS API — embeddable behind hospital SSO
  (replace the POC login with OIDC), deployable to government cloud (GCC)
  or fully on-prem.
- Transcript export hooks (post-POC, after governance review) could feed
  clinical documentation systems; the privacy-mode switch already isolates
  this decision in one place.
