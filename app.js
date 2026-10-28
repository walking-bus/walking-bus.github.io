(() => {
  "use strict";

  const config = window.WALKING_BUS_CONFIG || {};
  const page = document.body.dataset.page;
  const zone = config.ukTimeZone || "Europe/London";
  const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  const cacheKey = "walking-bus-timetable-v2";
  const routeNames = {
    "1": "Roses are Red",
    "2": "Duck’s Waddle"
  };
  const routes = {
    "1": ["Boot & Shoe", "St. Paul's", "Bowerham Hotel", "Park Hotel", "Premier (Dumbarton Rd)", "Gregson Centre"],
    "2": ["Boot & Shoe", "St. Paul's", "SPAR (Greaves Rd)", "Infirmary", "Market Square"]
  };

  const text = value => value == null ? "" : String(value).trim();
  const lower = value => text(value).toLowerCase();
  const upper = value => text(value).toUpperCase();

  function updateDisplayLayout() {
    if (page !== "screen") return;
    const requested = new URLSearchParams(window.location.search).get("layout");
    const forced = requested === "portrait" || requested === "landscape" ? requested : "";
    const viewportPortrait = window.innerHeight > window.innerWidth;
    const screenPortrait = window.screen && Number(window.screen.height) > Number(window.screen.width);
    document.body.dataset.layout = forced || (viewportPortrait || screenPortrait ? "portrait" : "landscape");
  }

  function localDateParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "long"
    }).formatToParts(date).reduce((result, part) => {
      result[part.type] = part.value;
      return result;
    }, {});
    return {
      iso: `${parts.year}-${parts.month}-${parts.day}`,
      weekday: parts.weekday,
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day)
    };
  }

  function dateFromParts(parts) {
    return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12));
  }

  function mondayFor(date = new Date()) {
    const parts = localDateParts(date);
    const local = dateFromParts(parts);
    const offset = (local.getUTCDay() + 6) % 7;
    local.setUTCDate(local.getUTCDate() - offset);
    return local;
  }

  function isoDate(date) {
    return date.toISOString().slice(0, 10);
  }

  function currentWeekDates() {
    const monday = mondayFor();
    return weekdays.map((day, index) => {
      const date = new Date(monday);
      date.setUTCDate(monday.getUTCDate() + index);
      return { day, date, iso: isoDate(date) };
    });
  }

  function formatWeekRange() {
    const week = currentWeekDates();
    const options = { day: "numeric", month: "short", timeZone: "UTC" };
    return `${new Intl.DateTimeFormat("en-GB", options).format(week[0].date)}–${new Intl.DateTimeFormat("en-GB", options).format(week[4].date)}`;
  }

  function unwrapRows(value) {
    if (typeof value === "string") {
      try { return unwrapRows(JSON.parse(value)); } catch { return []; }
    }
    if (Array.isArray(value)) return value.flatMap(unwrapRows);
    if (!value || typeof value !== "object") return [];
    if ("departures" in value) return unwrapRows(value.departures);
    if ("value" in value) return unwrapRows(value.value);
    if ("body" in value) return unwrapRows(value.body);
    return [value];
  }

  function uniqueRows(payload) {
    const rows = new Map();
    unwrapRows(payload).forEach(row => {
      const key = [
        row.FeedID ?? row.id,
        row.Date ?? row.ServiceDate ?? row.date,
        row.Day ?? row.day,
        row.Departure ?? row.Departs ?? row.departure ?? row.time,
        row.Route ?? row.route,
        row.Terminus ?? row.Destination ?? row.terminus
      ].map(text).join("|");
      if (!rows.has(key)) rows.set(key, row);
    });
    return [...rows.values()];
  }

  function isPublished(row) {
    const visible = lower(row.Visible ?? row.visible);
    const rotaStatus = upper(row.RotaStatus ?? row.Status ?? row.status);
    const displayStatus = lower(row.DisplayStatus ?? row.displayStatus ?? row.status);
    return visible === "yes" ||
      rotaStatus === "READY" ||
      rotaStatus === "SHORTENED" ||
      displayStatus === "running" ||
      displayStatus === "shortened route";
  }

  function parseServiceDate(value) {
    if (value == null || value === "") return "";
    if (typeof value === "number" && Number.isFinite(value)) {
      const excelEpoch = Date.UTC(1899, 11, 30);
      return isoDate(new Date(excelEpoch + Math.floor(value) * 86400000));
    }
    const raw = text(value);
    const serial = Number(raw);
    if (/^\d+(\.\d+)?$/.test(raw) && serial > 20000) {
      const excelEpoch = Date.UTC(1899, 11, 30);
      return isoDate(new Date(excelEpoch + Math.floor(serial) * 86400000));
    }
    const uk = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:\D.*)?$/);
    if (uk) return `${uk[3]}-${uk[2].padStart(2, "0")}-${uk[1].padStart(2, "0")}`;
    const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (iso) return iso[1];
    const ticks = raw.match(/\/Date\((\d+)/);
    if (ticks) return isoDate(new Date(Number(ticks[1])));
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? "" : isoDate(parsed);
  }

  function serviceDate(row) {
    return parseServiceDate(row.Date ?? row.ServiceDate ?? row.Service_Date ?? row.date);
  }

  function dayFor(row) {
    const date = serviceDate(row);
    if (date) {
      const entry = currentWeekDates().find(item => item.iso === date);
      return entry?.day || "";
    }
    const supplied = text(row.Day ?? row.day);
    return weekdays.find(day => day.toLowerCase().startsWith(supplied.toLowerCase().slice(0, 3))) || "";
  }

  function isInCurrentWeek(row) {
    const date = serviceDate(row);
    return date ? currentWeekDates().some(item => item.iso === date) : Boolean(dayFor(row));
  }

  function isToday(row) {
    const today = localDateParts();
    const date = serviceDate(row);
    return date ? date === today.iso : dayFor(row) === today.weekday;
  }

  function normaliseTime(value) {
    if (typeof value === "number" && value >= 0 && value < 1) {
      const minutes = Math.round(value * 24 * 60) % 1440;
      return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    }
    const rawValue = text(value);
    const isoTime = rawValue.match(/T(\d{2}):(\d{2})/);
    if (isoTime) return `${isoTime[1]}:${isoTime[2]}`;
    const raw = rawValue.toLowerCase().replace(/\s/g, "");
    if (/^\d{1,2}:\d{2}$/.test(raw)) {
      const [hours, minutes] = raw.split(":").map(Number);
      return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
    }
    const match = raw.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
    if (!match) return rawValue;
    let hours = Number(match[1]) % 12;
    if (match[3] === "pm") hours += 12;
    return `${String(hours).padStart(2, "0")}:${match[2] || "00"}`;
  }

  function routeNumber(row) {
    const raw = text(row.Route ?? row.route);
    return raw.match(/\d+/)?.[0] || raw || "–";
  }

  function routeName(row) {
    return routeNames[routeNumber(row)] || "Walking Bus";
  }

  function applyRouteStyle(element, row) {
    const number = routeNumber(row);
    if (number === "1" || number === "2") element.classList.add(`route-${number}`);
  }

  function normaliseStop(value) {
    return lower(value)
      .replace(/[’']/g, "")
      .replace(/\s*\(where this service terminates\)\s*/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function destinationFor(row) {
    const terminus = text(row.Terminus ?? row.terminus ?? row.Destination ?? row.destination);
    if (terminus && lower(terminus) !== "not enough volunteers") return terminus.replace(/\s*\(where this service terminates\)\s*/i, "");
    const display = text(row.DisplayText ?? row.displayText ?? row.message);
    const marker = " terminates at ";
    if (lower(display).includes(marker)) return display.slice(lower(display).indexOf(marker) + marker.length);
    return display || "Check with the Walking Bus team";
  }

  function stopsFor(row) {
    const stops = routes[routeNumber(row)] || [];
    if (!stops.length) return "Walking Bus route";
    const destination = normaliseStop(destinationFor(row));
    const index = stops.findIndex(stop => {
      const candidate = normaliseStop(stop);
      return candidate === destination || candidate.includes(destination) || destination.includes(candidate);
    });
    return (index >= 0 ? stops.slice(0, index + 1) : stops).join(" → ");
  }

  function sortValue(row) {
    const explicit = Number(row.SortOrder ?? row.sortOrder);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const [hours = 99, minutes = 99] = normaliseTime(row.Departure ?? row.Departs ?? row.departure ?? row.time).split(":").map(Number);
    return hours * 60 + minutes;
  }

  function emptyState(message) {
    const element = document.createElement("p");
    element.className = "empty-state";
    element.textContent = message;
    return element;
  }

  function renderToday(rows) {
    const list = document.querySelector("#today-list");
    if (!list) return;
    list.replaceChildren();
    const departures = rows.slice(0, 6);
    list.style.setProperty("--departure-count", String(Math.max(1, departures.length)));
    list.dataset.departureCount = String(departures.length);
    if (!rows.length) {
      list.append(emptyState("No Walking Bus departures are listed for today."));
      return;
    }
    const template = document.querySelector("#today-departure-template");
    departures.forEach(row => {
      const card = template.content.cloneNode(true);
      applyRouteStyle(card.querySelector(".today-departure"), row);
      card.querySelector(".departure-time").textContent = normaliseTime(row.Departure ?? row.Departs ?? row.departure ?? row.time);
      const routeHeading = card.querySelector(".route-name");
      const routeBadge = document.createElement("span");
      routeBadge.className = "route-roundel";
      routeBadge.textContent = `Route ${routeNumber(row)} · ${routeName(row)}`;
      routeHeading.replaceChildren(routeBadge);
      card.querySelector(".route-stops").textContent = stopsFor(row);
      card.querySelector(".destination strong").textContent = destinationFor(row);
      list.append(card);
    });
  }

  function renderWeek(rows, target) {
    if (!target) return;
    target.replaceChildren();
    const week = currentWeekDates();
    week.forEach(({ day, date }) => {
      const column = document.createElement("section");
      column.className = "day-column";
      const heading = document.createElement("header");
      heading.className = "day-heading";
      const dayName = document.createElement("h2");
      dayName.textContent = day;
      const dayDate = document.createElement("time");
      dayDate.dateTime = isoDate(date);
      dayDate.textContent = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(date);
      heading.append(dayName, dayDate);
      column.append(heading);

      const departures = rows.filter(row => dayFor(row) === day).sort((a, b) => sortValue(a) - sortValue(b)).slice(0, 6);
      if (!departures.length) {
        column.append(emptyState("No departures listed"));
      } else {
        departures.forEach(row => {
          const card = document.createElement("article");
          card.className = "week-departure";
          applyRouteStyle(card, row);
          const line = document.createElement("div");
          line.className = "week-departure-line";
          const time = document.createElement("time");
          time.textContent = normaliseTime(row.Departure ?? row.Departs ?? row.departure ?? row.time);
          const routeLabel = document.createElement("span");
          routeLabel.className = "week-route-label";
          const route = document.createElement("strong");
          route.className = "route-roundel";
          route.textContent = `Route ${routeNumber(row)}`;
          routeLabel.append(route);
          line.append(time, routeLabel);
          const destination = document.createElement("p");
          destination.className = "week-destination";
          destination.textContent = `To ${destinationFor(row)}`;
          const stops = document.createElement("p");
          stops.className = "week-stops";
          stops.textContent = stopsFor(row);
          card.append(line, destination, stops);
          column.append(card);
        });
        for (let index = departures.length; index < 6; index += 1) {
          const spacer = document.createElement("div");
          spacer.className = "week-slot-empty";
          spacer.setAttribute("aria-hidden", "true");
          column.append(spacer);
        }
      }
      target.append(column);
    });
  }

  function updateTimestamp(payload, source = "live") {
    const supplied = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload.generatedAt ?? payload.updatedAt
      : null;
    const date = supplied ? new Date(supplied) : new Date();
    const time = Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date);
    const label = source === "cache" ? `Last timetable update ${time}` : `Updated ${time}`;
    document.querySelector("#screen-updated")?.replaceChildren(document.createTextNode(label));
    document.querySelector("#embed-updated")?.replaceChildren(document.createTextNode(label));
  }

  function render(payload, source = "live") {
    const rows = uniqueRows(payload).filter(isPublished).filter(isInCurrentWeek);
    const sorted = rows.sort((a, b) => sortValue(a) - sortValue(b));
    renderToday(sorted.filter(isToday));
    renderWeek(sorted, document.querySelector("#screen-week-grid"));
    renderWeek(sorted, document.querySelector("#embed-week-grid"));
    document.querySelector(".embed-timetable")?.setAttribute("aria-busy", "false");
    updateTimestamp(payload, source);
  }

  function showUnavailable() {
    const today = document.querySelector("#today-list");
    if (today) today.replaceChildren(emptyState("The timetable is temporarily unavailable."));
    [document.querySelector("#screen-week-grid"), document.querySelector("#embed-week-grid")].forEach(grid => {
      if (grid) grid.replaceChildren(emptyState("The timetable is temporarily unavailable."));
    });
    document.querySelector("#screen-updated")?.replaceChildren(document.createTextNode("Please check again shortly"));
    document.querySelector("#embed-updated")?.replaceChildren(document.createTextNode("Please check again shortly"));
  }

  async function refresh() {
    try {
      if (!config.feedUrl) throw new Error("No feed URL configured");
      const response = await fetch(config.feedUrl, {
        method: config.requestMethod || "GET",
        headers: { Accept: "application/json" },
        cache: "default"
      });
      if (!response.ok) throw new Error(`Feed returned ${response.status}`);
      const payload = await response.json();
      try { window.localStorage?.setItem(cacheKey, JSON.stringify(payload)); } catch { /* Storage is optional. */ }
      render(payload);
    } catch (error) {
      console.error("Walking Bus timetable update failed", error);
      try {
        const stored = window.localStorage?.getItem(cacheKey);
        const cached = stored ? JSON.parse(stored) : null;
        if (cached) render(cached, "cache");
        else showUnavailable();
      } catch {
        showUnavailable();
      }
    }
  }

  function initialiseLabels() {
    const today = new Date();
    const todayLabel = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      weekday: "long",
      day: "numeric",
      month: "long"
    }).format(today);
    document.querySelector("#screen-date")?.replaceChildren(document.createTextNode(todayLabel));
    document.querySelector("#embed-week-range")?.replaceChildren(document.createTextNode(formatWeekRange()));
  }

  function startScreenRotation() {
    if (page !== "screen") return;
    const views = [...document.querySelectorAll("[data-screen-view]")];
    const dots = [...document.querySelectorAll(".page-progress span")];
    const heading = document.querySelector("#screen-heading");
    const date = document.querySelector("#screen-date");
    let active = 0;
    const showView = (index) => {
      active = index;
      views.forEach((view, index) => {
        const selected = index === active;
        view.classList.toggle("is-active", selected);
        view.setAttribute("aria-hidden", String(!selected));
        dots[index]?.classList.toggle("is-active", selected);
      });
      const weekView = views[active].dataset.screenView === "week";
      document.body.dataset.screenMode = weekView ? "week" : "today";
      heading.textContent = weekView ? "This week’s departures" : "Today’s departures";
      date.textContent = weekView ? formatWeekRange() : new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        weekday: "long",
        day: "numeric",
        month: "long"
      }).format(new Date());
    };

    const requestedView = new URLSearchParams(window.location.search).get("view")?.toLowerCase();
    const fixedView = requestedView === "week" ? "week" :
      (requestedView === "day" || requestedView === "today" ? "today" : "");

    if (fixedView) {
      const fixedIndex = views.findIndex((view) => view.dataset.screenView === fixedView);
      document.body.dataset.fixedView = fixedView;
      showView(fixedIndex >= 0 ? fixedIndex : 0);
      return;
    }

    delete document.body.dataset.fixedView;
    const switchView = () => showView((active + 1) % views.length);
    window.setInterval(switchView, Math.max(8, Number(config.screenSwitchSeconds) || 12) * 1000);
  }

  updateDisplayLayout();
  window.addEventListener("resize", updateDisplayLayout);
  window.addEventListener("orientationchange", updateDisplayLayout);
  initialiseLabels();
  refresh();
  startScreenRotation();
  window.setInterval(refresh, Math.max(30, Number(config.refreshSeconds) || 60) * 1000);
})();
