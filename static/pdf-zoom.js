/* pdf-zoom.js — shared by the PDF viewers of the local dashboards (ValidationsTool, Municipal AI Policy
 * Library, Seattle Contracts Dashboard, Literature Review Workbench). Keep the copies identical.
 *
 * 1. Zoom gestures over a PDF zoom the PDF, not the whole page:
 *    - a trackpad pinch, and the MX Master's thumb wheel set to “Zoom in/out” in Logi Options+, reach the page
 *      as wheel events with ctrlKey set (that is how Chrome reports pinches); ⌘-scroll does the same;
 *    - ⌘+ / ⌘− / ⌘0 while the pointer is over the PDF.
 *    The spot under the pointer stays put. While the gesture runs the pages are scaled with CSS (instant);
 *    when it pauses they are drawn again at the new size.
 * 2. The default size: as wide as the panel, but never larger than the page's real size
 *    (100% = 96 px per inch, the “actual size” of Preview and Acrobat).
 */
(function () {
  'use strict';

  // pdf.js draws 1 PDF point as 1 px at scale 1; real size is 96 px per inch = 96/72 px per point.
  const REAL_SIZE = 96 / 72;

  /** Scale that fits a page `pageWidth` points wide into `available` px, but never above real size. */
  function fitScale(available, pageWidth, realSize = REAL_SIZE) {
    return Math.max(0.1, Math.min(available / pageWidth, realSize));
  }

  /** The zoom shown to the user, where 100% is real size. */
  function percent(scale, realSize = REAL_SIZE) {
    return `${Math.round((scale / realSize) * 100)}%`;
  }

  /** Multiplicative zoom for one wheel event (the curve pdf.js uses for pinches). */
  function wheelFactor(e) {
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 30;          // lines
    else if (e.deltaMode === 2) dy *= 300;    // pages
    return Math.exp(-dy / 100);
  }

  const isZoomWheel = (e) => e.ctrlKey || e.metaKey;

  /** ⌘/Ctrl with + − 0: a zoom factor, 0 for “back to the default size”, or null when not a zoom key. */
  function keyZoom(e) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
    if (e.key === '=' || e.key === '+') return 1.2;
    if (e.key === '-' || e.key === '_') return 1 / 1.2;
    if (e.key === '0') return 0;
    return null;
  }

  /** Calls `fn` (debounced) when `el` changes size — the window, or a panel divider being dragged. */
  function onResize(el, fn, delay = 150) {
    let timer = null;
    let first = true;
    const ro = new ResizeObserver(() => {
      if (first) { first = false; return; }   // it also reports once right away
      clearTimeout(timer);
      timer = setTimeout(fn, delay);
    });
    ro.observe(el);
    return ro;
  }

  /** Tracks whether the pointer is over `el` (for the ⌘+ / ⌘− keys). */
  function hoverFlag(el) {
    const flag = { on: false };
    el.addEventListener('pointerenter', () => { flag.on = true; });
    el.addEventListener('pointerleave', () => { flag.on = false; });
    return flag;
  }

  /**
   * Zoom gestures for a scrolling PDF view drawn by our own code.
   *   container            the scrolling element
   *   content              the element holding the pages (scaled with CSS while a gesture runs)
   *   opts.getScale()      the current pdf.js scale (0 when no PDF is open)
   *   opts.setScale(s, showing)
   *                        draw at scale s (may return a promise); call showing() right before the new
   *                        drawing appears, so the CSS preview is dropped in the same frame
   *   opts.fit()           back to the default size (⌘0)
   *   opts.pages()         the page boxes, in order, each with a data-page attribute
   *   opts.onPreview(s)    optional: e.g. update the zoom label while zooming
   *   opts.min, opts.max   scale limits
   */
  function attach(container, content, opts) {
    const min = opts.min ?? 0.25;
    const max = opts.max ?? 5;
    const hover = hoverFlag(container);
    let g = null;   // the gesture in progress

    // The page under (or nearest below) a point, and where on it the point is.
    function anchorAt(x, y) {
      const pages = opts.pages();
      const page = pages.find((p) => p.getBoundingClientRect().bottom >= y) || pages[pages.length - 1];
      if (!page) return null;
      const r = page.getBoundingClientRect();
      return { key: page.dataset.page, fx: (x - r.left) / r.width, fy: (y - r.top) / r.height };
    }

    function begin(x, y) {
      const base = opts.getScale();
      if (!base) return null;
      const box = container.getBoundingClientRect();
      const c = content.getBoundingClientRect();
      return { base, target: base, px: x - box.left, py: y - box.top, ox: x - c.left, oy: y - c.top, anchor: anchorAt(x, y), timer: null };
    }

    function clearPreview() {
      content.style.transform = '';
      content.style.transformOrigin = '';
    }

    async function commit() {
      const done = g;
      g = null;
      if (Math.abs(done.target - done.base) < 1e-3) { clearPreview(); return; }
      await opts.setScale(done.target, clearPreview);
      clearPreview();
      if (!done.anchor) return;
      const page = opts.pages().find((p) => p.dataset.page === done.anchor.key);
      if (!page) return;
      const r = page.getBoundingClientRect();
      const box = container.getBoundingClientRect();
      container.scrollLeft += (r.left + done.anchor.fx * r.width) - (box.left + done.px);
      container.scrollTop += (r.top + done.anchor.fy * r.height) - (box.top + done.py);
    }

    function zoom(factor, x, y) {
      if (!g) g = begin(x, y);
      if (!g) return;
      g.target = Math.max(min, Math.min(max, g.target * factor));
      content.style.transformOrigin = `${g.ox}px ${g.oy}px`;
      content.style.transform = `scale(${g.target / g.base})`;
      if (opts.onPreview) opts.onPreview(g.target);
      clearTimeout(g.timer);
      g.timer = setTimeout(commit, 200);
    }

    container.addEventListener('wheel', (e) => {
      if (!isZoomWheel(e)) return;
      e.preventDefault();                        // otherwise Chrome zooms the whole page
      zoom(wheelFactor(e), e.clientX, e.clientY);
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (!hover.on) return;
      const f = keyZoom(e);
      if (f === null || !opts.getScale()) return;
      e.preventDefault();
      if (f === 0) { opts.fit(); return; }
      const box = container.getBoundingClientRect();
      zoom(f, box.left + box.width / 2, box.top + Math.min(box.height / 2, 240));
    });
  }

  window.PdfZoom = { REAL_SIZE, fitScale, percent, wheelFactor, isZoomWheel, keyZoom, onResize, hoverFlag, attach };
})();
