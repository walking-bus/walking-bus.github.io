(() => {
  "use strict";

  const config = window.WALKING_BUS_CONFIG || {};
  const viewMode = document.body.dataset.view === "week" ? "week" : "today";
  document.body.dataset.view = viewMode;
  const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  const list = document.querySelector("#departure-list");
  const panel = document.querySelector(".departures-panel");
  const messagePanel = document.querySelector("#message-panel");
  const messageTitle = document.querySelector("#message-title");
  const messageCopy = document.querySelector("#message-copy");
  const clock = document.querySelector("#clock");
  const dateLabel = document.querySelector("#date-label");
  const updatedLabel = document.querySelector("#updated-label");
  const template = document.querySelector("#departure-template");

  let lastGoodUpdate = null;
  let isLoading = false;

  const text = value => String(value ?? "").trim();
  const upper = value => text(value).toUpperCase();
  const lower = value => text(value).toLowerCase();

  function ukNow() {
    return new Date(new Date().toLocaleString("en-US", { timeZone: config.ukTimeZone || "Europe/London" }));
  }

  function updateClock() {
    const now = new Date();
    const zone = config.ukTimeZone || "Europe/London";
    clock.textContent = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(now);
    if (viewMode === "week") {
      const local = ukNow();
      const mondayOffset = (local.getDay() + 6) % 7;
      const monday = new Date(local);
      monday.setDate(local.getDate() - mondayOffset);
      const friday = new Date(monday);
      friday.setDate(monday.getDate() + 4);
      const formatter = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
      dateLabel.textContent = `${formatter.format(monday)} – ${formatter.format(friday)}`;
    } else {
      dateLabel.textContent = new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        weekday: "long",
        day: "numeric",
        month: "long"
      }).format(now);
    }
  }

  function extractRows(payload) {
    const unwrap = value => {
      if (typeof value === "string") {
        try { return unwrap(JSON.parse(value)); } catch { return []; }
      }
      if (Array.isArray(value)) return value.flatMap(unwrap);
      if (!value || typeof value !== "object") return [];
      if ("departures" in value) return unwrap(value.departures);
      if ("value" in value) return unwrap(value.value);
      if ("body" in value) return unwrap(value.body);
      return [value];
    };

    const unique = new Map();
    unwrap(payload).forEach(row => {
      const key = [
        row.FeedID ?? row.id,
        row.Departure ?? row.Departs ?? row.departure ?? row.time,
        row.Route ?? row.route,
        row.Terminus ?? row.terminus,
        row.RotaStatus ?? row.DisplayStatus ?? row.status
      ].map(text).join("|");
      if (!unique.has(key)) unique.set(key, row);
    });
    return [...unique.values()];
  }

  function isRunning(row) {
    const visible = lower(row.Visible ?? row.visible);
    const rotaStatus = upper(row.RotaStatus ?? row.Status ?? row.status);
    const displayStatus = lower(row.DisplayStatus ?? row.displayStatus ?? row.status);
    return visible === "yes" ||
      rotaStatus === "READY" ||
      rotaStatus === "SHORTENED" ||
      displayStatus === "running" ||
      displayStatus === "shortened route";
  }

  function isToday(row) {
    const suppliedDay = text(row.Day ?? row.day);
    if (!suppliedDay) return true;
    const today = new Intl.DateTimeFormat("en-GB", {
      timeZone: config.ukTimeZone || "Europe/London",
      weekday: "long"
    }).format(new Date());
    return suppliedDay.toLowerCase() === today.toLowerCase();
  }

  function dayForRow(row) {
    const supplied = text(row.Day ?? row.day);
    if (supplied) {
      const match = weekdays.find(day => day.toLowerCase().startsWith(supplied.toLowerCase().slice(0, 3)));
      if (match) return match;
    }
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: config.ukTimeZone || "Europe/London",
      weekday: "long"
    }).format(new Date());
  }

  function normaliseTime(value) {
    const raw = text(value).toLowerCase().replace(/\s/g, "");
    if (/^\d{1,2}:\d{2}$/.test(raw)) {
      const [hours, minutes] = raw.split(":").map(Number);
      return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
    }
    const match = raw.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
    if (!match) return text(value);
    let hours = Number(match[1]) % 12;
    if (match[3] === "pm") hours += 12;
    return `${String(hours).padStart(2, "0")}:${match[2] || "00"}`;
  }

  function routeDetails(value) {
    const raw = text(value);
    const number = raw.match(/\d+/)?.[0] || raw || "–";
    const stops = number === "1"
      ? ["Boot & Shoe", "St. Paul's", "Bowerham Hotel", "Park Hotel", "Premier (Dumbarton Rd)", "Gregson Centre"]
      : number === "2"
        ? ["Boot & Shoe", "St. Paul's", "SPAR (Greaves Rd)", "Infirmary", "Market Square"]
        : [];
    return { number, stops };
  }

  function normaliseStop(value) {
    return lower(value)
      .replace(/[’']/g, "")
      .replace(/\s*\(where this service terminates\)\s*/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function stopsFor(row, route) {
    if (!route.stops.length) return "Walking Bus route";
    const destination = normaliseStop(destinationFor(row));
    const terminusIndex = route.stops.findIndex(stop => {
      const normalised = normaliseStop(stop);
      return normalised === destination || normalised.includes(destination) || destination.includes(normalised);
    });
    const servedStops = terminusIndex >= 0 ? route.stops.slice(0, terminusIndex + 1) : route.stops;
    return servedStops.join(" → ");
  }

  function sortValue(row) {
    const explicit = Number(row.SortOrder ?? row.sortOrder);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const time = normaliseTime(row.Departure ?? row.Departs ?? row.departure ?? row.time);
    const [hours = 99, minutes = 99] = time.split(":").map(Number);
    return hours * 60 + minutes;
  }

  function statusDetails(row) {
    const status = upper(row.RotaStatus ?? row.Status ?? row.status);
    const display = lower(row.DisplayStatus ?? row.displayStatus ?? row.status);
    const shortened = status.includes("SHORTENED") || display.includes("shortened");
    return {
      shortened,
      label: shortened ? "Short route" : "Running"
    };
  }

  function destinationFor(row) {
    const terminus = text(row.Terminus ?? row.terminus ?? row.Destination ?? row.destination);
    if (terminus && lower(terminus) !== "not enough volunteers") return terminus;
    const display = text(row.DisplayText ?? row.displayText ?? row.message);
    const marker = " terminates at ";
    if (lower(display).includes(marker)) return display.slice(lower(display).indexOf(marker) + marker.length);
    return display || "See walking bus team";
  }

  function nextDepartureIndex(rows) {
    const now = ukNow();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const index = rows.findIndex(row => sortValue(row) >= currentMinutes);
    return index === -1 ? 0 : index;
  }

  function renderRows(rows) {
    list.className = "departure-list";
    list.replaceChildren();
    const sorted = rows.slice().sort((a, b) => sortValue(a) - sortValue(b));
    const nextIndex = nextDepartureIndex(sorted);
    document.body.dataset.density = sorted.length > 8 ? "dense" : "normal";
    list.style.setProperty("--row-count", String(Math.max(sorted.length, 1)));
    list.style.setProperty("--portrait-rows", String(Math.max(Math.ceil(sorted.length / 2), 1)));

    sorted.forEach((row, index) => {
      const fragment = template.content.cloneNode(true);
      const card = fragment.querySelector(".departure-row");
      const route = routeDetails(row.Route ?? row.route);
      const status = statusDetails(row);

      fragment.querySelector(".departure-time").textContent = normaliseTime(row.Departure ?? row.Departs ?? row.departure ?? row.time);
      fragment.querySelector(".route-number").textContent = route.number;
      fragment.querySelector(".route-name").textContent = `Route ${route.number}`;
      fragment.querySelector(".route-via").textContent = stopsFor(row, route);
      fragment.querySelector(".destination").textContent = destinationFor(row);
      fragment.querySelector(".status-badge").textContent = status.label;

      if (index === nextIndex) card.classList.add("is-next");
      if (status.shortened) card.classList.add("is-shortened");
      list.append(fragment);
    });

    messagePanel.hidden = sorted.length > 0;
    panel.setAttribute("aria-busy", "false");
  }

  function renderWeek(rows) {
    list.className = "departure-list week-list";
    list.replaceChildren();
    document.body.dataset.density = "normal";
    const today = new Intl.DateTimeFormat("en-GB", {
      timeZone: config.ukTimeZone || "Europe/London",
      weekday: "long"
    }).format(new Date());

    weekdays.forEach(day => {
      const dayRows = rows
        .filter(row => dayForRow(row) === day)
        .sort((a, b) => sortValue(a) - sortValue(b));
      const section = document.createElement("section");
      section.className = `week-day${day === today ? " is-today" : ""}`;
      section.setAttribute("aria-labelledby", `day-${day.toLowerCase()}`);
      section.style.setProperty("--service-count", String(Math.max(dayRows.length, 1)));

      const heading = document.createElement("h2");
      heading.className = "week-day-title";
      heading.id = `day-${day.toLowerCase()}`;
      heading.textContent = day;
      section.append(heading);

      const services = document.createElement("div");
      services.className = "week-day-services";

      if (!dayRows.length) {
        const empty = document.createElement("p");
        empty.className = "week-empty";
        empty.textContent = "No running buses listed";
        services.append(empty);
      } else {
        dayRows.forEach(row => {
          const status = statusDetails(row);
          const service = document.createElement("article");
          service.className = `week-service${status.shortened ? " is-shortened" : ""}`;

          const time = document.createElement("time");
          time.className = "week-service-time";
          time.textContent = normaliseTime(row.Departure ?? row.Departs ?? row.departure ?? row.time);

          const route = document.createElement("span");
          const routeInfo = routeDetails(row.Route ?? row.route);
          route.className = "week-service-route";
          route.textContent = `Route ${routeInfo.number}`;

          const destination = document.createElement("strong");
          destination.className = "week-service-destination";
          destination.textContent = destinationFor(row);

          const badge = document.createElement("span");
          badge.className = "week-service-status";
          badge.textContent = status.label;

          service.append(time, route, destination, badge);
          services.append(service);
        });
      }

      section.append(services);
      list.append(section);
    });

    messagePanel.hidden = true;
    panel.setAttribute("aria-busy", "false");
  }

  function showMessage(kind, title, copy) {
    list.replaceChildren();
    messagePanel.className = `message-panel is-${kind}`;
    messagePanel.hidden = false;
    messageTitle.textContent = title;
    messageCopy.textContent = copy;
    panel.setAttribute("aria-busy", kind === "loading" ? "true" : "false");
  }

  function setConnection(state) {
    document.body.dataset.connection = state;
  }

  async function refreshDepartures() {
    if (isLoading) return;
    isLoading = true;
    if (!lastGoodUpdate) showMessage("loading", "Loading departures", "Checking the live walking bus rota.");
    setConnection("loading");

    try {
      if (!config.feedUrl) throw new Error("No feed URL configured");
      const response = await fetch(config.feedUrl, {
        method: config.requestMethod || "GET",
        headers: { "Accept": "application/json" },
        cache: "no-store"
      });
      if (!response.ok) throw new Error(`Feed returned ${response.status}`);
      const payload = await response.json();
      const runningRows = extractRows(payload).filter(isRunning);
      const rows = viewMode === "week" ? runningRows : runningRows.filter(isToday);
      if (viewMode === "week") {
        renderWeek(rows);
      } else if (rows.length) {
        renderRows(rows);
      } else {
        showMessage("empty", "No walking buses listed", "There are no running Walking Bus departures for the rest of today.");
      }

      lastGoodUpdate = new Date();
      setConnection("live");
      updatedLabel.textContent = `Updated ${new Intl.DateTimeFormat("en-GB", {
        timeZone: config.ukTimeZone || "Europe/London",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).format(lastGoodUpdate)}`;
    } catch (error) {
      console.error("Walking Bus feed update failed", error);
      setConnection("error");
      if (!lastGoodUpdate) {
        showMessage("error", "Live information unavailable", "Please check back shortly or speak to the Walking Bus team.");
      }
      updatedLabel.textContent = lastGoodUpdate
        ? "Showing the most recent available rota"
        : "Unable to contact the live rota";
    } finally {
      isLoading = false;
    }
  }

  updateClock();
  refreshDepartures();
  window.setInterval(updateClock, 15_000);
  window.setInterval(refreshDepartures, Math.max(Number(config.refreshSeconds) || 60, 15) * 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshDepartures();
  });
})();
