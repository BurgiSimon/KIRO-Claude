import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as config from '../../src/config/index.js';

/** The public API required by the module contract (names must stay stable). */
const REQUIRED_FUNCTIONS = [
  // workspace.ts
  'createWorkspaceContext',
  // settings.ts
  'openSettings',
  'parseSettingValue',
  // agents.ts
  'loadAgents',
  'parseAgent',
  'builtinAgents',
  'selectAgent',
  'agentCreateTemplate',
  'validateAgentObject',
  'agentDirs',
  // mcp.ts
  'normalizeMcpServer',
  'loadMcpFile',
  'mcpConfigPaths',
  'resolveMcpServers',
  'toClaudeMcpConfig',
  'claudeServerName',
  'readMcpFileRaw',
  'addMcpServer',
  'removeMcpServer',
  // steering.ts
  'loadSteering',
  'expandFileRefs',
  'findAgentsMd',
  // resources.ts
  'resolveResources',
  // prompts.ts
  'loadPrompts',
  'findPrompt',
  'expandPrompt',
  // skills.ts
  'discoverSkills',
  'buildSkillsPluginDir',
  'expandSkillInvocation',
  // hooks.ts
  'normalizeAgentHooks',
  'loadHookFiles',
  'allHooksFor',
  // permissionsYaml.ts
  'loadPermissionScopes',
  'workspaceRootHash',
  // kiroignore.ts
  'loadKiroIgnore',
];

const REQUIRED_OBJECTS = ['SETTINGS_SCHEMA', 'AGENT_SCHEMA', 'PRESETS'];

describe('config/index public API', () => {
  const api = config as unknown as Record<string, unknown>;
  for (const name of REQUIRED_FUNCTIONS) it(`${name} is a function`, () => assert.equal(typeof api[name], 'function'));
  for (const name of REQUIRED_OBJECTS) {
    it(`${name} is an object`, () => {
      assert.equal(typeof api[name], 'object');
      assert.notEqual(api[name], null);
    });
  }
});
