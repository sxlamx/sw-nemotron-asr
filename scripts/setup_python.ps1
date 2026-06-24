# PowerShell script to set up Python virtual environment and dependencies

$VenvDir = Join-Path $PSScriptRoot "..\.venv"
$PythonExe = Join-Path $VenvDir "Scripts\python.exe"
$PipExe = Join-Path $VenvDir "Scripts\pip.exe"

if (-not (Test-Path $VenvDir)) {
    Write-Host "Creating Python virtual environment in $VenvDir..."
    python -m venv $VenvDir
    if (-not $?) {
        Write-Error "Failed to create virtual environment."
        exit 1
    }
} else {
    Write-Host "Virtual environment already exists."
}

Write-Host "Upgrading pip..."
Start-Process -FilePath $PythonExe -ArgumentList "-m pip install --upgrade pip" -Wait -NoNewWindow

Write-Host "Installing SpeechBrain, PyTorch (CPU-only), torchaudio, and numpy..."
# Use CPU-only torch to minimize download size (~150MB vs ~2GB)
Start-Process -FilePath $PipExe -ArgumentList "install torch torchaudio --extra-index-url https://download.pytorch.org/whl/cpu" -Wait -NoNewWindow
Start-Process -FilePath $PipExe -ArgumentList "install speechbrain numpy" -Wait -NoNewWindow

Write-Host "Python environment setup complete."
