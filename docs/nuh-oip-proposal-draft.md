# Solution Proposal — AI-Powered Multilingual Communication for Physiotherapy Consultations

**IMDA Open Innovation Platform, Call 29 · Challenge Owner: NUH Physiotherapy & KROI**
**Submitted by:** [Company legal name, UEN — registered and operating in Singapore]
**Contact:** Stephen Lam · stephen@smart-wares.com
**Status of solution: working prototype available for live demonstration in Singapore today.**

---

## 1. Executive Summary

We propose a **privacy-first, real-time two-way speech translation aid** purpose-built for physiotherapy consultations. A clinician speaks English into their own phone; the patient hears and reads their language. The patient replies in their language; the clinician hears and reads English. No interpreter, no app-switching, no typing — one tap to start, hands-free thereafter.

Unlike generic tools (Google Translate, MediBabble), our solution:

- **Understands physiotherapy.** A clinician-curated glossary and correction memory are injected into every translation, so "weight-bearing", "range of motion" and exercise instructions are translated the approved way, every time, for the whole team.
- **Learns from clinicians.** Any translation can be corrected in two taps mid-session; the correction applies to all future sessions (Use Case 2 of the brief, working today).
- **Keeps data in the hospital.** Speech recognition and translation run on-premises; translated speech is synthesized on the phone itself. In the default privacy mode, no audio, transcript or conversation is ever written to disk.

This is not a concept: the prototype already performs two-way English ↔ Bahasa Melayu / Bahasa Indonesia / Tamil / Cantonese / Mandarin / Burmese conversations at **~2 seconds from end of speech to translated text**, with spoken output, login-based access control, and a 76-point automated verification suite. We ask for the POC award to harden it in NUH's clinical setting, validate it against NUH's mock datasets and scenarios, and close the Hokkien gap.

## 2. Understanding of the Challenge

Language barriers affect 30–40% of physiotherapy interactions. The cost is concrete: assessments through ad-hoc interpreters lose nuance; sessions run up to twice the standard duration; scheduling is constrained by clinician language matching; and mistranslation of clinical terms ("cardiac arrest" → "imprisonment of heart") creates real safety risk. The discipline's specific needs shape our design:

- Consultations are **hands-busy** (guiding movements, manual therapy) → the tool must run hands-free after one tap, on the clinician's own phone.
- Wording precision affects **safety** ("put weight on the leg" vs "avoid weight on the leg") → translation must be terminology-controlled, not just fluent.
- Communication is **two-way and interactive** → patients must be able to ask follow-ups, not just receive instructions.
- It is a **communication aid, not a clinical tool** → the system displays a permanent disclaimer and makes no clinical suggestions.

## 3. Proposed Solution

### 3.1 How a consultation works (Use Case 1 of the brief)

1. Clinician logs in on their phone (installable web app, iOS & Android), selects the patient's language, taps the mic once.
2. Both parties simply talk. Each utterance is auto-detected as clinician-English or patient-language and routed accordingly — transcribed, translated, displayed as a chat bubble, and **spoken aloud through the phone speaker**.
3. Where the clinician uses technical terminology, the system proposes a **plain-English alternative** for the clinician to consider.
4. A manual direction switch covers noisy rooms; a per-bubble replay button repeats any translated audio.
5. In telehealth, the same phone sits beside the clinician's telehealth device and plays translated audio through its speaker — no video-platform integration required (as specified in the brief).

### 3.2 Continuous learning and content management (Use Case 2)

- Every bubble has a "refine" control: the clinician enters the corrected translation and an optional note. Corrections are stored per language pair and applied to all future translations — verified working: a stored correction is reproduced verbatim when the phrase recurs.
- Authorised users maintain a **physiotherapy glossary** (term, per-language approved translations, plain-English equivalent). Matching terms are enforced in every translation. Seeded with 22 core physiotherapy terms; grows with the team's practice.
- The knowledge base contains **only clinician-typed text** — never patient data (brief: no patient identifiers for learning).

### 3.3 Architecture (hybrid on-premises + on-device)

| Component | Where it runs | Notes |
|---|---|---|
| Speech recognition | On-prem server (hospital LAN) | Whisper large-v3-turbo; ~1.1 s/utterance on a modest GPU |
| Translation | On-prem LLM (default) | Cloud LLM available as an explicitly-flagged option; text-only, never audio |
| Speech output | **On the phone itself** | Device voices today; bundled offline voices on roadmap |
| Voice activity detection, UI | On the phone | AudioWorklet capture, installable PWA |
| Access control | On-prem server | Individual accounts, clinician/admin roles |

Audio never leaves the hospital network; with the default configuration nothing leaves it at all. Full data-flow, storage and retention detail is in our Data Processing Architecture annex.

### 3.4 Requirements traceability

| Brief requirement | Status |
|---|---|
| Real-time two-way speech → translated text + audio | **Working** (~2 s to text; audio immediate) |
| Healthcare-specific terminology accuracy | **Working** — glossary + correction injection |
| Continuous learning by authorised users | **Working** — correction loop + glossary management |
| Simpler alternatives for technical terms | **Working** (quality scales with LLM tier) |
| Bahasa Indonesia, Bahasa Melayu, Tamil, Cantonese, Burmese | **Working** (Burmese flagged: scripted-phrase quality today; fine-tune planned) |
| Hokkien | **Best-effort in POC** — Mandarin fallback with disclaimer; dedicated Taiwanese-Hokkien ASR models evaluated during POC (see §6 risks) |
| Scale to Arabic, Bengali | **Configuration-level** — natively supported by our ASR/TTS stack |
| Hands-free, mobile-first, iOS & Android | **Working** — one tap to start, installable PWA, screen wake-lock |
| User management & permission controls | **Working** — login, roles, admin-gated settings/KB deletion |
| No conversation recording/storage for POC | **Working** — privacy mode (default): nothing persisted, verified by automated tests |
| Communication aid only | **Working** — permanent disclaimer; no clinical content generated |
| Future integration potential | Designed for it — small REST/WS API, SSO-replaceable login, deployable on-prem or GCC |

## 4. Solution Advantage (Innovation)

- **Privacy architecture as a feature:** we believe we are unusual in combining on-prem ASR/LLM with **on-device speech synthesis** — the patient's translated voice is generated on the clinician's phone, not in any cloud. This maps directly onto healthcare data-governance expectations and differentiates us from cloud translation apps.
- **Terminology-controlled LLM translation:** prompt-time injection of a clinician-owned glossary and correction memory gives the accuracy benefits of domain fine-tuning without training on any patient data — and improvements are instant, not retrain-cycle-bound.
- **Progressive on-device roadmap (new IP):** the client is engineered to absorb WASM models (offline voices, neural VAD, ultimately on-device ASR for common languages) — a path to a zero-infrastructure product as on-device models mature.
- **Cost-effective:** commodity hardware (one GPU workstation serves a clinic), open-weight models, no per-minute translation fees.

## 5. POC Development Plan (SGD 50,000, milestone-aligned)

| Milestone | Period | Deliverables |
|---|---|---|
| M0 — Kickoff (30% award) | Week 0 | Scope agreement, NUH mock datasets & clinical scenarios received, deployment environment agreed |
| M1 — Clinical validation baseline | Weeks 1–4 | Accuracy evaluation against NUH mock text & speech sets per language; physiotherapy glossary co-built with NUH clinicians; Burmese/Hokkien model evaluation report |
| M2 — Clinic-ready hardening | Weeks 5–10 | On-prem deployment at NUH; clinician phones onboarded; offline voice bundles for weak-coverage languages; noise-robust VAD; SSO/security review inputs |
| M3 — Supervised in-person trials | Weeks 11–18 | Structured trials in outpatient physiotherapy with the brief's success metrics instrumented (session duration, comprehension checks, engagement observations) |
| M4 — Telehealth validation & handover (70% award) | Weeks 19–24 | Telehealth-mode trials; evaluation report against Metrics of Success; scale-up plan for NUHS cluster |

## 6. Key Risks and Mitigations (stated honestly)

- **Burmese ASR quality** — highest-WER language in scope; mitigated via scripted-phrase validation in M1 and a fine-tuned model if required (budgeted in M2).
- **Hokkien** — no production-grade open ASR exists; we commit to a rigorous evaluation of Taiwanese-Hokkien fine-tunes against Singaporean Hokkien in M1 and a transparent go/no-go, with Mandarin fallback + disclaimer meanwhile. We will not overclaim this language.
- **Translation quality ceiling** — the POC's on-prem LLM tier is selectable; M2 sizes the model to NUH's accuracy bar on NUH's own scenarios.
- **Device TTS variance** — mitigated by bundled offline voices (M2) replacing OS voices.

## 7. Metrics of Success — how we will measure

- **Consultation duration:** timestamped session analytics (aggregate counts/durations only — no content) comparing multilingual sessions with/without the tool against the 60/40-minute standards.
- **Understanding & adherence:** structured comprehension checks translated through the tool; clinician-rated communication-quality scores; PROM trends where NUH makes them available.
- **Engagement:** observed reduction in caregiver/colleague interpretation during trial sessions.
- **Manpower flexibility:** scheduling data — proportion of multilingual patients bookable to any clinician.

## 8. Scalability & Business Model

- **Technical scale:** one GPU server supports a clinic's concurrent consultations; stateless client; languages are configuration + voice-bundle additions. NUHS-cluster rollout = per-site server or GCC-hosted shared service.
- **Commercial model (indicative):** per-site licence + annual support; est. hardware SGD [X]k per site; software licence SGD [X]k/site/year including glossary tooling and model updates. Extension to other allied health professions is a glossary swap, not a rebuild.
- **[Placeholder: existing customers / revenue traction — Business Traction 10%]**

## 9. Company & Team

- **[Placeholder: company profile, UEN, past projects and track record — 10%]**
- **[Placeholder: team members, roles, technical certifications and relevant experience — 10%]**

## 10. Demonstration

A live demonstration is available immediately in Singapore: two-person multilingual consultation on a phone, glossary-controlled translation, mid-session correction learning, privacy-mode verification, and telehealth simulation. Demo script: `docs/demo-runbook.md`; architecture annex: `docs/data-processing-architecture.md`; language roadmap: `docs/roadmap.md`.

---

*Submission deadline: 14 Aug 2026, 1600 SGT via OIP.*
