const CSV_FILE = "meeting_calendar.csv";
const VENUE_FILE = "venue_locations.csv";
const POSTCODE_FILE = "postcode_locations_clean.csv";
const STORAGE_KEY = "trotifyRaceFinderState";

let races = [];
let venueLocations = {};
let postcodeLocations = {};

document.addEventListener("DOMContentLoaded", async () => {
  loadSavedDetails();
  renderHorseSelector();

  document.getElementById("findBtn").addEventListener("click", findRaces);
  document.getElementById("clearBtn").addEventListener("click", clearSavedDetails);

  document.getElementById("addHorseBtn").addEventListener("click", addHorse);
  document.getElementById("saveHorseBtn").addEventListener("click", saveCurrentHorse);
  document.getElementById("horseSelector").addEventListener("change", loadSelectedHorseFromSelector);

  document.getElementById("nextTwoWeeks").addEventListener("change", () => {
    if (document.getElementById("nextTwoWeeks").checked) {
      setNextTwoWeeksDates();
      findRaces();
    }
  });

  document.getElementById("sortBy").addEventListener("change", findRaces);

  races = await loadCSV(CSV_FILE);

  const venueRows = await loadCSV(VENUE_FILE);
  venueRows.forEach(row => {
    venueLocations[row.Venue.trim().toUpperCase()] = {
      lat: Number(row.Lat),
      lon: Number(row.Lon),
    };
  });

  const postcodeRows = await loadCSV(POSTCODE_FILE);
  postcodeRows.forEach(row => {
    postcodeLocations[String(row.Postcode).trim()] = {
      lat: Number(row.Lat),
      lon: Number(row.Lon),
    };
  });

  document.getElementById("summary").textContent =
    `Loaded ${races.length} race rows.`;
});

async function loadCSV(url) {
  const response = await fetch(url);
  const text = await response.text();
  return parseCSV(text);
}

function parseCSV(text) {
  const rows = [];
  const lines = text.trim().split(/\r?\n/);
  const headers = parseCSVLine(lines[0]);

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row = {};

    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });

    rows.push(row);
  }

  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current);
  return result;
}

function getHorseDetails() {
  return {
    horseName: value("horseName"),
    nr: numberValue("nr"),
    gait: value("gait"),
    sex: value("sex"),
    age: numberValue("age"),
    wins: numberValue("wins"),
    trainerPostcode: value("trainerPostcode"),
    maxTravelKm: numberValue("maxTravelKm"),
    dateFrom: value("dateFrom"),
    dateTo: value("dateTo"),
    vicbred: document.getElementById("vicbred").checked,
    avoidMetro: document.getElementById("avoidMetro").checked,
    barrierImportance: value("barrierImportance"),
    travelImportance: value("travelImportance"),
    distanceImportance: value("distanceImportance"),
    preferredMinDistance: numberValue("preferredMinDistance"),
    preferredMaxDistance: numberValue("preferredMaxDistance"),
    prizemoneyImportance: value("prizemoneyImportance"),
    avoidSeasonedWinners: value("avoidSeasonedWinners"),
    sortBy: value("sortBy"),
    nextTwoWeeks: document.getElementById("nextTwoWeeks").checked,
  };
}

function findRaces() {
  const state = readStoredState() || getAppState();
  let horse = getSelectedHorseWithTrainer();

  if (horse.nextTwoWeeks) {
    setNextTwoWeeksDates();
    state.trainer.nextTwoWeeks = true;
    horse.dateFrom = value("dateFrom");
    horse.dateTo = value("dateTo");
    state.horses[state.selectedHorseIndex].dateFrom = horse.dateFrom;
    state.horses[state.selectedHorseIndex].dateTo = horse.dateTo;
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

  const matches = races
    .map(race => assessRace(race, horse))
    .filter(result => result.isEligible)
    .sort((a, b) => sortRaceResults(a, b, horse.sortBy));

  renderResults(matches, horse);
}

function assessRace(race, horse) {
  const reasons = [];
  const warnings = [];
  const penalties = [];

  let score = 50;
  let distanceKmValue = null;
  let hardFail = false;

  // Date range
  if (horse.dateFrom || horse.dateTo) {
    const raceDate = parseRaceDate(race.DateISO || race.Date);

    if (horse.dateFrom && raceDate && raceDate < horse.dateFrom) {
      hardFail = true;
    }

    if (horse.dateTo && raceDate && raceDate > horse.dateTo) {
      hardFail = true;
    }
  }

  // Avoid metro races where third character of race code is M
  if (horse.avoidMetro && race.RaceCode && race.RaceCode.length >= 3) {
    if (race.RaceCode.charAt(2).toUpperCase() === "M") {
      hardFail = true;
    }
  }

  const prizemoney = numberOrNull(race.Prizemoney);
  if (prizemoney === 0) {
    score -= 40;
    penalties.push("Trial / no prizemoney");
    hardFail = true;
  }

  // Distance from trainer
  if (horse.trainerPostcode && horse.maxTravelKm !== null) {
    const trainer = postcodeLocations[String(horse.trainerPostcode).trim()];
    const venue = venueLocations[(race.Venue || "").trim().toUpperCase()];
    const travelWeight = weightValue(horse.travelImportance);

    if (trainer && venue) {
      distanceKmValue = distanceKm(trainer.lat, trainer.lon, venue.lat, venue.lon);

      if (distanceKmValue <= horse.maxTravelKm) {
        reasons.push(`${Math.round(distanceKmValue)}km away`);
      } else {
        const overBy = distanceKmValue - horse.maxTravelKm;
        score -= Math.min(35, (overBy / 50) * 8 * travelWeight);
        penalties.push(`${Math.round(distanceKmValue)}km away`);
        hardFail = true;
      }
    } else {
      warnings.push("Distance not checked");
    }
  }

  // Gait
  if (horse.gait && race.Gait && race.Gait !== horse.gait) {
    score -= 45;
    penalties.push(`Wrong gait: ${race.Gait}`);
    hardFail = true;
  } else if (horse.gait && race.Gait === horse.gait) {
    reasons.push("Correct gait");
  }

  // NR fit
  if (horse.nr !== null) {
    const minNR = numberOrNull(race.MinNR);
    const maxNR = getRaceMaxNR(race);

    if (minNR !== null && horse.nr < minNR) {
      score -= 35;
      penalties.push(`Below NR range ${minNR}+`);
      hardFail = true;
    } else if (maxNR !== null && horse.nr > maxNR) {
      score -= 35;
      penalties.push(`Above NR cap ${maxNR}`);
      hardFail = true;
    } else if (minNR !== null || maxNR !== null) {
      reasons.push(`NR fit ${minNR ?? "open"}-${maxNR ?? "open"}`);
    }
  }

  // Lifetime wins
  if (horse.wins !== null) {
    const minWins = numberOrNull(race.MinWins);
    const maxWins = numberOrNull(race.MaxWins);

    if (minWins !== null && horse.wins < minWins) {
      score -= 30;
      penalties.push(`Below wins range ${minWins}+`);
      hardFail = true;
    } else if (maxWins !== null && horse.wins > maxWins) {
      score -= 30;
      penalties.push(`Above wins cap ${maxWins}`);
      hardFail = true;
    } else if (minWins !== null || maxWins !== null) {
      reasons.push(`Wins fit ${minWins ?? "open"}-${maxWins ?? "open"}`);

      if (maxWins !== null && maxWins <= 3 && horse.wins === maxWins) {
        score += 8;
        reasons.push("At top of low-wins race");
      }
    }

    const avoidWeight = weightValue(horse.avoidSeasonedWinners);

    if (avoidWeight > 0) {
      if (maxWins !== null && maxWins <= 3) {
        score += 12 * avoidWeight;
        reasons.push("Low-wins race");
      } else if (minWins === null && maxWins === null) {
        score -= 10 * avoidWeight;
        penalties.push("Open wins race");
      }
    }
  }

  // Age
  if (horse.age !== null) {
    const minAge = numberOrNull(race.MinAge);
    const maxAge = numberOrNull(race.MaxAge);

    if (minAge !== null && horse.age < minAge) {
      score -= 25;
      penalties.push(`Too young for age condition`);
      hardFail = true;
    } else if (maxAge !== null && horse.age > maxAge) {
      score -= 25;
      penalties.push(`Too old for age condition`);
      hardFail = true;
    } else if (minAge !== null || maxAge !== null) {
      reasons.push(`Age fit ${minAge ?? "open"}-${maxAge ?? "open"}`);

      if (minAge !== null && minAge >= 4) {
        score += 4;
        reasons.push("Older-age race");
      }
    }
  }

  // Sex / mares only
  if (isTrue(race.IsMaresOnly)) {
    if (horse.sex && horse.sex !== "Mare" && horse.sex !== "Filly") {
      score -= 45;
      penalties.push("Mares only");
      hardFail = true;
    } else {
      score += 10;
      reasons.push("Mares race fit");
    }
  }

  // Vicbred
  if (isTrue(race.IsVicbredOnly)) {
    if (horse.vicbred) {
      score += 8;
      reasons.push("Vicbred fit");
    } else {
      score -= 25;
      warnings.push("Vicbred only");
      hardFail = true;
    }
  }

  // Preferred distance
  const raceDistance = numberOrNull(race.Distance);
  const minPreferredDistance = horse.preferredMinDistance;
  const maxPreferredDistance = horse.preferredMaxDistance;
  const distanceWeight = weightValue(horse.distanceImportance);

  if (raceDistance !== null && (minPreferredDistance !== null || maxPreferredDistance !== null)) {
    const minOk = minPreferredDistance === null || raceDistance >= minPreferredDistance;
    const maxOk = maxPreferredDistance === null || raceDistance <= maxPreferredDistance;

    if (minOk && maxOk) {
      score += 15 * distanceWeight;
      reasons.push("Preferred distance");
    } else {
      score -= 15 * distanceWeight;
      penalties.push("Outside preferred distance");
    }
  }

  // Barrier draw preference
  const drawText = String(race.Draw || "").toUpperCase();
  const barrierWeight = weightValue(horse.barrierImportance);

  if (barrierWeight > 0) {
    if (drawText.includes("PBD")) {
      score += 10 * barrierWeight;
      reasons.push("Preferential barrier draw");
    } else if (drawText.includes("RBD")) {
      score -= 10 * barrierWeight;
      penalties.push("Random barrier draw");
    }
  }

  // Prizemoney
  const prizemoneyWeight = weightValue(horse.prizemoneyImportance);

  if (prizemoney !== null && prizemoney > 0) {
    if (prizemoney >= 15000) {
      score += 17 * prizemoneyWeight;
      reasons.push("Excellent prizemoney");
    } else if (prizemoney >= 10000) {
      score += 12 * prizemoneyWeight;
      reasons.push("Strong prizemoney");
    } else if (prizemoney >= 6000) {
      score += 6 * prizemoneyWeight;
      reasons.push("Decent prizemoney");
    } else if (prizemoney < 5000) {
      score -= 15 * prizemoneyWeight;
      penalties.push("Low prizemoney");
    }
  }

  // Conditions
  if (race.OtherConditionsRaw) {
    warnings.push("Check conditions");
    score -= 3;
  }

  if (horse.prizemoneyImportance === "high" && prizemoney !== null && prizemoney <= 4000) {
    score -= 18;
    penalties.push("High prizemoney preference + low stakes");
  }


  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    isEligible: !hardFail,
    race,
    reasons,
    warnings,
    penalties,
    score,
    rating: suitabilityRating(score),
    distanceKm: distanceKmValue,
  };
}

function notEligible() {
  return { isEligible: false };
}

function sortRaceResults(a, b, sortBy = "fit") {
  const dateA = parseRaceDate(a.race.DateISO || a.race.Date) || "9999-99-99";
  const dateB = parseRaceDate(b.race.DateISO || b.race.Date) || "9999-99-99";

  if (sortBy === "date") {
    if (dateA !== dateB) return dateA.localeCompare(dateB);

    const venueA = String(a.race.Venue || "");
    const venueB = String(b.race.Venue || "");

    if (venueA !== venueB) return venueA.localeCompare(venueB);

    return b.score - a.score;
  }

  if (b.score !== a.score) return b.score - a.score;
  return dateA.localeCompare(dateB);
}

function renderResults(matches, horse) {
  const summary = document.getElementById("summary");
  const results = document.getElementById("results");

  summary.textContent = `${matches.length} likely eligible race(s) found for ${horse.horseName || "this horse"}.`;
  results.innerHTML = "";

  if (!matches.length) {
    results.innerHTML = `<div class="empty-state">No likely matches found.</div>`;
    return;
  }

  results.innerHTML = `
    <table class="results-table">
      <thead>
        <tr>
          <th class="date-col">Date</th>
          <th class="venue-col">Venue</th>
          <th>Day</th>
          <th>Time</th>
          <th class="race-col">Race Details</th>
          <th>Race Code</th>
          <th>Distance</th>
          <th>Class</th>
          <th>Prizemoney</th>
          <th class="score-col">Fit</th>
        </tr>
      </thead>
      <tbody>
        ${matches.map(match => {
          const race = match.race;
          const km = match.distanceKm !== null ? Math.round(match.distanceKm) : "";

          const detailNotes = [
            ...match.reasons,
            ...match.penalties,
            ...match.warnings,
          ].join(" | ");

          const scoreClass = getScoreClass(match.score);

          return `
            <tr class="${scoreClass}">
              <td class="date-col">${race.Date || ""}</td>

              <td class="venue-col">
                ${race.URL
                  ? `<a href="${escapeHtml(race.URL)}" target="_blank" rel="noopener noreferrer">${race.Venue || ""}</a>`
                  : `${race.Venue || ""}`
                }
              </td>

              <td>${race.Weekday || ""}</td>

              <td>${race.TimeOfDay || ""}</td>

              <td class="race-col">
                <span class="race-name" title="${escapeHtml(race.OtherConditionsRaw || "No conditions listed.")}">
                  ${race.RaceName || ""}
                </span>
              </td>

              <td>${race.RaceCode || ""}</td>

              <td>
                ${(() => {
                  const raceDistance = Number(race.Distance);
                  const prefMin = Number(horse.preferredMinDistance);
                  const prefMax = Number(horse.preferredMaxDistance);

                  const belowMin =
                    horse.preferredMinDistance &&
                    !isNaN(raceDistance) &&
                    raceDistance < prefMin;

                  const aboveMax =
                    horse.preferredMaxDistance &&
                    !isNaN(raceDistance) &&
                    raceDistance > prefMax;

                  const distanceText = race.Distance ? `${race.Distance}m` : "";

                  if (belowMin || aboveMax) {
                    return `<span class="distance-warning">${distanceText}</span>`;
                  }

                  return distanceText;
                })()}
              </td>

              <td>${race.ClassRaw || ""}</td>

              <td title="${escapeHtml(race.PrizeMoneyRaw || "")}">
                ${(() => {
                  const prize = Number(race.Prizemoney);
                  const importance = (horse.prizemoneyImportance || "").toLowerCase();

                  const prizeText = race.Prizemoney
                    ? `$${prize.toLocaleString()}`
                    : "";

                  if (
                    importance !== "low" &&
                    !isNaN(prize) &&
                    prize < 5000
                  ) {
                    return `<span class="stakes-warning">${prizeText}</span>`;
                  }

                  return prizeText;
                })()}
              </td>

              <td class="score-col">
                <span class="score-pill ${scoreClass}" title="${escapeHtml(detailNotes)}">
                  ${scoreDot(match.score)} ${match.score}
                </span>
              </td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

function loadSavedDetails() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return;

  const state = JSON.parse(saved);
  const trainer = state.trainer || {};
  const horse = (state.horses && state.horses[state.selectedHorseIndex || 0]) || {};

  setValue("trainerPostcode", trainer.trainerPostcode);
  setValue("maxTravelKm", trainer.maxTravelKm);
  setValue("sortBy", trainer.sortBy);
  document.getElementById("nextTwoWeeks").checked = !!trainer.nextTwoWeeks;

  setValue("horseName", horse.horseName);
  setValue("nr", horse.nr);
  setValue("gait", horse.gait);
  setValue("sex", horse.sex);
  setValue("age", horse.age);
  setValue("wins", horse.wins);
  setValue("dateFrom", horse.dateFrom);
  setValue("dateTo", horse.dateTo);
  setValue("barrierImportance", horse.barrierImportance);
  setValue("travelImportance", horse.travelImportance);
  setValue("distanceImportance", horse.distanceImportance);
  setValue("preferredMinDistance", horse.preferredMinDistance);
  setValue("preferredMaxDistance", horse.preferredMaxDistance);
  setValue("prizemoneyImportance", horse.prizemoneyImportance);
  setValue("avoidSeasonedWinners", horse.avoidSeasonedWinners);

  document.getElementById("vicbred").checked = !!horse.vicbred;
  document.getElementById("avoidMetro").checked = !!horse.avoidMetro;
}

function clearSavedDetails() {
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
}

function value(id) {
  return document.getElementById(id).value.trim();
}

function numberValue(id) {
  const raw = value(id);
  if (raw === "") return null;
  return Number(raw);
}

function setValue(id, val) {
  if (val === undefined || val === null) return;
  document.getElementById(id).value = val;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
}

function isTrue(value) {
  return String(value).toLowerCase() === "true";
}

function parseRaceDate(value) {
  if (!value) return "";

  const text = String(value).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const months = {
    jan: "01", january: "01",
    feb: "02", february: "02",
    mar: "03", march: "03",
    apr: "04", april: "04",
    may: "05",
    jun: "06", june: "06",
    jul: "07", july: "07",
    aug: "08", august: "08",
    sep: "09", september: "09",
    oct: "10", october: "10",
    nov: "11", november: "11",
    dec: "12", december: "12",
  };

  let match = text.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (match) {
    const day = match[1].padStart(2, "0");
    const month = months[match[2].toLowerCase()];
    const year = match[3];
    return month ? `${year}-${month}-${day}` : "";
  }

  match = text.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/);
  if (match) {
    const day = match[1].padStart(2, "0");
    const month = months[match[2].toLowerCase()];
    const year = `20${match[3]}`;
    return month ? `${year}-${month}-${day}` : "";
  }

  return "";
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(value) {
  return value * Math.PI / 180;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function weightValue(setting) {
  if (setting === "low") return 0.5;
  if (setting === "high" || setting === "strong") return 1.5;
  if (setting === "off") return 0;
  return 1;
}

function suitabilityRating(score) {
  if (score >= 80) return "Strong Fit";
  if (score >= 55) return "Reasonable Fit";
  if (score >= 30) return "Marginal Fit";
  return "Poor Fit";
}

function getScoreClass(score) {
  if (score >= 80) return "score-strong";
  if (score >= 55) return "score-good";
  if (score >= 30) return "score-marginal";
  return "score-poor";
}

function scoreDot(score) {
  if (score >= 80) return "🟢";
  if (score >= 55) return "🟡";
  if (score >= 30) return "🟠";
  return "🔴";
}

function setNextTwoWeeksDates() {
  const today = new Date();
  const twoWeeks = new Date();

  twoWeeks.setDate(today.getDate() + 14);

  document.getElementById("dateFrom").value = formatDateInput(today);
  document.getElementById("dateTo").value = formatDateInput(twoWeeks);
}

function formatDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function getRaceMaxNR(race) {
  const parsedMaxNR = numberOrNull(race.MaxNR);

  if (parsedMaxNR !== null) {
    return parsedMaxNR;
  }

  const classText = String(race.ClassRaw || "").toUpperCase();

  let match = classText.match(/NR\s*UP\s*TO\s*(\d+)/);
  if (match) return Number(match[1]);

  match = classText.match(/NR\s*(\d+)\s*(?:TO|-)\s*(\d+)/);
  if (match) return Number(match[2]);

  return null;
}

function getAppState() {
  return {
    trainer: {
      trainerPostcode: value("trainerPostcode"),
      maxTravelKm: numberValue("maxTravelKm"),
      sortBy: value("sortBy"),
      nextTwoWeeks: document.getElementById("nextTwoWeeks").checked,
    },
    horses: [
      {
        horseName: value("horseName"),
        nr: numberValue("nr"),
        gait: value("gait"),
        sex: value("sex"),
        age: numberValue("age"),
        wins: numberValue("wins"),
        vicbred: document.getElementById("vicbred").checked,
        avoidMetro: document.getElementById("avoidMetro").checked,
        barrierImportance: value("barrierImportance"),
        travelImportance: value("travelImportance"),
        distanceImportance: value("distanceImportance"),
        preferredMinDistance: numberValue("preferredMinDistance"),
        preferredMaxDistance: numberValue("preferredMaxDistance"),
        prizemoneyImportance: value("prizemoneyImportance"),
        avoidSeasonedWinners: value("avoidSeasonedWinners"),
        dateFrom: value("dateFrom"),
        dateTo: value("dateTo"),
      }
    ],
    selectedHorseIndex: 0,
  };
}

function getSelectedHorseWithTrainer() {
  const storedState = readStoredState();
  const currentState = getAppState();

  const state = storedState || currentState;
  const selectedIndex = state.selectedHorseIndex || 0;
  const horse = (state.horses && state.horses[selectedIndex]) || currentState.horses[0] || {};

  return {
    ...horse,
    trainerPostcode: currentState.trainer.trainerPostcode,
    maxTravelKm: currentState.trainer.maxTravelKm,
    sortBy: currentState.trainer.sortBy,
    nextTwoWeeks: currentState.trainer.nextTwoWeeks,
  };
}

function saveStoredState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function renderHorseSelector() {
  const selector = document.getElementById("horseSelector");
  if (!selector) return;

  const state = readStoredState() || getAppState();
  const horses = state.horses || [];

  selector.innerHTML = "";

  horses.forEach((horse, index) => {
    const option = document.createElement("option");
    option.value = index;
    option.textContent = horse.horseName || `Horse ${index + 1}`;
    selector.appendChild(option);
  });

  selector.value = state.selectedHorseIndex || 0;
}

function saveCurrentHorse() {
  const state = readStoredState() || getAppState();

  state.trainer = {
    trainerPostcode: value("trainerPostcode"),
    maxTravelKm: numberValue("maxTravelKm"),
    sortBy: value("sortBy"),
    nextTwoWeeks: document.getElementById("nextTwoWeeks").checked,
  };

  const index = Number(document.getElementById("horseSelector").value || 0);

  state.horses = state.horses || [];
  state.horses[index] = {
    horseName: value("horseName"),
    nr: numberValue("nr"),
    gait: value("gait"),
    sex: value("sex"),
    age: numberValue("age"),
    wins: numberValue("wins"),
    vicbred: document.getElementById("vicbred").checked,
    avoidMetro: document.getElementById("avoidMetro").checked,
    barrierImportance: value("barrierImportance"),
    travelImportance: value("travelImportance"),
    distanceImportance: value("distanceImportance"),
    preferredMinDistance: numberValue("preferredMinDistance"),
    preferredMaxDistance: numberValue("preferredMaxDistance"),
    prizemoneyImportance: value("prizemoneyImportance"),
    avoidSeasonedWinners: value("avoidSeasonedWinners"),
    dateFrom: value("dateFrom"),
    dateTo: value("dateTo"),
  };

  state.selectedHorseIndex = index;
  saveStoredState(state);
  renderHorseSelector();
}

function addHorse() {
  const state = readStoredState() || getAppState();

  state.horses = state.horses || [];
  state.horses.push({
    horseName: "New Horse",
    nr: null,
    gait: "",
    sex: "",
    age: null,
    wins: null,
    vicbred: false,
    avoidMetro: false,
    barrierImportance: "medium",
    travelImportance: "medium",
    distanceImportance: "medium",
    preferredMinDistance: null,
    preferredMaxDistance: null,
    prizemoneyImportance: "medium",
    avoidSeasonedWinners: "medium",
    dateFrom: value("dateFrom"),
    dateTo: value("dateTo"),
  });

  state.selectedHorseIndex = state.horses.length - 1;
  saveStoredState(state);

  loadSavedDetails();
  renderHorseSelector();
}

function loadSelectedHorseFromSelector() {
  const state = readStoredState();
  if (!state) return;

  state.selectedHorseIndex = Number(document.getElementById("horseSelector").value || 0);
  saveStoredState(state);

  loadSavedDetails();
}

function readStoredState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return null;

  try {
    return JSON.parse(saved);
  } catch {
    return null;
  }
}

function saveStoredState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function renderHorseSelector() {
  const selector = document.getElementById("horseSelector");
  if (!selector) return;

  const state = readStoredState() || getAppState();
  const horses = state.horses || [];

  selector.innerHTML = "";

  horses.forEach((horse, index) => {
    const option = document.createElement("option");
    option.value = index;
    option.textContent = horse.horseName || `Horse ${index + 1}`;
    selector.appendChild(option);
  });

  selector.value = state.selectedHorseIndex || 0;
}

function saveCurrentHorse() {
  const state = readStoredState() || getAppState();

  state.trainer = {
    trainerPostcode: value("trainerPostcode"),
    maxTravelKm: numberValue("maxTravelKm"),
    sortBy: value("sortBy"),
    nextTwoWeeks: document.getElementById("nextTwoWeeks").checked,
  };

  const index = Number(document.getElementById("horseSelector").value || 0);

  state.horses = state.horses || [];
  state.horses[index] = getCurrentHorseOnly();
  state.selectedHorseIndex = index;

  saveStoredState(state);
  renderHorseSelector();
}

function addHorse() {
  const state = readStoredState() || getAppState();

  state.horses = state.horses || [];
  state.horses.push({
    horseName: "New Horse",
    nr: null,
    gait: "",
    sex: "",
    age: null,
    wins: null,
    vicbred: false,
    avoidMetro: false,
    barrierImportance: "medium",
    travelImportance: "medium",
    distanceImportance: "medium",
    preferredMinDistance: null,
    preferredMaxDistance: null,
    prizemoneyImportance: "medium",
    avoidSeasonedWinners: "medium",
    dateFrom: value("dateFrom"),
    dateTo: value("dateTo"),
  });

  state.selectedHorseIndex = state.horses.length - 1;
  saveStoredState(state);

  loadSavedDetails();
  renderHorseSelector();
}

function loadSelectedHorseFromSelector() {
  const state = readStoredState();
  if (!state) return;

  state.selectedHorseIndex = Number(document.getElementById("horseSelector").value || 0);
  saveStoredState(state);

  loadSavedDetails();
}

function getCurrentHorseOnly() {
  return {
    horseName: value("horseName"),
    nr: numberValue("nr"),
    gait: value("gait"),
    sex: value("sex"),
    age: numberValue("age"),
    wins: numberValue("wins"),
    vicbred: document.getElementById("vicbred").checked,
    avoidMetro: document.getElementById("avoidMetro").checked,
    barrierImportance: value("barrierImportance"),
    travelImportance: value("travelImportance"),
    distanceImportance: value("distanceImportance"),
    preferredMinDistance: numberValue("preferredMinDistance"),
    preferredMaxDistance: numberValue("preferredMaxDistance"),
    prizemoneyImportance: value("prizemoneyImportance"),
    avoidSeasonedWinners: value("avoidSeasonedWinners"),
    dateFrom: value("dateFrom"),
    dateTo: value("dateTo"),
  };
}

function getAppState() {
  return {
    trainer: {
      trainerPostcode: value("trainerPostcode"),
      maxTravelKm: numberValue("maxTravelKm"),
      sortBy: value("sortBy"),
      nextTwoWeeks: document.getElementById("nextTwoWeeks").checked,
    },
    horses: [getCurrentHorseOnly()],
    selectedHorseIndex: 0,
  };
}

function getSelectedHorseWithTrainer() {
  const state = readStoredState() || getAppState();
  const currentTrainer = getAppState().trainer;
  const selectedIndex = state.selectedHorseIndex || 0;
  const horse = (state.horses && state.horses[selectedIndex]) || getCurrentHorseOnly();

  return {
    ...horse,
    trainerPostcode: currentTrainer.trainerPostcode,
    maxTravelKm: currentTrainer.maxTravelKm,
    sortBy: currentTrainer.sortBy,
    nextTwoWeeks: currentTrainer.nextTwoWeeks,
  };
}