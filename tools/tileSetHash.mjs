/**
 * The content address of a sector tile set — the one definition of it.
 *
 * A set ships in a folder named for its own contents,
 * tiles/<key>/<tier>.<setHash8>/, which is what lets a tile be cached forever
 * by a CDN, a service worker or a browser: the pathname promises those exact
 * bytes or a 404. tools/gen-tiles.mjs stamps that name when it cuts a set and
 * tools/publish-tiles.mjs re-derives it from the bytes it is about to publish,
 * so the formula has to be one function: two copies would be two opinions
 * about what a folder name promises, and a set published under a name that
 * does not match its bytes is the one failure the caching model cannot
 * survive.
 *
 * No dependencies on purpose — publishing must not need the asset toolchain
 * (sharp, the sources) that cutting does.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';

/** The tiles of a set, in the order its hash is taken over: `<c>_<r>.webp`
 *  only, sorted as strings. Anything else in the folder is not a tile. */
export const tileNames = (files) => files.filter((f) => /^\d+_\d+\.webp$/.test(f)).sort();

/** SHA-256 of a file, streamed. */
export function fileDigest(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => h.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * A set's identity: the first 8 hex of a SHA-256 over the sorted
 * `<name>\0<file sha256>\n` list of every tile in it. Over the WHOLE set, so
 * one changed tile moves the folder — a partial re-cut cannot hide under a
 * name a client already has cached.
 */
export async function setHash8(dir, files) {
  const h = createHash('sha256');
  for (const name of files) {
    h.update(`${name}\0${await fileDigest(path.join(dir, name))}\n`);
  }
  return h.digest('hex').slice(0, 8);
}
