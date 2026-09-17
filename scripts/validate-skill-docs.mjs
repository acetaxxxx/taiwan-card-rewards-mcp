import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const skillRoot = join(root, 'docs', 'taiwan-card-rewards-skill');
const toolsReference = join(skillRoot, 'references', 'mcp-tools.md');
const contract = await import(join(root, 'dist', 'mcp-contract.js'));
const toolNames = contract.mcpTools.map((tool) => tool.name);
const text = readFileSync(toolsReference, 'utf8');
const documentedNames = [...text.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]);

const documentedSet = new Set(documentedNames);
if (documentedNames.length !== toolNames.length || documentedSet.size !== toolNames.length || toolNames.some((name) => !documentedSet.has(name))) {
  throw new Error(`mcp-tools.md tool matrix drift: expected ${toolNames.length} names in contract, found ${documentedNames.length}`);
}

const scopedSpecFiles = [
  join(skillRoot, 'card-rewards-recommendation', 'workflows', 'recommendation-tools-specification.md'),
  join(skillRoot, 'card-rewards-evidence', 'workflows', 'evidence-tools-specification.md'),
  join(skillRoot, 'card-rewards-ledger', 'workflows', 'ledger-tools-specification.md'),
];

const contractToolSet = new Set(toolNames);
const scopedCoveredTools = new Set();
for (const specFile of scopedSpecFiles) {
  const specText = readFileSync(specFile, 'utf8');
  const specTools = [...specText.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1]);
  for (const tool of specTools) {
    if (!contractToolSet.has(tool)) {
      throw new Error(`Unknown tool "${tool}" documented in scoped spec: ${relative(root, specFile)}`);
    }
    scopedCoveredTools.add(tool);
  }
}

const missingInSpecs = toolNames.filter((t) => !scopedCoveredTools.has(t));
if (missingInSpecs.length > 0) {
  throw new Error(`Scoped tool specifications drift: missing coverage for tools: ${missingInSpecs.join(', ')}`);
}


const forbiddenKeys = /^(pan|cardNumber|card_number|cvv|cvc|otp|password|cookie|credential|credentials|secret|token|apiKey|api_key|ownerUser|owner_user|dataDir|data_dir|userId|user_id)$/i;
const files = [];
function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith('.md')) files.push(path);
  }
}
walk(skillRoot);

function inspect(value, source) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) inspect(item, source);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.test(key)) throw new Error(`forbidden sensitive/internal key ${key} in ${source}`);
    if (typeof child === 'string' && /\d{13,19}/.test(child)) throw new Error(`possible PAN in ${source}`);
    inspect(child, source);
  }
}

const toolCountPatterns = [
  /\b(\d+)-tool\b/gi,
  /\b(\d+)\s+tools\b/gi,
  /(\d+)\s*個工具/g,
  /(\d+)\s*項工具/g,
  /\b(\d+)\s*names in `mcp-tools\.md`/gi,
];

for (const file of files) {
  const source = relative(root, file);
  const markdown = readFileSync(file, 'utf8');
  for (const pattern of toolCountPatterns) {
    for (const match of markdown.matchAll(pattern)) {
      const count = parseInt(match[1], 10);
      if (count !== toolNames.length) {
        throw new Error(
          `Tool count drift in ${source}: found "${match[0]}" (${count}), expected runtime mcpTools count of ${toolNames.length}`
        );
      }
    }
  }
  for (const match of markdown.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)) {
    try { inspect(JSON.parse(match[1]), source); } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
}

console.log(`Skill docs consistency OK: ${toolNames.length} tools, ${files.length} markdown files checked`);
