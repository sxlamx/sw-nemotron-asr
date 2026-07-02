import sys
import os
import numpy as np
import torch
import soundfile as sf
from speechbrain.inference.speaker import EncoderClassifier

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.path.join(PROJECT_ROOT, "models", "speaker_id_model")
SPEAKERS_DIR = os.path.join(PROJECT_ROOT, "data", "speakers")

os.makedirs(SPEAKERS_DIR, exist_ok=True)

_classifier = None
_vad_model = None
_vad_utils = None

def get_classifier():
    global _classifier
    if _classifier is None:
        _classifier = EncoderClassifier.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            savedir=MODEL_DIR,
            run_opts={"device": "cpu"},
        )
    return _classifier

def get_vad_model():
    global _vad_model, _vad_utils
    if _vad_model is None:
        # Silero VAD is loaded via torch.hub and cached locally
        _vad_model, utils = torch.hub.load(
            repo_or_dir='snakers4/silero-vad',
            model='silero_vad',
            force_reload=False,
            onnx=False
        )
        _vad_utils = utils
    return _vad_model, _vad_utils

def get_embedding(audio_path):
    data, fs = sf.read(audio_path, dtype="float32")
    if len(data) == 0:
        print("Error: Audio file is empty.", file=sys.stderr, flush=True)
        return None

    if data.ndim == 1:
        signal = torch.from_numpy(data).unsqueeze(0)
    else:
        signal = torch.from_numpy(data.T)

    # 1. High-quality resampling using torchaudio Sinc Interpolation
    if fs != 16000:
        try:
            import torchaudio.transforms as T
            resampler = T.Resample(orig_freq=fs, new_freq=16000)
            signal = resampler(signal)
            print(f"Resampled audio from {fs}Hz to 16000Hz.", file=sys.stderr, flush=True)
        except Exception as e:
            print(f"Torchaudio resampling failed: {e}. Falling back to linear interpolation.", file=sys.stderr, flush=True)
            signal = torch.nn.functional.interpolate(
                signal.unsqueeze(0), scale_factor=16000 / fs, mode="linear", align_corners=False
            ).squeeze(0)

    # Convert to mono if multi-channel
    if signal.shape[0] > 1:
        signal = torch.mean(signal, dim=0, keepdim=True)

    signal_mono = signal.squeeze(0)

    # 2. Voice Activity Detection (VAD) using Silero VAD
    try:
        vad_model, utils = get_vad_model()
        get_speech_timestamps, _, _, _, collect_chunks = utils
        
        # Get speech intervals
        speech_timestamps = get_speech_timestamps(signal_mono, vad_model, sampling_rate=16000)
        
        if len(speech_timestamps) > 0:
            signal_mono = collect_chunks(speech_timestamps, signal_mono)
            print(f"VAD: Kept {signal_mono.shape[0]/16000:.2f}s of active speech.", file=sys.stderr, flush=True)
        else:
            print("VAD: No speech detected in audio.", file=sys.stderr, flush=True)
            return None
    except Exception as e:
        print(f"VAD skipped: {e}. Processing full audio.", file=sys.stderr, flush=True)

    # Add channel dimension back for SpeechBrain
    signal_input = signal_mono.unsqueeze(0)

    embeddings = get_classifier().encode_batch(signal_input)
    return embeddings.squeeze().cpu().numpy()

def cmd_enroll(speaker_id, audio_path):
    embedding = get_embedding(audio_path)
    if embedding is None:
        return "ERROR:No speech detected in enrollment audio."
    
    # L2 normalize the new embedding
    norm_emb = np.linalg.norm(embedding)
    if norm_emb > 0:
        embedding = embedding / norm_emb
    else:
        return "ERROR:Zero magnitude embedding."

    dest_path = os.path.join(SPEAKERS_DIR, f"{speaker_id}.npy")
    if os.path.exists(dest_path):
        try:
            old_embedding = np.load(dest_path)
            # L2 normalize old embedding to be safe
            norm_old = np.linalg.norm(old_embedding)
            if norm_old > 0:
                old_embedding = old_embedding / norm_old
            
            # Weighted blend: 70% old, 30% new
            blended = old_embedding * 0.7 + embedding * 0.3
            norm_blended = np.linalg.norm(blended)
            if norm_blended > 0:
                embedding = blended / norm_blended
            print(f"VAD/Enroll: Blended new embedding with existing profile for {speaker_id}.", file=sys.stderr, flush=True)
        except Exception as e:
            print(f"VAD/Enroll Warning: Failed to blend embeddings: {e}. Overwriting.", file=sys.stderr, flush=True)

    np.save(dest_path, embedding)
    return f"SUCCESS:Enrolled {speaker_id}"

def cmd_identify(audio_path):
    test_emb = get_embedding(audio_path)
    if test_emb is None:
        return "IDENTIFIED:Unknown:0.0000"
    
    # L2 normalize test embedding to be safe
    norm_test = np.linalg.norm(test_emb)
    if norm_test > 0:
        test_emb = test_emb / norm_test

    best_score = -1.0
    best_speaker = "Unknown"

    for filename in os.listdir(SPEAKERS_DIR):
        if not filename.endswith(".npy"):
            continue
        sid = filename[:-4]
        ref_emb = np.load(os.path.join(SPEAKERS_DIR, filename))
        
        # Normalize reference embedding
        norm_ref = np.linalg.norm(ref_emb)
        if norm_ref > 0:
            ref_emb = ref_emb / norm_ref
            
        similarity = np.dot(test_emb, ref_emb)
        if similarity > best_score:
            best_score = similarity
            best_speaker = sid

    THRESHOLD = 0.6
    tag = best_speaker if best_score >= THRESHOLD else "Unknown"
    return f"IDENTIFIED:{tag}:{best_score:.4f}"

def run_persistent():
    """Load model once, serve identify/enroll commands via stdin/stdout."""
    get_classifier()
    print("READY", flush=True)

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        parts = line.split(" ", 2)
        cmd = parts[0]
        try:
            if cmd == "identify" and len(parts) >= 2:
                print(cmd_identify(parts[1]), flush=True)
            elif cmd == "enroll" and len(parts) >= 3:
                print(cmd_enroll(parts[1], parts[2]), flush=True)
            else:
                print(f"ERROR:unknown command: {cmd}", flush=True)
        except Exception as e:
            print(f"ERROR:{e}", flush=True)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: speaker_id.py <persist|enroll|identify> ...")
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "persist":
        run_persistent()
    elif cmd == "enroll":
        if len(sys.argv) < 4:
            print("Error: enroll requires <speaker_id> <audio_path>")
            sys.exit(1)
        try:
            get_classifier()
            print(cmd_enroll(sys.argv[2], sys.argv[3]))
        except Exception as e:
            print(f"ERROR:{e}")
            sys.exit(1)
    elif cmd == "identify":
        try:
            get_classifier()
            print(cmd_identify(sys.argv[2]))
        except Exception as e:
            print(f"ERROR:{e}")
            sys.exit(1)
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)
