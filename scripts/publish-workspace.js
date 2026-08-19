#!/usr/bin/env node
'use strict';

/**
 * Validate and publish a Persona composition workspace from a local clone.
 *
 * Usage (from the persona repository root):
 *   node scripts/publish-workspace.js status
 *   node scripts/publish-workspace.js validate
 *   node scripts/publish-workspace.js publish
 *
 * Child content must already be committed and pushed. This script only advances
 * the persona lock: gitlinks, references/workspace.json, and portable fingerprints.
 *
 * This clone has no database, so it cannot turn a local endpoint id or actionId into a
 * repository. Those edges are carried forward from the previously published
 * references/workspace.json, which records them without storing any local id. Anything
 * that cannot be matched is reported unresolved — never guessed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { validatePortableBundle } = require('./validate-portable-bundle');

const FORBIDDEN = ['appId', 'endpointId', 'actionId', 'pageId', 'userId', 'pipelineId', 'listId', 'collectionId'];

const KIND_DIRECTORY = {
  workflow: 'workflows',
  pipeline: 'pipelines',
  list: 'lists',
  team_agent: 'team-agents',
};

/** Primary asset per kind — the definition the registry pins and the manifest records. */
const PRIMARY_ASSET = {
  pipeline: 'assets/pipeline.json',
  list: 'assets/list.json',
  workflow: 'assets/workflow.json',
  team_agent: 'assets/team-agent.json',
};

/**
 * Every validator a child scaffold ships, run from the child's own directory.
 *
 * `requiresAsset` gates optional ones: a list only validates records when it actually has
 * a data/records.json. A team agent has two validators, not one.
 */
const CHILD_VALIDATORS = {
  pipeline: [
    { script: 'scripts/validate-pipeline.js', run: ['node'], asset: 'assets/pipeline.json' },
  ],
  list: [
    { script: 'scripts/validate-list.js', run: ['node'], asset: 'assets/list.json' },
    { script: 'scripts/validate-records.js', run: ['node'], asset: 'data/records.json', requiresAsset: true },
  ],
  workflow: [
    { script: 'scripts/validate-workflow.ts', run: ['npx', 'tsx'], asset: 'assets/workflow.json' },
  ],
  team_agent: [
    { script: 'scripts/validate-team-agent.ts', run: ['npx', 'tsx'], asset: 'assets/team-agent.json' },
    // Task orchestration is opt-in: a plain team agent (build-basket,
    // submit-order, reserve-slot) ships only assets/team-agent.json, and this
    // validator exits non-zero when handed a path that does not exist.
    { script: 'scripts/validate-task-orchestration.ts', run: ['npx', 'tsx'], asset: 'assets/task-orchestration.json', requiresAsset: true },
  ],
};

function writeOut({ message }) {
  process.stdout.write(`${message}\n`);
}

function writeErr({ message }) {
  process.stderr.write(`${message}\n`);
}

function die({ message, code = 1 }) {
  writeErr({ message });
  process.exit(code);
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
    if (parent === current) {
      die({ message: 'Run this script from a cloned Persona repository (assets/chat-config.json + references/registry.json).' });
    }
    current = parent;
  }
}

function readJson({ filePath }) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

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

function git({ args, cwd, allowFail = false }) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0 && !allowFail) {
    die({ message: result.stderr.trim() || `git ${args.join(' ')} failed` });
  }
  return (result.stdout || '').trim();
}

/**
 * Same as `git`, but throws instead of exiting.
 *
 * The publish sequence must be able to unwind: `die()` terminates the process immediately,
 * which would strand written files, a staged index, and a rewritten `.gitmodules`.
 */
function gitOrThrow({ args, cwd, allowFail = false }) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0 && !allowFail) {
    throw new Error((result.stderr || '').trim() || `git ${args.join(' ')} failed`);
  }
  return (result.stdout || '').trim();
}

function isBuiltin({ value }) {
  return String(value || '').trim().toLowerCase().startsWith('schema-form:');
}

function toReferenceSlug({ value }) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'unnamed';
}

function cleanRemoteUrl({ repositoryUrl }) {
  const trimmed = String(repositoryUrl || '').trim().replace(/\.git$/i, '');
  try {
    const parsed = new URL(trimmed);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return trimmed;
  }
}

function slugFromRemoteUrl({ repositoryUrl }) {
  const cleaned = cleanRemoteUrl({ repositoryUrl });
  try {
    const parsed = new URL(cleaned);
    const parts = parsed.pathname.split('/').filter(Boolean);
    return toReferenceSlug({ value: parts[parts.length - 1] || cleaned });
  } catch {
    return toReferenceSlug({ value: cleaned.split('/').filter(Boolean).pop() || 'unnamed' });
  }
}

/**
 * Mirrors createWorkspaceSlugAllocator on the server. The base slug is only the
 * repository's last path segment, so orgA/intake and orgB/intake collide and would
 * otherwise merge into one node. First remote to claim a slug keeps it — nothing already
 * published moves — and any other remote gets a short digest of its own URL appended.
 */
function createSlugAllocator({ previous } = {}) {
  const claimedBy = new Map();
  const seededSlug = new Map();

  // Seed from the prior manifest keyed on (kind, canonical URL). Without this the bare
  // slug goes to whichever remote discovery reaches first, so inserting a transition or
  // command could move an already-published path.
  for (const node of (previous && previous.nodes) || []) {
    if (!node.path || !node.repositoryUrl || node.portable) continue;
    const slug = node.path.split('/').pop();
    if (!slug) continue;
    const cleaned = cleanRemoteUrl({ repositoryUrl: node.repositoryUrl });
    claimedBy.set(`${node.kind}:${slug}`, cleaned);
    seededSlug.set(`${node.kind}:${cleaned}`, slug);
  }

  return {
    claim({ kind, repositoryUrl }) {
      const cleaned = cleanRemoteUrl({ repositoryUrl });
      const seeded = seededSlug.get(`${kind}:${cleaned}`);
      if (seeded) return seeded;

      const base = slugFromRemoteUrl({ repositoryUrl });
      const baseKey = `${kind}:${base}`;
      const holder = claimedBy.get(baseKey);
      if (!holder) {
        claimedBy.set(baseKey, cleaned);
        seededSlug.set(`${kind}:${cleaned}`, base);
        return base;
      }
      if (holder === cleaned) return base;
      const suffixed = `${base}-${crypto.createHash('sha256').update(cleaned).digest('hex').slice(0, 6)}`;
      claimedBy.set(`${kind}:${suffixed}`, cleaned);
      seededSlug.set(`${kind}:${cleaned}`, suffixed);
      return suffixed;
    },
  };
}

function walkForbidden({ value, pathLabel = '$' }) {
  if (Array.isArray(value)) {
    value.forEach((child, index) => walkForbidden({ value: child, pathLabel: `${pathLabel}[${index}]` }));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN.includes(key)) {
      throw new Error(`${pathLabel}.${key} is environment-local and cannot be stored in references/workspace.json.`);
    }
    walkForbidden({ value: child, pathLabel: `${pathLabel}.${key}` });
  }
}

function parseRegistry({ repoRoot }) {
  const registry = readJson({ filePath: path.join(repoRoot, 'references', 'registry.json') });
  if (registry.schemaVersion !== 2 || !Array.isArray(registry.repos)) {
    throw new Error('references/registry.json must be schema v2 with a repos array.');
  }
  // A persona binds one workflow per slash command; Pipeline and List stay singular.
  const workflowCount = registry.repos.filter((entry) => entry.kind === 'workflow').length;
  const kinds = new Set(registry.repos.map((entry) => entry.kind));
  if (!kinds.has('workflow') || !kinds.has('pipeline') || !kinds.has('list')) {
    throw new Error('references/registry.json must contain at least one workflow, and exactly one pipeline and list.');
  }
  if (registry.repos.length !== workflowCount + 2) {
    throw new Error(
      `references/registry.json must contain exactly one Pipeline, one List, and one Workflow per command — expected ${workflowCount + 2}, found ${registry.repos.length}.`,
    );
  }
  if (registry.repos.some((entry) => entry.kind === 'team_agent')) {
    throw new Error('team_agent is not a portable registry kind. Keep extra repos in workspace.json.');
  }
  return registry;
}

function submoduleHead({ repoRoot, relPath }) {
  const abs = path.join(repoRoot, relPath);
  if (!fs.existsSync(abs)) return null;
  const head = git({ args: ['rev-parse', 'HEAD'], cwd: abs, allowFail: true });
  return /^[0-9a-f]{40}$/i.test(head) ? head : null;
}

function remoteHead({ repoRoot, relPath }) {
  const abs = path.join(repoRoot, relPath);
  const line = git({ args: ['ls-remote', 'origin', 'HEAD'], cwd: abs, allowFail: true });
  const sha = (line.split(/\s+/)[0] || '').trim();
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

/**
 * Is the checked-out commit present on origin?
 *
 * Deliberately not "does HEAD equal the remote head" — pinning an older commit is the
 * normal state of a submodule and must not block a publish. What must block is a commit
 * that exists only in this clone, because no one else could ever resolve that pin.
 */
function childCommitIsOnOrigin({ repoRoot, relPath, head, remote }) {
  if (!head || !remote) return true;
  if (head === remote) return true;
  const abs = path.join(repoRoot, relPath);
  const branch = currentBranchFor({ repoRoot, relPath });
  const fetched = spawnSync('git', ['fetch', '-q', 'origin', branch], { cwd: abs, encoding: 'utf8' });
  if (fetched.status !== 0) return null; // Cannot tell — reported separately.
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', head, 'FETCH_HEAD'], { cwd: abs, encoding: 'utf8' });
  return ancestor.status === 0;
}

function remoteUrlFor({ repoRoot, relPath }) {
  return git({ args: ['config', '--get', 'remote.origin.url'], cwd: path.join(repoRoot, relPath), allowFail: true });
}

function currentBranchFor({ repoRoot, relPath }) {
  const branch = git({ args: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd: path.join(repoRoot, relPath), allowFail: true });
  return branch && branch !== 'HEAD' ? branch : 'main';
}

function readChildJson({ repoRoot, relPath, assetPath }) {
  const filePath = path.join(repoRoot, relPath, assetPath);
  if (!fs.existsSync(filePath)) return null;
  try {
    return readJson({ filePath });
  } catch {
    return null;
  }
}

function listReferenceDirs({ repoRoot, kindDir }) {
  const root = path.join(repoRoot, 'references', kindDir);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.posix.join('references', kindDir, entry.name));
}

function readPreviousManifest({ repoRoot }) {
  const previousPath = path.join(repoRoot, 'references', 'workspace.json');
  if (!fs.existsSync(previousPath)) return { nodes: [], edges: [] };
  try {
    const parsed = readJson({ filePath: previousPath });
    return {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    };
  } catch {
    return { nodes: [], edges: [] };
  }
}

/** Rebuild a node from a carried-forward path, re-reading its live head and remote. */
function nodeFromDir({ repoRoot, id, kind, displayName, relPath, allocator }) {
  const repositoryUrl = remoteUrlFor({ repoRoot, relPath });
  const assetPath = PRIMARY_ASSET[kind];
  const definition = readChildJson({ repoRoot, relPath, assetPath });
  const portable = definition && definition.schemaVersion === 2 && definition.resourceKey
    ? {
      resourceKey: String(definition.resourceKey),
      assetPath,
      definitionFingerprint: fingerprint({ value: definition }),
    }
    : undefined;
  // The allocator is seeded from the prior manifest, so this returns the already-published
  // slug for a known remote and only allocates for a genuinely new one.
  if (repositoryUrl && !portable) allocator.claim({ kind, repositoryUrl });
  return {
    id,
    kind,
    displayName,
    path: relPath,
    repositoryUrl: repositoryUrl ? cleanRemoteUrl({ repositoryUrl }) : undefined,
    branch: currentBranchFor({ repoRoot, relPath }),
    revision: submoduleHead({ repoRoot, relPath }) || undefined,
    assetPaths: [assetPath],
    ...(portable ? { portable } : {}),
  };
}

function buildLocalManifest({ repoRoot, registry }) {
  const seedPrevious = readPreviousManifest({ repoRoot });
  const allocator = createSlugAllocator({ previous: seedPrevious });
  const chatConfig = readJson({ filePath: path.join(repoRoot, 'assets', 'chat-config.json') });
  const published = chatConfig.publishedConfig && typeof chatConfig.publishedConfig === 'object'
    ? chatConfig.publishedConfig
    : {};
  const topology = published.agentTopology && typeof published.agentTopology === 'object'
    ? published.agentTopology
    : {};
  const slashCommands = Array.isArray(topology.slashCommands) ? topology.slashCommands : [];
  const pipelineEntry = registry.repos.find((entry) => entry.kind === 'pipeline');
  const workflowEntries = registry.repos.filter((entry) => entry.kind === 'workflow');
  const listEntry = registry.repos.find((entry) => entry.kind === 'list');
  const pipelineDefinition = readChildJson({
    repoRoot,
    relPath: pipelineEntry.path,
    assetPath: pipelineEntry.assetPath || 'assets/pipeline.json',
  });
  const nested = pipelineDefinition && pipelineDefinition.pipeline && typeof pipelineDefinition.pipeline === 'object'
    ? pipelineDefinition.pipeline
    : pipelineDefinition || {};
  const transitions = Array.isArray(nested.transitions) ? nested.transitions : [];

  const previous = readPreviousManifest({ repoRoot });
  const previousNodeById = new Map(previous.nodes.map((node) => [node.id, node]));

  const nodes = new Map();
  const edges = [];
  const addEdge = ({ from, to, relation, source }) => {
    if (edges.some((edge) => edge.from === from && edge.to === to && edge.relation === relation && edge.source === source)) return;
    edges.push({ from, to, relation, source });
  };
  const upsertNode = ({ node }) => {
    const existing = nodes.get(node.id);
    if (!existing) {
      nodes.set(node.id, node);
      return node.id;
    }
    if (!existing.repositoryUrl && node.repositoryUrl) {
      nodes.set(node.id, { ...existing, ...node, unresolved: undefined });
    }
    return node.id;
  };

  for (const entry of registry.repos) {
    const definition = readChildJson({ repoRoot, relPath: entry.path, assetPath: entry.assetPath });
    upsertNode({
      node: {
        id: `${entry.kind}:${entry.resourceKey}`,
        kind: entry.kind,
        displayName: entry.displayName,
        path: entry.path,
        repositoryUrl: entry.repositoryUrl,
        branch: entry.branch,
        revision: submoduleHead({ repoRoot, relPath: entry.path }) || entry.revision,
        assetPaths: [entry.assetPath],
        portable: {
          resourceKey: entry.resourceKey,
          assetPath: entry.assetPath,
          definitionFingerprint: definition ? fingerprint({ value: definition }) : entry.definitionFingerprint,
        },
      },
    });
  }

  const pipelineId = `pipeline:${pipelineEntry.resourceKey}`;
  for (const workflowEntry of workflowEntries) {
    const workflowId = `workflow:${workflowEntry.resourceKey}`;
    // `to` already disambiguates these per workflow, so the source label stays
    // stable — existing published workspace.json files keep matching.
    addEdge({ from: 'persona', to: workflowId, relation: 'workflowRef', source: 'persona.workflowRef' });
    addEdge({ from: workflowId, to: pipelineId, relation: 'pipelineRef', source: 'workflow.pipelineRef' });
  }
  addEdge({ from: pipelineId, to: `list:${listEntry.resourceKey}`, relation: 'listRef', source: 'pipeline.storage.listRef' });

  // ---- Persona -> Workflow (slash commands) ----
  const extraWorkflowDirs = listReferenceDirs({ repoRoot, kindDir: 'workflows' });
  for (const command of slashCommands) {
    const trigger = String(command.trigger || '').trim();
    if (!trigger) continue;
    const execution = command.execution && typeof command.execution === 'object' ? command.execution : {};
    const workflowRef = execution.workflowRef && typeof execution.workflowRef === 'object'
      ? execution.workflowRef
      : (command.workflowRef && typeof command.workflowRef === 'object' ? command.workflowRef : {});
    const resourceKey = String(workflowRef.resourceKey || '').trim();
    const source = `persona.slashCommand.${trigger}`;
    const displayName = String(command.label || trigger);

    // A command bound to a local Operator action rather than a portable workflowRef cannot
    // be resolved from a clone. If a prior publish already reconciled this trigger, carry
    // that edge forward — the product rewrites commands to actionId on every sync, so
    // failing here would permanently block publishing an otherwise healthy workspace.
    // Only a trigger never reconciled before is genuinely unresolved.
    if (!resourceKey) {
      const priorEdge = previous.edges.find((edge) => edge.source === source && edge.relation === 'slashCommand');
      const priorNode = priorEdge ? previousNodeById.get(priorEdge.to) : null;
      if (priorNode && priorNode.path && fs.existsSync(path.join(repoRoot, priorNode.path))) {
        upsertNode({
          node: nodeFromDir({
            repoRoot,
            id: priorNode.id,
            kind: 'workflow',
            displayName: priorNode.displayName || displayName,
            relPath: priorNode.path,
            allocator,
          }),
        });
        addEdge({ from: 'persona', to: priorNode.id, relation: 'slashCommand', source });
        continue;
      }
      const unresolvedId = `workflow:command:${toReferenceSlug({ value: trigger })}`;
      upsertNode({
        node: { id: unresolvedId, kind: 'workflow', displayName, unresolved: { reason: 'missing_git_binding', source } },
      });
      addEdge({ from: 'persona', to: unresolvedId, relation: 'slashCommand', source });
      continue;
    }

    const id = `workflow:${resourceKey}`;
    if (nodes.has(id)) {
      addEdge({ from: 'persona', to: id, relation: 'slashCommand', source });
      continue;
    }
    const matchDir = extraWorkflowDirs.find((relPath) => {
      const definition = readChildJson({ repoRoot, relPath, assetPath: 'assets/workflow.json' });
      return definition && definition.resourceKey === resourceKey;
    });
    if (!matchDir) {
      upsertNode({
        node: { id, kind: 'workflow', displayName, unresolved: { reason: 'missing_git_binding', source } },
      });
      addEdge({ from: 'persona', to: id, relation: 'slashCommand', source });
      continue;
    }
    upsertNode({
      node: nodeFromDir({ repoRoot, id, kind: 'workflow', displayName, relPath: matchDir, allocator }),
    });
    addEdge({ from: 'persona', to: id, relation: 'slashCommand', source });
  }

  // ---- Pipeline -> Team Agent, and Team Agent -> child Workflow ----
  const teamAgentDirs = new Set(listReferenceDirs({ repoRoot, kindDir: 'team-agents' }));
  for (const transition of transitions) {
    const transitionId = String(transition.id || '').trim();
    const endpoint = String(transition.workflowEndpointId || '').trim();
    if (!transitionId || !endpoint || isBuiltin({ value: endpoint })) continue;
    const source = `pipeline.transition.${transitionId}.workflowEndpointId`;

    // `endpoint` is a runtime id with no local mapping to a repository. The only sound
    // resolution is the edge a previous server publish recorded for this exact transition.
    const previousEdge = previous.edges.find((edge) => edge.source === source && edge.relation === 'workflowEndpoint');
    const previousNode = previousEdge ? previousNodeById.get(previousEdge.to) : null;
    const matchDir = previousNode && previousNode.path && teamAgentDirs.has(previousNode.path)
      ? previousNode.path
      : null;

    if (!matchDir) {
      const unresolvedId = `team_agent:transition:${toReferenceSlug({ value: transitionId })}`;
      upsertNode({
        node: {
          id: unresolvedId,
          kind: 'team_agent',
          displayName: transitionId,
          unresolved: { reason: 'missing_git_binding', source },
        },
      });
      addEdge({ from: pipelineId, to: unresolvedId, relation: 'workflowEndpoint', source });
      continue;
    }

    const agentId = previousNode.id;
    upsertNode({
      node: nodeFromDir({
        repoRoot,
        id: agentId,
        kind: 'team_agent',
        displayName: previousNode.displayName || path.basename(matchDir),
        relPath: matchDir,
        allocator,
      }),
    });
    addEdge({ from: pipelineId, to: agentId, relation: 'workflowEndpoint', source });

    // Team Agent -> child Workflow. childSkills carry agentId/actionId, which a clone
    // cannot resolve, so these too are carried forward from the previous manifest.
    const orchestration = readChildJson({ repoRoot, relPath: matchDir, assetPath: 'assets/task-orchestration.json' });
    const childSkills = orchestration && Array.isArray(orchestration.childSkills) ? orchestration.childSkills : [];
    for (let index = 0; index < childSkills.length; index += 1) {
      const child = childSkills[index] || {};
      // Same stable key the server uses. Matching carried edges by array position instead
      // silently rebound workflows to the wrong children whenever a child skill was
      // reordered or inserted.
      const skillKey = String(child.id || child.workflowNodeId || `child-${index + 1}`).trim();
      const displayName = String(child.title || skillKey);
      const childSource = `team-agent.task-orchestration.childSkills.${skillKey}`;
      const carried = previous.edges.find(
        (edge) => edge.from === agentId && edge.relation === 'childSkill' && edge.source === childSource,
      );
      const carriedNode = carried ? previousNodeById.get(carried.to) : null;
      if (!carriedNode || !carriedNode.path || !fs.existsSync(path.join(repoRoot, carriedNode.path))) {
        const unresolvedId = `workflow:child:${toReferenceSlug({ value: `${agentId}-${skillKey}` })}`;
        upsertNode({
          node: { id: unresolvedId, kind: 'workflow', displayName, unresolved: { reason: 'missing_git_binding', source: childSource } },
        });
        addEdge({ from: agentId, to: unresolvedId, relation: 'childSkill', source: childSource });
        continue;
      }
      upsertNode({
        node: nodeFromDir({
          repoRoot,
          id: carriedNode.id,
          kind: 'workflow',
          displayName,
          relPath: carriedNode.path,
          allocator,
        }),
      });
      addEdge({ from: agentId, to: carriedNode.id, relation: 'childSkill', source: childSource });
    }
  }

  const manifest = {
    schemaVersion: 1,
    updatedAt: Date.now(),
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: edges.sort((left, right) => `${left.from}:${left.to}:${left.source}`.localeCompare(`${right.from}:${right.to}:${right.source}`)),
  };
  walkForbidden({ value: manifest });
  return manifest;
}

/**
 * Run every validator the child's scaffold ships. Returns issue strings.
 *
 * A child carrying a SKILL.md is scaffolded, so a missing validator is a real defect and
 * fails. A hand-made or legacy child without a SKILL.md is skipped loudly rather than
 * blocked — it never had a validator to lose.
 */
function runChildValidators({ repoRoot, node }) {
  const configs = CHILD_VALIDATORS[node.kind];
  if (!configs || !node.path) return [];
  const cwd = path.join(repoRoot, node.path);
  const scaffolded = fs.existsSync(path.join(cwd, 'SKILL.md'));
  const issues = [];

  for (const config of configs) {
    if (config.requiresAsset && !fs.existsSync(path.join(cwd, config.asset))) continue;
    if (!fs.existsSync(path.join(cwd, config.script))) {
      if (scaffolded) {
        issues.push(`${node.id}: scaffolded child is missing ${config.script}`);
      } else {
        writeOut({ message: `  skip  ${node.id}: no ${config.script} (child is not scaffolded)` });
      }
      continue;
    }
    const [command, ...prefix] = config.run;
    const result = spawnSync(command, [...prefix, config.script, config.asset], { cwd, encoding: 'utf8' });
    if (result.status === 0) continue;
    const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(0, 3).join(' ');
    issues.push(`${node.id}: ${config.script} failed — ${detail}`);
  }
  return issues;
}

/** A child must be a clean checkout: no uncommitted work, a real HEAD, and an origin. */
function childWorktreeIssues({ repoRoot, node }) {
  const cwd = path.join(repoRoot, node.path);
  const issues = [];
  if (!fs.existsSync(cwd)) return [`${node.path}: submodule is not checked out. Run git submodule update --init.`];

  const head = submoduleHead({ repoRoot, relPath: node.path });
  if (!head) return [`${node.path}: no resolvable commit HEAD.`];

  // Uncommitted work would be pinned out of existence — the lock would point at a commit
  // that does not contain what the author is actually looking at.
  const dirty = git({ args: ['status', '--porcelain'], cwd, allowFail: true });
  if (dirty) {
    issues.push(`${node.path}: has uncommitted changes. Commit and push the child first.`);
  }
  if (!remoteUrlFor({ repoRoot, relPath: node.path })) {
    issues.push(`${node.path}: has no origin remote.`);
  }
  return issues;
}

function validateLocal({ repoRoot, manifest }) {
  const issues = [];
  for (const node of manifest.nodes) {
    if (node.unresolved) {
      issues.push(`${node.id}: ${node.unresolved.reason} (${node.unresolved.source})`);
    }
  }

  // Full Persona -> Workflow -> Pipeline -> List relationship and fingerprints, not just
  // each file's header — otherwise a local publish passes where server import rejects.
  issues.push(...validatePortableBundle({ repoRoot }));

  for (const node of manifest.nodes) {
    if (node.unresolved || !node.path) continue;
    issues.push(...childWorktreeIssues({ repoRoot, node }));

    const head = submoduleHead({ repoRoot, relPath: node.path });
    const remote = remoteHead({ repoRoot, relPath: node.path });
    const onOrigin = childCommitIsOnOrigin({ repoRoot, relPath: node.path, head, remote });
    if (onOrigin === false) {
      issues.push(`${node.path}: child commit ${head} is not on origin. Push the child repository first.`);
    } else if (onOrigin === null) {
      issues.push(`${node.path}: could not reach origin to confirm child commit ${head} is published.`);
    }
    if (node.kind === 'team_agent') {
      const definition = readChildJson({ repoRoot, relPath: node.path, assetPath: 'assets/team-agent.json' });
      if (!definition || !definition.endpoint || typeof definition.endpoint !== 'object') {
        issues.push(`${node.id}: missing assets/team-agent.json endpoint`);
      }
    }
    issues.push(...runChildValidators({ repoRoot, node }));
  }
  return issues;
}

function pinRegistry({ repoRoot, registry }) {
  return {
    schemaVersion: 2,
    updatedAt: Date.now(),
    repos: registry.repos.map((entry) => {
      const definition = readChildJson({ repoRoot, relPath: entry.path, assetPath: entry.assetPath });
      const revision = submoduleHead({ repoRoot, relPath: entry.path }) || entry.revision;
      return {
        ...entry,
        revision,
        definitionFingerprint: definition ? fingerprint({ value: definition }) : entry.definitionFingerprint,
      };
    }),
  };
}

/**
 * Paths the previous manifest generated that this one no longer owns.
 *
 * Only ever previously generated paths — a gitlink this workspace never wrote is left
 * alone, so an unrelated submodule is never unlinked.
 */
function collectStalePaths({ previous, manifest }) {
  const next = new Set(manifest.nodes.map((node) => node.path).filter(Boolean));
  return [...new Set(
    previous.nodes
      .map((node) => node.path)
      .filter((relPath) => Boolean(relPath) && !next.has(relPath)),
  )];
}

function buildReadme({ registry, manifest }) {
  const portableRows = registry.repos
    .map((entry) => `| ${entry.kind} *(portable)* | \`${entry.resourceKey}\` | ${entry.displayName} | \`${entry.path}\` | \`${entry.branch}\` |`)
    .join('\n');
  const extraRows = manifest.nodes
    .filter((node) => !node.portable || !registry.repos.some((entry) => entry.resourceKey === node.portable.resourceKey))
    .map((node) => `| ${node.kind} | ${node.displayName} | \`${node.path || '—'}\` | ${node.unresolved ? `**${node.unresolved.reason}**` : 'ok'} |`)
    .join('\n');
  return `# AI Persona References

This folder is a **depth-1 composition workspace**. Every linked repository is a git
submodule of this Persona — never a submodule of another submodule.

\`\`\`bash
git submodule update --init
\`\`\`

## Portable bundle (\`registry.json\`)

Import materializes exactly one Workflow, Pipeline, and List.

| Kind | Resource key | Name | Path | Branch |
|---|---|---|---|---|
${portableRows}

## Authoring graph (\`workspace.json\`)

Generated. Extra workflows and team agents are same-environment authoring only.

| Kind | Name | Path | State |
|---|---|---|---|
${extraRows || '| — | _No extra repositories._ | | |'}

Commit children first, then publish.
`;
}

const GENERATED_FILES = ['references/registry.json', 'references/workspace.json', 'references/README.md'];

/**
 * Snapshot every file publish may write, plus `.gitmodules`, so a failure anywhere — most
 * importantly a rejected `git commit` — can restore the tree exactly.
 */
function snapshotGenerated({ repoRoot }) {
  const snapshot = new Map();
  for (const relPath of [...GENERATED_FILES, '.gitmodules']) {
    const abs = path.join(repoRoot, relPath);
    snapshot.set(relPath, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null);
  }
  return snapshot;
}

function restoreGenerated({ repoRoot, snapshot }) {
  for (const [relPath, content] of snapshot) {
    const abs = path.join(repoRoot, relPath);
    if (content === null) {
      fs.rmSync(abs, { force: true });
    } else {
      fs.writeFileSync(abs, content);
    }
  }
  // Drop everything publish staged; the index was verified clean beforehand.
  git({ args: ['reset', '-q'], cwd: repoRoot, allowFail: true });
}

/**
 * Remove the on-disk checkout for a stale link. The only place this script deletes a
 * directory — publish deliberately never does, because a stale path may still hold
 * uncommitted work the author has not pushed anywhere.
 */
function runPrune({ repoRoot, registry, manifest }) {
  const portablePaths = new Set(registry.repos.map((entry) => entry.path));
  const livePaths = new Set(manifest.nodes.map((node) => node.path).filter(Boolean));

  // Self-contained rule, because publish has already overwritten workspace.json by the
  // time prune runs: a directory under references/ that publish unlinked (no .gitmodules
  // section) and that the current graph does not claim is a leftover checkout.
  const registered = new Set();
  const gitmodulesPath = path.join(repoRoot, '.gitmodules');
  if (fs.existsSync(gitmodulesPath)) {
    for (const line of fs.readFileSync(gitmodulesPath, 'utf8').split('\n')) {
      const match = line.match(/^\s*path\s*=\s*(.+?)\s*$/);
      if (match) registered.add(path.posix.normalize(match[1]));
    }
  }

  let pruned = 0;
  for (const kindDir of ['workflows', 'pipelines', 'lists', 'team-agents']) {
    for (const relPath of listReferenceDirs({ repoRoot, kindDir })) {
      const normalized = path.posix.normalize(relPath);
      if (!normalized.startsWith('references/') || normalized.split('/').includes('..')) {
        writeErr({ message: `refuse  ${relPath}: not a direct workspace path` });
        continue;
      }
      if (portablePaths.has(normalized)) continue;
      if (livePaths.has(normalized)) continue;
      if (registered.has(normalized)) {
        writeErr({ message: `refuse  ${relPath}: still registered in .gitmodules; publish first` });
        continue;
      }
      fs.rmSync(path.join(repoRoot, normalized), { recursive: true, force: true });
      writeOut({ message: `pruned  ${relPath}` });
      pruned += 1;
    }
  }
  if (!pruned) writeOut({ message: 'Nothing to prune.' });
}

function main() {
  const command = (process.argv[2] || 'status').trim();
  if (!['status', 'validate', 'publish', 'prune'].includes(command)) {
    die({ message: 'Usage: node scripts/publish-workspace.js <status|validate|publish|prune>' });
  }
  const repoRoot = findRepoRoot({ startDir: process.cwd() });
  const registry = parseRegistry({ repoRoot });
  const previous = readPreviousManifest({ repoRoot });
  const manifest = buildLocalManifest({ repoRoot, registry });

  if (command === 'status') {
    writeOut({ message: `Workspace nodes: ${manifest.nodes.length}` });
    writeOut({ message: `Unresolved: ${manifest.nodes.filter((node) => node.unresolved).length}` });
    for (const node of manifest.nodes) {
      const head = node.path ? submoduleHead({ repoRoot, relPath: node.path }) : '';
      // Being behind origin is the normal state of a pin, so report it without implying
      // anything is wrong — the author decides whether to advance it.
      const remote = node.path ? remoteHead({ repoRoot, relPath: node.path }) : null;
      const drift = head && remote && head !== remote ? `  (origin is at ${remote})` : '';
      writeOut({
        message: `${node.unresolved ? 'UNRESOLVED' : 'ok'}  ${node.id}  ${node.path || '—'}  ${head || (node.unresolved && node.unresolved.reason) || ''}${drift}`,
      });
    }
    for (const stale of collectStalePaths({ previous, manifest })) {
      writeOut({ message: `stale  ${stale}  (publish unlinks it; run prune to remove the checkout)` });
    }
    return;
  }

  if (command === 'prune') {
    runPrune({ repoRoot, registry, manifest });
    return;
  }

  const issues = validateLocal({ repoRoot, manifest });

  if (command === 'validate') {
    if (issues.length) {
      issues.forEach((issue) => writeErr({ message: issue }));
      process.exit(1);
    }
    writeOut({ message: 'Workspace is valid. Child commits are on origin. Persona root is unchanged.' });
    return;
  }

  if (issues.length) {
    issues.forEach((issue) => writeErr({ message: issue }));
    die({ message: 'Publish aborted. The currently published persona root was not modified.' });
  }

  // Guard before staging: `update-index --cacheinfo` writes gitlinks into the index, so a
  // check afterwards could not tell publish's own entries from work the author had staged.
  // A bare `git commit` would otherwise sweep that unrelated work into the publish commit.
  const staged = git({ args: ['diff', '--cached', '--name-only'], cwd: repoRoot, allowFail: true });
  if (staged) {
    die({
      message: `Publish aborted: the index already has staged changes:\n${staged}\nCommit or unstage them first — publish must own its commit.`,
    });
  }

  // Everything below is planned first, then written. Any failure restores the snapshot so
  // HEAD, the index, and the working tree are exactly as they were.
  const pinnedRegistry = pinRegistry({ repoRoot, registry });
  const stalePaths = collectStalePaths({ previous, manifest });
  const readme = buildReadme({ registry: pinnedRegistry, manifest });
  const snapshot = snapshotGenerated({ repoRoot });

  try {
    fs.writeFileSync(path.join(repoRoot, 'references', 'registry.json'), `${JSON.stringify(pinnedRegistry, null, 2)}\n`);
    fs.writeFileSync(path.join(repoRoot, 'references', 'workspace.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(path.join(repoRoot, 'references', 'README.md'), readme);
    gitOrThrow({ args: ['add', ...GENERATED_FILES], cwd: repoRoot });

    // Unlink stale gitlinks so the published lock stays self-consistent, but never delete
    // the checkout — that is prune's job, and it may hold unpushed work.
    for (const stale of stalePaths) {
      gitOrThrow({ args: ['update-index', '--force-remove', '--', stale], cwd: repoRoot, allowFail: true });
      gitOrThrow({ args: ['config', '-f', '.gitmodules', '--remove-section', `submodule.${stale}`], cwd: repoRoot, allowFail: true });
    }
    if (fs.existsSync(path.join(repoRoot, '.gitmodules'))) {
      gitOrThrow({ args: ['add', '.gitmodules'], cwd: repoRoot, allowFail: true });
    }
    for (const node of manifest.nodes) {
      if (!node.path || !node.revision) continue;
      gitOrThrow({ args: ['update-index', '--add', '--cacheinfo', `160000,${node.revision},${node.path}`], cwd: repoRoot });
    }

    gitOrThrow({ args: ['commit', '-m', 'Publish persona composition workspace'], cwd: repoRoot });
  } catch (error) {
    restoreGenerated({ repoRoot, snapshot });
    die({
      message: `Publish failed: ${error instanceof Error ? error.message : String(error)}\nThe persona root, index, and generated files were restored.`,
    });
  }

  writeOut({ message: `Published workspace lock ${git({ args: ['rev-parse', 'HEAD'], cwd: repoRoot })}` });
  for (const stale of stalePaths) {
    if (fs.existsSync(path.join(repoRoot, stale))) {
      writeOut({ message: `stale checkout left at ${stale} — run: node scripts/publish-workspace.js prune` });
    }
  }
}

try {
  main();
} catch (error) {
  die({ message: error instanceof Error ? error.message : String(error) });
}
