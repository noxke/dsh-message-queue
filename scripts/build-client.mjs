#!/usr/bin/env node
/**
 * Wrap a CommonJS browser bundle in the `window.__ModuleLoader__.load` call the DSH web
 * client evaluates. The loader matches `id` against the package name, so the value comes
 * from the caller rather than from the bundle.
 * @module dsh-message-queue/scripts/build-client
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import process from 'node:process';

const USAGE = `Usage: node build-client.mjs --id <package-name> --in <bundle.cjs> --out <client.js> [--keep]

  --id    Package name the module loader matches. Written verbatim into the bundle.
  --in    CommonJS bundle to wrap. When the named path does not exist, the same basename is
          retried with .cjs, .js and .mjs.
  --out   Destination of the wrapped module.
  --keep  Leave the input bundle in place instead of removing it after the wrap.`;

/** A directive prologue; it stays a directive only as the factory body's first statement. */
const DIRECTIVE = /^(['"])use strict\1;?[ \t]*\r?\n/;

/** Source map pointers do not survive the wrap: they describe the bundle, not the wrapper. */
const SOURCE_MAP = /^\/\/[#@] sourceMappingURL=.*$/;

/** Extensions a bundler picks for CommonJS output, in the order they are retried. */
const BUNDLE_EXTENSIONS = ['.cjs', '.js', '.mjs'];

function fail(message) {
  process.stderr.write(`build-client: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { id: undefined, input: undefined, output: undefined, keep: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (arg === '--keep') {
      options.keep = true;
      continue;
    }
    if (arg === '--id' || arg === '--in' || arg === '--out') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        fail(`${arg} needs a value`);
      }
      options[arg === '--id' ? 'id' : arg === '--in' ? 'input' : 'output'] = value;
      index += 1;
      continue;
    }
    fail(`unknown argument ${arg}`);
  }

  if (options.id === undefined) fail('--id is required');
  if (options.input === undefined) fail('--in is required');
  if (options.output === undefined) fail('--out is required');
  if (options.id === '') fail('--id must not be empty');
  return options;
}

/**
 * Build the loader call around a bundle.
 * @param id - package name the loader matches.
 * @param source - CommonJS bundle text.
 * @returns the wrapped module text.
 */
function wrap(id, source) {
  const stripped = source
    .split('\n')
    .filter((line) => !SOURCE_MAP.test(line))
    .join('\n');

  const directive = DIRECTIVE.exec(stripped);
  const body = (directive ? stripped.slice(directive[0].length) : stripped).replace(/\s+$/, '');

  if (body === '') fail('the input bundle is empty');

  const indented = body
    .split('\n')
    .map((line) => (line === '' ? '' : `\t\t${line}`))
    .join('\n');

  const prologue = directive ? "\t\t'use strict';\n" : '';

  return `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(id)},\n\tfactory: (require) => {\n${prologue}\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n${indented}\n\t\treturn module.exports;\n\t},\n});\n`;
}

/**
 * Resolve the bundle to wrap. A bundler emits `.cjs` for CommonJS inside a `"type": "module"`
 * package and `.js` otherwise, so an exact miss is retried with each known extension.
 * @param path - absolute path the caller named.
 * @returns the path that exists, or undefined.
 */
function resolveBundle(path) {
  if (existsSync(path)) return path;

  const stem = path.replace(/\.[^./\\]+$/, '');
  for (const extension of BUNDLE_EXTENSIONS) {
    const candidate = `${stem}${extension}`;
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const options = parseArgs(process.argv.slice(2));
const inputPath = resolveBundle(resolve(options.input));
const outputPath = resolve(options.output);

if (inputPath === undefined) {
  fail(`cannot read ${options.input}: no such file, and none of ${BUNDLE_EXTENSIONS.join(', ')}`);
}

let source;
try {
  source = readFileSync(inputPath, 'utf8');
} catch (error) {
  fail(`cannot read ${options.input}: ${error.message}`);
}

const wrapped = wrap(options.id, source);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, wrapped);
if (!options.keep && inputPath !== outputPath) {
  rmSync(inputPath, { force: true });
}

process.stdout.write(
  `build-client: ${relative(process.cwd(), inputPath)} -> ${options.output} (${wrapped.length} bytes, id ${options.id})\n`,
);
