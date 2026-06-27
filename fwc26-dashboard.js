(() => {
  "use strict";

  const GROUPS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];
  const MATCHES_CSV_URL = "./data/matches.csv"; 
  const RANK_CSV_URL = "./data/rank.csv"; 
  const KNOCKOUT_REFRESH_MS = 30000;
  const KNOCKOUT_RESULT_FILES = {
    ro32: { url: "./data/RO32.csv", dataKey: "ro32Url" },
    ro16: { url: "./data/RO16.csv", dataKey: "ro16Url" },
    quarter: { url: "./data/Q.csv", dataKey: "quarterUrl" },
    semi: { url: "./data/S.csv", dataKey: "semiUrl" },
    bronze: { url: "./data/B.csv", dataKey: "bronzeUrl" },
    final: { url: "./data/F.csv", dataKey: "finalUrl" }
  };

  const TEAM_CODES = {
    Canada: "CAN", Mexico: "MEX", "United States": "USA", Algeria: "ALG",
    Argentina: "ARG", Australia: "AUS", Austria: "AUT", Belgium: "BEL",
    "Bosnia and Herzegovina": "BIH", Brazil: "BRA", "Cabo Verde": "CPV",
    "Cape Verde": "CPV", Colombia: "COL", "Congo DR": "COD", Croatia: "CRO", 
    Curaçao: "CUW", Curacao: "CUW", Czechia: "CZE", Ecuador: "ECU", Egypt: "EGY", 
    England: "ENG", France: "FRA", Germany: "GER", Ghana: "GHA", Haiti: "HAI",
    Iran: "IRN", Iraq: "IRQ", "Cote d'Ivoire": "CIV", "Ivory Coast": "CIV", 
    Japan: "JPN", Jordan: "JOR", Morocco: "MAR", Netherlands: "NED", 
    "New Zealand": "NZL", Norway: "NOR", Panama: "PAN", Paraguay: "PAR", 
    Portugal: "POR", Qatar: "QAT", "Saudi Arabia": "KSA", Scotland: "SCO", 
    Senegal: "SEN", "South Africa": "RSA", "South Korea": "KOR", Spain: "ESP",
    Sweden: "SWE", Switzerland: "SUI", Tunisia: "TUN", Türkiye: "TUR", 
    Turkiye: "TUR", Turkey: "TUR", Uruguay: "URU", Uzbekistan: "UZB"
  };

  document.addEventListener("DOMContentLoaded", async () => {
    const app = document.getElementById("fwc26-dashboard");
    if (!app) return;

    updateNavIndicator(app);
    window.addEventListener("resize", () => updateNavIndicator(app), { passive: true });

    const page = app.dataset.page;
    if (["groups", "third", "knockout", "results"].includes(page)) {
      await loadMatchData(app, page);
      if (page === "knockout") {
        window.setInterval(() => loadMatchData(app, page), KNOCKOUT_REFRESH_MS);
      }
    }
  });

  async function loadMatchData(app, page) {
    const status = document.getElementById("data-status");
    if (status) status.textContent = "Processing official tiebreaker rules...";

    const [matchesCsvText, rankCsvText] = await Promise.all([
      readCsv(app.dataset.matchesUrl || MATCHES_CSV_URL),
      readCsv(RANK_CSV_URL) 
    ]);

    const ranks = parseRankCsv(rankCsvText);
    const rawMatches = parseCsv(matchesCsvText).map(normalizeMatch).filter((m) => m.group && m.team1 && m.team2);
    const standings = buildStandings(rawMatches, ranks);
    const groupRankings = resolveAllGroups(standings, rawMatches, ranks);

    if (page === "groups") {
      renderGroupTables(groupRankings);
      setupGroupViewer();
      setupGroupSearch();
      if (status) status.textContent = "Group tables generated.";
    } else if (page === "third") {
      const thirdTeams = rankThirdPlaceTeams(groupRankings);
      renderThirdTable(thirdTeams);
      if (status) status.textContent = "Third-placed table generated.";
    } else if (page === "knockout") {
      const knockoutResults = await loadKnockoutResults(app);
      const resultCount = countKnockoutResults(knockoutResults);
      renderKnockoutMatrix(groupRankings, knockoutResults);
      if (status) {
        status.textContent = resultCount
          ? `Knockout bracket updated from ${resultCount} result row${resultCount === 1 ? "" : "s"}.`
          : "Round of 32 bracket generated based on current qualifiers.";
      }
    } else if (page === "results") {
      renderResults(rawMatches);
      if (status) status.textContent = "Past results generated.";
    }
  }

  async function readCsv(url) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error();
      return await res.text();
    } catch {
      return "";
    }
  }

  async function loadKnockoutResults(app) {
    const entries = await Promise.all(
      Object.entries(KNOCKOUT_RESULT_FILES).map(async ([stage, config]) => {
        const url = app.dataset[config.dataKey] || config.url;
        return [stage, parseKnockoutResults(await readCsv(url))];
      })
    );

    return Object.fromEntries(entries);
  }

  function countKnockoutResults(results) {
    return Object.values(results).reduce((total, rows) => total + rows.length, 0);
  }

  function parseCsv(text) {
    if (!text) return [];
    const rows = [];
    let cell = "", row = [], quoted = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i], next = text[i + 1];
      if (char === '"' && quoted && next === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = !quoted;
      else if (char === "," && !quoted) { row.push(cell.trim()); cell = ""; }
      else if ((char === "\n" || char === "\r") && !quoted) {
        if (char === "\r" && next === "\n") i++;
        row.push(cell.trim());
        if (row.some(Boolean)) rows.push(row);
        row = []; cell = "";
      } else cell += char;
    }
    if (cell || row.length) { row.push(cell.trim()); if (row.some(Boolean)) rows.push(row); }
    if (!rows.length) return [];
    const headers = rows.shift().map(h => h.replace(/^\uFEFF/, "").toLowerCase());
    return rows.map(vals => Object.fromEntries(headers.map((h, i) => [h, vals[i] || ""])));
  }

  function parseRankCsv(text) {
    const rankMap = new Map();
    if (!text) return rankMap;
    const lines = text.split(/\r?\n/);
    lines.forEach(line => {
      if (!line.trim()) return;
      const parts = line.split(',');
      if (parts.length >= 2) {
        let col1 = parts[0].trim(), col2 = parts[1].trim();
        let rank = parseInt(col1, 10), team = col2;
        if (isNaN(rank)) { rank = parseInt(col2, 10); team = col1; }
        if (!isNaN(rank) && team) rankMap.set(team, rank);
      }
    });
    return rankMap;
  }

  function parseKnockoutResults(text) {
    return parseCsv(text)
      .map(row => ({
        team1: (row.team1 || "").trim(),
        team2: (row.team2 || "").trim(),
        winner: (row.winner || "").trim()
      }))
      .filter(row => row.team1 && row.team2 && row.winner);
  }

  function normalizeMatch(row) {
    return {
      group: row.group?.trim().toUpperCase(),
      time: row["bd standard time"] || "",
      team1: row["team-1"] || "",
      team2: row["team-2"] || "",
      goals1: toNumber(row["goals of team-1"]),
      goals2: toNumber(row["goals of team-2"]),
      red1: toNumber(row["red card of team-1"]),
      red2: toNumber(row["red card of team-2"]),
      yellow1: toNumber(row["yellow card of team-1"]),
      yellow2: toNumber(row["yellow card of team-2"])
    };
  }

  function buildStandings(matches, ranks) {
    const table = new Map();
    matches.forEach(m => {
      const a = ensureTeam(table, m.group, m.team1, ranks);
      const b = ensureTeam(table, m.group, m.team2, ranks);
      a.played++; b.played++;
      a.goalsFor += m.goals1; a.goalsAgainst += m.goals2;
      b.goalsFor += m.goals2; b.goalsAgainst += m.goals1;
      a.redCards += m.red1; b.redCards += m.red2;
      a.yellowCards += m.yellow1; b.yellowCards += m.yellow2;

      if (m.goals1 > m.goals2) { a.wins++; b.losses++; a.points += 3; }
      else if (m.goals2 > m.goals1) { b.wins++; a.losses++; b.points += 3; }
      else { a.draws++; b.draws++; a.points += 1; b.points += 1; }
    });

    table.forEach(t => {
      t.goalDifference = t.goalsFor - t.goalsAgainst;
      t.conductScore = (t.yellowCards * -1) + (t.redCards * -4);
    });
    return Array.from(table.values());
  }

  function ensureTeam(table, group, name, ranks) {
    const key = `${group}:${name}`;
    if (!table.has(key)) {
      table.set(key, {
        group, name, code: TEAM_CODES[name] || name.slice(0, 3).toUpperCase(),
        played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, 
        goalDifference: 0, redCards: 0, yellowCards: 0, points: 0,
        conductScore: 0, fifaRank: ranks.get(name) || 999 
      });
    }
    return table.get(key);
  }

  function getH2HStats(teamsInTie, allMatches) {
    const h2hMap = new Map();
    teamsInTie.forEach(t => h2hMap.set(t.name, { pts: 0, gf: 0, ga: 0, gd: 0 }));
    
    const relevantMatches = allMatches.filter(m => h2hMap.has(m.team1) && h2hMap.has(m.team2));
    relevantMatches.forEach(m => {
      const a = h2hMap.get(m.team1);
      const b = h2hMap.get(m.team2);
      a.gf += m.goals1; a.ga += m.goals2;
      b.gf += m.goals2; b.ga += m.goals1;
      if (m.goals1 > m.goals2) a.pts += 3;
      else if (m.goals2 > m.goals1) b.pts += 3;
      else { a.pts += 1; b.pts += 1; }
    });

    h2hMap.forEach(stats => stats.gd = stats.gf - stats.ga);
    return h2hMap;
  }

  function resolveAllGroups(teams, matches) {
    const rankedGroups = new Map();
    GROUPS.forEach(g => {
      let groupTeams = teams.filter(t => t.group === g);
      groupTeams = rankSubset(groupTeams, matches);
      rankedGroups.set(g, groupTeams);
    });
    return rankedGroups;
  }

  function rankSubset(subset, matches) {
    if (subset.length <= 1) return subset;

    subset.sort((a, b) => b.points - a.points);

    const resolved = [];
    let currentTie = [subset[0]];

    for (let i = 1; i < subset.length; i++) {
      if (subset[i].points === currentTie[0].points) {
        currentTie.push(subset[i]);
      } else {
        resolved.push(...resolveTieBlock(currentTie, matches));
        currentTie = [subset[i]];
      }
    }
    resolved.push(...resolveTieBlock(currentTie, matches));
    return resolved;
  }

  function resolveTieBlock(tiedTeams, matches) {
    if (tiedTeams.length === 1) return tiedTeams;
    
    const h2hStats = getH2HStats(tiedTeams, matches);

    tiedTeams.sort((a, b) => {
      const aH2H = h2hStats.get(a.name);
      const bH2H = h2hStats.get(b.name);

      return (bH2H.pts - aH2H.pts) || 
             (bH2H.gd - aH2H.gd) || 
             (bH2H.gf - aH2H.gf) || 
             (b.goalDifference - a.goalDifference) || 
             (b.goalsFor - a.goalsFor) || 
             (b.conductScore - a.conductScore) || 
             (a.fifaRank - b.fifaRank) ||
             a.name.localeCompare(b.name);
    });

    return tiedTeams;
  }

  function rankThirdPlaceTeams(groupRankings) {
    const thirdTeams = [];
    groupRankings.forEach(teams => {
      if (teams.length >= 3) thirdTeams.push(teams[2]);
    });
    
    return thirdTeams.sort((a, b) => {
      return (b.points - a.points) || 
             (b.goalDifference - a.goalDifference) || 
             (b.goalsFor - a.goalsFor) || 
             (b.conductScore - a.conductScore) || 
             (a.fifaRank - b.fifaRank) ||
             a.name.localeCompare(b.name);
    });
  }

  function renderGroupTables(groupRankings) {
    const template = document.getElementById("team-row-template");
    if (!template) return;

    groupRankings.forEach((rows, group) => {
      const tbody = document.getElementById(`tbody-${group}`);
      if (!tbody) return;
      tbody.innerHTML = "";

      rows.forEach((team, idx) => {
        const clone = template.content.cloneNode(true);
        const tr = clone.querySelector(".team-row");
        tr.classList.add(`rank-${idx + 1}`, idx < 2 ? "qualified" : idx === 2 ? "third" : "eliminated");
        tr.setAttribute("data-team", team.name);

        const rankBadge = clone.querySelector('[data-col="rank"]');
        rankBadge.className = `rank-badge ${idx < 2 ? "green" : idx === 2 ? "yellow" : "muted"}`;
        rankBadge.textContent = idx + 1;
        
        clone.querySelector('[data-col="code"]').textContent = team.code;
        clone.querySelector('[data-col="name"]').textContent = team.name;
        clone.querySelector('[data-col="played"]').textContent = team.played;
        clone.querySelector('[data-col="wins"]').textContent = team.wins;
        clone.querySelector('[data-col="draws"]').textContent = team.draws;
        clone.querySelector('[data-col="losses"]').textContent = team.losses;
        clone.querySelector('[data-col="gf"]').textContent = team.goalsFor;
        clone.querySelector('[data-col="ga"]').textContent = team.goalsAgainst;
        
        const gd = clone.querySelector('[data-col="gd"]');
        gd.className = team.goalDifference > 0 ? "goal-diff positive" : team.goalDifference < 0 ? "goal-diff negative" : "goal-diff neutral";
        gd.textContent = team.goalDifference > 0 ? `+${team.goalDifference}` : team.goalDifference;
        
        clone.querySelector('[data-col="rc"]').textContent = team.redCards;
        clone.querySelector('[data-col="yc"]').textContent = team.yellowCards;
        clone.querySelector('[data-col="pts"]').textContent = team.points;
        tbody.appendChild(clone);
      });
    });
    setupCardEntrance(document);
  }

  function renderThirdTable(thirdTeams) {
    const tbody = document.getElementById("third-tbody");
    const template = document.getElementById("third-row-template");
    if (!tbody || !template) return;
    tbody.innerHTML = "";

    thirdTeams.forEach((team, idx) => {
      if (idx === 8) {
        const cutoff = document.createElement("tr");
        cutoff.className = "cutoff-row";
        cutoff.innerHTML = `<td colspan="9">Qualification Cutoff</td>`;
        tbody.appendChild(cutoff);
      }
      const clone = template.content.cloneNode(true);
      const tr = clone.querySelector(".team-row");
      tr.classList.add(idx < 8 ? "in-zone" : "out-zone");
      tr.setAttribute("data-team", team.name);
      
      const rankBadge = clone.querySelector('[data-col="rank"]');
      rankBadge.className = `rank-badge ${idx < 8 ? "green" : "muted"}`;
      rankBadge.textContent = idx + 1;
      
      clone.querySelector('[data-col="code"]').textContent = team.code;
      clone.querySelector('[data-col="name"]').textContent = team.name;
      clone.querySelector('[data-col="group"]').textContent = team.group;
      clone.querySelector('[data-col="pts"]').textContent = team.points;
      
      const gd = clone.querySelector('[data-col="gd"]');
      gd.className = team.goalDifference > 0 ? "goal-diff positive" : team.goalDifference < 0 ? "goal-diff negative" : "goal-diff neutral";
      gd.textContent = team.goalDifference > 0 ? `+${team.goalDifference}` : team.goalDifference;
      
      clone.querySelector('[data-col="gf"]').textContent = team.goalsFor;
      clone.querySelector('[data-col="rc"]').textContent = team.redCards;
      clone.querySelector('[data-col="yc"]').textContent = team.yellowCards;
      clone.querySelector('[data-col="status"]').textContent = idx < 8 ? "Qualified" : "Eliminated";
      tbody.appendChild(clone);
    });
    setupCardEntrance(document);
  }

function renderKnockoutMatrix(groupRankings, knockoutResults = {}) {
    const template = document.getElementById("knockout-match-template");
    if (!template) return;
    const results = Array.isArray(knockoutResults) ? { ro32: knockoutResults } : knockoutResults;

    const columns = [
      "left-r32", "left-r16", "left-qf", "left-sf",
      "center-finals",
      "right-sf", "right-qf", "right-r16", "right-r32"
    ];
    columns.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = "";
    });

    const thirdTeams = rankThirdPlaceTeams(groupRankings).slice(0, 8);
    const get3rd = (idx, label) => thirdTeams[idx] ? { ...thirdTeams[idx], seed: `3${thirdTeams[idx].group}` } : { name: "TBD", seed: label };
    const getSeed = (rank, grp) => {
      const t = groupRankings.get(grp)?.[rank - 1];
      return t ? { ...t, seed: `${rank}${grp}` } : { name: "TBD", seed: `${rank}${grp}` };
    };

    const matches = {
      73: { t1: getSeed(1, 'E'), t2: get3rd(0, '3(A/B/C/D/F)*') },
      74: { t1: getSeed(1, 'I'), t2: get3rd(1, '3(C/D/F/G/H)*') },
      75: { t1: getSeed(2, 'A'), t2: getSeed(2, 'B') },
      76: { t1: getSeed(1, 'F'), t2: getSeed(2, 'C') },
      77: { t1: getSeed(2, 'K'), t2: getSeed(2, 'L') },
      78: { t1: getSeed(1, 'H'), t2: getSeed(2, 'J') },
      79: { t1: getSeed(1, 'D'), t2: get3rd(2, '3(B/E/F/I/J)*') },
      80: { t1: getSeed(1, 'G'), t2: get3rd(3, '3(A/E/H/I/J)*') },
      81: { t1: getSeed(1, 'C'), t2: getSeed(2, 'F') },
      82: { t1: getSeed(2, 'E'), t2: getSeed(2, 'I') },
      83: { t1: getSeed(1, 'A'), t2: get3rd(4, '3(C/E/F/H/I)*') },
      84: { t1: getSeed(1, 'L'), t2: get3rd(5, '3(E/H/I/J/K)*') },
      85: { t1: getSeed(1, 'J'), t2: getSeed(2, 'H') },
      86: { t1: getSeed(2, 'D'), t2: getSeed(2, 'G') },
      87: { t1: getSeed(1, 'B'), t2: get3rd(6, '3(E/F/G/I/J)*') },
      88: { t1: getSeed(1, 'K'), t2: get3rd(7, '3(D/E/I/J/L)*') }
    };

    applyMatchResults(matches, range(73, 88), results.ro32 || []);

    const getAdvancingTeam = (matchId) => matches[matchId]?.winner || { name: `Winner Match ${matchId}`, seed: `M${matchId}` };
    const getLosingTeam = (matchId) => matches[matchId]?.loser || { name: `Loser Match ${matchId}`, seed: `M${matchId}` };
    const addFutureMatch = (id, m1, m2) => {
      matches[id] = {
        t1: getAdvancingTeam(m1),
        t2: getAdvancingTeam(m2)
      };
    };

    addFutureMatch(89, 73, 74); addFutureMatch(90, 75, 76);
    addFutureMatch(91, 77, 78); addFutureMatch(92, 79, 80);
    addFutureMatch(93, 81, 82); addFutureMatch(94, 83, 84);
    addFutureMatch(95, 85, 86); addFutureMatch(96, 87, 88);
    applyMatchResults(matches, range(89, 96), results.ro16 || []);

    addFutureMatch(97, 89, 90); addFutureMatch(98, 91, 92);
    addFutureMatch(99, 93, 94); addFutureMatch(100, 95, 96);
    applyMatchResults(matches, range(97, 100), results.quarter || []);

    addFutureMatch(101, 97, 98); addFutureMatch(102, 99, 100);
    applyMatchResults(matches, range(101, 102), results.semi || []);

    matches[104] = {
      t1: getAdvancingTeam(101),
      t2: getAdvancingTeam(102)
    };
    matches[103] = {
      t1: getLosingTeam(101),
      t2: getLosingTeam(102)
    };
    applyMatchResults(matches, [103], results.bronze || []);
    applyMatchResults(matches, [104], results.final || []);

    const appendMatch = (matchId, containerId, extraClass = "") => {
      const m = matches[matchId];
      const dest = document.getElementById(containerId);
      if (!dest || !m) return;

      const clone = template.content.cloneNode(true);
      const card = clone.querySelector(".bracket-match");
      if (extraClass) card.classList.add(extraClass);

      card.querySelector(".match-number").textContent = `Match ${matchId}`;
      renderKnockoutTeams(card, m.t1, m.t2, m.winner);
      dest.appendChild(clone);
    };

    [73, 74, 75, 76, 77, 78, 79, 80].forEach(id => appendMatch(id, "left-r32"));
    [89, 90, 91, 92].forEach(id => appendMatch(id, "left-r16"));
    [97, 98].forEach(id => appendMatch(id, "left-qf"));
    appendMatch(101, "left-sf");

    appendMatch(104, "center-finals", "grand-final");
    appendMatch(103, "center-finals", "third-place");

    appendMatch(102, "right-sf");
    [99, 100].forEach(id => appendMatch(id, "right-qf"));
    [93, 94, 95, 96].forEach(id => appendMatch(id, "right-r16"));
    [81, 82, 83, 84, 85, 86, 87, 88].forEach(id => appendMatch(id, "right-r32"));

    setupCardEntrance(document);
  }

  function applyMatchResults(matches, matchIds, results) {
    results.forEach(result => {
      const matchId = findMatchId(matches, matchIds, result);
      if (!matchId) return;

      const match = matches[matchId];
      const winner = getWinnerTeam(match, result);
      if (!winner) return;

      match.winner = winner;
      match.loser = getLoserTeam(match, winner);
    });
  }

  function findMatchId(matches, matchIds, result) {
    for (const id of matchIds) {
      const match = matches[id];
      if (match && isSameTeamPair(match.t1.name, match.t2.name, result.team1, result.team2)) {
        return id;
      }
    }
    return null;
  }

  function getWinnerTeam(match, result) {
    const winner = result.winner;
    const matchedTeam = findTeamInMatch(match, winner) ||
      (isSameTeam(winner, result.team1) ? findTeamInMatch(match, result.team1) : null) ||
      (isSameTeam(winner, result.team2) ? findTeamInMatch(match, result.team2) : null);
    if (matchedTeam) return matchedTeam;

    return {
      name: winner,
      seed: TEAM_CODES[winner] || winner.slice(0, 3).toUpperCase()
    };
  }

  function getLoserTeam(match, winner) {
    if (isSameTeam(winner.name, match.t1.name)) return match.t2;
    if (isSameTeam(winner.name, match.t2.name)) return match.t1;
    return null;
  }

  function findTeamInMatch(match, teamName) {
    if (isSameTeam(teamName, match.t1.name)) return match.t1;
    if (isSameTeam(teamName, match.t2.name)) return match.t2;
    return null;
  }

  function isSameTeamPair(teamA, teamB, otherA, otherB) {
    return (isSameTeam(teamA, otherA) && isSameTeam(teamB, otherB)) ||
           (isSameTeam(teamA, otherB) && isSameTeam(teamB, otherA));
  }

  function isSameTeam(a, b) {
    return normalizeTeamKey(a) === normalizeTeamKey(b);
  }

  function normalizeTeamKey(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function range(start, end) {
    return Array.from({ length: end - start + 1 }, (_, idx) => start + idx);
  }

  function renderKnockoutTeams(card, teamA, teamB, winner) {
    const teams = card.querySelector(".knockout-teams");
    if (!teams) return;

    teams.innerHTML = "";
    teams.style.display = "grid";
    teams.style.gridTemplateColumns = "1fr";
    teams.style.justifyItems = "stretch";
    teams.style.gap = "8px";

    teams.appendChild(createKnockoutTeamLine(teamA, "t1", winner));

    const versus = document.createElement("strong");
    versus.className = "score";
    versus.textContent = "vs";
    versus.style.minWidth = "0";
    versus.style.textAlign = "center";
    versus.style.lineHeight = "1";
    teams.appendChild(versus);

    teams.appendChild(createKnockoutTeamLine(teamB, "t2", winner));
  }

  function createKnockoutTeamLine(team, prefix, winner) {
    const line = document.createElement("span");
    line.className = "team-identity";
    line.style.width = "100%";
    line.style.justifyContent = "flex-start";

    const seed = document.createElement("span");
    seed.className = "team-flag";
    seed.dataset.col = `${prefix}-seed`;
    seed.textContent = team.seed;

    const name = document.createElement("span");
    name.className = "team-name";
    name.dataset.col = `${prefix}-name`;
    name.textContent = team.name;
    name.style.maxWidth = "none";
    name.style.overflow = "visible";
    name.style.textOverflow = "clip";
    name.style.whiteSpace = "normal";
    name.style.lineHeight = "1.25";
    if (winner && isSameTeam(team.name, winner.name)) {
      name.style.color = "var(--green)";
      name.style.fontWeight = "900";
      seed.style.borderColor = "rgba(66, 242, 161, 0.64)";
      seed.style.color = "var(--green)";
    }

    line.append(seed, name);
    return line;
  }

  function renderResults(matches) {
    const grid = document.getElementById("results-grid");
    const template = document.getElementById("match-card-template");
    if (!grid || !template) return;
    grid.innerHTML = "";
    matches.forEach(m => {
      const clone = template.content.cloneNode(true);
      clone.querySelector('[data-col="meta"]').textContent = `GROUP ${m.group} · ${m.time}`;
      clone.querySelector('[data-col="team1-code"]').textContent = TEAM_CODES[m.team1] || m.team1.slice(0, 3).toUpperCase();
      clone.querySelector('[data-col="team1-name"]').textContent = m.team1;
      clone.querySelector('[data-col="score"]').textContent = `${m.goals1} - ${m.goals2}`;
      clone.querySelector('[data-col="team2-code"]').textContent = TEAM_CODES[m.team2] || m.team2.slice(0, 3).toUpperCase();
      clone.querySelector('[data-col="team2-name"]').textContent = m.team2;
      clone.querySelector('[data-col="details"]').textContent = `Cards: ${m.team1} ${m.red1}RC ${m.yellow1}YC · ${m.team2} ${m.red2}RC ${m.yellow2}YC`;
      grid.appendChild(clone);
    });
    setupCardEntrance(document);
  }

  function setupGroupViewer() {
    document.getElementById("group-filters")?.addEventListener("click", e => {
      const button = e.target.closest(".group-pill");
      if (!button) return;
      document.querySelectorAll(".group-pill").forEach(p => p.classList.toggle("active", p === button));
      document.querySelectorAll(".group-table").forEach(t => t.classList.toggle("active", t.id === `table-${button.dataset.target}`));
      const input = document.getElementById("team-search");
      if (input) input.value = "";
      document.querySelectorAll(".team-row").forEach(r => r.classList.remove("is-hidden"));
    });
  }

  function setupGroupSearch() {
    document.getElementById("team-search")?.addEventListener("input", e => {
      const query = e.target.value.trim().toLowerCase();
      document.querySelectorAll(".group-table.active .team-row").forEach(row => {
        row.classList.toggle("is-hidden", query && !(row.getAttribute("data-team") || "").toLowerCase().includes(query));
      });
    });
  }

  function setupCardEntrance(root) {
    root.querySelectorAll(".standings-card, .match-card").forEach((card, idx) => {
      card.style.setProperty("--stagger", `${Math.min(idx, 10) * 45}ms`);
      card.classList.add("entering");
    });
  }

  function updateNavIndicator(app) {
    const nav = app.querySelector(".page-nav"), active = app.querySelector(".page-nav .nav-link.active");
    if (!nav || !active) return;
    const navBox = nav.getBoundingClientRect(), activeBox = active.getBoundingClientRect();
    nav.style.setProperty("--nav-x", `${activeBox.left - navBox.left}px`);
    nav.style.setProperty("--nav-w", `${activeBox.width}px`);
  }

  function toNumber(val) { const n = Number(val); return Number.isFinite(n) ? n : 0; }
})();
