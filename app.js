(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const money = (n) => (n == null || n === "" ? null : "$" + Number(n).toLocaleString("en-US"));
  const NL = '<span class="nl">not listed</span>';
  const COLORS = { "6plus": "#6a3d9a", "5": "#1f6f6a", "4den": "#d4a017" };
  const BCLASS = { "6plus": "b6", "5": "b5", "4den": "b4" };
  const FIT = { ideal: "Move-in fits (~Dec 1)", early: "Available early (overlap)", late: "Available after mid-Dec", unknown: "Move-in date not listed" };
  const UTIL_ORDER = ["water", "sewer", "trash", "gas", "electric", "internet", "landscaping", "hoa"];

  let DATA = null, ALL = [], map, layer, markers = {};

  function loadJSON(url, fallback) {
    return fetch(url, { cache: "no-store" }).then((r) => { if (!r.ok) throw 0; return r.json(); }).catch(() => fallback);
  }

  function availDate(l) {
    if (!l.availableIso) return null;
    return l.availableIso === "now" ? DATA.asOf : (l.availableIso < DATA.asOf ? DATA.asOf : l.availableIso);
  }

  function radius(rent) {
    if (!rent) return 6;
    const t = Math.max(0, Math.min(1, (rent - 2000) / 2500));
    return 7 + t * 13;
  }

  // ---------------- summary
  function renderSummary() {
    const act = ALL.filter((l) => l.status === "active");
    const today = (DATA.asOf || "");
    const newToday = act.filter((l) => l.firstSeen === today).length;
    const gone = ALL.filter((l) => l.status === "gone").length;
    const five = act.filter((l) => l.bedCategory !== "4den").length;
    const near = act.filter((l) => l.driveMin != null && l.driveMin <= DATA.drivePreferred).length;
    const ideal = act.filter((l) => l.availFit === "ideal").length;
    const under = act.filter((l) => l.rent && l.rent <= DATA.budgetRef).length;
    const stats = [
      [act.length, `active matches (${five} with 5+ BR, ${act.length - five} 4 + den)`],
      [near, `within ${DATA.drivePreferred} min drive of ERAU (est.)`],
      [ideal, "list a move-in date in the Dec 1 – mid-Dec window"],
      [under, `asking ≤ ${money(DATA.budgetRef)}/mo (reference only)`],
      [newToday, `new on ${today}`],
      [gone, "gone (kept below, flagged)"],
    ];
    $("#summary").innerHTML = stats.map(([b, s]) => `<div class="stat"><b>${b}</b><span>${esc(s)}</span></div>`).join("");
    $("#as-of").innerHTML = `Data as of <strong>${esc(DATA.asOf)}</strong> (refreshed ${esc(DATA.generatedAt || "")}). ` +
      `Sources read: ${DATA.sources.filter((s) => s.ok).map((s) => esc(s.source)).join(", ")}.`;
  }

  // ---------------- daily updates (blog)
  function li(it) {
    return it.href ? `<li><a href="${esc(it.href)}" target="_blank" rel="noopener">${esc(it.text)}</a></li>` : `<li>${esc(it.text)}</li>`;
  }
  function renderLog(entries) {
    const root = $("#log-feed");
    if (!entries || !entries.length) { root.innerHTML = "<p class='lede'>No posts yet.</p>"; return; }
    root.innerHTML = entries.slice().sort((a, b) => (b.date || "").localeCompare(a.date || "")).map((e) => {
      const d = new Date(e.date + "T12:00:00");
      const pretty = isNaN(d) ? e.date : d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
      const sec = (h, arr) => (arr && arr.length ? `<h4>${h}</h4><ul>${arr.map(li).join("")}</ul>` : "");
      return `<article class="log-entry">
        <time datetime="${esc(e.date)}">${esc(pretty)}</time>
        <h3>${esc(e.title)}</h3>
        ${e.lede ? `<p class="lede">${esc(e.lede)}</p>` : ""}
        ${sec("Best fits right now", e.top)}
        ${sec("New houses that fit", e.new)}
        ${sec("Price changes", e.changed)}
        ${sec("Gone", e.gone)}
        ${e.market ? `<p class="market"><strong>Market note.</strong> ${esc(e.market)}</p>` : ""}
      </article>`;
    }).join("");
  }

  // ---------------- cards
  function utilHtml(u) {
    if (!u) return NL;
    const anyKnown = UTIL_ORDER.some((k) => u[k]);
    const chips = UTIL_ORDER.map((k) => {
      const v = u[k];
      const lbl = v === "included" ? "included" : v === "tenant" ? "tenant pays" : "not listed";
      return `<span class="u ${v || ""}" title="${k}: ${lbl}">${k}${v === "included" ? " ✓" : v === "tenant" ? " $" : " ?"}</span>`;
    }).join("");
    return `<div class="utils">${chips}</div>${anyKnown ? "" : '<div class="meta">Listing does not say which utilities are included.</div>'}`;
  }

  function priceChanges(l) {
    const out = [];
    (l.priceHistory || []).forEach((p) => out.push(`${p.date}: ${money(p.from)} → ${money(p.to)} (seen by tracker)`));
    (l.sourcePriceHistory || []).filter((p) => /price change/i.test(p.event || "")).forEach((p) => out.push(`${p.date}: ${money(p.price)} (${esc(p.event)}, Zillow)`));
    return out.length ? out.join("<br>") : "none seen";
  }

  function cardHtml(l) {
    const cat = l.bedCategory;
    const gone = l.status === "gone";
    const drive = l.driveMin != null ? `${Math.round(l.driveMin)} min · ${l.driveMi} mi` : null;
    const far = l.driveMin != null && l.driveMin > DATA.drivePreferred;
    const badges = [
      `<span class="badge ${BCLASS[cat]}">${esc(l.bedsLabel)}</span>`,
      gone ? `<span class="badge gone">Gone ${esc(l.goneDate || "")}</span>` : "",
      !gone && l.firstSeen === DATA.asOf ? '<span class="badge new">New</span>' : "",
      `<span class="badge fit-${l.availFit}">${FIT[l.availFit]}</span>`,
      drive ? `<span class="badge ${far ? "far" : ""}">${far ? "Far · " : ""}${drive} (est.)</span>` : '<span class="badge warn">drive n/a</span>',
      l.vacation ? '<span class="badge warn">Vacation / short-term listing</span>' : "",
      (l.studentFlagsSerious || []).length ? '<span class="badge warn">Occupancy limit?</span>' : "",
      l.studentPositive ? '<span class="badge fit-ideal">Students/roommates mentioned OK</span>' : "",
      l.unverified ? '<span class="badge warn">Not re-checked today</span>' : "",
    ].join("");
    const deposit = l.deposit != null ? money(l.deposit) + (l.deposit === 0 ? " (listed as $0)" : "") : l.depositText ? esc(l.depositText) + (l.rent ? ` (≈ ${money(l.rent)})` : "") : NL;
    const contact = [l.manager, l.contact && l.contact !== l.manager ? l.contact : null, l.contactPhone].filter(Boolean).map(esc).join(" · ") || NL;
    const student = [
      l.studentRefusal ? `<span class="bad">Refuses students: "${esc(l.studentRefusal)}"</span>` : "",
      (l.studentFlags || []).length ? "Listing mentions: " + l.studentFlags.map((f) => `"${esc(f)}"`).join("; ") : "",
      l.studentPositive ? `Mentions: "${esc(l.studentPositive)}"` : "",
    ].filter(Boolean).join("<br>") || "No student/roommate policy in listing — ask";
    const den = cat === "4den" ? `4 + den (per listing): <span class="quote">“…${esc(l.denSnippet)}…”</span>` : l.denSnippet ? `<span class="quote">“…${esc(l.denSnippet)}…”</span>` : "—";
    const dom = l.daysOnMarket != null ? `${l.daysOnMarket} days <span class="meta">(${esc(l.domBasis)})</span>` : NL;
    const avail = l.availableRaw ? `${esc(l.availableRaw)}<br><span class="meta">${esc(l.availNote)}</span>` : NL;
    const notes = [];
    if (l.vacation) notes.push("Advertised as a vacation / short-term rental: confirm a Dec–May (or 12-month) lease and the real monthly price.");
    if (l.undisclosed) notes.push("Address not disclosed by the listing; map position and drive time unavailable or approximate.");
    if (l.coordSource === "craigslist") notes.push("Map pin from Craigslist (approximate).");
    if (l.rentNote) notes.push("Other sources: " + l.rentNote + ".");
    if (l.smoking) notes.push("No smoking.");
    notes.push(`First seen by tracker ${l.firstSeen}; last seen ${l.lastSeen || "—"}.`);
    const photo = l.photo ? `<img class="thumb" loading="lazy" src="${esc(l.photo)}" alt="Photo of ${esc(l.address)}" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=\\'thumb none\\'>photo unavailable</div>'">` : '<div class="thumb none">no photo URL in listing</div>';
    const links = (l.sources || []).map((s, i) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${i === 0 ? "Listing on " : ""}${esc(s.name)}</a>`).join(" · ");
    return `<article class="card ${gone ? "is-gone" : ""}" id="card-${esc(l.id)}" data-id="${esc(l.id)}">
      ${photo}
      <header>
        <h3><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.address)}</a><small>${esc(l.city)}, AZ</small></h3>
        <div class="price">${money(l.rent) || "Rent n/a"}<small>/month</small></div>
      </header>
      <div class="badges">${badges}</div>
      <dl class="facts">
        <dt>Beds / baths</dt><dd>${l.beds || "?"} bd / ${l.baths || "?"} ba</dd>
        <dt>Size / lot</dt><dd>${l.sqft ? Number(l.sqft).toLocaleString() + " sq ft" : "sq ft " + NL} · ${l.lot ? esc(l.lot) : "lot " + NL}</dd>
        <dt>Den / office</dt><dd>${den}</dd>
        <dt>Available</dt><dd>${avail}</dd>
        <dt>Drive to ERAU</dt><dd>${drive ? `${drive} <span class="meta">(estimated, OSRM, no traffic)</span>` : NL}</dd>
        <dt>Deposit</dt><dd>${deposit}</dd>
        <dt>Fees</dt><dd>${(l.fees || []).length ? l.fees.map(esc).join(", ") : NL}</dd>
        <dt>Utilities</dt><dd>${utilHtml(l.utilities)}${l.utilitiesText ? `<div class="meta quote">“${esc(l.utilitiesText)}”</div>` : ""}</dd>
        <dt>Parking</dt><dd>${l.parking ? esc(l.parking) : NL}</dd>
        <dt>Pets</dt><dd>${l.pets ? esc(l.pets) : NL}</dd>
        <dt>Furnished</dt><dd>${l.furnished ? esc(l.furnished) : NL}</dd>
        <dt>Lease</dt><dd>${l.lease ? esc(String(l.lease).replace(/^leaseTerm:\s*/i, "")) : NL}</dd>
        <dt>On market</dt><dd>${dom}</dd>
        <dt>Price changes</dt><dd>${priceChanges(l)}</dd>
        <dt>Students</dt><dd>${student}</dd>
        <dt>Contact</dt><dd>${contact}</dd>
      </dl>
      <p class="notes">${notes.map(esc).join(" ")}</p>
      <div class="links"><button type="button" data-fly="${esc(l.id)}">Show on map</button>${links}</div>
    </article>`;
  }

  function filtered() {
    const beds = $("#f-beds").value, maxRent = Number($("#f-rent").value) || null, maxDrive = Number($("#f-drive").value) || null;
    const by = $("#f-avail").value, hideGone = $("#f-gone").checked, hideVac = $("#f-vac").checked;
    const q = $("#q").value.trim().toLowerCase();
    let list = ALL.filter((l) => {
      if (hideGone && l.status === "gone") return false;
      if (hideVac && l.vacation) return false;
      if (beds === "5plus" && l.bedCategory === "4den") return false;
      if (beds === "6plus" && l.bedCategory !== "6plus") return false;
      if (beds === "4den" && l.bedCategory !== "4den") return false;
      if (maxRent && (!l.rent || l.rent > maxRent)) return false;
      if (maxDrive && (l.driveMin == null || l.driveMin > maxDrive)) return false;
      if (by) { const a = availDate(l); if (!a || a > by) return false; }
      if (q) {
        const blob = [l.address, l.city, l.manager, l.contact, l.descExcerpt, l.denSnippet, l.pets, l.parking].join(" ").toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
    const s = $("#f-sort").value;
    const num = (v, d) => (v == null ? d : v);
    const cmp = {
      score: (a, b) => (a.status === "gone") - (b.status === "gone") || b.score - a.score,
      rent: (a, b) => num(a.rent, 1e9) - num(b.rent, 1e9),
      "rent-desc": (a, b) => num(b.rent, -1) - num(a.rent, -1),
      drive: (a, b) => num(a.driveMin, 1e9) - num(b.driveMin, 1e9),
      avail: (a, b) => (availDate(a) || "9999").localeCompare(availDate(b) || "9999"),
      beds: (a, b) => (b.beds || 0) - (a.beds || 0) || b.score - a.score,
      new: (a, b) => (b.firstSeen || "").localeCompare(a.firstSeen || "") || b.score - a.score,
    }[s];
    return list.sort(cmp);
  }

  function apply() {
    const list = filtered();
    $("#count").textContent = `${list.length} shown of ${ALL.length} tracked.`;
    $("#cards").innerHTML = list.map(cardHtml).join("") || "<p class='lede'>Nothing matches these filters.</p>";
    paint(list);
  }

  // ---------------- map
  function initMap() {
    map = L.map("map", { scrollWheelZoom: true }).setView([DATA.target.lat, DATA.target.lng], 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    layer = L.layerGroup().addTo(map);
    L.marker([DATA.target.lat, DATA.target.lng], {
      icon: L.divIcon({ className: "erau-pin", html: "ERAU", iconSize: [30, 30] }), zIndexOffset: 1000,
    }).bindPopup(`<strong>${esc(DATA.target.name)}</strong><br>${esc(DATA.target.address)}`).addTo(map);
    setTimeout(() => map.invalidateSize(), 200);
  }

  function paint(list) {
    layer.clearLayers(); markers = {};
    const pts = [[DATA.target.lat, DATA.target.lng]];
    list.forEach((l) => {
      if (l.lat == null || l.lng == null) return;
      const gone = l.status === "gone";
      const m = L.circleMarker([l.lat, l.lng], {
        radius: radius(l.rent), color: gone ? "#9a9a9a" : "#fff", weight: gone ? 2 : 1.5,
        fillColor: gone ? "#fff" : COLORS[l.bedCategory], fillOpacity: gone ? 0.6 : (l.rent ? 0.85 : 0.35),
      }).bindPopup(`<strong>${esc(l.address)}</strong>, ${esc(l.city)}<br>${esc(l.bedsLabel)} · ${money(l.rent) || "rent n/a"}<br>` +
        `${l.driveMin != null ? Math.round(l.driveMin) + " min est. drive" : ""}${gone ? "<br><em>gone</em>" : ""}`);
      m.on("click", () => highlight(l.id, true));
      m.addTo(layer); markers[l.id] = m; pts.push([l.lat, l.lng]);
    });
    if (pts.length > 1) {
      map.fitBounds(pts, { padding: [30, 30], maxZoom: 13 });
      setTimeout(() => { map.invalidateSize(); map.fitBounds(pts, { padding: [30, 30], maxZoom: 13 }); }, 300);
    }
  }

  function highlight(id, scroll) {
    document.querySelectorAll(".card.is-hl").forEach((c) => c.classList.remove("is-hl"));
    const el = document.getElementById("card-" + id);
    if (el) { el.classList.add("is-hl"); if (scroll) el.scrollIntoView({ behavior: "smooth", block: "start" }); }
  }

  function flyTo(id) {
    const l = ALL.find((x) => x.id === id);
    if (!l || l.lat == null) return;
    map.flyTo([l.lat, l.lng], 14, { duration: 0.8 });
    if (markers[id]) markers[id].openPopup();
    highlight(id, false);
    $("#map").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // ---------------- sources + excluded
  function renderSources() {
    $("#src-ok").innerHTML = "<tr><th>Source</th><th>Status</th><th>Candidates</th><th>Matches</th></tr>" +
      DATA.sources.map((s) => `<tr><td>${esc(s.source)}</td><td class="${s.ok ? "ok" : "bad"}">${s.ok ? "OK" : "failed"} <span class="meta">(${esc(s.http.join(","))})</span></td><td>${s.candidates}</td><td>${s.matches}</td></tr>`).join("");
    $("#src-blocked").innerHTML = "<tr><th>Source</th><th>HTTP</th><th>Result</th></tr>" +
      (DATA.blocked || []).map((b) => `<tr><td><a href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.source)}</a></td><td>${esc(b.http)}</td><td>${esc(b.verdict)}</td></tr>`).join("") +
      "<tr><td>Facebook Marketplace</td><td>—</td><td>skipped (login wall)</td></tr>";
    const ex = DATA.excluded || [];
    $("#excl-count").textContent = `(${ex.length})`;
    $("#excl").innerHTML = "<tr><th>Address</th><th>BR</th><th>Rent</th><th>Why excluded</th></tr>" +
      ex.map((e) => `<tr><td><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.address)}</a>, ${esc(e.city)}</td><td>${esc(e.beds ?? "?")}</td><td>${money(e.rent) || "—"}</td><td>${esc(e.reason)}</td></tr>`).join("");
  }

  Promise.all([loadJSON("listings.json", window.LISTINGS_DATA), loadJSON("updates.json", window.UPDATES_DATA || { entries: [] })]).then(([data, upd]) => {
    DATA = data || { listings: [], sources: [], target: { lat: 34.6162, lng: -112.4488 } };
    ALL = DATA.listings || [];
    renderSummary();
    renderLog((upd && upd.entries) || []);
    renderSources();
    initMap();
    apply();
    ["#f-beds", "#f-drive", "#f-sort", "#f-gone", "#f-vac", "#f-avail"].forEach((s) => $(s).addEventListener("change", apply));
    ["#f-rent", "#q"].forEach((s) => $(s).addEventListener("input", apply));
    $("#cards").addEventListener("click", (e) => { const b = e.target.closest("[data-fly]"); if (b) flyTo(b.dataset.fly); });
  });
})();
