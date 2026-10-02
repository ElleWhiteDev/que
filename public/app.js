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

function render(entries) {
  list.replaceChildren();
  entries.forEach((entry, i) => {
    const li = document.createElement('li');
    li.style.setProperty('--c', `var(${colors[i % colors.length]})`);
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
    wait.className = i === 0 ? 'wait next' : 'wait';
    wait.textContent = formatWait(i);

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

    if (isMine || adminPassword) {
      const remove = document.createElement('button');
      remove.className = 'remove';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => removeEntry(entry));
      li.append(remove);
    }

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
}

async function load() {
  try {
    const res = await fetch('/api/waitlist');
    render(await res.json());
  } catch {
    showMessage('Could not load the wait list.', true);
  }
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
    showMessage('Staff mode on — you can remove anyone.');
  }
  updateStaffButton();
  load();
});

updateStaffButton();

const SPARKLE_CHARS = ['✦', '✧', '★', '·'];
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
    s.style.setProperty('--c', randomColor());
    s.style.setProperty('--s', `${9 + Math.random() * 13}px`);
    s.style.setProperty('--d', `${4 + Math.random() * 5}s`);
    s.style.setProperty('--delay', `${-Math.random() * 9}s`);
    layer.append(s);
  }
}

// A quick shower of sparkles flying out from an element.
function sparkleBurst(el) {
  if (reduceMotion) return;
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  for (let i = 0; i < 16; i++) {
    const s = document.createElement('span');
    s.className = 'burst';
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

if (!reduceMotion) makeSparkles(window.innerWidth < 600 ? 14 : 26);

load();
setInterval(load, 10000);
