/** Effective persisted model settings exposed by Letta management records. */
export interface ModelSettingsSnapshot {
  /** Configured model handle, when the management record identifies it. */
  model?: string;
  /** Persisted tier, including "none"; undefined means absent or unconfirmed. */
  reasoningEffort?: string;
  /** Effective context-window limit, when persisted. */
  contextWindow?: number;
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function contextLimit(value: RecordValue): number | undefined {
  if (typeof value.context_window_limit === "number") return value.context_window_limit;
  const settings = isRecord(value.model_settings) ? value.model_settings : undefined;
  if (settings && typeof settings.context_window_limit === "number") {
    return settings.context_window_limit;
  }
  const legacy = isRecord(value.llm_config) ? value.llm_config : undefined;
  return legacy && typeof legacy.context_window === "number" ? legacy.context_window : undefined;
}

function settingsOf(agent: RecordValue): RecordValue {
  // model_settings is the current canonical shape. Only use the old llm_config
  // location when the canonical field is absent/null, not when it is {}.
  if (isRecord(agent.model_settings)) return agent.model_settings;
  const legacy = isRecord(agent.llm_config) ? agent.llm_config : undefined;
  return legacy && isRecord(legacy.model_settings) ? legacy.model_settings : {};
}

function effectiveEffort(settings: RecordValue): string | undefined {
  if ((isRecord(settings.thinking) && settings.thinking.type === "disabled") || settings.enable_reasoner === false) {
    return "none";
  }
  // Explicit null is a deliberate clear, even if a legacy alias also exists.
  if (settings.reasoning === null || settings.reasoning_effort === null || settings.effort === null) {
    return undefined;
  }
  if (isRecord(settings.reasoning) && settings.reasoning.reasoning_effort === null) {
    return undefined;
  }
  if (Object.hasOwn(settings, "reasoning")) {
    if (settings.reasoning === null) return undefined;
    if (isRecord(settings.reasoning)) {
      if (Object.hasOwn(settings.reasoning, "reasoning_effort")) {
        return nonEmptyString(settings.reasoning.reasoning_effort);
      }
    }
  }
  if (Object.hasOwn(settings, "reasoning_effort")) {
    return nonEmptyString(settings.reasoning_effort);
  }
  if (Object.hasOwn(settings, "effort")) return nonEmptyString(settings.effort);
  return undefined;
}

/**
 * Read a management API agent/conversation pair without inventing defaults.
 * Conversation model and context limits override the agent; its non-empty
 * model_settings overlay the agent settings. A changed conversation model does
 * not inherit an agent reasoning tier unless the conversation specifies one.
 * Returns undefined when a scoped record is malformed or unavailable.
 */
export function modelSnapshot(agentValue: unknown, conversationValue?: unknown): ModelSettingsSnapshot | undefined {
  if (!isRecord(agentValue)) return undefined;
  if (malformedScope(agentValue) || (conversationValue != null &&
      (!isRecord(conversationValue) || malformedScope(conversationValue)))) return undefined;
  const agent = agentValue;
  const conversation = isRecord(conversationValue) ? conversationValue : undefined;
  const agentSettings = settingsOf(agent);
  const conversationSettings = conversation && isRecord(conversation.model_settings)
    ? conversation.model_settings
    : undefined;
  const hasConversationSettings = Boolean(conversationSettings && Object.keys(conversationSettings).length > 0);
  const inherited = { ...agentSettings };
  if (hasExplicitEffort(conversationSettings)) {
    for (const key of ["reasoning", "reasoning_effort", "effort", "thinking", "enable_reasoner"]) delete inherited[key];
  }
  const settings: RecordValue = hasConversationSettings ? { ...inherited, ...conversationSettings } : inherited;

  const agentModel = nonEmptyString(agent.model);
  const conversationModel = conversation ? nonEmptyString(conversation.model) : undefined;
  const model = conversationModel ?? agentModel;
  const switchedConversationModel = Boolean(conversationModel && agentModel && conversationModel !== agentModel);
  let reasoningEffort = effectiveEffort(settings);
  if (switchedConversationModel && !hasExplicitEffort(conversationSettings)) {
    reasoningEffort = undefined;
  }
  const conversationContext = conversation ? contextLimit(conversation) : undefined;
  const contextWindow = conversationContext ?? contextLimit(agent);

  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

function malformedScope(value: RecordValue): boolean {
  if (value.model != null && (typeof value.model !== "string" || !value.model.trim())) return true;
  if (value.model_settings != null && !isRecord(value.model_settings)) return true;
  const settings = isRecord(value.model_settings) ? value.model_settings : undefined;
  const legacy = isRecord(value.llm_config) ? value.llm_config : undefined;
  const validLimit = (limit: unknown) => limit == null ||
    (typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0);
  if (!validLimit(value.context_window_limit) || !validLimit(settings?.context_window_limit) ||
      !validLimit(legacy?.context_window)) return true;
  if (settings?.reasoning != null && !isRecord(settings.reasoning)) return true;
  const reasoning = settings && isRecord(settings.reasoning) ? settings.reasoning : undefined;
  return [settings?.reasoning_effort, settings?.effort, reasoning?.reasoning_effort]
    .some((effort) => effort != null && typeof effort !== "string");
}

function hasExplicitEffort(settings: RecordValue | undefined): boolean {
  if (!settings) return false;
  if (Object.hasOwn(settings, "reasoning_effort") || Object.hasOwn(settings, "effort")) return true;
  return (
    (isRecord(settings.reasoning) && Object.hasOwn(settings.reasoning, "reasoning_effort")) ||
    Object.hasOwn(settings, "reasoning") ||
    settings.enable_reasoner === false ||
    (isRecord(settings.thinking) && settings.thinking.type === "disabled")
  );
}
