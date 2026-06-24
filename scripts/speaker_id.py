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

def get_classifier():
    global _classifier
    if _classifier is None:
        _classifier = EncoderClassifier.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            savedir=MODEL_DIR,
            run_opts={"device": "cpu"},
        )
    return _classifier

def get_embedding(audio_path):
    data, fs = sf.read(audio_path, dtype="float32")
    if data.ndim == 1:
        signal = torch.from_numpy(data).unsqueeze(0)
    else:
        signal = torch.from_numpy(data.T)

    if fs != 16000:
        signal = torch.nn.functional.interpolate(
            signal.unsqueeze(0), scale_factor=16000 / fs, mode="linear", align_corners=False
        ).squeeze(0)

    if signal.shape[0] > 1:
        signal = torch.mean(signal, dim=0, keepdim=True)

    embeddings = get_classifier().encode_batch(signal)
    return embeddings.squeeze().cpu().numpy()

def cmd_enroll(speaker_id, audio_path):
    embedding = get_embedding(audio_path)
    dest_path = os.path.join(SPEAKERS_DIR, f"{speaker_id}.npy")
    np.save(dest_path, embedding)
    return f"SUCCESS:Enrolled {speaker_id}"

def cmd_identify(audio_path):
    test_emb = get_embedding(audio_path)
    best_score = -1.0
    best_speaker = "Unknown"

    for filename in os.listdir(SPEAKERS_DIR):
        if not filename.endswith(".npy"):
            continue
        sid = filename[:-4]
        ref_emb = np.load(os.path.join(SPEAKERS_DIR, filename))
        norm_a = np.linalg.norm(test_emb)
        norm_b = np.linalg.norm(ref_emb)
        similarity = np.dot(test_emb, ref_emb) / (norm_a * norm_b) if norm_a > 0 and norm_b > 0 else 0.0
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
