// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* The background colour the person chose (src/site.js), put on the page
   before it is first drawn, so it never flashes the default first. A plain
   script in each page's head, because a module would run too late. */
(function () {
  try {
    var bg = localStorage.getItem('ivx-docs-background');
    if (!bg || !/^#[0-9a-f]{6}$/i.test(bg)) return;
    var root = document.documentElement;
    root.dataset.bg = bg;
    root.style.setProperty('--chosen', bg);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = bg;
  } catch (e) { /* storage blocked: the default it is */ }
})();
