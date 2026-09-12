/**
 * AirWave Client Logic
 * P2P WebRTC Audio Mesh + Polling Google Apps Script Engine
 */

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// Global State
const state = {
  userId: localStorage.getItem('airwave_userId') || 'peer_' + Math.random().toString(36).substr(2, 9),
  username: localStorage.getItem('airwave_username') || '',
  apiUrl: localStorage.getItem('airwave_apiUrl') || '',
  role: 'IDLE', // 'IDLE' | 'BROADCASTER' | 'LISTENER'
  activeRoomId: null,
  localStream: null,
  audioContext: null,
  analyser: null,
  animationFrame: null,
  isMuted: false,
  // Broadcaster State: Map of listenerId -> RTCPeerConnection
  broadcasterPeers: new Map(),
  // Listener State: Single RTCPeerConnection to Broadcaster
  listenerPeerConnection: null,
  pollingIntervals: {
    signals: null,
    directory: null,
    timer: null
  },
  broadcastStartTime: null
};

// DOM References
const dom = {
  onboardingSection: document.getElementById('onboardingSection'),
  appWorkspace: document.getElementById('appWorkspace'),
  joinForm: document.getElementById('joinForm'),
  usernameInput: document.getElementById('usernameInput'),
  apiUrlInput: document.getElementById('apiUrlInput'),
  userBadge: document.getElementById('userBadge'),
  displayUsername: document.getElementById('displayUsername'),
  btnSettings: document.getElementById('btnSettings'),
  // Broadcaster UI
  broadcasterConsole: document.getElementById('broadcasterConsole'),
  btnOpenBroadcastModal: document.getElementById('btnOpenBroadcastModal'),
  broadcastModal: document.getElementById('broadcastModal'),
  btnCloseModal: document.getElementById('btnCloseModal'),
  startBroadcastForm: document.getElementById('startBroadcastForm'),
  streamTitleInput: document.getElementById('streamTitleInput'),
  streamCategoryInput: document.getElementById('streamCategoryInput'),
  broadcastTitleDisplay: document.getElementById('broadcastTitleDisplay'),
  broadcastCategoryBadge: document.getElementById('broadcastCategoryBadge'),
  listenerCount: document.getElementById('listenerCount'),
  broadcastTimer: document.getElementById('broadcastTimer'),
  btnToggleMute: document.getElementById('btnToggleMute'),
  btnEndBroadcast: document.getElementById('btnEndBroadcast'),
  audioSourceSelect: document.getElementById('audioSourceSelect'),
  visualizerCanvas: document.getElementById('visualizerCanvas'),
  audioInputLabel: document.getElementById('audioInputLabel'),
  // Listener UI
  listenerDeck: document.getElementById('listenerDeck'),
  listenerRoomTitle: document.getElementById('listenerRoomTitle'),
  listenerPeerStatus: document.getElementById('listenerPeerStatus'),
  remoteAudioPlayer: document.getElementById('remoteAudioPlayer'),
  volumeSlider: document.getElementById('volumeSlider'),
  btnLeaveStream: document.getElementById('btnLeaveStream'),
  // Directory UI
  roomsGrid: document.getElementById('roomsGrid'),
  noRoomsPlaceholder: document.getElementById('noRoomsPlaceholder'),
  btnManualRefresh: document.getElementById('btnManualRefresh'),
  toastContainer: document.getElementById('toastContainer')
};

/* ================= Toast Notification System ================= */
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  const colors = {
    info: 'bg-slate-800 text-indigo-400 border-indigo-500/30',
    success: 'bg-slate-800 text-emerald-400 border-emerald-500/30',
    error: 'bg-slate-800 text-rose-400 border-rose-500/30'
  };

  toast.className = `border px-4 py-3 rounded-xl shadow-xl flex items-center space-x-3 text-sm transition-all duration-300 transform translate-y-2 opacity-0 ${colors[type] || colors.info}`;
  toast.innerHTML = `<i class="fa-solid ${type === 'success' ? 'fa-check' : type === 'error' ? 'fa-triangle-exclamation' : 'fa-circle-info'}"></i><span>${message}</span>`;
  
  dom.toastContainer.appendChild(toast);
  requestAnimationFrame(() => toast.classList.remove('translate-y-2', 'opacity-0'));

  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

/* ================= Signaling REST API Wrapper ================= */
async function apiCall(method, body = null, params = null) {
  let url = state.apiUrl;
  if (params) {
    const query = new URLSearchParams(params).toString();
    url += `?${query}`;
  }

  const options = { method, mode: 'cors' };
  if (body && method === 'POST') {
    options.body = JSON.stringify(body);
    options.headers = { 'Content-Type': 'text/plain;charset=utf-8' }; // bypass GAS CORS preflight issues
  }

  const res = await fetch(url, options);
  return await res.json();
}

/* ================= Initialization & Lifecycle ================= */
window.addEventListener('DOMContentLoaded', () => {
  localStorage.setItem('airwave_userId', state.userId);

  if (state.username && state.apiUrl) {
    initApp();
  } else {
    dom.usernameInput.value = state.username;
    dom.apiUrlInput.value = state.apiUrl;
  }

  // Event Listeners
  dom.joinForm.addEventListener('submit', handleOnboarding);
  dom.btnSettings.addEventListener('click', resetAuth);
  dom.btnOpenBroadcastModal.addEventListener('click', () => dom.broadcastModal.classList.remove('hidden'));
  dom.btnCloseModal.addEventListener('click', () => dom.broadcastModal.classList.add('hidden'));
  dom.startBroadcastForm.addEventListener('submit', handleStartBroadcast);
  dom.btnToggleMute.addEventListener('click', toggleMute);
  dom.btnEndBroadcast.addEventListener('click', handleEndBroadcast);
  dom.btnLeaveStream.addEventListener('click', handleLeaveStream);
  dom.btnManualRefresh.addEventListener('click', refreshRooms);
  dom.volumeSlider.addEventListener('input', (e) => {
    dom.remoteAudioPlayer.volume = parseFloat(e.target.value);
  });
  dom.audioSourceSelect.addEventListener('change', changeAudioDevice);
});

async function handleOnboarding(e) {
  e.preventDefault();
  state.username = dom.usernameInput.value.trim();
  state.apiUrl = dom.apiUrlInput.value.trim();

  localStorage.setItem('airwave_username', state.username);
  localStorage.setItem('airwave_apiUrl', state.apiUrl);

  try {
    showToast('Connecting to Signaling...', 'info');
    await apiCall('POST', {
      action: 'registerUser',
      userId: state.userId,
      username: state.username
    });
    initApp();
  } catch (err) {
    showToast(`Signaling connection failed: ${err.message}`, 'error');
  }
}

function resetAuth() {
  if (confirm('Reconfigure username and API endpoint?')) {
    clearInterval(state.pollingIntervals.signals);
    clearInterval(state.pollingIntervals.directory);
    localStorage.removeItem('airwave_apiUrl');
    location.reload();
  }
}

function initApp() {
  dom.onboardingSection.classList.add('hidden');
  dom.appWorkspace.classList.remove('hidden');
  dom.userBadge.classList.remove('hidden');
  dom.userBadge.classList.add('flex');
  dom.displayUsername.textContent = state.username;

  refreshRooms();
  state.pollingIntervals.directory = setInterval(refreshRooms, 5000);
  state.pollingIntervals.signals = setInterval(pollSignals, 2500);
  populateAudioInputs();
}

/* ================= Audio Hardware & Visualizer ================= */
async function populateAudioInputs() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput');
    dom.audioSourceSelect.innerHTML = '';
    audioInputs.forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.text = device.label || `Microphone ${index + 1}`;
      dom.audioSourceSelect.appendChild(option);
    });
  } catch (err) {
    console.warn('Unable to list audio devices:', err);
  }
}

async function changeAudioDevice() {
  if (state.role !== 'BROADCASTER') return;
  const deviceId = dom.audioSourceSelect.value;
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId } }
    });
    const newTrack = newStream.getAudioTracks()[0];

    // Replace audio track on all connected peers
    state.broadcasterPeers.forEach(({ pc }) => {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
      if (sender) sender.replaceTrack(newTrack);
    });

    state.localStream.getAudioTracks().forEach(t => t.stop());
    state.localStream = newStream;
    dom.audioInputLabel.textContent = newTrack.label;
    setupAudioAnalysis(newStream);
    showToast('Switched audio input device', 'info');
  } catch (err) {
    showToast(`Device switch failed: ${err.message}`, 'error');
  }
}

function setupAudioAnalysis(stream) {
  if (state.audioContext) state.audioContext.close();
  
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  state.audioContext = new AudioContext();
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = 64;

  const source = state.audioContext.createMediaStreamSource(stream);
  source.connect(state.analyser);

  renderVisualizer();
}

function renderVisualizer() {
  const canvas = dom.visualizerCanvas;
  const ctx = canvas.getContext('2d');
  const bufferLength = state.analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function draw() {
    state.animationFrame = requestAnimationFrame(draw);
    state.analyser.getByteFrequencyData(dataArray);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const barWidth = (canvas.width / bufferLength) * 2;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const barHeight = (dataArray[i] / 255) * canvas.height;
      ctx.fillStyle = `rgb(${99 + barHeight * 0.5}, 102, 241)`;
      ctx.fillRect(x, canvas.height - barHeight, barWidth - 1, barHeight);
      x += barWidth;
    }
  }
  draw();
}

/* ================= Broadcaster Engine ================= */
async function handleStartBroadcast(e) {
  e.preventDefault();
  const title = dom.streamTitleInput.value.trim();
  const category = dom.streamCategoryInput.value;

  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    dom.audioInputLabel.textContent = state.localStream.getAudioTracks()[0].label;
    setupAudioAnalysis(state.localStream);
  } catch (err) {
    showToast(`Microphone access denied: ${err.message}`, 'error');
    return;
  }

  const roomId = 'room_' + Math.random().toString(36).substr(2, 9);
  state.activeRoomId = roomId;
  state.role = 'BROADCASTER';

  try {
    await apiCall('POST', {
      action: 'createBroadcast',
      roomId,
      broadcasterId: state.userId,
      title,
      category
    });

    dom.broadcastModal.classList.add('hidden');
    dom.broadcasterConsole.classList.remove('hidden');
    dom.btnOpenBroadcastModal.classList.add('hidden');
    dom.broadcastTitleDisplay.textContent = title;
    dom.broadcastCategoryBadge.textContent = category;

    // Stream duration counter
    state.broadcastStartTime = Date.now();
    state.pollingIntervals.timer = setInterval(updateBroadcastTimer, 1000);

    showToast('You are now live!', 'success');
  } catch (err) {
    showToast(`Failed to register room: ${err.message}`, 'error');
  }
}

function updateBroadcastTimer() {
  const elapsedSeconds = Math.floor((Date.now() - state.broadcastStartTime) / 1000);
  const minutes = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
  const seconds = String(elapsedSeconds % 60).padStart(2, '0');
  dom.broadcastTimer.textContent = `${minutes}:${seconds}`;
}

function toggleMute() {
  if (!state.localStream) return;
  state.isMuted = !state.isMuted;
  state.localStream.getAudioTracks()[0].enabled = !state.isMuted;
  dom.btnToggleMute.classList.toggle('bg-red-600', state.isMuted);
  dom.btnToggleMute.innerHTML = state.isMuted ? '<i class="fa-solid fa-microphone-slash"></i>' : '<i class="fa-solid fa-microphone"></i>';
  showToast(state.isMuted ? 'Microphone muted' : 'Microphone unmuted', 'info');
}

async function handleEndBroadcast() {
  if (!confirm('Are you sure you want to end this live broadcast?')) return;

  try {
    await apiCall('POST', { action: 'endBroadcast', roomId: state.activeRoomId });
  } catch (err) {
    console.error('Failed to notify room end:', err);
  }

  // Cleanup Broadcaster connections
  state.broadcasterPeers.forEach(({ pc }) => pc.close());
  state.broadcasterPeers.clear();

  if (state.localStream) {
    state.localStream.getTracks().forEach(t => t.stop());
  }
  if (state.animationFrame) cancelAnimationFrame(state.animationFrame);
  if (state.audioContext) state.audioContext.close();
  clearInterval(state.pollingIntervals.timer);

  state.role = 'IDLE';
  state.activeRoomId = null;

  dom.broadcasterConsole.classList.add('hidden');
  dom.btnOpenBroadcastModal.classList.remove('hidden');
  showToast('Live stream ended', 'info');
  refreshRooms();
}

/* ================= Listener Engine ================= */
async function joinStream(roomId, roomTitle) {
  if (state.role !== 'IDLE') {
    showToast('Leave or end your active session before joining another', 'error');
    return;
  }

  state.role = 'LISTENER';
  state.activeRoomId = roomId;

  dom.listenerDeck.classList.remove('hidden');
  dom.listenerRoomTitle.textContent = roomTitle;
  dom.listenerPeerStatus.textContent = 'Contacting Broadcaster...';

  // Instantiate Peer Connection
  const pc = new RTCPeerConnection(RTC_CONFIG);
  state.listenerPeerConnection = pc;

  pc.ontrack = (event) => {
    dom.remoteAudioPlayer.srcObject = event.streams[0];
    dom.listenerPeerStatus.textContent = 'Connected (P2P Mesh)';
    showToast('Direct peer audio stream active', 'success');
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      apiCall('POST', {
        action: 'postSignal',
        fromPeer: state.userId,
        toPeer: roomId, // Signals targeted to roomId are picked up by broadcaster
        roomId: state.activeRoomId,
        type: 'ICE_CANDIDATE',
        payload: event.candidate
      });
    }
  };

  pc.onconnectionstatechange = () => {
    dom.listenerPeerStatus.textContent = `Status: ${pc.connectionState}`;
  };

  // Dispatch Join Request to broadcaster
  apiCall('POST', {
    action: 'postSignal',
    fromPeer: state.userId,
    toPeer: roomId,
    roomId: roomId,
    type: 'JOIN_REQUEST',
    payload: { username: state.username }
  });
}

function handleLeaveStream() {
  if (state.listenerPeerConnection) {
    state.listenerPeerConnection.close();
    state.listenerPeerConnection = null;
  }
  dom.remoteAudioPlayer.srcObject = null;
  dom.listenerDeck.classList.add('hidden');
  state.role = 'IDLE';
  state.activeRoomId = null;
  showToast('Left audio stream', 'info');
}

/* ================= Signaling & WebRTC Mesh Negotiation ================= */
async function pollSignals() {
  if (state.role === 'IDLE') return;

  try {
    const targetPeerId = state.role === 'BROADCASTER' ? state.activeRoomId : state.userId;
    const res = await apiCall('GET', null, { action: 'getSignals', toPeer: targetPeerId });

    if (res.success && res.signals.length > 0) {
      for (const signal of res.signals) {
        await processSignal(signal);
      }
    }
  } catch (err) {
    console.warn('Signaling poll failed:', err);
  }
}

async function processSignal(signal) {
  const { fromPeer, type, payload } = signal;

  // Broadcaster Logic
  if (state.role === 'BROADCASTER') {
    if (type === 'JOIN_REQUEST') {
      showToast(`User joining: ${payload.username || fromPeer}`, 'info');

      const pc = new RTCPeerConnection(RTC_CONFIG);
      state.broadcasterPeers.set(fromPeer, { pc, username: payload.username });

      // Add local audio tracks
      state.localStream.getTracks().forEach(track => pc.addTrack(track, state.localStream));

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          apiCall('POST', {
            action: 'postSignal',
            fromPeer: state.activeRoomId,
            toPeer: fromPeer,
            roomId: state.activeRoomId,
            type: 'ICE_CANDIDATE',
            payload: e.candidate
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
          state.broadcasterPeers.delete(fromPeer);
          updateListenerCounter();
        }
      };

      // Create WebRTC Offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      await apiCall('POST', {
        action: 'postSignal',
        fromPeer: state.activeRoomId,
        toPeer: fromPeer,
        roomId: state.activeRoomId,
        type: 'SDP_OFFER',
        payload: offer
      });

      updateListenerCounter();
    } else if (type === 'SDP_ANSWER') {
      const peerData = state.broadcasterPeers.get(fromPeer);
      if (peerData) {
        await peerData.pc.setRemoteDescription(new RTCSessionDescription(payload));
      }
    } else if (type === 'ICE_CANDIDATE') {
      const peerData = state.broadcasterPeers.get(fromPeer);
      if (peerData && payload) {
        await peerData.pc.addIceCandidate(new RTCIceCandidate(payload));
      }
    }
  }

  // Listener Logic
  if (state.role === 'LISTENER') {
    const pc = state.listenerPeerConnection;
    if (!pc) return;

    if (type === 'SDP_OFFER') {
      await pc.setRemoteDescription(new RTCSessionDescription(payload));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      await apiCall('POST', {
        action: 'postSignal',
        fromPeer: state.userId,
        toPeer: state.activeRoomId,
        roomId: state.activeRoomId,
        type: 'SDP_ANSWER',
        payload: answer
      });
    } else if (type === 'ICE_CANDIDATE') {
      if (payload) {
        await pc.addIceCandidate(new RTCIceCandidate(payload));
      }
    }
  }
}

function updateListenerCounter() {
  dom.listenerCount.textContent = state.broadcasterPeers.size;
}

/* ================= Stream Discovery / Directory ================= */
async function refreshRooms() {
  try {
    const res = await apiCall('GET', null, { action: 'getActiveBroadcasts' });
    if (!res.success) return;

    const rooms = res.rooms || [];
    dom.roomsGrid.innerHTML = '';

    if (rooms.length === 0) {
      dom.noRoomsPlaceholder.classList.remove('hidden');
    } else {
      dom.noRoomsPlaceholder.classList.add('hidden');
      rooms.forEach(room => {
        const card = document.createElement('div');
        card.className = 'bg-slate-900 border border-slate-800 hover:border-indigo-500/50 rounded-2xl p-5 transition flex flex-col justify-between space-y-4';
        card.innerHTML = `
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-xs px-2.5 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 font-medium">${room.category || 'General'}</span>
              <span class="text-xs text-slate-500"><i class="fa-solid fa-wifi text-emerald-400 mr-1"></i> Live</span>
            </div>
            <h4 class="text-base font-bold text-white tracking-tight">${room.title}</h4>
            <p class="text-xs text-slate-400 truncate">Broadcaster ID: ${room.broadcasterId}</p>
          </div>
          <button onclick="joinStream('${room.roomId}', '${encodeURIComponent(room.title)}')" class="w-full bg-slate-800 hover:bg-indigo-600 text-white font-medium py-2 rounded-xl text-sm transition flex items-center justify-center space-x-2">
            <i class="fa-solid fa-headphones"></i>
            <span>Tune In</span>
          </button>
        `;
        dom.roomsGrid.appendChild(card);
      });
    }
  } catch (err) {
    console.warn('Directory refresh failed:', err);
  }
}

// Global binding for DOM inline onclick
window.joinStream = (roomId, encodedTitle) => {
  joinStream(roomId, decodeURIComponent(encodedTitle));
};