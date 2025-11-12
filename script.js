/* ======================================================
   AirLinker - WebRTC File Transfer
   Author: Arnav
   ====================================================== */

const SIGNALING_SERVER = 'wss://airlinker-signaling.onrender.com';
const CHUNK_SIZE = 16 * 1024; // 16 KB

// ===== UI Elements =====
const fileInput = document.getElementById('fileInput');
const selectBtn = document.getElementById('selectFileBtn');
const uploadArea = document.getElementById('uploadArea');
const qrSection = document.getElementById('qrSection');
const qrcodeDiv = document.getElementById('qrcode');
const statusText = document.getElementById('statusText');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const fileNameLabel = document.getElementById('fileName');
const fileSizeLabel = document.getElementById('fileSize');
// ===== Receiver UI Elements =====
const receiverProgress = document.getElementById('receiverProgress');
const receiverProgressFill = document.getElementById('receiverProgressFill');
const receiverProgressText = document.getElementById('receiverProgressText');
const receiverFileName = document.getElementById('receiverFileName');
const receiverFileSize = document.getElementById('receiverFileSize');
const receiverView = document.getElementById('receiverView');
const senderView = document.getElementById('senderView');
const connectingState = document.getElementById('connectingState');
const receiverComplete = document.getElementById('receiverComplete');


let ws, pc, dc, sessionId, fileToSend;
let receivedChunks = [];

// ===== Utilities =====
function log(msg) {
  console.log(msg);
  if (statusText) statusText.textContent = msg;
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

// ===== Peer + DataChannel =====
function createPeer() {
  pc = new RTCPeerConnection({
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302'] },
      { urls: ['stun:global.stun.twilio.com:3478'] }
    ]
  });

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      ws.send(JSON.stringify({
        type: 'ice-candidate',
        candidate: e.candidate,
        sessionId
      }));
    }
  };

  pc.ondatachannel = (e) => {
    dc = e.channel;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => log('Data channel open (receiver)');
    dc.onmessage = handleIncomingChunk;
  };
}


function createDataChannel() {
  dc = pc.createDataChannel('file');
  dc.binaryType = 'arraybuffer';
  dc.onopen = () => {
    log('Data channel open (sender)');
    sendFile();
  };
  dc.onmessage = handleIncomingChunk;
}

// ===== Signaling Connection =====
async function connectWS() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(SIGNALING_SERVER);
    ws.onopen = () => {
      log('Connected to signaling server');
      resolve();
    };
    ws.onerror = reject;
    ws.onmessage = async (e) => {
  try {
    // WebSocket data might arrive as Blob (binary), not JSON text
    const data = typeof e.data === 'string'
      ? e.data
      : await e.data.text();
    const msg = JSON.parse(data);
    handleSignal(msg);
  } catch (err) {
    console.warn('Non-JSON WebSocket message ignored:', e.data);
  }
};
  });
}

// ===== Sender Flow =====
async function startSender() {
  await connectWS();
  createPeer();
  createDataChannel();

  sessionId = Math.random().toString(36).slice(2, 9);
  ws.send(JSON.stringify({ type: 'create-session', sessionId }));

  const link = `https://airlinker.netlify.app/?id=${sessionId}`;
  renderQR(link);
  log('Session created, waiting for receiver...');
}

async function handleSignal(msg) {
  // Sender: receiver joined
  if (msg.type === 'session-joined') {
    log('Receiver connected, sending offer...');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp, sessionId }));
    return;
  }

  // Receiver: got offer (only receiver handles this)
  if (msg.type === 'offer' && msg.sdp) {
    if (dc) {
      // This means you're the sender, ignore your own offer
      console.warn('Ignoring duplicate offer on sender side');
      return;
    }

    log('Received offer from sender');
    await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({ type: 'answer', sdp: answer.sdp, sessionId }));
    log('Answer sent back to sender');
    return;
  }

  // Sender: got answer
  if (msg.type === 'answer' && msg.sdp) {
    // Avoid setting remote description twice
    if (pc.signalingState === 'stable') {
      console.warn('Ignoring duplicate answer (already stable)');
      return;
    }

    log('Received answer, establishing connection...');
    await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
    log('Peer connection established');
    return;
  }

  // ICE candidates
  if (msg.type === 'ice-candidate' && msg.candidate) {
    try {
      await pc.addIceCandidate(msg.candidate);
    } catch (err) {
      console.error('Error adding ICE candidate:', err);
    }
  }
}

// ===== Receiver Flow =====
async function startReceiver(id) {
  await connectWS();
  sessionId = id;
  createPeer();
  ws.send(JSON.stringify({ type: 'join-session', sessionId }));
  log('Joined session, waiting for offer...');
}

// ===== File Handling =====
async function sendFile() {
  if (!fileToSend || !dc) return;
  const file = fileToSend;
  log(`Sending ${file.name} (${formatBytes(file.size)})...`);
  const metadata = JSON.stringify({ name: file.name, size: file.size });
  dc.send(metadata);

  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  let offset = 0, chunkIndex = 0;

  while (offset < file.size) {
    const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();

    // Wait if the buffer is too full
    while (dc.bufferedAmount > 5 * CHUNK_SIZE) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    try {
      dc.send(chunk);
      offset += CHUNK_SIZE;
      chunkIndex++;
    } catch (err) {
      console.warn('Send failed, retrying chunk...', err);
      await new Promise(resolve => setTimeout(resolve, 200));
      continue;
    }

    // Update progress
    const pct = Math.floor((offset / file.size) * 100);
    progressFill.style.width = pct + '%';
    progressText.textContent = pct + '%';
  }

  log('File sent successfully!');
}

function handleIncomingChunk(e) {
  // --- Metadata (first message)
  if (typeof e.data === 'string') {
    const meta = JSON.parse(e.data);
    receivedChunks = [];
    receivedChunks.expectedName = meta.name;
    receivedChunks.expectedSize = meta.size;

    // Switch to receiver view
    if (senderView) senderView.classList.add('hidden');
    if (receiverView) receiverView.classList.remove('hidden');
    if (connectingState) connectingState.classList.add('hidden');
    if (receiverProgress) receiverProgress.classList.remove('hidden');
    if (receiverComplete) receiverComplete.classList.add('hidden');

    // Update receiver info
    receiverFileName.textContent = meta.name;
    receiverFileSize.textContent = formatBytes(meta.size);
    receiverProgressFill.style.width = '0%';
    receiverProgressText.textContent = '0%';

    log(`Receiving ${meta.name} (${formatBytes(meta.size)})...`);
    return;
  }

  // --- Binary data chunk
  receivedChunks.push(e.data);

  const receivedSize = receivedChunks.reduce((a, b) => a + b.byteLength, 0);
  const pct = Math.floor((receivedSize / receivedChunks.expectedSize) * 100);

  receiverProgressFill.style.width = pct + '%';
  receiverProgressText.textContent = `${pct}%`;

  // --- When done
  if (receivedSize >= receivedChunks.expectedSize) {
    const blob = new Blob(receivedChunks);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = receivedChunks.expectedName || 'download.bin';
    a.click();

    // Update UI
    receiverProgress.classList.add('hidden');
    receiverComplete.classList.remove('hidden');
    log('File received and saved.');
  }
}


function saveReceivedFile() {
  const blob = new Blob(receivedChunks);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = receivedChunks.expectedName || 'download.bin';
  a.click();
  log('File received and saved.');
}

// ===== QR / UI =====
function renderQR(link) {
  uploadArea.classList.add('hidden');
  qrSection.classList.remove('hidden');
  qrcodeDiv.innerHTML = '';
  new QRCode(qrcodeDiv, { text: link, width: 200, height: 200 });
}

selectBtn?.addEventListener('click', () => fileInput.click());
fileInput?.addEventListener('change', async () => {
  if (fileInput.files.length > 0) {
    fileToSend = fileInput.files[0];
    fileNameLabel.textContent = fileToSend.name;
    fileSizeLabel.textContent = formatBytes(fileToSend.size);
    await startSender();
  }
});

// ===== Auto-start Receiver if link contains ?id =====
const params = new URLSearchParams(window.location.search);
if (params.has('id')) {
  startReceiver(params.get('id'));
}
