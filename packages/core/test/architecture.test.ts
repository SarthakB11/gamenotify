/**
 * Architecture rules (LLD §1), enforced as a test. dependency-cruiser cannot parse TypeScript 7 yet
 * (no stable compiler API until 7.1), so the import graph is extracted with a small static scan instead.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '../../..');
const coreSrc = join(repo, 'packages/core/src');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' || name === 'dist' ? [] : walk(p);
    return /\.tsx?$/.test(name) ? [p] : [];
  });

const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

interface Edge {
  from: string;
  to: string; // repo-relative path for local imports, bare specifier otherwise
}

const edgesOf = (file: string): Edge[] => {
  const src = readFileSync(file, 'utf8');
  const out: Edge[] = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = (m[1] ?? m[2]) as string;
    const to = spec.startsWith('.') ? relative(repo, resolve(dirname(file), spec)) : spec;
    out.push({ from: relative(repo, file), to });
  }
  return out;
};

const coreFiles = walk(coreSrc).filter((f) => !f.includes('/testing/'));
const coreEdges = coreFiles.flatMap(edgesOf);
const layer = (p: string) => /^packages\/core\/src\/([^/.]+)/.exec(p)?.[1] ?? 'other';

const violations = (pred: (e: Edge) => boolean) => coreEdges.filter(pred).map((e) => `${e.from} → ${e.to}`);

describe('architecture (hexagonal layering)', () => {
  it('domain depends on nothing but itself', () => {
    expect(violations((e) => layer(e.from) === 'domain' && layer(e.to) !== 'domain')).toEqual([]);
  });

  it('ports only know the domain', () => {
    expect(violations((e) => layer(e.from) === 'ports' && !['domain', 'ports'].includes(layer(e.to)))).toEqual([]);
  });

  it('application never depends on adapters, simulators or the composition root', () => {
    expect(
      violations((e) => layer(e.from) === 'application' && ['infrastructure', 'simulation', 'composition'].includes(layer(e.to))),
    ).toEqual([]);
  });

  it('simulators only use domain + ports (they publish through EventPublisher)', () => {
    expect(violations((e) => layer(e.from) === 'simulation' && !['domain', 'ports', 'simulation'].includes(layer(e.to)))).toEqual(
      [],
    );
  });

  it('core has zero npm dependencies and no Node I/O modules', () => {
    expect(violations((e) => !e.to.startsWith('packages/'))).toEqual([]);
  });

  it('apps import the core only through its public entry points', () => {
    const appEdges = ['apps/server/src', 'apps/demo/src'].flatMap((d) => walk(join(repo, d))).flatMap(edgesOf);
    expect(appEdges.filter((e) => e.to.startsWith('packages/')).map((e) => `${e.from} → ${e.to}`)).toEqual([]);
  });

  it('has no import cycles in the core', () => {
    const graph = new Map<string, string[]>();
    for (const e of coreEdges) {
      const to = e.to.replace(/\.tsx?$/, '');
      const from = e.from.replace(/\.tsx?$/, '');
      graph.set(from, [...(graph.get(from) ?? []), to]);
    }
    const state = new Map<string, 'visiting' | 'done'>();
    const cycles: string[] = [];
    const visit = (n: string, path: string[]) => {
      if (state.get(n) === 'done') return;
      if (state.get(n) === 'visiting') {
        cycles.push([...path.slice(path.indexOf(n)), n].join(' → '));
        return;
      }
      state.set(n, 'visiting');
      for (const m of graph.get(n) ?? []) visit(m, [...path, n]);
      state.set(n, 'done');
    };
    for (const n of graph.keys()) visit(n, []);
    expect(cycles).toEqual([]);
  });

  it('scans a meaningful graph (guards against a broken regex passing vacuously)', () => {
    expect(coreFiles.length).toBeGreaterThan(30);
    expect(coreEdges.length).toBeGreaterThan(80);
  });
});
