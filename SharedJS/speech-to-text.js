const voiceBtn = document.getElementById('voiceBtn');
const voiceModal = document.getElementById('voiceModal');
const closeVoiceBtn = document.getElementById('closeVoiceBtn');
const recordBtn = document.getElementById('recordBtn');
const voiceText = document.getElementById('voiceText');
const clearVoiceBtn =
    document.getElementById('clearVoiceBtn');

voiceText.value =
    localStorage.getItem('voiceTranscript') || '';

clearVoiceBtn.onclick = () => {
    voiceText.value = '';

    localStorage.removeItem(
        'voiceTranscript'
    );
};


const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

let recognition = null;
let state = 'idle';          // 'idle' | 'starting' | 'recording' | 'stopping'
let startWhenIdle = false;
let baseText = '';
let gotSignal = false;
let noSignalTimer = null;
let stopTimer = null;
let speechBroken = false;    // set when the engine proves unusable this session

function clearTimers() {
    clearTimeout(noSignalTimer);
    clearTimeout(stopTimer);
}

function markSignal() {
    gotSignal = true;
    clearTimeout(noSignalTimer);
}

function createRecognition() {
    if (!SpeechRecognition) return;

    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
        state = 'recording';
        gotSignal = false;
        updateRecordButton();

        // Engines that start but never hear anything (e.g. some WebViews)
        noSignalTimer = setTimeout(() => {
            if (!gotSignal && state === 'recording') {
                speechBroken = true;
                forceReset();
                voiceText.placeholder =
                    'Voice capture is not working in this browser. Use your keyboard\'s mic button.';
                voiceText.focus();
            }
        }, 6000);
    };

    recognition.onaudiostart = markSignal;
    recognition.onspeechstart = markSignal;

    recognition.onend = () => {
        clearTimers();
        state = 'idle';
        updateRecordButton();

        if (startWhenIdle) {
            startWhenIdle = false;
            startListening();
        }
    };

    recognition.onerror = (event) => {
        console.error('Speech error:', event.error);
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
            speechBroken = true;
            voiceText.placeholder =
                'Microphone permission denied. Use your keyboard\'s mic button.';
        }
    };

    recognition.onresult = (event) => {
        markSignal();
        let text = '';
        for (let i = 0; i < event.results.length; i++) {
            text += event.results[i][0].transcript;
        }
        voiceText.value = (baseText ? baseText + ' ' : '') + text;
        localStorage.setItem('voiceTranscript', voiceText.value);
    };
}

// Throw away a stuck engine and build a fresh one
function forceReset() {
    clearTimers();
    startWhenIdle = false;

    if (recognition) {
        const old = recognition;
        old.onstart = old.onend = old.onerror = old.onresult =
            old.onaudiostart = old.onspeechstart = null;
        try { old.abort(); } catch (e) {}
    }

    createRecognition();
    state = 'idle';
    updateRecordButton();
}

function startListening() {
    if (!recognition || speechBroken) {
        voiceText.focus();
        return;
    }

    if (state === 'stopping') {
        startWhenIdle = true;
        return;
    }
    if (state !== 'idle') return;

    baseText = voiceText.value.trim();
    state = 'starting';
    updateRecordButton();

    try {
        recognition.start();
    } catch (err) {
        console.error(err);
        forceReset();
    }
}

function stopListening() {
    if (!recognition) return;
    startWhenIdle = false;

    if (state === 'recording' || state === 'starting') {
        state = 'stopping';
        updateRecordButton();
        clearTimeout(noSignalTimer);

        try { recognition.stop(); } catch (e) {}

        // If onend never fires, don't stay stuck
        stopTimer = setTimeout(() => {
            if (state === 'stopping') forceReset();
        }, 1500);
    }
}

function updateRecordButton() {
    if (!recognition) {
        recordBtn.disabled = true;
        recordBtn.textContent = 'Use Keyboard Dictation';
        return;
    }

    if (speechBroken) {
        recordBtn.disabled = true;
        recordBtn.textContent = 'Use Keyboard Dictation';
        return;
    }

    recordBtn.disabled = (state === 'starting' || state === 'stopping');

    recordBtn.textContent =
        state === 'recording' ? 'Stop Recording' :
            state === 'starting'  ? 'Starting…' :
                state === 'stopping'  ? 'Stopping…' :
                    'Start Recording';
}

createRecognition();

voiceBtn.onclick = () => {
    voiceText.value = localStorage.getItem('voiceTranscript') || '';
    voiceModal.classList.remove('hidden');

    if (SpeechRecognition) {
        startListening();   // safe now: handles idle/stopping/already running
    } else {
        setTimeout(() => voiceText.focus(), 100);
    }
};

recordBtn.onclick = () => {
    if (state === 'recording') stopListening();
    else startListening();
};

closeVoiceBtn.onclick = async () => {
    stopListening();
    // ...rest unchanged (clipboard copy, hide modal)

    const text = voiceText.value.trim();

    if (text) {
        try {
            await navigator.clipboard.writeText(text);
            console.log('Copied voice text to clipboard');
        } catch (err) {
            console.error('Clipboard copy failed:', err);
        }
    }

    voiceModal.classList.add('hidden');
};

voiceText.addEventListener('input', () => {
    localStorage.setItem(
        'voiceTranscript',
        voiceText.value
    );
});

if (!SpeechRecognition) {
    recordBtn.disabled = true;
    recordBtn.textContent =
        'Speech Recognition Unavailable';
}

updateRecordButton();