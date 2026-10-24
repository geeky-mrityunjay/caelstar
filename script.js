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
        -> renderMarquee / renderScrubText / renderStory:
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

  // Service orbit: Caelstar core, one node per service on a ring, plus a side list. All names come from data.catalog.services.
  const ORBIT = { cx: 280, cy: 230, r: 170 };
  const orbitPoint = (i, n) => {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    return [ORBIT.cx + ORBIT.r * Math.cos(a), ORBIT.cy + ORBIT.r * Math.sin(a)];
  };
  let starCount = 0;
  function renderStory() {
    starCount = data.catalog.services.length;
    const { cx, cy, r } = ORBIT, circ = 2 * Math.PI * r;
    let svg = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="#fff" stroke-opacity=".12" stroke-dasharray="2 7"/>' +
              '<circle id="orbp" cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="#83CFC0" stroke-width="2" stroke-linecap="round"' +
              ' transform="rotate(-90 ' + cx + ' ' + cy + ')" stroke-dasharray="' + circ + '" stroke-dashoffset="' + circ + '" data-l="' + circ + '"/>';
    for (let i = 0; i < starCount; i++) {
      const [x, y] = orbitPoint(i, starCount);
      svg += '<line id="ln' + i + '" x1="' + cx + '" y1="' + cy + '" x2="' + x + '" y2="' + y + '" stroke="#83CFC0" stroke-opacity=".55" stroke-width="1.2"' +
             ' stroke-dasharray="' + r + '" stroke-dashoffset="' + r + '" data-l="' + r + '"/>';
    }
    svg += '<g id="core"><circle class="h" cx="' + cx + '" cy="' + cy + '" r="46" fill="#83CFC0" opacity=".18"/>' +
           '<circle cx="' + cx + '" cy="' + cy + '" r="30" fill="#83CFC0"/>' +
           '<text x="' + cx + '" y="' + (cy + 4) + '" text-anchor="middle" font-size="11" font-weight="800" fill="#161616" letter-spacing=".5">' +
           escapeHtml(data.site.name.toUpperCase().slice(0, 9)) + '</text></g>';
    for (let i = 0; i < starCount; i++) {
      const [x, y] = orbitPoint(i, starCount);
      svg += '<g class="sg" id="sg' + i + '" style="opacity:.28" transform="translate(' + x + ' ' + y + ')">' +
             '<circle class="h" r="20" fill="#83CFC0" opacity=".3"/><circle r="15" fill="#161616" stroke="#83CFC0" stroke-width="1.5"/>' +
             '<text y="4.5" text-anchor="middle" font-size="13" font-weight="700" fill="#fff">' + (i + 1) + '</text></g>';
    }
    $('#cst').innerHTML = svg;
    $('#svl').innerHTML = data.catalog.services.map((sv, i) => '<li id="sl' + i + '"><i>' + (i + 1) + '</i>' + escapeHtml(catN(sv, 't')) + '</li>').join('');
  }

  // Runs everything above, in order.
  function renderContent() {
    renderHead();
    bindContent(document, data);
    renderMarquee();
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
    const hash = location.hash.replace(/^#\/?/, '');
    if (/^service-[a-z]+$/.test(hash)) return 'service';
    const match = hash.match(new RegExp('^(' + names.join('|') + ')'));
    return match ? match[1] : 'home';
  }

  function route() {
    const name = currentViewName();
    $$('.view').forEach(v => v.classList.toggle('on', v.id === 'v-' + name));
    $$('.menu a').forEach(a => a.classList.toggle('on', a.dataset.v === (name === 'service' ? 'services' : name)));

    if (name === 'service') renderService(location.hash.replace(/^#\/?service-/, ''));
    const navItem = data.nav.find(n => n.view === name);
    document.title = name === 'home' ? data.site.homeTitle
      : (navItem ? navItem.label : (catCur ? catN(catCur, 't') : 'Service')) + ' — ' + data.site.name;

    currentView = $('#v-' + name);
    scrollToTop();
    parallaxEls = $$('[data-speed]', currentView);
    scrubEls = $$('.scrub', currentView);

    $$('.rv:not(.in)', currentView).forEach((el, i) => {
      el.style.transitionDelay = (i % 3) * 90 + 'ms';
      revealObserver.observe(el);
    });
    // Elements outside the views (the contact panel) are shared by every page.
    $$('#contact .rv:not(.in)').forEach(el => revealObserver.observe(el));
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

  // Orbit: as you scroll, each service joins the core in order; the ring fills and the caption follows.
  let storyKey = '';
  function updateStory() {
    const story = dom.story;
    if (!story.offsetParent) return;      // story lives on the home page only
    const r = story.getBoundingClientRect();
    if (r.bottom < -50 || r.top > innerHeight + 50) return;

    const sticky = story.firstElementChild;
    const p = clamp(-(r.top - 76) / (r.height - sticky.offsetHeight), 0, 1);
    const t = p * starCount, active = Math.min(starCount - 1, Math.floor(t)), done = p > 0.97;

    const ring = document.getElementById('orbp');
    ring.style.strokeDashoffset = ring.dataset.l * (1 - (done ? 1 : clamp((t - 0.5) / starCount, 0, 1)));
    for (let i = 0; i < starCount; i++) {
      const line = document.getElementById('ln' + i);
      line.style.strokeDashoffset = line.dataset.l * (1 - clamp(t - i, 0, 1));
      const star = document.getElementById('sg' + i);
      star.style.opacity = t >= i ? 1 : 0.28;
      star.classList.toggle('act', i === active && !done);
      document.getElementById('sl' + i).className = done || i < active ? 'on' : i === active ? 'act' : '';
    }

    const key = done ? 'done' : active;
    if (key === storyKey) return;       // only touch the caption when the step changes
    storyKey = key;
    if (done) {
      dom.cc.textContent = starCount + ' of ' + starCount;
      dom.cn.innerHTML = richText(data.story.doneTitle);
      dom.cd.textContent = data.story.doneText;
    } else {
      const service = data.catalog.services[active];
      const words = catN(service, 't').split(' ');
      dom.cc.textContent = (active + 1) + ' of ' + starCount;
      dom.cn.innerHTML = '<b>' + escapeHtml(words.shift()) + '</b> ' + escapeHtml(words.join(' '));
      dom.cd.textContent = catN(service, 'd');
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

  /* ---------------------------------------------------------------
     SERVICE TILES + SERVICE PAGES  (content: data.json > catalog)
     Every payment button ends in catPay(). To connect Razorpay, define
       window.caelstarPay = ({service, package, amount, unit, quantity}) => { ...open checkout... }
     Until then a demo checkout window is shown.
     --------------------------------------------------------------- */
  let catL = 'en', catCur = null;
  const catInr = x => '₹' + x.toLocaleString('en-IN');
  const catU = k => data.catalog.ui[catL][k];
  const catUn = x => catL === 'hi' ? (data.catalog.units[x] || x) : x;
  const catN = (sv, k) => (catL === 'hi' && data.catalog.hi[sv.id]) ? data.catalog.hi[sv.id][k] : sv[k];
  const catIcon = k => '<span class="ic" data-k="' + k + '"><svg viewBox="0 0 24 24"><path d="' + data.catalog.icons[k] + '"/></svg></span>';

  function renderTiles() {
    $$('[data-tiles]').forEach(el => {
      el.innerHTML = data.catalog.services.map(sv =>
        '<a class="card tile" href="#service-' + sv.id + '">' + catIcon(sv.ic) + '<h3>' + catN(sv, 't') + '</h3><p>' + catN(sv, 'd') +
        '</p><span class="btn sea">' + catN(sv, 'b') + '<i>↗</i></span></a>').join('');
    });
  }

  function renderService(id) {
    const sv = data.catalog.services.find(x => x.id === id);
    if (!sv) { location.hash = ''; return; }
    catCur = sv;
    const el = $('#svc');
    el.innerHTML = `<button class="back" type="button" id="catBack">${catU('back')}</button>
      <div class="svh">${catIcon(sv.ic)}<div><h1>${catN(sv, 't')}</h1><p class="sub" style="margin:8px 0 0">${catN(sv, 'd')}</p></div></div>
      <div class="blk"><h2>${sv.quote ? catU('scope') : catU('pkg')}</h2><p class="gst" style="margin:0 0 20px">${sv.quote ? catU('qn') : catU('gst')}</p>
      <div class="grid">${sv.pk.map((p, i) => `<article class="card pk${i === 1 ? ' pkf' : ''}">${i === 1 ? `<span class="tag">${catU('pop')}</span>` : ''}<h3>${p[0]}</h3>${sv.quote ? '' : `<div class="amt">${catInr(p[1])} <small>${catUn(p[3] || sv.u)}</small></div>`}${p[4] ? `<div class="qty"><span class="gst">${catU('addp').replace('{a}', catInr(p[4].add))}</span><div class="stp"><button type="button" class="qm" aria-label="Remove page">−</button><b class="qn">1</b><button type="button" class="qp" aria-label="Add page">+</button></div><div class="tot"></div></div>` : ''}<ul class="ben">${p[2].map(f => `<li>${f}</li>`).join('')}</ul><button type="button" class="btn ${i === 1 ? 'sea' : 'dark'}">${sv.quote ? catU('disc') : catU('proc')}</button></article>`).join('')}</div></div>`;
    $('#catBack').onclick = () => { location.hash = ''; };
    el.querySelectorAll('.pk').forEach((card, i) => {
      const p = sv.pk[i]; let q = 1;
      const tot = card.querySelector('.tot'), qn = card.querySelector('.qn');
      const price = () => p[4] ? p[1] + p[4].add * (q - 1) : p[1];
      const upd = () => { qn.textContent = q; tot.textContent = catU('tot').replace('{n}', q).replace('{t}', catInr(price())); };
      if (p[4]) {
        card.querySelector('.qm').onclick = () => { q = Math.max(1, q - 1); upd(); };
        card.querySelector('.qp').onclick = () => { q = Math.min(50, q + 1); upd(); };
        upd();
      }
      card.querySelector('.btn').onclick = () => catPay(sv, p, q, price());
    });
  }

  function catPay(sv, p, qty, amount) {
    qty = qty || 1; amount = amount == null ? p[1] : amount;
    const modal = $('#modal'), box = $('#box');
    const close = () => modal.classList.remove('on');
    if (sv.quote) {   // App development: no payment, send an enquiry
      openGetStarted(sv.id);
      return;
    }
    if (typeof window.caelstarPay === 'function') {
      window.caelstarPay({ service: sv.id, package: p[0], amount: amount, unit: sv.u, quantity: qty });
      return;
    }
    box.innerHTML = `<div class="mh">${catU('mh')}</div><div class="mb"><div class="demo">${catU('demo')}</div><div class="row"><span>${catN(sv, 't')}</span></div><div class="row"><span>${p[0]}${qty > 1 ? ' × ' + qty : ''} ${catU('pkgw')}</span><b>${catInr(amount)}</b></div><div class="gst">${catU('gstinv')}</div><button class="btn sea" id="catOk">${catU('pay')} ${catInr(amount)}</button><button class="btn light" id="catX">${catU('cancel')}</button></div>`;
    modal.classList.add('on');
    $('#catX').onclick = close;
    $('#catOk').onclick = () => {
      box.innerHTML = `<div class="mh">${catU('ok')}</div><div class="mb"><div style="font-size:40px">✅</div><p style="margin:0">${catU('thanks').replace('{p}', p[0])}</p><button class="btn dark" id="catX">${catU('done')}</button></div>`;
      $('#catX').onclick = close;
    };
  }

  /* ---------------------------------------------------------------
     GET STARTED: enquiry form in a pop-up. A static site cannot send mail by itself,
     so Send opens the visitor's email app, and the address can always be copied.
     --------------------------------------------------------------- */
  function openGetStarted(serviceId) {
    const modal = $('#modal'), box = $('#box');
    const close = () => modal.classList.remove('on');
    const email = data.site.email;
    const options = data.catalog.services.map(sv =>
      '<option value="' + escapeHtml(catN(sv, 't')) + '"' + (sv.id === serviceId ? ' selected' : '') + '>' + escapeHtml(catN(sv, 't')) + '</option>').join('');
    box.innerHTML = '<div class="mh">Tell us what you need</div><form class="mb gs" id="gsf" novalidate>' +
      '<label for="gsn">Your name</label><input id="gsn" autocomplete="name">' +
      '<label for="gse">Email</label><input id="gse" type="email" autocomplete="email">' +
      '<label for="gss">Service</label><select id="gss"><option value="Not sure yet">Not sure yet</option>' + options + '</select>' +
      '<label for="gsm">What are you building?</label><textarea id="gsm" rows="3"></textarea>' +
      '<div class="msg" id="gsmsg" role="status"></div>' +
      '<button class="btn sea" type="submit">Send enquiry</button>' +
      '<div class="gst">Or write to us at <b id="gsa">' + escapeHtml(email) + '</b> <button type="button" class="back cp" id="gscp">Copy</button><br>Or call <a href="' + data.site.phoneHref + '"><b>' + escapeHtml(data.site.phone) + '</b></a></div>' +
      '<button class="btn light" type="button" id="gsx">Close</button></form>';
    modal.classList.add('on');
    $('#gsx').onclick = close;
    $('#gscp').onclick = () => {
      const done = () => { $('#gscp').textContent = 'Copied'; };
      try { navigator.clipboard.writeText(email).then(done, () => selectAddress()); } catch (e) { selectAddress(); }
    };
    function selectAddress() {
      const range = document.createRange(); range.selectNodeContents($('#gsa'));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      $('#gscp').textContent = 'Press Ctrl+C';
    }
    $('#gsf').addEventListener('submit', e => {
      e.preventDefault();
      const name = $('#gsn').value.trim(), from = $('#gse').value.trim(), note = $('#gsm').value.trim(), service = $('#gss').value;
      const msg = $('#gsmsg');
      if (!name) { setMessage(msg, 'Please enter your name.', 'err'); return; }
      if (!EMAIL_PATTERN.test(from)) { setMessage(msg, 'Please enter a valid email address.', 'err'); return; }
      setMessage(msg, 'Your email app should open with the details filled in. If nothing opens, copy our address below and send them yourself.', 'ok');
      const body = 'Name: ' + name + '\nEmail: ' + from + '\nService: ' + service + '\n\n' + note;
      location.href = 'mailto:' + email + '?subject=' + encodeURIComponent('Enquiry: ' + service) + '&body=' + encodeURIComponent(body);
    });
    setTimeout(() => $('#gsn').focus(), 50);
  }

  function catSetLang(l) {
    catL = l;
    document.documentElement.lang = l;
    $('#lgn').textContent = l === 'hi' ? 'हिं' : 'EN';
    try { localStorage.setItem('cl', l); } catch (e) {}
    renderTiles();
    renderStory(); storyKey = '';
    if (currentView && currentView.id === 'v-service' && catCur) renderService(catCur.id);
  }

  function initCatalog() {
    const modal = $('#modal'), box = $('#box');
    renderTiles();
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('on'); });
    addEventListener('keydown', e => { if (e.key === 'Escape') modal.classList.remove('on'); });
    $('#lg').addEventListener('click', () => {
      const more = ['বাংলা', 'தமிழ்', 'తెలుగు', 'मराठी', 'ગુજરાતી', 'ಕನ್ನಡ', 'മലയാളം', 'ਪੰਜਾਬੀ', 'ଓଡ଼ିଆ', 'اردو'];
      box.innerHTML = `<div class="mh">Choose your language · अपनी भाषा चुनें</div><div class="mb"><div class="lang"><button class="btn sea" data-l="en">English</button><button class="btn sea" data-l="hi">हिन्दी</button></div><div class="gst">More Indian languages</div><div class="chips">${more.map(x => `<span class="chip">${x}</span>`).join('')}</div><div class="demo">Other languages are shown as a preview and arrive in the full build.</div></div>`;
      modal.classList.add('on');
      box.querySelectorAll('[data-l]').forEach(b => b.onclick = () => { catSetLang(b.dataset.l); modal.classList.remove('on'); });
    });
    // Every "Get Started" button opens the enquiry pop-up.
    document.addEventListener('click', e => {
      if (!e.target.closest('[data-gs]')) return;
      e.preventDefault();
      closeMenu();
      openGetStarted();
    });
    // Package buttons elsewhere (Pricing page) use data-pay="<serviceId>-<packageIndex>".
    document.addEventListener('click', e => {
      const btn = e.target.closest('[data-pay]');
      if (!btn) return;
      e.preventDefault();
      const cut = btn.dataset.pay.lastIndexOf('-');
      const sv = data.catalog.services.find(x => x.id === btn.dataset.pay.slice(0, cut));
      const p = sv && sv.pk[Number(btn.dataset.pay.slice(cut + 1))];
      if (p) catPay(sv, p, 1, p[1]);
    });
    try { const saved = localStorage.getItem('cl'); if (saved && saved !== 'en') catSetLang(saved); } catch (e) {}
  }

  function initNewsletter() {
    const copy = data.footer.newsletter;
    $('#nb').addEventListener('click', () => {
      const valid = EMAIL_PATTERN.test($('#nm').value.trim());
      setMessage($('#nmsg'), valid ? copy.successMessage : copy.errorMessage, valid ? 'ok' : 'err');
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
    initCatalog();
    initRouter();
    initNewsletter();
    initEasterEggs();
    addEventListener('resize', () => { marqueeWidth = 0; });
    requestAnimationFrame(frame);
  }

  boot();
})();
