import { describe, expect, it } from "vitest";
import {
  COLLABORATION_PROTOCOL_VERSION,
  CollaborationMessageType,
  type CollaborationSaveReceipt,
  type SharedCompileState,
  type SharedCompileStates
} from "../src/shared/collaborationProtocol.js";
import type {
  CollaborationSaveReceipt as ClientCollaborationSaveReceipt,
  SharedCompileState as ClientSharedCompileState,
  SharedCompileStates as ClientSharedCompileStates
} from "../src/client/collaboration.js";
import type {
  CollaborationSaveReceipt as ServerCollaborationSaveReceipt,
  SharedCompileState as ServerSharedCompileState,
  SharedCompileStates as ServerSharedCompileStates
} from "../src/server/collaboration.js";

type Equal<Left, Right> = (
  <Value>() => Value extends Left ? 1 : 2
) extends (
  <Value>() => Value extends Right ? 1 : 2
) ? true : false;
type Assert<Value extends true> = Value;

// These assertions deliberately make a divergent client/server re-export a
// type-checking failure. The binary protocol has no runtime type metadata, so
// this is the earliest safe place to catch a one-sided wire-shape change.
type _ClientCompileStateMatchesShared = Assert<Equal<ClientSharedCompileState, SharedCompileState>>;
type _ServerCompileStateMatchesShared = Assert<Equal<ServerSharedCompileState, SharedCompileState>>;
type _ClientCompileStatesMatchesShared = Assert<Equal<ClientSharedCompileStates, SharedCompileStates>>;
type _ServerCompileStatesMatchesShared = Assert<Equal<ServerSharedCompileStates, SharedCompileStates>>;
type _ClientSaveReceiptMatchesShared = Assert<Equal<ClientCollaborationSaveReceipt, CollaborationSaveReceipt>>;
type _ServerSaveReceiptMatchesShared = Assert<Equal<ServerCollaborationSaveReceipt, CollaborationSaveReceipt>>;

describe("collaboration wire protocol", () => {
  it("keeps established message identifiers stable", () => {
    expect(CollaborationMessageType).toMatchObject({
      Sync: 0,
      Awareness: 1,
      QueryAwareness: 3,
      Flush: 4,
      Protocol: 5,
      Maintenance: 6,
      Permission: 7,
      CompileStates: 8,
      FormatLease: 9
    });
  });

  it("keeps the current protocol version until an intentional wire migration", () => {
    expect(COLLABORATION_PROTOCOL_VERSION).toBe(3);
  });
});
