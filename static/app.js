// AuraNemotron Web Client JS

let audioCtx = null;
let micStream = null;
let sourceNode = null;
let analyserNode = null;
let scriptNode = null;
let audioBuffer = [];
let isRecording = false;
let recordStartTime = 0;
let timeIntervalId = null;

// WebSocket state
let ws = null;
let wsReconnectTimer = null;

// Visualizer configuration
const canvas = document.getElementById('visualizer');
const canvasCtx = canvas.getContext('2d');
let animationFrameId = null;

// UI Elements
const recStatus = document.getElementById('rec-status');
const recordTrigger = document.getElementById('record-trigger');
const micIcon = document.getElementById('mic-icon');
const stopIcon = document.getElementById('stop-icon');
const timeDisplay = document.getElementById('recording-time');
const resultBox = document.getElementById('transcription-result');
const resSpeakerName = document.getElementById('res-speaker-name');
const resMeta = document.getElementById('res-meta');
const resText = document.getElementById('res-text');
const resSpeakerBadge = document.getElementById('res-speaker');
const resSpeakerConfidence = document.getElementById('res-speaker-confidence');
const resAliases = document.getElementById('res-aliases');
const resAliasesList = document.getElementById('res-aliases-list');

// Speaker Enrollment UI Elements
const speakerTableBody = document.getElementById('speaker-table-body');
const enrollBtn = document.getElementById('enroll-btn');
const enrollMicStatus = document.getElementById('enroll-mic-status');
const speakerIdInput = document.getElementById('speaker-id');
const speakerNameInput = document.getElementById('speaker-name');
const speakerAliasesInput = document.getElementById('speaker-aliases');

// Modal Elements
const editModal = document.getElementById('edit-modal');
const modalDisplayName = document.getElementById('modal-display-name');
const modalAliases = document.getElementById('modal-aliases');
const modalCloseBtn = document.getElementById('modal-close-btn');
const modalCancelBtn = document.getElementById('modal-cancel-btn');
const modalSaveBtn = document.getElementById('modal-save-btn');
let editingSpeakerId = null;

// Settings & Recordings UI Elements
const recordingsTableBody = document.getElementById('recordings-table-body');
const sessionAudio = document.getElementById('session-audio');
const refreshSessionsBtn = document.getElementById('refresh-sessions-btn');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const settingCuratedFolder = document.getElementById('setting-curated-folder');
const settingMinSamples = document.getElementById('setting-min-samples');
const settingMaxSamples = document.getElementById('setting-max-samples');
const settingsStatus = document.getElementById('settings-status');
const enrollSampleCount = document.getElementById('enroll-sample-count');

// Cache of speakers and aliases
let speakerAliasesMap = {};

// Resize canvas
function resizeCanvas() {
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = 100;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Initial page load
document.addEventListener('DOMContentLoaded', () => {
    fetchSpeakers();
    fetchSettings();
    fetchSessions();
    drawVisualizerIdle();
    connectWebSocket();
    initLangSelectors();
});

window.addEventListener('beforeunload', () => {
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    if (ws) ws.close();
});

// ─── WebSocket Management ────────────────────────────────────────────────────

let wsPendingResponse = false;

function connectWebSocket() {
    if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
    }
    // Don't open a second connection if one is already live
    if (ws && ws.readyState !== WebSocket.CLOSED) return;
    try {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${proto}//${location.host}/ws/transcribe`;
        ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
            console.log('[WS] Connected to', wsUrl);
        };

        ws.onmessage = (event) => {
            wsPendingResponse = false;
            try {
                const data = JSON.parse(event.data);
                displayLiveResult(data);
            } catch (err) {
                console.error('[WS] Failed to parse message:', err, event.data);
            }
        };

        ws.onerror = (err) => {
            console.error('[WS] WebSocket error:', err);
        };

        ws.onclose = (event) => {
            console.log('[WS] Connection closed (code:', event.code, '). Reconnecting in 3s...');
            if (wsPendingResponse) {
                wsPendingResponse = false;
                resetRecordUI();
            }
            ws = null;
            wsReconnectTimer = setTimeout(connectWebSocket, 3000);
        };
    } catch (err) {
        console.error('[WS] Failed to create WebSocket:', err);
        wsReconnectTimer = setTimeout(connectWebSocket, 3000);
    }
}

// Send recorded WAV blob via WebSocket; REST fallback when WS is not available
async function sendAudioViaWS(blob) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('[WS] WebSocket not ready — falling back to REST /api/transcribe.');
        await uploadAndTranscribe(blob);
        // Re-enable button (uploadAndTranscribe only re-enables on error via resetRecordUI)
        recordTrigger.disabled = false;
        return;
    }
    showLiveProcessing();
    try {
        const arrayBuffer = await blob.arrayBuffer();
        wsPendingResponse = true;
        ws.send(arrayBuffer);
        // Response arrives asynchronously via ws.onmessage → displayLiveResult
    } catch (err) {
        wsPendingResponse = false;
        console.error('[WS] Error sending audio:', err);
        resetRecordUI();
    }
}

// Show "Processing..." state in the live transcript panel
function showLiveProcessing() {
    const panel = document.getElementById('live-transcript-panel');
    panel.style.display = 'block';
    document.getElementById('live-processing-indicator').style.display = 'inline';
    document.getElementById('live-original-text').textContent = '';
    document.getElementById('live-translation-section').style.display = 'none';
    document.getElementById('live-speaker-info').textContent = '';
    document.getElementById('live-lang-label').textContent = '—';
}

// Update live transcript panel when WS response arrives
function displayLiveResult(data) {
    // Re-enable record button and reset status
    recordTrigger.disabled = false;
    recStatus.innerText = 'Idle';
    recStatus.className = 'status-badge idle';

    const panel = document.getElementById('live-transcript-panel');
    panel.style.display = 'block';
    document.getElementById('live-processing-indicator').style.display = 'none';

    // Language route label: detected_lang → target_lang
    const srcLang = data.detected_lang || document.getElementById('source-lang').value || 'auto';
    const tgtLang = data.target_lang || document.getElementById('target-lang').value || 'en';
    document.getElementById('live-lang-label').textContent = `${srcLang} → ${tgtLang}`;

    // Original transcript
    document.getElementById('live-original-text').textContent = data.transcript || '(No speech detected)';

    // Translation (hidden when empty)
    if (data.translation) {
        document.getElementById('live-translation-section').style.display = 'block';
        document.getElementById('live-translation-text').textContent = data.translation;
    } else {
        document.getElementById('live-translation-section').style.display = 'none';
    }

    // Speaker info
    const speakerId = data.speaker_id;
    const confidence = data.confidence;
    if (speakerId && speakerId !== 'Unknown') {
        const confStr = confidence && confidence > 0
            ? ` (${(confidence * 100).toFixed(0)}%)`
            : '';
        document.getElementById('live-speaker-info').textContent = `Speaker: ${speakerId}${confStr}`;
    } else {
        document.getElementById('live-speaker-info').textContent = 'Speaker: Unknown';
    }

    // Also update the classic result box and refresh recordings list
    displayResult(data);
    fetchSessions();
}

// ─── Language Selector Init & Handlers ───────────────────────────────────────

function initLangSelectors() {
    const sourceLang = document.getElementById('source-lang');
    const targetLang = document.getElementById('target-lang');

    sourceLang.addEventListener('change', async () => {
        try {
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source_language: sourceLang.value })
            });
            console.log('[Settings] source_language →', sourceLang.value);
        } catch (err) {
            console.error('[Settings] Failed to save source_language:', err);
        }
    });

    targetLang.addEventListener('change', async () => {
        try {
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ target_language: targetLang.value })
            });
            console.log('[Settings] target_language →', targetLang.value);
        } catch (err) {
            console.error('[Settings] Failed to save target_language:', err);
        }
    });
}

// ─── Speaker Database ─────────────────────────────────────────────────────────

// Fetch speakers mapping from backend
async function fetchSpeakers() {
    try {
        const response = await fetch('/api/speakers/aliases');
        if (response.ok) {
            speakerAliasesMap = await response.json();
            populateSpeakerTable();
        }
    } catch (err) {
        console.error('Error fetching speakers:', err);
    }
}

// Populate the speaker profiles dashboard table
function populateSpeakerTable() {
    speakerTableBody.innerHTML = '';

    const keys = Object.keys(speakerAliasesMap);
    if (keys.length === 0) {
        speakerTableBody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No registered speakers. Record one below!</td></tr>`;
        return;
    }

    keys.forEach(id => {
        const info = speakerAliasesMap[id];
        const row = document.createElement('tr');
        row.innerHTML = `
            <td style="font-family: var(--font-mono); font-weight: 600;">${escapeHtml(id)}</td>
            <td>${escapeHtml(info.name)}</td>
            <td>${info.aliases.map(a => `<span style="background: rgba(255,255,255,0.05); padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.8rem; margin-right: 0.3rem;">${escapeHtml(a)}</span>`).join('')}</td>
            <td class="table-actions">
                <button class="action-btn" title="Edit Aliases" onclick="openEditModal(${JSON.stringify(id)})">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                </button>
            </td>
        `;
        speakerTableBody.appendChild(row);
    });
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// ─── Visualizer ───────────────────────────────────────────────────────────────

// Visualizer: Draw inactive visual state
function drawVisualizerIdle() {
    if (isRecording) return;
    canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
    canvasCtx.lineWidth = 2;
    canvasCtx.strokeStyle = 'rgba(0, 242, 254, 0.15)';
    canvasCtx.beginPath();
    const sliceWidth = canvas.width / 100;
    let x = 0;
    for (let i = 0; i < 100; i++) {
        const y = canvas.height / 2 + Math.sin(i * 0.1) * 3;
        if (i === 0) {
            canvasCtx.moveTo(x, y);
        } else {
            canvasCtx.lineTo(x, y);
        }
        x += sliceWidth;
    }
    canvasCtx.stroke();
    animationFrameId = requestAnimationFrame(drawVisualizerIdle);
}

// Start visualizer from live microphone stream
function startVisualizer() {
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
    }
    analyserNode.fftSize = 256;
    const bufferLength = analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function draw() {
        if (!isRecording) return;
        animationFrameId = requestAnimationFrame(draw);

        analyserNode.getByteTimeDomainData(dataArray);

        canvasCtx.fillStyle = 'rgba(11, 12, 16, 0.2)'; // semi-transparent background to create trailing motion blur
        canvasCtx.fillRect(0, 0, canvas.width, canvas.height);

        canvasCtx.lineWidth = 3;
        canvasCtx.strokeStyle = 'rgba(0, 242, 254, 0.85)';
        canvasCtx.shadowBlur = 10;
        canvasCtx.shadowColor = 'var(--primary-color)';

        canvasCtx.beginPath();
        const sliceWidth = canvas.width * 1.0 / bufferLength;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
            const v = dataArray[i] / 128.0;
            const y = v * canvas.height / 2;

            if (i === 0) {
                canvasCtx.moveTo(x, y);
            } else {
                canvasCtx.lineTo(x, y);
            }
            x += sliceWidth;
        }

        canvasCtx.lineTo(canvas.width, canvas.height / 2);
        canvasCtx.stroke();

        // Reset shadow properties for next draw
        canvasCtx.shadowBlur = 0;
    }
    draw();
}

// ─── WAV Generation ───────────────────────────────────────────────────────────

function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

function bufferToWav(buffer) {
    const bufferLength = buffer.length;
    const wavBuffer = new ArrayBuffer(44 + bufferLength * 2);
    const view = new DataView(wavBuffer);

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + bufferLength * 2, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM Format
    view.setUint16(22, 1, true); // Mono Channel
    view.setUint32(24, 16000, true); // Sample Rate: 16kHz
    view.setUint32(28, 32000, true); // Byte Rate: 16000 * 2
    view.setUint16(32, 2, true); // Block Align
    view.setUint16(34, 16, true); // Bits per Sample: 16-bit
    writeString(view, 36, 'data');
    view.setUint32(40, bufferLength * 2, true);

    let offset = 44;
    for (let i = 0; i < bufferLength; i++, offset += 2) {
        let s = Math.max(-1, Math.min(1, buffer[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return new Blob([view], { type: 'audio/wav' });
}

// ─── Timer ────────────────────────────────────────────────────────────────────

function startTimer() {
    recordStartTime = Date.now();
    timeDisplay.style.display = 'block';
    timeDisplay.innerText = "00:00";
    timeIntervalId = setInterval(() => {
        const elapsed = Math.floor((Date.now() - recordStartTime) / 1000);
        const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const seconds = String(elapsed % 60).padStart(2, '0');
        timeDisplay.innerText = `${minutes}:${seconds}`;
    }, 1000);
}

function stopTimer() {
    if (timeIntervalId) {
        clearInterval(timeIntervalId);
        timeIntervalId = null;
    }
    timeDisplay.style.display = 'none';
}

// ─── Audio Recording ──────────────────────────────────────────────────────────

// Setup audio stream capturing
async function startAudioRecording() {
    try {
        audioBuffer = [];
        // Setup audio context with target sample rate of 16kHz
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });

        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

        sourceNode = audioCtx.createMediaStreamSource(micStream);
        analyserNode = audioCtx.createAnalyser();

        // Setup ScriptProcessorNode for recording audio chunks
        scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);
        scriptNode.onaudioprocess = (e) => {
            if (!isRecording) return;
            const channelData = e.inputBuffer.getChannelData(0);
            // Append a copy of the buffer data
            audioBuffer.push(...channelData);
        };

        // Wire routing
        sourceNode.connect(analyserNode);
        sourceNode.connect(scriptNode);
        scriptNode.connect(audioCtx.destination); // Required to trigger onaudioprocess in some browsers

        isRecording = true;
        startVisualizer();
        startTimer();
    } catch (err) {
        console.error('Error starting audio recording:', err);
        alert('Could not access microphone. Please check permissions.');
        resetRecordUI();
    }
}

// Stop audio stream and return WAV file blob
async function stopAudioRecording() {
    isRecording = false;
    stopTimer();

    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
    }

    if (scriptNode) {
        scriptNode.disconnect();
        scriptNode = null;
    }
    if (sourceNode) {
        sourceNode.disconnect();
        sourceNode = null;
    }
    if (micStream) {
        micStream.getTracks().forEach(track => track.stop());
        micStream = null;
    }
    if (audioCtx) {
        await audioCtx.close();
        audioCtx = null;
    }

    // Convert recorded buffer to 16kHz WAV Blob
    const wavBlob = bufferToWav(audioBuffer);
    audioBuffer = [];
    drawVisualizerIdle();
    return wavBlob;
}

// ─── Recording Trigger ────────────────────────────────────────────────────────

recordTrigger.addEventListener('click', async () => {
    if (!isRecording) {
        // Start recording
        recordTrigger.classList.add('recording');
        micIcon.style.display = 'none';
        stopIcon.style.display = 'block';

        recStatus.innerText = "Recording...";
        recStatus.className = "status-badge recording";

        resultBox.style.display = 'none';

        await startAudioRecording();
    } else {
        // Stop recording and process
        recordTrigger.classList.remove('recording');
        micIcon.style.display = 'block';
        stopIcon.style.display = 'none';

        recStatus.innerText = "Processing ASR & Speaker ID...";
        recStatus.className = "status-badge processing";

        recordTrigger.disabled = true;

        const audioBlob = await stopAudioRecording();
        await sendAudioViaWS(audioBlob);
        // Button re-enabled by displayLiveResult (WS path) or by sendAudioViaWS (REST fallback)
    }
});

function resetRecordUI() {
    isRecording = false;
    stopTimer();
    recordTrigger.classList.remove('recording');
    micIcon.style.display = 'block';
    stopIcon.style.display = 'none';
    recStatus.innerText = "Idle";
    recStatus.className = "status-badge idle";
    recordTrigger.disabled = false;
}

// ─── REST Fallback (kept for WS-unavailable situations) ──────────────────────

// Upload WAV to transcription API
async function uploadAndTranscribe(blob) {
    const formData = new FormData();
    formData.append('audio', blob, 'audio.wav');

    try {
        const response = await fetch('/api/transcribe', {
            method: 'POST',
            body: formData
        });

        if (response.ok) {
            const data = await response.json();
            displayResult(data);
            fetchSessions();
        } else {
            const errText = await response.text();
            alert('Error from transcription API: ' + errText);
            resetRecordUI();
        }
    } catch (err) {
        console.error('API Error:', err);
        alert('Network/API error occurred.');
        resetRecordUI();
    }
}

// ─── Result Display ───────────────────────────────────────────────────────────

// Render API transcription response into the classic result box
function displayResult(data) {
    recStatus.innerText = "Idle";
    recStatus.className = "status-badge idle";

    resMeta.innerText = `Session ID: ${data.session_id}`;
    resText.innerText = data.transcript || "(No speech detected)";

    // Resolve speaker ID using alias map
    const speakerId = data.speaker_id;
    if (speakerId && speakerId !== "Unknown" && speakerAliasesMap[speakerId]) {
        const info = speakerAliasesMap[speakerId];
        resSpeakerName.innerText = info.name;
        resSpeakerBadge.className = "speaker-badge";

        if (info.aliases && info.aliases.length > 0) {
            resAliases.style.display = 'block';
            resAliasesList.innerHTML = info.aliases.map(a => `<span>${escapeHtml(a)}</span>`).join('');
        } else {
            resAliases.style.display = 'none';
        }
    } else {
        resSpeakerName.innerText = speakerId === "Unknown" ? "Unknown Speaker" : (speakerId || "Unknown Speaker");
        resSpeakerBadge.className = "speaker-badge unknown";
        resAliases.style.display = 'none';
    }

    // Render speaker ID confidence
    if (data.confidence && data.confidence > 0) {
        resSpeakerConfidence.innerText = `${(data.confidence * 100).toFixed(1)}%`;
        resSpeakerConfidence.style.display = 'inline-block';
    } else {
        resSpeakerConfidence.style.display = 'none';
    }

    resultBox.style.display = 'block';
}

// ─── Speaker Enrollment ───────────────────────────────────────────────────────

let isEnrollRecording = false;
let enrollAudioBuffer = [];
let enrollAudioCtx = null;
let enrollMicStream = null;
let enrollSourceNode = null;
let enrollScriptNode = null;

enrollBtn.addEventListener('click', async () => {
    // Validate inputs
    const sId = speakerIdInput.value.trim();
    const sName = speakerNameInput.value.trim();
    const sAliases = speakerAliasesInput.value.trim();

    if (!sId || !sName) {
        alert('Please fill out Speaker ID and Display Name.');
        return;
    }

    if (!isEnrollRecording) {
        // Start profile recording
        isEnrollRecording = true;
        enrollBtn.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: pulse-glow 1s infinite;"><circle cx="12" cy="12" r="10"></circle><rect x="9" y="9" width="6" height="6"></rect></svg>
            Stop & Register (Speak for ~5s)
        `;
        enrollBtn.style.background = 'linear-gradient(135deg, var(--accent-color), #ff758c)';
        enrollMicStatus.innerText = "RECORDING PROFILE...";
        enrollMicStatus.style.color = "var(--accent-color)";

        // Disable other interactions
        recordTrigger.disabled = true;
        speakerIdInput.disabled = true;
        speakerNameInput.disabled = true;
        speakerAliasesInput.disabled = true;

        try {
            enrollAudioBuffer = [];
            enrollAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
            enrollMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });

            enrollSourceNode = enrollAudioCtx.createMediaStreamSource(enrollMicStream);
            enrollScriptNode = enrollAudioCtx.createScriptProcessor(4096, 1, 1);

            enrollScriptNode.onaudioprocess = (e) => {
                if (!isEnrollRecording) return;
                const channelData = e.inputBuffer.getChannelData(0);
                enrollAudioBuffer.push(...channelData);
            };

            enrollSourceNode.connect(enrollScriptNode);
            enrollScriptNode.connect(enrollAudioCtx.destination);
        } catch (err) {
            console.error('Error starting enrollment recording:', err);
            alert('Microphone access failed.');
            resetEnrollUI();
        }
    } else {
        // Stop and enroll
        enrollMicStatus.innerText = "PROCESSING PROFILE...";
        enrollMicStatus.style.color = "var(--primary-color)";
        enrollBtn.disabled = true;

        isEnrollRecording = false;

        if (enrollScriptNode) {
            enrollScriptNode.disconnect();
            enrollScriptNode = null;
        }
        if (enrollSourceNode) {
            enrollSourceNode.disconnect();
            enrollSourceNode = null;
        }
        if (enrollMicStream) {
            enrollMicStream.getTracks().forEach(track => track.stop());
            enrollMicStream = null;
        }
        if (enrollAudioCtx) {
            await enrollAudioCtx.close();
            enrollAudioCtx = null;
        }

        const audioBlob = bufferToWav(enrollAudioBuffer);
        enrollAudioBuffer = [];

        await registerSpeakerProfile(sId, sName, sAliases, audioBlob);
        resetEnrollUI();
        await fetchSpeakers(); // reload speaker list
    }
});

function resetEnrollUI() {
    isEnrollRecording = false;
    enrollBtn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-plus-circle"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="16"></line><line x1="8" y1="12" x2="16" y2="12"></line></svg>
        Record & Register Profile
    `;
    enrollBtn.style.background = '';
    enrollBtn.disabled = false;
    enrollMicStatus.innerText = "WAV format (16kHz mono)";
    enrollMicStatus.style.color = "";

    recordTrigger.disabled = false;
    speakerIdInput.disabled = false;
    speakerNameInput.disabled = false;
    speakerAliasesInput.disabled = false;

    speakerIdInput.value = '';
    speakerNameInput.value = '';
    speakerAliasesInput.value = '';
    if (enrollSampleCount) enrollSampleCount.textContent = '';
}

// Send profile request to API
async function registerSpeakerProfile(id, name, aliases, audioBlob) {
    const formData = new FormData();
    formData.append('audio', audioBlob, 'profile.wav');
    formData.append('id', id);
    formData.append('name', name);
    formData.append('aliases', aliases); // comma-separated string

    try {
        const response = await fetch('/api/speakers/enroll', {
            method: 'POST',
            body: formData
        });

        if (response.ok) {
            const data = await response.json();
            const count = data.sample_count || 0;
            if (enrollSampleCount) {
                enrollSampleCount.textContent = `Sample ${count} enrolled — record again to add more`;
            }
        } else {
            const errText = await response.text();
            alert('Failed to register speaker: ' + errText);
        }
    } catch (err) {
        console.error('Enroll API error:', err);
        alert('Network error enrolling speaker.');
    }
}

// ─── Settings ─────────────────────────────────────────────────────────────────

async function fetchSettings() {
    try {
        const res = await fetch('/api/settings');
        if (res.ok) {
            const s = await res.json();
            settingCuratedFolder.value = s.curated_audio_folder;
            settingMinSamples.value = s.min_enrollment_samples;
            settingMaxSamples.value = s.max_enrollment_samples;
            // Populate settings panel fields for API key and language defaults
            // API key: show placeholder if set, never populate with the masked value
            const settingsApiKey = document.getElementById('settings-nemotron-api-key');
            if (settingsApiKey) {
                settingsApiKey.value = '';
                settingsApiKey.placeholder = s.nemotron_api_key ? 'Key is set — enter new key to update' : 'nvapi-...';
            }
            const settingsSourceLang = document.getElementById('settings-source-lang');
            if (settingsSourceLang && s.source_language) settingsSourceLang.value = s.source_language;
            const settingsTargetLang = document.getElementById('settings-target-lang');
            if (settingsTargetLang && s.target_language) settingsTargetLang.value = s.target_language;
            // Populate recording-area language dropdowns from server settings
            if (s.source_language) {
                const sourceLang = document.getElementById('source-lang');
                if (sourceLang) sourceLang.value = s.source_language;
            }
            if (s.target_language) {
                const targetLang = document.getElementById('target-lang');
                if (targetLang) targetLang.value = s.target_language;
            }
        }
    } catch (err) {
        console.error('Error fetching settings:', err);
    }
}

saveSettingsBtn.addEventListener('click', async () => {
    const apiKeyInput = document.getElementById('settings-nemotron-api-key').value.trim();
    const patch = {
        curated_audio_folder: settingCuratedFolder.value.trim(),
        min_enrollment_samples: parseInt(settingMinSamples.value, 10),
        max_enrollment_samples: parseInt(settingMaxSamples.value, 10),
        source_language: document.getElementById('settings-source-lang').value,
        target_language: document.getElementById('settings-target-lang').value,
    };
    // Only send API key if the user entered a new one (never send empty to avoid clearing stored key)
    if (apiKeyInput) patch.nemotron_api_key = apiKeyInput;
    if (isNaN(patch.min_enrollment_samples) || isNaN(patch.max_enrollment_samples)
        || patch.min_enrollment_samples < 1 || patch.max_enrollment_samples < 1
        || patch.min_enrollment_samples >= patch.max_enrollment_samples) {
        settingsStatus.textContent = 'Min must be ≥ 1 and less than Max.';
        settingsStatus.style.color = 'var(--accent-color)';
        setTimeout(() => { settingsStatus.textContent = ''; }, 3000);
        return;
    }
    try {
        const res = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch)
        });
        if (res.ok) {
            settingsStatus.innerText = 'Settings saved.';
            settingsStatus.style.color = 'var(--success-color)';
            // Sync recording-area language dropdowns to match saved settings values
            const srcLangEl = document.getElementById('source-lang');
            const tgtLangEl = document.getElementById('target-lang');
            if (srcLangEl) srcLangEl.value = patch.source_language;
            if (tgtLangEl) tgtLangEl.value = patch.target_language;
        } else {
            settingsStatus.innerText = 'Failed to save settings.';
            settingsStatus.style.color = 'var(--accent-color)';
        }
    } catch (err) {
        settingsStatus.innerText = 'Network error.';
        settingsStatus.style.color = 'var(--accent-color)';
    }
    setTimeout(() => { settingsStatus.innerText = ''; }, 3000);
});

// ─── Recordings ───────────────────────────────────────────────────────────────

refreshSessionsBtn.addEventListener('click', fetchSessions);

// Sessions / Recordings functions
async function fetchSessions() {
    try {
        const res = await fetch('/api/sessions');
        if (res.ok) {
            const sessions = await res.json();
            populateRecordingsTable(sessions);
        }
    } catch (err) {
        console.error('Error fetching sessions:', err);
    }
}

function populateRecordingsTable(sessions) {
    recordingsTableBody.innerHTML = '';
    if (!sessions || !Array.isArray(sessions) || sessions.length === 0) {
        recordingsTableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">No recordings yet.</td></tr>`;
        return;
    }
    sessions.forEach(s => {
        const row = document.createElement('tr');
        row.id = `session-row-${s.session_id}`;
        const ts = s.timestamp ? s.timestamp.replace('T', ' ') : '-';
        const conf = s.confidence > 0 ? `${(s.confidence * 100).toFixed(1)}%` : '-';
        const speakerDisplay = s.speaker_id && s.speaker_id !== 'Unknown'
            ? `<span style="color:var(--primary-color); font-family:var(--font-mono); font-size:0.85rem;">${escapeHtml(s.speaker_id)}</span>`
            : `<span style="color:var(--text-muted);">Unknown</span>`;

        const confirmBtn = s.speaker_id && s.speaker_id !== 'Unknown'
            ? s.confirmed
                ? `<button class="action-btn confirmed" title="Already confirmed" disabled>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                  </button>`
                : `<button class="action-btn confirm" title="Confirm speaker &amp; add to training" onclick="confirmSession(${JSON.stringify(s.session_id)})">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                  </button>`
            : '';

        row.innerHTML = `
            <td style="font-family:var(--font-mono); font-size:0.8rem; white-space:nowrap;">${escapeHtml(ts)}</td>
            <td>${speakerDisplay}</td>
            <td class="transcript-cell" title="${escapeHtml(s.transcript)}">${escapeHtml(s.transcript) || '<em style="color:var(--text-muted);">—</em>'}</td>
            <td style="font-family:var(--font-mono); font-size:0.85rem;">${conf}</td>
            <td class="table-actions">
                <button class="action-btn" title="Play" onclick="playSession(${JSON.stringify(s.audio_url)})">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                </button>
                ${confirmBtn}
            </td>
        `;
        recordingsTableBody.appendChild(row);
    });
}

function playSession(audioUrl) {
    if (!audioUrl) return;
    sessionAudio.src = audioUrl;
    sessionAudio.style.display = 'block';
    sessionAudio.play();
}

window.confirmSession = async function(sessionId) {
    try {
        const response = await fetch(`/api/sessions/${sessionId}/confirm`, { method: 'POST' });
        if (response.ok) {
            const data = await response.json();
            const row = document.getElementById(`session-row-${sessionId}`);
            if (row) {
                const confirmBtn = row.querySelector('.action-btn.confirm');
                if (confirmBtn) {
                    confirmBtn.className = 'action-btn confirmed';
                    confirmBtn.disabled = true;
                    confirmBtn.title = `Confirmed — sample count: ${data.sample_count}`;
                }
            }
        } else {
            const errText = await response.text();
            alert('Failed to confirm session: ' + errText);
        }
    } catch (err) {
        console.error('Confirm session error:', err);
        alert('Network error confirming session.');
    }
};

// ─── Modal ────────────────────────────────────────────────────────────────────

window.openEditModal = function(id) {
    editingSpeakerId = id;
    const info = speakerAliasesMap[id];

    modalDisplayName.value = info.name;
    modalAliases.value = info.aliases.join(', ');

    editModal.style.display = 'flex';
};

function closeModal() {
    editModal.style.display = 'none';
    editingSpeakerId = null;
}

modalCloseBtn.addEventListener('click', closeModal);
modalCancelBtn.addEventListener('click', closeModal);

modalSaveBtn.addEventListener('click', async () => {
    if (!editingSpeakerId) return;

    const display_name = modalDisplayName.value.trim();
    const aliases = modalAliases.value.split(',').map(s => s.trim()).filter(s => s.length > 0);

    if (!display_name) {
        alert('Display Name is required.');
        return;
    }

    try {
        const response = await fetch('/api/speakers/aliases', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                id: editingSpeakerId,
                name: display_name,
                aliases: aliases
            })
        });

        if (response.ok) {
            closeModal();
            await fetchSpeakers();
        } else {
            const errText = await response.text();
            alert('Failed to update speaker: ' + errText);
        }
    } catch (err) {
        console.error('Update API Error:', err);
        alert('Network error updating aliases.');
    }
});
