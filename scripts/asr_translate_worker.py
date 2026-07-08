import sys
import os
import json
import shutil

# Windows: symlink creation requires elevated privileges; fall back to copy
_orig_symlink = os.symlink
def _symlink_or_copy(src, dst, target_is_directory=False):
    try:
        _orig_symlink(src, dst, target_is_directory)
    except OSError:
        if os.path.isdir(src): shutil.copytree(src, dst)
        else: shutil.copy2(src, dst)
os.symlink = _symlink_or_copy

# Windows: corporate proxy intercepts HTTPS; disable SSL verification for model downloads
import ssl as _ssl
_ssl._create_default_https_context = _ssl._create_unverified_context

import httpx

# Bypass corporate SSL interception for HuggingFace model downloads.
# huggingface_hub 1.x uses httpx internally; set_client_factory lets us inject
# a client with verify=False before any download is attempted.
try:
    from huggingface_hub.utils._http import (
        set_client_factory as _hf_set_client_factory,
        hf_request_event_hook as _hf_hook,
    )
    def _ssl_bypass_hf_factory() -> httpx.Client:
        return httpx.Client(
            event_hooks={"request": [_hf_hook]},
            follow_redirects=True,
            timeout=None,
            verify=False,
        )
    _hf_set_client_factory(_ssl_bypass_hf_factory)
except Exception:
    pass  # Best-effort; may still succeed if proxy doesn't intercept

import torch
from faster_whisper import WhisperModel

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WHISPER_MODEL_DIR = os.path.join(PROJECT_ROOT, "models", "whisper")

_whisper_model = None

def get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        _whisper_model = WhisperModel(
            "small",
            device="cpu",
            compute_type="int8",
            download_root=WHISPER_MODEL_DIR,
        )
    return _whisper_model

def cmd_transcribe(audio_path: str, source_lang: str) -> dict:
    model = get_whisper_model()
    lang_arg = None if source_lang == "auto" else source_lang
    try:
        segments, info = model.transcribe(
            audio_path,
            language=lang_arg,
            beam_size=5,
            vad_filter=True,
            vad_parameters={"threshold": 0.3},
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        detected = info.language if source_lang == "auto" else source_lang
        return {"status": "ok", "text": text, "detected_lang": detected}
    except Exception as e:
        return {"status": "error", "message": str(e)}

def cmd_translate(text: str, source_lang: str, target_lang: str, api_key: str) -> dict:
    if not text.strip():
        return {"status": "ok", "translation": ""}
    if source_lang == target_lang:
        return {"status": "ok", "translation": text}
    if not api_key:
        return {"status": "error", "message": "No Nemotron API key configured"}
    try:
        from openai import OpenAI
        client = OpenAI(
            base_url="https://integrate.api.nvidia.com/v1",
            api_key=api_key,
            http_client=__import__("httpx").Client(verify=False),
        )
        lang_names = {
            "zh": "Simplified Chinese", "en": "English",
            "ms": "Malay", "ta": "Tamil", "ko": "Korean",
        }
        src_name = lang_names.get(source_lang, source_lang)
        tgt_name = lang_names.get(target_lang, target_lang)
        prompt = (
            f"Translate the following {src_name} text to {tgt_name}. "
            f"Output only the translation, no explanations.\n\nText: {text}"
        )
        resp = client.chat.completions.create(
            model="nvidia/llama-3.1-nemotron-70b-instruct",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=512,
        )
        translation = resp.choices[0].message.content.strip()
        return {"status": "ok", "translation": translation}
    except Exception as e:
        return {"status": "error", "message": str(e)}

def run_persistent():
    get_whisper_model()
    print("READY", flush=True)
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            cmd = req.get("cmd")
            if cmd == "transcribe":
                result = cmd_transcribe(req["audio_path"], req.get("source_lang", "auto"))
            elif cmd == "translate":
                result = cmd_translate(
                    req["text"], req["source_lang"], req["target_lang"], req.get("api_key", "")
                )
            else:
                result = {"status": "error", "message": f"unknown cmd: {cmd}"}
        except Exception as e:
            result = {"status": "error", "message": str(e)}
        print(json.dumps(result), flush=True)

if __name__ == "__main__":
    run_persistent()
