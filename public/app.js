const colors = ['--red', '--orange', '--yellow', '--green', '--blue', '--indigo', '--violet'];
const MINUTES_PER_MASSAGE = 15;

const form = document.getElementById('join-form');
const input = document.getElementById('name-input');
const message = document.getElementById('message');
const list = document.getElementById('waitlist');
const count = document.getElementById('count');
const empty = document.getElementById('empty');
const joinWait = document.getElementById('join-wait');
const staffBtn = document.getElementById('staff-btn');

// Saved in this browser only. Wrapped in try/catch because some browsers block storage.
function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable; things still work for this visit.
  }
}

// Secret keys for the entries this browser added: { [id]: token }.
// Only the holder of an entry's key (or staff) can remove it.
let myTokens = readStore('waitlist-tokens', {});
let adminPassword = readStore('waitlist-admin', null);
// The calledAt time of each call this browser has already acknowledged: { [id]: calledAt }.
// Staff pressing Call again gives a new calledAt, so the alert shows again.
let seenCalls = readStore('waitlist-seen-calls', {});

function showMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle('error', isError);
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatWait(peopleAhead) {
  const minutes = peopleAhead * MINUTES_PER_MASSAGE;
  if (minutes === 0) return 'Up next!';
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const parts = [];
  if (hrs) parts.push(`${hrs} hr`);
  if (mins) parts.push(`${mins} min`);
  return `~${parts.join(' ')} wait`;
}

// Ids already on screen, so only newly joined people get the pop-in animation.
// Starts as null so the first load doesn't animate everyone at once.
let seenIds = null;

// Text with a decorative emoji in front that screen readers skip.
function withIcon(el, icon, text) {
  const span = document.createElement('span');
  span.setAttribute('aria-hidden', 'true');
  span.textContent = icon;
  el.replaceChildren(span, ` ${text}`);
  return el;
}

// What the list was last drawn from, so the 4-second refresh only redraws
// when something changed. Redrawing would otherwise kick keyboard and
// screen reader users off whatever button they were on.
let lastRenderKey = '';

// Which called people have replied "On my way!", so staff can be told when a new reply comes in.
// Starts as null so replies that already existed on page load don't trigger a notice.
let onTheWayIds = null;

function noticeReplies(entries) {
  const now = new Set(entries.filter((e) => e.ackedAt).map((e) => e.id));
  if (onTheWayIds && adminPassword) {
    const fresh = entries.filter((e) => now.has(e.id) && !onTheWayIds.has(e.id));
    if (fresh.length) {
      showMessage(`${fresh.map((e) => e.name).join(' and ')} ${fresh.length > 1 ? 'are' : 'is'} on the way!`);
      playChime();
    }
  }
  onTheWayIds = now;
}

function render(entries) {
  noticeReplies(entries);
  const renderKey = JSON.stringify([entries, Boolean(adminPassword), Object.keys(myTokens)]);
  if (renderKey !== lastRenderKey) {
    lastRenderKey = renderKey;
    drawList(entries);
  }
  checkMyTurn(entries);
}

function drawList(entries) {
  // Remember which button had focus so it can get it back after redrawing.
  const focused = document.activeElement?.closest?.('.waitlist button');
  const refocus = focused && { id: focused.dataset.id, action: focused.dataset.action };

  list.replaceChildren();
  entries.forEach((entry, i) => {
    const li = document.createElement('li');
    const color = colors[i % colors.length];
    li.style.setProperty('--c', `var(${color})`);
    li.style.setProperty('--cd', `var(${color}-deep)`);
    if (seenIds && !seenIds.has(entry.id)) li.classList.add('new');

    const pos = document.createElement('span');
    pos.className = 'position';
    pos.textContent = i + 1;

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.name;

    const details = document.createElement('span');
    details.className = 'details';

    const wait = document.createElement('span');
    if (entry.ackedAt) {
      li.classList.add('called', 'on-way');
      wait.className = 'wait called-text';
      withIcon(wait, '🏃', 'On the way!');
    } else if (entry.calledAt) {
      li.classList.add('called');
      wait.className = 'wait called-text';
      withIcon(wait, '🔔', 'Called to the booth!');
    } else {
      wait.className = i === 0 ? 'wait next' : 'wait';
      wait.textContent = formatWait(i);
    }

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = `joined ${formatTime(entry.joinedAt)}`;

    details.append(wait, time);
    li.append(pos, name, details);

    const isMine = Boolean(myTokens[entry.id]);
    if (isMine) {
      li.classList.add('mine');
      const you = document.createElement('span');
      you.className = 'you';
      you.textContent = 'You';
      name.append(' ', you);
    }

    const actions = document.createElement('span');
    actions.className = 'actions';

    if (adminPassword) {
      const call = document.createElement('button');
      call.className = 'call';
      call.dataset.id = entry.id;
      call.dataset.action = 'call';
      withIcon(call, '🔔', entry.calledAt ? 'Call again' : 'Call');
      call.setAttribute('aria-label', entry.calledAt ? `Call ${entry.name} again` : `Call ${entry.name}`);
      call.addEventListener('click', () => callEntry(entry));
      actions.append(call);
    }

    if (isMine || adminPassword) {
      const remove = document.createElement('button');
      remove.className = 'remove';
      remove.dataset.id = entry.id;
      remove.dataset.action = 'remove';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${entry.name}`);
      remove.addEventListener('click', () => removeEntry(entry));
      actions.append(remove);
    }

    if (actions.childElementCount) li.append(actions);

    list.append(li);
  });
  seenIds = new Set(entries.map((e) => e.id));

  // Forget keys for entries that are no longer on the list.
  const stillHere = Object.fromEntries(
    Object.entries(myTokens).filter(([id]) => seenIds.has(Number(id)))
  );
  if (Object.keys(stillHere).length !== Object.keys(myTokens).length) {
    myTokens = stillHere;
    writeStore('waitlist-tokens', myTokens);
  }
  count.textContent = entries.length;
  joinWait.textContent = entries.length
    ? `If you join now: ${formatWait(entries.length)} (${entries.length} ahead of you)`
    : 'No wait — you would be up next!';
  empty.hidden = entries.length > 0;

  if (refocus) {
    const again = list.querySelector(
      `button[data-id="${refocus.id}"][data-action="${refocus.action}"]`
    );
    // If that person was removed, land on the list heading instead of the page top.
    (again || list.closest('section').querySelector('h2')).focus();
  }
}

async function load() {
  try {
    const res = await fetch('/api/waitlist');
    render(await res.json());
  } catch {
    showMessage('Could not load the wait list.', true);
  }
  loadLunch();
}

// ---------- Lunch break ----------
// Staff can start a 30-minute lunch. While it's on, nobody can join the list.

const lunchNotice = document.getElementById('lunch-notice');
const lunchBtn = document.getElementById('lunch-btn');
const addBtn = form.querySelector('button');
let lunchUntil = null;

async function loadLunch() {
  try {
    const res = await fetch('/api/lunch');
    if (!res.ok) throw new Error();
    ({ until: lunchUntil } = await res.json());
  } catch {
    // Keep showing whatever we knew last.
  }
  renderLunch();
}

function renderLunch() {
  // Ends on its own once the time passes, even between checks.
  const onLunch = Boolean(lunchUntil && new Date(lunchUntil) > new Date());
  const text = onLunch ? `We're on lunch! Back at ${formatTime(lunchUntil)} — please check back then.` : '';
  // Only touch the page when something changed, so screen readers aren't spammed.
  if (lunchNotice.dataset.text !== text) {
    lunchNotice.dataset.text = text;
    if (onLunch) withIcon(lunchNotice, '🥪', text);
    lunchNotice.hidden = !onLunch;
  }
  input.disabled = onLunch;
  addBtn.disabled = onLunch;
  addBtn.textContent = onLunch ? 'On lunch' : 'Add me';

  lunchBtn.hidden = !adminPassword;
  lunchBtn.textContent = onLunch ? 'Back from lunch' : 'Going to lunch (30 min)';
}

lunchBtn.addEventListener('click', async () => {
  const onLunch = Boolean(lunchUntil && new Date(lunchUntil) > new Date());
  const res = await fetch('/api/lunch', {
    method: onLunch ? 'DELETE' : 'POST',
    headers: { 'X-Admin-Password': adminPassword },
  });
  if (res.ok) {
    lunchUntil = onLunch ? null : (await res.json()).until;
    showMessage(onLunch ? 'Welcome back — people can join again.' : `Enjoy lunch! Joining is paused until ${formatTime(lunchUntil)}.`);
  } else {
    const { error } = await res.json().catch(() => ({}));
    showMessage(error || 'Could not change the lunch setting.', true);
  }
  renderLunch();
});

// ---------- "It's your turn" alert ----------

const turnModal = document.getElementById('your-turn');
const turnName = document.getElementById('your-turn-name');
const pageTitle = document.title;
let activeCall = null;

function checkMyTurn(entries) {
  const mine = entries.find(
    (e) => myTokens[e.id] && e.calledAt && seenCalls[e.id] !== e.calledAt
  );
  if (!mine || (activeCall && activeCall.calledAt === mine.calledAt)) return;
  activeCall = mine;
  turnName.textContent = mine.name;
  turnModal.returnValue = '';
  if (!turnModal.open) turnModal.showModal();
  document.title = "🔔 It's your turn! – Paul Houston Massage";
  if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);
  playChime();
}

turnModal.addEventListener('close', () => {
  // "On my way!" sets returnValue to 'ack'; closing with Escape doesn't send a reply.
  if (activeCall && turnModal.returnValue === 'ack') sendOnMyWay(activeCall);
  if (activeCall) {
    seenCalls[activeCall.id] = activeCall.calledAt;
    // Only keep acknowledgements for entries that are still ours.
    seenCalls = Object.fromEntries(Object.entries(seenCalls).filter(([id]) => myTokens[id]));
    writeStore('waitlist-seen-calls', seenCalls);
    activeCall = null;
  }
  document.title = pageTitle;
});

async function sendOnMyWay(entry) {
  try {
    const res = await fetch(`/api/waitlist/${entry.id}/ack`, {
      method: 'POST',
      headers: { 'X-Remove-Token': myTokens[entry.id] },
    });
    if (!res.ok) throw new Error();
    showMessage("Thanks — Paul knows you're on your way!");
  } catch {
    showMessage("Couldn't send your reply, but please head to the booth.", true);
  }
  load();
}

// A short three-note chime. Browsers may block sound until the visitor has
// tapped the page, so this is a bonus on top of the pop-up and vibration.
function playChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [659.25, 783.99, 1046.5].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = ctx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.3, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.5);
    });
  } catch {
    // No sound available; the pop-up still shows.
  }
}

async function callEntry(entry) {
  const res = await fetch(`/api/waitlist/${entry.id}/call`, {
    method: 'POST',
    headers: { 'X-Admin-Password': adminPassword },
  });
  if (res.ok) {
    showMessage(`Called ${entry.name} to the booth.`);
  } else {
    const { error } = await res.json().catch(() => ({}));
    showMessage(error || `Could not call ${entry.name}.`, true);
  }
  load();
}

async function removeEntry(entry) {
  if (!confirm(`Remove ${entry.name} from the wait list?`)) return;
  const headers = {};
  if (myTokens[entry.id]) headers['X-Remove-Token'] = myTokens[entry.id];
  if (adminPassword) headers['X-Admin-Password'] = adminPassword;
  const res = await fetch(`/api/waitlist/${entry.id}`, { method: 'DELETE', headers });
  if (res.ok || res.status === 404) {
    showMessage(`${entry.name} was removed.`);
  } else {
    const { error } = await res.json().catch(() => ({}));
    showMessage(error || 'Could not remove that name.', true);
  }
  load();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = input.value.trim();
  if (!name) return;
  const res = await fetch('/api/waitlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (res.ok) {
    const entry = await res.json();
    myTokens[entry.id] = entry.removeToken;
    writeStore('waitlist-tokens', myTokens);
    input.value = '';
    showMessage(`Thanks, ${name}! You're on the list.`);
    sparkleBurst(form.querySelector('button'));
  } else {
    const { error } = await res.json().catch(() => ({}));
    showMessage(error || 'Could not add your name.', true);
  }
  load();
});

const findMe = document.getElementById('find-me');
document.getElementById('find-me-btn').addEventListener('click', () => findMe.showModal());
// Close when clicking the backdrop outside the modal box.
findMe.addEventListener('click', (e) => {
  if (e.target === findMe) findMe.close();
});

// Staff mode: Paul logs in with the staff password to remove anyone.
function updateStaffButton() {
  staffBtn.textContent = adminPassword ? 'Staff log out' : 'Staff';
}

staffBtn.addEventListener('click', async () => {
  if (adminPassword) {
    adminPassword = null;
    writeStore('waitlist-admin', null);
    renderLunch();
  } else {
    const password = prompt('Staff password');
    if (!password) return;
    const res = await fetch('/api/admin/check', {
      method: 'POST',
      headers: { 'X-Admin-Password': password },
    });
    if (!res.ok) {
      showMessage('Wrong staff password.', true);
      return;
    }
    adminPassword = password;
    writeStore('waitlist-admin', password);
    showMessage('Staff mode on — you can call or remove anyone.');
  }
  updateStaffButton();
  load();
});

updateStaffButton();

const SPARKLE_CHARS = ['✦', '✧', '★'];

// ---------- Pause / play animations ----------
// Starts paused for people whose device asks for reduced motion; anyone can toggle it.
// The class is first set by the small script in <head> so nothing moves before this runs.
const motionBtn = document.getElementById('motion-btn');

function motionOn() {
  return !document.documentElement.classList.contains('no-motion');
}

function updateMotionButton() {
  motionBtn.textContent = motionOn() ? 'Pause animations' : 'Play animations';
  motionBtn.setAttribute('aria-pressed', String(!motionOn()));
}

motionBtn.addEventListener('click', () => {
  const turnOn = !motionOn();
  document.documentElement.classList.toggle('no-motion', !turnOn);
  writeStore('waitlist-motion', turnOn ? 'on' : 'off');
  if (turnOn && !document.querySelector('.sparkle')) makeSparkles(sparkleCount());
  updateMotionButton();
});

function randomColor() {
  return `var(${colors[Math.floor(Math.random() * colors.length)]})`;
}

// Twinkling sparkles scattered across the page background.
function makeSparkles(count) {
  const layer = document.getElementById('sparkles');
  for (let i = 0; i < count; i++) {
    const s = document.createElement('span');
    s.className = 'sparkle';
    s.textContent = SPARKLE_CHARS[i % SPARKLE_CHARS.length];
    s.style.left = `${Math.random() * 100}%`;
    s.style.top = `${Math.random() * 100}%`;
    // Go through the rainbow in order so every colour shows up evenly.
    s.style.setProperty('--c', `var(${colors[i % colors.length]})`);
    s.style.setProperty('--s', `${11 + Math.random() * 12}px`);
    s.style.setProperty('--d', `${4 + Math.random() * 5}s`);
    s.style.setProperty('--delay', `${-Math.random() * 9}s`);
    layer.append(s);
  }
}

// A quick shower of sparkles flying out from an element.
function sparkleBurst(el) {
  if (!motionOn()) return;
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  for (let i = 0; i < 16; i++) {
    const s = document.createElement('span');
    s.className = 'burst';
    s.setAttribute('aria-hidden', 'true');
    s.textContent = SPARKLE_CHARS[i % 3];
    const angle = (i / 16) * Math.PI * 2;
    const dist = 50 + Math.random() * 50;
    s.style.left = `${cx}px`;
    s.style.top = `${cy}px`;
    s.style.setProperty('--c', randomColor());
    s.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
    s.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
    s.addEventListener('animationend', () => s.remove());
    document.body.append(s);
  }
}

function sparkleCount() {
  return window.innerWidth < 600 ? 14 : 26;
}

updateMotionButton();
if (motionOn()) makeSparkles(sparkleCount());

load();
// Check often so a called person sees their alert within a few seconds,
// and right away when they come back to the tab or unlock their phone.
setInterval(load, 4000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') load();
});
