const DEFAULTS = { serverUrl: 'https://copimon.onrender.com', roomId: 'default' };

function getSync(keys) { return new Promise(r => chrome.storage.sync.get(keys, r)); }
function setSync(obj) { return new Promise(r => chrome.storage.sync.set(obj, r)); }

(async function init(){
  const cfg = await getSync(DEFAULTS);
  document.getElementById('serverUrl').value = cfg.serverUrl;
  document.getElementById('roomId').value = cfg.roomId;
})();

document.getElementById('save').addEventListener('click', async () => {
  const serverUrl = document.getElementById('serverUrl').value.trim();
  const roomId = document.getElementById('roomId').value.trim() || 'default';
  await setSync({ serverUrl, roomId });
  const successMsg = document.getElementById('successMessage');
  successMsg.style.display = 'block';
  setTimeout(() => { successMsg.style.display = 'none'; }, 3000);
});

document.querySelectorAll('input').forEach(input => {
  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      document.getElementById('save').click();
    }
  });
});


