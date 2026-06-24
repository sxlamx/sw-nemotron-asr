# PowerShell script to download Nemotron-3.5-ASR ONNX model files

$ModelDir = Join-Path $PSScriptRoot "..\models"
if (-not (Test-Path $ModelDir)) {
    New-Item -ItemType Directory -Force -Path $ModelDir | Out-Null
}

$RepoUrl = "https://huggingface.co/tonythethompson/Nemotron-3.5-ASR-Streaming-0.6B-ONNX/resolve/main"
$Files = @("encoder.onnx", "encoder.onnx.data", "decoder_joint.onnx", "tokenizer.model")

foreach ($File in $Files) {
    $DestPath = Join-Path $ModelDir $File
    if (-not (Test-Path $DestPath)) {
        Write-Host "Downloading $File to $DestPath..."
        $Url = "$RepoUrl/$File"
        
        # Using Invoke-WebRequest
        try {
            Invoke-WebRequest -Uri $Url -OutFile $DestPath -UserAgent "Mozilla/5.0"
            Write-Host "Successfully downloaded $File."
        }
        catch {
            Write-Error "Failed to download $File from $Url. Error: $_"
            exit 1
        }
    } else {
        Write-Host "$File already exists, skipping download."
    }
}

Write-Host "All models verified in $ModelDir."
