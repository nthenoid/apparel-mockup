// Converts PDF-compatible .ai, .pdf and .eps artwork to a transparent PNG.
// Ghostscript runs in SAFER mode, with no shell, a time limit, a fixed
// maximum canvas size, and a throwaway temp folder that is always deleted.
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_ACTIVE = 2;
const MAX_SIDE_PX = 4000;
let active = 0;

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function sniff(buf) {
  if (buf.length < 8) return null;
  const head = buf.subarray(0, 5).toString('latin1');
  if (head === '%PDF-') return 'pdf';
  if (head.startsWith('%!PS')) return 'eps';
  if (buf.readUInt32BE(0) === 0xc5d0d3c6) return 'eps'; // DOS binary EPS header
  return null;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30_000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH } }, (err, _o, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr || '').slice(0, 500) }));
      else resolve();
    });
  });
}

export async function convertVector(buf) {
  const type = sniff(buf);
  if (!type) {
    throw new UserError(
      'This file isn’t a PDF-compatible .ai, a .pdf or an .eps. In Illustrator, save with “Create PDF Compatible File” turned on, or export a PNG or SVG.'
    );
  }
  if (active >= MAX_ACTIVE) throw new UserError('The converter is busy. Try again in a few seconds.', 503);
  active++;
  let dir;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'conv-'));
    const input = path.join(dir, type === 'pdf' ? 'in.pdf' : 'in.eps');
    const output = path.join(dir, 'out.png');
    await writeFile(input, buf, { mode: 0o600 });
    const args = [
      '-dSAFER',
      '-dBATCH',
      '-dNOPAUSE',
      '-dQUIET',
      '-sDEVICE=pngalpha',
      '-dTextAlphaBits=4',
      '-dGraphicsAlphaBits=4',
      '-dFirstPage=1',
      '-dLastPage=1',
      // Render into a fixed-size canvas so a huge page can't exhaust memory.
      `-g${MAX_SIDE_PX}x${MAX_SIDE_PX}`,
      '-dFIXEDMEDIA',
      type === 'pdf' ? '-dPDFFitPage' : '-dEPSFitPage',
      `-sOutputFile=${output}`,
      input,
    ];
    try {
      await run('gs', args);
    } catch (err) {
      if (err.code === 'ENOENT') throw new UserError('Ghostscript isn’t installed in this container.', 500);
      if (err.killed) throw new UserError('This file took too long to convert. Export it as a PNG or SVG instead.', 422);
      throw new UserError('This file couldn’t be converted. Export it as a PNG or SVG instead.', 422);
    }
    return await readFile(output);
  } finally {
    active--;
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
