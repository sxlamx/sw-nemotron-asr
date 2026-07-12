// tts.js — on-device text-to-speech for translated utterances.
//
// Provider chain (first available wins per language):
//   1. SherpaWasmProvider — locally-served WASM VITS voices under /tts/.
//      Activates only when /tts/manifest.json exists. Bundles must be built
//      MODULARIZE'd so multiple voices coexist; until then this provider
//      reports unavailable and the chain falls through. (Phase 4 item.)
//   2. WebSpeechProvider — browser/OS speechSynthesis. Voices are the device's
//      own TTS engines (on-device on modern iOS/Android). Zero download.
//
// VAD gating: while TTS is audible (+ a tail), window.TTS.isPlaying() returns
// true so the mic VAD can drop samples and not re-transcribe our own speaker.

(function () {
    'use strict';

    const PLAYBACK_TAIL_MS = 300; // keep gating active briefly after audio ends

    // BCP-47 candidates per app language code, in preference order.
    // First match against installed voices wins; otherwise utterance.lang is
    // set to the first candidate and the engine picks its default.
    const LANG_TAGS = {
        en:  ['en-SG', 'en-GB', 'en-US', 'en'],
        id:  ['id-ID', 'id'],
        ms:  ['ms-MY', 'ms'],
        ta:  ['ta-SG', 'ta-IN', 'ta-MY', 'ta'],
        yue: ['yue-HK', 'zh-HK', 'yue'],
        my:  ['my-MM', 'my'],
        zh:  ['zh-CN', 'cmn-Hans-CN', 'zh'],
        ko:  ['ko-KR', 'ko'],
    };

    let playing = false;
    let tailTimer = null;
    let audioCtxUnlocked = false;

    function setPlaying(v) {
        if (v) {
            if (tailTimer) { clearTimeout(tailTimer); tailTimer = null; }
            playing = true;
        } else {
            if (tailTimer) clearTimeout(tailTimer);
            tailTimer = setTimeout(() => { playing = false; tailTimer = null; }, PLAYBACK_TAIL_MS);
        }
        if (typeof window.onTTSGateChange === 'function') window.onTTSGateChange(playing);
    }

    // ── Provider: Web Speech API ────────────────────────────────────────────
    const WebSpeechProvider = {
        name: 'webspeech',
        voices: [],
        ready: false,

        init() {
            if (!('speechSynthesis' in window)) return;
            const load = () => {
                this.voices = window.speechSynthesis.getVoices() || [];
                this.ready = this.voices.length > 0;
            };
            load();
            // Chrome loads voices asynchronously
            if (window.speechSynthesis.onvoiceschanged !== undefined) {
                window.speechSynthesis.onvoiceschanged = load;
            }
        },

        pickVoice(lang) {
            const tags = LANG_TAGS[lang] || [lang];
            for (const tag of tags) {
                const lower = tag.toLowerCase();
                const exact = this.voices.find(v => v.lang && v.lang.toLowerCase() === lower);
                if (exact) return exact;
                const prefix = this.voices.find(v => v.lang && v.lang.toLowerCase().startsWith(lower));
                if (prefix) return prefix;
            }
            return null;
        },

        available(lang) {
            if (!('speechSynthesis' in window)) return false;
            // Even without a matched voice we can try: the engine may resolve
            // utterance.lang itself. Report true when the API exists.
            return true;
        },

        hasVoiceFor(lang) {
            return !!this.pickVoice(lang);
        },

        speak(text, lang) {
            return new Promise((resolve) => {
                if (!('speechSynthesis' in window)) { resolve(false); return; }
                try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
                const utt = new SpeechSynthesisUtterance(text);
                const voice = this.pickVoice(lang);
                if (voice) utt.voice = voice;
                utt.lang = (voice && voice.lang) || (LANG_TAGS[lang] || [lang])[0];
                utt.rate = 0.95;
                let done = false;
                const finish = (ok) => {
                    if (done) return;
                    done = true;
                    setPlaying(false);
                    resolve(ok);
                };
                utt.onstart = () => setPlaying(true);
                utt.onend = () => finish(true);
                utt.onerror = (e) => {
                    console.warn('[TTS] speechSynthesis error:', e.error || e);
                    finish(false);
                };
                // Safety: some engines never fire onend for empty/failed speech
                const est = Math.max(2000, 80 * text.length);
                setTimeout(() => finish(false), est + 5000);
                setPlaying(true); // gate immediately; onstart can lag the first audio
                window.speechSynthesis.speak(utt);
            });
        },
    };

    // ── Provider: sherpa-onnx WASM (slot; activates when bundles are served) ─
    const SherpaWasmProvider = {
        name: 'sherpa-wasm',
        manifest: null,

        async init() {
            try {
                const res = await fetch('/tts/manifest.json', { cache: 'no-store' });
                if (res.ok) {
                    this.manifest = await res.json();
                    console.log('[TTS] sherpa-wasm manifest found:', this.manifest);
                }
            } catch (e) { /* not deployed — normal */ }
        },

        available(lang) {
            // Loader for MODULARIZE'd per-voice bundles lands in Phase 4.
            return false;
        },

        speak() { return Promise.resolve(false); },
    };

    const providers = [SherpaWasmProvider, WebSpeechProvider];

    // ── Public API ──────────────────────────────────────────────────────────
    window.TTS = {
        enabled: true,

        async init() {
            WebSpeechProvider.init();
            await SherpaWasmProvider.init();
        },

        // Must be called from a user gesture (record button) so iOS/Android
        // allow subsequent programmatic playback.
        unlock() {
            if (audioCtxUnlocked) return;
            audioCtxUnlocked = true;
            if ('speechSynthesis' in window) {
                // Speaking an empty utterance inside the gesture unlocks the engine
                try {
                    const u = new SpeechSynthesisUtterance('');
                    u.volume = 0;
                    window.speechSynthesis.speak(u);
                } catch (e) { /* ignore */ }
            }
        },

        isPlaying() { return playing; },

        providerFor(lang) {
            return providers.find(p => p.available(lang)) || null;
        },

        // True when the device very likely has a real voice for this language
        hasVoiceFor(lang) {
            if (SherpaWasmProvider.available(lang)) return true;
            return WebSpeechProvider.hasVoiceFor(lang);
        },

        stop() {
            if ('speechSynthesis' in window) {
                try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
            }
            setPlaying(false);
        },

        // Speak text in the given app language code; resolves when done.
        async speak(text, lang) {
            if (!this.enabled || !text || !text.trim()) return false;
            const provider = this.providerFor(lang);
            if (!provider) {
                console.warn('[TTS] No provider available for', lang);
                return false;
            }
            return provider.speak(text, lang);
        },
    };
})();
