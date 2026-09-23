/**
 * Published message fixtures for a data feed channel: shapes from the Scorbit
 * API's data-feed message serializers (the `type` + `metadata` envelope, the
 * machine and score records). Frames follow Centrifugo's uni_sse format.
 *
 * Which fields are guaranteed follows the serializers' own rule: in DRF output
 * a field is always present only if it is required (the default) or declares a
 * `default=`. A `required=False` field without a default is omitted when there
 * is no value; `allow_null` means it may be null, `allow_blank` that it may be
 * "". `UPDATE` carries every field; `MINIMAL_UPDATE` carries only the
 * guaranteed ones, and the library must accept both.
 */
import type { FeedUpdate } from "../../src/types.js";
import { FEED_ID, MACHINE_A, MACHINE_B } from "./api.js";

export const UPDATE: FeedUpdate = {
  type: "data_feed_update",
  metadata: {
    created_at: "2026-09-22T18:00:00Z",
    updated_at: "2026-09-22T18:00:00Z",
  },
  payload: {
    machines: [
      {
        machine_uuid: MACHINE_A,
        game_name: "Monster Bash",
        game_in_progress: true,
        game_ended: false,
        scores: [
          {
            position: 1,
            player: {
              id: "33333333-3333-4333-8333-333333333333",
              username: "pinwizard",
              avatar: null,
              display_name: "Pin Wizard",
              initials: "PW",
            },
            score: 1234560,
            ball: 2,
            ball_in_progress: true,
            modes: ["Multiball"],
            is_nfc_verified: false,
            tournament_id: null,
          },
          {
            position: 2,
            player: null,
            score: 88000,
            ball: null,
            ball_in_progress: null,
            modes: [],
            is_nfc_verified: false,
          },
        ],
        updated_at: "2026-09-22T17:59:58Z",
      },
      {
        machine_uuid: MACHINE_B,
        game_name: "Medieval Madness",
        game_in_progress: false,
        game_ended: true,
        scores: [],
        updated_at: null,
      },
    ],
  },
};

/**
 * Only what the serializers guarantee: `type` and `metadata` (created_at,
 * updated_at) are always added; per machine machine_uuid, game_in_progress,
 * scores, and game_ended (default False); per score position, score, player
 * (may be null), modes (default []) and is_nfc_verified (default False); per
 * player username. game_name, updated_at, ball, ball_in_progress,
 * tournament_id and the other player fields may all be absent.
 */
export const MINIMAL_UPDATE: FeedUpdate = {
  type: "data_feed_update",
  metadata: { created_at: "2026-09-22T18:00:00Z", updated_at: "2026-09-22T18:00:00Z" },
  payload: {
    machines: [
      {
        machine_uuid: MACHINE_A,
        game_in_progress: true,
        game_ended: false,
        scores: [
          {
            position: 1,
            player: { username: "pinwizard" },
            score: 10,
            modes: [],
            is_nfc_verified: false,
          },
          { position: 2, player: null, score: 0, modes: [], is_nfc_verified: false },
        ],
      },
      // Blank and null where the serializers allow them.
      {
        machine_uuid: MACHINE_B,
        game_name: "",
        game_in_progress: false,
        game_ended: false,
        updated_at: null,
        scores: [
          {
            position: 1,
            player: { username: "u", avatar: null, display_name: "", initials: "" },
            score: 0,
            ball: null,
            ball_in_progress: null,
            modes: [],
            is_nfc_verified: false,
            tournament_id: null,
          },
        ],
      },
    ],
  },
};

/** A uni_sse `data:` payload carrying a publication on a channel, wrapped in `push`. */
export const pubFrame = (data: unknown, channel = `data_feed:${FEED_ID}`) =>
  `data: ${JSON.stringify({ push: { channel, pub: { data } } })}\n\n`;
export const CONNECT_FRAME = `data: ${JSON.stringify({ connect: { client: "c-1", version: "6", subs: {} } })}\n\n`;
export const DISCONNECT_FRAME = `data: ${JSON.stringify({ push: { disconnect: { code: 3005, reason: "token expired" } } })}\n\n`;
