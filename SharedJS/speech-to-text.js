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
let startWhenIdle = false;   // user asked to start while still stopping
let baseText = '';           // text already in the box before this session

if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
        state = 'recording';
        updateRecordButton();
    };

    recognition.onend = () => {
        state = 'idle';
        updateRecordButton();

        if (startWhenIdle) {
            startWhenIdle = false;
            startListening();
        }
    };

    recognition.onerror = (event) => {
        console.error('Speech error:', event.error);
        // 'no-speech' and 'aborted' are routine; onend fires after every error
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
            voiceText.placeholder = 'Microphone permission denied. Use keyboard dictation.';
        }
    };

    recognition.onresult = (event) => {
        let text = '';
        for (let i = 0; i < event.results.length; i++) {
            text += event.results[i][0].transcript;
        }
        voiceText.value = (baseText ? baseText + ' ' : '') + text;
        localStorage.setItem('voiceTranscript', voiceText.value);
    };
}

function startListening() {
    if (!recognition) {
        voiceText.focus();
        return;
    }

    if (state === 'stopping') {          // wait for onend, then start
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
        state = 'idle';
        updateRecordButton();
    }
}

function stopListening() {
    if (!recognition) return;
    startWhenIdle = false;

    if (state === 'recording' || state === 'starting') {
        state = 'stopping';
        updateRecordButton();
        recognition.stop();
    }
}

function updateRecordButton() {
    if (!recognition) {
        recordBtn.disabled = true;
        recordBtn.textContent = 'Use Keyboard Dictation';
        return;
    }

    // Disable only while the engine is in transition
    recordBtn.disabled = (state === 'starting' || state === 'stopping');

    recordBtn.textContent =
        state === 'recording' ? 'Stop Recording' :
            state === 'starting'  ? 'Starting…' :
                state === 'stopping'  ? 'Stopping…' :
                    'Start Recording';
}

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