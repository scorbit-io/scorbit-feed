import type { FeedUpdate } from "./types.js";

// Publications are checked at the boundary. Required here means the server's
// serializer guarantees it (required, or has a default); a field it may omit
// is optional, and null or "" is accepted where the serializer allows them.
// A problem names the field only.

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
  for (const field of ["id", "display_name", "initials"] as const) {
    if (!optional(player[field], isString)) return `player.${field}`;
  }
  if (!optional(player.avatar, (v) => v === null || isString(v))) return "player.avatar";
  return undefined;
}

function scoreProblem(score: unknown): string | undefined {
  if (!isObject(score)) return "";
  if (!isNumber(score.position)) return "position";
  if (!isNumber(score.score)) return "score";
  if (!optional(score.ball, (v) => v === null || isNumber(v))) return "ball";
  if (!optional(score.ball_in_progress, (v) => v === null || isBoolean(v))) {
    return "ball_in_progress";
  }
  if (!Array.isArray(score.modes) || !score.modes.every(isString)) return "modes";
  if (!isBoolean(score.is_nfc_verified)) return "is_nfc_verified";
  if (!optional(score.tournament_id, (v) => v === null || isString(v))) return "tournament_id";
  return playerProblem(score.player);
}

function machineProblem(machine: unknown): string | undefined {
  if (!isObject(machine)) return "";
  if (!isString(machine.machine_uuid) || machine.machine_uuid === "") return "machine_uuid";
  if (!optional(machine.game_name, isString)) return "game_name";
  if (!isBoolean(machine.game_in_progress)) return "game_in_progress";
  if (!isBoolean(machine.game_ended)) return "game_ended";
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
  if (!isObject(data.metadata)) return { problem: "metadata" };
  // Message metadata: created_at and updated_at are always sent (date-times);
  // game, machine, variant and venue (uuids) and sequence (an integer) only
  // when set.
  for (const field of ["created_at", "updated_at"] as const) {
    if (!isString(data.metadata[field])) return { problem: `metadata.${field}` };
  }
  for (const field of ["game", "machine", "variant", "venue"] as const) {
    if (!optional(data.metadata[field], isString)) return { problem: `metadata.${field}` };
  }
  if (!optional(data.metadata.sequence, Number.isInteger)) return { problem: "metadata.sequence" };
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
