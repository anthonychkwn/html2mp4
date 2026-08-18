#!/usr/bin/env node
/**
 * Record a self-contained HTML animation to an MP4, via the real Chrome
 * compositor.
 *
 * Why a screencast and not screenshot-per-frame: page.screenshot() in a loop
 * forces a synchronous paint per call, which stalls rAF-driven and CSS
 * animations and produces judder. Page.startScreencast taps the frames the
 * compositor is already producing, so the timeline runs at true wall-clock
 * speed. The captured frames arrive at irregular intervals, so they are
 * resampled onto a fixed grid afterwards.
 *
 * Usage:
 *   node record.js <input.html> [options]
 *
 * Options:
 *   --out <file>       output mp4            (default out.mp4)
 *   --width <px>       viewport width        (default 1080)
 *   --height <px>      viewport height       (default 1920)
 *   --fps <n>          output frame rate     (default 30)
 *   --duration <sec>   seconds to record     (default 5)
 *   --wait <selector>  wait for this selector before recording
 *   --hide <selector>  display:none these elements before recording
 *   --keep-frames      leave the JPEG frames on disk
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const NUMERIC = new Set(['width', 'height', 'fps', 'duration']);
const INTEGER = new Set(['width', 'height']);
const STRING = new Set(['out', 'wait', 'hide']);

const USAGE =
  'usage: node record.js <input.html> [--out out.mp4] [--fps 30] [--duration 5]';

function parseArgs(argv) {
  const opts = {
    out: 'out.mp4', width: 1080, height: 1920, fps: 30, duration: 5,
    wait: null, hide: null, keepFrames: false,
  };
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep-frames') { opts.keepFrames = true; continue; }
    if (!a.startsWith('--')) { positional.push(a); continue; }

    const key = a.slice(2);
    if (!NUMERIC.has(key) && !STRING.has(key)) throw new Error(`unknown option --${key}`);
    const val = argv[++i];
    if (val === undefined) throw new Error(`--${key} needs a value`);

    if (!NUMERIC.has(key)) { opts[key] = val; continue; }
    const n = Number(val);
    // Number('') is 0 and Number('30px') is NaN; both must be rejected before
    // they reach the frame maths, where they turn into an unreadable failure.
    if (val.trim() === '' || !Number.isFinite(n) || n <= 0) {
      throw new Error(`--${key} needs a positive number, got "${val}"`);
    }
    if (INTEGER.has(key) && !Number.isInteger(n)) {
      throw new Error(`--${key} needs a whole number of pixels, got "${val}"`);
    }
    opts[key] = n;
  }

  if (!positional.length) throw new Error(`no input file given
${USAGE}`);
  if (positional.length > 1) {
    throw new Error(`expected one input file, got ${positional.length}: ${positional.join(' ')}
${USAGE}`);
  }
  opts.input = path.resolve(positional[0]);
  // Chrome happily renders its own error page for a missing file, which would
  // otherwise be recorded as a perfectly valid video of nothing.
  if (!fs.existsSync(opts.input)) throw new Error(`no such file: ${opts.input}`);
  return opts;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  let o;
  try {
    o = parseArgs(process.argv);
  } catch (err) {
    console.error('[error]', err.message);
    process.exit(1);
  }
  const FRAMES = Math.round(o.fps * o.duration);
  const FRAME_MS = 1000 / o.fps;
  const frameDir = path.join(path.dirname(path.resolve(o.out)), '.frames');

  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true });

  // headless:false with an offscreen window: the headless compositor throttles
  // animation frames aggressively, a real window does not.
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--allow-file-access-from-files',
      '--no-sandbox',
      `--window-size=${o.width},${o.height}`,
      '--hide-scrollbars',
      '--window-position=-2400,-2400',
      '--disable-features=Translate',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    defaultViewport: { width: o.width, height: o.height, deviceScaleFactor: 1 },
    protocolTimeout: 120000,
  });

  const page = await browser.newPage();
  const client = await page.target().createCDPSession();
  const url = 'file:///' + o.input.replace(/\\/g, '/');
  console.log('[load]', url);
  await page.goto(url, { waitUntil: 'load' });

  if (o.wait) {
    await page.waitForSelector(o.wait, { timeout: 30000 });
  }
  if (o.hide) {
    await page.evaluate(sel => {
      document.querySelectorAll(sel).forEach(el => { el.style.display = 'none'; });
    }, o.hide);
  }

  const incoming = [];
  let firstTs = null;
  let stopped = false;

  client.on('Page.screencastFrame', async ev => {
    if (stopped) return;
    if (firstTs === null) firstTs = ev.metadata.timestamp;
    incoming.push({ tMs: (ev.metadata.timestamp - firstTs) * 1000, data: ev.data });
    try { await client.send('Page.screencastFrameAck', { sessionId: ev.sessionId }); } catch (_) {}
  });

  await client.send('Page.startScreencast', {
    format: 'jpeg', quality: 92,
    maxWidth: o.width, maxHeight: o.height, everyNthFrame: 1,
  });
  console.log(`[screencast] capturing ${o.duration}s in real time`);
  await sleep(o.duration * 1000 + 300);
  stopped = true;
  await client.send('Page.stopScreencast');
  await browser.close();
  console.log(`[screencast] ${incoming.length} raw frames`);

  if (incoming.length < FRAMES / 2) {
    console.error('[error] too few frames captured; the compositor is not producing real-time output');
    process.exit(1);
  }

  // Resample the irregular screencast stream onto a fixed fps grid by holding
  // the most recent frame at or before each target timestamp.
  let idx = 0;
  for (let i = 0; i < FRAMES; i++) {
    const target = i * FRAME_MS;
    while (idx + 1 < incoming.length && incoming[idx + 1].tMs <= target) idx++;
    fs.writeFileSync(
      path.join(frameDir, 'f' + String(i).padStart(5, '0') + '.jpg'),
      Buffer.from(incoming[idx].data, 'base64'),
    );
  }
  console.log(`[resample] ${FRAMES} frames at ${o.fps}fps`);

  const ff = spawnSync('ffmpeg', [
    '-y', '-framerate', String(o.fps),
    '-i', path.join(frameDir, 'f%05d.jpg'),
    '-c:v', 'libx264', '-crf', '18', '-preset', 'medium',
    '-pix_fmt', 'yuv420p', o.out,
  ], { stdio: 'inherit' });

  if (ff.status !== 0) {
    console.error('[error] ffmpeg failed; frames left in', frameDir);
    process.exit(1);
  }
  if (!o.keepFrames) fs.rmSync(frameDir, { recursive: true, force: true });
  console.log('[done]', o.out);
}

module.exports = { parseArgs };

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
