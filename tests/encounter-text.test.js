// Unit tests for the encounter panel's text-trim helpers in screen.js.
//
// The encounter panel is canvas-rendered, so its song meta line ("artist ·
// tuning · duration") is laid out with ctx.fillText and must be trimmed to fit
// the panel. A prior fixed 34-char trim clipped strings that actually had room
// (e.g. "Vecindad Autopsia · E Standard · 3:45" showed as "...· E Standard ·
// …"). `_encTrimW` replaces it with a width-aware trim driven by
// ctx.measureText.
//
// These helpers depend only on ctx.measureText, so we extract the *real*
// source from screen.js (no copy that could drift) and run it against a fake
// monospace context. That keeps the test offline, fast, and browser-free while
// still exercising the shipped implementation.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf-8');

// Pull a `const <name> = (...) => { ... };` arrow declaration out of the source
// by brace-matching its body, then eval it in isolation and hand back the fn.
function loadHelper(name) {
    const sig = SRC.indexOf('const ' + name + ' =');
    assert.notStrictEqual(sig, -1, name + ' not found in screen.js');
    const open = SRC.indexOf('{', SRC.indexOf('=>', sig));
    let depth = 0, end = -1;
    for (let i = open; i < SRC.length; i++) {
        if (SRC[i] === '{') depth++;
        else if (SRC[i] === '}' && --depth === 0) { end = i; break; }
    }
    assert.notStrictEqual(end, -1, 'could not brace-match body of ' + name);
    const decl = SRC.slice(sig, end + 1);
    // eslint-disable-next-line no-new-func
    return new Function(decl + '; return ' + name + ';')();
}

const _encTrimW = loadHelper('_encTrimW');
const _encTrim = loadHelper('_encTrim');

// Fake monospace ctx: every glyph (including the '…' ellipsis) is one cell.
const CHAR = 10;
const ctx = { measureText: (s) => ({ width: String(s).length * CHAR }) };
const px = (s) => ctx.measureText(s).width;

test.describe('_encTrimW (width-aware trim)', () => {
    test('returns the string untouched when it already fits', () => {
        assert.strictEqual(_encTrimW(ctx, 'abc', 100), 'abc');
    });

    test('keeps a string whose width exactly equals the budget', () => {
        assert.strictEqual(_encTrimW(ctx, 'abcd', 4 * CHAR), 'abcd');
    });

    test('trims with an ellipsis and stays within the pixel budget', () => {
        const out = _encTrimW(ctx, 'abcdefghij', 5 * CHAR);
        assert.ok(out.endsWith('…'), 'expected an ellipsis on a trimmed string');
        assert.ok(px(out) <= 5 * CHAR, 'trimmed text must fit the budget');
    });

    test('keeps the maximum number of characters that fit', () => {
        const budget = 5 * CHAR; // 4 chars + the ellipsis
        const out = _encTrimW(ctx, 'abcdefghij', budget);
        assert.strictEqual(out, 'abcd…');
        // One more source char would overflow — proves it is maximal, not stingy.
        assert.ok(px('abcde…') > budget);
    });

    test('regression: the reported meta line fits the encounter panel width', () => {
        // Panel is ENC_W=512; the meta line sits below the PLAY button so it has
        // the full width minus the 26px right inset and 38px left margin.
        const META_MAX = 512 - 26 - 38; // 448px of room
        const meta = 'Vecindad Autopsia · E Standard · 3:45';
        const out = _encTrimW(ctx, meta, META_MAX);
        assert.strictEqual(out, meta, 'meta line should render in full, not clipped');
        assert.ok(!out.endsWith('…'), 'no ellipsis when the line fits');
    });

    test('coerces nullish input to an empty string', () => {
        assert.strictEqual(_encTrimW(ctx, null, 50), '');
        assert.strictEqual(_encTrimW(ctx, undefined, 50), '');
    });
});

test.describe('_encTrim (fixed char-count trim)', () => {
    test('passes through short strings unchanged', () => {
        assert.strictEqual(_encTrim('hello', 10), 'hello');
    });

    test('trims to n chars with an ellipsis when too long', () => {
        assert.strictEqual(_encTrim('abcdef', 4), 'abc…');
    });

    test('coerces nullish input to an empty string', () => {
        assert.strictEqual(_encTrim(null, 5), '');
    });
});
