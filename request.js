const titleInput = document.getElementById('req-title');
const submitBtn  = document.getElementById('req-submit');

let turnstileToken = null;

function onTurnstileSolved(token) {
  turnstileToken = token;
  updateSubmit();
}

function onTurnstileExpired() {
  turnstileToken = null;
  updateSubmit();
}

function updateSubmit() {
  submitBtn.disabled = !titleInput.value.trim() || !turnstileToken;
}

titleInput.addEventListener('input', updateSubmit);
updateSubmit();

const BTN_LABEL = 'ENVOYER <i class="fa-solid fa-angle-right"></i>';
const success = document.getElementById('req-success');
let successTimer;

document.getElementById('req-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  if (!titleInput.value.trim() || !turnstileToken) return;

  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

  const formData = new FormData(this);
  formData.set('cf-turnstile-response', turnstileToken);

  try {
    const res = await fetch('https://formspree.io/f/mjgddkqp', {
      method: 'POST',
      body: formData,
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error('bad response');

    this.reset();
    turnstileToken = null;
    if (window.turnstile) turnstile.reset('#req-turnstile');
    success.classList.add('visible');
    clearTimeout(successTimer);
    successTimer = setTimeout(() => success.classList.remove('visible'), 4000);
  } catch (_) {
    alert("Une erreur est survenue. Réessaie plus tard.");
    if (window.turnstile) turnstile.reset('#req-turnstile');
  } finally {
    submitBtn.innerHTML = BTN_LABEL;
    updateSubmit();
  }
});
