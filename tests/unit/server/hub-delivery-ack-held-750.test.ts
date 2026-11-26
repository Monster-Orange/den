/**
 * Issue 750 step 4: the delivery service's ack for an agent whose Hub
 * tools failed to load. What Hub's whoami lists sets it: with
 * deliveries.ack_held the loop acks `held`; without it, `queued` (an older
 * Hub). It reads only whoami, never hub.groups (the By group view's
 * switch), so that switch can't change it. A new connection forgets the old Hub's answer until the new one says.
 * The loop's own held and queued paths: hub-delivery-held-tools.test.ts.
 */
import { describe, expect, it } from "@jest/globals";
import {
  deliveryAckHeld,
  noteWhoami,
} from "../../../src/ui/server/hub-delivery-service.js";
import { ACK_HELD_FEATURE } from "../../../src/shared/hub/hub-delivery.js";

describe("issue 750 step 4: whoami decides held or queued", () => {
  it("the feature is the one Hub's G1/G2 contract names", () => {
    expect(ACK_HELD_FEATURE).toBe("deliveries.ack_held");
  });

  it("whoami listing deliveries.ack_held: the loop acks held", () => {
    noteWhoami({ features: ["inbox.feed", "deliveries.ack_held"] });
    expect(deliveryAckHeld()).toBe(true);
  });

  it("whoami without it (an older Hub): queued", () => {
    noteWhoami({ features: ["deliveries.ack_held"] });
    noteWhoami({ features: ["inbox.feed"] });
    expect(deliveryAckHeld()).toBe(false);
    noteWhoami({});
    expect(deliveryAckHeld()).toBe(false);
  });

  it("a whoami with no answer keeps nothing of the last Hub's (null: queued)", () => {
    noteWhoami({ features: ["deliveries.ack_held"] });
    noteWhoami(null);
    expect(deliveryAckHeld()).toBe(false);
  });
});
