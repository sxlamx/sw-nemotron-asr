import sys
import os
import numpy as np
import torch
import torchaudio
from speechbrain.inference.speaker import EncoderClassifier

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.path.join(PROJECT_ROOT, "models", "speaker_id_model")
SPEAKERS_DIR = os.path.join(PROJECT_ROOT, "data", "speakers")

os.makedirs(SPEAKERS_DIR, exist_ok=True)

# Load classifier
classifier = EncoderClassifier.from_hparams(
    source="speechbrain/spkrec-ecapa-voxceleb",
    savedir=MODEL_DIR,
    run_opts={"device": "cpu"} # Force CPU execution to avoid requiring CUDA libraries
)

def get_embedding(audio_path):
    # Load audio using torchaudio
    signal, fs = torchaudio.load(audio_path)
    
    # SpeechBrain ECAPA-TDNN model expects 16kHz mono audio
    # Resample if needed
    if fs != 16000:
        resampler = torchaudio.transforms.Resample(orig_freq=fs, new_freq=16000)
        signal = resampler(signal)
    
    # Check if stereo, convert to mono
    if signal.shape[0] > 1:
        signal = torch.mean(signal, dim=0, keepdim=True)
        
    embeddings = classifier.encode_batch(signal)
    # The embeddings shape is [1, 1, 192], squeeze to [192]
    embedding_numpy = embeddings.squeeze().cpu().numpy()
    return embedding_numpy

def enroll(speaker_id, audio_path):
    try:
        embedding = get_embedding(audio_path)
        dest_path = os.path.join(SPEAKERS_DIR, f"{speaker_id}.npy")
        np.save(dest_path, embedding)
        print(f"SUCCESS: Enrolled speaker '{speaker_id}' to {dest_path}")
    except Exception as e:
        print(f"ERROR: {str(e)}")
        sys.exit(1)

def identify(audio_path):
    try:
        test_emb = get_embedding(audio_path)
        
        best_score = -1.0
        best_speaker = "Unknown"
        
        # Load all enrolled speaker profiles
        for filename in os.listdir(SPEAKERS_DIR):
            if filename.endswith(".npy"):
                speaker_id = filename[:-4]
                emb_path = os.path.join(SPEAKERS_DIR, filename)
                ref_emb = np.load(emb_path)
                
                # Calculate cosine similarity
                dot_prod = np.dot(test_emb, ref_emb)
                norm_a = np.linalg.norm(test_emb)
                norm_b = np.linalg.norm(ref_emb)
                
                if norm_a > 0 and norm_b > 0:
                    similarity = dot_prod / (norm_a * norm_b)
                else:
                    similarity = 0.0
                
                if similarity > best_score:
                    best_score = similarity
                    best_speaker = speaker_id
                    
        # Set a similarity threshold (0.6 is standard for ECAPA-TDNN)
        THRESHOLD = 0.6
        if best_score >= THRESHOLD:
            print(f"IDENTIFIED:{best_speaker}:{best_score:.4f}")
        else:
            print(f"IDENTIFIED:Unknown:{best_score:.4f}")
            
    except Exception as e:
        print(f"ERROR: {str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage:")
        print("  python speaker_id.py enroll <speaker_id> <audio_path>")
        print("  python speaker_id.py identify <audio_path>")
        sys.exit(1)
        
    cmd = sys.argv[1]
    if cmd == "enroll":
        if len(sys.argv) < 4:
            print("Error: speaker_id required for enroll command")
            sys.exit(1)
        enroll(sys.argv[2], sys.argv[3])
    elif cmd == "identify":
        identify(sys.argv[2])
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)
