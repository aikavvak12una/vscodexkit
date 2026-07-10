"use strict";

const crypto = require("node:crypto");

const RULE_VERSION = 1;
const RETRY_HANDLER_KEY = '"retry-safety-buffered-turn-for-host"';
const IDENTIFIER = "[A-Za-z_$][\\w$]*";

class SymbolResolutionError extends Error {
  constructor(hookPoint, state, message) {
    super(`HookPoint[${hookPoint}] state=${state}: ${message}`);
    this.name = "SymbolResolutionError";
    this.hookPoint = hookPoint;
    this.state = state;
  }
}

function resolveWebviewRetryPlan(source) {
  if (typeof source !== "string" || source.length === 0) {
    throw new SymbolResolutionError("webview-retry-command", "MISSING", "bundle source is empty");
  }

  const handlerKeyIndex = findUniqueNeedle(source, RETRY_HANDLER_KEY, "retry handler key");
  const header = resolveHandlerHeader(source, handlerKeyIndex);
  const bodyEnd = findMatchingBrace(source, header.bodyStart);
  const body = source.slice(header.bodyStart + 1, bodyEnd);
  const bodyOffset = header.bodyStart + 1;

  const lookup = matchExactlyOnce(
    body,
    new RegExp(
      `(?:let|const|var)\\s+(${IDENTIFIER})\\s*=\\s*${escapeRegExp(header.manager)}\\.getConversation\\(\\s*${escapeRegExp(header.conversationId)}\\s*\\)\\s*[,;]\\s*(?:(?:let|const|var)\\s+)?(${IDENTIFIER})\\s*=\\s*(${IDENTIFIER})\\(\\s*\\1\\s*,\\s*${escapeRegExp(header.turnId)}\\s*\\)`
    ),
    "turn lookup"
  );
  const conversationState = lookup[1];
  const turn = lookup[2];
  const turnLookup = lookup[3];

  const interrupt = matchExactlyOnce(
    body,
    new RegExp(
      `${escapeRegExp(header.manager)}\\.interruptConversation\\(\\s*${escapeRegExp(header.conversationId)}\\s*\\)`
    ),
    "conversation interrupt"
  );

  const reacquire = matchExactlyOnce(
    body,
    new RegExp(
      `(?:let|const|var)\\s+(${IDENTIFIER})\\s*=\\s*${escapeRegExp(header.manager)}\\.getConversation\\(\\s*${escapeRegExp(header.conversationId)}\\s*\\)`
    ),
    "post-interrupt conversation state",
    (match) => match.index > interrupt.index
  );
  const rollbackState = reacquire[1];

  const rollback = matchExactlyOnce(
    body,
    new RegExp(
      `(?<![.\\w$])(${IDENTIFIER})\\(\\s*${escapeRegExp(header.manager)}\\s*,\\s*\\{\\s*conversationId\\s*:\\s*${escapeRegExp(header.conversationId)}\\s*,\\s*conversationState\\s*:\\s*(${IDENTIFIER})\\s*,\\s*rollbackResponse\\s*:\\s*await\\s+${escapeRegExp(header.manager)}\\.sendRequest\\(\\s*(?:\`thread/rollback\`|"thread/rollback"|'thread/rollback')\\s*,\\s*\\{\\s*threadId\\s*:\\s*${escapeRegExp(header.conversationId)}\\s*,\\s*numTurns\\s*:\\s*1\\s*\\}\\s*\\)\\s*\\}\\s*\\)`
    ),
    "rollback state application"
  );
  const applyRollback = rollback[1];
  if (rollback[2] !== rollbackState) {
    throw new SymbolResolutionError(
      "webview-retry-command",
      "MISSING",
      "rollback does not consume the post-interrupt conversation state"
    );
  }

  const restart = matchExactlyOnce(
    body,
    new RegExp(
      `(?:let|const|var)\\s+(${IDENTIFIER})\\s*=\\s*\\(\\s*0\\s*,\\s*(${IDENTIFIER})\\.default\\s*\\)\\(\\s*${escapeRegExp(turn)}\\.params\\s*,\\s*\\[\\s*(?:\`clientUserMessageId\`|"clientUserMessageId"|'clientUserMessageId')\\s*,\\s*(?:\`threadId\`|"threadId"|'threadId')\\s*\\]\\s*\\)\\s*;\\s*await\\s+(${IDENTIFIER})\\(\\s*${escapeRegExp(header.manager)}\\s*,\\s*${escapeRegExp(header.conversationId)}\\s*,\\s*\\{\\s*\\.\\.\\.\\1(?:\\s*[,}])`
    ),
    "turn parameter restart"
  );
  const omitModule = restart[2];
  const startTurn = restart[3];

  requireExactlyOnce(
    body,
    /inheritThreadSettings\s*:\s*(?:!1|false)/,
    "non-inherited thread settings"
  );

  const offsets = Object.freeze({
    handlerKey: handlerKeyIndex,
    bodyStart: header.bodyStart,
    bodyEnd,
    turnLookup: bodyOffset + lookup.index,
    interrupt: bodyOffset + interrupt.index,
    reacquireConversation: bodyOffset + reacquire.index,
    applyRollback: bodyOffset + rollback.index,
    omitAndStartTurn: bodyOffset + restart.index
  });
  requireCausalOrder(offsets);

  const handlerSource = source.slice(handlerKeyIndex, bodyEnd + 1);
  return Object.freeze({
    ruleVersion: RULE_VERSION,
    hookPoint: "webview-retry-command",
    state: "FOUND",
    handlerKey: RETRY_HANDLER_KEY,
    handlerKeyOffset: handlerKeyIndex,
    commandWrapper: header.commandWrapper,
    turnLookup,
    applyRollback,
    omitModule,
    startTurn,
    evidenceHash: crypto.createHash("sha256").update(handlerSource, "utf8").digest("hex"),
    offsets,
    evidence: Object.freeze({
      manager: header.manager,
      conversationId: header.conversationId,
      turnId: header.turnId,
      model: header.model,
      conversationState,
      turn,
      rollbackState
    })
  });
}

function inspectWebviewRetryPlan(source) {
  try {
    return resolveWebviewRetryPlan(source);
  } catch (error) {
    return Object.freeze({
      ruleVersion: RULE_VERSION,
      hookPoint: "webview-retry-command",
      state: error instanceof SymbolResolutionError ? error.state : "ERROR",
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function resolveHandlerHeader(source, handlerKeyIndex) {
  const tail = source.slice(handlerKeyIndex + RETRY_HANDLER_KEY.length);
  const match = tail.match(
    new RegExp(
      `^\\s*:\\s*(${IDENTIFIER})\\(\\s*async\\s*\\(\\s*(${IDENTIFIER})\\s*,\\s*\\{([^{}]+)\\}\\s*\\)\\s*=>\\s*\\{`
    )
  );
  if (!match) {
    throw new SymbolResolutionError(
      "webview-retry-command",
      "MISSING",
      "retry handler header does not match the supported structure"
    );
  }

  const fields = match[3];
  const conversationId = resolveDestructuredField(fields, "conversationId");
  const turnId = resolveDestructuredField(fields, "turnId");
  const model = resolveDestructuredField(fields, "model");
  return {
    commandWrapper: match[1],
    manager: match[2],
    conversationId,
    turnId,
    model,
    bodyStart: handlerKeyIndex + RETRY_HANDLER_KEY.length + match[0].length - 1
  };
}

function resolveDestructuredField(fields, field) {
  const matches = findPatternMatches(
    fields,
    new RegExp(
      `(?:^|,)\\s*${escapeRegExp(field)}(?:\\s*:\\s*(${IDENTIFIER}))?\\s*(?=,|$)`
    )
  );
  if (matches.length !== 1) {
    const state = matches.length === 0 ? "MISSING" : "AMBIGUOUS";
    throw new SymbolResolutionError(
      "webview-retry-command",
      state,
      `${field} binding count is ${matches.length}`
    );
  }
  return matches[0][1] || field;
}

function findUniqueNeedle(source, needle, label) {
  const matches = [];
  let offset = 0;
  while (true) {
    const index = source.indexOf(needle, offset);
    if (index === -1) break;
    matches.push(index);
    offset = index + needle.length;
  }
  if (matches.length !== 1) {
    const state = matches.length === 0 ? "MISSING" : "AMBIGUOUS";
    throw new SymbolResolutionError(
      "webview-retry-command",
      state,
      `${label} count is ${matches.length}`
    );
  }
  return matches[0];
}

function matchExactlyOnce(source, pattern, label, predicate = null) {
  const matches = findPatternMatches(source, pattern).filter((match) =>
    predicate ? predicate(match) : true
  );
  if (matches.length !== 1) {
    const state = matches.length === 0 ? "MISSING" : "AMBIGUOUS";
    throw new SymbolResolutionError(
      "webview-retry-command",
      state,
      `${label} candidate count is ${matches.length}`
    );
  }
  return matches[0];
}

function requireCausalOrder(offsets) {
  const ordered = [
    ["turn lookup", offsets.turnLookup],
    ["conversation interrupt", offsets.interrupt],
    ["conversation reacquire", offsets.reacquireConversation],
    ["rollback state application", offsets.applyRollback],
    ["omit parameters and start turn", offsets.omitAndStartTurn]
  ];
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1][1] >= ordered[index][1]) {
      throw new SymbolResolutionError(
        "webview-retry-command",
        "MISSING",
        `${ordered[index][0]} does not follow ${ordered[index - 1][0]}`
      );
    }
  }
}

function requireExactlyOnce(source, pattern, label) {
  matchExactlyOnce(source, pattern, label);
}

function findPatternMatches(source, pattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return Array.from(source.matchAll(new RegExp(pattern.source, flags)));
}

// The handler is isolated before structural matching so braces inside strings,
// comments, or regular expressions cannot leak into neighbouring handlers.
function findMatchingBrace(source, openIndex) {
  if (source[openIndex] !== "{") {
    throw new SymbolResolutionError(
      "webview-retry-command",
      "ERROR",
      `expected handler body at offset ${openIndex}`
    );
  }

  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '"' || char === "'" || char === "`") {
      index = skipQuoted(source, index, char);
      continue;
    }
    if (char === "/" && next === "/") {
      index = skipLineComment(source, index + 2);
      continue;
    }
    if (char === "/" && next === "*") {
      index = skipBlockComment(source, index + 2);
      continue;
    }
    if (char === "/" && looksLikeRegexStart(source, index)) {
      index = skipRegexLiteral(source, index);
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new SymbolResolutionError(
    "webview-retry-command",
    "ERROR",
    "retry handler body is unbalanced"
  );
}

function skipQuoted(source, start, quote) {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
    } else if (source[index] === quote) {
      return index;
    }
  }
  return source.length - 1;
}

function skipLineComment(source, start) {
  const end = source.indexOf("\n", start);
  return end === -1 ? source.length - 1 : end;
}

function skipBlockComment(source, start) {
  const end = source.indexOf("*/", start);
  return end === -1 ? source.length - 1 : end + 1;
}

function looksLikeRegexStart(source, index) {
  let previous = index - 1;
  while (previous >= 0 && /\s/.test(source[previous])) previous -= 1;
  if (previous < 0) return true;
  return "([{=,:;!?&|+-*%^~<>".includes(source[previous]);
}

function skipRegexLiteral(source, start) {
  let inCharacterClass = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
    } else if (char === "[") {
      inCharacterClass = true;
    } else if (char === "]") {
      inCharacterClass = false;
    } else if (char === "/" && !inCharacterClass) {
      while (/[A-Za-z]/.test(source[index + 1] || "")) index += 1;
      return index;
    }
  }
  return source.length - 1;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  RETRY_HANDLER_KEY,
  RULE_VERSION,
  SymbolResolutionError,
  inspectWebviewRetryPlan,
  resolveWebviewRetryPlan
};
