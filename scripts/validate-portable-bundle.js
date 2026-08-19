#!/usr/bin/env node
'use strict';

/**
 * Validate the portable Persona bundle from a local clone.
 *
 * Usage (from the persona repository root):
 *   node scripts/validate-portable-bundle.js
 *
 * Checks the full Persona → Workflow → Pipeline → List relationship, not just each file's
 * header. A header-only check passes bundles whose refs point at the wrong resource, which
 * the server then rejects at import — this closes that gap so a local publish and a server
 * publish agree on what is portable.
 *
 * Mirrors server/src/services/portable-assets/portable-bundle-validator.ts. That module
 * imports server internals and cannot be reused from a persona clone.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FORBIDDEN_DEFINITION_FIELDS = [
  'pageId',
  'userId',
  'collectionId',
  'pipelineId',
  'listId',
  'actionId',
  'automationId',
  'commandId',
  'recordId',
  'runId',
];

function stableJson({ value }) {
  if (Array.isArray(value)) return `[${value.map((child) => stableJson({ value: child })).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson({ value: child })}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint({ value }) {
  return crypto.createHash('sha256').update(stableJson({ value })).digest('hex');
}

function readJson({ filePath }) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** Collect every value stored under `key`, at any depth. */
function collectRefs({ value, key, found = [] }) {
  if (Array.isArray(value)) {
    value.forEach((child) => collectRefs({ value: child, key, found }));
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  for (const [childKey, child] of Object.entries(value)) {
    if (childKey === key) found.push(child);
    collectRefs({ value: child, key, found });
  }
  return found;
}

function auditLocalIds({ value, kind, issues, pathLabel = '$' }) {
  if (Array.isArray(value)) {
    value.forEach((child, index) => auditLocalIds({ value: child, kind, issues, pathLabel: `${pathLabel}[${index}]` }));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_DEFINITION_FIELDS.includes(key)) {
      issues.push(`${kind}: ${pathLabel}.${key} is environment-local and cannot be in a portable definition.`);
    }
    auditLocalIds({ value: child, kind, issues, pathLabel: `${pathLabel}.${key}` });
  }
}

/**
 * `expectedKeys` is a list because a persona binds one workflow per slash
 * command. Singular relationships pass a one-element list.
 *
 * @returns {Set<string>} the expected keys that were actually referenced.
 */
function checkRef({ owner, refs, refKey, expectedKind, expectedKeys, issues }) {
  const matched = new Set();
  if (refs.length === 0) {
    issues.push(`${owner}: missing ${refKey} to ${expectedKeys.join(' | ')}.`);
    return matched;
  }
  refs.forEach((ref, index) => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
      issues.push(`${owner}.${refKey}[${index}]: reference must be an object.`);
      return;
    }
    if (ref.kind !== expectedKind) {
      issues.push(`${owner}.${refKey}[${index}]: expected kind ${expectedKind}, received ${String(ref.kind)}.`);
      return;
    }
    if (!expectedKeys.includes(ref.resourceKey)) {
      issues.push(`${owner}.${refKey}[${index}]: expected ${expectedKeys.join(' | ')}, received ${String(ref.resourceKey)}.`);
      return;
    }
    matched.add(ref.resourceKey);
  });
  return matched;
}

/**
 * @returns {string[]} issues; empty means the bundle is portable.
 */
function validatePortableBundle({ repoRoot }) {
  const issues = [];

  const registry = readJson({ filePath: path.join(repoRoot, 'references', 'registry.json') });
  if (!registry) return ['references/registry.json is missing or not valid JSON.'];
  if (registry.schemaVersion !== 2 || !Array.isArray(registry.repos)) {
    return ['references/registry.json must be schema v2 with a repos array.'];
  }
  const persona = readJson({ filePath: path.join(repoRoot, 'assets', 'chat-config.json') });
  if (!persona) return [...issues, 'assets/chat-config.json is missing or not valid JSON.'];
  if (persona.schemaVersion !== 2 || !persona.resourceKey) {
    issues.push('assets/chat-config.json must be schema v2 with a resourceKey.');
  }
  auditLocalIds({ value: persona.publishedConfig || {}, kind: 'persona', issues });

  // One workflow per slash command; the Pipeline and List are the shared spine.
  const workflowEntries = [];
  const byKind = {};
  for (const entry of registry.repos) {
    if (!entry || !entry.kind) continue;
    if (entry.kind === 'workflow') {
      workflowEntries.push(entry);
      continue;
    }
    if (byKind[entry.kind]) {
      issues.push(`references/registry.json has more than one ${entry.kind} entry.`);
      continue;
    }
    byKind[entry.kind] = entry;
  }
  if (workflowEntries.length === 0) {
    issues.push('references/registry.json is missing its workflow dependency.');
  }
  for (const kind of ['pipeline', 'list']) {
    if (!byKind[kind]) issues.push(`references/registry.json is missing its ${kind} dependency.`);
  }
  if (registry.repos.length !== workflowEntries.length + 2) {
    issues.push(
      `references/registry.json must contain exactly one Pipeline, one List, and one Workflow per command — expected ${workflowEntries.length + 2}, found ${registry.repos.length}.`,
    );
  }
  if (workflowEntries.length === 0 || !byKind.pipeline || !byKind.list) return issues;

  // Each definition must exist at its declared path, carry a matching portable header, hold
  // no environment-local ids, and match the fingerprint the manifest pinned for it.
  const readDefinition = ({ kind, entry }) => {
    const definition = readJson({ filePath: path.join(repoRoot, entry.path, entry.assetPath) });
    if (!definition) {
      issues.push(`${kind}:${entry.resourceKey}: missing ${entry.path}/${entry.assetPath}.`);
      return null;
    }
    if (definition.schemaVersion !== 2) {
      issues.push(`${kind}:${entry.resourceKey}: ${entry.assetPath} is not schema v2.`);
    }
    if (definition.resourceKey !== entry.resourceKey) {
      issues.push(`${kind}:${entry.resourceKey}: declares resourceKey ${String(definition.resourceKey)}.`);
    }
    auditLocalIds({ value: definition, kind: `${kind}:${entry.resourceKey}`, issues });
    const actual = fingerprint({ value: definition });
    if (entry.definitionFingerprint && entry.definitionFingerprint !== actual) {
      issues.push(`${kind}:${entry.resourceKey}: definitionFingerprint does not match ${entry.assetPath}.`);
    }
    return definition;
  };
  const workflowDefinitions = workflowEntries.map((entry) => readDefinition({ kind: 'workflow', entry }));
  const definitions = {
    pipeline: readDefinition({ kind: 'pipeline', entry: byKind.pipeline }),
    list: readDefinition({ kind: 'list', entry: byKind.list }),
  };
  if (workflowDefinitions.some((definition) => !definition) || !definitions.pipeline || !definitions.list) {
    return issues;
  }

  // The relationship chain — the part a header-only check misses entirely.
  const workflowKeys = workflowEntries.map((entry) => entry.resourceKey);
  const referencedWorkflowKeys = checkRef({
    owner: 'persona',
    refs: collectRefs({ value: persona, key: 'workflowRef' }),
    refKey: 'workflowRef',
    expectedKind: 'workflow',
    expectedKeys: workflowKeys,
    issues,
  });
  for (const key of workflowKeys) {
    if (!referencedWorkflowKeys.has(key)) {
      issues.push(`persona: no slash command references workflow ${key}.`);
    }
  }
  // Not every command drives the Pipeline — a tool or sandbox-skill command
  // legitimately has none — so the requirement is connectivity: at least one
  // workflow reaches it, and any workflow that names one names the shared one.
  let pipelineReferenced = false;
  workflowDefinitions.forEach((definition, index) => {
    const refs = collectRefs({ value: definition, key: 'pipelineRef' });
    if (refs.length === 0) return;
    pipelineReferenced = true;
    checkRef({
      owner: `workflow:${workflowKeys[index]}`,
      refs,
      refKey: 'pipelineRef',
      expectedKind: 'pipeline',
      expectedKeys: [byKind.pipeline.resourceKey],
      issues,
    });
  });
  if (!pipelineReferenced) {
    issues.push(`workflow: no workflow references pipeline ${byKind.pipeline.resourceKey}.`);
  }
  checkRef({
    owner: 'pipeline.storage',
    refs: collectRefs({ value: definitions.pipeline.storage || {}, key: 'listRef' }),
    refKey: 'listRef',
    expectedKind: 'list',
    expectedKeys: [byKind.list.resourceKey],
    issues,
  });
  checkRef({
    owner: 'list.list',
    refs: collectRefs({ value: definitions.list.list || {}, key: 'pipelineRef' }),
    refKey: 'pipelineRef',
    expectedKind: 'pipeline',
    expectedKeys: [byKind.pipeline.resourceKey],
    issues,
  });

  return issues;
}

function findRepoRoot({ startDir }) {
  let current = startDir;
  while (true) {
    if (
      fs.existsSync(path.join(current, 'assets', 'chat-config.json'))
      && fs.existsSync(path.join(current, 'references', 'registry.json'))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

module.exports = { validatePortableBundle, stableJson, fingerprint };

if (require.main === module) {
  const repoRoot = findRepoRoot({ startDir: process.cwd() });
  if (!repoRoot) {
    process.stderr.write('Run this from a cloned Persona repository (assets/chat-config.json + references/registry.json).\n');
    process.exit(1);
  }
  const issues = validatePortableBundle({ repoRoot });
  if (issues.length) {
    issues.forEach((issue) => process.stderr.write(`${issue}\n`));
    process.exit(1);
  }
  process.stdout.write('Portable bundle is valid.\n');
}
