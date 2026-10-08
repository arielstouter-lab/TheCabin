const voiceBtn = document.getElementById('voiceBtn');
const voiceModal = document.getElementById('voiceModal');
const closeVoiceBtn = document.getElementById('closeVoiceBtn');

voiceBtn.onclick = async () => {
    voiceModal.classList.remove('hidden');

    if (!isRecording) {
        await startRecording();
    }
};

closeVoiceBtn.onclick = () => {
    if (isRecording) {
        stopRecording();
    }

    voiceModal.classList.add('hidden');
};

let recorder;
let chunks = [];
let isRecording = false;
let mediaStream;
const recordBtn = document.getElementById('recordBtn');

recordBtn.onclick = async () => {
    if (isRecording) {
        stopRecording();
    } else {
        await startRecording();
    }
};

async function startRecording() {
    mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true
    });

    chunks = [];

    recorder = new MediaRecorder(mediaStream);

    recorder.ondataavailable = e => {
        chunks.push(e.data);
    };

    recorder.onstop = async () => {
        const audioBlob = new Blob(chunks, {
            type: 'audio/webm'
        });

        isRecording = false;
        updateRecordButton();

        await uploadForTranscription(audioBlob);

        mediaStream.getTracks().forEach(track => track.stop());
    };

    recorder.start();

    isRecording = true;
    updateRecordButton();
}

function stopRecording() {
    if (recorder && isRecording) {
        recorder.stop();
    }
}

function updateRecordButton() {
    recordBtn.textContent = isRecording
        ? 'Stop Recording'
        : 'Start Recording';
}

async function uploadForTranscription(audioBlob) {
    const formData = new FormData();
    formData.append('audio', audioBlob);

    const response = await fetch('/api/transcribe', {
        method: 'POST',
        body: formData
    });

    const data = await response.json();

    document.getElementById('voiceText').value = data.text;
}

updateRecordButton();