/* =====================================================================
   CAELSTAR — script.js
   =====================================================================
   FOR ENGINEERS: ARCHITECTURE IN 60 SECONDS

   Content  -> data.json   (all copy, lists, links, icons)
   Markup   -> index.html  (structure + data-* mount points + <template>s)
   Design   -> style.css   (tokens in :root)
   Logic    -> this file   (never contains copy; only reads data.json)

   STATE FLOW
     data.json --fetch--> `data` (read-only object)
        -> renderContent():  fills every data-* mount point in index.html
        -> renderMarquee / renderComparison / renderScrubText / renderStory:
           the few widgets that need custom markup
        -> initMotion():     smooth scroll + reveal/counter observers
        -> initRouter():     shows one .view per URL hash (#/, #/services ...)
        -> initInteractions: newsletter, seller form, easter eggs
        -> frame loop:       one requestAnimationFrame drives all scroll motion
     Nothing is ever written back to `data`. To change content, edit data.json.

   MOUNT ATTRIBUTES (used in index.html, resolved by bindElement)
     data-text="a.b"          textContent from data.json path a.b
     data-html="a.b"          same, with **bold** / *italic* markers -> <b>/<em>
     data-tpl="Hi {a.b}"      textContent from a text template
     data-attr="x={a.b}|y=…"  set attributes; {#} = item number, {@a.b} = from root
     data-icon="icon"         inject an SVG icon (paths live in data.json > icons)
     data-flag="a.b"          remove the element when a.b is empty/false
     data-class-from="a"      add the class named by value a (e.g. "dark")
     data-class-flag="a:cls"  add class `cls` when a is truthy
     data-list="a.b" data-template="id" [data-limit-from="a.b"]
                              repeat <template id="id"> once per item
     data-scrub="a.b"         word-by-word scroll-highlight text

   POINTS OF CONTACT FOR NEW FEATURES
     New text / list item ........ edit data.json only
     New repeated block .......... add a <template> + data-list in index.html
     New page .................... add <div class="view" id="v-NAME"> in
                                   index.html and an entry in data.json > nav
     New scroll effect ........... add an update…() function, call it from frame()
     New custom widget ........... add a render…() function, call it in renderContent()
   ===================================================================== */

(function () {
  'use strict';

  /* ---------------------------------------------------------------
     0. SETTINGS (behaviour constants, not content)
     --------------------------------------------------------------- */
  const DATA_URL = 'data.json';
  const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;
  const HEADER_OFFSET = 84;           // px kept clear above anchors when scrolling
  const TOAST_MS = 3200;
  const reduceMotion = matchMedia('(prefers-reduced-motion:reduce)').matches;

  // Positions of the constellation stars (x, y inside the 800x460 canvas).
  // One star is drawn per service, up to the number of points listed here.
  const STAR_POINTS = [[60, 370], [150, 260], [235, 340], [330, 210], [420, 290],
                       [510, 160], [590, 240], [680, 110], [750, 60]];

  /* ---------------------------------------------------------------
     1. SMALL HELPERS
     --------------------------------------------------------------- */
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const clamp = (x, min, max) => Math.max(min, Math.min(max, x));

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // "**bold**" -> <b>, "*italic*" -> <em> (headings use these for styling)
  function richText(text) {
    return escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>');
  }

  let data = null;   // the parsed data.json (set once in boot)

  /* ---------------------------------------------------------------
     2. CONTENT ENGINE: data.json -> DOM
     --------------------------------------------------------------- */

  // Find a value by path. "." = the current item, "@a.b" = from the data root.
  function lookup(path, scope) {
    path = path.trim();
    if (path === '.') return scope;
    let source = scope;
    if (path[0] === '@') { source = data; path = path.slice(1); }
    return path.split('.').reduce((obj, key) => (obj == null ? undefined : obj[key]), source);
  }

  // Replace {path} placeholders inside a text template.
  function interpolate(template, scope, index) {
    return template.replace(/\{([^}]+)\}/g, (_, path) => {
      if (path === '#') return index + 1;
      const value = lookup(path, scope);
      return value == null ? '' : value;
    });
  }

  function iconSvg(name) {
    const path = data.icons[name];
    return path ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + path + '"/></svg>' : '';
  }

  // Apply every data-* attribute found on one element.
  function bindElement(el, scope, index) {
    const d = el.dataset;
    if ('flag' in d && !lookup(d.flag, scope)) { el.remove(); return; }
    if (d.text) el.textContent = lookup(d.text, scope) ?? '';
    if (d.html) el.innerHTML = richText(lookup(d.html, scope) ?? '');
    if (d.tpl) el.textContent = interpolate(d.tpl, scope, index);
    if (d.icon) el.innerHTML = iconSvg(lookup(d.icon, scope));
    if (d.attr) {
      d.attr.split('|').forEach(pair => {
        const eq = pair.indexOf('=');
        el.setAttribute(pair.slice(0, eq).trim(), interpolate(pair.slice(eq + 1), scope, index));
      });
    }
    if (d.classFrom) { const cls = lookup(d.classFrom, scope); if (cls) el.classList.add(cls); }
    if (d.classFlag) { const [path, cls] = d.classFlag.split(':'); if (lookup(path, scope)) el.classList.add(cls); }
    if (d.list) renderList(el, scope);
  }

  // Bind every mount point inside `root` (a page or a cloned template).
  function bindContent(root, scope, index) {
    const selector = '[data-flag],[data-text],[data-html],[data-tpl],[data-attr],[data-icon],[data-class-from],[data-class-flag],[data-list]';
    $$(selector, root).forEach(el => bindElement(el, scope, index));
  }

  // Repeat a <template> once per list item.
  function renderList(container, scope) {
    const items = lookup(container.dataset.list, scope) || [];
    const template = document.getElementById(container.dataset.template);
    const limitPath = container.dataset.limitFrom;
    const limit = limitPath ? lookup(limitPath, data) : items.length;
    const nodes = items.slice(0, limit).map((item, i) => {
      const clone = template.content.cloneNode(true);
      bindContent(clone, item, i);
      return clone;
    });
    container.replaceChildren(...nodes);
  }

  /* ---------------------------------------------------------------
     3. CUSTOM RENDERERS (widgets that need bespoke markup)
     --------------------------------------------------------------- */

  function renderHead() {
    $('meta[name="description"]').content = data.site.description;
  }

  // Word strip under the hero. Alternates bold / italic; repeated 3x for a seamless loop.
  function renderMarquee() {
    const words = data.home.marquee.map((word, i) => {
      const tag = i % 2 ? 'em' : 'b';
      return '<' + tag + '>' + escapeHtml(word) + '</' + tag + '><u>✦</u>';
    }).join('');
    $('#mq1').innerHTML = ('<span>' + words + '</span>').repeat(3);
  }

  // Plan comparison table. "✓" and "–" get tick / dash styling; the featured plan's column is tinted.
  function renderComparison() {
    const plans = data.plans;
    const featured = plans.findIndex(p => p.featured);
    $('#cmpHead').innerHTML = '<th></th>' + plans.map((p, i) =>
      '<th' + (i === featured ? ' class="g"' : '') + '>' + escapeHtml(p.name) + '</th>').join('');
    $('#cmp').innerHTML = data.comparison.map(row =>
      '<tr><td>' + escapeHtml(row.label) + '</td>' + row.values.map((value, i) => {
        const cls = [i === featured ? 'g' : '', value === '✓' ? 'y' : value === '–' ? 'n' : ''].join(' ').trim();
        return '<td' + (cls ? ' class="' + cls + '"' : '') + '>' + escapeHtml(value) + '</td>';
      }).join('') + '</tr>').join('');
  }

  // Statements whose words light up as you scroll. Markers: **bold**, *italic*.
  function renderScrubText() {
    $$('[data-scrub]').forEach(el => {
      const text = lookup(el.dataset.scrub, data);
      const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|[^*]+)/g;
      let html = '', match;
      while ((match = pattern.exec(text))) {
        let part = match[0], cls = '';
        if (part.startsWith('**')) { cls = ' b'; part = part.slice(2, -2); }
        else if (part[0] === '*') { cls = ' i'; part = part.slice(1, -1); }
        part.split(/\s+/).filter(Boolean).forEach(word => {
          html += '<span class="w' + cls + '">' + escapeHtml(word) + '</span> ';
        });
      }
      el.setAttribute('aria-label', text.replace(/\*/g, ''));
      el.innerHTML = html;
    });
  }

  // Constellation SVG: background dust, connecting lines, one star per service.
  let starCount = 0;
  function renderStory() {
    starCount = Math.min(data.services.length, STAR_POINTS.length);
    let svg = '';
    for (let i = 0; i < 46; i++) {
      svg += '<circle cx="' + ((i * 127) % 800) + '" cy="' + ((i * 73 + i * i * 11) % 460) + '" r="' +
             (0.6 + (i % 3) * 0.5) + '" fill="#fff" opacity="' + (0.15 + (i % 4) * 0.1) + '"/>';
    }
    for (let i = 0; i < starCount - 1; i++) {
      const [x1, y1] = STAR_POINTS[i], [x2, y2] = STAR_POINTS[i + 1];
      const length = Math.hypot(x2 - x1, y2 - y1);
      svg += '<line id="ln' + i + '" x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 +
             '" stroke="#83CFC0" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="' + length +
             '" stroke-dashoffset="' + length + '" data-l="' + length + '"/>';
    }
    for (let i = 0; i < starCount; i++) {
      svg += '<g class="sg" id="sg' + i + '" style="opacity:0" transform="translate(' + STAR_POINTS[i][0] + ' ' +
             STAR_POINTS[i][1] + ')"><circle class="h" r="16" fill="#83CFC0" opacity=".3"/>' +
             '<circle r="6" fill="#fff"/><circle r="2.6" fill="#83CFC0"/></g>';
    }
    $('#cst').innerHTML = svg;
  }

  // Runs everything above, in order.
  function renderContent() {
    renderHead();
    bindContent(document, data);
    renderMarquee();
    renderComparison();
    renderScrubText();
    renderStory();
  }

  /* ---------------------------------------------------------------
     4. SMOOTH SCROLL, REVEALS, COUNTERS
     --------------------------------------------------------------- */
  let lenis = null;
  let revealObserver, counterObserver;

  function initMotion() {
    if (window.Lenis && !reduceMotion) {
      lenis = new Lenis({ duration: 1.25, smoothWheel: true, easing: t => Math.min(1, 1.001 - Math.pow(2, -10 * t)) });
    } else {
      document.documentElement.style.scrollBehavior = 'smooth';
    }

    // Fade-up elements (.rv) get class "in" once visible.
    revealObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('in');
        revealObserver.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });

    // Number counters (.cnt) count up to data-n.
    counterObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        counterObserver.unobserve(entry.target);
        countUp(entry.target, +entry.target.dataset.n);
      });
    }, { threshold: 0.6 });
  }

  function countUp(el, target) {
    const start = performance.now();
    (function step(now) {
      const p = Math.min(1, (now - start) / 1200);
      el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
    })(start);
  }

  const scrollToTop = () => (lenis ? lenis.scrollTo(0, { immediate: true }) : window.scrollTo(0, 0));
  function scrollToElement(el) {
    const y = el.getBoundingClientRect().top + scrollY - HEADER_OFFSET;
    lenis ? lenis.scrollTo(y, { duration: 1.4 }) : window.scrollTo({ top: y, behavior: 'smooth' });
  }

  /* ---------------------------------------------------------------
     5. MOBILE MENU
     --------------------------------------------------------------- */
  const header = $('#hdr'), burger = $('#burger'), menu = $('#menu');
  function closeMenu() { menu.classList.remove('open'); burger.setAttribute('aria-expanded', 'false'); }
  function initMenu() {
    burger.addEventListener('click', () => {
      burger.setAttribute('aria-expanded', menu.classList.toggle('open'));
    });
  }

  /* ---------------------------------------------------------------
     6. ROUTER: one .view visible per URL hash
     --------------------------------------------------------------- */
  let currentView = null;       // the visible .view element
  let parallaxEls = [];         // [data-speed] elements in the current view
  let scrubEls = [];            // .scrub statements in the current view

  function currentViewName() {
    const names = data.nav.map(n => n.view).filter(v => v !== 'home');
    const match = location.hash.match(new RegExp('^#/(' + names.join('|') + ')'));
    return match ? match[1] : 'home';
  }

  function route() {
    const name = currentViewName();
    $$('.view').forEach(v => v.classList.toggle('on', v.id === 'v-' + name));
    $$('.menu a').forEach(a => a.classList.toggle('on', a.dataset.v === name));

    const navItem = data.nav.find(n => n.view === name);
    document.title = name === 'home' ? data.site.homeTitle : navItem.label + ' — ' + data.site.name;

    currentView = $('#v-' + name);
    scrollToTop();
    parallaxEls = $$('[data-speed]', currentView);
    scrubEls = $$('.scrub', currentView);

    $$('.rv:not(.in)', currentView).forEach((el, i) => {
      el.style.transitionDelay = (i % 3) * 90 + 'ms';
      revealObserver.observe(el);
    });
    $$('.cnt', currentView).forEach(el => { el.textContent = '0'; counterObserver.observe(el); });
    closeMenu();
  }

  function initRouter() {
    addEventListener('hashchange', route);
    // Links marked data-s scroll to an on-page section (e.g. #contact) instead of changing page.
    document.addEventListener('click', e => {
      const link = e.target.closest('a[data-s]');
      if (!link) return;
      e.preventDefault();
      const target = document.getElementById(link.getAttribute('href').slice(1));
      if (target) scrollToElement(target);
      closeMenu();
    });
    route();
  }

  /* ---------------------------------------------------------------
     7. SCROLL-DRIVEN UPDATES (each called once per frame)
     --------------------------------------------------------------- */
  const dom = {};   // cached elements, filled in cacheDom()
  let marqueeWidth = 0, marqueeDrift = 0, heroRadius = 44;

  function cacheDom() {
    ['prog', 'panel', 'rings', 'globe', 'mq1', 'rail', 'story', 'cc', 'cn', 'cd'].forEach(id => { dom[id] = document.getElementById(id); });
    heroRadius = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--radius-panel')) || 44;
  }

  function updateHeader(y) { header.classList.toggle('scrolled', y > 20); }

  function updateProgressBar(y, vh) {
    const max = Math.max(1, document.documentElement.scrollHeight - vh);
    dom.prog.style.transform = 'scaleX(' + clamp(y / max, 0, 1) + ')';
  }

  // Home hero: panel shrinks, globe rings rotate, marquee drifts.
  function updateHero(y) {
    if (!currentView || currentView.id !== 'v-home') return;
    const p = clamp(y / 700, 0, 1);
    dom.panel.style.transform = 'scale(' + (1 - p * 0.05) + ')';
    dom.panel.style.borderRadius = (heroRadius + p * 20) + 'px';
    dom.rings.style.transform = 'rotate(' + y * 0.06 + 'deg)';
    dom.globe.style.transform = 'rotate(' + -y * 0.04 + 'deg)';
    marqueeDrift += 0.35;
    if (!marqueeWidth) marqueeWidth = dom.mq1.scrollWidth / 3;
    dom.mq1.style.transform = 'translateX(' + -((y * 0.45 + marqueeDrift) % (marqueeWidth || 1)) + 'px)';
  }

  // Elements with data-speed float at different speeds (parallax). Off for floating cards on phones.
  function updateParallax(vh) {
    parallaxEls.forEach(el => {
      if (innerWidth <= 640 && el.classList.contains('fc')) { el.style.transform = ''; return; }
      const r = el.getBoundingClientRect();
      if (r.bottom < -200 || r.top > vh + 200) return;
      el.style.transform = 'translateY(' + (r.top + r.height / 2 - vh / 2) * parseFloat(el.dataset.speed) + 'px)';
    });
  }

  // Statement words fade in one by one.
  function updateScrubText(vh) {
    scrubEls.forEach(el => {
      const r = el.getBoundingClientRect();
      const p = clamp((vh * 0.85 - r.top) / (r.height + vh * 0.35), 0, 1);
      const words = el.children, n = words.length;
      for (let i = 0; i < n; i++) words[i].style.opacity = 0.16 + 0.84 * clamp(p * (n + 3) - i, 0, 1);
    });
  }

  // The vertical line beside "three steps" fills as you scroll.
  function updateStepsRail(vh) {
    if (!dom.rail || !dom.rail.offsetParent) return;
    const r = dom.rail.parentNode.getBoundingClientRect();
    dom.rail.style.transform = 'scaleY(' + clamp((vh * 0.6 - r.top) / r.height, 0, 1) + ')';
  }

  // Constellation: lines draw and stars light up with scroll progress through #story.
  let storyKey = '';
  function updateStory() {
    const story = dom.story;
    const r = story.getBoundingClientRect();
    if (r.bottom < -50 || r.top > innerHeight + 50) return;

    const sticky = story.firstElementChild;
    const p = clamp(-(r.top - 76) / (r.height - sticky.offsetHeight), 0, 1);
    const t = p * starCount, active = Math.min(starCount - 1, Math.floor(t)), done = p > 0.96;

    for (let i = 0; i < starCount - 1; i++) {
      const line = document.getElementById('ln' + i);
      line.style.strokeDashoffset = line.dataset.l * (1 - clamp(t - i, 0, 1));
    }
    for (let i = 0; i < starCount; i++) {
      const star = document.getElementById('sg' + i);
      star.style.opacity = (i === 0 ? t > 0.02 : t >= i - 0.02) ? 1 : 0;
      star.classList.toggle('act', i === active && !done);
    }

    const key = done ? 'done' : active;
    if (key === storyKey) return;       // only touch the caption when the step changes
    storyKey = key;
    if (done) {
      dom.cc.textContent = starCount + ' of ' + starCount;
      dom.cn.innerHTML = richText(data.story.doneTitle);
      dom.cd.textContent = data.story.doneText;
    } else {
      const service = data.services[active];
      const words = service.title.split(' ');
      dom.cc.textContent = (active + 1) + ' of ' + starCount;
      dom.cn.innerHTML = '<b>' + escapeHtml(words.shift()) + '</b> ' + escapeHtml(words.join(' '));
      dom.cd.textContent = service.summary;
    }
  }

  // One loop drives all scroll motion.
  function frame(time) {
    if (lenis) lenis.raf(time);
    const y = scrollY, vh = innerHeight;
    updateHeader(y);
    updateProgressBar(y, vh);
    if (!reduceMotion) {
      updateHero(y);
      updateParallax(vh);
      updateScrubText(vh);
      updateStepsRail(vh);
    }
    updateStory();
    requestAnimationFrame(frame);
  }

  /* ---------------------------------------------------------------
     8. INTERACTIONS: forms and easter eggs
     --------------------------------------------------------------- */
  let toastTimer;
  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), TOAST_MS);
  }

  function starShower(count) {
    const layer = document.createElement('div');
    layer.className = 'fall';
    for (let i = 0; i < count; i++) {
      const star = document.createElement('i');
      star.textContent = '✦';
      star.style.left = Math.random() * 100 + '%';
      star.style.fontSize = 12 + Math.random() * 26 + 'px';
      star.style.animationDuration = 2 + Math.random() * 2.2 + 's';
      star.style.animationDelay = Math.random() * 0.8 + 's';
      layer.appendChild(star);
    }
    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), 5200);
  }

  function setMessage(el, text, kind) { el.textContent = text; el.className = 'msg ' + kind; }

  function initNewsletter() {
    const copy = data.footer.newsletter;
    $('#nb').addEventListener('click', () => {
      const valid = EMAIL_PATTERN.test($('#nm').value.trim());
      setMessage($('#nmsg'), valid ? copy.successMessage : copy.errorMessage, valid ? 'ok' : 'err');
    });
  }

  function initSellerForm() {
    const form = data.pricingPage.seller.form;
    $('#sb').addEventListener('click', () => {
      const name = $('#sn').value.trim(), email = $('#se').value.trim(), business = $('#sbz').value.trim();
      const message = $('#smsg');
      if (!name || !EMAIL_PATTERN.test(email)) { setMessage(message, form.errorMessage, 'err'); return; }
      setMessage(message, form.successMessage, 'ok');
      location.href = 'mailto:' + data.site.email + '?subject=' + encodeURIComponent(form.mailSubject) +
        '&body=' + encodeURIComponent('Name: ' + name + '\nEmail: ' + email + '\nBusiness: ' + business);
    });
  }

  function initEasterEggs() {
    // Click any logo five times quickly.
    let clicks = 0, resetTimer;
    $$('.logo').forEach(logo => logo.addEventListener('click', () => {
      clicks++;
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => { clicks = 0; }, 1200);
      if (clicks >= 5) { clicks = 0; starShower(60); toast(data.easterEggs.logoToast); }
    }));
    // Hidden star in the footer.
    $('#hs').addEventListener('click', () => {
      starShower(40);
      toast(interpolate(data.easterEggs.hiddenStarToast, data));
    });
    // Click the globe to spin it.
    $('.stage svg.big').addEventListener('click', () => {
      const options = { duration: 1800, easing: 'cubic-bezier(.2,.8,.2,1)' };
      dom.globe.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(720deg)' }], options);
      dom.rings.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(-360deg)' }], options);
      starShower(14);
    });
  }

  /* ---------------------------------------------------------------
     9. BOOT
     --------------------------------------------------------------- */
  function showLoadError(error) {
    console.error(error);
    document.body.innerHTML = '<div class="load-error"><h2>Could not load data.json</h2>' +
      '<p>This site reads its content from <code>data.json</code>. Browsers block that when the page is ' +
      'opened by double-clicking. Run <code>npm start</code> in this folder (or any local web server) ' +
      'and open the address it prints. Also check that data.json is valid JSON.</p></div>';
  }

  async function boot() {
    try {
      const response = await fetch(DATA_URL);
      if (!response.ok) throw new Error(DATA_URL + ' returned ' + response.status);
      data = await response.json();
      renderContent();
    } catch (error) {
      showLoadError(error);
      return;
    }
    cacheDom();
    initMotion();
    initMenu();
    initRouter();
    initNewsletter();
    initSellerForm();
    initEasterEggs();
    addEventListener('resize', () => { marqueeWidth = 0; });
    requestAnimationFrame(frame);
  }

  boot();
})();
