// Scorbit feed overlay: renders the agent's /events stream. No credential ever
// reaches this page: the agent holds the feed and serves only its data.
(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search);
  var sameOrigin = window.location.protocol === "http:" || window.location.protocol === "https:";
  var agent = params.get("agent") || (sameOrigin ? "" : "http://127.0.0.1:8787");

  var statusEl = document.getElementById("status");
  var machinesEl = document.getElementById("machines");

  function setStatus(status) {
    statusEl.dataset.status = status;
    statusEl.title = status;
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

  function render(machines) {
    machinesEl.replaceChildren();
    machines.forEach(function (machine) {
      var card = document.createElement("section");
      card.className = "machine";
      card.dataset.machine = machine.machine_uuid;

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

      card.append(title, state, list);
      machinesEl.append(card);
    });
  }

  // EventSource reconnects by itself if the agent restarts.
  var source = new EventSource(agent + "/events");
  source.addEventListener("status", function (event) {
    setStatus(JSON.parse(event.data).status);
  });
  source.addEventListener("state", function (event) {
    render(JSON.parse(event.data).machines || []);
  });
  source.onerror = function () {
    setStatus("reconnecting");
  };
})();
