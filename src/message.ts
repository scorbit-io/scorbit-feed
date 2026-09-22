import type { FeedUpdate } from "./types.js";

// Publications are checked at the boundary, for every field the feed, the
// agent's /state and the starter overlay read. A problem names the field only.

type Body = Record<string, unknown>;

const isObject = (value: unknown): value is Body =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const optional = (value: unknown, check: (v: unknown) => boolean) =>
  value === undefined || check(value);
const isString = (value: unknown) => typeof value === "string";
const isNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const isBoolean = (value: unknown) => typeof value === "boolean";

function playerProblem(player: unknown): string | undefined {
  if (player === null) return undefined;
  if (!isObject(player) || !isString(player.username)) return "player";
  if (!optional(player.display_name, isString)) return "player.display_name";
  return undefined;
}

function scoreProblem(score: unknown): string | undefined {
  if (!isObject(score)) return "";
  if (!isNumber(score.position)) return "position";
  if (!isNumber(score.score)) return "score";
  if (!optional(score.ball, (v) => v === null || isNumber(v))) return "ball";
  if (!optional(score.modes, Array.isArray)) return "modes";
  return playerProblem(score.player);
}

function machineProblem(machine: unknown): string | undefined {
  if (!isObject(machine)) return "";
  if (!isString(machine.machine_uuid) || machine.machine_uuid === "") return "machine_uuid";
  if (!optional(machine.game_name, isString)) return "game_name";
  if (!isBoolean(machine.game_in_progress)) return "game_in_progress";
  if (!optional(machine.game_ended, isBoolean)) return "game_ended";
  if (!optional(machine.updated_at, (v) => v === null || isString(v))) return "updated_at";
  if (!Array.isArray(machine.scores)) return "scores";
  for (const [i, score] of machine.scores.entries()) {
    const problem = scoreProblem(score);
    if (problem !== undefined) return `scores[${i}]${problem ? `.${problem}` : ""}`;
  }
  return undefined;
}

/**
 * A publication's data: a valid `data_feed_update`, a malformed one (to drop
 * and report), or `undefined` for anything that is not a feed update at all.
 */
export function parsePublication(
  data: unknown,
): { update: FeedUpdate } | { problem: string } | undefined {
  if (!isObject(data) || data.type !== "data_feed_update") return undefined;
  if (!optional(data.metadata, isObject)) return { problem: "metadata" };
  const metadata = (data.metadata ?? {}) as Body;
  if (!optional(metadata.updated_at, isString)) return { problem: "metadata.updated_at" };
  const payload = data.payload;
  if (!isObject(payload) || !Array.isArray(payload.machines)) return { problem: "machines" };
  for (const [i, machine] of payload.machines.entries()) {
    const problem = machineProblem(machine);
    if (problem !== undefined) return { problem: `machines[${i}]${problem ? `.${problem}` : ""}` };
  }
  return { update: data as unknown as FeedUpdate };
}

/** Narrow a publication's data to a valid `data_feed_update`, or `undefined`. */
export function asFeedUpdate(data: unknown): FeedUpdate | undefined {
  const parsed = parsePublication(data);
  return parsed && "update" in parsed ? parsed.update : undefined;
}
