const voiceBtn = document.getElementById('voiceBtn');
const voiceModal = document.getElementById('voiceModal');
const closeVoiceBtn = document.getElementById('closeVoiceBtn');

voiceBtn.onclick = () => {
    voiceModal.classList.remove('hidden');
};

closeVoiceBtn.onclick = () => {
    voiceModal.classList.add('hidden');
};

let recorder;
let chunks = [];

document.getElementById('recordBtn').onclick = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: true
    });

    recorder = new MediaRecorder(stream);

    chunks = [];

    recorder.ondataavailable = e => chunks.push(e.data);

    recorder.onstop = async () => {
        const audioBlob = new Blob(chunks, {
            type: 'audio/webm'
        });

        await uploadForTranscription(audioBlob);
    };

    recorder.start();

    setTimeout(() => recorder.stop(), 10000);
};

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