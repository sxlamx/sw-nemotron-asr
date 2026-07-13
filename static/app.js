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

// ─── Auth ─────────────────────────────────────────────────────────────────────

let currentUser = null;

async function checkAuth() {
    try {
        const res = await fetch('/api/me');
        if (res.status === 401) {
            location.href = '/login.html';
            return false;
        }
        if (res.ok) {
            currentUser = await res.json();
            const userEl = document.getElementById('header-user');
            const logoutBtn = document.getElementById('logout-btn');
            if (currentUser.auth_enabled && userEl) {
                userEl.textContent = `${currentUser.username} · ${currentUser.role}`;
                if (logoutBtn) {
                    logoutBtn.style.display = '';
                    logoutBtn.addEventListener('click', async () => {
                        await fetch('/api/logout', { method: 'POST' }).catch(() => {});
                        location.href = '/login.html';
                    });
                }
            }
            // Server enforces roles; grey out admin-only controls for clarity
            if (currentUser.role !== 'admin') {
                const saveBtn = document.getElementById('save-settings-btn');
                if (saveBtn) { saveBtn.disabled = true; saveBtn.title = 'Admin role required'; }
            } else {
                const usersCard = document.getElementById('users-card');
                if (usersCard) { usersCard.style.display = ''; fetchUsers(); }
            }
        }
    } catch (err) { /* offline — let the page load */ }
    return true;
}

// PWA: service worker for installability + shell resilience (needs HTTPS/localhost)
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch((err) => {
            console.warn('[PWA] Service worker registration failed:', err);
        });
    });
}

// Initial page load
document.addEventListener('DOMContentLoaded', async () => {
    if (!(await checkAuth())) return;
    fetchSpeakers();
    fetchSettings();
    fetchSessions();
    drawVisualizerIdle();
    connectWebSocket();
    initLangSelectors();

    // Provider toggle buttons
    document.querySelectorAll('.provider-btn').forEach(btn => {
        btn.addEventListener('click', () => setProvider(btn.dataset.provider));
    });

    // Refresh Ollama models button — saves host first, then fetches
    const refreshOllamaBtn = document.getElementById('refresh-ollama-models-btn');
    if (refreshOllamaBtn) {
        refreshOllamaBtn.addEventListener('click', async () => {
            const hostEl = document.getElementById('settings-ollama-host');
            if (hostEl && hostEl.value.trim()) {
                await fetch('/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ollama_host: hostEl.value.trim() }),
                }).catch(() => {});
            }
            fetchOllamaModels();
        });
    }
});

window.addEventListener('beforeunload', () => {
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    if (ws) ws.close();
});

// ─── Transcript History ───────────────────────────────────────────────────────

const MAX_HISTORY = 100;
let transcriptHistory = [];
let historyStartTime = null;

function addToHistory(data) {
    if (!historyStartTime) historyStartTime = Date.now();
    const elapsed = Math.floor((Date.now() - historyStartTime) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    const displayText = data.translation || data.transcript || '';
    const isTranslated = !!data.translation;
    if (!displayText) return;

    transcriptHistory.push({ time: `${mm}:${ss}`, text: displayText, isTranslated, speaker: data.speaker_id });
    if (transcriptHistory.length > MAX_HISTORY) transcriptHistory.shift();

    const wrap = document.getElementById('transcript-history-wrap');
    const list = document.getElementById('transcript-history-list');
    wrap.classList.remove('hidden');

    const entry = document.createElement('div');
    entry.className = 'history-entry';
    entry.innerHTML = `<span class="history-time">${mm}:${ss}</span>` +
        (data.speaker_id && data.speaker_id !== 'Unknown'
            ? `<span class="history-speaker">${escapeHtml(data.speaker_id)}</span>` : '') +
        `<span class="history-text${isTranslated ? ' translated' : ''}">${escapeHtml(displayText)}</span>`;
    list.appendChild(entry);

    // Keep only last 100 DOM nodes
    while (list.children.length > MAX_HISTORY) list.removeChild(list.firstChild);
    list.scrollTop = list.scrollHeight;
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('clear-history-btn').addEventListener('click', () => {
        transcriptHistory = [];
        historyStartTime = null;
        document.getElementById('transcript-history-list').innerHTML = '';
        document.getElementById('transcript-history-wrap').classList.add('hidden');
    });
});

// ─── Conversation Mode ───────────────────────────────────────────────────────

const LANG_LABELS = {
    en: 'English', zh: 'Mandarin', ms: 'Melayu', ta: 'Tamil', ko: 'Korean',
    id: 'Indonesia', yue: 'Cantonese', my: 'Burmese',
};

let conversationMode = true;
let patientLang = 'ms';
let convoDirection = 'auto'; // 'auto' | 'to_patient' | 'to_clinician'
let ttsEnabled = true;
let privacyMode = true;

function sendWSConfig() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
        type: 'config',
        conversation: conversationMode,
        patient_lang: patientLang,
        direction: convoDirection,
    }));
}

function updateDirectionPillLabels() {
    const code = (patientLang || 'ms').toUpperCase();
    document.querySelectorAll('.dir-patient-code').forEach(el => { el.textContent = code; });
}

function applyConversationModeUI() {
    const convoRow = document.getElementById('convo-lang-row');
    const classicSelectors = document.getElementById('classic-lang-selectors');
    if (convoRow) convoRow.style.display = conversationMode ? 'flex' : 'none';
    if (classicSelectors) classicSelectors.style.display = conversationMode ? 'none' : 'flex';
}

function updateTTSVoiceNote() {
    const note = document.getElementById('tts-voice-note');
    if (!note) return;
    if (!ttsEnabled || !window.TTS) { note.classList.add('hidden'); return; }
    // Voice list can load asynchronously — check again shortly after changes
    setTimeout(() => {
        if (!TTS.hasVoiceFor(patientLang)) {
            note.textContent = `⚠ No ${LANG_LABELS[patientLang] || patientLang} voice installed on this device — translations will show as text only.`;
            note.classList.remove('hidden');
        } else {
            note.classList.add('hidden');
        }
    }, 500);
}

function renderConversationBubble(data) {
    const wrap = document.getElementById('convo-log-wrap');
    const log = document.getElementById('convo-log');
    if (!wrap || !log) return;
    wrap.classList.remove('hidden');

    const dir = data.direction === 'to_patient' ? 'to-patient' : 'to-clinician';
    const who = data.direction === 'to_patient' ? '🩺 Clinician' : '🧑 Patient';
    const srcLabel = LANG_LABELS[data.detected_lang] || data.detected_lang;
    const tgtLabel = LANG_LABELS[data.target_lang] || data.target_lang;

    const bubble = document.createElement('div');
    bubble.className = `convo-bubble ${dir}`;
    const hasTranslation = !!data.translation;
    bubble.innerHTML = `
        <div class="convo-bubble-meta">
            <span>${who}</span>
            <span>${escapeHtml(srcLabel)} → ${escapeHtml(tgtLabel)}</span>
            ${hasTranslation ? '<button type="button" class="convo-replay" title="Replay audio">🔊</button>' : ''}
            ${hasTranslation ? '<button type="button" class="convo-flag" title="Refine this translation">✎</button>' : ''}
        </div>
        <div class="convo-bubble-original">${escapeHtml(data.transcript || '(no speech detected)')}</div>
        ${hasTranslation ? `<div class="convo-bubble-translation">${escapeHtml(data.translation)}</div>` : ''}
        ${data.simpler_english ? `<div class="simpler-chip">💡 Simpler: ${escapeHtml(data.simpler_english)}</div>` : ''}
    `;
    if (hasTranslation) {
        bubble.querySelector('.convo-replay').addEventListener('click', () => {
            if (window.TTS) TTS.speak(data.translation, data.target_lang);
        });
        bubble.querySelector('.convo-flag').addEventListener('click', () => {
            openCorrectionModal(data);
        });
    }
    log.appendChild(bubble);
    while (log.children.length > 100) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
}

// ─── Correction Feedback (continuous learning) ──────────────────────────────

let correctionContext = null;

function openCorrectionModal(data) {
    correctionContext = data;
    document.getElementById('correction-source').textContent = data.transcript || '';
    document.getElementById('correction-current').textContent = data.translation || '';
    document.getElementById('correction-text').value = data.translation || '';
    document.getElementById('correction-note').value = '';
    document.getElementById('correction-modal').style.display = 'flex';
}

function closeCorrectionModal() {
    document.getElementById('correction-modal').style.display = 'none';
    correctionContext = null;
}

async function saveCorrection() {
    if (!correctionContext) return;
    const corrected = document.getElementById('correction-text').value.trim();
    if (!corrected) { alert('Corrected translation is required.'); return; }
    try {
        const res = await fetch('/api/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                src_lang: correctionContext.detected_lang,
                tgt_lang: correctionContext.target_lang,
                source_text: correctionContext.transcript,
                wrong_translation: correctionContext.translation,
                corrected_translation: corrected,
                note: document.getElementById('correction-note').value.trim(),
            }),
        });
        if (res.ok) {
            closeCorrectionModal();
        } else {
            alert('Failed to save correction: ' + await res.text());
        }
    } catch (err) {
        alert('Network error saving correction.');
    }
}

// ─── Glossary Management ─────────────────────────────────────────────────────

async function fetchGlossary() {
    const tbody = document.getElementById('glossary-table-body');
    if (!tbody) return;
    try {
        const res = await fetch('/api/glossary');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        renderGlossaryTable(await res.json());
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">Could not load glossary.</td></tr>`;
    }
}

function renderGlossaryTable(entries) {
    const tbody = document.getElementById('glossary-table-body');
    tbody.innerHTML = '';
    if (!entries || entries.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">No glossary terms yet — add the first one above.</td></tr>`;
        return;
    }
    entries.sort((a, b) => (a.term_en || '').localeCompare(b.term_en || ''));
    entries.forEach(e => {
        const translations = Object.entries(e.translations || {})
            .filter(([, v]) => v)
            .map(([k, v]) => `<span style="margin-right:0.6rem;"><span style="color:var(--primary-color); font-family:var(--font-mono); font-size:0.75rem;">${escapeHtml(k)}</span> ${escapeHtml(v)}</span>`)
            .join('');
        const row = document.createElement('tr');
        row.innerHTML = `
            <td style="font-weight:600;">${escapeHtml(e.term_en)}</td>
            <td>${translations || '<em style="color:var(--text-muted);">—</em>'}</td>
            <td style="color:var(--text-muted);">${escapeHtml(e.simpler_en || '')}</td>
            <td style="font-family:var(--font-mono); font-size:0.78rem; color:var(--text-muted);">${escapeHtml(e.source || 'manual')}</td>
            <td class="table-actions">
                <button type="button" class="action-btn" title="Delete term">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
            </td>
        `;
        row.querySelector('.action-btn').addEventListener('click', async () => {
            if (!confirm(`Delete glossary term "${e.term_en}"?`)) return;
            const res = await fetch(`/api/glossary/${encodeURIComponent(e.id)}`, { method: 'DELETE' });
            if (res.ok) fetchGlossary();
        });
        tbody.appendChild(row);
    });
}

async function addGlossaryTerm() {
    const termEn = document.getElementById('glossary-term-en').value.trim();
    const lang = document.getElementById('glossary-lang').value;
    const translation = document.getElementById('glossary-translation').value.trim();
    const simpler = document.getElementById('glossary-simpler').value.trim();
    const status = document.getElementById('glossary-status');
    if (!termEn || !translation) {
        status.textContent = 'English term and translation are required.';
        setTimeout(() => { status.textContent = ''; }, 3000);
        return;
    }
    // Merge with any existing entry so adding a second language keeps the first
    let translations = {};
    let existingSimpler = '';
    try {
        const res = await fetch('/api/glossary');
        if (res.ok) {
            const existing = (await res.json()).find(
                g => (g.term_en || '').toLowerCase() === termEn.toLowerCase());
            if (existing) {
                translations = existing.translations || {};
                existingSimpler = existing.simpler_en || '';
            }
        }
    } catch (err) { /* proceed with fresh entry */ }
    translations[lang] = translation;
    try {
        const res = await fetch('/api/glossary', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                term_en: termEn,
                translations,
                simpler_en: simpler || existingSimpler,
            }),
        });
        if (res.ok) {
            status.textContent = `Saved "${termEn}".`;
            document.getElementById('glossary-term-en').value = '';
            document.getElementById('glossary-translation').value = '';
            document.getElementById('glossary-simpler').value = '';
            fetchGlossary();
        } else {
            status.textContent = 'Failed: ' + await res.text();
        }
    } catch (err) {
        status.textContent = 'Network error.';
    }
    setTimeout(() => { status.textContent = ''; }, 3000);
}

// ─── User Management (admin only) ────────────────────────────────────────────

async function fetchUsers() {
    const tbody = document.getElementById('users-table-body');
    if (!tbody) return;
    try {
        const res = await fetch('/api/users');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const users = await res.json();
        tbody.innerHTML = '';
        users.forEach(u => {
            const isSelf = currentUser && u.username === currentUser.username;
            const row = document.createElement('tr');
            row.innerHTML = `
                <td style="font-family:var(--font-mono);">${escapeHtml(u.username)}${isSelf ? ' <span style="color:var(--text-muted); font-size:0.75rem;">(you)</span>' : ''}</td>
                <td>${escapeHtml(u.role)}</td>
                <td class="table-actions">
                    <button type="button" class="action-btn" title="Delete account">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    </button>
                </td>
            `;
            row.querySelector('.action-btn').addEventListener('click', async () => {
                if (!confirm(`Delete account "${u.username}"?`)) return;
                const res2 = await fetch(`/api/users/${encodeURIComponent(u.username)}`, { method: 'DELETE' });
                if (res2.ok) {
                    if (isSelf) { location.href = '/login.html'; return; }
                    fetchUsers();
                } else {
                    alert('Failed: ' + await res2.text());
                }
            });
            tbody.appendChild(row);
        });
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:var(--text-muted);">Could not load accounts.</td></tr>`;
    }
}

async function addUser() {
    const status = document.getElementById('users-status');
    const username = document.getElementById('user-new-name').value.trim();
    const password = document.getElementById('user-new-password').value;
    const role = document.getElementById('user-new-role').value;
    if (!username || password.length < 8) {
        status.textContent = 'Username and a password of at least 8 characters are required.';
        setTimeout(() => { status.textContent = ''; }, 3000);
        return;
    }
    try {
        const res = await fetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, role }),
        });
        if (res.ok) {
            status.textContent = `Saved account "${username}".`;
            document.getElementById('user-new-name').value = '';
            document.getElementById('user-new-password').value = '';
            fetchUsers();
        } else {
            status.textContent = 'Failed: ' + await res.text();
        }
    } catch (err) {
        status.textContent = 'Network error.';
    }
    setTimeout(() => { status.textContent = ''; }, 3000);
}

document.addEventListener('DOMContentLoaded', () => {
    const userAddBtn = document.getElementById('user-add-btn');
    if (userAddBtn) userAddBtn.addEventListener('click', addUser);
});

document.addEventListener('DOMContentLoaded', () => {
    fetchGlossary();
    const addBtn = document.getElementById('glossary-add-btn');
    if (addBtn) addBtn.addEventListener('click', addGlossaryTerm);
    const cClose = document.getElementById('correction-close-btn');
    const cCancel = document.getElementById('correction-cancel-btn');
    const cSave = document.getElementById('correction-save-btn');
    if (cClose) cClose.addEventListener('click', closeCorrectionModal);
    if (cCancel) cCancel.addEventListener('click', closeCorrectionModal);
    if (cSave) cSave.addEventListener('click', saveCorrection);
});

document.addEventListener('DOMContentLoaded', () => {
    if (window.TTS) TTS.init();

    const convoToggle = document.getElementById('convo-mode-toggle');
    if (convoToggle) {
        convoToggle.addEventListener('change', () => {
            conversationMode = convoToggle.checked;
            applyConversationModeUI();
            sendWSConfig();
            fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ conversation_mode: conversationMode }),
            }).catch(() => {});
        });
    }

    const ttsToggle = document.getElementById('tts-toggle');
    if (ttsToggle) {
        ttsToggle.addEventListener('change', () => {
            ttsEnabled = ttsToggle.checked;
            if (window.TTS) { TTS.enabled = ttsEnabled; if (!ttsEnabled) TTS.stop(); }
            updateTTSVoiceNote();
            fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tts_enabled: ttsEnabled }),
            }).catch(() => {});
        });
    }

    const patientSel = document.getElementById('patient-lang');
    if (patientSel) {
        patientSel.addEventListener('change', () => {
            patientLang = patientSel.value;
            updateDirectionPillLabels();
            updateTTSVoiceNote();
            sendWSConfig();
            fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ patient_language: patientLang }),
            }).catch(() => {});
        });
    }

    document.querySelectorAll('.dir-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            convoDirection = btn.dataset.dir;
            document.querySelectorAll('.dir-btn').forEach(b =>
                b.classList.toggle('active', b === btn));
            sendWSConfig();
        });
    });

    const clearConvoBtn = document.getElementById('clear-convo-btn');
    if (clearConvoBtn) {
        clearConvoBtn.addEventListener('click', () => {
            document.getElementById('convo-log').innerHTML = '';
            document.getElementById('convo-log-wrap').classList.add('hidden');
        });
    }

    updateDirectionPillLabels();
    applyConversationModeUI();
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
            sendWSConfig();
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'config_ack') {
                    console.log('[WS] Config acknowledged:', data);
                    return;
                }
                wsPendingResponse = false;
                displayLiveResult(data);
            } catch (err) {
                wsPendingResponse = false;
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

// Last captured transcript for retranslate
let lastCapture = { text: '', detected_lang: '', translation: '' };

// Update live transcript panel when WS response arrives
function displayLiveResult(data) {
    // Status badge
    if (isRecording) {
        recStatus.innerText = 'Listening...';
        recStatus.className = 'status-badge idle';
    } else {
        recordTrigger.disabled = false;
        recStatus.innerText = 'Idle';
        recStatus.className = 'status-badge idle';
    }

    // Conversation mode: chat bubble + spoken translation, no classic panels
    if (data.direction === 'to_patient' || data.direction === 'to_clinician') {
        if (data.transcript) {
            renderConversationBubble(data);
            addToHistory(data);
            if (data.tts && ttsEnabled && window.TTS && data.translation) {
                TTS.speak(data.translation, data.target_lang);
            }
        }
        lastCapture = {
            text: data.transcript || '',
            detected_lang: data.detected_lang || 'auto',
            translation: data.translation || '',
        };
        if (!privacyMode) fetchSessions();
        return;
    }

    const panel = document.getElementById('live-transcript-panel');
    panel.classList.remove('hidden');
    document.getElementById('live-processing-indicator').classList.add('hidden');

    // Source lang badge
    const srcLang = data.detected_lang || 'auto';
    document.getElementById('live-lang-label').textContent = srcLang;

    // Sync live target select to current target-lang dropdown
    const tgtLang = document.getElementById('target-lang').value;
    document.getElementById('live-target-select').value = tgtLang;

    // Original transcript
    document.getElementById('live-original-text').textContent = data.transcript || '(No speech detected)';

    // Translation — show even if empty (placeholder)
    const transEl = document.getElementById('live-translation-text');
    const tSection = document.getElementById('live-translation-section');
    if (data.translation) {
        transEl.textContent = data.translation;
        tSection.style.opacity = '1';
    } else {
        transEl.textContent = '(No API key set — go to Settings to add NVIDIA key)';
        transEl.style.color = 'var(--text-muted)';
        tSection.style.opacity = '0.6';
    }

    // Speaker info
    const confStr = data.confidence > 0 ? ` · ${(data.confidence * 100).toFixed(0)}%` : '';
    document.getElementById('live-speaker-info').textContent =
        `👤 ${data.speaker_id || 'Unknown'}${confStr}`;

    // Store for retranslate
    lastCapture = { text: data.transcript || '', detected_lang: srcLang, translation: data.translation || '' };
    document.getElementById('retranslate-btn').disabled = !lastCapture.text;

    // Append to transcript history log
    addToHistory(data);

    // Also update the classic result box and refresh recordings list
    displayResult(data);
    fetchSessions();
}

// ─── Retranslate ─────────────────────────────────────────────────────────────

async function retranslate() {
    if (!lastCapture.text) return;
    const targetLang = document.getElementById('live-target-select').value;
    const btn = document.getElementById('retranslate-btn');
    btn.disabled = true;
    btn.textContent = '⟳ Translating...';

    // Sync target lang everywhere
    document.getElementById('target-lang').value = targetLang;
    const stl = document.getElementById('settings-target-lang');
    if (stl) stl.value = targetLang;
    await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_language: targetLang }),
    }).catch(() => {});

    const transEl = document.getElementById('live-translation-text');
    transEl.textContent = '⟳ Translating...';
    transEl.style.color = 'var(--text-muted)';

    try {
        const res = await fetch('/api/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: lastCapture.text,
                source_lang: lastCapture.detected_lang,
                target_lang: targetLang,
            }),
        });
        if (res.ok) {
            const { translation } = await res.json();
            transEl.textContent = translation || '(empty)';
            transEl.style.color = '';
            lastCapture.translation = translation;
            // Add to history
            addToHistory({ ...lastCapture, translation, speaker_id: '', confidence: 0 });
        } else {
            const msg = await res.text();
            transEl.textContent = `Error: ${msg}`;
        }
    } catch (err) {
        transEl.textContent = `Network error: ${err.message}`;
    }
    btn.disabled = false;
    btn.textContent = '↻ Retranslate';
}

document.addEventListener('DOMContentLoaded', () => {
    const retBtn = document.getElementById('retranslate-btn');
    if (retBtn) {
        retBtn.disabled = true;
        retBtn.addEventListener('click', retranslate);
    }
    // Changing live target select auto-retranslates
    const liveTarget = document.getElementById('live-target-select');
    if (liveTarget) {
        liveTarget.addEventListener('change', retranslate);
    }
});

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

// ─── Real-time VAD State ─────────────────────────────────────────────────────

const VAD_THRESHOLD      = 0.008;   // RMS energy above this = speech
const SILENCE_GAP_MS     = 800;     // silence after speech to trigger segment send
const MIN_UTTERANCE_MS   = 300;     // ignore bursts shorter than this
const MAX_UTTERANCE_MS   = 15000;   // force-send if utterance exceeds this

let vadState      = 'silence';  // 'silence' | 'speech'
let utteranceBuf  = [];         // Float32 samples for current utterance
let speechStart   = null;       // Date.now() when speech began
let silenceStart  = null;       // Date.now() when silence began after speech

function vadReset() {
    vadState = 'silence';
    utteranceBuf = [];
    speechStart = null;
    silenceStart = null;
}

// Actual capture rate of the running AudioContext. iOS ignores a requested
// 16 kHz, so we capture at the native rate and resample when sending.
let captureSampleRate = 16000;

function resampleTo16k(samples, fromRate) {
    if (fromRate === 16000) return samples;
    const ratio = fromRate / 16000;
    const outLen = Math.floor(samples.length / ratio);
    const out = new Array(outLen);
    for (let i = 0; i < outLen; i++) {
        const pos = i * ratio;
        const i0 = Math.floor(pos);
        const i1 = Math.min(i0 + 1, samples.length - 1);
        const frac = pos - i0;
        out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
    }
    return out;
}

// Send a Float32 samples array as a 16 kHz WAV binary WS frame
async function sendUtteranceSamples(samples) {
    if (!samples.length) return;
    const blob = bufferToWav(resampleTo16k(samples, captureSampleRate));
    const arrayBuffer = await blob.arrayBuffer();
    if (ws && ws.readyState === WebSocket.OPEN) {
        wsPendingResponse = true;
        ws.send(arrayBuffer);
        recStatus.innerText = 'Processing...';
        recStatus.className = 'status-badge processing';
    }
}

// ─── Audio Recording ──────────────────────────────────────────────────────────

// Shared VAD/segmentation for both capture paths (AudioWorklet + fallback)
function handleCaptureSamples(samples) {
    if (!isRecording) return;
    // Gate the mic while TTS is playing (+tail) so the device speaker
    // doesn't re-trigger transcription of its own translated speech
    if (window.TTS && TTS.isPlaying()) return;

    // Energy VAD
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);
    const isSpeech = rms > VAD_THRESHOLD;

    if (isSpeech) {
        if (vadState === 'silence') {
            speechStart = Date.now();
            vadState = 'speech';
            recStatus.innerText = 'Speaking...';
            recStatus.className = 'status-badge recording';
        }
        for (let i = 0; i < samples.length; i++) utteranceBuf.push(samples[i]);
        silenceStart = null;
    } else {
        if (vadState === 'speech') {
            for (let i = 0; i < samples.length; i++) utteranceBuf.push(samples[i]); // trailing silence
            if (!silenceStart) silenceStart = Date.now();

            const silence = Date.now() - silenceStart;
            const utteranceDur = Date.now() - speechStart;

            if (silence >= SILENCE_GAP_MS && utteranceDur >= MIN_UTTERANCE_MS) {
                sendUtteranceSamples(utteranceBuf.slice());
                vadReset();
                recStatus.innerText = 'Listening...';
                recStatus.className = 'status-badge idle';
            }
        }
    }

    // Force-send if utterance runs too long (avoids memory growth)
    if (utteranceBuf.length >= MAX_UTTERANCE_MS / 1000 * captureSampleRate) {
        sendUtteranceSamples(utteranceBuf.slice());
        vadReset();
    }
}

let workletNode = null;
let wakeLock = null;

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
        }
    } catch (err) { /* not critical — e.g. low battery mode */ }
}

async function startAudioRecording() {
    try {
        vadReset();
        // Native sample rate: iOS ignores a requested 16 kHz; we resample on send
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        captureSampleRate = audioCtx.sampleRate;
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

        sourceNode  = audioCtx.createMediaStreamSource(micStream);
        analyserNode = audioCtx.createAnalyser();
        sourceNode.connect(analyserNode);

        // Preferred path: AudioWorklet (ScriptProcessorNode is deprecated)
        let usingWorklet = false;
        if (audioCtx.audioWorklet) {
            try {
                await audioCtx.audioWorklet.addModule('/worklet/pcm-capture.js');
                workletNode = new AudioWorkletNode(audioCtx, 'pcm-capture');
                workletNode.port.onmessage = (e) => handleCaptureSamples(e.data);
                sourceNode.connect(workletNode);
                usingWorklet = true;
                console.log('[Audio] AudioWorklet capture at', captureSampleRate, 'Hz');
            } catch (err) {
                console.warn('[Audio] AudioWorklet unavailable, falling back:', err);
            }
        }
        if (!usingWorklet) {
            scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);
            scriptNode.onaudioprocess = (e) => handleCaptureSamples(e.inputBuffer.getChannelData(0));
            sourceNode.connect(scriptNode);
            scriptNode.connect(audioCtx.destination);
            console.log('[Audio] ScriptProcessor capture at', captureSampleRate, 'Hz');
        }

        requestWakeLock();
        isRecording = true;
        startVisualizer();
        startTimer();
        recStatus.innerText = 'Listening...';
        recStatus.className = 'status-badge idle';
    } catch (err) {
        console.error('Error starting audio recording:', err);
        alert('Could not access microphone. Please check permissions.');
        resetRecordUI();
    }
}

async function stopAudioRecording() {
    isRecording = false;
    stopTimer();

    // Flush any accumulated utterance before closing mic
    if (utteranceBuf.length > 0 && vadState === 'speech') {
        await sendUtteranceSamples(utteranceBuf.slice());
    }
    vadReset();

    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    if (workletNode) { workletNode.port.onmessage = null; workletNode.disconnect(); workletNode = null; }
    if (scriptNode)  { scriptNode.disconnect();  scriptNode = null; }
    if (sourceNode)  { sourceNode.disconnect();  sourceNode = null; }
    if (micStream)   { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (audioCtx)    { await audioCtx.close();   audioCtx = null; }
    if (wakeLock)    { wakeLock.release().catch(() => {}); wakeLock = null; }

    drawVisualizerIdle();
}

// ─── Recording Trigger ────────────────────────────────────────────────────────

recordTrigger.addEventListener('click', async () => {
    // Unlock speech synthesis inside the user gesture (iOS/Android autoplay)
    if (window.TTS) TTS.unlock();
    if (!isRecording) {
        recordTrigger.classList.add('recording');
        micIcon.style.display = 'none';
        stopIcon.style.display = 'block';
        resultBox.style.display = 'none';
        await startAudioRecording();
    } else {
        recordTrigger.classList.remove('recording');
        micIcon.style.display = 'block';
        stopIcon.style.display = 'none';
        recordTrigger.disabled = true;
        await stopAudioRecording();
        // Re-enable only after any final WS response, or immediately if nothing pending
        if (!wsPendingResponse) resetRecordUI();
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
let enrollCaptureRate = 16000;
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
            enrollAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
            enrollCaptureRate = enrollAudioCtx.sampleRate;
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

        const audioBlob = bufferToWav(resampleTo16k(enrollAudioBuffer, enrollCaptureRate));
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

async function fetchOllamaModels() {
    const sel = document.getElementById('settings-ollama-model');
    if (!sel) return;
    const currentVal = sel.dataset.current || sel.value;
    sel.innerHTML = '<option value="">Loading…</option>';
    try {
        const res = await fetch('/api/ollama/models');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const models = (data.models || []).map(m => m.name || m.model || m).filter(Boolean);
        if (models.length === 0) {
            sel.innerHTML = '<option value="">No models found</option>';
            return;
        }
        sel.innerHTML = '<option value="">— select model —</option>' +
            models.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
        if (currentVal) sel.value = currentVal;
    } catch (e) {
        sel.innerHTML = '<option value="">Could not reach Ollama server</option>';
    }
}

function setProvider(p) {
    document.querySelectorAll('.provider-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.provider === p);
    });
    const isWhisper = p === 'whisper';
    const liveTarget = document.getElementById('live-target-select');
    const targetLang = document.getElementById('target-lang');
    const settingsTargetLang = document.getElementById('settings-target-lang');
    const whisperNote = document.getElementById('whisper-en-note');
    const retBtn = document.getElementById('retranslate-btn');
    if (liveTarget) liveTarget.disabled = isWhisper;
    if (targetLang) targetLang.disabled = isWhisper;
    if (settingsTargetLang) settingsTargetLang.disabled = isWhisper;
    if (whisperNote) whisperNote.classList.toggle('hidden', !isWhisper);
    if (retBtn) retBtn.disabled = isWhisper || !lastCapture.text;
    fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ translation_provider: p }),
    }).catch(e => console.error('Failed to save provider:', e));
}

async function fetchSettings() {
    try {
        const res = await fetch('/api/settings');
        if (res.ok) {
            const s = await res.json();
            settingCuratedFolder.value = s.curated_audio_folder;
            settingMinSamples.value = s.min_enrollment_samples;
            settingMaxSamples.value = s.max_enrollment_samples;
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
            if (s.source_language) {
                const sourceLang = document.getElementById('source-lang');
                if (sourceLang) sourceLang.value = s.source_language;
            }
            if (s.target_language) {
                const targetLang = document.getElementById('target-lang');
                if (targetLang) targetLang.value = s.target_language;
            }
            // Conversation mode / TTS / privacy
            if (typeof s.conversation_mode === 'boolean') {
                conversationMode = s.conversation_mode;
                const ct = document.getElementById('convo-mode-toggle');
                if (ct) ct.checked = conversationMode;
            }
            if (s.patient_language) {
                patientLang = s.patient_language;
                const ps = document.getElementById('patient-lang');
                if (ps) ps.value = patientLang;
            }
            if (typeof s.tts_enabled === 'boolean') {
                ttsEnabled = s.tts_enabled;
                const tt = document.getElementById('tts-toggle');
                if (tt) tt.checked = ttsEnabled;
                if (window.TTS) TTS.enabled = ttsEnabled;
            }
            if (typeof s.privacy_mode === 'boolean') {
                privacyMode = s.privacy_mode;
                // Nothing is persisted in privacy mode — hide the Recordings card
                const recCard = recordingsTableBody && recordingsTableBody.closest('.card');
                if (recCard) recCard.style.display = privacyMode ? 'none' : '';
            }
            updateDirectionPillLabels();
            applyConversationModeUI();
            updateTTSVoiceNote();
            // Provider toggle
            if (s.translation_provider) setProvider(s.translation_provider);
            // Ollama settings
            const ollamaHost = document.getElementById('settings-ollama-host');
            if (ollamaHost && s.ollama_host) ollamaHost.value = s.ollama_host;
            const ollamaModelSel = document.getElementById('settings-ollama-model');
            if (ollamaModelSel && s.ollama_model) ollamaModelSel.dataset.current = s.ollama_model;
            if (s.translation_provider === 'ollama') fetchOllamaModels();
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
    if (apiKeyInput) patch.nemotron_api_key = apiKeyInput;
    const ollamaHostEl = document.getElementById('settings-ollama-host');
    if (ollamaHostEl && ollamaHostEl.value.trim()) patch.ollama_host = ollamaHostEl.value.trim();
    const ollamaModelEl = document.getElementById('settings-ollama-model');
    if (ollamaModelEl && ollamaModelEl.value) patch.ollama_model = ollamaModelEl.value;
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
