#!/bin/bash
# Bash script to set up Python virtual environment and dependencies on macOS/Linux

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/../.venv"
PYTHON_EXE="$VENV_DIR/bin/python"
PIP_EXE="$VENV_DIR/bin/pip"

if [ ! -d "$VENV_DIR" ]; then
    echo "Creating Python virtual environment in $VENV_DIR..."
    python3 -m venv "$VENV_DIR"
    if [ $? -ne 0 ]; then
        echo "Error: Failed to create virtual environment."
        exit 1
    fi
else
    echo "Virtual environment already exists."
fi

echo "Upgrading pip..."
"$PYTHON_EXE" -m pip install --upgrade pip

echo "Installing SpeechBrain, PyTorch (CPU-only), torchaudio, and numpy..."
# Use CPU-only torch to minimize download size
"$PIP_EXE" install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
"$PIP_EXE" install speechbrain numpy

echo "Installing faster-whisper, openai, and httpx for ASR/translation worker..."
"$PIP_EXE" install faster-whisper openai httpx

echo "Python environment setup complete."
