/**
 * Published message fixtures for a data feed channel: shapes from the Scorbit
 * API's data-feed message serializers (the `type` + `metadata` envelope, the
 * machine and score records). Frames follow Centrifugo's uni_sse format.
 */
import type { FeedUpdate } from "../../src/types.js";
import { MACHINE_A, MACHINE_B } from "./api.js";

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

/** A uni_sse `data:` payload carrying a publication, wrapped in `push` as the server sends it. */
export const pubFrame = (data: unknown) =>
  `data: ${JSON.stringify({ push: { channel: "data_feed:f_x", pub: { data } } })}\n\n`;
export const CONNECT_FRAME = `data: ${JSON.stringify({ connect: { client: "c-1", version: "6", subs: {} } })}\n\n`;
export const DISCONNECT_FRAME = `data: ${JSON.stringify({ push: { disconnect: { code: 3005, reason: "token expired" } } })}\n\n`;
