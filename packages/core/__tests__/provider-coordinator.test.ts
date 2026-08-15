import { describe, expect, it } from "bun:test";
import { Logger } from "@orijs/logging";
import { Container } from "../src/container";
import { ProviderCoordinator } from "../src/provider-coordinator";

describe("ProviderCoordinator", () => {
  it("omits absent eager configuration and retains an explicit value", () => {
    class ImplicitProvider {}
    class ExplicitProvider {}

    const coordinator = new ProviderCoordinator(
      new Container(),
      new Logger("test"),
    );

    coordinator.addProvider(ImplicitProvider, []);
    coordinator.addProvider(ExplicitProvider, [], false);

    const [implicit, explicit] = coordinator["providers"];
    expect(implicit).toBeDefined();
    expect(explicit).toBeDefined();
    expect(Object.hasOwn(implicit!, "eager")).toBeFalse();
    expect(Object.hasOwn(explicit!, "eager")).toBeTrue();
    expect(explicit!.eager).toBeFalse();
  });
});
