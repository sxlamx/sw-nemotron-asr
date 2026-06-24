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

// Cache of speakers and aliases
let speakerAliasesMap = {};

// Resize canvas
function resizeCanvas() {
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = 100;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Initial page load: retrieve speaker database
document.addEventListener('DOMContentLoaded', () => {
    fetchSpeakers();
    drawVisualizerIdle();
});

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
            <td style="font-family: var(--font-mono); font-weight: 600;">${id}</td>
            <td>${escapeHtml(info.name)}</td>
            <td>${info.aliases.map(a => `<span style="background: rgba(255,255,255,0.05); padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.8rem; margin-right: 0.3rem;">${escapeHtml(a)}</span>`).join('')}</td>
            <td class="table-actions">
                <button class="action-btn" title="Edit Aliases" onclick="openEditModal('${id}')">
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

// WAV generation and header writing
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

// Timer functionality
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

// Recording/Transcribing UI workflow
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
        await uploadAndTranscribe(audioBlob);
        
        recordTrigger.disabled = false;
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

// Render API transcription response
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

    resultBox.style.display = 'block';
}

// Enrollment process
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
            alert(`Speaker profile '${name}' registered successfully!`);
        } else {
            const errText = await response.text();
            alert('Failed to register speaker: ' + errText);
        }
    } catch (err) {
        console.error('Enroll API error:', err);
        alert('Network error enrolling speaker.');
    }
}

// Modal handling
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
