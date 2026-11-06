/**
 * The built-in slash commands, in /help order (01 §5.1; Q's help lists quit/clear/help first).
 */

import type { BuiltinCommand } from '../types.js';
import { agentCommand } from './agent.js';
import { basicCommands, stubCommands } from './basic.js';
import { chatCommand, loadCommand, saveCommand, sessionsCommand } from './chat.js';
import { compactCommand, rewindCommand, tangentCommand } from './conversation.js';
import { contextCommand } from './context.js';
import { editorCommand, replyCommand } from './editor.js';
import { hooksCommand, mcpCommand, todosCommand, transcriptCommand, usageCommand } from './info.js';
import { effortCommand, modelCommand } from './model.js';
import { planCommand } from './plan.js';
import { promptsCommand } from './prompts.js';
import { acceptAllCommand, toolsCommand } from './tools.js';

export function builtinCommands(): BuiltinCommand[] {
  return [
    ...basicCommands.slice(0, 3), // quit, clear, help
    editorCommand,
    replyCommand,
    agentCommand,
    chatCommand,
    saveCommand,
    loadCommand,
    sessionsCommand,
    contextCommand,
    modelCommand,
    effortCommand,
    planCommand,
    toolsCommand,
    acceptAllCommand,
    promptsCommand,
    hooksCommand,
    mcpCommand,
    compactCommand,
    usageCommand,
    tangentCommand,
    rewindCommand,
    todosCommand,
    transcriptCommand,
    ...basicCommands.slice(3), // session-id, issue, knowledge, profile, copy, title, settings
    ...stubCommands(),
  ];
}
