/**
 * Spec phase instructions (research 03 §1.10 — the port's original, behavior-equivalent wording;
 * the LP prompt is behavioral reference only, 03 §0.1). Every builder fixes the exact output path
 * because models otherwise invent locations (03 §1.10, KC SKILL.md).
 *
 * Delivery (00 §8 C21): phase instructions go into the **user turn** (PromptInput.text, with the
 * spec-mode base block as PromptInput.extraContext), never into the system prompt.
 *
 *  - §1.10.1 spec-mode base block            → {@link specModeBlock}
 *  - §1.10.2 requirements (EARS)              → {@link requirementsPrompt}
 *  - §1.10.3 design (+ design-first variant)  → {@link designPrompt}
 *  - §1.10.4 tasks                            → {@link tasksPrompt}
 *  - §1.10.5 bugfix phases                    → {@link bugfixAnalysisPrompt}, {@link bugfixDesignPrompt}, {@link bugfixTasksPrompt}
 *  - §1.10.6 / §1.8 analyze requirements      → {@link analyzePrompt}, {@link parseAnalysis}, {@link applyFindingsPrompt}
 *  - §1.10.7 quick spec questions             → {@link quickQuestionsPrompt}
 *  - §1.10.8 task execution + `TASK_RESULT:`  → {@link taskExecutionPrompt}, {@link parseTaskResult}
 *  - §1.10.9 sync                             → {@link syncPrompt}
 *  - §1.4.2 / §1.11.4 checkpoint question     → {@link checkpointQuestion}, {@link revisionPrompt}
 */

import type { SpecDocKind } from './model.js';
import { SPEC_DOC_FILES } from './model.js';

/** Fixed intro of `## Correctness Properties` (03 §1.5.3; verbatim in KR and MaClaw). */
export const CORRECTNESS_INTRO =
  'A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.';

/** The sentinel the task session must end with (03 §1.10.8, §1.7.2). */
export const TASK_RESULT_PREFIX = 'TASK_RESULT:';

export type SpecKindLabel = 'feature' | 'bugfix' | 'quick';

export interface SpecPromptVars {
  /** Spec (folder) name. */
  name: string;
  /** Absolute `.kiro/specs/<name>`. */
  dir: string;
  /** Workspace root. */
  ws: string;
}

// ───────────────────────────── §1.10.1 base block ─────────────────────────────

/** Spec-mode base instructions (03 §1.10.1), wrapped as a `<kiro-spec-mode>` context block. */
export function specModeBlock(v: SpecPromptVars & { type: SpecKindLabel }): string {
  return `<kiro-spec-mode>
You are working in Kiro spec mode on the spec "${v.name}" (${v.type}). A spec turns an idea into
three reviewed documents, then into code, one task at a time.
Spec folder: ${v.dir}   Workspace: ${v.ws}
Ground rules:
- Write spec documents ONLY at the exact paths given in each phase instruction. Never create other
  files in ${v.dir} (no notes, no research files) and never write outside ${v.dir} while a phase is
  being drafted.
- Work on exactly ONE phase per turn. When the phase document is written, stop: give a 2-4 line
  summary of what you wrote and what you'd like the user to check. Do not ask "shall I continue",
  the tool shows the review checkpoint.
- Never implement product code while drafting requirements, design, or tasks.
- Before drafting, read project conventions: .kiro/steering/**/*.md and AGENTS.md (if present).
  If steering contradicts the user's request, say so and ask which wins.
- If the user's message is feedback on the current document, revise that document in place and
  stop again. Do not advance phases yourself.
- Ask clarifying questions only when the answer would materially change the document and cannot
  be discovered by reading the code; ask at most 3, each with your recommended answer.
- Keep documents concrete and self-contained: no placeholders, no TODOs.
</kiro-spec-mode>`;
}

// ───────────────────────────── §1.10.2 requirements ─────────────────────────────

const EARS_RULES = `Write every acceptance criterion in EARS form with a glossary term as the subject:
  THE <System> SHALL <response>
  WHEN <trigger>, THE <System> SHALL <response>
  WHILE <state>, THE <System> SHALL <response>
  IF <unwanted condition>, THEN THE <System> SHALL <response>
  WHERE <optional feature applies>, THE <System> SHALL <response>
Each criterion must be testable, atomic (one SHALL), and free of vague words ("fast", "large",
"user-friendly") unless quantified. Cover error cases, edge cases, limits, and non-functional
constraints (performance, security, accessibility) where relevant. Number requirements from 1;
criteria are referenced later as <requirement>.<criterion> (e.g. 2.3).`;

const PROPERTY_RULES = `start with this sentence verbatim: "${CORRECTNESS_INTRO}"
   Then "### Property <K>: <Name>", one sentence starting with "*For any* …", and a line
   "**Validates: Requirements x.y, …**". Derive properties only from criteria that are logically
   testable over generated inputs.`;

export interface RequirementsPromptOptions {
  dir: string;
  /** User description (ground truth). */
  desc: string;
  /** `/spec new` mid-conversation: the conversation so far is input too (03 §5.2). */
  useConversation?: boolean;
  /** Design-first phase 2: derive from the approved design, then append Correctness Properties. */
  designFirst?: boolean;
  /** Quick spec: the user's answers to the clarifying questions (or a note that defaults apply). */
  clarifications?: string;
}

export function requirementsPrompt(o: RequirementsPromptOptions): string {
  const lines = [
    `Phase: REQUIREMENTS. Create or update ${o.dir}/requirements.md.`,
    o.designFirst
      ? `Derive requirements that are feasible under the approved design in ${o.dir}/design.md; do not add\nbehavior the design cannot support. Afterwards append ## Correctness Properties to design.md (${PROPERTY_RULES.replace(/^start/, 'Start')})`
      : `Draft a complete first version from the user's description right away, without asking a series of\nquestions first. Focus on behavior, not on exploring the code.`,
    `Use exactly this structure:
# Requirements Document
## Introduction            (what the feature is, scope, non-goals)
## Glossary                (- **Term_Name**: definition; name every system/component used as a subject below)
## Requirements
### Requirement <N>: <Title>
**User Story:** As a <role>, I want <capability>, so that <benefit>
#### Acceptance Criteria
1. <EARS sentence>`,
    EARS_RULES,
  ];
  if (o.useConversation) lines.push('Use the conversation so far as input.');
  if (o.clarifications) lines.push(`Clarifications from the user:\n${o.clarifications}`);
  lines.push(`User description (ground truth): ${o.desc}`);
  return lines.join('\n');
}

// ───────────────────────────── §1.10.3 design ─────────────────────────────

export interface DesignPromptOptions extends SpecPromptVars {
  /** Design-first phase 1 (no requirements yet). */
  designFirst?: { detail: 'high' | 'low'; desc: string; useConversation?: boolean };
}

export function designPrompt(o: DesignPromptOptions): string {
  if (o.designFirst) {
    const level =
      o.designFirst.detail === 'low'
        ? 'Detail level: LOW-LEVEL (algorithm pseudocode, interface contracts, key data structures, non-functional properties)'
        : 'Detail level: HIGH-LEVEL (architecture diagram, component interactions, patterns, non-functional properties)';
    return [
      level,
      `Phase: DESIGN (design-first). Create or update ${o.dir}/design.md from the user's description.`,
      `Research first: read the relevant code, configs, and dependencies in ${o.ws}; look up external APIs
if needed. Keep findings in the conversation, not in extra files, and briefly cite sources.
Use exactly these sections:
# Design Document: <Title>
## Overview
## Architecture            (include a mermaid diagram when it helps)
## Components and Interfaces   (per component: file path, interface/signatures, responsibilities)
## Data Models
## Error Handling
## Testing Strategy        (unit tests; property-based tests with the library for this language,
   at least 100 iterations each, each test tagged "Feature: ${o.name}, Property <K>: <text>";
   integration tests if needed)
Do not write "## Correctness Properties" yet: requirements do not exist; they are derived from this
design in the next phase. State key decisions with their rationale.`,
      ...(o.designFirst.useConversation ? ['Use the conversation so far as input.'] : []),
      `User description (ground truth): ${o.designFirst.desc}`,
    ].join('\n');
  }
  return `Phase: DESIGN. Requirements in ${o.dir}/requirements.md are approved. Create or update ${o.dir}/design.md.
Research first: read the relevant code, configs, and dependencies in ${o.ws}; look up external APIs
if needed. Keep findings in the conversation, not in extra files, and briefly cite sources.
Use exactly these sections:
# Design Document: <Title>
## Overview
## Architecture            (include a mermaid diagram when it helps)
## Components and Interfaces   (per component: file path, interface/signatures, responsibilities)
## Data Models
## Correctness Properties  (${PROPERTY_RULES})
## Error Handling
## Testing Strategy        (unit tests; property-based tests with the library for this language,
   at least 100 iterations each, each test tagged "Feature: ${o.name}, Property <K>: <text>";
   integration tests if needed)
The design must address every acceptance criterion; state key decisions with their rationale.
If you find a gap or contradiction in the requirements, say so and suggest a requirements change
instead of silently designing around it.`;
}

// ───────────────────────────── §1.10.4 tasks ─────────────────────────────

export function tasksPrompt(o: { dir: string; designFirst?: boolean }): string {
  return `Phase: TASKS. Requirements and design are approved. Create or update ${o.dir}/tasks.md.
Turn the design into an ordered series of coding steps that a coding agent will execute one at a
time, test-first where sensible. Each step builds on the previous ones, nothing is left unwired,
complexity grows gradually, and core functionality is validated early.
Format:
# Implementation Plan: <Title>
## Overview  (2-5 sentences)
## Tasks
- [ ] 1. <Top-level task>
  - [ ] 1.1 <Sub-task: concrete objective naming files/functions>
    - <detail bullets>
    - _Requirements: 1.1, 2.3_
  - [ ]* 1.2 Write property test for <thing>
    - **Property <K>: <Name>**
    - **Validates: Requirements x.y**
- [ ] 2. Checkpoint - <milestone>
  - Ensure all tests pass, ask the user if questions arise.
## Notes
## Task Dependency Graph
\`\`\`json
{"waves":[{"id":0,"tasks":["1.1"]},{"id":1,"tasks":["1.2","2.1"]}]}
\`\`\`
Rules: at most two levels; every item is a checkbox; sub-tasks numbered N.M; every task references
granular acceptance criteria (not just user stories); every criterion is covered by some task;
mark unit-test and property-test sub-tasks optional with "*" right after "]"; one property-test
sub-task per design property; add a checkpoint after each major milestone and a final checkpoint;
only tasks that write, modify, or test code: NO manual testing, deployment, metrics gathering,
user training, or process tasks. Do not repeat design detail; assume requirements and design are
available during execution. The dependency graph lists every leaf task (optional ones included,
checkpoints excluded) in waves: a task appears only after all tasks it depends on.`;
}

// ───────────────────────────── §1.10.5 bugfix ─────────────────────────────

export function bugfixAnalysisPrompt(o: { dir: string; desc: string; useConversation?: boolean }): string {
  return `Phase: BUG ANALYSIS. Create or update ${o.dir}/bugfix.md using exactly:
# Bugfix Requirements Document
## Introduction   (symptom, location, impact, and what the fix must NOT change)
## Bug Analysis
### Current Behavior (Defect)        1.1 WHEN <condition> THEN the system <incorrect behavior>
### Expected Behavior (Correct)      2.1 WHEN <condition> THEN the system SHALL <correct behavior>
### Unchanged Behavior (Regression Prevention)  3.1 WHEN <condition> THEN the system SHALL CONTINUE TO <behavior>
Optionally add "## Bug Condition (Formal)" with an isBugCondition(X) pseudocode predicate and
Fix-Checking / Preservation-Checking properties. Read the code to reproduce the reasoning; do not fix anything yet.${
    o.useConversation ? '\nUse the conversation so far as input.' : ''
  }
User report: ${o.desc}`;
}

export function bugfixDesignPrompt(o: { dir: string }): string {
  return `Phase: DESIGN (bugfix). The bug analysis in ${o.dir}/bugfix.md is approved.
Explore the code to find the root cause, then write ${o.dir}/design.md with: Overview; Glossary; Bug
Details (Bug Condition, Examples); Expected Behavior (Preservation Requirements); Hypothesized Root
Cause; Correctness Properties (Property 1: Bug Condition / expected behavior on buggy inputs;
Property 2: Preservation on all other inputs); Fix Implementation (Changes Required, minimal and
surgical); Testing Strategy (exploratory checking on unfixed code, fix checking, preservation
checking, unit, property-based, integration).
Use "# <Title> Bugfix Design" as the heading. Do not fix anything yet.`;
}

export function bugfixTasksPrompt(o: { dir: string }): string {
  return `Phase: TASKS (bugfix). The bug analysis and design are approved.
Write ${o.dir}/tasks.md in this order: 1. bug-condition exploration property test, which MUST FAIL
on unfixed code (do not fix code or test when it fails; record counterexamples); 2. preservation
property tests written observation-first, which MUST PASS on unfixed code; 3. the fix (3.1 implement
with \`_Bug_Condition:_\`, \`_Expected_Behavior:_\`, \`_Preservation:_\` and \`_Requirements:_\`
annotations; 3.2 re-run test 1, now passing; 3.3 re-run tests 2, still passing); 4. checkpoint.
These tasks are required (no \`*\`).
Format: "# Implementation Plan" heading, "## Overview", "## Tasks" with checkbox items
("- [ ] 1. <title>", sub-tasks "  - [ ] 3.1 <title>"), each with detail bullets and a
"_Requirements: 1.1, 2.1_" line referencing the ids in bugfix.md, then "## Task Dependency Graph"
with a \`\`\`json {"waves":[{"id":0,"tasks":["1","2"]},…]} \`\`\` block (checkpoints excluded).`;
}

// ───────────────────────────── §1.10.7 quick spec ─────────────────────────────

export function quickQuestionsPrompt(o: { desc: string }): string {
  return `Quick Spec: before any document is written, ask up to 6 clarifying questions about scope,
constraints and edge cases for the request below, each with a recommended default. Do not write
any file in this turn. Format each question as:
[1]: <question>
a. <option> (recommended)
b. <option>
End with: (Answer with "1=a, 2=b" or provide your own answers)
Request: ${o.desc}`;
}

// ───────────────────────────── dispatcher ─────────────────────────────

export interface PhasePromptContext extends SpecPromptVars {
  specType: 'feature' | 'bugfix';
  workflowType: 'requirements-first' | 'design-first';
  /** User description; '' when resuming an existing spec. */
  desc: string;
  detail?: 'high' | 'low';
  useConversation?: boolean;
  clarifications?: string;
}

/** The drafting instruction for phase document `doc` of a spec. */
export function phasePrompt(doc: SpecDocKind, c: PhasePromptContext): string {
  const desc = c.desc.trim() || `(no new description; continue the spec "${c.name}" from its existing documents in ${c.dir})`;
  if (c.specType === 'bugfix') {
    if (doc === 'bugfix' || doc === 'requirements') return bugfixAnalysisPrompt({ dir: c.dir, desc, useConversation: c.useConversation === true });
    if (doc === 'design') return bugfixDesignPrompt({ dir: c.dir });
    return bugfixTasksPrompt({ dir: c.dir });
  }
  const designFirst = c.workflowType === 'design-first';
  switch (doc) {
    case 'requirements': {
      const o: RequirementsPromptOptions = { dir: c.dir, desc, designFirst };
      if (c.useConversation) o.useConversation = true;
      if (c.clarifications) o.clarifications = c.clarifications;
      return requirementsPrompt(o);
    }
    case 'design':
      return designFirst
        ? designPrompt({ ...c, designFirst: { detail: c.detail ?? 'high', desc, useConversation: c.useConversation === true } })
        : designPrompt({ name: c.name, dir: c.dir, ws: c.ws });
    case 'tasks':
      return tasksPrompt({ dir: c.dir, designFirst });
    default:
      return bugfixAnalysisPrompt({ dir: c.dir, desc });
  }
}

/** Files a phase may write (03 §1.11.3): the phase doc; design-first requirements also design.md. */
export function phaseWritableDocs(doc: SpecDocKind, c: Pick<PhasePromptContext, 'specType' | 'workflowType'>): SpecDocKind[] {
  if (c.specType === 'feature' && c.workflowType === 'design-first' && doc === 'requirements') return ['requirements', 'design'];
  return [doc];
}

// ───────────────────────────── checkpoints (§1.4.2, §1.11.4) ─────────────────────────────

const NEXT_LABEL: Record<SpecDocKind, string> = {
  requirements: 'the requirements',
  bugfix: 'the bug analysis',
  design: 'the design',
  tasks: 'the implementation plan',
};

/** Review question after a phase (LP wording, 03 §1.4.2). */
export function checkpointQuestion(doc: SpecDocKind, next: SpecDocKind | undefined): string {
  const head =
    doc === 'requirements'
      ? 'Do the requirements look good?'
      : doc === 'bugfix'
        ? 'Does the bug analysis look good?'
        : doc === 'design'
          ? 'Does the design look good?'
          : 'Do the tasks look good?';
  return next ? `${head} If so, we can move on to ${NEXT_LABEL[next]}.` : head;
}

/** "Approve and continue to design" / "Approve tasks" (03 §1.11.4). */
export function approveLabel(doc: SpecDocKind, next: SpecDocKind | undefined): string {
  if (!next) return doc === 'tasks' ? 'Approve tasks' : `Approve ${SPEC_DOC_FILES[doc]}`;
  return `Approve and continue to ${next === 'tasks' ? 'tasks' : next}`;
}

export interface ReviewComment {
  line: number;
  lineText: string;
  comment: string;
}

/** One revision request (03 §1.11.4): `Revise {doc} per these review comments:` … free text. */
export function revisionPrompt(o: { file: string; feedback: string; comments?: readonly ReviewComment[] }): string {
  const parts: string[] = [];
  if (o.comments && o.comments.length) {
    parts.push(`Revise ${o.file} per these review comments:`);
    for (const c of o.comments) parts.push(`- line ${c.line} ("${c.lineText}"): ${c.comment}`);
    if (o.feedback.trim()) parts.push(o.feedback.trim());
  } else {
    parts.push(`Revise ${o.file} per this feedback, in place, then stop again:`);
    parts.push(o.feedback.trim());
  }
  return parts.join('\n');
}

// ───────────────────────────── §1.10.6 / §1.8 analyze requirements ─────────────────────────────

export type FindingCategory = 'ambiguity' | 'inconsistency' | 'conflict' | 'assumption' | 'edge_case';

export interface AnalysisFinding {
  id: string;
  category: FindingCategory | string;
  requirements: string[];
  explanation: string;
  question: string;
  options: { label: string; edit: string }[];
  severity: 'high' | 'medium' | 'low' | string;
}

/** JSON schema of the analysis output (for `--json-schema` / initialize.jsonSchema when wired). */
export const ANALYZE_JSON_SCHEMA = Object.freeze({
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'category', 'requirements', 'explanation', 'question', 'options', 'severity'],
        properties: {
          id: { type: 'string' },
          category: { type: 'string', enum: ['ambiguity', 'inconsistency', 'conflict', 'assumption', 'edge_case'] },
          requirements: { type: 'array', items: { type: 'string' } },
          explanation: { type: 'string' },
          question: { type: 'string' },
          options: {
            type: 'array',
            items: { type: 'object', required: ['label', 'edit'], properties: { label: { type: 'string' }, edit: { type: 'string' } } },
          },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
});

export function analyzePrompt(o: { dir: string; file?: string }): string {
  const file = o.file ?? 'requirements.md';
  return `Analyze ${o.dir}/${file} (read-only; do not edit files). Reason across ALL requirements
together, not one by one. Report only real problems in these categories:
inconsistency (criteria that cannot all hold), ambiguity (terms that would lead to different
implementations), conflict (functional vs non-functional constraints that cannot all be met),
assumption (undefined concepts/behaviors referenced), edge_case (missing failure modes,
boundaries, concurrency). For each finding give the criterion ids involved, a plain-language
explanation, one clarifying question, and 1-3 concrete fix options written as replacement or new
EARS criteria. Output only the JSON object matching the schema.
Schema: {"findings":[{"id":"F1","category":"ambiguity|inconsistency|conflict|assumption|edge_case",
"requirements":["2.3","4.1"],"explanation":"…","question":"…",
"options":[{"label":"…","edit":"<replacement or new criterion text>"}],"severity":"high|medium|low"}]}
When there are no real problems, output {"findings":[]}.`;
}

function extractJsonObject(text: string): string | undefined {
  const fence = /```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/i.exec(text);
  if (fence) return fence[1];
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  return a >= 0 && b > a ? text.slice(a, b + 1) : undefined;
}

/** Parse the analysis turn's answer (tolerates a fence or prose around the JSON object). */
export function parseAnalysis(text: string): { findings: AnalysisFinding[] } | { error: string } {
  const body = extractJsonObject(text);
  if (body === undefined) return { error: 'no JSON object in the analysis output' };
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (e) {
    return { error: `invalid JSON in the analysis output (${e instanceof Error ? e.message : String(e)})` };
  }
  const list = raw && typeof raw === 'object' ? (raw as { findings?: unknown }).findings : undefined;
  if (!Array.isArray(list)) return { error: 'the analysis output has no "findings" array' };
  const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
  const findings: AnalysisFinding[] = [];
  list.forEach((f, i) => {
    if (!f || typeof f !== 'object') return;
    const o = f as Record<string, unknown>;
    const options = Array.isArray(o.options)
      ? o.options
          .map((x) =>
            typeof x === 'string'
              ? { label: x, edit: x }
              : x && typeof x === 'object'
                ? { label: str((x as Record<string, unknown>).label), edit: str((x as Record<string, unknown>).edit) }
                : undefined,
          )
          .filter((x): x is { label: string; edit: string } => !!x && (x.label !== '' || x.edit !== ''))
          .map((x) => ({ label: x.label || x.edit, edit: x.edit || x.label }))
      : [];
    findings.push({
      id: str(o.id) || `F${i + 1}`,
      category: str(o.category) || 'ambiguity',
      requirements: Array.isArray(o.requirements) ? o.requirements.map(str).filter(Boolean) : [],
      explanation: str(o.explanation),
      question: str(o.question),
      options,
      severity: str(o.severity) || 'medium',
    });
  });
  return { findings };
}

export interface FindingAnswer {
  finding: AnalysisFinding;
  /** Chosen option edit or the user's own answer. */
  resolution: string;
}

/** Turn B of Analyze Requirements (03 §1.8 step 3): apply all answers in one write turn. */
export function applyFindingsPrompt(o: { dir: string; file?: string; answers: readonly FindingAnswer[] }): string {
  const file = o.file ?? 'requirements.md';
  const lines = [
    `Update ${o.dir}/${file} to resolve these findings. Change only what each resolution requires, keep`,
    'the document structure and EARS form, keep existing criterion numbering stable (append new',
    'criteria at the end of their requirement), and do not edit any other file.',
  ];
  for (const a of o.answers) {
    const reqs = a.finding.requirements.length ? `; criteria ${a.finding.requirements.join(', ')}` : '';
    lines.push(`- ${a.finding.id} (${a.finding.category}${reqs}): ${a.finding.question || a.finding.explanation}`);
    lines.push(`  Resolution: ${a.resolution}`);
  }
  return lines.join('\n');
}

// ───────────────────────────── §1.10.8 task execution ─────────────────────────────

export interface TaskPromptInput {
  id: string;
  title: string;
  name: string;
  dir: string;
  requirementRefs: readonly string[];
  details?: readonly string[];
  /** Sub-task lines (`[ ] 2.1 Title`) when a parent is executed as one unit. */
  subTasks?: readonly string[];
  isCheckpoint?: boolean;
  /** PreTaskExec agent-action prompts, prepended (00 §2.4). */
  hookPrompts?: readonly string[];
}

export function taskExecutionPrompt(t: TaskPromptInput): string {
  const refs = t.requirementRefs.length
    ? `- Verify against the referenced requirements: _Requirements: ${t.requirementRefs.join(', ')}_. Run the relevant tests/build.`
    : '- Verify against the task details and the design. Run the relevant tests/build.';
  const body = [
    `Execute Task: ${t.id} ${t.title}`,
    `Spec: ${t.name} (${t.dir}). The task is marked [-] in tasks.md because it is the task you are executing`,
    'now. Rules:',
    '- You have the requirements, design, and task list above; follow them.',
    '- If this task has sub-tasks, they are listed below and are part of this execution, in order.',
    '- Implement ONLY this task. Do not start other tasks, even if they look small.',
    refs,
    '- Do NOT edit checkboxes in tasks.md; the tool manages them.',
    `- Finish with a final line exactly "${TASK_RESULT_PREFIX} completed" or "${TASK_RESULT_PREFIX} blocked - <reason>",`,
    '  preceded by a short summary of changes and verification.',
  ];
  if (t.isCheckpoint) {
    body.push(
      '- This is a CHECKPOINT: do not implement new functionality. Run the full test suite and build.',
      `  If anything fails, or a question for the user arises, report it and finish with "${TASK_RESULT_PREFIX} blocked - <reason>".`,
    );
  }
  if (t.details && t.details.length) {
    body.push('Task details:');
    for (const d of t.details) body.push(`- ${d}`);
  }
  if (t.subTasks && t.subTasks.length) {
    body.push('Sub-tasks:');
    for (const s of t.subTasks) body.push(`- ${s}`);
  }
  const text = body.join('\n');
  return t.hookPrompts && t.hookPrompts.length ? `${t.hookPrompts.join('\n\n')}\n\n${text}` : text;
}

export interface TaskResultSignal {
  status: 'completed' | 'blocked';
  reason?: string;
}

/**
 * The last `TASK_RESULT: completed` / `TASK_RESULT: blocked - <reason>` line of the model's final
 * text (markdown emphasis/backticks around it tolerated). `blocked` counts anywhere; `completed`
 * only when unqualified and followed by nothing but blank/fence/emphasis lines. undefined ⇒ no
 * unambiguous signal ⇒ the task is NOT complete (03 §1.7.2, KI:#11786).
 */
export function parseTaskResult(text: string): TaskResultSignal | undefined {
  const lines = text.split(/\r?\n/);
  /** Lines that may follow the sentinel without making it ambiguous (fence closers, emphasis, rules). */
  const trivial = (s: string): boolean => /^[\s*_`~>\-=.]*$/.test(s);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.trim().replace(/^>\s*/, '').replace(/^[*_`]+|[*_`]+$/g, '').trim();
    const m = /^TASK_RESULT:[ \t]*(completed|blocked)\b[ \t]*(?:[-–—:][ \t]*(.*)|[.!]*)$/i.exec(l);
    if (!m) continue;
    const status = m[1]!.toLowerCase() as 'completed' | 'blocked';
    const reason = (m[2] ?? '').replace(/[*_`]+$/g, '').trim();
    if (status === 'blocked') return { status, reason: reason || 'no reason given' };
    // `completed` counts only as the unqualified final line ("TASK_RESULT: completed" exactly,
    // 03 §1.10.8): a qualifier ("completed - partially") or text after it makes the result
    // ambiguous, and an ambiguous result must never mark the task [x] (03 §1.7.2, KI:#11786).
    if (reason.replace(/[.!]+$/, '') !== '') return undefined;
    if (!lines.slice(i + 1).every(trivial)) return undefined;
    return { status };
  }
  return undefined;
}

// ───────────────────────────── §1.10.9 sync ─────────────────────────────

export function syncPrompt(o: { dir: string; ws: string }): string {
  return `Compare ${o.dir}/tasks.md with the current code in ${o.ws}, and with requirements/design. (1) For each
unchecked task already fully implemented (code + tests exist), change its box to [x]. (2) If
requirements contain criteria not covered by any task, append new tasks (continue numbering)
with _Requirements:_ refs, and update the Task Dependency Graph. Do not modify other text.
Report what changed.`;
}
