import sys
import os
import json
import shutil
import numpy as np
import torch
import soundfile as sf
from speechbrain.inference.speaker import EncoderClassifier

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.path.join(PROJECT_ROOT, "models", "speaker_id_model")
SPEAKERS_DIR = os.path.join(PROJECT_ROOT, "data", "speakers")

DEFAULT_MAX_SAMPLES = 10
DEFAULT_MIN_SAMPLES = 3

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

def migrate_flat_embeddings():
    for f in os.listdir(SPEAKERS_DIR):
        full = os.path.join(SPEAKERS_DIR, f)
        if os.path.isfile(full) and f.endswith(".npy"):
            sid = f[:-4]
            dest_dir = os.path.join(SPEAKERS_DIR, sid, "embeddings")
            os.makedirs(dest_dir, exist_ok=True)
            shutil.move(full, os.path.join(dest_dir, "001.npy"))
            # Write a default threshold.json since we only have 1 sample
            thresh_path = os.path.join(SPEAKERS_DIR, sid, "threshold.json")
            if not os.path.exists(thresh_path):
                with open(thresh_path, "w") as tf:
                    json.dump({"threshold": 0.60, "sample_count": 1}, tf)
            print(f"Migrated {f} → {sid}/embeddings/001.npy", file=sys.stderr, flush=True)

def cmd_enroll(speaker_id, audio_path, max_samples=DEFAULT_MAX_SAMPLES):
    embedding = get_embedding(audio_path)
    if embedding is None:
        return "ERROR:No speech detected in enrollment audio."

    # L2-normalize the new embedding
    norm_emb = np.linalg.norm(embedding)
    if norm_emb > 0:
        embedding = embedding / norm_emb
    else:
        return "ERROR:Zero magnitude embedding."

    # Create speaker embeddings directory if needed
    emb_dir = os.path.join(SPEAKERS_DIR, speaker_id, "embeddings")
    os.makedirs(emb_dir, exist_ok=True)

    # List existing .npy files sorted by name
    existing = sorted(f for f in os.listdir(emb_dir) if f.endswith(".npy"))

    # Evict oldest sample if at capacity
    if len(existing) >= max_samples:
        oldest = os.path.join(emb_dir, existing[0])
        os.remove(oldest)
        existing = existing[1:]

    # Determine next index
    if existing:
        last_index = max(int(os.path.splitext(f)[0]) for f in existing)
        next_index = last_index + 1
    else:
        next_index = 1

    dest_path = os.path.join(emb_dir, f"{next_index:03d}.npy")
    np.save(dest_path, embedding)

    # Reload all embeddings (including the new one) for threshold computation
    all_files = sorted(f for f in os.listdir(emb_dir) if f.endswith(".npy"))
    all_embeddings = [np.load(os.path.join(emb_dir, f)) for f in all_files]
    n = len(all_embeddings)

    if n == 1:
        threshold = 0.60
    else:
        loo_scores = []
        for i in range(n):
            others = [all_embeddings[j] for j in range(n) if j != i]
            sims = [float(np.dot(all_embeddings[i], other)) for other in others]
            loo_scores.append(float(np.mean(sims)))
        mean_loo = float(np.mean(loo_scores))
        std_loo = float(np.std(loo_scores))
        threshold = float(max(0.40, min(0.80, mean_loo - 1.5 * std_loo)))

    thresh_path = os.path.join(SPEAKERS_DIR, speaker_id, "threshold.json")
    with open(thresh_path, "w") as tf:
        json.dump({"threshold": threshold, "sample_count": n}, tf)

    return f"SUCCESS:Enrolled {speaker_id}:count={n}"

def cmd_identify(audio_path, min_samples=DEFAULT_MIN_SAMPLES):
    test_emb = get_embedding(audio_path)
    if test_emb is None:
        return "IDENTIFIED:Unknown:0.0000"

    # L2-normalize the test embedding
    norm_test = np.linalg.norm(test_emb)
    if norm_test > 0:
        test_emb = test_emb / norm_test

    best_score = -1.0
    best_speaker = None
    best_threshold = 0.0

    for entry in os.listdir(SPEAKERS_DIR):
        speaker_dir = os.path.join(SPEAKERS_DIR, entry)
        if not os.path.isdir(speaker_dir):
            continue

        thresh_path = os.path.join(speaker_dir, "threshold.json")
        if not os.path.exists(thresh_path):
            continue

        with open(thresh_path, "r") as tf:
            thresh_data = json.load(tf)

        if thresh_data.get("sample_count", 0) < min_samples:
            continue

        emb_dir = os.path.join(speaker_dir, "embeddings")
        if not os.path.isdir(emb_dir):
            continue

        ref_files = [f for f in os.listdir(emb_dir) if f.endswith(".npy")]
        if not ref_files:
            continue

        sims = []
        for rf in ref_files:
            ref_emb = np.load(os.path.join(emb_dir, rf))
            norm_ref = np.linalg.norm(ref_emb)
            if norm_ref > 0:
                ref_emb = ref_emb / norm_ref
            sims.append(float(np.dot(test_emb, ref_emb)))

        speaker_score = float(np.mean(sims))
        if speaker_score > best_score:
            best_score = speaker_score
            best_speaker = entry
            best_threshold = float(thresh_data.get("threshold", 0.60))

    if best_speaker is None:
        return "IDENTIFIED:Unknown:0.0000"

    if best_score >= best_threshold:
        return f"IDENTIFIED:{best_speaker}:{best_score:.4f}"
    else:
        return f"IDENTIFIED:Unknown:{best_score:.4f}"

def run_persistent():
    """Load model once, serve identify/enroll commands via stdin/stdout."""
    migrate_flat_embeddings()
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
                print(cmd_identify(parts[1], min_samples=DEFAULT_MIN_SAMPLES), flush=True)
            elif cmd == "enroll" and len(parts) >= 3:
                print(cmd_enroll(parts[1], parts[2], max_samples=DEFAULT_MAX_SAMPLES), flush=True)
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
