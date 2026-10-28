let mediaRecorder;
let audioChunks = [];

// Initialize Lucide icons
lucide.createIcons();
// State Management
let currentScreen = 'login';
let username = '';
let selectedDomain = 'Artificial Intelligence';
let selectedDifficulty = 'medium';
let selectedLanguage = 'english';
let selectedMode = 'video';
let isRecording = false;
let recordingStartTime = null;
let recordingTimer = null;
let interviewData = [];
let currentAudio = null; // tracks playing audio
let authToken = '';
try { localStorage.removeItem('intraview_token'); } catch (_) {}
let submitTimer = null, pendingBlob = null, sendOnStop = false, stopping = false, discardOnStop = false, isEnding = false, recordedMs = 0, requestController = null;
let sessionId = null;
let processingAnswer = false;
const API_BASE = 'http://127.0.0.1:5000';

function authHeaders(extra = {}) { return { ...extra, ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) }; }
async function apiJson(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, { ...options, headers: authHeaders(options.headers || {}) });
    let data; try { data = await response.json(); } catch { data = {}; }
    if (response.status === 401 && authToken) { authToken = ''; username = ''; sessionId = null; processingAnswer = false; showScreen('login-screen'); throw new Error('Session expired. Please log in again.'); }
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
}
let avatarReady = false;
function speakFallback(text, onDone) {
    const fin = () => { if (window.Avatar) window.Avatar.stopTimedSpeech(); setVideoState('LISTENING'); if (onDone) onDone(); };
    if (!text) { fin(); return; }
    if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) { console.error('Browser speech synthesis is unavailable.'); fin(); return; }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text); u.lang = 'en-US';
    u.onstart = () => { setVideoState('SPEAKING'); if (window.Avatar && avatarReady) window.Avatar.startTimedSpeech(); };
    u.onend = fin; u.onerror = fin;
    window.speechSynthesis.speak(u);
}

function setVideoState(state) {
    const stage = document.getElementById('avatar-stage');
    const wave = document.getElementById('ai-voice-wave');
    const loading = document.getElementById('video-loading');
    if (loading) loading.classList.add('hidden');
    const speaking = state === 'SPEAKING' || state === 'WELCOME';

    // AVATAR MODE: the 3D interviewer stays visible and just changes pose
    if (selectedMode === 'video' && avatarReady && window.Avatar) {
        if (wave) wave.classList.add('hidden');
        if (stage) stage.classList.remove('hidden');
        window.Avatar.setState(state === 'WELCOME' ? 'SPEAKING' : state);
        return;
    }
    if (state === 'LOADING') {
        if (stage) stage.classList.add('hidden');
        if (wave) wave.classList.add('hidden');
        if (loading) loading.classList.remove('hidden');
        return;
    }
    // VOICE MODE (or avatar unavailable): audio wave only
    if (stage) stage.classList.add('hidden');
    if (wave) wave.classList.toggle('hidden', !speaking);
}

async function ensureAvatar() {
    if (selectedMode !== 'video' || !window.Avatar) return false;
    if (avatarReady) return true;
    const text = document.getElementById('video-loading-text');
    const loading = document.getElementById('video-loading');
    if (loading) loading.classList.remove('hidden');
    if (text) text.textContent = 'Loading avatar...';
    const ok = await window.Avatar.init(document.getElementById('avatar-stage'), p => { if (text) text.textContent = `Loading avatar... ${p}%`; });
    if (text) text.textContent = 'Generating response...';
    if (loading) loading.classList.add('hidden');
    avatarReady = ok;
    if (!ok) alert('The 3D avatar could not be loaded, so the interview will use the voice wave instead.');
    return ok;
}
// Screen Management
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.remove('active');
        screen.style.display = 'none';
    });
    const target = document.getElementById(screenId);
    if (!target) { console.error(`Screen not found: ${screenId}`); return; }
    target.style.display = 'flex';
    const menuWrapper = document.getElementById('user-menu-wrapper');
    if (menuWrapper) {
        const authenticatedScreen = ['welcome-screen', 'setup-screen', 'interview-screen', 'feedback-screen', 'profile-screen', 'history-screen'].includes(screenId) && Boolean(authToken);
        menuWrapper.classList.toggle('hidden', !authenticatedScreen);
    }
    const menu = document.getElementById('user-menu');
    if (menu) menu.classList.add('hidden');
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    setTimeout(() => {
        target.classList.add('active');
        currentScreen = screenId;
        if (window.lucide) lucide.createIcons();
    }, 50);
}


async function signup() {
    const fullName = document.getElementById('signup-fullname').value.trim();
    const email = document.getElementById('signup-email').value.trim();
    const role = document.getElementById('signup-role').value;
    const user = document.getElementById('signup-username').value.trim();
    const pass = document.getElementById('signup-password').value;
    if (!user || !pass || !fullName || !email || !role) {
        alert('Please fill in all fields to create your professional profile.');
        return;
    }
    try {
        const res = await fetch(`${API_BASE}/signup`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fullname: fullName, email, role, username: user, password: pass })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Signup failed (${res.status})`);
        if (!data.token) throw new Error('Signup succeeded but no authentication token was returned.');
        username = data.username || user;
        authToken = data.token;
        
        document.getElementById('welcome-text').textContent = `Welcome, ${data.fullname || username}`;
        document.getElementById('dropdown-full-name').textContent = data.fullname || username;
        document.getElementById('dropdown-username').textContent = `@${username.toLowerCase()}`;
        showScreen('welcome-screen');
    } catch (err) {
        console.error('Signup failed:', err);
        alert(err.message || 'Could not connect to the IntraView server.');
    }
}

async function login() {
    const user = document.getElementById('username-input').value.trim();
    const pass = document.getElementById('password-input').value;
    if (!user || !pass) { alert('Enter your username and password.'); return; }
    try {
        const res = await fetch(`${API_BASE}/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: user, password: pass })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Login failed (${res.status})`);
        if (!data.token) throw new Error('Login succeeded but no authentication token was returned.');
        username = data.username || user;
        authToken = data.token;
        
        document.getElementById('welcome-text').textContent = `Welcome, ${data.fullname || username}`;
        document.getElementById('dropdown-full-name').textContent = data.fullname || username;
        document.getElementById('dropdown-username').textContent = `@${username.toLowerCase()}`;
        showScreen('welcome-screen');
    } catch (err) {
        console.error('Login failed:', err);
        alert(err.message || 'Could not connect to the IntraView server.');
    }
}
// Setup Functions
function selectDifficulty(difficulty) {
    selectedDifficulty = difficulty;
    
    // Update UI
    document.querySelectorAll('.difficulty-btn').forEach(btn => {
        btn.classList.remove('active', 'border-indigo-500', 'bg-indigo-600/20', 'text-indigo-400');
        btn.classList.add('border-slate-700', 'bg-slate-800/50', 'text-slate-400');
    });
    
    const selectedBtn = document.getElementById(`diff-${difficulty}`);
    selectedBtn.classList.remove('border-slate-700', 'bg-slate-800/50', 'text-slate-400');
    selectedBtn.classList.add('active');
}

function selectMode(mode) {
    selectedMode = mode;
    
    const videoLabel = document.getElementById('mode-video-label');
    const voiceLabel = document.getElementById('mode-voice-label');
    const videoDot = document.getElementById('mode-video-dot');
    const voiceDot = document.getElementById('mode-voice-dot');
    const voiceContainer = document.getElementById('mode-voice-dot-container');
    
    if (mode === 'video') {
        videoLabel.classList.add('border-indigo-500', 'bg-indigo-600/10');
        videoLabel.classList.remove('border-slate-700', 'bg-slate-800/50');
        videoDot.classList.remove('bg-transparent');
        videoDot.classList.add('bg-indigo-500');
        
        voiceLabel.classList.remove('border-indigo-500', 'bg-indigo-600/10');
        voiceLabel.classList.add('border-slate-700', 'bg-slate-800/50');
        voiceDot.classList.add('bg-transparent');
        voiceDot.classList.remove('bg-indigo-500');
        voiceContainer.classList.remove('border-indigo-500');
        voiceContainer.classList.add('border-slate-600');
    } else {
        voiceLabel.classList.add('border-indigo-500', 'bg-indigo-600/10');
        voiceLabel.classList.remove('border-slate-700', 'bg-slate-800/50');
        voiceDot.classList.remove('bg-transparent');
        voiceDot.classList.add('bg-indigo-500');
        voiceContainer.classList.remove('border-slate-600');
        voiceContainer.classList.add('border-indigo-500');
        
        videoLabel.classList.remove('border-indigo-500', 'bg-indigo-600/10');
        videoLabel.classList.add('border-slate-700', 'bg-slate-800/50');
        videoDot.classList.add('bg-transparent');
        videoDot.classList.remove('bg-indigo-500');
    }
}

let startingInterview = false;
async function startInterview() {
    if (startingInterview) return;
    if (window.Avatar) window.Avatar.unlockAudio(); // must run inside the click so audio can start later
    if (!authToken) { alert('Please log in again before starting an interview.'); showScreen('login-screen'); return; }
    selectedDomain = document.getElementById('domain-select').value;
    selectedLanguage = document.getElementById('language-select').value || 'english';
    document.getElementById('display-username').textContent = username;
    document.getElementById('display-domain').textContent = selectedDomain;
    document.getElementById('display-language').textContent = selectedLanguage.charAt(0).toUpperCase() + selectedLanguage.slice(1);
    interviewData = []; sessionId = null; processingAnswer = false; isEnding = false;
    startingInterview = true;
    const startBtn = document.querySelector('#setup-screen button[onclick="startInterview()"]');
    if (startBtn) startBtn.disabled = true;
    try {
        const data = await apiJson('/start-interview', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({domain:selectedDomain, difficulty:selectedDifficulty, mode:selectedMode, language:selectedLanguage}) });
        sessionId = data.session_id;
        document.getElementById('question-text').textContent = data.question;
        const counter = document.getElementById('question-counter'); if (counter) counter.textContent = `Question 1 of ${data.total}`;
        const progress = document.getElementById('progress-bar'); if (progress) progress.style.width = `${100 / data.total}%`;
        const percent = document.getElementById('progress-percent'); if (percent) percent.textContent = `${Math.round(100 / data.total)}%`;
        showScreen('interview-screen');
        await ensureAvatar();
        setVideoState('LISTENING');
        if (data.audio_url) playInterviewerAudio(data.audio_url, data.spoken_text || data.question); else speakFallback(data.spoken_text || data.question);
    } catch (e) { alert(`Could not start interview: ${e.message}`); }
    finally { startingInterview = false; if (startBtn) startBtn.disabled = false; }
    const micButton = document.getElementById('mic-btn');
        if (selectedMode === 'voice') { if (micButton) micButton.classList.add('scale-150','my-8'); }
    else if (micButton) micButton.classList.remove('scale-150','my-8');
}

function stopInterviewerAudio() {
    if (window.Avatar) { window.Avatar.detachAudio(); window.Avatar.stopTimedSpeech(); }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    if (currentAudio) { const old = currentAudio; currentAudio = null; old.pause(); old.removeAttribute('src'); } // null first: stale events are ignored
}

function playInterviewerAudio(audioUrl, fallbackText, onDone) {
    stopInterviewerAudio();
    let finished = false;
    const done = () => { if (finished) return; finished = true; if (window.Avatar) window.Avatar.stopTimedSpeech(); setVideoState('LISTENING'); if (onDone) onDone(); };
    if (!audioUrl) { speakFallback(fallbackText, done); return; }
    const audio = new Audio();
    audio.crossOrigin = 'anonymous'; // must be set before src, or the analyser hears silence
    audio.preload = 'auto';
    currentAudio = audio;
    let fellBack = false;
    const fallbackOnce = () => { if (fellBack || finished || currentAudio !== audio) return; fellBack = true; speakFallback(fallbackText, done); };
    const analysed = avatarReady && window.Avatar ? window.Avatar.attachAudio(audio) : false;
    audio.addEventListener('playing', () => {
        if (currentAudio !== audio) return;
        setVideoState('SPEAKING');
        if (avatarReady && window.Avatar && !analysed) window.Avatar.startTimedSpeech();
    }, { once: true });
    audio.addEventListener('ended', () => { if (currentAudio === audio) done(); }, { once: true });
    audio.addEventListener('error', fallbackOnce, { once: true });
    audio.src = `${API_BASE}${audioUrl}`;
    audio.play().catch(fallbackOnce);
}

// Interview Functions
async function toggleRecording() {
    const micBtn = document.getElementById('mic-btn');
    const statusText = document.getElementById('recording-status');
    const waveform = document.getElementById('waveform');
    const timer = document.getElementById('recording-timer');
    const submitBtn = document.getElementById('submit-btn');

    if (processingAnswer || stopping) return;
    if (isRecording) { stopRecording(); return; }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
        alert('Audio recording is not supported in this browser. Please use a recent version of Chrome, Safari, or Edge.');
        return;
    }

    micBtn.disabled = true;
    statusText.textContent = 'Requesting microphone access…';
    let acquiredStream = null;
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        acquiredStream = stream;
        const recorder = mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];
        mediaRecorder.ondataavailable = event => { if (event.data && event.data.size > 0) audioChunks.push(event.data); };
        mediaRecorder.onstop = () => {
            const blob = new Blob(audioChunks, { type: recorder.mimeType || 'audio/webm' });
            audioChunks = [];
            stream.getTracks().forEach(track => track.stop());
            stopping = false;
            if (discardOnStop) { discardOnStop = false; return; }
            if (blob.size === 0 || recordedMs < 2000) { resetInterviewUI(); statusText.innerHTML = '<span>Recording too short. Please try again.</span>'; return; }
            if (sendOnStop) { sendOnStop = false; sendAudioToBackend(blob); return; }
            pendingBlob = blob;
            statusText.innerHTML = `<span class="text-slate-400">Recorded ${formatTime(Math.floor(recordedMs / 1000))} - press Submit, or tap the mic to re-record</span>`;
            submitBtn.disabled = false;
            submitBtn.classList.remove('bg-slate-800', 'text-slate-500', 'cursor-not-allowed');
            submitBtn.classList.add('bg-indigo-600', 'text-white', 'hover:bg-indigo-500', 'shadow-lg', 'shadow-indigo-500/25');
        };
        mediaRecorder.start();
        pendingBlob = null; clearTimeout(submitTimer);
        isRecording = true;
        micBtn.disabled = false;
        micBtn.classList.add('recording');
        statusText.innerHTML = '<span class="text-red-400 font-semibold flex items-center gap-2"><span class="w-2 h-2 bg-red-500 rounded-full animate-pulse"></span>Recording…</span>';
        waveform.classList.remove('hidden');
        timer.classList.remove('hidden');
        recordingStartTime = Date.now();
        clearInterval(recordingTimer);
        recordingTimer = setInterval(updateTimer, 1000);
        submitBtn.disabled = true;
        submitBtn.classList.remove('bg-indigo-600', 'text-white', 'hover:bg-indigo-500', 'shadow-lg', 'shadow-indigo-500/25');
        submitBtn.classList.add('bg-slate-800', 'text-slate-500', 'cursor-not-allowed');
        submitTimer = setTimeout(() => {
            if (isRecording && !processingAnswer) {
                submitBtn.disabled = false;
                submitBtn.classList.remove('bg-slate-800', 'text-slate-500', 'cursor-not-allowed');
                submitBtn.classList.add('bg-indigo-600', 'text-white', 'hover:bg-indigo-500', 'shadow-lg', 'shadow-indigo-500/25');
            }
        }, 3000);
    } catch (err) {
        console.error('Microphone access failed:', err);
        streamCleanupIfNeeded();
        if (acquiredStream) acquiredStream.getTracks().forEach(track => track.stop());
        isRecording = false;
        micBtn.disabled = false;
        alert('Microphone access failed. Please allow microphone access and try again.');
        resetInterviewUI();
    }
}

function streamCleanupIfNeeded() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        try { mediaRecorder.stop(); } catch (_) { /* already stopped */ }
    }
}

function stopRecording(send = false, discard = false) {
    const micBtn = document.getElementById('mic-btn');
    const statusText = document.getElementById('recording-status');
    isRecording = false; stopping = true; sendOnStop = send; discardOnStop = discard;
    recordedMs = Date.now() - recordingStartTime;
    micBtn.classList.remove('recording');
    clearInterval(recordingTimer); clearTimeout(submitTimer);
    statusText.innerHTML = `<span class="text-slate-400">Recorded ${formatTime(Math.floor(recordedMs / 1000))}</span>`;
    document.getElementById('waveform').classList.add('hidden');
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop(); else stopping = false;
}

async function sendAudioToBackend(blob) {
    if (processingAnswer) return;
    if (!sessionId || !authToken) { alert('Interview session expired. Please log in and start again.'); resetInterviewUI(); return; }
    processingAnswer = true;
    const oldQuestion = document.getElementById('question-text').textContent;
    const formData = new FormData();
    formData.append('audio', blob, 'input.webm');
    formData.append('session_id', sessionId);
    const status = document.getElementById('ai-status-text'); if (status) status.textContent = 'Processing your answer...';
    document.getElementById('processing-status')?.classList.remove('hidden');
    document.getElementById('submit-btn').disabled = true; document.getElementById('mic-btn').disabled = true;
    setVideoState('LOADING');
    try {
        requestController = new AbortController();
        const data = await apiJson('/process-audio', { method:'POST', body:formData, signal: requestController.signal });
        if (data.silent) {
            document.getElementById('question-text').textContent = data.question || oldQuestion;
            if (data.audio_url) playInterviewerAudio(data.audio_url, data.spoken_text); else speakFallback(data.spoken_text);
            return;
        }
        if (data.transcript) interviewData.push({ question:oldQuestion, transcript:data.transcript, confidence:Number(data.confidence)||0, communication:Number(data.communication)||0, emotion:data.emotion||'Professional' });
        document.getElementById('question-text').textContent = data.question || 'Response received.';
        const counter = document.getElementById('question-counter'); if (counter && data.question_number && data.total) counter.textContent = `Question ${data.question_number} of ${data.total}`;
        const progress = document.getElementById('progress-bar'); if (progress && data.question_number && data.total) progress.style.width = `${Math.min(100, data.question_number/data.total*100)}%`;
        const percent = document.getElementById('progress-percent'); if (percent && data.question_number && data.total) percent.textContent = `${Math.min(100,Math.round(data.question_number/data.total*100))}%`;
        if (data.end) {
            await new Promise(res => { const t = setTimeout(res, 20000); playInterviewerAudio(data.audio_url, data.spoken_text || data.question, () => { clearTimeout(t); res(); }); });
            await endInterview(true);
            return;
        }
        if (data.audio_url) playInterviewerAudio(data.audio_url, data.spoken_text || data.question); else speakFallback(data.spoken_text || data.question);
    } catch (e) {
        if (e.name === 'AbortError') return;
        console.error('Audio pipeline error:', e); alert(`Could not process your answer: ${e.message}`); setVideoState('LISTENING');
    } finally { processingAnswer = false; resetInterviewUI(); }
}
function updateTimer() {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    document.getElementById('recording-timer').textContent = formatTime(elapsed);
}

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
    const secs = (seconds % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
}

function submitAnswer() {
    if (processingAnswer || stopping) return;
    if (isRecording) {
        stopRecording(true);
    } else if (pendingBlob) {
        const blob = pendingBlob; pendingBlob = null;
        sendAudioToBackend(blob);
    } else {
        return;
    }
    if (!stopping && !processingAnswer) return;
    
    // Lock UI and show processing steps
    document.getElementById('processing-status').classList.remove('hidden');
    document.getElementById('submit-btn').disabled = true;
    document.getElementById('mic-btn').disabled = true;
    
    document.getElementById('ai-status').classList.remove('opacity-0');
    document.getElementById('ai-status-text').textContent = 'Processing audio...';
    
    document.getElementById('status-listening').classList.add('status-completed');
    document.getElementById('status-processing').classList.add('status-active');
    
    if (selectedMode === 'video') {
        document.getElementById('video-loading').classList.remove('hidden');
    }
}

function resetInterviewUI() {
    pendingBlob = null; clearTimeout(submitTimer);
    document.getElementById('processing-status').classList.add('hidden');
    // Clear the processing-step colours so the next answer starts from a clean state
    ['status-listening', 'status-processing', 'status-generating'].forEach(id => {
        const step = document.getElementById(id);
        if (step) step.classList.remove('status-active', 'status-completed');
    });
    const aiStatus = document.getElementById('ai-status');
    if (aiStatus) aiStatus.classList.add('opacity-0');
    document.getElementById('recording-status').innerHTML = '<span>Click microphone to start recording</span>';
    document.getElementById('recording-timer').textContent = '00:00';
    document.getElementById('recording-timer').classList.add('hidden');
    document.getElementById('waveform').classList.add('hidden');
    
    const submitBtn = document.getElementById('submit-btn');
    submitBtn.disabled = true;
    submitBtn.classList.remove('bg-indigo-600', 'text-white', 'hover:bg-indigo-500', 'shadow-lg', 'shadow-indigo-500/25');
    submitBtn.classList.add('bg-slate-800', 'text-slate-500', 'cursor-not-allowed');
    
    const micBtn = document.getElementById('mic-btn');
    micBtn.disabled = false;
    micBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    micBtn.classList.remove('recording');
}

function getConfidenceText(score) {
    if (score >= 90) return 'Excellent confidence';
    if (score >= 80) return 'Strong confidence';
    if (score >= 70) return 'Good confidence; room to improve';
    return 'Confidence needs development';
}
function getCommunicationText(score) {
    if (score >= 90) return 'Exceptional clarity';
    if (score >= 80) return 'Clear communication';
    if (score >= 70) return 'Good communication; reduce fillers';
    return 'Communication could be clearer';
}

function updateEmotionDisplay(emotion) {
    const emotionData = {
        'Confident': { icon: '💪', label: 'Confident', desc: 'Strong, assured presence', color: 'text-indigo-400', tags: ['Assertive', 'Assured'] },
        'Enthusiastic': { icon: '⚡', label: 'Enthusiastic', desc: 'High energy and engagement', color: 'text-yellow-400', tags: ['Energetic', 'Engaged'] },
        'Calm': { icon: '🧘', label: 'Calm', desc: 'Composed and steady', color: 'text-blue-400', tags: ['Calm', 'Steady'] },
        'Professional': { icon: '👔', label: 'Professional', desc: 'Formal and structured', color: 'text-slate-400', tags: ['Formal', 'Structured'] },
        'Tense': { icon: '😟', label: 'Tense', desc: 'Try to relax and pace your responses', color: 'text-amber-400', tags: ['Tense', 'Rushed'] },
        'Subdued': { icon: '🌿', label: 'Subdued', desc: 'Try a more energetic delivery', color: 'text-blue-400', tags: ['Quiet', 'Low energy'] }
    };

    const data = emotionData[emotion] || emotionData['Professional'];

    document.getElementById('emotion-icon').textContent = data.icon;
    document.getElementById('emotion-label').textContent = data.label;
    document.getElementById('emotion-label').className = `font-semibold ${data.color}`;
    document.getElementById('emotion-desc').textContent = data.desc;
    document.getElementById('emotion-icon').classList.add('emotion-pulse');

    // Tone chips now follow the detected emotion instead of always showing "Calm / Steady"
    const tagBox = document.getElementById('emotion-tags');
    if (tagBox) {
        tagBox.replaceChildren();
        data.tags.forEach(tag => {
            const chip = document.createElement('span');
            chip.className = 'px-2 py-1 bg-slate-800 rounded text-xs text-slate-400';
            chip.textContent = tag;
            tagBox.append(chip);
        });
    }
}

function restartInterview() {
    interviewData = [];
    if (isRecording) stopRecording(false, true);
    if (requestController) requestController.abort();
    isEnding = false;
    [['overall-score', '0'], ['confidence-value', '0%'], ['communication-value', '0%'], ['confidence-text', ''], ['communication-text', ''], ['ai-feedback-text', 'Your feedback will appear here once the interview is analysed.']].forEach(([id, v]) => { const el = document.getElementById(id); if (el) el.textContent = v; });
    document.getElementById('username-input').value = '';
    document.getElementById('password-input').value = '';
    document.getElementById('score-circle').style.strokeDashoffset = 440;
    document.getElementById('confidence-bar').style.width = '0%';
    document.getElementById('communication-bar').style.width = '0%';
    document.getElementById('emotion-icon').classList.remove('emotion-pulse');
    const emotionTags = document.getElementById('emotion-tags'); if (emotionTags) emotionTags.replaceChildren();

    // Reset setup selections
    selectedDomain = 'Artificial Intelligence';
    selectedDifficulty = 'medium';
    selectedLanguage = 'english';
    selectedMode = 'video';
    document.getElementById('domain-select').value = 'Artificial Intelligence';
    document.getElementById('language-select').value = 'english';
        selectDifficulty('medium');
    selectMode('video');
    
    sessionId = null; processingAnswer = false;
    const progressBar = document.getElementById('progress-bar'); if (progressBar) progressBar.style.width = '0%';
    const progressPercent = document.getElementById('progress-percent'); if (progressPercent) progressPercent.textContent = '0%';
    const questionCounter = document.getElementById('question-counter'); if (questionCounter) questionCounter.textContent = 'Question 1 of 5';
    stopInterviewerAudio();
    resetInterviewUI();
    showScreen('setup-screen');
}

function downloadReport() {
    // Create a simple text report
    const report = `
INTERVIEW PERFORMANCE REPORT
Generated by IntraView AI
Candidate: ${username}
Date: ${new Date().toLocaleDateString()}

OVERALL SCORE: ${document.getElementById('overall-score').textContent}/100

BREAKDOWN:
- Confidence: ${document.getElementById('confidence-value').textContent}
- Communication: ${document.getElementById('communication-value').textContent}
- Dominant Emotion: ${document.getElementById('emotion-label').textContent}

AI FEEDBACK:
${document.getElementById('ai-feedback-text').textContent}

DETAILED RESPONSES:
${interviewData.map((d, i) => `\nQ${i+1}: ${d.question}\nYour answer: ${d.transcript || 'Not available'}\nConfidence: ${d.confidence}% | Communication: ${d.communication}%`).join('\n')}
    `.trim();
    
    // Create download
    const blob = new Blob([report], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `IntraView_Report_${username.replace(/\s+/g, '_')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Enter key support for inputs
document.addEventListener('DOMContentLoaded', () => {
    const usernameInput = document.getElementById('username-input');
    const passwordInput = document.getElementById('password-input');
    
    if (usernameInput) {
        usernameInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && passwordInput) {
                passwordInput.focus();
            }
        });
    }
    
    if (passwordInput) {
        passwordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                login();
            }
        });
    }
    
    // Initialize mode selection
    selectMode('video');

});

async function endInterview(alreadyCompleted = false) {
    if (isEnding) return;
    if (!alreadyCompleted) {
        if (isRecording) stopRecording(false, true);
        if (requestController) requestController.abort();
    }
    if (!alreadyCompleted) {
        stopInterviewerAudio();
    }
    if (!sessionId) { showScreen('feedback-screen'); return; }
    const feedbackEl = document.getElementById('ai-feedback-text');
    if (feedbackEl) feedbackEl.textContent = 'Generating your interview feedback…';
    showScreen('feedback-screen');
    isEnding = true;
    try {
        const result = await apiJson('/end-interview', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({session_id:sessionId}) });
        const setText = (id, value) => { const el=document.getElementById(id); if (el) el.textContent = String(value ?? 0); };
        setText('overall-score', result.overall_score ?? 0);
        setText('confidence-value', `${result.confidence ?? 0}%`); setText('communication-value', `${result.communication ?? 0}%`);
        const confidenceText = document.getElementById('confidence-text'); if (confidenceText) confidenceText.textContent = getConfidenceText(Number(result.confidence) || 0);
        const communicationText = document.getElementById('communication-text'); if (communicationText) communicationText.textContent = getCommunicationText(Number(result.communication) || 0);
        const confidenceBar=document.getElementById('confidence-bar'); if(confidenceBar) confidenceBar.style.width=`${result.confidence ?? 0}%`;
        const communicationBar=document.getElementById('communication-bar'); if(communicationBar) communicationBar.style.width=`${result.communication ?? 0}%`;
        const circle=document.getElementById('score-circle'); if(circle) circle.style.strokeDashoffset=440-(440*(Number(result.overall_score)||0)/100);
        if (feedbackEl) feedbackEl.textContent = result.feedback || 'Interview completed.';
        if (typeof updateEmotionDisplay === 'function') updateEmotionDisplay(result.emotion || 'Professional');
    } catch (e) {
        console.error('Finalisation error:', e);
        if (feedbackEl) feedbackEl.textContent = `Could not retrieve final feedback: ${e.message}`;
    } finally { isEnding = false; }
}

function toggleUserMenu() {
    const menu = document.getElementById('user-menu');
    if (menu) {
        menu.classList.toggle('hidden');
        lucide.createIcons(); // Makes sure the new icons load
    }
}

async function logout() {
    if (isRecording) stopRecording(false, true);
    stopInterviewerAudio();
    try { if (authToken) await fetch(`${API_BASE}/logout`, {method:'POST', headers:authHeaders()}); } catch (e) { console.warn(e); }
    authToken = ''; localStorage.removeItem('intraview_token'); sessionId = null; username = '';
    const menu = document.getElementById('user-menu');
    if (menu) menu.classList.add('hidden');
    showScreen('login-screen');
}

async function loadProfile() {
    // Hide the dropdown menu
    const menu = document.getElementById('user-menu');
    if (menu) menu.classList.add('hidden');

    showScreen('profile-screen');

    try {
        const res = await fetch(`${API_BASE}/get-profile/${encodeURIComponent(username)}`, { headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not load profile');
        {
            document.getElementById('profile-fullname').textContent = data.fullname || data.username;
            document.getElementById('profile-username').textContent = '@' + data.username;
            document.getElementById('profile-email').textContent = data.email || 'N/A';
            document.getElementById('profile-role').textContent = data.target_role || 'N/A';
            document.getElementById('profile-total').textContent = data.total_interviews || 0;
            document.getElementById('profile-avg-score').textContent = (data.avg_score || 0) + '%';
        }
    } catch (err) {
        console.error(err);
        const nameEl = document.getElementById('profile-fullname'); if (nameEl) nameEl.textContent = 'Could not load profile';
    }
}
async function loadHistory() {
    showScreen('history-screen');
    const container = document.getElementById('history-container');
    container.innerHTML = '<p class="text-slate-400 text-center col-span-2">Loading your history...</p>';

    try {
        // Fetching from the route we created in app.py
        const res = await fetch(`${API_BASE}/get-history/${encodeURIComponent(username)}`, { headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not load history');

        if (data.length === 0) {
            container.innerHTML = '<p class="text-slate-400 text-center col-span-2">No interviews recorded yet.</p>';
            return;
        }

        container.replaceChildren();
        data.forEach(item => {
            const card = document.createElement('div');
            card.className = 'bg-slate-900/50 border border-slate-800 p-6 rounded-2xl shadow-xl hover:border-indigo-500/30 transition-all';
            const top = document.createElement('div'); top.className = 'flex justify-between items-start mb-4';
            const details = document.createElement('div');
            const title = document.createElement('h4'); title.className = 'text-lg font-bold text-indigo-400';
            title.textContent = `${item.domain || 'Interview'} (${item.difficulty || 'N/A'} | ${item.mode || 'N/A'})`;
            const dateEl = document.createElement('p'); dateEl.className = 'text-xs text-slate-500';
            const parsedDate = item.date ? new Date(item.date) : null;
            dateEl.textContent = parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toLocaleString() : 'Date unavailable';
            details.append(title, dateEl);
            const score = document.createElement('span'); score.className = 'px-3 py-1 bg-indigo-500/20 text-indigo-400 rounded-full text-xs font-bold';
            score.textContent = `Score: ${Number(item.overall_score) || 0}%`;
            top.append(details, score);
            const grid = document.createElement('div'); grid.className = 'grid grid-cols-2 gap-4 text-sm text-slate-300';
            [['Confidence', item.confidence], ['Communication', item.communication], ['Tone', item.emotion]].forEach(([label, value]) => {
                const cell = document.createElement('div'); cell.className = 'flex flex-col';
                if (label === 'Tone') cell.classList.add('col-span-2', 'pt-2', 'border-t', 'border-slate-800', 'italic', 'text-slate-400');
                const labelEl = document.createElement('span'); labelEl.className = 'text-xs text-slate-500 uppercase font-bold'; labelEl.textContent = label;
                const valueEl = document.createElement('span'); valueEl.textContent = label === 'Tone' ? String(value || 'N/A') : `${Number(value) || 0}%`;
                cell.append(labelEl, valueEl); grid.append(cell);
            });
            card.append(top, grid); container.append(card);
        });
    } catch (err) {
        container.innerHTML = '<p class="text-red-400 text-center col-span-2">Error connecting to database.</p>';
        console.error(err);
    }
}