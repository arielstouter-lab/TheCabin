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
    window.SpeechRecognition ||
    window.webkitSpeechRecognition;

let recognition = null;
let isRecording = false;

if (SpeechRecognition) {
    recognition = new SpeechRecognition();

    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event) => {
        let text = '';

        for (let i = 0; i < event.results.length; i++) {
            text += event.results[i][0].transcript;
        }

        voiceText.value = text;

        localStorage.setItem('voiceTranscript', text);
    };

    recognition.onend = () => {
        isRecording = false;
        updateRecordButton();
    };
}

function startListening() {
    if (!SpeechRecognition) {
        recordBtn.disabled = true;
        recordBtn.textContent =
            'Speech Recognition Unavailable';
    }

    recognition.start();

    isRecording = true;
    updateRecordButton();
}

function stopListening() {
    if (!recognition) return;

    recognition.stop();

    isRecording = false;
    updateRecordButton();
}

function updateRecordButton() {
    recordBtn.textContent = isRecording
        ? '⏹ Stop Recording'
        : '🎤 Start Recording';
}

voiceBtn.onclick = () => {

    voiceText.value =
        localStorage.getItem('voiceTranscript') || '';

    voiceModal.classList.remove('hidden');

    if (!isRecording) {
        startListening();
    }
};

recordBtn.onclick = () => {
    if (isRecording) {
        stopListening();
    } else {
        startListening();
    }
};

closeVoiceBtn.onclick = async () => {
    if (isRecording) {
        stopListening();
    }

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