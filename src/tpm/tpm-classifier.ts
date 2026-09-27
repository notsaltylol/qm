import type { JevAnswer, JevClient, JevQuestion } from "../classify/jev-client.ts";
import {
  TPM_COLUMNS,
  TPM_KINDS,
  type TpmColumn,
  type TpmEdgeKind,
  type TpmItem,
  type TpmJudgment,
  type TpmKind,
  type TpmRubricQuestion,
} from "./tpm-store.ts";

export const CONFIRM_EDGE_AT = 0.85;
export const PROPOSE_EDGE_AT = 0.5;
export const ACCEPT_CHOICE_AT = 0.6;
const BODY_CHARS = 4_000;
const CANDIDATE_CHARS = 500;

export const KIND_CRITERIA: Record<TpmKind, { what: string; not_for: string; examples: string[] }> = {
  ticket: {
    what: "A unit of engineering or product work that someone on the team will do: a bug fix, feature, task, or chore.",
    not_for: "A problem report written by or for a customer, a reference document, or a dated goal that groups work.",
    examples: ["Fix OAuth token refresh race", "Add CSV export to reports page"],
  },
  customer_issue: {
    what: "A problem, complaint, or request reported by or on behalf of a customer or end user.",
    not_for: "The internal work item planned to fix the problem.",
    examples: ["Acme says exports time out for large accounts", "Support ticket: customer cannot log in with SSO"],
  },
  document: {
    what: "A written reference such as a spec, design doc, PRD, runbook, RFC, or meeting notes.",
    not_for: "A request for work or a report of a problem.",
    examples: ["Billing v2 design doc", "Q3 launch runbook"],
  },
  milestone: {
    what: "A dated goal, launch, release, or deliverable that groups several pieces of work.",
    not_for: "A single piece of work that one person finishes.",
    examples: ["GA launch of the new dashboard", "SOC 2 audit readiness by March"],
  },
};

export const COLUMN_CRITERIA: Record<TpmColumn, string> = {
  backlog: "Captured but not yet planned or prioritized; nobody has committed to doing it soon.",
  ready: "Planned and ready to start, but nobody has started working on it yet.",
  in_progress: "Someone is actively working on it right now.",
  blocked:
    "Started or planned, but it cannot move forward because it is waiting on another team, person, decision, or piece of work.",
  in_review: "The work itself is done and it is waiting for code review, QA, sign-off, or approval.",
  done: "Finished, shipped, resolved, or closed.",
};

export const CUSTOMER_IMPACT_LEVELS = [
  "No customer impact is described.",
  "Customers are inconvenienced but have a workaround.",
  "A key customer workflow is degraded or unreliable.",
  "Customers are blocked, or revenue or a renewal is at risk.",
];

export interface ItemDraft {
  title: string;
  body: string;
  kind?: TpmKind;
  column?: TpmColumn;
}

export interface Relation {
  kind: TpmEdgeKind;
  fromId: string;
  toId: string;
  probability: number;
}

export interface ItemClassification {
  kind: { value: TpmKind; confidence: number } | null;
  column: { value: TpmColumn; confidence: number } | null;
  mentionsBlocker: number;
  customerImpact: { score: number; confidence: number };
  custom: Record<string, TpmJudgment>;
  links: LinkJudgments;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  questionCount: number;
}

const workKinds = new Set<TpmKind>(["ticket", "milestone"]);

function excerpt(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const LINK_QUESTIONS = [
  "blocked_by",
  "blocks",
  "item_fixes",
  "candidate_fixes",
  "item_describes",
  "candidate_describes",
] as const;
type LinkQuestion = (typeof LINK_QUESTIONS)[number];

function candidateQuestions(index: number): Record<string, JevQuestion> {
  const ref = `\`candidates[${index}]\``;
  const dependency = (waiting: string, on: string): JevQuestion => ({
    type: "noul",
    instructions: `Does ${waiting} say or clearly imply that its work cannot proceed until the work in ${on} is finished?`,
    criteria: {
      true: `${waiting} names ${on}, or the exact work ${on} describes, as something it is waiting on or depends on.`,
      false: "The two are only related by topic, or the dependency runs the other way, or no dependency is stated.",
    },
  });
  const fixes = (work: string, problem: string): JevQuestion => ({
    type: "noul",
    instructions: `Is ${problem} a customer problem, and would finishing the work described in ${work} fix or resolve it?`,
  });
  const describes = (doc: string, work: string): JevQuestion => ({
    type: "noul",
    instructions: `Is ${doc} a written document, and does it describe the plan, design, requirements, or status of the work in ${work}?`,
  });
  const questions: Record<LinkQuestion, JevQuestion> = {
    blocked_by: dependency("`item`", ref),
    blocks: dependency(ref, "`item`"),
    item_fixes: fixes("`item`", ref),
    candidate_fixes: fixes(ref, "`item`"),
    item_describes: describes("`item`", ref),
    candidate_describes: describes(ref, "`item`"),
  };
  return Object.fromEntries(Object.entries(questions).map(([key, question]) => [`${key}_${index}`, question]));
}

function rubricQuestion(question: TpmRubricQuestion): JevQuestion {
  if (question.type === "choice") {
    return {
      type: "choice",
      instructions: question.instructions,
      criteria: question.criteria as Record<string, string>,
    };
  }
  if (question.type === "score") {
    return { type: "score", instructions: question.instructions, criteria: question.criteria as string[] };
  }
  return { type: "noul", instructions: question.instructions };
}

function judgment(answer: JevAnswer): TpmJudgment {
  if (answer.type === "noul") return { type: "noul", value: answer.noul };
  if (answer.type === "choice") return { type: "choice", value: answer.choice, confidence: answer.confidence };
  return { type: "score", value: answer.score, confidence: answer.confidence };
}

export function buildItemQuestions(
  draft: ItemDraft,
  candidates: readonly TpmItem[],
  rubric: readonly TpmRubricQuestion[],
): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {};
  if (!draft.kind) {
    questions.kind = {
      type: "choice",
      instructions: "What kind of item is `item`?",
      criteria: Object.fromEntries(TPM_KINDS.map((kind) => [kind, KIND_CRITERIA[kind]])),
    };
  }
  if (!draft.column) {
    questions.column = {
      type: "choice",
      instructions: "Which stage of work does `item` describe itself as being in right now?",
      criteria: Object.fromEntries(TPM_COLUMNS.map((column) => [column, COLUMN_CRITERIA[column]])),
    };
  }
  questions.mentions_blocker = {
    type: "noul",
    instructions:
      "Does `item.body` say that this work is currently blocked, stalled, or waiting on another team, person, decision, or piece of work?",
  };
  questions.customer_impact = {
    type: "score",
    instructions: "How severely does `item` say customers are affected?",
    criteria: CUSTOMER_IMPACT_LEVELS,
  };
  candidates.forEach((_candidate, index) => Object.assign(questions, candidateQuestions(index)));
  for (const question of rubric) questions[`custom_${question.key}`] = rubricQuestion(question);
  return questions;
}

export function itemState(draft: ItemDraft, candidates: readonly TpmItem[]): unknown {
  return {
    item: {
      title: draft.title,
      body: excerpt(draft.body, BODY_CHARS),
      ...(draft.kind ? { kind: draft.kind } : {}),
    },
    candidates: candidates.map((candidate) => ({
      kind: candidate.kind,
      title: candidate.title,
      stage: candidate.column,
      summary: excerpt(candidate.body, CANDIDATE_CHARS),
    })),
  };
}

export type LinkJudgments = Array<{ candidateId: string; p: Record<LinkQuestion, number> }>;

export function resolveRelations(
  itemId: string,
  kind: TpmKind,
  judgments: LinkJudgments,
  kindOf: (id: string) => TpmKind | undefined,
): Relation[] {
  const out: Relation[] = [];
  const push = (edgeKind: TpmEdgeKind, fromId: string, toId: string, p: number) => {
    if (p >= PROPOSE_EDGE_AT && fromId !== toId) out.push({ kind: edgeKind, fromId, toId, probability: p });
  };
  for (const { candidateId, p } of judgments) {
    const other = kindOf(candidateId);
    if (!other) continue;
    if (workKinds.has(kind) && workKinds.has(other)) {
      push("blocks", candidateId, itemId, p.blocked_by);
      push("blocks", itemId, candidateId, p.blocks);
    }
    if (workKinds.has(kind) && other === "customer_issue") push("addresses", itemId, candidateId, p.item_fixes);
    if (kind === "customer_issue" && workKinds.has(other)) push("addresses", candidateId, itemId, p.candidate_fixes);
    if (kind === "document" && other !== "document") push("documents", itemId, candidateId, p.item_describes);
    if (other === "document" && kind !== "document") push("documents", candidateId, itemId, p.candidate_describes);
  }
  return out;
}

function linkJudgments(answers: Record<string, JevAnswer>, candidates: readonly TpmItem[]): LinkJudgments {
  return candidates.map((candidate, index) => ({
    candidateId: candidate.id,
    p: Object.fromEntries(
      LINK_QUESTIONS.map((key) => {
        const answer = answers[`${key}_${index}`];
        return [key, answer?.type === "noul" ? answer.noul : 0];
      }),
    ) as Record<LinkQuestion, number>,
  }));
}

export async function classifyItem(
  client: JevClient,
  draft: ItemDraft,
  candidates: readonly TpmItem[],
  rubric: readonly TpmRubricQuestion[],
  signal?: AbortSignal,
): Promise<ItemClassification> {
  const questions = buildItemQuestions(draft, candidates, rubric);
  const result = await client.evaluate(itemState(draft, candidates), questions, signal);
  const { answers } = result;
  const choice = (key: string) => {
    const answer = answers[key];
    return answer?.type === "choice" ? { value: answer.choice, confidence: answer.confidence } : null;
  };
  const blocker = answers.mentions_blocker;
  const impact = answers.customer_impact;
  const custom: Record<string, TpmJudgment> = {};
  for (const question of rubric) {
    const answer = answers[`custom_${question.key}`];
    if (answer) custom[question.key] = judgment(answer);
  }
  return {
    kind: choice("kind") as ItemClassification["kind"],
    column: choice("column") as ItemClassification["column"],
    mentionsBlocker: blocker?.type === "noul" ? blocker.noul : 0,
    customerImpact:
      impact?.type === "score" ? { score: impact.score, confidence: impact.confidence } : { score: 0, confidence: 0 },
    custom,
    links: linkJudgments(answers, candidates),
    model: result.model,
    usage: result.usage,
    questionCount: Object.keys(questions).length,
  };
}
