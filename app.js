// js/auth.js
'use strict';

const Auth = (() => {
  let _user = null;

  async function init() {
    return new Promise(resolve => {
      firebase.auth().onAuthStateChanged(user => {
        _user = user;
        resolve(user);
      });
    });
  }

  async function register(email, password, displayName) {
    const cred = await firebase.auth().createUserWithEmailAndPassword(email, password);
    await cred.user.updateProfile({ displayName });
    // Save user profile in Realtime DB
    await firebase.database().ref(`users/${cred.user.uid}`).set({
      uid:         cred.user.uid,
      displayName,
      email,
      online:      true,
      lastSeen:    Date.now(),
      fcmToken:    null,
      createdAt:   Date.now(),
    });
    _user = cred.user;
    return cred.user;
  }

  async function login(email, password) {
    const cred = await firebase.auth().signInWithEmailAndPassword(email, password);
    _user = cred.user;
    // Mark online
    await firebase.database().ref(`users/${cred.user.uid}/online`).set(true);
    return cred.user;
  }

  async function logout() {
    if (_user) {
      await firebase.database().ref(`users/${_user.uid}/online`).set(false);
      await firebase.database().ref(`users/${_user.uid}/lastSeen`).set(Date.now());
    }
    await firebase.auth().signOut();
    _user = null;
  }

  function getUser() { return _user; }

  async function updateFcmToken(token) {
    if (_user) {
      await firebase.database().ref(`users/${_user.uid}/fcmToken`).set(token);
    }
  }

  // Watch own online presence
  function setupPresence() {
    if (!_user) return;
    const ref = firebase.database().ref(`users/${_user.uid}/online`);
    ref.set(true);
    ref.onDisconnect().set(false);
    firebase.database().ref(`users/${_user.uid}/lastSeen`).onDisconnect().set(Date.now());
  }

  async function searchUsers(query) {
    const snap = await firebase.database().ref('users').once('value');
    const results = [];
    const q = query.toLowerCase();
    snap.forEach(child => {
      const u = child.val();
      if (child.key !== _user?.uid) {
        const emailMatch = u.email?.toLowerCase().includes(q);
        const nameMatch  = u.displayName?.toLowerCase().includes(q);
        if (emailMatch || nameMatch) results.push(u);
      }
    });
    return results.slice(0, 10);
  }

  async function getUserById(uid) {
    const snap = await firebase.database().ref(`users/${uid}`).once('value');
    return snap.val();
  }

  return { init, register, login, logout, getUser, updateFcmToken, setupPresence, searchUsers, getUserById };
})();
// js/webrtc.js
'use strict';

const WebRTCManager = (() => {
  let pc = null;
  let localStream = null;
  let remoteStream = null;
  let currentCallId = null;
  let callType = 'audio'; // 'audio' | 'video'
  let isCaller = false;
  let callRef = null;
  let iceCandidates = [];
  let callTimer = null;
  let callSeconds = 0;
  let currentFacingMode = 'user';

  // Callbacks
  const on = {
    stateChange:  () => {},
    remoteStream: () => {},
    callEnded:    () => {},
  };

  async function getTurnServers() {
    try {
      const res = await fetch(SOLVIX_CONFIG.cloudflare.workerUrl + '/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      return data.iceServers || [];
    } catch {
      return [];
    }
  }

  async function getLocalStream(type) {
    const constraints = type === 'video'
      ? { audio: true, video: { facingMode: currentFacingMode, width: { ideal: 1280 }, height: { ideal: 720 } } }
      : { audio: true, video: false };
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  async function createPC() {
    const turnServers = await getTurnServers();
    const iceServers = [...SOLVIX_CONFIG.ice.iceServers, ...turnServers];
    pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 10 });

    pc.onicecandidate = ({ candidate }) => {
      if (candidate && callRef) {
        const side = isCaller ? 'callerCandidates' : 'calleeCandidates';
        callRef.child(side).push(candidate.toJSON());
      }
    };

    pc.ontrack = (event) => {
      remoteStream = event.streams[0];
      on.remoteStream(remoteStream);
    };

    let reconnectTimer = null;
    pc.onconnectionstatechange = () => {
      on.stateChange(pc.connectionState);
      if (pc.connectionState === 'connected') {
        clearTimeout(reconnectTimer);
        startCallTimer();
      }
      if (pc.connectionState === 'disconnected') {
        // Give 8 seconds to reconnect before ending
        reconnectTimer = setTimeout(() => {
          if (pc && pc.connectionState !== 'connected') endCall(true);
        }, 8000);
      }
      if (['failed', 'closed'].includes(pc.connectionState)) {
        clearTimeout(reconnectTimer);
        endCall(false);
      }
    };

    return pc;
  }

  async function startCall(peerUid, type) {
    callType = type;
    isCaller = true;
    currentCallId = Date.now().toString(36) + Math.random().toString(36).substr(2);
    callRef = firebase.database().ref(`calls/${currentCallId}`);

    localStream = await getLocalStream(type);
    await createPC();

    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await callRef.set({
      callId:     currentCallId,
      callerId:   Auth.getUser().uid,
      callerName: Auth.getUser().displayName,
      calleeUid:  peerUid,
      type:       callType,
      status:     'ringing',
      offer:      { type: offer.type, sdp: offer.sdp },
      createdAt:  Date.now(),
    });

    // Listen for answer
    callRef.child('answer').on('value', async snap => {
      if (snap.val() && !pc.currentRemoteDescription) {
        await pc.setRemoteDescription(new RTCSessionDescription(snap.val()));
        drainCandidates();
      }
    });

    // Listen for callee ICE
    callRef.child('calleeCandidates').on('child_added', snap => {
      if (pc.remoteDescription) pc.addIceCandidate(new RTCIceCandidate(snap.val()));
      else iceCandidates.push(snap.val());
    });

    // Listen for status changes
    callRef.child('status').on('value', snap => {
      if (snap.val() === 'ended') endCall(false);
    });

    return { callId: currentCallId, localStream };
  }

  async function answerCall(callData) {
    callType = callData.type;
    isCaller = false;
    currentCallId = callData.callId;
    callRef = firebase.database().ref(`calls/${currentCallId}`);

    localStream = await getLocalStream(callType);
    await createPC();

    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    await pc.setRemoteDescription(new RTCSessionDescription(callData.offer));

    // Add any buffered caller candidates
    callRef.child('callerCandidates').once('value', snap => {
      snap.forEach(child => pc.addIceCandidate(new RTCIceCandidate(child.val())));
    });

    callRef.child('callerCandidates').on('child_added', snap => {
      if (pc.remoteDescription) pc.addIceCandidate(new RTCIceCandidate(snap.val()));
    });

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await callRef.child('answer').set({ type: answer.type, sdp: answer.sdp });
    await callRef.child('status').set('ongoing');

    callRef.child('status').on('value', snap => {
      if (snap.val() === 'ended') endCall(false);
    });

    return localStream;
  }

  async function declineCall(callId) {
    await firebase.database().ref(`calls/${callId}/status`).set('declined');
  }

  async function endCall(notify = true) {
    stopCallTimer();
    if (notify && callRef) {
      await callRef.child('status').set('ended');
    }
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    if (pc) {
      pc.close();
      pc = null;
    }
    callRef?.off();
    callRef = null;
    currentCallId = null;
    on.callEnded();
  }

  async function switchCamera() {
    currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
    if (!localStream) return;
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) videoTrack.stop();
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: currentFacingMode },
        audio: false,
      });
      const newTrack = newStream.getVideoTracks()[0];
      const sender = pc?.getSenders().find(s => s.track?.kind === 'video');
      if (sender) await sender.replaceTrack(newTrack);
      localStream.removeTrack(videoTrack);
      localStream.addTrack(newTrack);
      return localStream;
    } catch (e) {
      console.error('Camera switch failed', e);
    }
  }

  function toggleMute() {
    if (!localStream) return false;
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) { audioTrack.enabled = !audioTrack.enabled; return !audioTrack.enabled; }
    return false;
  }

  function toggleVideo() {
    if (!localStream) return false;
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) { videoTrack.enabled = !videoTrack.enabled; return !videoTrack.enabled; }
    return false;
  }

  function setSpeaker(loud) {
    // Works on supported browsers via setSinkId
    const remoteAudio = document.getElementById('remoteAudio');
    if (remoteAudio && 'setSinkId' in remoteAudio) {
      // 'default' = earpiece, 'speaker' = loudspeaker
      remoteAudio.setSinkId(loud ? 'speaker' : 'default').catch(() => {});
    }
  }

  function drainCandidates() {
    iceCandidates.forEach(c => pc.addIceCandidate(new RTCIceCandidate(c)));
    iceCandidates = [];
  }

  function startCallTimer() {
    callSeconds = 0;
    callTimer = setInterval(() => {
      callSeconds++;
      const m = String(Math.floor(callSeconds / 60)).padStart(2, '0');
      const s = String(callSeconds % 60).padStart(2, '0');
      const el = document.getElementById('callTimerDisplay');
      if (el) el.textContent = `${m}:${s}`;
    }, 1000);
  }

  function stopCallTimer() {
    clearInterval(callTimer);
    callTimer = null;
    callSeconds = 0;
  }

  function getStream() { return localStream; }

  function listenForIncomingCalls(uid, callback) {
    const listenFrom = Date.now() - 5000; // only calls from last 5 seconds
    firebase.database().ref('calls')
      .orderByChild('calleeUid').equalTo(uid)
      .on('child_added', snap => {
        const data = snap.val();
        if (data && data.status === 'ringing' && data.createdAt > listenFrom) {
          callback(data);
        }
      });
  }

  return {
    startCall, answerCall, declineCall, endCall,
    switchCamera, toggleMute, toggleVideo, setSpeaker,
    getStream, listenForIncomingCalls,
    on,
  };
})();
// js/chat.js
'use strict';

const Chat = (() => {
  const listeners = {};

  function getChatId(uid1, uid2) {
    return [uid1, uid2].sort().join('_');
  }

  async function sendMessage(toUid, text) {
    const fromUid = Auth.getUser().uid;
    const chatId = getChatId(fromUid, toUid);
    const msg = {
      from:      fromUid,
      to:        toUid,
      text:      text.trim(),
      timestamp: Date.now(),
      read:      false,
    };
    await firebase.database().ref(`chats/${chatId}/messages`).push(msg);
    await firebase.database().ref(`chats/${chatId}/meta`).set({
      participants:   [fromUid, toUid],
      lastMessage:    text.trim(),
      lastTimestamp:  Date.now(),
      lastSender:     fromUid,
    });
    return msg;
  }

  function listenMessages(toUid, callback) {
    const fromUid = Auth.getUser().uid;
    const chatId = getChatId(fromUid, toUid);
    const ref = firebase.database().ref(`chats/${chatId}/messages`).orderByChild('timestamp');
    ref.on('child_added', snap => callback(snap.val()));
    listeners[chatId] = ref;
    return () => ref.off();
  }

  function stopListening(toUid) {
    const fromUid = Auth.getUser().uid;
    const chatId = getChatId(fromUid, toUid);
    if (listeners[chatId]) { listeners[chatId].off(); delete listeners[chatId]; }
  }

  async function getConversationList() {
    const uid = Auth.getUser().uid;
    const snap = await firebase.database().ref('chats').orderByChild('meta/participants').once('value');
    const conversations = [];
    snap.forEach(child => {
      const meta = child.val()?.meta;
      if (meta && meta.participants?.includes(uid)) {
        const peerId = meta.participants.find(p => p !== uid);
        conversations.push({ chatId: child.key, meta, peerId });
      }
    });
    return conversations;
  }

  async function markRead(toUid) {
    const fromUid = Auth.getUser().uid;
    const chatId = getChatId(fromUid, toUid);
    const snap = await firebase.database().ref(`chats/${chatId}/messages`).orderByChild('read').equalTo(false).once('value');
    const updates = {};
    snap.forEach(child => {
      if (child.val().to === fromUid) updates[`${child.key}/read`] = true;
    });
    if (Object.keys(updates).length) {
      await firebase.database().ref(`chats/${chatId}/messages`).update(updates);
    }
  }

  return { sendMessage, listenMessages, stopListening, getConversationList, markRead, getChatId };
})();
// js/app.js
'use strict';

// ────────────────────────────────────────────────
// PWA Install + Permission Gate
// ────────────────────────────────────────────────
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
});

// ────────────────────────────────────────────────
// DOM helpers
// ────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const show = id => { $(id)?.classList.remove('hidden'); };
const hide = id => { $(id)?.classList.add('hidden'); };

function showToast(msg, duration = 2800) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), duration);
}

// ────────────────────────────────────────────────
// Permission Gate
// ────────────────────────────────────────────────
async function requestAllPermissions() {
  const results = {};

  // Camera & Mic
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    stream.getTracks().forEach(t => t.stop());
    results.media = true;
  } catch {
    results.media = false;
  }

  // Notifications
  if ('Notification' in window) {
    const perm = await Notification.requestPermission();
    results.notification = perm === 'granted';
  }

  return results;
}

async function handlePermissionAllow() {
  $('btnAllow').disabled = true;
  $('btnAllow').textContent = 'Requesting…';

  const results = await requestAllPermissions();

  if (!results.media) {
    // Must have camera & mic
    showToast('⚠️ Camera & Microphone permission required.');
    $('btnAllow').disabled = false;
    $('btnAllow').textContent = 'Grant Permissions';
    return;
  }

  // Try PWA install
  if (deferredInstallPrompt) {
    try {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
    } catch {}
  }

  // Hide permission screen, show loading, proceed
  hide('permissionScreen');
  const overlay = $('loadingOverlay');
  if (overlay) overlay.classList.remove('hidden');
  initApp();
}

function handlePermissionDeny() {
  // Redirect away
  document.body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#07080f;color:#8892b0;flex-direction:column;gap:16px;font-family:sans-serif;padding:24px;text-align:center">
      <div style="font-size:48px">🚫</div>
      <div style="color:#fff;font-size:20px;font-weight:700">Permission Required</div>
      <div>VoCall requires Camera, Microphone and Notification permissions to function.<br>Please reload and grant permissions.</div>
      <button onclick="location.reload()" style="margin-top:16px;padding:12px 28px;background:#00d4ff;color:#000;border:none;border-radius:12px;font-weight:700;font-size:15px;cursor:pointer">Reload</button>
    </div>`;
}

// ────────────────────────────────────────────────
// App Init
// ────────────────────────────────────────────────
async function initApp() {
  // Firebase init
  try {
    if (!firebase.apps.length) firebase.initializeApp(SOLVIX_CONFIG.firebase);
  } catch(e) { /* already initialized */ }

  const user = await Auth.init();

  // Hide loading overlay with fade
  const overlay = $('loadingOverlay');
  if (overlay) {
    overlay.classList.add('fade-out');
    setTimeout(() => overlay.classList.add('hidden'), 400);
  }

  if (user) {
    Auth.setupPresence();
    await setupFCM();
    showMainApp(user);
  } else {
    show('authScreen');
  }
}

// ────────────────────────────────────────────────
// Push Notification Setup (Web Push API)
// ────────────────────────────────────────────────
async function setupFCM() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    // Subscribe to push (VAPID)
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(SOLVIX_CONFIG.notifications.vapidKey),
      });
    }
    // Save subscription endpoint to Firebase for this user
    if (sub && Auth.getUser()) {
      await firebase.database().ref(`users/${Auth.getUser().uid}/pushSub`).set(JSON.stringify(sub));
    }
  } catch (e) {
    console.warn('Push setup failed:', e.message);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

// ────────────────────────────────────────────────
// Auth UI
// ────────────────────────────────────────────────
function setupAuthUI() {
  // Tab switching
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      $(`tab-${tab.dataset.tab}`)?.classList.add('active');
    });
  });

  // Login
  $('btnLogin')?.addEventListener('click', async () => {
    const email = $('loginEmail').value.trim();
    const pass  = $('loginPass').value;
    if (!email || !pass) { showAuthError('loginError', 'Fill in all fields.'); return; }
    $('btnLogin').disabled = true;
    try {
      await Auth.login(email, pass);
      Auth.setupPresence();
      await setupFCM();
      hide('authScreen');
      showMainApp(Auth.getUser());
    } catch (e) {
      showAuthError('loginError', friendlyError(e));
    } finally {
      $('btnLogin').disabled = false;
    }
  });

  // Register
  $('btnRegister')?.addEventListener('click', async () => {
    const name  = $('regName').value.trim();
    const email = $('regEmail').value.trim();
    const pass  = $('regPass').value;
    const pass2 = $('regPass2').value;
    if (!name || !email || !pass) { showAuthError('regError', 'Fill in all fields.'); return; }
    if (pass !== pass2)           { showAuthError('regError', 'Passwords do not match.'); return; }
    if (pass.length < 6)          { showAuthError('regError', 'Password must be 6+ characters.'); return; }
    $('btnRegister').disabled = true;
    try {
      await Auth.register(email, pass, name);
      Auth.setupPresence();
      await setupFCM();
      hide('authScreen');
      showMainApp(Auth.getUser());
    } catch (e) {
      showAuthError('regError', friendlyError(e));
    } finally {
      $('btnRegister').disabled = false;
    }
  });
}

function showAuthError(id, msg) {
  const el = $(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 4000);
}

function friendlyError(e) {
  const map = {
    'auth/user-not-found':    'No account found with this email.',
    'auth/wrong-password':    'Incorrect password.',
    'auth/email-already-in-use': 'Email already registered.',
    'auth/weak-password':     'Password too weak.',
    'auth/invalid-email':     'Invalid email address.',
    'auth/network-request-failed': 'Network error. Check your connection.',
  };
  return map[e.code] || e.message || 'Something went wrong.';
}

// ────────────────────────────────────────────────
// Main App
// ────────────────────────────────────────────────
function showMainApp(user) {
  show('mainScreen');
  // Set avatar
  const initials = (user.displayName || user.email || 'U').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  $('userAvatar').textContent = initials;
  loadCallHistory();
  loadChatList();
  setupIncomingCallListener();
}

// ────────────────────────────────────────────────
// BOTTOM NAV
// ────────────────────────────────────────────────
function setupBottomNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const panel = btn.dataset.panel;
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $(`panel-${panel}`)?.classList.add('active');
    });
  });
}

// ────────────────────────────────────────────────
// CALLS
// ────────────────────────────────────────────────
async function loadCallHistory() {
  const uid = Auth.getUser()?.uid;
  if (!uid) return;
  const list = $('callList');
  list.innerHTML = '';

  const [snap, snap2] = await Promise.all([
    firebase.database().ref('calls').orderByChild('callerId').equalTo(uid).limitToLast(30).once('value'),
    firebase.database().ref('calls').orderByChild('calleeUid').equalTo(uid).limitToLast(30).once('value'),
  ]);

  const calls = {};
  snap.forEach(c => { if(c.val()) calls[c.key] = c.val(); });
  snap2.forEach(c => { if(c.val()) calls[c.key] = c.val(); });

  const sorted = Object.values(calls).sort((a, b) => b.createdAt - a.createdAt);

  if (!sorted.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">📞</div><div class="empty-text">No call history yet.<br>Tap + to make your first call.</div></div>`;
    return;
  }

  for (const call of sorted) {
    const isOutgoing = call.callerId === uid;
    const peerId = isOutgoing ? call.calleeUid : call.callerId;
    const peerData = await Auth.getUserById(peerId);
    const peerName = peerData?.displayName || peerData?.email || 'Unknown';
    const peerInitials = peerName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const missed = !isOutgoing && call.status === 'ended' && !call.answer;
    const time = formatTime(call.createdAt);
    const typeIcon = call.type === 'video' ? '🎥' : '🔊';
    const dirIcon = isOutgoing ? '↗️' : (missed ? '↘️' : '↙️');

    const el = document.createElement('div');
    el.className = `call-item${missed ? ' missed' : ''}`;
    el.innerHTML = `
      <div class="avatar" style="font-size:14px">${peerInitials}</div>
      <div class="call-info">
        <div class="call-name">${peerName}</div>
        <div class="call-meta"><span>${dirIcon} ${isOutgoing ? 'Outgoing' : (missed ? 'Missed' : 'Incoming')}</span><span>${typeIcon}</span><span>${time}</span></div>
      </div>
      <div class="call-actions">
        <button class="btn-call-action btn-audio" title="Audio call">📞</button>
        <button class="btn-call-action btn-video" title="Video call">🎥</button>
      </div>`;
    el.querySelector('.btn-audio').addEventListener('click', (e) => { e.stopPropagation(); startOutgoingCall(peerId, peerName, 'audio'); });
    el.querySelector('.btn-video').addEventListener('click', (e) => { e.stopPropagation(); startOutgoingCall(peerId, peerName, 'video'); });
    list.appendChild(el);
  }
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 86400000) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diff < 604800000) return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// New Call Modal
let selectedUser = null;

function openNewCallModal() {
  $('newCallModal').classList.add('open');
  $('userSearch').value = '';
  $('searchResults').innerHTML = '';
  $('callActionBtns').style.display = 'none';
  selectedUser = null;
  $('userSearch').focus();
}

function closeNewCallModal() { $('newCallModal').classList.remove('open'); }

async function searchUsers(query) {
  if (query.length < 2) { $('searchResults').innerHTML = ''; return; }
  const results = await Auth.searchUsers(query);
  $('searchResults').innerHTML = '';
  if (!results.length) {
    $('searchResults').innerHTML = '<div style="color:#8892b0;font-size:13px;padding:12px">No users found.</div>';
    return;
  }
  results.forEach(u => {
    const initials = u.displayName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const el = document.createElement('div');
    el.className = 'user-result';
    el.innerHTML = `
      <div class="avatar">${initials}</div>
      <div><div class="uname">${u.displayName}</div><div class="uemail">${u.email}</div></div>`;
    el.addEventListener('click', () => {
      selectedUser = u;
      $('callActionBtns').style.display = 'flex'; $('callActionBtns').style.marginTop = '12px';
      document.querySelectorAll('.user-result').forEach(r => r.style.background = '');
      el.style.background = 'rgba(0,212,255,0.08)';
    });
    $('searchResults').appendChild(el);
  });
}

async function startOutgoingCall(uid, name, type) {
  if (uid === Auth.getUser()?.uid) { showToast('You cannot call yourself.'); return; }
  closeNewCallModal();
  showCallScreen({ uid, displayName: name }, type, true);
  try {
    const { localStream } = await WebRTCManager.startCall(uid, type);
    setupCallControls(localStream, type);
    $('localVideo').srcObject = localStream;
    $('localVideo').play().catch(() => {});
    if (type === 'video') {
      $('callStatusOverlay').style.display = 'flex';
    }
  } catch (e) {
    showToast('Failed to start call: ' + e.message);
    hideCallScreen();
  }
}

// ────────────────────────────────────────────────
// CALL SCREEN
// ────────────────────────────────────────────────
let audioCtx = null, ringOsc = null;

function playRingtone() {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    ringOsc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    ringOsc.connect(gain); gain.connect(audioCtx.destination);
    ringOsc.frequency.value = 440;
    gain.gain.value = 0.3;
    ringOsc.start();
    const interval = setInterval(() => {
      if (!ringOsc) { clearInterval(interval); return; }
      ringOsc.frequency.value = ringOsc.frequency.value === 440 ? 480 : 440;
    }, 400);
  } catch {}
}

function stopRingtone() {
  ringOsc?.stop();
  audioCtx?.close();
  ringOsc = null; audioCtx = null;
}

function showCallScreen(peer, type, outgoing) {
  const initials = peer.displayName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  $('callPeerAvatar').textContent = initials;
  $('callPeerName').textContent = peer.displayName;
  $('callState').textContent = outgoing ? 'Calling…' : 'Connecting…';
  $('callTimerDisplay').classList.remove('show');
  $('localVideo').style.display = type === 'video' ? 'block' : 'none';
  $('remoteVideo').style.display = type === 'video' ? 'block' : 'none';
  show('callScreen');

  WebRTCManager.on.stateChange = (state) => {
    if (state === 'connected') {
      $('callState').textContent = 'Connected';
      $('callTimerDisplay').classList.add('show');
      $('callStatusOverlay').style.opacity = '0';
      $('callStatusOverlay').style.pointerEvents = 'none';
    }
  };
  WebRTCManager.on.remoteStream = (stream) => {
    if (type === 'video') {
      $('remoteVideo').srcObject = stream;
      $('remoteVideo').play().catch(() => {});
    } else {
      // Audio call - route to hidden audio element
      $('remoteAudio').srcObject = stream;
      $('remoteAudio').play().catch(() => {});
    }
  };
  WebRTCManager.on.callEnded = () => {
    stopRingtone();
    hideCallScreen();
    loadCallHistory();
    showToast('Call ended.');
  };
}

function hideCallScreen() {
  hide('callScreen');
  $('remoteVideo').srcObject = null;
  $('localVideo').srcObject = null;
  $('remoteAudio').srcObject = null;
  $('callStatusOverlay').style.opacity = '1';
  $('callStatusOverlay').style.pointerEvents = '';
  // Reset control button states
  $('btnMute').classList.remove('active');
  $('btnMute').querySelector('span:first-child').textContent = '🎤';
  $('btnSpeaker').classList.remove('active');
  $('btnSpeaker').querySelector('span:first-child').textContent = '🔈';
  $('btnCam').classList.remove('active');
  $('btnCam').querySelector('span:first-child').textContent = '📷';
  $('callTimerDisplay').textContent = '00:00';
  $('callTimerDisplay').classList.remove('show');
}

function setupCallControls(localStream, type) {
  let muted = false, videoOff = false, loudSpeaker = false;

  $('btnMute').onclick = () => {
    muted = WebRTCManager.toggleMute();
    $('btnMute').classList.toggle('active', muted);
    $('btnMute').querySelector('span:first-child').textContent = muted ? '🔇' : '🎤';
  };

  $('btnSpeaker').onclick = () => {
    loudSpeaker = !loudSpeaker;
    WebRTCManager.setSpeaker(loudSpeaker);
    $('btnSpeaker').classList.toggle('active', loudSpeaker);
    $('btnSpeaker').querySelector('span:first-child').textContent = loudSpeaker ? '🔊' : '🔈';
  };

  if (type === 'video') {
    $('btnCam').style.display = '';
    $('btnFlip').style.display = '';
    $('btnCam').onclick = () => {
      videoOff = WebRTCManager.toggleVideo();
      $('btnCam').classList.toggle('active', videoOff);
      $('btnCam').querySelector('span:first-child').textContent = videoOff ? '🚫' : '📷';
    };
    $('btnFlip').onclick = async () => {
      const stream = await WebRTCManager.switchCamera();
      if (stream) { $('localVideo').srcObject = stream; $('localVideo').play().catch(() => {}); }
    };
  } else {
    $('btnCam').style.display = 'none';
    $('btnFlip').style.display = 'none';
    $('btnCam').onclick = null;
    $('btnFlip').onclick = null;
  }

  $('btnEndCall').onclick = () => WebRTCManager.endCall(true);
}

// ────────────────────────────────────────────────
// INCOMING CALL
// ────────────────────────────────────────────────
function setupIncomingCallListener() {
  const uid = Auth.getUser()?.uid;
  if (!uid) return;
  WebRTCManager.listenForIncomingCalls(uid, (callData) => {
    showIncomingCall(callData);
  });
}

function showIncomingCall(callData) {
  $('incomingCallerName').textContent = callData.callerName || 'Unknown';
  $('incomingCallType').textContent = callData.type === 'video' ? '📹 Video Call' : '🔊 Audio Call';
  const initials = (callData.callerName || 'U').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  $('incomingCallerAvatar').textContent = initials;
  show('incomingScreen');
  playRingtone();

  let answering = false;
  $('btnAnswer').onclick = async () => {
    if (answering) return;
    answering = true;
    stopRingtone();
    hide('incomingScreen');
    showCallScreen({ uid: callData.callerId, displayName: callData.callerName }, callData.type, false);
    try {
      const localStream = await WebRTCManager.answerCall(callData);
      setupCallControls(localStream, callData.type);
      $('localVideo').srcObject = localStream;
      $('localVideo').play().catch(() => {});
    } catch (e) {
      showToast('Failed to answer: ' + e.message);
      hideCallScreen();
    }
  };

  $('btnDecline').onclick = () => {
    stopRingtone();
    hide('incomingScreen');
    WebRTCManager.declineCall(callData.callId);
    showToast('Call declined.');
  };
}

// Notification click from SW
navigator.serviceWorker?.addEventListener('message', (event) => {
  if (event.data?.type === 'NOTIFICATION_CLICK') {
    const { data, action } = event.data;
    if (action === 'answer' && data.callId) {
      firebase.database().ref(`calls/${data.callId}`).once('value').then(snap => {
        if (snap.val()) showIncomingCall(snap.val());
      });
    }
  }
});

// ────────────────────────────────────────────────
// CHAT
// ────────────────────────────────────────────────
async function loadChatList() {
  const uid = Auth.getUser()?.uid;
  if (!uid) return;
  const list = $('chatList');
  list.innerHTML = '';

  // Detach previous listener if any
  firebase.database().ref('chats').off('value');
  // Listen realtime for new chats
  firebase.database().ref('chats').on('value', async snap => {
    list.innerHTML = '';
    const rows = [];
    snap.forEach(child => {
      const meta = child.val()?.meta;
      if (meta?.participants?.includes(uid)) {
        const peerId = meta.participants.find(p => p !== uid);
        rows.push({ chatId: child.key, meta, peerId });
      }
    });
    rows.sort((a, b) => (b.meta.lastTimestamp || 0) - (a.meta.lastTimestamp || 0));

    if (!rows.length) {
      list.innerHTML = `<div class="empty-state"><div class="empty-icon">💬</div><div class="empty-text">No conversations yet.<br>Start a chat from the Calls tab.</div></div>`;
      return;
    }

    for (const row of rows) {
      const peerData = await Auth.getUserById(row.peerId);
      if (!peerData) continue;
      const name = peerData.displayName || peerData.email;
      const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
      const time = formatTime(row.meta.lastTimestamp || Date.now());

      const el = document.createElement('div');
      el.className = 'chat-item';
      el.innerHTML = `
        <div class="avatar">${initials}</div>
        <div class="chat-info">
          <div class="chat-name">${name}</div>
          <div class="chat-preview">${row.meta.lastMessage || ''}</div>
        </div>
        <div class="chat-meta">
          <div class="chat-time">${time}</div>
        </div>`;
      el.addEventListener('click', () => openConversation(row.peerId, peerData));
      list.appendChild(el);
    }
  });
}

let currentChatPeer = null;
let stopListeningFn = null;

function openConversation(peerId, peerData) {
  currentChatPeer = peerId;
  const name = peerData.displayName || peerData.email;
  const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  $('convPeerName').textContent = name;
  $('convPeerAvatar').textContent = initials;
  $('messagesWrap').innerHTML = '';
  show('chatConvScreen');
  Chat.markRead(peerId).catch(() => {});

  if (stopListeningFn) stopListeningFn();
  stopListeningFn = Chat.listenMessages(peerId, (msg) => {
    appendMessage(msg);
    $('messagesWrap').scrollTop = $('messagesWrap').scrollHeight;
  });

  // Call buttons from conversation header
  $('convBtnAudio').onclick = () => startOutgoingCall(peerId, name, 'audio');
  $('convBtnVideo').onclick = () => startOutgoingCall(peerId, name, 'video');
}

function appendMessage(msg) {
  const myUid = Auth.getUser().uid;
  const isSent = msg.from === myUid;
  const el = document.createElement('div');
  el.className = `msg ${isSent ? 'sent' : 'recv'}`;
  const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `${escapeHtml(msg.text)}<div class="msg-time">${time}${isSent ? ' ✓' : ''}</div>`;
  $('messagesWrap').appendChild(el);
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

async function sendMessage() {
  const input = $('msgInput');
  const text = input.value.trim();
  if (!text || !currentChatPeer) return;
  input.value = '';
  input.style.height = '';
  try {
    await Chat.sendMessage(currentChatPeer, text);
  } catch (e) {
    showToast('Send failed: ' + e.message);
  }
}


// ────────────────────────────────────────────────
// NEW CHAT MODAL
// ────────────────────────────────────────────────
function openNewChatModal() {
  $('newChatModal').classList.add('open');
  $('chatUserSearch').value = '';
  $('chatSearchResults').innerHTML = '';
  setTimeout(() => $('chatUserSearch').focus(), 300);
}

function closeNewChatModal() {
  $('newChatModal').classList.remove('open');
}

async function searchChatUsers(query) {
  const resultsEl = $('chatSearchResults');
  if (query.length < 1) { resultsEl.innerHTML = ''; return; }

  resultsEl.innerHTML = '<div style="color:#8892b0;font-size:13px;padding:12px">Searching…</div>';
  const results = await Auth.searchUsers(query);
  resultsEl.innerHTML = '';

  if (!results.length) {
    resultsEl.innerHTML = '<div style="color:#8892b0;font-size:13px;padding:12px">No users found.</div>';
    return;
  }

  results.forEach(u => {
    const initials = (u.displayName || u.email || 'U').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const el = document.createElement('div');
    el.className = 'user-result';
    el.innerHTML = `
      <div class="avatar">${initials}</div>
      <div>
        <div class="uname">${u.displayName || 'Unknown'}</div>
        <div class="uemail">${u.email}</div>
      </div>
      <div style="margin-left:auto;color:var(--accent);font-size:13px;font-weight:600">Message →</div>`;
    el.addEventListener('click', () => {
      closeNewChatModal();
      openConversation(u.uid, u);
    });
    resultsEl.appendChild(el);
  });
}

// ────────────────────────────────────────────────
// BOOT
// ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setupAuthUI();
  setupBottomNav();
  bindAllEvents();

  // Register SW first (non-blocking)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Check if camera permission already granted → skip gate
  if (navigator.permissions) {
    navigator.permissions.query({ name: 'camera' }).then(perm => {
      if (perm.state === 'granted') {
        // Already have permission - go straight to app
        const overlay = $('loadingOverlay');
        if (overlay) overlay.classList.remove('hidden');
        hide('permissionScreen');
        initApp();
      } else {
        // Need to ask for permission first
        hide('loadingOverlay');
        show('permissionScreen');
      }
    }).catch(() => {
      hide('loadingOverlay');
      show('permissionScreen');
    });
  } else {
    // Permissions API not supported (e.g. Safari) → show gate
    hide('loadingOverlay');
    show('permissionScreen');
  }
});

function bindAllEvents() {
  // Permission buttons
  $('btnAllow')?.addEventListener('click', handlePermissionAllow);
  $('btnDeny')?.addEventListener('click', handlePermissionDeny);

  // New chat modal
  $('btnNewChat')?.addEventListener('click', openNewChatModal);
  $('newChatModal')?.addEventListener('click', (e) => {
    if (e.target === $('newChatModal')) closeNewChatModal();
  });
  $('chatUserSearch')?.addEventListener('input', (e) => searchChatUsers(e.target.value));

  // New call modal
  $('btnNewCall')?.addEventListener('click', openNewCallModal);
  $('newCallModal')?.addEventListener('click', (e) => {
    if (e.target === $('newCallModal')) closeNewCallModal();
  });
  $('userSearch')?.addEventListener('input', (e) => searchUsers(e.target.value));
  $('btnDoAudio')?.addEventListener('click', () => {
    if (selectedUser) startOutgoingCall(selectedUser.uid, selectedUser.displayName, 'audio');
  });
  $('btnDoVideo')?.addEventListener('click', () => {
    if (selectedUser) startOutgoingCall(selectedUser.uid, selectedUser.displayName, 'video');
  });

  // Chat send
  $('btnSendMsg')?.addEventListener('click', sendMessage);
  $('msgInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  $('msgInput')?.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 100) + 'px';
    $('btnSendMsg').disabled = !this.value.trim();
  });

  // Back from conversation
  $('btnBackChat')?.addEventListener('click', () => {
    hide('chatConvScreen');
    if (stopListeningFn) { stopListeningFn(); stopListeningFn = null; }
    currentChatPeer = null;
  });

  // Logout
  $('btnLogout')?.addEventListener('click', async () => {
    if (!confirm('Logout from VoCall?')) return;
    await Auth.logout();
    firebase.database().ref('chats').off('value');
    hide('mainScreen');
    show('authScreen');
  });
}
