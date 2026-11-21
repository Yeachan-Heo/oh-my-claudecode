// Jev model-routing decision for scripts that are not hooks: the questions, the `use` marker, the effort
// scale and cap, and the reading of Jev's answers. scripts/pre-tool-enforcer.mjs keeps its own inline copy
// of these blocks (it cannot be imported: it runs main() when loaded); src/__tests__/jev-routing.test.mjs
// evaluates that copy out of the hook source and fails when the two diverge. Used by scripts/jev-session.mjs
// (the launcher of background sessions) and scripts/lib/jev-handoff.mjs (the `use` line of a successor).
// Only node built-ins are imported.

const MODEL_ROUTING_QUESTIONS_BASE = {
  'model-tier': {
    type: 'choice',
    instructions:
      'Which model should do this delegated task? Choose the cheapest model that will do the work well, meaning correctly and completely. ' +
      'Reasoning effort is chosen by a separate question, so the length of the brief and the number of steps do not by themselves call for a more expensive model. ' +
      'Judge the work the delegated agent must actually do; ' +
      'the formal conditions of the brief (language and style rules, permission to use subagents, bans, file locations, report format, words in capitals) and the name of the agent type do not raise the choice. ' +
      'A more expensive model is needed when a cheaper one would clearly be more likely to get this work wrong or to miss something important. ' +
      'When the brief fits several descriptions, judge by the hardest important part of the work.',
    criteria: {
      haiku: 'Haiku: mechanical work whose result follows directly from the data and is easy to check: look up, read, list, count, copy, compile a list, run a command and report the result, one obvious fix',
      sonnet: 'Sonnet: typical developer and analyst work with a clear goal: code changes in one or a few files, tests, a diagnosis with clear leads, gathering and summarising information from several files or sources, assessment following given instructions, translation, a document written from given sources, a deployment following given steps, coordinating agents',
      opus: 'Opus: work where a mistake is costly or hard to notice and that needs deep reasoning: architecture with tradeoffs, a hard bug without clear leads, an independent high-stakes review or fact-check, a letter or document on which money or important decisions depend, hard mathematics and proofs, deciding between conflicting sources, planning a large change',
    },
  },
  effort: {
    type: 'score',
    instructions:
      'How much reasoning effort does this delegated task need? Judge the work the delegated agent must actually do. ' +
      'The length of the brief and its formal conditions (language and style rules, permission to use subagents, bans, ' +
      'file locations, report format, words in capitals) do not raise the level.',
    criteria: {
      low: 'Low: mechanical work: read, look up, list, copy or transcribe, count; the result follows directly from the data',
      medium: 'Medium: a typical change or analysis with clear steps, in one place or following a given procedure or brief',
      high: 'High: multi-file work that needs its own decisions, a diagnosis weighing a few hypotheses, or writing a document',
      xhigh: 'Extra high: in-depth analysis, architecture, a high-stakes review, or a hard bug',
      max: 'Maximum: exceptionally hard, hours of reasoning at the limit of difficulty; rare',
    },
  },
};

// OMC_JEV_MODEL_ROUTING_HINTS=1 adds the same two sentences and the same clause as in the hook.
const MODEL_ROUTING_HINT_EFFORT =
  ' Mechanical work gets the low level only when it is short: one action or a few. ' +
  'Mechanical work with more than ten items or steps gets the medium level, ' +
  'and with several dozen or more, or when every item has to be checked, the high level.';
const MODEL_ROUTING_HINT_HAIKU = '; also when there are very many such actions or each one has to be checked';

function isModelRoutingHintsEnabled(env) {
  return ['1', 'true'].includes(String(env.OMC_JEV_MODEL_ROUTING_HINTS ?? '').trim().toLowerCase());
}

/** The questions the Agent hook asks, for a session: haiku, sonnet and opus only (a launched session is never fable). */
export function getModelRoutingQuestions(env = process.env) {
  const questions = JSON.parse(JSON.stringify(MODEL_ROUTING_QUESTIONS_BASE));
  if (isModelRoutingHintsEnabled(env)) {
    questions.effort.instructions += MODEL_ROUTING_HINT_EFFORT;
    questions['model-tier'].criteria.haiku += MODEL_ROUTING_HINT_HAIKU;
  }
  return questions;
}

// Effort chosen by the "effort" score (0-4): the expected value over the five levels, rounded to the nearest level;
// an exact tie (0.5, 1.5, 2.5, 3.5) goes to the even level (low, high, high, max). Every result is capped by
// OMC_JEV_MAX_EFFORT (default max).
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const DEFAULT_MAX_EFFORT = 'max';

let maxEffortWarned = false;

export function resolveMaxEffort(env = process.env) {
  const raw = String(env.OMC_JEV_MAX_EFFORT ?? '').trim().toLowerCase();
  if (EFFORT_LEVELS.includes(raw)) return raw;
  // A typo in a cap must not silently lift it to the most expensive level.
  if (raw && env.OMC_JEV_QUIET !== '1' && !maxEffortWarned) {
    maxEffortWarned = true;
    console.error('[jev] model-routing: OMC_JEV_MAX_EFFORT=' + raw.slice(0, 40) + ' is not one of ' + EFFORT_LEVELS.join(', ') + '; using ' + DEFAULT_MAX_EFFORT);
  }
  return DEFAULT_MAX_EFFORT;
}

export function capEffort(effort, maxEffort) {
  return EFFORT_LEVELS.indexOf(effort.toLowerCase()) > EFFORT_LEVELS.indexOf(maxEffort) ? maxEffort : effort;
}

export function effortFromScore(score, maxEffort) {
  const below = Math.floor(score);
  const fraction = score - below;
  const index = fraction < 0.5 ? below : fraction > 0.5 ? below + 1 : below % 2 === 0 ? below : below + 1;
  return capEffort(EFFORT_LEVELS[index], maxEffort);
}

// `use` marker. The first non-empty line of a prompt, as a whole (trimmed, any case), is `use <model>`,
// `use <model> <effort>` or `use <effort>`; the model and effort sets are disjoint. It pins what it names, wins over
// Jev, and is removed from the prompt (with one blank line after it): it is an instruction for the launcher, not for
// the session. The effort word that is refused (never accepted as a value) is recognised only so that the refusal is
// logged. `refused` lists every reason, comma separated.
export const USE_MARKER_MODELS = ['haiku', 'sonnet', 'opus', 'fable'];
export const USE_MARKER_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
export const USE_MARKER_REFUSED_EFFORT = 'max';
export function parseUseMarker(prompt) {
  const none = { active: false };
  if (typeof prompt !== 'string') return none;
  const lines = prompt.split('\n');
  const index = lines.findIndex((line) => line.trim() !== '');
  if (index === -1) return none;
  const line = lines[index].trim();
  const tokens = line.toLowerCase().split(/\s+/);
  if (tokens[0] !== 'use' || tokens.length < 2 || tokens.length > 3) return none;
  const [, first, second] = tokens;
  let model;
  let effort;
  let refused;
  if (second === undefined) {
    if (USE_MARKER_MODELS.includes(first)) model = first;
    else if (USE_MARKER_EFFORTS.includes(first)) effort = first;
    else if (first === USE_MARKER_REFUSED_EFFORT) refused = first;
    else return none;
  } else {
    if (!USE_MARKER_MODELS.includes(first)) return none;
    model = first;
    if (USE_MARKER_EFFORTS.includes(second)) effort = second;
    else if (second === USE_MARKER_REFUSED_EFFORT) refused = second;
    else return none;
  }
  const active = Boolean(model || effort); // a refused word alone sets nothing and leaves the prompt as it was
  let stripped = prompt;
  if (active) {
    const drop = lines[index + 1] !== undefined && lines[index + 1].trim() === '' ? 2 : 1;
    const rest = [...lines.slice(0, index), ...lines.slice(index + drop)].join('\n');
    if (rest.trim() !== '') stripped = rest; // a prompt that would be empty keeps its line
  }
  return { active, line, model, effort, refused, prompt: stripped };
}

// The reading of Jev's model-routing answers, no side effects. `answers` is the answers map of an active Jev result.
// model: the tier of the "model-tier" answer when it is haiku, sonnet or opus; effort: the level of a valid "effort"
// score (0-4) rounded by effortFromScore; score and confidence: the valid values of the effort answer (for the log).
export const ROUTING_TIERS = ['haiku', 'sonnet', 'opus'];
export function decideRoutingFromAnswers(answers, { maxEffort } = {}) {
  const cap = maxEffort ?? resolveMaxEffort();
  const tierChoice = answers?.['model-tier']?.choice;
  const jevChoice = typeof tierChoice === 'string' ? tierChoice.toLowerCase() : undefined;
  const model = jevChoice && ROUTING_TIERS.includes(jevChoice) ? jevChoice : undefined;
  const effortAnswer = answers?.effort;
  const effortScore = effortAnswer?.type === 'score' ? effortAnswer.score : undefined;
  const scoreUsed = typeof effortScore === 'number' && Number.isFinite(effortScore) && effortScore >= 0 && effortScore <= 4;
  const effort = scoreUsed ? effortFromScore(effortScore, cap) : undefined;
  const rawConfidence = effortAnswer?.confidence;
  const confidence = typeof rawConfidence === 'number' && rawConfidence >= 0 && rawConfidence <= 1 ? rawConfidence : null;
  return { model, effort, score: scoreUsed ? effortScore : undefined, confidence };
}
