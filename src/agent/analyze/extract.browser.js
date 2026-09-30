/* eslint-disable */
// Runs INSIDE the target page (via Playwright page.evaluate). Plain JS, no imports, no closures
// over Node code. Returns a JSON-serializable description of the page.
(function extract(opts) {
  var VH = window.innerHeight;
  var VW = window.innerWidth;
  var MAX_SECTION_CHARS = opts.maxSectionChars || 9000;
  var MAX_SECTIONS = opts.maxSections || 18;
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, META: 1, LINK: 1, HEAD: 1, BR: 0 };

  // ---------------------------------------------------------------- helpers
  function toHex(c) {
    if (!c) return null;
    var m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    var p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    if (p.length === 4 && p[3] < 0.05) return null;
    var hex = '#' + p.slice(0, 3).map(function (n) { return Math.round(n).toString(16).padStart(2, '0'); }).join('');
    if (p.length === 4 && p[3] < 0.98) hex += Math.round(p[3] * 255).toString(16).padStart(2, '0');
    return hex;
  }
  function px(v) { return Math.round(parseFloat(v) || 0); }
  function absRect(el) {
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  }
  function isVisible(el, cs) {
    cs = cs || getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (parseFloat(cs.opacity) === 0 && el.getBoundingClientRect().height < 4) return false;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0 && cs.overflow !== 'visible') return false;
    if (r.width === 0 && r.height === 0 && !el.children.length) return false;
    if (r.right < -5 || r.left > VW + 5) return false; // off-canvas drawers / hidden mobile menus
    return true;
  }
  function firstFamily(ff) {
    return (ff || '').split(',')[0].replace(/["']/g, '').trim();
  }
  function cleanText(t) { return (t || '').replace(/\s+/g, ' ').trim(); }
  function shortHref(href) {
    if (!href) return '';
    try {
      var u = new URL(href, location.href);
      if (u.origin === location.origin) return u.pathname + u.hash;
      return u.href.slice(0, 120);
    } catch (e) { return href.slice(0, 120); }
  }
  function ownText(el) {
    var t = '';
    for (var i = 0; i < el.childNodes.length; i++) if (el.childNodes[i].nodeType === 3) t += el.childNodes[i].textContent;
    return cleanText(t);
  }

  // ---------------------------------------------------------------- assets
  var assets = [];
  var assetByUrl = {};
  function addAsset(url, kind, extra) {
    if (!url || url.indexOf('data:image/gif') === 0) return null;
    if (url.indexOf('data:') === 0 && url.length > 200000) return null;
    var abs;
    try { abs = new URL(url, location.href).href; } catch (e) { return null; }
    if (assetByUrl[abs]) return assetByUrl[abs].id;
    var a = Object.assign({ id: 'img_' + assets.length, url: abs, kind: kind }, extra || {});
    assets.push(a);
    assetByUrl[abs] = a;
    return a.id;
  }
  function bestImgSrc(img) {
    return img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
  }
  function bgUrl(cs) {
    var m = (cs.backgroundImage || '').match(/url\(["']?([^"')]+)["']?\)/);
    return m ? m[1] : null;
  }

  // ---------------------------------------------------------------- serializer
  var budget = 0;
  function describe(el, cs, pcs) {
    var tag = el.tagName.toLowerCase();
    var a = [];
    var r = el.getBoundingClientRect();
    // layout
    if (cs.display.indexOf('flex') >= 0) {
      a.push(cs.flexDirection.indexOf('column') === 0 ? 'flex-col' : 'flex-row');
      if (cs.flexWrap === 'wrap') a.push('wrap');
      if (cs.justifyContent && cs.justifyContent !== 'normal' && cs.justifyContent !== 'flex-start') a.push('justify=' + cs.justifyContent);
      if (cs.alignItems && cs.alignItems !== 'normal' && cs.alignItems !== 'stretch') a.push('items=' + cs.alignItems);
      if (px(cs.columnGap) || px(cs.rowGap)) a.push('gap=' + px(cs.rowGap) + '/' + px(cs.columnGap));
    } else if (cs.display.indexOf('grid') >= 0) {
      var cols = cs.gridTemplateColumns.split(' ').filter(function (s) { return /px|fr|%/.test(s); }).length;
      a.push('grid cols=' + cols);
      if (px(cs.columnGap) || px(cs.rowGap)) a.push('gap=' + px(cs.rowGap) + '/' + px(cs.columnGap));
    }
    if (cs.position === 'sticky' || cs.position === 'fixed') a.push(cs.position);
    // box
    var bg = toHex(cs.backgroundColor);
    if (bg && bg !== toHex(pcs && pcs.backgroundColor)) a.push('bg=' + bg);
    var bu = bgUrl(cs);
    if (bu) { var bid = addAsset(bu, 'bg', { w: Math.round(r.width), h: Math.round(r.height) }); if (bid) a.push('bg-image={{' + bid + '}} size=' + cs.backgroundSize); }
    if (cs.backgroundImage && cs.backgroundImage.indexOf('gradient') >= 0) a.push('bg-gradient="' + cs.backgroundImage.slice(0, 160) + '"');
    var pad = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(px);
    if (pad.some(Boolean)) a.push('pad=' + pad.join(' '));
    if (cs.borderTopLeftRadius.indexOf('%') > 0 && parseFloat(cs.borderTopLeftRadius) >= 40) a.push('radius=9999');
    else if (px(cs.borderTopLeftRadius)) a.push('radius=' + px(cs.borderTopLeftRadius));
    var bw = px(cs.borderTopWidth) || px(cs.borderBottomWidth);
    if (bw && cs.borderTopStyle !== 'none') a.push('border=' + bw + ' ' + (toHex(cs.borderTopColor) || ''));
    else if (px(cs.borderBottomWidth) && cs.borderBottomStyle !== 'none') a.push('border-b=' + px(cs.borderBottomWidth) + ' ' + toHex(cs.borderBottomColor));
    if (cs.boxShadow && cs.boxShadow !== 'none') a.push('shadow');
    if (cs.fontStyle === 'italic' && (!pcs || pcs.fontStyle !== 'italic')) a.push('italic');
    var ml = px(cs.marginLeft), mr = px(cs.marginRight);
    if (ml > 0 && Math.abs(ml - mr) < 2 && r.width < (el.parentElement ? el.parentElement.getBoundingClientRect().width - 4 : VW)) a.push('center');
    else if ((ml > 0 && ml < 80) || (mr > 0 && mr < 80)) a.push('mx=' + ml + ' ' + mr);
    if (/^(section|header|footer|div)$/.test(tag) && (bu || bg) && r.height > 300 && el.children.length <= 3) a.push('min-h=' + Math.round(r.height));
    var mt = px(cs.marginTop), mb = px(cs.marginBottom);
    if (mt > 0 || mb > 0) a.push('m=' + mt + ' ' + mb);
    if (/^(a|span|b|strong|em|i|small|label|code)$/.test(tag) && (cs.display === 'block' || cs.display === 'inline-block')) a.push(cs.display);
    if (/^(ul|ol)$/.test(tag) && cs.listStyleType !== 'none') a.push('list=' + cs.listStyleType);
    if (cs.maxWidth && cs.maxWidth !== 'none' && px(cs.maxWidth) > 0) a.push('max-w=' + px(cs.maxWidth));
    if (bg || bw || /^(img|svg|video|iframe|picture|canvas)$/.test(tag) || (cs.boxShadow && cs.boxShadow !== 'none'))
      a.push('size=' + Math.round(r.width) + 'x' + Math.round(r.height));
    // text style (only when it changes vs parent)
    if (!pcs || cs.fontSize !== pcs.fontSize) a.push('fs=' + px(cs.fontSize));
    if (!pcs || cs.fontWeight !== pcs.fontWeight) a.push('fw=' + cs.fontWeight);
    if (!pcs || cs.color !== pcs.color) a.push('c=' + toHex(cs.color));
    if (!pcs || firstFamily(cs.fontFamily) !== firstFamily(pcs.fontFamily)) a.push('font="' + firstFamily(cs.fontFamily) + '"');
    if (pcs && cs.textAlign !== pcs.textAlign && cs.textAlign !== 'start') a.push('align=' + cs.textAlign);
    if (cs.textTransform !== 'none' && (!pcs || cs.textTransform !== pcs.textTransform)) a.push('tt=' + cs.textTransform);
    if (cs.letterSpacing !== 'normal' && (!pcs || cs.letterSpacing !== pcs.letterSpacing)) a.push('ls=' + cs.letterSpacing);
    if (/^h[1-6]$|^p$/.test(tag) && cs.lineHeight !== 'normal') a.push('lh=' + px(cs.lineHeight));
    // element specifics
    if (tag === 'a') {
      a.push('href="' + shortHref(el.getAttribute('href')) + '"');
      if ((bg || bw) && r.height < 80) a.push('button');
    }
    if (tag === 'img') {
      var id = addAsset(bestImgSrc(el), 'img', { w: Math.round(r.width), h: Math.round(r.height), alt: el.alt || '' });
      a.push('src={{' + id + '}}');
      if (el.alt) a.push('alt="' + cleanText(el.alt).slice(0, 80) + '"');
      if (cs.objectFit && cs.objectFit !== 'fill') a.push('fit=' + cs.objectFit);
    }
    if (tag === 'video' && el.poster) a.push('poster={{' + addAsset(el.poster, 'img', {}) + '}}');
    if (/^(input|textarea|select)$/.test(tag)) {
      if (el.type) a.push('type=' + el.type);
      if (el.placeholder) a.push('placeholder="' + el.placeholder.slice(0, 60) + '"');
    }
    if (el.getAttribute('aria-label')) a.push('aria="' + el.getAttribute('aria-label').slice(0, 60) + '"');
    return '<' + tag + (a.length ? ' ' + a.join(' ') : '') + '>';
  }

  function isPlainWrapper(el, cs) {
    if (!/^(DIV|SPAN|SECTION|ARTICLE)$/.test(el.tagName)) return false;
    if (cs.display.indexOf('flex') >= 0 || cs.display.indexOf('grid') >= 0) return false;
    if (toHex(cs.backgroundColor) || bgUrl(cs) || px(cs.borderTopWidth) || px(cs.paddingTop) || px(cs.paddingLeft)) return false;
    if (ownText(el)) return false;
    return true;
  }

  function serialize(el, depth, pcs, out) {
    if (budget > MAX_SECTION_CHARS) return;
    if (SKIP_TAGS[el.tagName]) return;
    var cs = getComputedStyle(el);
    if (!isVisible(el, cs)) return;
    var tag = el.tagName.toLowerCase();
    var indent = '  '.repeat(depth);

    if (tag === 'svg') {
      var r = el.getBoundingClientRect();
      var label = el.getAttribute('aria-label') || (el.querySelector('title') && el.querySelector('title').textContent) || '';
      var html = el.outerHTML;
      if (r.width <= 48 && r.height <= 48) {
        line(out, indent + '[icon ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' c=' + toHex(cs.color) + (label ? ' "' + label + '"' : '') + ']');
      } else if (html.length < 6000) {
        var sid = addAsset('svg:' + assets.length, 'svg', { svg: html, w: Math.round(r.width), h: Math.round(r.height), alt: label });
        line(out, indent + '<svg src={{' + sid + '}} size=' + Math.round(r.width) + 'x' + Math.round(r.height) + (label ? ' "' + label + '"' : '') + '>');
      } else {
        line(out, indent + '[svg illustration ' + Math.round(r.width) + 'x' + Math.round(r.height) + ']');
      }
      return;
    }
    if (tag === 'iframe') { line(out, indent + '[iframe embed ' + shortHref(el.src) + ']'); return; }

    // collapse styleless single-child wrappers
    var kids = [];
    for (var i = 0; i < el.children.length; i++) kids.push(el.children[i]);
    if (depth > 0 && isPlainWrapper(el, cs) && kids.length === 1) return serialize(kids[0], depth, pcs, out);

    line(out, indent + describe(el, cs, pcs));
    // children incl. text nodes, in order
    var shown = 0;
    var elementKids = 0;
    for (var j = 0; j < el.childNodes.length; j++) {
      var n = el.childNodes[j];
      if (n.nodeType === 3) {
        var t = cleanText(n.textContent);
        if (t) {
          var raw = n.textContent;
          if (/^\s/.test(raw) && j > 0) t = ' ' + t;
          if (/\s$/.test(raw) && j < el.childNodes.length - 1) t = t + ' ';
          line(out, indent + '  "' + t.slice(0, 400) + '"');
        }
      } else if (n.nodeType === 1) {
        elementKids++;
        if (shown >= 30) continue;
        shown++;
        serialize(n, depth + 1, cs, out);
      }
    }
    if (elementKids > shown) line(out, indent + '  …(+' + (elementKids - shown) + ' more similar items)');
  }
  function line(out, s) { out.push(s); budget += s.length + 1; }

  // ---------------------------------------------------------------- segmentation
  function blockKids(el) {
    var res = [];
    for (var i = 0; i < el.children.length; i++) {
      var c = el.children[i];
      if (SKIP_TAGS[c.tagName]) continue;
      var cs = getComputedStyle(c);
      if (!isVisible(c, cs)) continue;
      if (cs.position === 'absolute') continue;
      var r = c.getBoundingClientRect();
      if (r.height < 8 || r.width < VW * 0.3) continue;
      res.push(c);
    }
    return res;
  }
  function stackedVertically(kids) {
    for (var i = 1; i < kids.length; i++) {
      var a = kids[i - 1].getBoundingClientRect(), b = kids[i].getBoundingClientRect();
      if (b.top < a.bottom - 4) return false;
    }
    return true;
  }
  function shouldSplit(el, depth) {
    if (depth > 5) return false;
    var tag = el.tagName;
    if (tag === 'HEADER' || tag === 'FOOTER' || tag === 'NAV') return false;
    var kids = blockKids(el);
    if (kids.length < 2 || !stackedVertically(kids)) return false;
    if (tag === 'MAIN' || el.getAttribute('role') === 'main') return true;
    var h = el.getBoundingClientRect().height;
    var big = kids.filter(function (k) { return k.getBoundingClientRect().height >= 200; }).length;
    return h > VH * 1.3 && big >= 2;
  }

  var root = document.body;
  for (var guard = 0; guard < 10; guard++) {
    var k = blockKids(root);
    if (k.length === 1) root = k[0]; else break;
  }
  var candidates = [];
  (function expand(list, depth) {
    list.forEach(function (el) {
      if (shouldSplit(el, depth)) expand(blockKids(el), depth + 1);
      else candidates.push(el);
    });
  })(blockKids(root), 0);
  if (!candidates.length) candidates = [root];

  // fixed/sticky header that lives outside the flow
  var fixedHeader = null;
  document.querySelectorAll('header, nav, [class*="header" i], [class*="navbar" i]').forEach(function (el) {
    if (fixedHeader) return;
    var cs = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    if ((cs.position === 'fixed' || cs.position === 'sticky') && r.top <= 5 && r.width >= VW * 0.9 && r.height < 220 && isVisible(el, cs)) fixedHeader = el;
  });
  if (fixedHeader && !candidates.some(function (c) { return c === fixedHeader || c.contains(fixedHeader) || fixedHeader.contains(c); })) {
    candidates.unshift(fixedHeader);
  }

  var sections = candidates
    .map(function (el) { return { el: el, rect: absRect(el) }; })
    .sort(function (a, b) { return a.rect.y - b.rect.y; });
  // merge slivers into the previous section
  sections = sections.reduce(function (acc, s) {
    var hasText = cleanText(s.el.innerText).length > 0;
    if (acc.length && (s.rect.h < 24 || (!hasText && s.rect.h < 80))) {
      acc[acc.length - 1].extra = (acc[acc.length - 1].extra || []).concat([s.el]);
      return acc;
    }
    acc.push(s);
    return acc;
  }, []);
  while (sections.length > MAX_SECTIONS) {
    var minI = 1, minH = Infinity;
    for (var q = 1; q < sections.length; q++) {
      var hsum = sections[q].rect.h + sections[q - 1].rect.h;
      if (hsum < minH) { minH = hsum; minI = q; }
    }
    var gone = sections.splice(minI, 1)[0];
    var prev = sections[minI - 1];
    prev.extra = (prev.extra || []).concat([gone.el], gone.extra || []);
  }

  var out = sections.map(function (s, idx) {
    var lines = [];
    budget = 0;
    var rootCs = getComputedStyle(s.el);
    var pageBg = getComputedStyle(document.body);
    serialize(s.el, 0, pageBg, lines);
    (s.extra || []).forEach(function (x) { serialize(x, 0, pageBg, lines); });
    if (budget > MAX_SECTION_CHARS) lines.push('…(truncated)');
    var headings = Array.prototype.slice.call(s.el.querySelectorAll('h1,h2,h3')).map(function (h) { return cleanText(h.innerText); }).filter(Boolean).slice(0, 4);
    var tag = s.el.tagName.toLowerCase();
    var nLinks = s.el.querySelectorAll('a').length;
    var txt = cleanText(s.el.innerText);
    var role = tag === 'header' || s.el === fixedHeader || (idx <= 2 && s.rect.h < 180 && (s.el.querySelector('nav') || nLinks >= 3)) ? 'header'
      : tag === 'footer' || (idx >= sections.length - 2 && (/©|copyright|all rights reserved/i.test(txt) || (idx === sections.length - 1 && nLinks > 6))) ? 'footer' : 'content';
    var bottom = s.rect.y + s.rect.h;
    (s.extra || []).forEach(function (x) { var r = absRect(x); bottom = Math.max(bottom, r.y + r.h); });
    return {
      index: idx,
      tag: tag,
      role: role,
      rect: { x: s.rect.x, y: s.rect.y, w: s.rect.w, h: bottom - s.rect.y },
      bg: toHex(rootCs.backgroundColor),
      position: rootCs.position,
      headings: headings,
      textPreview: cleanText(s.el.innerText).slice(0, 280),
      counts: {
        links: s.el.querySelectorAll('a').length,
        images: s.el.querySelectorAll('img,picture,svg').length,
        buttons: s.el.querySelectorAll('button,a[class*="btn" i],a[class*="button" i]').length,
      },
      dom: lines.join('\n'),
    };
  });

  // ---------------------------------------------------------------- design tokens
  var textColors = {}, bgColors = {}, btnColors = {}, fontsW = {}, sizes = {}, radii = {};
  var all = document.body.querySelectorAll('*');
  var limit = Math.min(all.length, 6000);
  for (var z = 0; z < limit; z++) {
    var e = all[z];
    if (SKIP_TAGS[e.tagName]) continue;
    var cs2 = getComputedStyle(e);
    if (cs2.display === 'none' || cs2.visibility === 'hidden') continue;
    var rr = e.getBoundingClientRect();
    if (!rr.width || !rr.height) continue;
    var tx = ownText(e).length;
    if (tx) {
      var tc = toHex(cs2.color); if (tc) textColors[tc] = (textColors[tc] || 0) + tx;
      var fam = firstFamily(cs2.fontFamily); fontsW[fam] = (fontsW[fam] || 0) + tx;
      var fs = px(cs2.fontSize); sizes[fs] = (sizes[fs] || 0) + tx;
    }
    var bgc = toHex(cs2.backgroundColor);
    if (bgc) {
      bgColors[bgc] = (bgColors[bgc] || 0) + Math.min(rr.width * rr.height, VW * VH * 3);
      if ((e.tagName === 'A' || e.tagName === 'BUTTON') && rr.height < 90) btnColors[bgc] = (btnColors[bgc] || 0) + 1;
    }
    var rad = px(cs2.borderTopLeftRadius);
    if (rad && rad < 60 && (bgc || px(cs2.borderTopWidth))) radii[rad] = (radii[rad] || 0) + 1;
  }
  function top(obj, n) {
    return Object.keys(obj).map(function (k) { return { value: k, weight: Math.round(obj[k]) }; })
      .sort(function (a, b) { return b.weight - a.weight; }).slice(0, n);
  }
  var bodyCs = getComputedStyle(document.body);
  var headingFont = (function () { var h = document.querySelector('h1,h2'); return h ? firstFamily(getComputedStyle(h).fontFamily) : null; })();

  var navLinks = [];
  var headerSec = out.filter(function (x) { return x.role === 'header'; })[0];
  var navEl = document.querySelector('header nav, nav, header') || (headerSec ? sections[headerSec.index].el : null);
  if (navEl) navEl.querySelectorAll('a').forEach(function (a) {
    var t = cleanText(a.innerText); if (t && navLinks.length < 20) navLinks.push({ text: t.slice(0, 40), href: shortHref(a.getAttribute('href')) });
  });

  var icon = document.querySelector('link[rel~="icon"]');
  var ogImage = document.querySelector('meta[property="og:image"]');
  return {
    url: location.href,
    title: document.title,
    lang: document.documentElement.lang || 'en',
    description: (document.querySelector('meta[name="description"]') || {}).content || '',
    favicon: icon ? new URL(icon.getAttribute('href'), location.href).href : null,
    ogImage: ogImage ? ogImage.content : null,
    docHeight: document.documentElement.scrollHeight,
    viewport: { w: VW, h: VH },
    tokens: {
      bodyBg: toHex(bodyCs.backgroundColor) || toHex(getComputedStyle(document.documentElement).backgroundColor) || '#ffffff',
      bodyColor: toHex(bodyCs.color),
      bodyFont: firstFamily(bodyCs.fontFamily),
      headingFont: headingFont,
      textColors: top(textColors, 8),
      bgColors: top(bgColors, 8),
      buttonColors: top(btnColors, 5),
      fonts: top(fontsW, 5),
      fontSizes: top(sizes, 8),
      radii: top(radii, 4),
    },
    fontLinks: Array.prototype.slice.call(document.querySelectorAll('link[href*="fonts.googleapis.com"], link[href*="use.typekit.net"], link[href*="fonts.bunny.net"]')).map(function (l) { return l.href; }),
    nav: navLinks,
    sections: out,
    assets: assets,
  };
})
