// Scorbit feed overlay: renders the agent's /events stream. No credential ever
// reaches this page: the agent holds the feed and serves only its data.
(function () {
  "use strict";

  var DEFAULT_AGENT = "http://127.0.0.1:8787";

  // An http(s) URL without its trailing slashes, or null.
  function normaliseAgent(value) {
    var url;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return (url.origin + url.pathname).replace(/\/+$/, "");
  }

  // ?agent= wins. Otherwise use this page's own origin only if it IS the agent
  // (its /healthz says so); a page on any other web server, or opened from
  // disk, reads the agent at its default address.
  function resolveAgent() {
    var param = new URLSearchParams(window.location.search).get("agent");
    if (param !== null) {
      var chosen = normaliseAgent(param);
      if (chosen !== null) return Promise.resolve(chosen);
      console.warn("Scorbit overlay: ignoring ?agent=, which must be an http(s) URL");
    }
    var protocol = window.location.protocol;
    if (protocol !== "http:" && protocol !== "https:") return Promise.resolve(DEFAULT_AGENT);
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, 2000);
    return fetch("/healthz", { signal: controller.signal })
      .then(function (response) {
        return response.json();
      })
      .then(function (body) {
        return body && body.agent === "scorbit-feed" ? "" : DEFAULT_AGENT;
      })
      .catch(function () {
        return DEFAULT_AGENT;
      })
      .then(function (agent) {
        clearTimeout(timer);
        return agent;
      });
  }

  var statusEl = document.getElementById("status");
  var statusText = document.getElementById("status-text");
  // What the live region announces; the dot's colour and shape match these.
  var STATUS_LABELS = {
    idle: "Connecting to the live feed",
    connecting: "Connecting to the live feed",
    live: "Live",
    reconnecting: "Reconnecting to the live feed",
    ended: "Live feed ended",
  };
  var machinesEl = document.getElementById("machines");
  var emptyEl = document.getElementById("empty");

  function setStatus(status) {
    var known = Object.prototype.hasOwnProperty.call(STATUS_LABELS, status);
    var label = known ? STATUS_LABELS[status] : "Live feed status: " + String(status);
    statusEl.dataset.status = status;
    statusEl.title = label;
    // Only a real change is announced, so a repeated status is not read twice.
    if (statusText.textContent !== label) statusText.textContent = label;
  }

  function playerName(score) {
    var player = score.player;
    if (!player) return "Player " + score.position;
    return player.display_name || player.username;
  }

  function machineState(machine) {
    if (machine.game_in_progress) {
      var balls = machine.scores
        .map(function (s) {
          return s.ball;
        })
        .filter(function (b) {
          return b !== null && b !== undefined;
        });
      return balls.length ? "Ball " + Math.max.apply(null, balls) : "In progress";
    }
    return machine.game_ended ? "Final scores" : "Waiting for a game";
  }

  // One tile per machine, keyed by machine_uuid: a feed that follows its venues
  // gains and loses machines while it runs, so position means nothing.
  var tiles = new Map();

  function fillTile(card, machine) {
    var title = document.createElement("h2");
    title.textContent = machine.game_name || "Machine";
    var state = document.createElement("div");
    state.className = "state";
    state.textContent = machineState(machine);
    var list = document.createElement("ol");
    machine.scores.forEach(function (score) {
      var row = document.createElement("li");
      var name = document.createElement("span");
      name.textContent = playerName(score);
      var value = document.createElement("span");
      value.textContent = Number(score.score).toLocaleString();
      row.append(name, value);
      list.append(row);
    });
    card.replaceChildren(title, state, list);
  }

  // `updated_at` stays null until the agent has received a publication: until
  // then an empty list means "not heard yet", not "no machines".
  function render(state) {
    var machines = state.machines || [];
    var seen = new Set();
    machines.forEach(function (machine) {
      var uuid = machine.machine_uuid;
      seen.add(uuid);
      var card = tiles.get(uuid);
      if (!card) {
        card = document.createElement("section");
        card.className = "machine";
        card.dataset.machine = uuid;
        tiles.set(uuid, card);
      }
      fillTile(card, machine);
      // Appending an existing tile moves it, so the tiles follow the feed's order.
      machinesEl.append(card);
    });
    tiles.forEach(function (card, uuid) {
      if (seen.has(uuid)) return;
      card.remove();
      tiles.delete(uuid);
    });
    emptyEl.hidden = machines.length > 0 || state.updated_at == null;
  }

  // EventSource reconnects by itself if the agent restarts.
  resolveAgent().then(function (agent) {
    var source = new EventSource(agent + "/events");
    source.addEventListener("status", function (event) {
      setStatus(JSON.parse(event.data).status);
    });
    source.addEventListener("state", function (event) {
      render(JSON.parse(event.data));
    });
    source.onerror = function () {
      setStatus("reconnecting");
    };
  });
})();
