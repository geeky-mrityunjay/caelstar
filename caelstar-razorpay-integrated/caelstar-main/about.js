/* =====================================================================
   CAELSTAR — about.js  (stand-alone: only used by about.html)
   Handles: scroll progress bar, header style, reveal-on-scroll,
   word-by-word statement, product-tile drift, mobile menu.
   No libraries, no data file: works when you just open about.html.
   ===================================================================== */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const reduceMotion = matchMedia('(prefers-reduced-motion:reduce)').matches;

  // Footer year
  const year = $('#year'); if (year) year.textContent = new Date().getFullYear();

  // Scroll-highlight statement: [data-scrub] text, **bold** and *italic* markers
  $$('[data-scrub]').forEach(el => {
    const text = el.dataset.scrub, re = /(\*\*[^*]+\*\*|\*[^*]+\*|[^*]+)/g;
    let html = '', m;
    while ((m = re.exec(text))) {
      let part = m[0], cls = '';
      if (part.startsWith('**')) { cls = ' b'; part = part.slice(2, -2); }
      else if (part[0] === '*') { cls = ' i'; part = part.slice(1, -1); }
      part.split(/\s+/).filter(Boolean).forEach(w => { html += '<span class="w' + cls + '">' + w + '</span> '; });
    }
    el.setAttribute('aria-label', text.replace(/\*/g, ''));
    el.innerHTML = html;
  });

  // Reveal on scroll
  const io = new IntersectionObserver(entries => entries.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }), { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
  $$('.rv').forEach((el, i) => { el.style.transitionDelay = (i % 3) * 80 + 'ms'; io.observe(el); });

  // Mobile menu
  const burger = $('#burger'), menu = $('#menu');
  const setMenu = open => { menu.classList.toggle('open', open); burger.setAttribute('aria-expanded', String(open)); };
  burger.addEventListener('click', () => setMenu(!menu.classList.contains('open')));
  menu.addEventListener('click', e => { if (e.target.closest('a')) setMenu(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { setMenu(false); burger.focus(); } });

  // One scroll loop
  const header = $('#hdr'), prog = $('#prog'), scrub = $$('.scrub'), drift = $$('[data-speed]');
  function frame() {
    const y = scrollY, vh = innerHeight;
    header.classList.toggle('scrolled', y > 20);
    prog.style.transform = 'scaleX(' + clamp(y / Math.max(1, document.documentElement.scrollHeight - vh), 0, 1) + ')';
    if (!reduceMotion) {
      scrub.forEach(el => {
        const r = el.getBoundingClientRect(); if (r.bottom < 0 || r.top > vh) return;
        const p = clamp((vh * 0.85 - r.top) / (r.height + vh * 0.35), 0, 1), w = el.children, n = w.length;
        for (let i = 0; i < n; i++) w[i].style.opacity = 0.16 + 0.84 * clamp(p * (n + 3) - i, 0, 1);
      });
      // The grey product tile's label drifts as you scroll
      drift.forEach(el => {
        const r = el.parentElement.getBoundingClientRect(); if (r.bottom < -200 || r.top > vh + 200) return;
        el.style.transform = 'translateY(' + (r.top + r.height / 2 - vh / 2) * parseFloat(el.dataset.speed) + 'px)';
      });
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
