// Resolving __dirname from import.meta.url yields a leading-slash path on
// Windows ("/C:/..."), which breaks every fs call. Strip it once, here.
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');

export const ROOT = path.resolve(decodeURIComponent(here), '..');
