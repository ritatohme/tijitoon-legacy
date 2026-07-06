// Announcement popup (index page). Fetches announcement.json and, unless that
// announcement was already dismissed, builds the popup DOM and shows it after a
// short delay. Replaces the old popup.html fragment + popup.js pair — one script,
// no runtime HTML include. Styles live in css/popup.css.
(function () {
  fetch('announcement.json?v=' + Date.now())
    .then(r => r.json())
    .then(function (ann) {
      if (!ann.enabled) return;

      const KEY = 'tijitoon_ann_' + ann.id;
      if (localStorage.getItem(KEY)) return;

      // Build popup
      const bd = document.createElement('div');
      bd.id = 'req-backdrop';

      const pp = document.createElement('div');
      pp.id = 'req-popup';
      pp.innerHTML = `
        <div class="req-banner">
          <span>✦ TIJITOON ✦</span>
          <button class="req-x"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="req-body">
          <div class="req-eyebrow"></div>
          <h2 class="req-headline"></h2>
          <p class="req-text"></p>
          <div class="req-actions">
            <a class="req-btn"></a>
            <button class="req-btn-ghost"></button>
          </div>
        </div>`;

      pp.querySelector('.req-eyebrow').textContent  = ann.eyebrow;
      pp.querySelector('.req-headline').textContent = ann.title;
      pp.querySelector('.req-text').textContent     = ann.text;

      const btn = pp.querySelector('.req-btn');
      if (ann.btnUrl) {
        btn.textContent = ann.btnLabel + ' ';
        btn.appendChild(Object.assign(document.createElement('i'), { className: 'fa-solid fa-angle-right' }));
        btn.href = ann.btnUrl;
      } else {
        btn.style.display = 'none';
      }

      const later = pp.querySelector('.req-btn-ghost');
      if (ann.dismissLabel) {
        later.textContent = ann.dismissLabel;
      } else {
        later.style.display = 'none';
      }

      function closePopup() {
        bd.style.display = 'none';
        pp.style.display = 'none';
        bd.classList.remove('req-visible');
        pp.classList.remove('req-visible');
        localStorage.setItem(KEY, '1');
      }

      btn.addEventListener('click', closePopup);
      later.addEventListener('click', closePopup);
      bd.addEventListener('click', closePopup);
      pp.querySelector('.req-x').addEventListener('click', closePopup);

      document.body.appendChild(bd);
      document.body.appendChild(pp);

      setTimeout(function () {
        bd.style.display = 'block';
        pp.style.display = 'block';
        requestAnimationFrame(function () {
          bd.classList.add('req-visible');
          pp.classList.add('req-visible');
        });
      }, 1200);
    })
    .catch(function () { /* no announcement / bad json — silently skip */ });
})();
