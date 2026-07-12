# Telehealth Mode

The NUH brief specifies that during telehealth consultations the solution is
still accessed **through the clinician's phone, played through the device
speaker** — no video-platform integration is required.

## Setup

1. Clinician runs the telehealth consultation on the usual platform
   (laptop/desktop, hospital-approved video tool).
2. The clinician's phone runs this app (PWA) next to the telehealth device,
   on speakerphone distance from both the clinician and the telehealth speaker.
3. Conversation mode on, patient language selected, mic listening.

## How the audio path works

- The **patient's voice** arrives through the telehealth device's speaker and
  is picked up by the phone microphone exactly like in-person speech; the
  energy VAD segments it and it is transcribed/translated as `to_clinician`.
- The **clinician speaks English** normally; the app translates `to_patient`
  and the phone speaker plays the translated audio, which the telehealth
  microphone carries to the patient.
- The mic is gated while the app itself is speaking (+300 ms tail), so the
  phone does not re-transcribe its own TTS output.

## Tuning checklist (rehearse before a real session)

- If laptop-speaker audio does not trigger transcription, raise the speaker
  volume or lower `VAD_THRESHOLD` in `static/app.js` (default 0.008 RMS).
- Keep the phone ≥ 30 cm from the telehealth speaker to avoid clipping.
- Echo cancellation on the telehealth platform should stay ON (it prevents
  the patient hearing their own translated audio twice).
- Latency expectation: ~2 s speech→text, TTS starts immediately after —
  advise both parties to pause briefly after speaking.
