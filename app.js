const qs = new URLSearchParams(location.search);
const roomId = qs.get('room');
const userId = qs.get('uid');
const userName = qs.get('name') || 'Guest';

if (!roomId || !userId) {
  alert('Missing room/user details. Go back to home page.');
  location.href = 'index.html';
}

const state = {
  localStream: null,
  screenTrack: null,
  peers: new Map(),
  users: new Map(),
  makingOfferTo: new Set(),
  polls: { offers: 0, answers: 0, ice: 0, chat: 0, commands: 0 },
  chatOpen: false,
  micEnabled: true,
  camEnabled: true,
  isHost: false,
  handRaised: false,
  recorder: null,
  recordedChunks: []
};

const els = {
  roomLabel: document.getElementById('roomLabel'),
  status: document.getElementById('connectionStatus'),
  videoGrid: document.getElementById('videoGrid'),
  chatPanel: document.getElementById('chatPanel'),
  chatMessages: document.getElementById('chatMessages'),
  chatInput: document.getElementById('chatInput'),
  toggleChatBtn: document.getElementById('toggleChatBtn'),
  toggleMicBtn: document.getElementById('toggleMicBtn'),
  toggleCamBtn: document.getElementById('toggleCamBtn'),
  shareScreenBtn: document.getElementById('shareScreenBtn'),
  raiseHandBtn: document.getElementById('raiseHandBtn'),
  recordBtn: document.getElementById('recordBtn')
};

const iceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls: 'turn:YOUR_EXPRESSTURN_SERVER:3478',
    username: 'YOUR_USERNAME',
    credential: 'YOUR_PASSWORD'
  },
  {
    urls: 'turn:YOUR_EXPRESSTURN_SERVER:443?transport=tcp',
    username: 'YOUR_USERNAME',
    credential: 'YOUR_PASSWORD'
  }
];

els.roomLabel.textContent = `Room: ${roomId}`;

function api(action, payload = {}) {
  const form = new FormData();
  form.append('action', action);
  Object.entries(payload).forEach(([k, v]) => {
    form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  });
  return fetch('api.php', { method: 'POST', body: form }).then((r) => r.json());
}

function setStatus(text) {
  els.status.textContent = text;
}

function upsertVideoTile(id, name, stream, opts = {}) {
  let tile = document.getElementById(`tile-${id}`);
  if (!tile) {
    tile = document.createElement('article');
    tile.id = `tile-${id}`;
    tile.className = 'video-tile';

    const vid = document.createElement('video');
    vid.autoplay = true;
    vid.playsInline = true;
    if (opts.muted) vid.muted = true;
    tile.appendChild(vid);

    const meta = document.createElement('div');
    meta.className = 'tile-meta';
    meta.innerHTML = `<span class="name"></span><span class="role"></span><span class="hand"></span><span class="host-actions"></span>`;
    tile.appendChild(meta);
    els.videoGrid.appendChild(tile);
  }

  const video = tile.querySelector('video');
  if (stream && video.srcObject !== stream) video.srcObject = stream;

  tile.querySelector('.name').textContent = name;
  const user = state.users.get(id);
  tile.querySelector('.role').innerHTML = user?.is_host ? '<span class="host">(Host)</span>' : '';
  tile.querySelector('.hand').innerHTML = user?.hand_raised ? '<span class="hand">✋</span>' : '';

  const actionsWrap = tile.querySelector('.host-actions');
  actionsWrap.innerHTML = '';
  if (state.isHost && id !== userId) {
    const muteBtn = document.createElement('button');
    muteBtn.textContent = 'Mute';
    muteBtn.style.padding = '0.1rem 0.35rem';
    muteBtn.style.fontSize = '0.7rem';
    muteBtn.onclick = () => sendCommand('mute_user', { target: id });

    const kickBtn = document.createElement('button');
    kickBtn.textContent = 'Remove';
    kickBtn.style.padding = '0.1rem 0.35rem';
    kickBtn.style.fontSize = '0.7rem';
    kickBtn.onclick = () => sendCommand('remove_user', { target: id });

    actionsWrap.append(muteBtn, kickBtn);
  }
}

function removeTile(id) {
  const tile = document.getElementById(`tile-${id}`);
  if (tile) tile.remove();
}

function appendChat(msg) {
  const row = document.createElement('div');
  row.className = 'msg';
  const at = new Date(msg.ts * 1000).toLocaleTimeString();
  row.innerHTML = `<small>${msg.name} • ${at}</small><div>${msg.text}</div>`;
  els.chatMessages.appendChild(row);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function getPeer(targetUserId) {
  if (state.peers.has(targetUserId)) return state.peers.get(targetUserId);
  const pc = new RTCPeerConnection({ iceServers });

  state.localStream.getTracks().forEach((track) => pc.addTrack(track, state.localStream));

  const remoteStream = new MediaStream();
  pc.ontrack = (evt) => {
    evt.streams[0].getTracks().forEach((t) => remoteStream.addTrack(t));
    const user = state.users.get(targetUserId);
    upsertVideoTile(targetUserId, user?.name || 'Participant', remoteStream);
  };

  pc.onicecandidate = (evt) => {
    if (evt.candidate) {
      api('send_ice', {
        room_id: roomId,
        user_id: userId,
        target_id: targetUserId,
        candidate: evt.candidate
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      closePeer(targetUserId);
    }
  };

  state.peers.set(targetUserId, { pc, remoteStream, pendingIce: [] });
  return state.peers.get(targetUserId);
}

function closePeer(targetId) {
  const rec = state.peers.get(targetId);
  if (!rec) return;
  rec.pc.close();
  state.peers.delete(targetId);
  removeTile(targetId);
}

async function ensureOffer(targetId) {
  if (state.makingOfferTo.has(targetId)) return;
  state.makingOfferTo.add(targetId);
  const { pc } = getPeer(targetId);
  try {
    // Only one side starts negotiation (lower id wins) to avoid collisions.
    if (userId > targetId) return;
    if (pc.signalingState !== 'stable') return;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await api('send_offer', {
      room_id: roomId,
      user_id: userId,
      target_id: targetId,
      sdp: offer
    });
  } finally {
    state.makingOfferTo.delete(targetId);
  }
}

async function handleOffers(items) {
  for (const item of items) {
    if (item.from === userId) continue;
    const rec = getPeer(item.from);
    const { pc } = rec;
    const offerCollision = pc.signalingState !== 'stable';
    const polite = userId > item.from;
    if (offerCollision && !polite) {
      continue;
    }
    if (offerCollision && polite) {
      try {
        await pc.setLocalDescription({ type: 'rollback' });
      } catch (e) {
        console.warn('Rollback failed', e);
      }
    }
    await pc.setRemoteDescription(item.sdp);
    while (rec.pendingIce.length) {
      const cand = rec.pendingIce.shift();
      try {
        await pc.addIceCandidate(cand);
      } catch (e) {
        console.warn('Buffered ICE add failed', e);
      }
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await api('send_answer', {
      room_id: roomId,
      user_id: userId,
      target_id: item.from,
      sdp: answer
    });
  }
}

async function handleAnswers(items) {
  for (const item of items) {
    const rec = state.peers.get(item.from);
    if (!rec) continue;
    if (!rec.pc.currentRemoteDescription) {
      await rec.pc.setRemoteDescription(item.sdp);
      while (rec.pendingIce.length) {
        const cand = rec.pendingIce.shift();
        try {
          await rec.pc.addIceCandidate(cand);
        } catch (e) {
          console.warn('Buffered ICE add failed', e);
        }
      }
    }
  }
}

async function handleIce(items) {
  for (const item of items) {
    const rec = state.peers.get(item.from) || getPeer(item.from);
    if (!rec.pc.remoteDescription) {
      rec.pendingIce.push(item.candidate);
      continue;
    }
    try {
      await rec.pc.addIceCandidate(item.candidate);
    } catch (e) {
      rec.pendingIce.push(item.candidate);
    }
  }
}

function syncUsers(users = []) {
  const next = new Map();
  for (const u of users) next.set(u.user_id, u);

  for (const [id] of state.users.entries()) {
    if (!next.has(id)) closePeer(id);
  }

  state.users = next;
  const me = state.users.get(userId);
  state.isHost = Boolean(me?.is_host);

  for (const [id, user] of state.users.entries()) {
    if (id === userId) continue;
    const peerExists = state.peers.has(id);
    // Deterministic caller: lower user ID initiates offers.
    if (!peerExists && userId < id) {
      ensureOffer(id).catch(console.error);
    }
  }

  // update tile metadata
  for (const [id] of state.users.entries()) {
    const tile = document.getElementById(`tile-${id}`);
    if (tile) upsertVideoTile(id, state.users.get(id).name, tile.querySelector('video').srcObject);
  }

  els.recordBtn.style.display = state.isHost ? 'inline-block' : 'none';
}

async function pollLoop() {
  try {
    await api('heartbeat', { room_id: roomId, user_id: userId });

    const [usersRes, offersRes, answersRes, iceRes, chatRes, cmdRes] = await Promise.all([
      api('get_users', { room_id: roomId }),
      api('get_offers', { room_id: roomId, user_id: userId, since_id: state.polls.offers }),
      api('get_answers', { room_id: roomId, user_id: userId, since_id: state.polls.answers }),
      api('get_ice', { room_id: roomId, user_id: userId, since_id: state.polls.ice }),
      api('get_chat', { room_id: roomId, since_id: state.polls.chat }),
      api('get_commands', { room_id: roomId, user_id: userId, since_id: state.polls.commands })
    ]);

    if (usersRes.ok) syncUsers(usersRes.users);

    if (offersRes.ok) {
      state.polls.offers = offersRes.last_id || state.polls.offers;
      await handleOffers(offersRes.items || []);
    }

    if (answersRes.ok) {
      state.polls.answers = answersRes.last_id || state.polls.answers;
      await handleAnswers(answersRes.items || []);
    }

    if (iceRes.ok) {
      state.polls.ice = iceRes.last_id || state.polls.ice;
      await handleIce(iceRes.items || []);
    }

    if (chatRes.ok) {
      for (const msg of chatRes.items || []) appendChat(msg);
      state.polls.chat = chatRes.last_id || state.polls.chat;
    }

    if (cmdRes.ok) {
      for (const cmd of cmdRes.items || []) {
        if (cmd.type === 'mute_user') {
          const audioTrack = state.localStream?.getAudioTracks?.()[0];
          if (audioTrack) {
            audioTrack.enabled = false;
            state.micEnabled = false;
            els.toggleMicBtn.textContent = 'Unmute';
          }
        }
        if (cmd.type === 'remove_user') {
          alert('Host removed you from this meeting.');
          leaveMeeting();
        }
      }
      state.polls.commands = cmdRes.last_id || state.polls.commands;
    }

    setStatus('Connected');
  } catch (e) {
    console.error(e);
    setStatus('Reconnecting...');
  }
}

async function sendCommand(type, payload = {}) {
  await api('send_command', { room_id: roomId, user_id: userId, type, payload });
}

async function initMedia() {
  state.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  upsertVideoTile(userId, `${userName} (You)`, state.localStream, { muted: true });
}

function swapVideoTrack(track) {
  for (const rec of state.peers.values()) {
    const sender = rec.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) sender.replaceTrack(track);
  }
}

async function startScreenShare() {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  const track = stream.getVideoTracks()[0];
  track.onended = stopScreenShare;

  const oldTrack = state.localStream.getVideoTracks()[0];
  state.localStream.removeTrack(oldTrack);
  oldTrack.stop();
  state.localStream.addTrack(track);
  state.screenTrack = track;
  swapVideoTrack(track);
  upsertVideoTile(userId, `${userName} (You)`, state.localStream, { muted: true });
}

async function stopScreenShare() {
  if (!state.screenTrack) return;
  state.screenTrack.stop();
  state.screenTrack = null;

  const cam = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  const camTrack = cam.getVideoTracks()[0];
  const current = state.localStream.getVideoTracks()[0];
  if (current) state.localStream.removeTrack(current);
  state.localStream.addTrack(camTrack);
  swapVideoTrack(camTrack);
  upsertVideoTile(userId, `${userName} (You)`, state.localStream, { muted: true });
}

async function leaveMeeting() {
  await api('leave', { room_id: roomId, user_id: userId });
  state.localStream?.getTracks().forEach((t) => t.stop());
  for (const id of [...state.peers.keys()]) closePeer(id);
  location.href = 'index.html';
}

function startRecording() {
  if (!state.isHost) return alert('Only host can record.');
  if (state.recorder && state.recorder.state === 'recording') {
    state.recorder.stop();
    els.recordBtn.textContent = 'Start Recording';
    return;
  }
  const composite = new MediaStream(state.localStream.getTracks());
  state.recorder = new MediaRecorder(composite, { mimeType: 'video/webm' });
  state.recordedChunks = [];
  state.recorder.ondataavailable = (e) => e.data.size && state.recordedChunks.push(e.data);
  state.recorder.onstop = () => {
    const blob = new Blob(state.recordedChunks, { type: 'video/webm' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `meeting-${roomId}-${Date.now()}.webm`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  state.recorder.start();
  els.recordBtn.textContent = 'Stop Recording';
}

async function init() {
  setStatus('Joining room...');
  const joined = await api('join_room', {
    room_id: roomId,
    user_id: userId,
    name: userName
  });
  if (!joined.ok) {
    alert(joined.error || 'Unable to join room');
    return (location.href = 'index.html');
  }

  await initMedia();
  setStatus('Starting...');

  setInterval(pollLoop, 1300);
  pollLoop();
}

window.addEventListener('beforeunload', () => {
  navigator.sendBeacon('api.php', new URLSearchParams({ action: 'leave', room_id: roomId, user_id: userId }));
});

document.getElementById('copyLinkBtn').onclick = async () => {
  const link = `${location.origin}${location.pathname.replace('meeting.html', 'index.html')}?room=${encodeURIComponent(roomId)}`;
  await navigator.clipboard.writeText(link);
  alert('Meeting link copied');
};

document.getElementById('toggleChatBtn').onclick = () => {
  state.chatOpen = !state.chatOpen;
  els.chatPanel.classList.toggle('hidden', !state.chatOpen);
};

document.getElementById('sendChatBtn').onclick = async () => {
  const text = els.chatInput.value.trim();
  if (!text) return;
  await api('send_chat', { room_id: roomId, user_id: userId, text });
  els.chatInput.value = '';
};

els.chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('sendChatBtn').click();
});

els.toggleMicBtn.onclick = () => {
  const track = state.localStream.getAudioTracks()[0];
  if (!track) return;
  state.micEnabled = !state.micEnabled;
  track.enabled = state.micEnabled;
  els.toggleMicBtn.textContent = state.micEnabled ? 'Mute' : 'Unmute';
};

els.toggleCamBtn.onclick = () => {
  const track = state.localStream.getVideoTracks()[0];
  if (!track) return;
  state.camEnabled = !state.camEnabled;
  track.enabled = state.camEnabled;
  els.toggleCamBtn.textContent = state.camEnabled ? 'Camera Off' : 'Camera On';
};

els.shareScreenBtn.onclick = async () => {
  if (state.screenTrack) return stopScreenShare();
  try {
    await startScreenShare();
  } catch (e) {
    alert('Screen share was blocked or unavailable.');
  }
};

els.raiseHandBtn.onclick = async () => {
  state.handRaised = !state.handRaised;
  els.raiseHandBtn.textContent = state.handRaised ? 'Lower Hand' : 'Raise Hand';
  await sendCommand('raise_hand', { raised: state.handRaised });
};

els.recordBtn.onclick = startRecording;
document.getElementById('leaveBtn').onclick = leaveMeeting;

init().catch((e) => {
  console.error(e);
  alert('Failed to initialize meeting app.');
});
