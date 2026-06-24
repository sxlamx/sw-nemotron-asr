import os
import sys
import urllib.request

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.path.join(PROJECT_ROOT, "models")
os.makedirs(MODEL_DIR, exist_ok=True)

REPO_URL = "https://huggingface.co/tonythethompson/Nemotron-3.5-ASR-Streaming-0.6B-ONNX/resolve/main"
FILES = {
    "encoder.onnx": None,
    "encoder.onnx.data": 2454405120, # Explicitly expect 2.45 GB
    "decoder_joint.onnx": None,
    "tokenizer.model": None
}

def download_file(file_name, expected_size):
    url = f"{REPO_URL}/{file_name}"
    dest_path = os.path.join(MODEL_DIR, file_name)
    
    # Get remote size if not hardcoded
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    
    if expected_size is None:
        try:
            with urllib.request.urlopen(req) as res:
                expected_size = int(res.getheader('Content-Length', 0))
        except Exception as e:
            print(f"Error querying remote size for {file_name}: {e}")
            return False

    # Check if local file exists and matches size
    if os.path.exists(dest_path):
        local_size = os.path.getsize(dest_path)
        if local_size == expected_size:
            print(f"{file_name} already exists and is complete ({local_size} bytes).")
            return True
        else:
            print(f"{file_name} size mismatch: local {local_size} vs expected {expected_size}. Redownloading...")
            os.remove(dest_path)

    print(f"Downloading {file_name} ({expected_size / 1024 / 1024:.2f} MB)...")
    
    try:
        # Download with chunk progress reporting
        with urllib.request.urlopen(req) as response:
            with open(dest_path, 'wb') as out_file:
                downloaded = 0
                chunk_size = 1024 * 1024 # 1MB chunks
                
                while True:
                    chunk = response.read(chunk_size)
                    if not chunk:
                        break
                    out_file.write(chunk)
                    downloaded += len(chunk)
                    
                    # Print progress every 10MB
                    if downloaded % (10 * chunk_size) == 0 or downloaded == expected_size:
                        percent = (downloaded / expected_size) * 100
                        print(f"Progress: {percent:.1f}% ({downloaded / 1024 / 1024:.1f} / {expected_size / 1024 / 1024:.1f} MB)", end='\r')
                        sys.stdout.flush()
        print(f"\nSuccessfully downloaded {file_name}.")
        return True
    except Exception as e:
        if os.path.exists(dest_path):
            os.remove(dest_path)
        print(f"\nError downloading {file_name}: {e}")
        return False

if __name__ == "__main__":
    success = True
    for file_name, expected_size in FILES.items():
        if not download_file(file_name, expected_size):
            success = False
            break
            
    if success:
        print("All model files downloaded and verified successfully!")
        sys.exit(0)
    else:
        print("Model download failed.")
        sys.exit(1)
