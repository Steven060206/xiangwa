const storageKey = 'hako.pending-seat.v1';
let memory = null;
let memoryOnly = false;

function stored() {
  if (memoryOnly) return memory;
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : memory;
  } catch { return memory; }
}

export function discardApplication(application) {
  if (!application) return;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved?.key === application.key) localStorage.removeItem(storageKey);
  } catch { /* In-memory play remains available. */ }
  if (memory?.key === application.key) memory = null;
}

export function pendingApplication(roomCode) {
  const value = stored();
  if (!value) return null;
  if (!/^[A-Z2-9]{6}$/.test(value.roomCode) || !/^[a-f0-9]{64}$/.test(value.key)
      || !['join', 'recover'].includes(value.endpoint) || !(value.expiresAt > Date.now())) {
    discardApplication(value);
    return null;
  }
  return !roomCode || value.roomCode === roomCode ? value : null;
}

export function beginApplication(roomCode, endpoint) {
  const existing = pendingApplication(roomCode);
  if (existing?.endpoint === endpoint) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  memory = { roomCode, endpoint, key, expiresAt: Date.now() + 30 * 60 * 1000 };
  try {
    localStorage.setItem(storageKey, JSON.stringify(memory));
    memoryOnly = false;
  } catch { memoryOnly = true; }
  return memory;
}
