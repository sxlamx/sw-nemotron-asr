Here is a comprehensive design specification and a ready-to-use set of instructions that you can feed directly to an LLM coding agent to build this system.

### **System Architecture & Design Specifications**

#### **1. High-Level Architecture**

* **Client Interface (Frontend):** A React-based web interface that utilizes the `MediaRecorder` API to capture audio from the user's microphone, sending it to the backend via HTTP POST.
* **API Gateway (Rust):** A high-performance web server (using `axum`) that handles incoming audio blobs, manages session UUIDs, and orchestrates file I/O operations.
* **Inference Engine (Nemotron-3.5-ASR):** The backend leverages the quantized ONNX variant of Nemotron-3.5-ASR (e.g., `onnx-community/nemotron-3.5-asr-streaming-0.6b-onnx-int4`). Because it uses a Cache-Aware FastConformer-RNNT architecture, it runs efficiently on CPUs or GPUs using the `ort` crate or `parakeet-rs` wrapper.
* **Storage Layer:** A local file system directory structure organized by `session_id`. Each session folder acts as the single source of truth, containing both the raw `.wav` audio file and a `transcript.txt` file.

#### **2. Backend Workflow**

1. **Session Initialization:** Upon receiving an audio payload, the Rust backend generates a unique UUID (`session_id`) and creates a corresponding storage directory (`/sessions/{session_id}/`).
2. **Audio Ingestion:** The client streams or posts the audio to the server. The Rust backend writes the file directly to `{session_id}/audio.wav`.
3. **Transcription Pipeline:**
* The audio is read and resampled to 16kHz mono (the required input format for Nemotron).
* The audio tensor is passed to the ONNX runtime. The model's `prompt_index` tensor is passed to support multilingual auto-detection across your target channels.


4. **Finalization:** The final transcript text is written to `{session_id}/transcript.txt` and a JSON payload is returned to the frontend.

---

### **Prompt Instructions for your LLM Coding Agent**

*Copy and paste the block below into your AI coding assistant (like Cursor, Claude, or ChatGPT) to generate the complete codebase.*

---

**System Prompt / Instruction:**
You are an expert full-stack engineer and system architect. I need you to build an end-to-end web application and API that records voice on the frontend and transcribes it on the backend using Rust and NVIDIA's Nemotron-3.5-ASR model.

Please generate the complete codebase, ensuring it meets the following technical requirements:

**1. Frontend (React / Vite.js)**

* Create a clean, intuitive web interface to record audio using the browser's `MediaRecorder` API.
* Include a "Start Recording" and "Stop Recording" button.
* When recording stops, package the audio blob and send it via a `multipart/form-data` POST request to the Rust backend.
* Display the returned transcript on the screen.

**2. Backend (Rust / Axum)**

* Set up an Axum web server with CORS enabled to accept requests from the React frontend.
* **Endpoint 1 (`POST /api/transcribe`):** Accepts the audio file payload.
* **File Management:** For every request, generate a unique `session_id` (UUID v4). Create a directory structure like `data/sessions/{session_id}/`.
* Save the uploaded audio file as `audio.wav` inside the newly created session folder.

**3. Model Integration (Nemotron-3.5-ASR via ONNX)**

* Use the `ort` (ONNX Runtime) crate or the `parakeet-rs` crate to load the `onnx-community/nemotron-3.5-asr-streaming-0.6b-onnx-int4` model.
* Implement an audio processing step using the `hound` or `rubato` crates to ensure the incoming audio is resampled to mono, 16kHz.
* Run the inference. Since this model supports 40 languages, ensure the `prompt_index` tensor is set to auto-detect (`101`) or configured specifically to handle a mix of English, Bahasa Melayu, and 中文.
* Capture the output transcript string.

**4. Storage and Response**

* Save the final text output to a file named `transcript.txt` in the exact same `{session_id}` folder as the audio file.
* Return a JSON response to the client containing the `session_id` and the `transcript`.

Please provide:

1. The `Cargo.toml` with all necessary high-performance dependencies.
2. The complete Rust backend code (`main.rs` and any routing/inference module files).
3. The React frontend code (`App.jsx` and API calling logic).
4. Step-by-step instructions on how to download the Nemotron ONNX model files and boot up the stack.

---
