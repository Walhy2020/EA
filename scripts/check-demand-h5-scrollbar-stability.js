const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'src', 'admin', 'static', 'demand-h5.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src', 'admin', 'static', 'demand-h5.html'), 'utf8');

function layoutSnapshot({ viewportWidth, scrollbarVisible, supportsScrollbarGutter, mobile }) {
  const reservesScrollbar = supportsScrollbarGutter || (!mobile && !supportsScrollbarGutter);
  const reservedWidth = reservesScrollbar ? 15 : 0;
  const contentWidth = viewportWidth - reservedWidth;
  const layoutWidth = reservesScrollbar ? contentWidth : viewportWidth - (scrollbarVisible ? 15 : 0);
  const shellWidth = Math.min(520, layoutWidth);
  return {
    clientWidth: layoutWidth,
    shellCenter: (layoutWidth - shellWidth) / 2 + shellWidth / 2,
  };
}

assert.match(css, /html\s*\{[\s\S]*?scrollbar-gutter:\s*stable;/, 'html must reserve a stable document scrollbar gutter');
assert.match(css, /@supports not \(scrollbar-gutter: stable\)[\s\S]*?@media \(min-width: 700px\)[\s\S]*?overflow-y:\s*scroll;/, 'legacy desktop fallback must reserve a scrollbar slot');
assert.doesNotMatch(css, /scrollbar-gutter:\s*stable both-edges/, 'do not reserve an unnecessary second gutter');
assert.match(html, /demand-h5\.css\?v=0\.2\.9/, 'CSS cache version must match this release');

for (const viewportWidth of [390, 1280]) {
  const mobile = viewportWidth < 700;
  for (const supportsScrollbarGutter of [true, false]) {
    const before = layoutSnapshot({ viewportWidth, scrollbarVisible: false, supportsScrollbarGutter, mobile });
    const after = layoutSnapshot({ viewportWidth, scrollbarVisible: true, supportsScrollbarGutter, mobile });
    if (!supportsScrollbarGutter && mobile) continue;
    assert.strictEqual(after.clientWidth, before.clientWidth, `client width must stay stable at ${viewportWidth}px`);
    assert.strictEqual(after.shellCenter, before.shellCenter, `shell center must stay stable at ${viewportWidth}px`);
  }
}

console.log('Demand H5 scrollbar stability checks passed: document gutter, desktop fallback, wide/narrow center stability.');
