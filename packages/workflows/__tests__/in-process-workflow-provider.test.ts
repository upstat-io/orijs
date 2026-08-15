/**
 * Tests for InProcessWorkflowProvider
 *
 * This file runs the shared contract tests against the InProcess provider.
 * All WorkflowProvider implementations must pass the same contract tests
 * to ensure feature parity across providers.
 *
 * See __tests__/contract/ for the shared test suite.
 */

import type { Logger } from "@orijs/logging";
import { describe, expect, it } from "bun:test";

import { InProcessWorkflowProvider } from "../src/in-process-workflow-provider.ts";
import {
  workflowProviderContractTests,
  type ProviderConfig,
} from "./contract/index";

// ============================================================
// CONTRACT TESTS - Run shared test suite for InProcessWorkflowProvider
// ============================================================
workflowProviderContractTests({
  providerName: "InProcessWorkflowProvider",
  createProvider: async () => new InProcessWorkflowProvider(),
  createProviderWithConfig: async (config: ProviderConfig) => {
    const providerConfig: { logger?: Logger; defaultTimeout?: number } = {};

    if (config.logger) {
      providerConfig.logger = config.logger;
    }

    if (config.timeoutMs !== undefined) {
      providerConfig.defaultTimeout = config.timeoutMs;
    }

    // If we have any config, pass the config object
    if (Object.keys(providerConfig).length > 0) {
      return new InProcessWorkflowProvider(providerConfig);
    }

    return new InProcessWorkflowProvider();
  },
  cleanup: async () => {},
  timeout: 5000,
});

describe("definition consumer configuration", () => {
  it("should omit absent error handlers and retain configured handlers", () => {
    const provider = new InProcessWorkflowProvider();
    const handler = async (): Promise<void> => {};

    provider.registerDefinitionConsumer("without-error-handler", handler);

    const consumers = Reflect.get(provider, "definitionConsumers");
    expect(consumers).toBeInstanceOf(Map);
    if (!(consumers instanceof Map)) {
      throw new Error("definitionConsumers must be a Map");
    }
    const withoutErrorHandler = consumers.get("without-error-handler");
    expect(Object.hasOwn(withoutErrorHandler ?? {}, "onError")).toBe(false);

    const onError = async (): Promise<void> => {};
    provider.registerDefinitionConsumer(
      "with-error-handler",
      handler,
      undefined,
      undefined,
      onError,
    );

    const withErrorHandler = consumers.get("with-error-handler");
    expect(Object.hasOwn(withErrorHandler ?? {}, "onError")).toBe(true);
    expect(withErrorHandler?.onError).toBe(onError);
  });
});
