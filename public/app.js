const colors = ['--red', '--orange', '--yellow', '--green', '--blue', '--indigo', '--violet'];
const MINUTES_PER_MASSAGE = 15;

const form = document.getElementById('join-form');
const input = document.getElementById('name-input');
const message = document.getElementById('message');
const list = document.getElementById('waitlist');
const count = document.getElementById('count');
const empty = document.getElementById('empty');
const joinWait = document.getElementById('join-wait');

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

function render(entries) {
  list.replaceChildren();
  entries.forEach((entry, i) => {
    const li = document.createElement('li');
    li.style.setProperty('--c', `var(${colors[i % colors.length]})`);

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

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => removeEntry(entry));

    li.append(pos, name, details, remove);
    list.append(li);
  });
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
  const res = await fetch(`/api/waitlist/${entry.id}`, { method: 'DELETE' });
  if (res.ok || res.status === 404) showMessage(`${entry.name} was removed.`);
  else showMessage('Could not remove that name.', true);
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
    input.value = '';
    showMessage(`Thanks, ${name}! You're on the list.`);
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

load();
setInterval(load, 10000);
