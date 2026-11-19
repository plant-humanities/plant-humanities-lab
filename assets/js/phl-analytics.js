/*
 * Plant Humanities Lab: GA4 events beyond page views.
 * Loaded by _includes/analytics/google.html (production builds only).
 *
 *   page_not_found       404 page shown and no redirect matched   missing_path, referrer
 *   redirect_404         landed here via the 404 redirect          from_path, to_path
 *   cite_open            Cite This opened                          essay
 *   article_download     PDF or Word download chosen               essay, format
 *   entity_popup_open    Wikidata entity popup opened              essay, qid
 *   essay_read_complete  end of the essay reached after >= 30 s    essay
 *   viewer_interaction   first use of an embedded viewer           essay, viewer
 *
 * Each event is sent at most once per page view (per qid for popups). No
 * personal data is sent; the referrer is reduced to its origin and path.
 */
(function () {
  'use strict';

  if (typeof window.gtag !== 'function') return;
  if (window.entreluma404 && window.entreluma404.redirecting) return;

  var sent = {};
  function send(name, params, onceKey) {
    var key = onceKey || name;
    if (sent[key]) return;
    sent[key] = true;
    window.gtag('event', name, params || {});
  }

  var isEssay = !!document.querySelector('meta[name="citation_title"]');
  var essay = location.pathname;

  /* 404s and recovered redirects */
  if (window.entreluma404 && window.entreluma404.notFound) {
    var ref = '';
    try {
      if (document.referrer) {
        var r = new URL(document.referrer);
        ref = r.origin + r.pathname;
      }
    } catch (e) {}
    send('page_not_found', { missing_path: location.pathname, referrer: ref });
  }

  try {
    var from = sessionStorage.getItem('entreluma:redirected-from');
    if (from) {
      sessionStorage.removeItem('entreluma:redirected-from');
      send('redirect_404', { from_path: from, to_path: location.pathname });
    }
  } catch (e) {}

  if (!isEssay) return;

  /* Clicks: Cite This and article downloads */
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target : null;
    if (!el) return;
    if (el.closest('.js-cite-open')) send('cite_open', { essay: essay });
    var dl = el.closest('[data-export-format]');
    if (dl) {
      var format = dl.getAttribute('data-export-format');
      send('article_download', { essay: essay, format: format }, 'article_download:' + format);
    }
    var action = el.closest('a.trigger[data-action]');
    if (action) viewer(action.getAttribute('data-target'));
  }, true);

  /* Entity popups (Shoelace dropdowns built by entreluma.js) */
  document.addEventListener('sl-show', function (e) {
    var dd = e.target && e.target.closest && e.target.closest('.entity-popup');
    if (!dd) return;
    var qid = dd.getAttribute('data-qid') || '';
    send('entity_popup_open', { essay: essay, qid: qid }, 'entity_popup_open:' + qid);
  });

  /* Embedded viewers: first interaction of any kind on the page */
  function viewerType(frame) {
    var src = (frame && (frame.getAttribute('src') || '')) || '';
    var m = src.match(/\/components\/([\w-]+)\.html/);
    if (m) return m[1];
    if (/youtube|youtu\.be/.test(src)) return 'youtube';
    if (/vimeo/.test(src)) return 'vimeo';
    return 'iframe';
  }
  function viewer(targetId) {
    var frame = targetId ? document.getElementById(targetId) : null;
    send('viewer_interaction', { essay: essay, viewer: viewerType(frame) });
  }
  /* Clicking into an iframe moves focus to it and blurs the window. */
  window.addEventListener('blur', function () {
    setTimeout(function () {
      var a = document.activeElement;
      if (a && a.tagName === 'IFRAME') send('viewer_interaction', { essay: essay, viewer: viewerType(a) });
    }, 0);
  });

  /* Reading to the end, after at least 30 seconds on the page */
  var start = Date.now();
  var MIN_MS = 30000;
  function watchEnd() {
    var body = document.querySelector('.post-content, [data-pagefind-body]');
    if (!body || !('IntersectionObserver' in window)) return;
    var paras = body.querySelectorAll('p');
    var last = paras[paras.length - 1];
    if (!last) return;
    var timer = null;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var wait = MIN_MS - (Date.now() - start);
        if (wait <= 0) {
          send('essay_read_complete', { essay: essay });
          io.disconnect();
        } else if (!timer) {
          /* Reached the end early: re-check once the 30 s have passed. */
          timer = setTimeout(function () {
            timer = null;
            io.unobserve(last);
            io.observe(last);
          }, wait);
        }
      });
    });
    io.observe(last);
  }
  /* entreluma.js restructures the article after load; wait for it. */
  if (document.readyState === 'complete') setTimeout(watchEnd, 1000);
  else window.addEventListener('load', function () { setTimeout(watchEnd, 1000); });
})();
