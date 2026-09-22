//   <script src="weather.js" defer></script>
//
// Renders the card into #weatherCard (both pages).
// Renders a 7-day list into #weekForecast, but only if that element
// exists on the page — so app.html just won't have one, no separate
// file or flag needed.

const WC_STORAGE_KEY = "wc-unit"; // "c" or "f"

// ---- WMO weather code -> { label, icon, accent } -----------------
// Open-Meteo returns WMO codes: https://open-meteo.com/en/docs
function codeInfo(code, isDay){
    const map = {
        0:  { label:"Clear sky",        icon: isDay?"sun":"moon",        accent:"#3f7fb3" },
        1:  { label:"Mostly clear",     icon: isDay?"sun-cloud":"moon-cloud", accent:"#3f7fb3" },
        2:  { label:"Partly cloudy",    icon: isDay?"sun-cloud":"moon-cloud", accent:"#4a7a94" },
        3:  { label:"Overcast",         icon:"cloud",                    accent:"#5b6a78" },
        45: { label:"Fog",              icon:"fog",                      accent:"#6b7580" },
        48: { label:"Icy fog",          icon:"fog",                      accent:"#6b7580" },
        51: { label:"Light drizzle",    icon:"drizzle",                  accent:"#4b7089" },
        53: { label:"Drizzle",          icon:"drizzle",                  accent:"#456a86" },
        55: { label:"Dense drizzle",    icon:"drizzle",                  accent:"#3f6480" },
        61: { label:"Light rain",       icon:"rain",                     accent:"#3f6480" },
        63: { label:"Rain",             icon:"rain",                     accent:"#375c78" },
        65: { label:"Heavy rain",       icon:"rain",                     accent:"#2f4f68" },
        71: { label:"Light snow",       icon:"snow",                     accent:"#6a7c96" },
        73: { label:"Snow",             icon:"snow",                     accent:"#62748e" },
        75: { label:"Heavy snow",       icon:"snow",                     accent:"#586a84" },
        80: { label:"Rain showers",     icon:"rain",                     accent:"#3a6280" },
        81: { label:"Rain showers",     icon:"rain",                     accent:"#345c7a" },
        82: { label:"Violent showers",  icon:"rain",                     accent:"#2c4f6b" },
        95: { label:"Thunderstorm",     icon:"storm",                    accent:"#3a3f60" },
        96: { label:"Thunderstorm",     icon:"storm",                    accent:"#343957" },
        99: { label:"Severe storm",     icon:"storm",                    accent:"#2e3350" },
    };
    return map[code] || { label:"Unsettled", icon:"cloud", accent:"#4a5a6b" };
}

// ---- condition icons (line-style, no external icon library) ------
function weatherIcon(kind){
    const s = 'stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"';
    const icons = {
        sun: `<svg viewBox="0 0 24 24" ${s}><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.4M12 19.6V22M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2 12h2.4M19.6 12H22M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7"/></svg>`,
        moon: `<svg viewBox="0 0 24 24" ${s}><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5Z"/></svg>`,
        "sun-cloud": `<svg viewBox="0 0 24 24" ${s}><circle cx="8.5" cy="8.5" r="3.3"/><path d="M8.5 2.6v1.6M8.5 12.8v1.4M3.2 8.5h1.4M12.4 8.5h1.3M4.7 4.7l1 1M11 11l1 1M12.3 4.7l-1 1M5.7 11l-1 1"/><path d="M9 20.5h8a3.5 3.5 0 0 0 .6-6.95A5 5 0 0 0 8 15.2a3 3 0 0 0 1 5.3Z"/></svg>`,
        "moon-cloud": `<svg viewBox="0 0 24 24" ${s}><path d="M16 9.3a4.5 4.5 0 1 1-4.9-4.5 3.6 3.6 0 0 0 4.9 4.5Z"/><path d="M9 20.5h8a3.5 3.5 0 0 0 .6-6.95A5 5 0 0 0 8 15.2a3 3 0 0 0 1 5.3Z"/></svg>`,
        cloud: `<svg viewBox="0 0 24 24" ${s}><path d="M7 18.5h9.5a3.8 3.8 0 0 0 .7-7.55A5.6 5.6 0 0 0 6.7 12.7a3.4 3.4 0 0 0 .3 5.8Z"/></svg>`,
        fog: `<svg viewBox="0 0 24 24" ${s}><path d="M4 9.5h13M4 13h16M4 16.5h11M7 20h9"/></svg>`,
        drizzle: `<svg viewBox="0 0 24 24" ${s}><path d="M7 13.5h9.5a3.8 3.8 0 0 0 .5-7.5A5.6 5.6 0 0 0 6.7 8a3.4 3.4 0 0 0 .3 5.5Z"/><path d="M9 18v2.4M13 18v2.4M17 18v2.4"/></svg>`,
        rain: `<svg viewBox="0 0 24 24" ${s}><path d="M7 12.5h9.5a3.8 3.8 0 0 0 .5-7.5A5.6 5.6 0 0 0 6.7 7a3.4 3.4 0 0 0 .3 5.5Z"/><path d="M8 17l-1.4 3M13 17l-1.4 3M18 17l-1.4 3"/></svg>`,
        snow: `<svg viewBox="0 0 24 24" ${s}><path d="M7 12.5h9.5a3.8 3.8 0 0 0 .5-7.5A5.6 5.6 0 0 0 6.7 7a3.4 3.4 0 0 0 .3 5.5Z"/><path d="M9 17v4M7 18.3l4 1.4M13 17v4M11 18.3l4 1.4M17 17v4M15 18.3l4 1.4"/></svg>`,
        storm: `<svg viewBox="0 0 24 24" ${s}><path d="M7 11.5h9.5a3.8 3.8 0 0 0 .5-7.5A5.6 5.6 0 0 0 6.7 6a3.4 3.4 0 0 0 .3 5.5Z"/><path d="M13 15l-2.6 4h2.4L11 22"/></svg>`,
    };
    return icons[kind] || icons.cloud;
}

function humidityIcon(){
    return `<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3.4c3.1 4.1 6.2 7.6 6.2 11a6.2 6.2 0 1 1-12.4 0c0-3.4 3.1-6.9 6.2-11Z"/>
  </svg>`;
}

// ---- moon phase -------------------------------------------------------
// 0/1 = new moon, 0.25 = first quarter, 0.5 = full moon, 0.75 = last quarter.
function getMoonPhase(date){
    const synodicMonth = 29.530588853; // days
    const knownNewMoonUTC = Date.UTC(2000, 0, 6, 18, 14, 0);
    const diffDays = (date.getTime() - knownNewMoonUTC) / 86400000;
    let phase = (diffDays % synodicMonth) / synodicMonth;
    if (phase < 0) phase += 1;
    return phase;
}

function moonPhaseName(phase){
    if (phase < 0.03 || phase > 0.97) return "New Moon";
    if (phase < 0.22) return "Waxing Crescent";
    if (phase < 0.28) return "First Quarter";
    if (phase < 0.47) return "Waxing Gibbous";
    if (phase < 0.53) return "Full Moon";
    if (phase < 0.72) return "Waning Gibbous";
    if (phase < 0.78) return "Last Quarter";
    return "Waning Crescent";
}

function moonPhaseIcon(phase){
    const r = 9, cx = 12, cy = 12;
    const angle = phase * 2 * Math.PI;
    const rx = Math.abs(Math.cos(angle)) * r;
    const sweepOuter = phase < 0.5 ? 1 : 0;
    const sweepInner = (phase < 0.25 || phase > 0.75) ? sweepOuter : 1 - sweepOuter;
    const lit = `M ${cx},${cy - r} A ${r},${r} 0 0 ${sweepOuter} ${cx},${cy + r} `
        + `A ${rx},${r} 0 0 ${sweepInner} ${cx},${cy - r} Z`;
    return `<svg viewBox="0 0 24 24">
    <circle cx="${cx}" cy="${cy}" r="${r}" stroke="currentColor" stroke-width="1.3" fill="none"/>
    <path d="${lit}" fill="currentColor"/>
  </svg>`;
}

// ---- temperature helpers -----------------------------------------
function cToF(c){ return c * 9 / 5 + 32; }
function fmtTemp(c, unit){
    return Math.round(unit === "f" ? cToF(c) : c);
}

// ---- location (Supabase, authenticated users only) -----------------
async function fetchLocation(){
    const { data, error } = await window.supabaseClient
        .from('weather_location')
        .select('lat, lon, label')
        .single();
    if (error) throw error;
    return data; // { lat, lon, label }
}

// ---- forecast fetch -------------------------------------------------
async function fetchForecastData(lat, lon){
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&current=temperature_2m,weather_code,is_day,relative_humidity_2m` +
        `&hourly=temperature_2m,weather_code,is_day` +
        `&daily=temperature_2m_max,temperature_2m_min,weather_code` +
        `&temperature_unit=celsius&timezone=auto&forecast_days=7`;

    const res = await fetch(url);
    if (!res.ok) throw new Error("Weather request failed");
    return res.json();
}

// ==== CARD (#weatherCard — present on both app.html and weather.html) ====

let wcUnit = localStorage.getItem(WC_STORAGE_KEY) || "f";
let wcLastRaw = null;

function renderWeatherCard(raw, place){
    wcLastRaw = raw;
    const root = document.getElementById("weatherCard");
    const { current, daily } = raw;
    const info = codeInfo(current.weather_code, current.is_day);
    const moonPhase = getMoonPhase(new Date());

    const nowTime = new Date(raw.current.time).getTime();
    const nowIdx = raw.hourly.time.findIndex(t => new Date(t).getTime() >= nowTime);
    const startIdx = nowIdx === -1 ? 0 : nowIdx;
    const hourly = [1, 2, 3, 4].map(offset => {
        const idx = Math.min(startIdx + offset, raw.hourly.time.length - 1);
        const dt = new Date(raw.hourly.time[idx]);
        return {
            label: dt.toLocaleTimeString([], { hour: 'numeric' }).replace(' ', ''),
            temp: raw.hourly.temperature_2m[idx],
            code: raw.hourly.weather_code[idx],
            isDay: raw.hourly.is_day[idx],
        };
    });

    root.style.setProperty("--accent", info.accent);
    root.innerHTML = `
    <div class="wc-temp-row">
      <div class="wc-temp">${fmtTemp(current.temperature_2m, wcUnit)}°</div>
      <div class="wc-unit" id="wcUnitToggle" title="Toggle °C/°F">${wcUnit === "f" ? "F" : "C"}</div>
    </div>
    <div class="wc-condition">${info.label}</div>
    <div class="wc-hilo">H:${fmtTemp(daily.temperature_2m_max[0], wcUnit)}°  L:${fmtTemp(daily.temperature_2m_min[0], wcUnit)}°</div>

    <div class="wc-meta">
      <div class="wc-meta-item">${humidityIcon()}<span>${Math.round(current.relative_humidity_2m)}%</span></div>
      <div class="wc-meta-item">${moonPhaseIcon(moonPhase)}<span>${moonPhaseName(moonPhase)}</span></div>
    </div>

    <div class="wc-strip">
      ${hourly.map(h => {
        const hi = codeInfo(h.code, h.isDay);
        return `<div class="wc-hour">
          <span>${h.label}</span>
          ${weatherIcon(hi.icon)}
          <b>${fmtTemp(h.temp, wcUnit)}°</b>
        </div>`;
    }).join("")}
    </div>

    <div class="wc-strip">
     <span class="wc-updated">Updated ${new Date().toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})}</span>
    </div>
  `;

    document.getElementById("wcUnitToggle").addEventListener("click", () => {
        wcUnit = wcUnit === "f" ? "c" : "f";
        localStorage.setItem(WC_STORAGE_KEY, wcUnit);
        renderWeatherCard(wcLastRaw, place);
        renderWeekForecast(wcLastRaw); // no-op if #weekForecast isn't on this page
    });
}

function showWeatherCardState(msg, isError, showRetry){
    const root = document.getElementById("weatherCard");
    root.style.removeProperty("--accent");
    const container = document.getElementById("weekForecast");
    if (container) container.style.removeProperty("--accent");
    root.innerHTML = `<div class="wc-state${isError ? ' error':''}">${msg}${
        showRetry ? '<div><button class="wc-retry" id="wcRetry">Try again</button></div>' : ''
    }</div>`;
    if (showRetry) document.getElementById("wcRetry").addEventListener("click", initWeather);
}

// ==== 7-DAY LIST (#weekForecast — only present on weather.html) ====

function renderWeekForecast(raw){
    const container = document.getElementById("weekForecast");
    if (!container) return; // e.g. app.html has no week list — nothing to do

    const currentInfo = codeInfo(raw.current.weather_code, raw.current.is_day);
    container.style.setProperty("--accent", currentInfo.accent);

    container.innerHTML = raw.daily.time.map((t, i) => {
        const date = new Date(t);
        const info = codeInfo(raw.daily.weather_code[i], true);
        const moon = getMoonPhase(date);
        const dayLabel = i === 0 ? "Today" : date.toLocaleDateString([], { weekday: "short" });
        return `
      <div class="wf-row">
        <span class="wf-day">${dayLabel}</span>
        <span class="wf-icon">${weatherIcon(info.icon)}</span>
        <span class="wf-condition">${info.label}</span>
        <span class="wf-moon" title="${moonPhaseName(moon)}">${moonPhaseIcon(moon)}</span>
        <span class="wf-temps">
          <b>${fmtTemp(raw.daily.temperature_2m_max[i], wcUnit)}°</b>
          <span class="wf-lo">${fmtTemp(raw.daily.temperature_2m_min[i], wcUnit)}°</span>
        </span>
      </div>`;
    }).join("");
}

// ==== INIT (runs on both pages) ====

async function initWeather(){
    showWeatherCardState("Loading forecast…");
    try{
        const location = await fetchLocation();
        const raw = await fetchForecastData(location.lat, location.lon);
        renderWeatherCard(raw, location.label);
        renderWeekForecast(raw); // no-op on pages without #weekForecast
    } catch(err){
        showWeatherCardState("Couldn't load weather.", true, true);
    }
}

if (window.initAppPage) {
    window.initAppPage(initWeather);
} else {
    document.addEventListener("app:ready", initWeather, { once: true });
}

// ---- Seasonal background ------------------------------------------
(function initSeasonalBackground() {
    if (!document.body.classList.contains('cal-page')) return;

    function getSeason(date) {
        const m = date.getMonth() + 1; // 1-12
        const d = date.getDate();
        if ((m === 3 && d >= 20) || m === 4 || m === 5 || (m === 6 && d < 21)) return 'spring';
        if ((m === 6 && d >= 21) || m === 7 || m === 8 || (m === 9 && d < 22)) return 'summer';
        if ((m === 9 && d >= 22) || m === 10 || m === 11 || (m === 12 && d < 21)) return 'fall';
        return 'winter';
    }

    const seasonImages = {
        spring: 'spring.jpg',
        summer: 'summer.jpg',
        fall: 'fall.jpg',
        winter: 'winter.jpg'
    };

    const season = getSeason(new Date());
    const el = document.body;
    el.dataset.season = season;

    const img = new Image();
    img.onload = () => {
        el.style.setProperty('--season-img', `url(${seasonImages[season]})`);
        el.classList.add('img-loaded');
    };
    img.src = seasonImages[season];
})();
