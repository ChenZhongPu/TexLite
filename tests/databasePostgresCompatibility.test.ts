import { describe, expect, it } from "vitest";
import { bindPostgresParameters } from "../src/server/database/runtime.js";

describe("PostgreSQL runtime parameter binding", () => {
  it("converts positional parameters without interpolating values", () => {
    expect(bindPostgresParameters(
      "SELECT id FROM users WHERE username = ? AND id <> ?",
      ["Alice", "user-1"]
    )).toEqual({
      text: "SELECT id FROM users WHERE username = $1 AND id <> $2",
      params: ["Alice", "user-1"]
    });
  });

  it("converts named parameters used by the project catalog query", () => {
    expect(bindPostgresParameters(
      "SELECT id FROM projects WHERE owner_id = :userId LIMIT :limit OFFSET :offset",
      [{ userId: "user-1", limit: 20, offset: 0 }]
    )).toEqual({
      text: "SELECT id FROM projects WHERE owner_id = $1 LIMIT $2 OFFSET $3",
      params: ["user-1", 20, 0]
    });
  });

  it("does not treat a parameter object as SQL text", () => {
    expect(bindPostgresParameters("SELECT :value::text AS value", [{ value: "a:b" }])).toEqual({
      text: "SELECT $1::text AS value",
      params: ["a:b"]
    });
  });
});
