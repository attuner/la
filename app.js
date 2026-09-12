/**
 * AirWave Client Logic
 * P2P WebRTC Live Audio Broadcasting Engine
 */

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

// Global State
const state = {
  userId: localStorage.getItem('airwave_userId') || 'peer_' + Math.random().toString(36).substring(2, 9),
  username: localStorage.getItem('airwave_username') || '',
  apiUrl: localStorage.getItem('airwave_apiUrl') || '',
  role: 'IDLE', // 'IDLE' | 'BROADCASTER' | 'LISTENER'
  activeRoomId: null,
  localStream: null,
  audioContext: null,
  analyser: null,
  animationFrame: null,
  isMuted: false,
  
  // Broadcaster State: Map of listenerId -> { pc: RTCPeerConnection, candidateQueue: [] }
  broadcasterPeers: new Map(),
  
  // Listener State
  listenerPeerConnection: null,
  listenerCandidateQueue: [],
  
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
  btnUnmuteAudio: document.getElementById('btnUnmuteAudio'),
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

/* ================= Signaling REST API ================= */
async function apiCall(method, body = null, params = null) {
  let url = state.apiUrl;
  if (params) {
    const query = new URLSearchParams(params).toString();
    url += (url.includes('?') ? '&' : '?') + query;
  }

  const options = { 
    method, 
    mode: 'cors',
    redirect: 'follow'
  };

  if (body && method === 'POST') {
    options.body = JSON.stringify(body);
    // Plain text content-type prevents CORS preflight triggers on GAS redirects
    options.headers = { 'Content-Type': 'text/plain;charset=utf-8' };
  }

  const res = await fetch(url, options);
  if (!res.ok) {
    throw new Error(`HTTP Error ${res.status}`);
  }
  return await res.json();
}

/* ================= Initialization ================= */
window.addEventListener('DOMContentLoaded', () => {
  localStorage.setItem('airwave_userId', state.userId);

  if (state.username && state.apiUrl) {
    initApp();
  } else {
    dom.usernameInput.value = state.username;
    dom.apiUrlInput.value = state.apiUrl;
  }

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

  // Manual unlock for strict browser autoplay policies
  dom.btnUnmuteAudio.addEventListener('click', () => {
    dom.remoteAudioPlayer.play().then(() => {
      dom.btnUnmuteAudio.classList.add('hidden');
    }).catch(err => console.error('Audio play failed:', err));
  });
});

async function handleOnboarding(e) {
  e.preventDefault();
  state.username = dom.usernameInput.value.trim();
  state.apiUrl = dom.apiUrlInput.value.trim();

  localStorage.setItem('airwave_username', state.username);
  localStorage.setItem('airwave_apiUrl', state.apiUrl);

  try {
    showToast('Connecting to Signaling endpoint...', 'info');
    const res = await apiCall('POST', {
      action: 'registerUser',
      userId: state.userId,
      username: state.username
    });
    if (res.success) {
      initApp();
    } else {
      showToast(`Connection rejected: ${res.error}`, 'error');
    }
  } catch (err) {
    showToast(`Failed to connect: ${err.message}`, 'error');
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
  state.pollingIntervals.directory = setInterval(refreshRooms, 4000);
  state.pollingIntervals.signals = setInterval(pollSignals, 1800);
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
    console.warn('Unable to enumerate audio devices:', err);
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

    state.broadcasterPeers.forEach(({ pc }) => {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
      if (sender) sender.replaceTrack(newTrack);
    });

    if (state.localStream) {
      state.localStream.getAudioTracks().forEach(t => t.stop());
    }
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
    state.localStream = await navigator.mediaDevices.getUserMedia({ 
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }, 
      video: false 
    });
    dom.audioInputLabel.textContent = state.localStream.getAudioTracks()[0].label;
    setupAudioAnalysis(state.localStream);
  } catch (err) {
    showToast(`Microphone access error: ${err.message}`, 'error');
    return;
  }

  const roomId = 'room_' + Math.random().toString(36).substring(2, 9);
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

    state.broadcastStartTime = Date.now();
    state.pollingIntervals.timer = setInterval(updateBroadcastTimer, 1000);

    showToast('Broadcasting live!', 'success');
  } catch (err) {
    showToast(`Failed to initialize room: ${err.message}`, 'error');
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
  showToast(state.isMuted ? 'Microphone muted' : 'Microphone live', 'info');
}

async function handleEndBroadcast() {
  if (!confirm('End this broadcast session?')) return;

  try {
    await apiCall('POST', { action: 'endBroadcast', roomId: state.activeRoomId });
  } catch (err) {
    console.error('Failed to notify room end:', err);
  }

  state.broadcasterPeers.forEach(({ pc }) => pc.close());
  state.broadcasterPeers.clear();

  if (state.localStream) {
    state.localStream.getTracks().forEach(t => t.stop());
    state.localStream = null;
  }
  if (state.animationFrame) cancelAnimationFrame(state.animationFrame);
  if (state.audioContext) state.audioContext.close();
  clearInterval(state.pollingIntervals.timer);

  state.role = 'IDLE';
  state.activeRoomId = null;

  dom.broadcasterConsole.classList.add('hidden');
  dom.btnOpenBroadcastModal.classList.remove('hidden');
  showToast('Broadcast session closed', 'info');
  refreshRooms();
}

/* ================= Listener Engine ================= */
async function joinStream(roomId, roomTitle) {
  if (state.role !== 'IDLE') {
    showToast('Please leave or stop your current stream first', 'error');
    return;
  }

  // Pre-unlock audio element inside this user gesture handler
  dom.remoteAudioPlayer.srcObject = null;
  dom.remoteAudioPlayer.play().catch(() => {}); // primes the audio subsystem

  state.role = 'LISTENER';
  state.activeRoomId = roomId;
  state.listenerCandidateQueue = [];

  dom.listenerDeck.classList.remove('hidden');
  dom.listenerRoomTitle.textContent = roomTitle;
  dom.listenerPeerStatus.textContent = 'Initializing connection...';
  dom.btnUnmuteAudio.classList.add('hidden');

  const pc = new RTCPeerConnection(RTC_CONFIG);
  state.listenerPeerConnection = pc;

  // Add a receive-only audio transceiver to generate a valid audio offer
  pc.addTransceiver('audio', { direction: 'recvonly' });

  pc.ontrack = (event) => {
    if (event.streams && event.streams[0]) {
      dom.remoteAudioPlayer.srcObject = event.streams[0];
    } else {
      const inboundStream = new MediaStream([event.track]);
      dom.remoteAudioPlayer.srcObject = inboundStream;
    }

    dom.listenerPeerStatus.textContent = 'Connected (P2P Audio Live)';
    showToast('Connected! Playing live audio', 'success');

    // Trigger audio play
    dom.remoteAudioPlayer.play().catch(e => {
      console.warn('Autoplay blocked:', e);
      dom.btnUnmuteAudio.classList.remove('hidden');
    });
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      apiCall('POST', {
        action: 'postSignal',
        fromPeer: state.userId,
        toPeer: roomId, // Broadcaster polls for messages targeted to roomId
        roomId: state.activeRoomId,
        type: 'ICE_CANDIDATE',
        payload: event.candidate
      }).catch(err => console.error('Failed to send ICE:', err));
    }
  };

  pc.onconnectionstatechange = () => {
    dom.listenerPeerStatus.textContent = `Status: ${pc.connectionState}`;
    if (pc.connectionState === 'connected') {
      showToast('P2P connection established', 'success');
    } else if (pc.connectionState === 'failed') {
      showToast('Peer connection failed. Refresh and retry.', 'error');
    }
  };

  // Create and post initial SDP Offer
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await apiCall('POST', {
      action: 'postSignal',
      fromPeer: state.userId,
      toPeer: roomId,
      roomId: roomId,
      type: 'SDP_OFFER',
      payload: offer
    });

    dom.listenerPeerStatus.textContent = 'Awaiting broadcaster response...';
  } catch (err) {
    showToast(`Handshake failed: ${err.message}`, 'error');
  }
}

function handleLeaveStream() {
  if (state.listenerPeerConnection) {
    state.listenerPeerConnection.close();
    state.listenerPeerConnection = null;
  }
  dom.remoteAudioPlayer.srcObject = null;
  dom.listenerDeck.classList.add('hidden');
  dom.btnUnmuteAudio.classList.add('hidden');
  state.role = 'IDLE';
  state.activeRoomId = null;
  state.listenerCandidateQueue = [];
  showToast('Disconnected from stream', 'info');
}

/* ================= Signaling & WebRTC Exchange ================= */
async function pollSignals() {
  if (state.role === 'IDLE') return;

  try {
    const targetPeerId = state.role === 'BROADCASTER' ? state.activeRoomId : state.userId;
    const res = await apiCall('GET', null, { action: 'getSignals', toPeer: targetPeerId });

    if (res.success && res.signals && res.signals.length > 0) {
      for (const signal of res.signals) {
        await processSignal(signal);
      }
    }
  } catch (err) {
    console.warn('Signaling poll interval warning:', err);
  }
}

async function processSignal(signal) {
  const { fromPeer, type, payload } = signal;

  // Broadcaster Logic
  if (state.role === 'BROADCASTER') {
    if (type === 'SDP_OFFER') {
      showToast(`Incoming listener: ${fromPeer}`, 'info');

      const pc = new RTCPeerConnection(RTC_CONFIG);
      const peerEntry = { pc, candidateQueue: [] };
      state.broadcasterPeers.set(fromPeer, peerEntry);

      // Add local audio tracks to the outgoing connection
      if (state.localStream) {
        state.localStream.getTracks().forEach(track => {
          pc.addTrack(track, state.localStream);
        });
      }

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          apiCall('POST', {
            action: 'postSignal',
            fromPeer: state.activeRoomId,
            toPeer: fromPeer,
            roomId: state.activeRoomId,
            type: 'ICE_CANDIDATE',
            payload: e.candidate
          }).catch(err => console.error('Broadcaster ICE error:', err));
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
          state.broadcasterPeers.delete(fromPeer);
          updateListenerCounter();
        }
      };

      // Set Remote Description (Listener's Offer)
      await pc.setRemoteDescription(new RTCSessionDescription(payload));

      // Flush buffered ICE candidates
      while (peerEntry.candidateQueue.length > 0) {
        const candidate = peerEntry.candidateQueue.shift();
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.warn('Failed to add queued candidate:', e);
        }
      }

      // Generate Answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      await apiCall('POST', {
        action: 'postSignal',
        fromPeer: state.activeRoomId,
        toPeer: fromPeer,
        roomId: state.activeRoomId,
        type: 'SDP_ANSWER',
        payload: answer
      });

      updateListenerCounter();
    } 
    else if (type === 'ICE_CANDIDATE') {
      const peerEntry = state.broadcasterPeers.get(fromPeer);
      if (peerEntry) {
        if (peerEntry.pc.remoteDescription && peerEntry.pc.remoteDescription.type) {
          try {
            await peerEntry.pc.addIceCandidate(new RTCIceCandidate(payload));
          } catch (e) {
            console.warn('Error adding ICE candidate on broadcaster:', e);
          }
        } else {
          // Buffer candidate until remote description is settled
          peerEntry.candidateQueue.push(payload);
        }
      }
    }
  }

  // Listener Logic
  if (state.role === 'LISTENER') {
    const pc = state.listenerPeerConnection;
    if (!pc) return;

    if (type === 'SDP_ANSWER') {
      await pc.setRemoteDescription(new RTCSessionDescription(payload));
      
      // Flush buffered listener ICE candidates
      while (state.listenerCandidateQueue.length > 0) {
        const cand = state.listenerCandidateQueue.shift();
        try {
          await pc.addIceCandidate(new RTCIceCandidate(cand));
        } catch (e) {
          console.warn('Failed to add queued candidate on listener:', e);
        }
      }
    } 
    else if (type === 'ICE_CANDIDATE') {
      if (pc.remoteDescription && pc.remoteDescription.type) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(payload));
        } catch (e) {
          console.warn('Error adding ICE candidate on listener:', e);
        }
      } else {
        // Buffer candidate if remote answer hasn't arrived yet
        state.listenerCandidateQueue.push(payload);
      }
    }
  }
}

function updateListenerCounter() {
  dom.listenerCount.textContent = state.broadcasterPeers.size;
}

/* ================= Stream Discovery ================= */
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
        // Don't show current broadcaster their own room in the directory
        if (state.role === 'BROADCASTER' && room.roomId === state.activeRoomId) return;

        const card = document.createElement('div');
        card.className = 'bg-slate-900 border border-slate-800 hover:border-indigo-500/50 rounded-2xl p-5 transition flex flex-col justify-between space-y-4';
        card.innerHTML = `
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-xs px-2.5 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 font-medium">${escapeHtml(room.category || 'General')}</span>
              <span class="text-xs text-slate-500"><i class="fa-solid fa-wifi text-emerald-400 mr-1"></i> Live</span>
            </div>
            <h4 class="text-base font-bold text-white tracking-tight">${escapeHtml(room.title)}</h4>
            <p class="text-xs text-slate-400 truncate">Broadcaster ID: ${escapeHtml(room.broadcasterId)}</p>
          </div>
          <button data-room-id="${escapeHtml(room.roomId)}" data-room-title="${escapeHtml(room.title)}" class="btn-tune-in w-full bg-slate-800 hover:bg-indigo-600 text-white font-medium py-2 rounded-xl text-sm transition flex items-center justify-center space-x-2">
            <i class="fa-solid fa-headphones"></i>
            <span>Tune In</span>
          </button>
        `;
        dom.roomsGrid.appendChild(card);
      });

      // Bind listener events cleanly using dataset parameters
      document.querySelectorAll('.btn-tune-in').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const target = e.currentTarget;
          const roomId = target.getAttribute('data-room-id');
          const title = target.getAttribute('data-room-title');
          joinStream(roomId, title);
        });
      });
    }
  } catch (err) {
    console.warn('Directory refresh failed:', err);
  }
}

function escapeHtml(string) {
  const div = document.createElement('div');
  div.textContent = string;
  return div.innerHTML;
}