const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { parseArgs } = require('../record.js');

// A file that is guaranteed to exist, for the cases that are not about the input path.
const REAL = path.join(__dirname, '..', 'example', 'bars.html');
const argv = (...rest) => ['node', 'record.js', ...rest];

test('defaults', () => {
  const o = parseArgs(argv(REAL));
  assert.strictEqual(o.out, 'out.mp4');
  assert.strictEqual(o.width, 1080);
  assert.strictEqual(o.height, 1920);
  assert.strictEqual(o.fps, 30);
  assert.strictEqual(o.duration, 5);
  assert.strictEqual(o.wait, null);
  assert.strictEqual(o.hide, null);
  assert.strictEqual(o.keepFrames, false);
  assert.strictEqual(o.input, path.resolve(REAL));
});

test('values are parsed and numbers coerced', () => {
  const o = parseArgs(argv(REAL, '--out', 'a.mp4', '--width', '720', '--height', '720',
    '--fps', '60', '--duration', '2.5', '--wait', '#ready', '--hide', '.ctl', '--keep-frames'));
  assert.strictEqual(o.out, 'a.mp4');
  assert.strictEqual(o.width, 720);
  assert.strictEqual(o.height, 720);
  assert.strictEqual(o.fps, 60);
  assert.strictEqual(o.duration, 2.5);
  assert.strictEqual(o.wait, '#ready');
  assert.strictEqual(o.hide, '.ctl');
  assert.strictEqual(o.keepFrames, true);
});

test('--keep-frames does not swallow the next argument', () => {
  const o = parseArgs(argv(REAL, '--keep-frames', '--fps', '24'));
  assert.strictEqual(o.keepFrames, true);
  assert.strictEqual(o.fps, 24);
});

test('a missing input file is rejected instead of recording a browser error page', () => {
  assert.throws(() => parseArgs(argv('does-not-exist.html')), /no such file/i);
});

test('no input file at all', () => {
  assert.throws(() => parseArgs(argv('--fps', '30')), /input file/i);
});

test('unknown option', () => {
  assert.throws(() => parseArgs(argv(REAL, '--framerate', '30')), /unknown option/i);
});

test('an option with no value is rejected', () => {
  for (const flag of ['--out', '--fps', '--wait']) {
    assert.throws(() => parseArgs(argv(REAL, flag)), /needs a value/i, `${flag} with no value`);
  }
});

test('non-numeric numbers are rejected', () => {
  assert.throws(() => parseArgs(argv(REAL, '--fps', 'thirty')), /positive number/i);
  assert.throws(() => parseArgs(argv(REAL, '--duration', '')), /positive number/i);
});

test('zero and negative numbers are rejected', () => {
  assert.throws(() => parseArgs(argv(REAL, '--fps', '0')), /positive number/i);
  assert.throws(() => parseArgs(argv(REAL, '--duration', '-1')), /positive number/i);
  assert.throws(() => parseArgs(argv(REAL, '--width', '0')), /positive number/i);
});

test('fractional viewport sizes are rejected, fractional fps is allowed', () => {
  assert.throws(() => parseArgs(argv(REAL, '--width', '720.5')), /whole number/i);
  assert.throws(() => parseArgs(argv(REAL, '--height', '1279.5')), /whole number/i);
  assert.strictEqual(parseArgs(argv(REAL, '--fps', '29.97')).fps, 29.97);
});

test('a second positional argument is rejected', () => {
  // catches "-out foo.mp4" (one dash), which would otherwise be read as two inputs
  assert.throws(() => parseArgs(argv(REAL, '-out', 'foo.mp4')), /one input file/i);
});
