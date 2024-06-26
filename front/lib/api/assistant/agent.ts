import type {
  AgentActionConfigurationType,
  AgentActionsEvent,
  AgentActionSpecification,
  AgentActionSpecificEvent,
  AgentActionSuccessEvent,
  AgentChainOfThoughtEvent,
  AgentConfigurationType,
  AgentErrorEvent,
  AgentGenerationCancelledEvent,
  AgentGenerationSuccessEvent,
  AgentMessageSuccessEvent,
  AgentMessageType,
  ConversationType,
  DustAppRunTokensEvent,
  GenerationCancelEvent,
  GenerationSuccessEvent,
  GenerationTokensEvent,
  LightAgentConfigurationType,
  ModelConfigurationType,
  UserMessageType,
} from "@dust-tt/types";
import {
  assertNever,
  cloneBaseConfig,
  DustProdActionRegistry,
  isDustAppRunConfiguration,
  isProcessConfiguration,
  isRetrievalConfiguration,
  isTablesQueryConfiguration,
  isWebsearchConfiguration,
  removeNulls,
  SUPPORTED_MODEL_CONFIGS,
} from "@dust-tt/types";
import { escapeRegExp } from "lodash";

import { runActionStreamed } from "@app/lib/actions/server";
import { getRunnerforActionConfiguration } from "@app/lib/api/assistant/actions/runners";
import { getAgentConfiguration } from "@app/lib/api/assistant/configuration";
import {
  constructPromptMultiActions,
  renderConversationForModelMultiActions,
} from "@app/lib/api/assistant/generation";
import { runLegacyAgent } from "@app/lib/api/assistant/legacy_agent";
import type { Authenticator } from "@app/lib/auth";
import { redisClient } from "@app/lib/redis";
import logger from "@app/logger/logger";

const CANCELLATION_CHECK_INTERVAL = 500;

// This interface is used to execute an agent. It is not in charge of creating the AgentMessage,
// nor updating it (responsability of the caller based on the emitted events).
export async function* runAgent(
  auth: Authenticator,
  configuration: LightAgentConfigurationType,
  conversation: ConversationType,
  userMessage: UserMessageType,
  agentMessage: AgentMessageType
): AsyncGenerator<
  | AgentErrorEvent
  | AgentActionSpecificEvent
  | AgentActionSuccessEvent
  | GenerationTokensEvent
  | AgentGenerationSuccessEvent
  | AgentGenerationCancelledEvent
  | AgentMessageSuccessEvent
  | AgentChainOfThoughtEvent,
  void
> {
  const fullConfiguration = await getAgentConfiguration(
    auth,
    configuration.sId
  );
  if (!fullConfiguration) {
    throw new Error(
      `Unreachable: could not find detailed configuration for agent ${configuration.sId}`
    );
  }

  const owner = auth.workspace();
  if (!owner) {
    throw new Error("Unreachable: could not find owner workspace for agent");
  }

  const multiActions = owner.flags.includes("multi_actions");

  const stream = !multiActions
    ? runLegacyAgent(
        auth,
        fullConfiguration,
        conversation,
        userMessage,
        agentMessage
      )
    : runMultiActionsAgentLoop(
        auth,
        fullConfiguration,
        conversation,
        userMessage,
        agentMessage
      );

  for await (const event of stream) {
    yield event;
  }
}

export async function* runMultiActionsAgentLoop(
  auth: Authenticator,
  configuration: AgentConfigurationType,
  conversation: ConversationType,
  userMessage: UserMessageType,
  agentMessage: AgentMessageType
): AsyncGenerator<
  | AgentErrorEvent
  | AgentActionSpecificEvent
  | AgentActionSuccessEvent
  | GenerationTokensEvent
  | AgentGenerationSuccessEvent
  | AgentGenerationCancelledEvent
  | AgentMessageSuccessEvent
  | AgentChainOfThoughtEvent
> {
  const now = Date.now();

  for (let i = 0; i < configuration.maxToolsUsePerRun + 1; i++) {
    const localLogger = logger.child({
      workspaceId: conversation.owner.sId,
      conversationId: conversation.sId,
      multiActionLoopIteration: i,
    });

    localLogger.info("Starting multi-action loop iteration");

    const actions =
      // If we already executed the maximum number of actions, we don't run any more.
      // This will force the agent to run the generation.
      i === configuration.maxToolsUsePerRun
        ? []
        : // Otherwise, we let the agent decide which action to run (if any).
          configuration.actions;

    const loopIterationStream = runMultiActionsAgent(auth, {
      agentConfiguration: configuration,
      conversation,
      userMessage,
      agentMessage,
      availableActions: actions,
    });

    for await (const event of loopIterationStream) {
      switch (event.type) {
        case "agent_error":
          localLogger.error(
            {
              elapsedTime: Date.now() - now,
              error: event.error,
            },
            "Error running multi-actions agent."
          );
          yield event;
          return;
        case "agent_actions":
          localLogger.info(
            {
              elapsed: Date.now() - now,
            },
            "[ASSISTANT_TRACE] Action inputs generation"
          );

          const actionIndexByType: Record<string, number> = {};
          const eventStreamGenerators = event.actions.map(
            ({ action, inputs, functionCallId, specification }) => {
              const index = actionIndexByType[action.type] ?? 0;
              actionIndexByType[action.type] = index + 1;
              return runAction(auth, {
                configuration: configuration,
                actionConfiguration: action,
                conversation,
                userMessage,
                agentMessage,
                inputs,
                specification,
                functionCallId,
                step: i,
                indexForType: index,
              });
            }
          );

          const eventStreamPromises = eventStreamGenerators.map((gen) =>
            gen.next()
          );
          while (eventStreamPromises.length > 0) {
            const winner = await Promise.race(
              eventStreamPromises.map(async (p, i) => {
                return { v: await p, offset: i };
              })
            );
            if (winner.v.done) {
              eventStreamGenerators.splice(winner.offset, 1);
              // eslint-disable-next-line @typescript-eslint/no-floating-promises
              eventStreamPromises.splice(winner.offset, 1);
            } else {
              eventStreamPromises[winner.offset] =
                eventStreamGenerators[winner.offset].next();
              yield winner.v.value;
            }
          }
          break;

        // Generation events
        case "generation_tokens":
          yield event;
          break;
        case "generation_cancel":
          yield {
            type: "agent_generation_cancelled",
            created: event.created,
            configurationId: configuration.sId,
            messageId: agentMessage.sId,
          } satisfies AgentGenerationCancelledEvent;
          return;
        case "generation_success":
          if (event.chainOfThought.length) {
            yield {
              type: "agent_chain_of_thought",
              created: event.created,
              configurationId: configuration.sId,
              messageId: agentMessage.sId,
              message: agentMessage,
              chainOfThought: event.chainOfThought,
            };
          }
          yield {
            type: "agent_generation_success",
            created: event.created,
            configurationId: configuration.sId,
            messageId: agentMessage.sId,
            text: event.text,
          } satisfies AgentGenerationSuccessEvent;

          agentMessage.content = event.text;
          agentMessage.status = "succeeded";
          yield {
            type: "agent_message_success",
            created: Date.now(),
            configurationId: configuration.sId,
            messageId: agentMessage.sId,
            message: agentMessage,
          };
          return;

        case "agent_chain_of_thought":
          yield event;
          break;

        default:
          assertNever(event);
      }
    }
  }
}

// This method is used by the multi-actions execution loop to pick the next action
// to execute and generate its inputs.
export async function* runMultiActionsAgent(
  auth: Authenticator,
  {
    agentConfiguration,
    conversation,
    userMessage,
    agentMessage,
    availableActions,
  }: {
    agentConfiguration: AgentConfigurationType;
    conversation: ConversationType;
    userMessage: UserMessageType;
    agentMessage: AgentMessageType;
    availableActions: AgentActionConfigurationType[];
  }
): AsyncGenerator<
  | AgentErrorEvent
  | GenerationSuccessEvent
  | GenerationCancelEvent
  | GenerationTokensEvent
  | AgentActionsEvent
  | AgentChainOfThoughtEvent
> {
  const prompt = await constructPromptMultiActions(
    auth,
    userMessage,
    agentConfiguration,
    "You are a conversational assistant with access to function calling."
  );

  const model = SUPPORTED_MODEL_CONFIGS.find(
    (m) =>
      m.modelId === agentConfiguration.model.modelId &&
      m.providerId === agentConfiguration.model.providerId &&
      m.supportsMultiActions
  );

  if (!model) {
    yield {
      type: "agent_error",
      created: Date.now(),
      configurationId: agentConfiguration.sId,
      messageId: agentMessage.sId,
      error: {
        code: "model_does_not_support_multi_actions",
        message:
          `The model you selected (${agentConfiguration.model.modelId}) ` +
          `does not support multi-actions.`,
      },
    };
    return;
  }

  const MIN_GENERATION_TOKENS = 2048;

  // Turn the conversation into a digest that can be presented to the model.
  const modelConversationRes = await renderConversationForModelMultiActions({
    conversation,
    model,
    prompt,
    allowedTokenCount: model.contextSize - MIN_GENERATION_TOKENS,
  });

  if (modelConversationRes.isErr()) {
    logger.error(
      {
        workspaceId: conversation.owner.sId,
        conversationId: conversation.sId,
        error: modelConversationRes.error,
      },
      "Error rendering conversation for model."
    );
    yield {
      type: "agent_error",
      created: Date.now(),
      configurationId: agentConfiguration.sId,
      messageId: agentMessage.sId,
      error: {
        code: "conversation_render_error",
        message: `Error rendering conversation for model: ${modelConversationRes.error.message}`,
      },
    } satisfies AgentErrorEvent;

    return;
  }

  const specifications: AgentActionSpecification[] = [];
  for (const a of availableActions) {
    if (a.name && a.description) {
      // Normal case, it's a multi-actions agent.

      const runner = getRunnerforActionConfiguration(a);
      const specRes = await runner.buildSpecification(auth, {
        name: a.name,
        description: a.description,
      });

      if (specRes.isErr()) {
        logger.error(
          {
            workspaceId: conversation.owner.sId,
            conversationId: conversation.sId,
            error: specRes.error,
          },
          "Failed to build the specification for action."
        );
        yield {
          type: "agent_error",
          created: Date.now(),
          configurationId: agentConfiguration.sId,
          messageId: agentMessage.sId,
          error: {
            code: "build_spec_error",
            message: `Failed to build the specification for action ${a.sId},`,
          },
        } satisfies AgentErrorEvent;

        return;
      }
      specifications.push(specRes.value);
    } else {
      // Special case for legacy single-action agents that have never been edited in
      // multi-actions mode.
      // We tolerate missing name/description to preserve support for legacy single-action agents.
      // In those cases, we use the name/description from the legacy spec.

      if (!a.name && availableActions.length > 1) {
        // We can't allow not having a name if there are multiple actions.
        yield {
          type: "agent_error",
          created: Date.now(),
          configurationId: agentConfiguration.sId,
          messageId: agentMessage.sId,
          error: {
            code: "missing_name",
            message: `Action ${a.sId} is missing a name`,
          },
        } satisfies AgentErrorEvent;

        return;
      }

      const runner = getRunnerforActionConfiguration(a);
      const legacySpecRes =
        await runner.deprecatedBuildSpecificationForSingleActionAgent(auth);
      if (legacySpecRes.isErr()) {
        logger.error(
          {
            workspaceId: conversation.owner.sId,
            conversationId: conversation.sId,
            error: legacySpecRes.error,
          },
          "Failed to build the legacy specification for action."
        );
        yield {
          type: "agent_error",
          created: Date.now(),
          configurationId: agentConfiguration.sId,
          messageId: agentMessage.sId,
          error: {
            code: "build_legacy_spec_error",
            message: `Failed to build the legacy specification for action ${a.sId},`,
          },
        } satisfies AgentErrorEvent;

        return;
      }

      const specRes = await runner.buildSpecification(auth, {
        name: a.name ?? "",
        description: a.description ?? "",
      });

      if (specRes.isErr()) {
        logger.error(
          {
            workspaceId: conversation.owner.sId,
            conversationId: conversation.sId,
            error: specRes.error,
          },
          "Failed to build the specification for action."
        );
        yield {
          type: "agent_error",
          created: Date.now(),
          configurationId: agentConfiguration.sId,
          messageId: agentMessage.sId,
          error: {
            code: "build_spec_error",
            message: `Failed to build the specification for action ${a.sId},`,
          },
        } satisfies AgentErrorEvent;

        return;
      }

      const spec = specRes.value;
      if (!a.name) {
        spec.name = legacySpecRes.value.name;
      }
      if (!a.description) {
        spec.description = legacySpecRes.value.description;
      }
      specifications.push(spec);
    }
  }

  const config = cloneBaseConfig(
    DustProdActionRegistry["assistant-v2-multi-actions-agent"].config
  );
  config.MODEL.function_call = specifications.length === 0 ? null : "auto";
  config.MODEL.provider_id = model.providerId;
  config.MODEL.model_id = model.modelId;
  config.MODEL.temperature = agentConfiguration.model.temperature;

  const res = await runActionStreamed(
    auth,
    "assistant-v2-multi-actions-agent",
    config,
    [
      {
        conversation: modelConversationRes.value.modelConversation,
        specifications,
        prompt,
      },
    ],
    {
      conversationId: conversation.sId,
      workspaceId: conversation.owner.sId,
      userMessageId: userMessage.sId,
    }
  );

  if (res.isErr()) {
    logger.error(
      {
        workspaceId: conversation.owner.sId,
        conversationId: conversation.sId,
        error: res.error,
      },
      "Error running multi-actions agent."
    );
    yield {
      type: "agent_error",
      created: Date.now(),
      configurationId: agentConfiguration.sId,
      messageId: agentMessage.sId,
      error: {
        code: "multi_actions_error",
        message: `Error running multi-actions agent action: [${res.error.type}] ${res.error.message}`,
      },
    } satisfies AgentErrorEvent;

    return;
  }

  const { eventStream } = res.value;

  const output: {
    actions: Array<{
      functionCallId: string | null;
      name: string | null;
      arguments: Record<string, string | boolean | number> | null;
    }>;
    generation: string | null;
  } = {
    actions: [],
    generation: null,
  };

  let shouldYieldCancel = false;
  let lastCheckCancellation = Date.now();
  const redis = await redisClient();
  let isGeneration = true;
  const tokenEmitter = new TokenEmitter(
    agentConfiguration,
    agentMessage,
    model.delimitersConfiguration
  );

  try {
    const _checkCancellation = async () => {
      try {
        const cancelled = await redis.get(
          `assistant:generation:cancelled:${agentMessage.sId}`
        );
        if (cancelled === "1") {
          shouldYieldCancel = true;
          await redis.set(
            `assistant:generation:cancelled:${agentMessage.sId}`,
            0,
            {
              EX: 3600, // 1 hour
            }
          );
        }
      } catch (error) {
        logger.error({ error }, "Error checking cancellation");
        return false;
      }
    };

    for await (const event of eventStream) {
      if (event.type === "function_call") {
        isGeneration = false;
      }

      if (event.type === "error") {
        yield* tokenEmitter.flushTokens();
        yield {
          type: "agent_error",
          created: Date.now(),
          configurationId: agentConfiguration.sId,
          messageId: agentMessage.sId,
          error: {
            code: "multi_actions_error",
            message: `Error running multi-actions agent action: ${JSON.stringify(
              event,
              null,
              2
            )}`,
          },
        } satisfies AgentErrorEvent;
        return;
      }

      const currentTimestamp = Date.now();
      if (
        currentTimestamp - lastCheckCancellation >=
        CANCELLATION_CHECK_INTERVAL
      ) {
        void _checkCancellation(); // Trigger the async function without awaiting
        lastCheckCancellation = currentTimestamp;
      }

      if (shouldYieldCancel) {
        yield* tokenEmitter.flushTokens();
        yield {
          type: "generation_cancel",
          created: Date.now(),
          configurationId: agentConfiguration.sId,
          messageId: agentMessage.sId,
        } satisfies GenerationCancelEvent;
        return;
      }

      if (event.type === "tokens" && isGeneration) {
        yield* tokenEmitter.emitTokens(event);
      }

      if (event.type === "block_execution") {
        const e = event.content.execution[0][0];
        if (e.error) {
          yield* tokenEmitter.flushTokens();
          yield {
            type: "agent_error",
            created: Date.now(),
            configurationId: agentConfiguration.sId,
            messageId: agentMessage.sId,
            error: {
              code: "multi_actions_error",
              message: `Error running multi-actions agent action: ${e.error}`,
            },
          } satisfies AgentErrorEvent;
          return;
        }

        if (event.content.block_name === "MODEL" && e.value && isGeneration) {
          yield* tokenEmitter.flushTokens();

          yield {
            type: "generation_success",
            created: Date.now(),
            configurationId: agentConfiguration.sId,
            messageId: agentMessage.sId,
            text: tokenEmitter.getContent(),
            chainOfThought: tokenEmitter.getChainOfThought(),
          } satisfies GenerationSuccessEvent;

          return;
        }

        if (event.content.block_name === "OUTPUT" && e.value) {
          const v = e.value as any;
          if ("actions" in v) {
            output.actions = v.actions;
          }
          if ("generation" in v) {
            output.generation = v.generation;
          }

          yield* tokenEmitter.flushTokens();

          break;
        }
      }
    }
  } finally {
    await redis.quit();
  }

  if (!output.actions.length) {
    yield {
      type: "agent_error",
      created: Date.now(),
      configurationId: agentConfiguration.sId,
      messageId: agentMessage.sId,
      error: {
        code: "no_action_or_generation_found",
        message: "No action or generation found",
      },
    } satisfies AgentErrorEvent;
    return;
  }

  const actions: AgentActionsEvent["actions"] = [];
  const agentActions = agentConfiguration.actions;

  if (agentActions.length === 1 && !agentActions[0].name) {
    // Special case for legacy single-action agents that have never been edited in
    // multi-actions mode.
    // We must backfill the name from the legacy spec in order to match the action.
    const runner = getRunnerforActionConfiguration(agentActions[0]);
    const legacySpecRes =
      await runner.deprecatedBuildSpecificationForSingleActionAgent(auth);
    if (legacySpecRes.isErr()) {
      logger.error(
        {
          workspaceId: conversation.owner.sId,
          conversationId: conversation.sId,
          error: legacySpecRes.error,
        },
        "Failed to build the legacy specification for action."
      );
      yield {
        type: "agent_error",
        created: Date.now(),
        configurationId: agentConfiguration.sId,
        messageId: agentMessage.sId,
        error: {
          code: "build_legacy_spec_error",
          message: `Failed to build the legacy specification for action ${agentActions[0].sId},`,
        },
      } satisfies AgentErrorEvent;

      return;
    }
    agentActions[0].name = legacySpecRes.value.name;
  }

  for (const a of output.actions) {
    const action = agentActions.find((ac) => ac.name === a.name);

    if (!action) {
      yield {
        type: "agent_error",
        created: Date.now(),
        configurationId: agentConfiguration.sId,
        messageId: agentMessage.sId,
        error: {
          code: "action_not_found",
          message: `Action ${a.name} not found`,
        },
      } satisfies AgentErrorEvent;
      return;
    }

    const spec = specifications.find((s) => s.name === a.name) ?? null;

    actions.push({
      action,
      inputs: a.arguments ?? {},
      specification: spec,
      functionCallId: a.functionCallId ?? null,
    });
  }

  yield* tokenEmitter.flushTokens();

  const chainOfThought = tokenEmitter.getChainOfThought();
  const content = tokenEmitter.getContent();

  if (chainOfThought.length || content.length) {
    yield {
      type: "agent_chain_of_thought",
      created: Date.now(),
      configurationId: agentConfiguration.sId,
      messageId: agentMessage.sId,
      message: agentMessage,

      // All content here was generated before a tool use and is not proper generation content
      // and can therefore be safely assumed to be reflection from the model before using a tool.
      // In practice, we should never have both chainOfThought and content.
      // It is not completely impossible that eg Anthropic decides to emit part of the
      // CoT between `<thinking>` XML tags and the rest outside of any tag.
      chainOfThought: removeNulls([chainOfThought, content]).join("\n"),
    };
  }

  yield {
    type: "agent_actions",
    created: Date.now(),
    actions,
  };

  return;
}

async function* runAction(
  auth: Authenticator,
  {
    configuration,
    actionConfiguration,
    conversation,
    userMessage,
    agentMessage,
    inputs,
    specification,
    functionCallId,
    step,
    indexForType,
  }: {
    configuration: AgentConfigurationType;
    actionConfiguration: AgentActionConfigurationType;
    conversation: ConversationType;
    userMessage: UserMessageType;
    agentMessage: AgentMessageType;
    inputs: Record<string, string | boolean | number>;
    specification: AgentActionSpecification | null;
    functionCallId: string | null;
    step: number;
    indexForType: number;
  }
): AsyncGenerator<
  AgentActionSpecificEvent | AgentErrorEvent | AgentActionSuccessEvent,
  void
> {
  const now = Date.now();

  if (isRetrievalConfiguration(actionConfiguration)) {
    const runner = getRunnerforActionConfiguration(actionConfiguration);

    const eventStream = runner.run(
      auth,
      {
        agentConfiguration: configuration,
        conversation,
        agentMessage,
        rawInputs: inputs,
        functionCallId,
        step,
      },
      {
        // We allocate 32 refs per retrieval action.
        refsOffset: indexForType * 32,
      }
    );

    for await (const event of eventStream) {
      switch (event.type) {
        case "retrieval_params":
          yield event;
          break;
        case "retrieval_error":
          yield {
            type: "agent_error",
            created: event.created,
            configurationId: configuration.sId,
            messageId: agentMessage.sId,
            error: {
              code: event.error.code,
              message: event.error.message,
            },
          };
          return;
        case "retrieval_success":
          yield {
            type: "agent_action_success",
            created: event.created,
            configurationId: configuration.sId,
            messageId: agentMessage.sId,
            action: event.action,
          };

          // We stitch the action into the agent message. The conversation is expected to include
          // the agentMessage object, updating this object will update the conversation as well.
          agentMessage.actions.push(event.action);
          break;

        default:
          assertNever(event);
      }
    }
  } else if (isDustAppRunConfiguration(actionConfiguration)) {
    if (!specification) {
      logger.error(
        {
          workspaceId: conversation.owner.sId,
          conversationId: conversation.sId,
          elapsedTime: Date.now() - now,
        },
        "No specification found for Dust app run action."
      );
      yield {
        type: "agent_error",
        created: now,
        configurationId: configuration.sId,
        messageId: agentMessage.sId,
        error: {
          code: "parameters_generation_error",
          message: "No specification found for Dust app run action.",
        },
      };
      return;
    }
    const runner = getRunnerforActionConfiguration(actionConfiguration);

    const eventStream = runner.run(
      auth,
      {
        agentConfiguration: configuration,
        conversation,
        agentMessage,
        rawInputs: inputs,
        functionCallId,
        step,
      },
      {
        spec: specification,
      }
    );

    for await (const event of eventStream) {
      switch (event.type) {
        case "dust_app_run_params":
          yield event;
          break;
        case "dust_app_run_error":
          yield {
            type: "agent_error",
            created: event.created,
            configurationId: configuration.sId,
            messageId: agentMessage.sId,
            error: {
              code: event.error.code,
              message: event.error.message,
            },
          };
          return;
        case "dust_app_run_block":
          yield event;
          break;
        case "dust_app_run_success":
          yield {
            type: "agent_action_success",
            created: event.created,
            configurationId: configuration.sId,
            messageId: agentMessage.sId,
            action: event.action,
          };

          // We stitch the action into the agent message. The conversation is expected to include
          // the agentMessage object, updating this object will update the conversation as well.
          agentMessage.actions.push(event.action);
          break;

        default:
          assertNever(event);
      }
    }
  } else if (isTablesQueryConfiguration(actionConfiguration)) {
    const runner = getRunnerforActionConfiguration(actionConfiguration);

    const eventStream = runner.run(auth, {
      agentConfiguration: configuration,
      conversation,
      agentMessage,
      rawInputs: inputs,
      functionCallId,
      step,
    });

    for await (const event of eventStream) {
      switch (event.type) {
        case "tables_query_params":
        case "tables_query_output":
          yield event;
          break;
        case "tables_query_error":
          yield {
            type: "agent_error",
            created: event.created,
            configurationId: configuration.sId,
            messageId: agentMessage.sId,
            error: {
              code: event.error.code,
              message: event.error.message,
            },
          };
          return;
        case "tables_query_success":
          yield {
            type: "agent_action_success",
            created: event.created,
            configurationId: configuration.sId,
            messageId: agentMessage.sId,
            action: event.action,
          };

          // We stitch the action into the agent message. The conversation is expected to include
          // the agentMessage object, updating this object will update the conversation as well.
          agentMessage.actions.push(event.action);
          break;
        default:
          assertNever(event);
      }
    }
  } else if (isProcessConfiguration(actionConfiguration)) {
    const runner = getRunnerforActionConfiguration(actionConfiguration);

    const eventStream = runner.run(auth, {
      agentConfiguration: configuration,
      conversation,
      userMessage,
      agentMessage,
      rawInputs: inputs,
      functionCallId,
      step,
    });

    for await (const event of eventStream) {
      switch (event.type) {
        case "process_params":
          yield event;
          break;
        case "process_error":
          yield {
            type: "agent_error",
            created: event.created,
            configurationId: configuration.sId,
            messageId: agentMessage.sId,
            error: {
              code: event.error.code,
              message: event.error.message,
            },
          };
          return;
        case "process_success":
          yield {
            type: "agent_action_success",
            created: event.created,
            configurationId: configuration.sId,
            messageId: agentMessage.sId,
            action: event.action,
          };

          // We stitch the action into the agent message. The conversation is expected to include
          // the agentMessage object, updating this object will update the conversation as well.
          agentMessage.actions.push(event.action);
          break;

        default:
          assertNever(event);
      }
    }
  } else if (isWebsearchConfiguration(actionConfiguration)) {
    // TODO(pr) refactor the isXXX cases to avoid the duplication for process and websearch
    const runner = getRunnerforActionConfiguration(actionConfiguration);

    const eventStream = runner.run(auth, {
      agentConfiguration: configuration,
      conversation,
      agentMessage,
      rawInputs: inputs,
      functionCallId: null,
      step,
    });

    for await (const event of eventStream) {
      switch (event.type) {
        case "websearch_params":
          yield event;
          break;
        case "websearch_error":
          yield {
            type: "agent_error",
            created: event.created,
            configurationId: configuration.sId,
            messageId: agentMessage.sId,
            error: {
              code: event.error.code,
              message: event.error.message,
            },
          };
          return;
        case "websearch_success":
          yield {
            type: "agent_action_success",
            created: event.created,
            configurationId: configuration.sId,
            messageId: agentMessage.sId,
            action: event.action,
          };

          // We stitch the action into the agent message. The conversation is expected to include
          // the agentMessage object, updating this object will update the conversation as well.
          agentMessage.actions.push(event.action);
          break;

        default:
          assertNever(event);
      }
    }
  } else {
    assertNever(actionConfiguration);
  }
}

class TokenEmitter {
  private buffer: string = "";
  private content: string = "";
  private chainOfThought: string = "";
  private chainOfToughtDelimitersOpened: number = 0;
  private pattern?: RegExp;
  private incompleteDelimiterPattern?: RegExp;
  private specByDelimiter: Record<
    string,
    {
      type: "opening_delimiter" | "closing_delimiter";
      isChainOfThought: boolean;
    }
  >;

  constructor(
    private agentConfiguration: AgentConfigurationType,
    private agentMessage: AgentMessageType,
    delimitersConfiguration: ModelConfigurationType["delimitersConfiguration"]
  ) {
    this.buffer = "";
    this.content = "";
    this.chainOfThought = "";
    this.chainOfToughtDelimitersOpened = 0;

    // Ensure no duplicate delimiters.
    const allDelimitersArray =
      delimitersConfiguration?.delimiters.flatMap(
        ({ openingPattern, closingPattern }) => [
          escapeRegExp(openingPattern),
          escapeRegExp(closingPattern),
        ]
      ) ?? [];

    if (allDelimitersArray.length !== new Set(allDelimitersArray).size) {
      throw new Error("Duplicate delimiters in the configuration");
    }

    // Store mapping of delimiters to their spec.
    this.specByDelimiter =
      delimitersConfiguration?.delimiters.reduce(
        (acc, { openingPattern, closingPattern, isChainOfThought }) => {
          acc[openingPattern] = {
            type: "opening_delimiter" as const,
            isChainOfThought,
          };
          acc[closingPattern] = {
            type: "closing_delimiter" as const,
            isChainOfThought,
          };
          return acc;
        },
        {} as TokenEmitter["specByDelimiter"]
      ) ?? {};

    // Store the regex pattern that match any of the delimiters.
    this.pattern = allDelimitersArray.length
      ? new RegExp(allDelimitersArray.join("|"))
      : undefined;

    // Store the regex pattern that match incomplete delimiters.
    this.incompleteDelimiterPattern =
      delimitersConfiguration?.incompleteDelimiterRegex;
  }

  async *flushTokens({
    upTo,
  }: {
    upTo?: number;
  } = {}): AsyncGenerator<GenerationTokensEvent> {
    if (!this.buffer.length) {
      return;
    }

    const text =
      upTo === undefined ? this.buffer : this.buffer.substring(0, upTo);

    yield {
      type: "generation_tokens",
      created: Date.now(),
      configurationId: this.agentConfiguration.sId,
      messageId: this.agentMessage.sId,
      text,
      classification: this.chainOfToughtDelimitersOpened
        ? "chain_of_thought"
        : "tokens",
    };

    if (this.chainOfToughtDelimitersOpened) {
      this.chainOfThought += text;
    } else {
      this.content += text;
    }

    this.buffer = upTo === undefined ? "" : this.buffer.substring(upTo);
  }

  async *emitTokens(
    event: DustAppRunTokensEvent
  ): AsyncGenerator<GenerationTokensEvent> {
    // Add text of the new event to the buffer.
    this.buffer += event.content.tokens.text;
    if (!this.pattern) {
      yield* this.flushTokens();
      return;
    }

    if (this.incompleteDelimiterPattern?.test(this.buffer)) {
      // Wait for the next event to complete the delimiter.
      return;
    }

    let match: RegExpExecArray | null;
    while ((match = this.pattern.exec(this.buffer))) {
      const del = match[0];
      const index = match.index;

      // Emit text before the delimiter as 'text' or 'chain_of_thought'
      if (index > 0) {
        yield* this.flushTokens({ upTo: index });
      }

      const { type: classification, isChainOfThought } =
        this.specByDelimiter[del];

      if (!classification) {
        throw new Error(`Unknown delimiter: ${del}`);
      }

      if (isChainOfThought) {
        if (classification === "opening_delimiter") {
          this.chainOfToughtDelimitersOpened += 1;
        } else {
          this.chainOfToughtDelimitersOpened -= 1;
        }
      }

      // Emit the delimiter.
      yield {
        type: "generation_tokens",
        created: Date.now(),
        configurationId: this.agentConfiguration.sId,
        messageId: this.agentMessage.sId,
        text: del,
        classification,
      } satisfies GenerationTokensEvent;

      // Update the buffer
      this.buffer = this.buffer.substring(index + del.length);
    }

    // Emit the remaining text/chain_of_thought.
    yield* this.flushTokens();
  }

  getContent(): string {
    return this.content;
  }

  getChainOfThought(): string {
    return this.chainOfThought;
  }
}
