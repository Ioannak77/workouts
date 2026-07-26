const $ = (id) => document.getElementById(id);

/* ---------- Local Storage Compatibility Layer ---------- */
window.storage = {
  async get(key) {
    const value = localStorage.getItem(key);
    if (value === null) return null;
    return { value };
  },
  async set(key, value) {
    localStorage.setItem(key, value);
    return true;
  },
  async remove(key) {
    localStorage.removeItem(key);
    return true;
  },
  async list(prefix = "") {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!prefix || key.startsWith(prefix)) keys.push(key);
    }
    return { keys };
  }
};

let todayKey = "";
let exerciseNames = new Set();
let currentCheckinWeek = null;
let profileView = 'hub';
let userUnits = 'kg';
let userRestSeconds = 30;
let userTimerAlert = 'sound';
let workoutSessionExerciseList = [];
let loggingScreenExercise = null;
let loggingScreenSetIndex = 1;
let loggingScreenReps = 12;
let loggingScreenWeight = 0;
let selectedMood = null;
let wssTimerInterval = null;

/* ---------- data loaded from data/exercises.json ---------- */
let EQUIPMENT_OPTIONS = [];
let REST_TIMER_OPTIONS = [30, 45, 60, 90, 120, 150, 180, 210, 240, 270, 300];
let TIMER_ALERT_OPTIONS = [];
let MUSCLE_GROUP_OPTIONS = [];
let IMAGE_FOLDERS = {};
let EXERCISE_LIBRARY = {};
let WORKOUTS = {};
let WARMUP_VARIANTS = {};
const EXERCISE_IMAGE_BASE = 'exercise-images/';

async function loadExerciseData(){
  try{
    const res = await fetch('data/exercises.json?v=2', { cache: 'no-store' });
    const data = await res.json();
    EQUIPMENT_OPTIONS = data.equipmentOptions || [];
    REST_TIMER_OPTIONS = data.restTimerOptions || [30,45,60,90,120];
    TIMER_ALERT_OPTIONS = data.timerAlertOptions || [];
    MUSCLE_GROUP_OPTIONS = data.muscleGroupOptions || [];
    IMAGE_FOLDERS = data.imageFolders || {};
    EXERCISE_LIBRARY = data.exerciseLibrary || {};
    WORKOUTS = data.workouts || {};
    WARMUP_VARIANTS = data.warmupVariants || {};
  }catch(e){
    console.error("Could not load data/exercises.json — make sure this app is served over http(s), not opened as a local file", e);
    showToast("Couldn't load exercise data");
  }
}

const PLAN_ORDER = ['warmup','lower','upper','full'];
const editingGroups = new Set();

/* ---------- exercise icons ---------- */
const GENERIC_ICON = `<svg viewBox="0 0 24 24" fill="none"><rect x="1.5" y="9" width="3" height="6" rx="1" fill="var(--moss)"/><rect x="19.5" y="9" width="3" height="6" rx="1" fill="var(--moss)"/><rect x="4.5" y="10.5" width="3" height="3" fill="var(--moss)"/><rect x="16.5" y="10.5" width="3" height="3" fill="var(--moss)"/><rect x="7.5" y="11" width="9" height="2" fill="var(--moss)"/></svg>`;

function findExerciseImage(name){
  for(const libKey of Object.keys(EXERCISE_LIBRARY)){
    const found = EXERCISE_LIBRARY[libKey].find(e=>e.name === name);
    if(found) return { img: found.img, libKey };
  }
  return null;
}

function normalizeChecklistItem(item){
  if(typeof item === 'string') return { name: item, detail: '' };
  return { name: item.name, detail: item.detail || '' };
}
function getWarmupExercises(profile){
  const loc = profile && profile.location;
  if(loc && WARMUP_VARIANTS[loc]) return WARMUP_VARIANTS[loc];
  return WARMUP_VARIANTS.gym || (WORKOUTS.warmup && WORKOUTS.warmup.exercises) || [];
}

function findExerciseData(name){
  for(const libKey of Object.keys(EXERCISE_LIBRARY)){
    const found = EXERCISE_LIBRARY[libKey].find(e=>e.name === name);
    if(found) return found;
  }
  return null;
}

function getExerciseRestSeconds(name){
  const data = findExerciseData(name);
  return (data && data.rest) ? data.rest : userRestSeconds;
}

function getIcon(name){
  const found = findExerciseImage(name);
  if(!found) return null;
  const folder = IMAGE_FOLDERS[found.libKey] || found.libKey;
  const src = `${EXERCISE_IMAGE_BASE}${folder}/${found.img}`;
  return `<img src="${src}" alt="${escapeHTML(name)}" style="width:100%;height:100%;object-fit:contain;">`;
}

async function getCustomWorkouts(){
  try{
    const res = await window.storage.get('custom-workouts');
    return res && res.value ? JSON.parse(res.value) : [];
  }catch(e){ return []; }
}
async function saveCustomWorkouts(list){
  try{ await window.storage.set('custom-workouts', JSON.stringify(list)); }
  catch(e){ console.error("Could not save custom workouts list", e); showToast("Couldn't save"); }
}
async function addCustomWorkout(label){
  const list = await getCustomWorkouts();
  const key = `custom-${Date.now()}`;
  list.push({ key, label });
  await saveCustomWorkouts(list);
  return key;
}

async function renameCustomWorkout(key, newLabel){
  const list = await getCustomWorkouts();
  const found = list.find(w=>w.key === key);
  if(found){
    found.label = newLabel;
    await saveCustomWorkouts(list);
  }
}

async function getHiddenWorkouts(){
  try{
    const res = await window.storage.get('hidden-workouts');
    return res && res.value ? JSON.parse(res.value) : [];
  }catch(e){ return []; }
}
async function saveHiddenWorkouts(list){
  try{ await window.storage.set('hidden-workouts', JSON.stringify(list)); }
  catch(e){ console.error("Could not save hidden workouts list", e); showToast("Couldn't save"); }
}
async function getPlanDef(key){
  if(WORKOUTS[key]) return WORKOUTS[key];
  const list = await getCustomWorkouts();
  const found = list.find(w=>w.key === key);
  return found ? { key, label: found.label, type:'strength', focus:'Custom workout' } : null;
}
async function getAllPlanDefs(){
  const hidden = await getHiddenWorkouts();
  const fixed = PLAN_ORDER.filter(k=>!hidden.includes(k)).map(k=>WORKOUTS[k]).filter(Boolean);
  const customList = await getCustomWorkouts();
  const custom = customList.map(c=>({ key:c.key, label:c.label, type:'strength', focus:'Custom workout' }));
  return [...fixed, ...custom];
}
async function deleteWorkout(key){
  if(WORKOUTS[key]){
    const hidden = await getHiddenWorkouts();
    if(!hidden.includes(key)){
      hidden.push(key);
      await saveHiddenWorkouts(hidden);
    }
  } else {
    const list = await getCustomWorkouts();
    await saveCustomWorkouts(list.filter(w=>w.key !== key));
    try{ await window.storage.remove(`workout-template:${key}`); }catch(e){ /* nothing to delete, fine */ }
  }
  editingGroups.delete(key);
  await updateSession(todayKey, (s)=>{ s.plan = s.plan.filter(p=>p !== key); });
  showToast("Workout deleted");
  await renderAll();
}

async function getWorkoutTemplate(key){
  try{
    const res = await window.storage.get(`workout-template:${key}`);
    if(res && res.value){
      const parsed = JSON.parse(res.value);
      if(Array.isArray(parsed) && parsed.length) return parsed;
    }
  }catch(e){ /* fall through to default */ }
  return (WORKOUTS[key] && WORKOUTS[key].exercises) ? WORKOUTS[key].exercises.map(e=>({...e})) : [];
}
async function saveWorkoutTemplate(key, exercises){
  try{
    const result = await window.storage.set(`workout-template:${key}`, JSON.stringify(exercises));
    if(!result) throw new Error("no result");
  }catch(e){ console.error("Could not save workout template", e); showToast("Couldn't save changes"); }
}

function pad(n){ return n.toString().padStart(2,"0"); }
function dateKey(d){ return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function prettyDate(key){
  const [y,m,d] = key.split("-").map(Number);
  const dt = new Date(y, m-1, d);
  return dt.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
}
function showToast(msg){
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(()=>t.classList.remove("show"), 1400);
}
function escapeHTML(str){
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* ---------- fuzzy matching for exercise search ---------- */
function levenshtein(a, b){
  const m = a.length, n = b.length;
  const dp = Array.from({length:m+1}, ()=> new Array(n+1).fill(0));
  for(let i=0;i<=m;i++) dp[i][0] = i;
  for(let j=0;j<=n;j++) dp[0][j] = j;
  for(let i=1;i<=m;i++){
    for(let j=1;j<=n;j++){
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}
function fuzzyScore(query, target){
  query = String(query).trim().toLowerCase();
  const t = String(target).toLowerCase();
  if(!query) return 0;
  if(t === query) return 100;
  if(t.startsWith(query)) return 90;
  if(t.includes(query)) return 75;

  const words = t.split(/\s+/);
  let best = 0;
  words.forEach(w=>{
    if(w.startsWith(query)) best = Math.max(best, 65);
    else if(w.includes(query)) best = Math.max(best, 55);
  });
  if(best) return best;

  let qi = 0;
  for(let i=0; i<t.length && qi<query.length; i++){
    if(t[i] === query[qi]) qi++;
  }
  if(qi === query.length) return 40;

  const maxDist = Math.max(1, Math.floor(query.length * 0.34));
  let minDist = Infinity;
  words.forEach(w=>{ minDist = Math.min(minDist, levenshtein(query, w)); });
  if(minDist <= maxDist) return 30 - minDist;

  return -1;
}

function tallySVG(count){
  const groups = Math.ceil(count/5) || 0;
  let svgGroups = "";
  let remaining = count;
  for(let g=0; g<groups; g++){
    const inGroup = Math.min(5, remaining);
    remaining -= inGroup;
    let marks = "";
    const strokeW = 2.5;
    for(let i=0;i<Math.min(inGroup,4);i++){
      const x = 3 + i*4;
      marks += `<line x1="${x}" y1="2" x2="${x}" y2="16" stroke="var(--moss)" stroke-width="${strokeW}" stroke-linecap="round"/>`;
    }
    if(inGroup === 5){
      marks += `<line x1="1" y1="15" x2="16" y2="3" stroke="var(--amber)" stroke-width="${strokeW}" stroke-linecap="round"/>`;
    }
    svgGroups += `<svg width="18" height="18" viewBox="0 0 18 18">${marks}</svg>`;
  }
  return svgGroups;
}

/* ---------- storage ---------- */
async function loadExerciseNames(){
  try{
    const res = await window.storage.get('exercise-names');
    if(res && res.value) exerciseNames = new Set(JSON.parse(res.value));
  }catch(e){ exerciseNames = new Set(); }
  const dl = $("exerciseOptions");
  dl.innerHTML = "";
  [...exerciseNames].sort().forEach(name=>{
    const opt = document.createElement("option");
    opt.value = name;
    dl.appendChild(opt);
  });
}
async function saveExerciseName(name){
  if(exerciseNames.has(name)) return;
  exerciseNames.add(name);
  try{ await window.storage.set('exercise-names', JSON.stringify([...exerciseNames])); }
  catch(e){ console.error("Could not save exercise name", e); }
  await loadExerciseNames();
}

function defaultSession(){ return { plan: [], checklist: [], sets: [], startedAt: null, finishedAt: null, newPRs: [], completed: [], mood: null }; }
async function getSession(key){
  try{
    const res = await window.storage.get(`session:${key}`);
    if(!res || !res.value) return defaultSession();
    const parsed = JSON.parse(res.value);
    if(Array.isArray(parsed)) return { ...defaultSession(), sets: parsed };
    return { ...defaultSession(), ...parsed };
  }catch(e){ return defaultSession(); }
}
async function saveSession(key, sessionObj){
  try{
    const result = await window.storage.set(`session:${key}`, JSON.stringify(sessionObj));
    if(!result) console.error("Save returned no result");
  }catch(e){ console.error("Storage error saving session", e); showToast("Couldn't save — try again"); }
}
async function updateSession(key, mutator){
  const s = await getSession(key);
  mutator(s);
  await saveSession(key, s);
  return s;
}
async function getAllSessionKeys(){
  try{ const res = await window.storage.list('session:'); return res && res.keys ? res.keys : []; }
  catch(e){ return []; }
}
async function getProgramStart(){
  try{ const res = await window.storage.get('program-start-date'); return res && res.value ? res.value : null; }
  catch(e){ return null; }
}
async function setProgramStart(dateStr){
  try{ await window.storage.set('program-start-date', dateStr); }
  catch(e){ console.error("Could not save program start", e); }
}
async function getWeekData(week){
  try{
    const res = await window.storage.get(`progress-photo:week-${week}`);
    if(!res || !res.value) return { photo:null, weight:null, bodyFat:null };
    if(res.value.startsWith('data:')) return { photo:res.value, weight:null, bodyFat:null };
    const parsed = JSON.parse(res.value);
    return { photo: parsed.photo || null, weight: parsed.weight ?? null, bodyFat: parsed.bodyFat ?? null };
  }catch(e){ return { photo:null, weight:null, bodyFat:null }; }
}
async function saveWeekData(week, data){
  try{
    const result = await window.storage.set(`progress-photo:week-${week}`, JSON.stringify(data));
    if(!result) throw new Error("no result");
  }catch(e){ console.error("Could not save week data", e); showToast("Couldn't save — try again"); }
}

/* ---------- profile ---------- */
const KG_TO_LBS = 2.20462;
function kgToDisplay(kg, units){ return units === 'lbs' ? Math.round(kg * KG_TO_LBS * 10) / 10 : kg; }
function displayToKg(val, units){ const num = Number(val) || 0; return units === 'lbs' ? num / KG_TO_LBS : num; }
function toDisplayWeight(kg){ return kgToDisplay(kg, userUnits); }
function toStorageWeight(val){ return displayToKg(val, userUnits); }
function unitLabel(){ return userUnits === 'lbs' ? 'lbs' : 'kg'; }
async function refreshUserSettingsCache(){
  const profile = await getProfile();
  userUnits = profile.units || 'kg';
  userRestSeconds = profile.restTimerSeconds || 30;
  userTimerAlert = profile.timerAlert || 'sound';
}

function getAvailableExercises(equipmentKeys){
  const keys = new Set(equipmentKeys || []);
  const pool = [...(EXERCISE_LIBRARY.none || [])];
  Object.keys(EXERCISE_LIBRARY).forEach(libKey=>{
    if(libKey !== 'none' && keys.has(libKey)) pool.push(...EXERCISE_LIBRARY[libKey]);
  });
  return pool;
}

function defaultProfile(){
  return {
    name: '',
    location: null,
    equipment: [],
    units: 'kg',
    restTimerSeconds: 30,
    timerAlert: 'sound'
  };
}
async function getProfile(){
  try{
    const res = await window.storage.get('user-profile');
    if(res && res.value) return { ...defaultProfile(), ...JSON.parse(res.value) };
  }catch(e){ /* fall through */ }
  return defaultProfile();
}
async function saveProfile(profile){
  try{
    const result = await window.storage.set('user-profile', JSON.stringify(profile));
    if(!result) throw new Error("no result");
  }catch(e){ console.error("Could not save profile", e); showToast("Couldn't save profile"); }
}
async function setProfileName(name){
  const profile = await getProfile();
  profile.name = name;
  await saveProfile(profile);
}

async function setProfileLocation(loc){
  const profile = await getProfile();
  const newLoc = profile.location === loc ? null : loc;
  profile.location = newLoc;
  if(newLoc === 'gym'){
    profile.equipment = EQUIPMENT_OPTIONS.filter(o=>o.key !== 'none').map(o=>o.key);
  } else if(newLoc === 'home'){
    profile.equipment = [];
  }
  await saveProfile(profile);
  await renderProfileModal();
}
async function toggleProfileEquipment(key){
  const profile = await getProfile();
  const eq = new Set(profile.equipment);
  if(key === 'none'){
    eq.has('none') ? eq.clear() : (eq.clear(), eq.add('none'));
  } else {
    eq.delete('none');
    eq.has(key) ? eq.delete(key) : eq.add(key);
  }
  profile.equipment = [...eq];
  await saveProfile(profile);
  await renderProfileModal();
}

async function setProfileUnits(units){
  const profile = await getProfile();
  profile.units = units;
  await saveProfile(profile);
  await renderProfileModal();
}
async function setProfileRestTimer(seconds){
  const profile = await getProfile();
  profile.restTimerSeconds = seconds;
  await saveProfile(profile);
  await renderProfileModal();
}
async function setProfileTimerAlert(key){
  const profile = await getProfile();
  profile.timerAlert = key;
  await saveProfile(profile);
  await renderProfileModal();
}

function subPageHeaderHTML(title){
  return `
    <div class="profile-subheader">
      <button type="button" class="profile-back-btn" id="profileBackBtn">‹ Back</button>
      <div class="finish-title" style="margin:0;">${escapeHTML(title)}</div>
    </div>
  `;
}
function displayName(profile){
  const n = (profile.name || '').trim();
  return n ? n : 'Athlete';
}
function profileHubHTML(profile){
  return `
    <div class="finish-title">Settings</div>
    <div class="profile-greeting">Hi, ${escapeHTML(displayName(profile))}!</div>
    <div class="profile-identity">
      <input type="text" id="profileNameInput" class="profile-name-input" placeholder="Display name (optional)" value="${escapeHTML(profile.name || '')}">
    </div>
    <div class="profile-menu">
      <button type="button" class="profile-menu-item" data-view="equipment"><span>Equipment</span><span class="pmi-arrow">›</span></button>
      <button type="button" class="profile-menu-item" data-view="preferences"><span>Preferences</span><span class="pmi-arrow">›</span></button>
      <button type="button" class="profile-menu-item" data-view="progress"><span>Progress</span><span class="pmi-arrow">›</span></button>
      <button type="button" class="profile-menu-item" data-view="data"><span>Data</span><span class="pmi-arrow">›</span></button>
      <button type="button" class="profile-menu-item" data-view="help"><span>Help</span><span class="pmi-arrow">›</span></button>
    </div>
  `;
}
function equipmentPageHTML(){
  return `
    ${subPageHeaderHTML('Equipment')}
    <div class="profile-section-title" style="margin-top:0;">Training location</div>
    <div class="plan-grid" id="locationGrid">
      <button type="button" class="plan-btn" data-location="gym">Gym</button>
      <button type="button" class="plan-btn" data-location="home">Home</button>
    </div>
    <div class="profile-section-title">Equipment available</div>
    <div class="profile-hint">Select everything you have access to — this will be used to tailor your workout plans.</div>
    <div id="equipmentList"></div>
  `;
}

function preferencesPageHTML(){
  return `
    ${subPageHeaderHTML('Preferences')}
    <div class="profile-section-title" style="margin-top:0;">Units</div>
    <div class="plan-grid" id="unitsGrid">
      <button type="button" class="plan-btn" data-units="kg">Kilograms (kg)</button>
      <button type="button" class="plan-btn" data-units="lbs">Pounds (lbs)</button>
    </div>
    <div class="profile-section-title">Rest timer</div>
    <div class="profile-hint" style="margin-top:0;">Most exercises have their own recommended rest time built in. This is the fallback used for exercises without one (e.g. custom ones you add yourself).</div>
    <div class="plan-grid" id="restTimerGrid"></div>
    <div class="profile-section-title">Timer alert</div>
    <div class="profile-hint" style="margin-top:0;">How you're notified when rest is over.</div>
    <div class="plan-grid" id="timerAlertGrid"></div>
  `;
}
async function progressPageHTML(){
  const startStr = await getProgramStart();
  const week = startStr ? currentWeekFromStart(startStr) : null;
  const total = await getStripTotalWeeks(week || 0);

  let rows = '';
  let hasAny = false;
  for(let w=0; w<=total; w++){
    const data = await getWeekData(w);
    if(!data.photo && data.weight == null && data.bodyFat == null) continue;
    hasAny = true;
    const label = w === 0 ? 'Start' : `Week ${w}`;
    rows += `
      <div class="progress-history-row" data-week="${w}">
        ${data.photo ? `<img src="${data.photo}" alt="${label}">` : `<div class="progress-history-noimg">No photo</div>`}
        <div class="progress-history-info">
          <div class="progress-history-label">${escapeHTML(label)}</div>
          <div class="progress-history-stats">${data.weight != null ? `${toDisplayWeight(data.weight)}${unitLabel()}` : '—'} · ${data.bodyFat != null ? `${data.bodyFat}% BF` : '—'}</div>
        </div>
      </div>
    `;
  }

  return `
    ${subPageHeaderHTML('Progress')}
    <div class="profile-hint" style="margin-top:0;">
      ${week ? `You're in week ${week} of your progression plan.` : `You haven't started a progression plan yet.`}
    </div>
    <div class="profile-section-title">Check-in history</div>
    ${hasAny ? `<div class="progress-history-list">${rows}</div>` : `<div class="profile-hint">No check-ins logged yet — add one from the Progression card on your home screen.</div>`}
    <button type="button" class="checkin-btn" id="viewRecapBtn" style="width:100%; margin-top:14px;">View last month's recap</button>
  `;
}
function dataPageHTML(){
  return `
    ${subPageHeaderHTML('Data')}
    <div class="profile-hint" style="margin-top:0;">Your workouts, sets, and photos are stored on this device only.</div>
    <button type="button" class="checkin-btn" id="exportDataBtn" style="width:100%; margin-bottom:10px;">Export backup</button>
    <button type="button" class="checkin-btn" id="importDataBtn" style="width:100%; margin-bottom:10px;">Import backup</button>
    <button type="button" class="checkin-btn" id="resetProfileBtn" style="width:100%; margin-bottom:10px;">Reset profile info</button>
    <button type="button" class="checkin-btn" id="clearHistoryBtn" style="width:100%; margin-bottom:10px; color:var(--error); border-color:var(--error);">Clear all workout history</button>
    <div class="reset-app-warning">⚠️ This erases everything — export a backup first if you want to keep your data.</div>
    <button type="button" class="checkin-btn" id="resetAppBtn" style="width:100%; color:var(--error); border-color:var(--error);">Reset app (erase everything)</button>
  `;
}

async function resetEntireApp(){
  try{
    const res = await window.storage.list('');
    const keys = res && res.keys ? res.keys : [];
    for(const k of keys){ try{ await window.storage.remove(k); }catch(e){ /* ignore */ } }
    showToast("App reset — reloading…");
    setTimeout(()=> window.location.reload(), 1000);
  }catch(e){
    console.error("Reset app failed", e);
    showToast("Couldn't reset app");
  }
}

async function exportAllData(){
  try{
    const res = await window.storage.list('');
    const keys = res && res.keys ? res.keys : [];
    const dump = {};
    for(const k of keys){
      const v = await window.storage.get(k);
      if(v && v.value !== undefined) dump[k] = v.value;
    }
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type:'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pumppal-backup-${todayKey}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("Backup downloaded");
  }catch(e){
    console.error("Export failed", e);
    showToast("Couldn't export backup");
  }
}
async function importAllData(file){
  try{
    const text = await file.text();
    const dump = JSON.parse(text);
    const entries = Object.entries(dump);
    if(!entries.length){ showToast("Backup file looks empty"); return; }
    for(const [k, v] of entries){
      await window.storage.set(k, v);
    }
    showToast("Backup restored — reloading…");
    setTimeout(()=> window.location.reload(), 1200);
  }catch(e){
    console.error("Import failed", e);
    showToast("Couldn't read that backup file");
  }
}
const APP_VERSION = '1.0.0';
const FEEDBACK_EMAIL = 'constantinouioanna7@gmail.com';
function mailtoLink(subject, body){
  return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
function helpPageHTML(){
  return `
    ${subPageHeaderHTML('Help')}
    <div class="profile-hint" style="margin-top:0;">
      PumpPal tracks your workouts, rest timers, and weekly progress photos — all stored privately on this device.
      <br><br>
      Tap a workout to log sets, or Edit to build your own from your available equipment.
    </div>
    <div class="profile-menu" style="margin-top:16px;">
      <a class="profile-menu-item" href="${mailtoLink('PumpPal — Bug report', 'Describe the bug here:')}"><span>🐞 Report a bug</span></a>
      <a class="profile-menu-item" href="${mailtoLink('PumpPal — Feature suggestion', 'Describe your idea here:')}"><span>💡 Suggest a feature</span></a>
      <a class="profile-menu-item" href="${mailtoLink('PumpPal — Exercise request', 'Which exercise would you like added?')}"><span>🏋 Request an exercise</span></a>
    <div class="help-footer">
      <div>Version ${APP_VERSION}</div>
      <div>Built with ❤️ by Ioanna</div>
    </div>
  `;
}

function wireBackButton(){
  const btn = $("profileBackBtn");
  if(btn) btn.addEventListener('click', ()=>{ profileView = 'hub'; renderProfileModal(); });
}

async function renderProfileModal(){
  const profile = await getProfile();
  const body = $("profileModalBody");

  if(profileView === 'hub'){
    body.innerHTML = profileHubHTML(profile);
    $("profileNameInput").addEventListener('change', (e)=> setProfileName(e.target.value.trim()));
    body.querySelectorAll('.profile-menu-item').forEach(btn=>{
      btn.addEventListener('click', ()=>{ profileView = btn.dataset.view; renderProfileModal(); });
    });
    return;
  }

  if(profileView === 'equipment'){
    body.innerHTML = equipmentPageHTML();
    $("locationGrid").querySelectorAll('.plan-btn').forEach(btn=>{
      btn.classList.toggle('active', btn.dataset.location === profile.location);
      btn.addEventListener('click', ()=> setProfileLocation(btn.dataset.location));
    });
    const eqList = $("equipmentList");
    EQUIPMENT_OPTIONS.forEach(opt=>{
      const done = profile.equipment.includes(opt.key);
      const item = document.createElement('div');
      item.className = `checklist-item ${done?'done':''}`;
      item.innerHTML = `<div class="checklist-label">${escapeHTML(opt.label)}</div>`;
      item.addEventListener('click', ()=>toggleProfileEquipment(opt.key));
      eqList.appendChild(item);
    });
    wireBackButton();
    return;
  }

  if(profileView === 'preferences'){
    body.innerHTML = preferencesPageHTML();
    $("unitsGrid").querySelectorAll('.plan-btn').forEach(btn=>{
      btn.classList.toggle('active', btn.dataset.units === profile.units);
      btn.addEventListener('click', ()=> setProfileUnits(btn.dataset.units));
    });
    const restGrid = $("restTimerGrid");
    REST_TIMER_OPTIONS.forEach(sec=>{
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `plan-btn ${profile.restTimerSeconds === sec ? 'active' : ''}`;
      btn.textContent = formatRestSeconds(sec);
      btn.addEventListener('click', ()=> setProfileRestTimer(sec));
      restGrid.appendChild(btn);
    });
    const alertGrid = $("timerAlertGrid");
    TIMER_ALERT_OPTIONS.forEach(opt=>{
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `plan-btn ${profile.timerAlert === opt.key ? 'active' : ''}`;
      btn.textContent = opt.label;
      btn.addEventListener('click', ()=> setProfileTimerAlert(opt.key));
      alertGrid.appendChild(btn);
    });
    wireBackButton();
    return;
  }

  if(profileView === 'progress'){
    body.innerHTML = await progressPageHTML();
    body.querySelectorAll('.progress-history-row').forEach(row=>{
      row.addEventListener('click', ()=>{
        closeProfileModal();
        openPhotoModal(Number(row.dataset.week));
      });
    });
    const viewRecapBtn = $("viewRecapBtn");
    if(viewRecapBtn){
      viewRecapBtn.addEventListener('click', async ()=>{
        const now = new Date();
        const prevDate = new Date(now.getFullYear(), now.getMonth()-1, 1);
        closeProfileModal();
        await openMonthlyRecap(prevDate.getFullYear(), prevDate.getMonth());
      });
    }
    wireBackButton();
    return;
  }

  if(profileView === 'data'){
    body.innerHTML = dataPageHTML();
    $("exportDataBtn").addEventListener('click', exportAllData);
    $("importDataBtn").addEventListener('click', ()=> $("dataImportInput").click());
    const resetProfileBtn = $("resetProfileBtn");
    resetProfileBtn.addEventListener('click', async ()=>{
      if(resetProfileBtn.dataset.armed !== '1'){
        resetProfileBtn.dataset.armed = '1';
        resetProfileBtn.textContent = 'Tap again to confirm';
        setTimeout(()=>{ if(resetProfileBtn.dataset.armed === '1'){ resetProfileBtn.dataset.armed='0'; resetProfileBtn.textContent = 'Reset profile info'; } }, 4000);
        return;
      }
      await saveProfile(defaultProfile());
      showToast("Profile reset");
      profileView = 'hub';
      await renderProfileModal();
    });
    const clearBtn = $("clearHistoryBtn");
    clearBtn.addEventListener('click', async ()=>{
      if(clearBtn.dataset.armed !== '1'){
        clearBtn.dataset.armed = '1';
        clearBtn.textContent = 'Tap again to confirm';
        setTimeout(()=>{ if(clearBtn.dataset.armed === '1'){ clearBtn.dataset.armed='0'; clearBtn.textContent = 'Clear all workout history'; } }, 4000);
        return;
      }
      const keys = await getAllSessionKeys();
      for(const k of keys){ try{ await window.storage.remove(k); }catch(e){ /* ignore */ } }
      showToast("History cleared");
      await renderAll();
    });

    const resetAppBtn = $("resetAppBtn");
    resetAppBtn.addEventListener('click', async ()=>{
      if(resetAppBtn.dataset.armed !== '1'){
        resetAppBtn.dataset.armed = '1';
        resetAppBtn.textContent = 'Tap again to confirm — erases everything';
        setTimeout(()=>{ if(resetAppBtn.dataset.armed === '1'){ resetAppBtn.dataset.armed='0'; resetAppBtn.textContent = 'Reset app (erase everything)'; } }, 4000);
        return;
      }
      await resetEntireApp();
    });

    wireBackButton();
    return;
  }

  if(profileView === 'help'){
    body.innerHTML = helpPageHTML();
    wireBackButton();
    return;
  }
}
function eimListHTML(title, items){
  if(!items || !items.length){
    return `<div class="eim-section-title">${escapeHTML(title)}</div><div class="eim-empty">Not added yet.</div>`;
  }
  return `
    <div class="eim-section-title">${escapeHTML(title)}</div>
    <ul class="eim-list">${items.map(i=>`<li>${escapeHTML(i)}</li>`).join('')}</ul>
  `;
}
function eimListItems(items){
  if(!items || !items.length) return `<div class="eim-empty">Not added yet.</div>`;
  return `<ul class="eim-list">${items.map(i=>`<li>${escapeHTML(i)}</li>`).join('')}</ul>`;
}
function openExerciseImageModal(src, name){
  if(!src) return;
  $("exerciseImageModalImg").src = src;
  $("exerciseImageModalImg").alt = name;
  $("exerciseImageModalLabel").textContent = name;

  const data = findExerciseData(name);
  const muscleLabel = data && data.muscle ? muscleLabelFor(data.muscle) : null;
  const body = $("exerciseImageModalBody");
  body.innerHTML = `
    <div class="eim-tabs">
      <button type="button" class="eim-tab active" data-tab="howto">How to</button>
      <button type="button" class="eim-tab" data-tab="muscles">Muscles</button>
      <button type="button" class="eim-tab" data-tab="mistakes">Mistakes</button>
      <button type="button" class="eim-tab" data-tab="tips">Tips</button>
    </div>
    <div class="eim-panel" data-panel="howto">${eimListItems(data && data.steps)}</div>
    <div class="eim-panel" data-panel="muscles" style="display:none;">${muscleLabel ? `<div class="eim-muscle-badge">${escapeHTML(muscleLabel)}</div>` : `<div class="eim-empty">Not tagged yet.</div>`}</div>
    <div class="eim-panel" data-panel="mistakes" style="display:none;">${eimListItems(data && data.mistakes)}</div>
    <div class="eim-panel" data-panel="tips" style="display:none;">${eimListItems(data && data.tips)}</div>
  `;
  body.querySelectorAll('.eim-tab').forEach(tab=>{
    tab.addEventListener('click', ()=>{
      body.querySelectorAll('.eim-tab').forEach(t=> t.classList.remove('active'));
      tab.classList.add('active');
      body.querySelectorAll('.eim-panel').forEach(p=>{
        p.style.display = (p.dataset.panel === tab.dataset.tab) ? 'block' : 'none';
      });
    });
  });

  $("exerciseImageModal").classList.add('open');
}
function closeExerciseImageModal(){
  $("exerciseImageModal").classList.remove('open');
}

/* ---------- home screen ---------- */
function getGreetingSub(){
  const h = new Date().getHours();
  if(h < 12) return 'Good morning,';
  if(h < 18) return 'Good afternoon,';
  return 'Good evening,';
}
async function renderGreeting(){
  const profile = await getProfile();
  const subEl = $("greetingSub");
  const nameEl = $("greetingName");
  if(subEl) subEl.textContent = getGreetingSub();
  if(nameEl) nameEl.textContent = displayName(profile);
}

const FOCUS_TIPS = [
  "Form over ego. Every rep counts.",
  "Consistency beats intensity. Show up today.",
  "Rest is part of the plan, not a break from it.",
  "Progress isn't always visible on the scale.",
  "You don't have to be extreme, just consistent.",
  "Small steps today, big change tomorrow.",
  "Discipline today, results tomorrow."
];
function getDailyFocusTip(){
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(),0,0)) / 86400000);
  return FOCUS_TIPS[dayOfYear % FOCUS_TIPS.length];
}
function renderFocusTip(){
  const el = $("focusTipCard");
  if(!el) return;
  el.innerHTML = `
    <div class="ftc-thumb"></div>
    <div class="ftc-body">
      <div class="ftc-label">Focus tip</div>
      <div class="ftc-text">${escapeHTML(getDailyFocusTip())}</div>
    </div>
  `;
}

async function getActiveWorkoutProgress(session){
  const strengthPlans = [];
  for(const key of session.plan){
    const def = await getPlanDef(key);
    if(def && def.type === 'strength') strengthPlans.push({ key, def });
  }
  if(!strengthPlans.length) return null;
  let total = 0, completedCount = 0;
  for(const { key } of strengthPlans){
    const exercises = await getWorkoutTemplate(key);
    exercises.forEach(ex=>{
      total++;
      if((session.completed || []).includes(ex.name)) completedCount++;
    });
  }
  const label = strengthPlans.length === 1 ? strengthPlans[0].def.label : 'Workout';
  return { total, completedCount, label };
}

async function renderHomeWorkoutCard(){
  const session = await getSession(todayKey);
  const card = $("homeWorkoutCard");
  if(!card) return;

  if(session.startedAt && !session.finishedAt){
    const progress = await getActiveWorkoutProgress(session);
    const total = progress ? progress.total : 0;
    const done = progress ? progress.completedCount : 0;
    const label = progress ? progress.label : 'Workout';
    const pct = total ? Math.round((done/total)*100) : 0;
    const elapsed = formatDuration(Date.now() - session.startedAt);
    card.className = 'home-workout-card active';
    card.innerHTML = `
      <div class="hwc-row">
        <div>
          <div class="hwc-label">Continue workout</div>
          <div class="hwc-title">${escapeHTML(label)}</div>
          <div class="hwc-sub">Exercise ${total ? Math.min(done+1, total) : 0} of ${total}</div>
          <div class="hwc-elapsed">${elapsed} elapsed</div>
        </div>
        <div class="hwc-thumb"></div>
      </div>
      <div class="hwc-progress-track"><div class="hwc-progress-fill" style="width:${pct}%"></div></div>
      <button type="button" class="hwc-btn" id="hwcContinueBtn">Continue workout ›</button>
    `;
    $("hwcContinueBtn").addEventListener('click', openWorkoutSession);
  } else {
    card.className = 'home-workout-card idle';
    card.innerHTML = `
      <div class="hwc-idle-title">No workout in progress</div>
      <div class="hwc-idle-sub">Start a workout or create one to get moving.</div>
      <button type="button" class="hwc-btn" id="hwcStartBtn">Start workout</button>
    `;
    $("hwcStartBtn").addEventListener('click', openWorkoutSession);
  }
}

/* ---------- workout session (full-screen flow) ---------- */
async function buildFlattenedExerciseList(session){
  const list = [];
  for(const key of session.plan){
    const def = await getPlanDef(key);
    if(def && def.type === 'strength'){
      const exercises = await getWorkoutTemplate(key);
      exercises.forEach(ex=> list.push({ ...ex, planKey:key }));
    }
  }
  return list;
}

function startWssTimer(startedAt){
  clearInterval(wssTimerInterval);
  const tick = ()=>{ const el = $("wssTimerValue"); if(el) el.textContent = formatDuration(Date.now()-startedAt); };
  tick();
  wssTimerInterval = setInterval(tick, 1000);
}
function stopWssTimer(){ clearInterval(wssTimerInterval); wssTimerInterval = null; }

async function openWorkoutSession(){
  let session = await getSession(todayKey);
  if(!session.startedAt){
    await updateSession(todayKey, (s)=>{ s.startedAt = Date.now(); s.finishedAt = null; });
    session = await getSession(todayKey);
  }
  workoutSessionExerciseList = await buildFlattenedExerciseList(session);
  if(!workoutSessionExerciseList.length){
    showToast("Add exercises to this workout first");
    document.querySelectorAll('.tab-btn').forEach(b=> b.classList.remove('active'));
    $("tabWorkoutsBtn").classList.add('active');
    document.querySelectorAll('.app-page').forEach(p=> p.classList.remove('active'));
    $("workoutsPage").classList.add('active');
    return;
  }
  $("workoutSessionScreen").classList.add('open');
  startWssTimer(session.startedAt || Date.now());
  await renderWorkoutSessionOverview();
}
function closeWorkoutSession(){
  $("workoutSessionScreen").classList.remove('open');
  stopWssTimer();
  renderAll();
}

async function renderWorkoutSessionOverview(){
  const session = await getSession(todayKey);
  const completed = session.completed || [];
  const remaining = workoutSessionExerciseList.filter(ex=>!completed.includes(ex.name));
  const total = workoutSessionExerciseList.length;
  const doneCount = total - remaining.length;

  const progress = await getActiveWorkoutProgress(session);
  $("wssTitle").textContent = progress ? progress.label : 'Workout';
  $("wssProgressText").textContent = `${Math.min(doneCount+1,total)} / ${total} exercises`;
  $("wssProgressFill").style.width = `${total ? Math.round((doneCount/total)*100) : 0}%`;

  if(!remaining.length){
    closeWorkoutSession();
    await handleFinishWorkout();
    return;
  }

  const current = remaining[0];
  const next = remaining[1] || null;
  const data = findExerciseData(current.name);
  const muscleLabel = data && data.muscle ? muscleLabelFor(data.muscle) : '';
  const restSecs = getExerciseRestSeconds(current.name);

  $("wssCurrentCard").innerHTML = `
    <div class="wss-label">Current exercise</div>
    <div class="wss-ex-name">${escapeHTML(current.name)}</div>
    <div class="wss-ex-meta">${escapeHTML(current.target)} · Rest ${formatRestSeconds(restSecs)}</div>
    ${muscleLabel ? `<div class="wss-muscle-tag">${escapeHTML(muscleLabel)}</div>` : ``}
  `;

  const upNextCard = $("wssUpNextCard");
  if(next){
    upNextCard.style.display = 'flex';
    upNextCard.querySelector('.wss-upnext-name').textContent = next.name;
  } else {
    upNextCard.style.display = 'none';
  }

  $("wssTipText").textContent = getDailyFocusTip();

  $("wssLogSetBtn").onclick = ()=> openLoggingScreen(current);
  $("wssSkipBtn").onclick = async ()=>{
    await updateSession(todayKey, (s)=>{
      s.completed = s.completed || [];
      if(!s.completed.includes(current.name)) s.completed.push(current.name);
    });
    await renderWorkoutSessionOverview();
  };
}

async function openLoggingScreen(ex){
  loggingScreenExercise = ex;
  const repGoal = parseRepGoal(ex.target) || 12;
  const session = await getSession(todayKey);
  const loggedCount = session.sets.filter(s=>s.exercise===ex.name).length;
  loggingScreenSetIndex = loggedCount + 1;
  loggingScreenReps = repGoal;
  loggingScreenWeight = ex.weight != null ? toDisplayWeight(ex.weight) : 0;
  $("loggingScreen").classList.add('open');
  await renderLoggingScreen();
}
function closeLoggingScreen(){
  $("loggingScreen").classList.remove('open');
}

async function renderLoggingScreen(){
  const ex = loggingScreenExercise;
  if(!ex) return;
  const targetSetsNum = extractLeadingSets(ex.target) || 1;
  const restSecs = getExerciseRestSeconds(ex.name);
  $("loggingExerciseName").textContent = ex.name;
  $("loggingSetLabel").textContent = `Set ${loggingScreenSetIndex} of ${targetSetsNum}`;
  $("loggingRepsValue").textContent = loggingScreenReps;
  $("loggingWeightValue").textContent = loggingScreenWeight;
  $("loggingWeightUnit").textContent = unitLabel();
  $("loggingRestValue").textContent = formatRestSeconds(restSecs);

  const repChips = [8,10,12,15,20];
  $("loggingRepsChips").innerHTML = repChips.map(r=>`<button type="button" class="logging-chip ${r===loggingScreenReps?'active':''}" data-rep="${r}">${r}</button>`).join('');
  $("loggingRepsChips").querySelectorAll('.logging-chip').forEach(btn=>{
    btn.addEventListener('click', async ()=>{ loggingScreenReps = Number(btn.dataset.rep); await renderLoggingScreen(); });
  });

  const baseW = loggingScreenWeight || 20;
  const step = userUnits==='lbs' ? 5 : 2.5;
  const rawChips = [baseW-step*1.5, baseW-step, baseW-step*0.5, baseW, baseW+step*0.5].map(w=>Math.max(0, Math.round(w*100)/100));
  const uniqueChips = [...new Set(rawChips)];
  $("loggingWeightChips").innerHTML = uniqueChips.map(w=>`<button type="button" class="logging-chip ${w===loggingScreenWeight?'active':''}" data-w="${w}">${w}</button>`).join('');
  $("loggingWeightChips").querySelectorAll('.logging-chip').forEach(btn=>{
    btn.addEventListener('click', async ()=>{ loggingScreenWeight = Number(btn.dataset.w); await renderLoggingScreen(); });
  });

  const session = await getSession(todayKey);
  const logged = session.sets.filter(s=>s.exercise===ex.name);
  $("loggingSetHistory").innerHTML = logged.map((s,i)=>`
    <div class="logging-history-row"><span>Set ${i+1}</span><span>${s.reps} reps</span><span>${toDisplayWeight(s.weight)}${unitLabel()}</span></div>
  `).join('');
}

function openProfileModal(){
  profileView = 'hub';
  $("profileModal").classList.add('open');
  renderProfileModal();
}

async function closeProfileModal(){
  $("profileModal").classList.remove('open');
  profileView = 'hub';
  await refreshUserSettingsCache();
  await renderPlanSection();
  await renderStats();
  await renderGreeting();
}

/* ---------- monthly recap ---------- */
const MASCOT_IMG_HTML = `<img src="icons/mascot/flexing.png" alt="PumpPal mascot" style="width:100%; height:100%; object-fit:contain;">`;

function daysInMonth(year, monthIndex){ return new Date(year, monthIndex+1, 0).getDate(); }
function formatDurationLong(ms){
  const totalMin = Math.round(ms/60000);
  const h = Math.floor(totalMin/60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function muscleLabelFor(key){
  const found = MUSCLE_GROUP_OPTIONS.find(m=>m.key===key);
  return found ? found.label : key;
}

async function computeMonthlyRecap(year, monthIndex){
  const monthPrefix = `${year}-${pad(monthIndex+1)}`;
  const prevDate = new Date(year, monthIndex-1, 1);
  const prevMonthPrefix = `${prevDate.getFullYear()}-${pad(prevDate.getMonth()+1)}`;

  const allKeys = await getAllSessionKeys();
  const dateKeys = allKeys.map(k=>k.replace('session:',''));
  const monthDateKeys = dateKeys.filter(k=>k.startsWith(monthPrefix));
  const prevMonthDateKeys = dateKeys.filter(k=>k.startsWith(prevMonthPrefix));

  let workoutsCompleted = 0;
  let totalDurationMs = 0;
  let totalVolume = 0;
  let totalSets = 0;
  let totalReps = 0;
  const exerciseDayCounts = {};
  const muscleSetCounts = {};
  const prMap = {};
  const activeDateKeys = [];

  for(const dk of monthDateKeys){
    const s = await getSession(dk);
    if(s.sets.length > 0){ workoutsCompleted++; activeDateKeys.push(dk); }
    if(s.startedAt && s.finishedAt && s.finishedAt > s.startedAt){
      totalDurationMs += (s.finishedAt - s.startedAt);
    }
    totalVolume += volumeOf(s.sets);
    totalSets += s.sets.length;
    s.sets.forEach(set=>{
      totalReps += Number(set.reps) || 0;
      if(!exerciseDayCounts[set.exercise]) exerciseDayCounts[set.exercise] = new Set();
      exerciseDayCounts[set.exercise].add(dk);
      const data = findExerciseData(set.exercise);
      const muscle = data && data.muscle ? data.muscle : null;
      if(muscle) muscleSetCounts[muscle] = (muscleSetCounts[muscle] || 0) + 1;
    });
    (s.newPRs || []).forEach(ev=>{
      if(ev.type === 'weight' && ev.delta != null && ev.delta > 0){
        if(!prMap[ev.exercise] || ev.delta > prMap[ev.exercise].delta) prMap[ev.exercise] = { delta: ev.delta, weight: ev.weight };
      }
    });
  }

  activeDateKeys.sort();
  const longestStreak = computeLongestStreakInMonth(activeDateKeys);

  let prevWorkouts = 0;
  let prevVolume = 0;
  for(const dk of prevMonthDateKeys){
    const s = await getSession(dk);
    if(s.sets.length > 0) prevWorkouts++;
    prevVolume += volumeOf(s.sets);
  }

  const workoutsDelta = workoutsCompleted - prevWorkouts;
  const volumeDeltaPct = prevVolume > 0 ? Math.round(((totalVolume - prevVolume) / prevVolume) * 100) : null;

  const totalDays = daysInMonth(year, monthIndex);
  const weeksInMonth = totalDays / 7;
  const avgPerWeek = weeksInMonth > 0 ? Math.round((workoutsCompleted / weeksInMonth) * 10) / 10 : 0;

  const muscleEntries = Object.entries(muscleSetCounts).sort((a,b)=> b[1]-a[1]);
  const mostMuscle = muscleEntries.length ? muscleLabelFor(muscleEntries[0][0]) : null;
  const leastMuscle = muscleEntries.length ? muscleLabelFor(muscleEntries[muscleEntries.length-1][0]) : null;

  const dayEntries = Object.entries(exerciseDayCounts).map(([name, set])=>[name, set.size]).sort((a,b)=> b[1]-a[1]);
  const favoriteExercise = dayEntries.length ? { name: dayEntries[0][0], sessions: dayEntries[0][1] } : null;

  const consistencyScore = Math.min(100, Math.round((workoutsCompleted / totalDays) * 100));

  const prs = Object.entries(prMap)
    .map(([exercise, v])=>({ exercise, delta: v.delta, weight: v.weight }))
    .sort((a,b)=> b.delta - a.delta)
    .slice(0, 5);

  let bestLift = null;
  if(prs.length){
    const top = prs[0];
    let bestReps = 0;
    for(const dk of monthDateKeys){
      const s = await getSession(dk);
      s.sets.forEach(set=>{
        if(set.exercise === top.exercise && set.weight === top.weight) bestReps = Math.max(bestReps, set.reps);
      });
    }
    bestLift = { exercise: top.exercise, weight: top.weight, reps: bestReps };
  }

  const monthLabel = new Date(year, monthIndex, 1).toLocaleDateString(undefined, { month:'long', year:'numeric' });

  return {
    monthLabel, workoutsCompleted, workoutsDelta,
    totalDurationMs, totalVolume, volumeDeltaPct, avgPerWeek,
    prs, mostMuscle, leastMuscle, favoriteExercise,
    totalSets, totalReps, consistencyScore, bestLift, longestStreak
  };
}

function computeLongestStreakInMonth(sortedActiveDateKeys){
  if(!sortedActiveDateKeys.length) return 0;
  let longest = 1, current = 1;
  for(let i=1; i<sortedActiveDateKeys.length; i++){
    const prev = new Date(sortedActiveDateKeys[i-1]);
    const cur = new Date(sortedActiveDateKeys[i]);
    const diffDays = Math.round((cur-prev)/86400000);
    if(diffDays === 1){ current++; longest = Math.max(longest, current); }
    else if(diffDays > 1){ current = 1; }
  }
  return longest;
}

function recapStatRow(icon, label, value, sub){
  return `
    <div class="recap-stat-row">
      <div class="recap-stat-icon">${icon}</div>
      <div class="recap-stat-body">
        <div class="recap-stat-label">${escapeHTML(label)}</div>
        <div class="recap-stat-value">${value}</div>
        ${sub ? `<div class="recap-stat-sub">${sub}</div>` : ``}
      </div>
    </div>
  `;
}

function renderRecapContent(recap){
  const deltaWorkoutsHTML = recap.workoutsDelta !== 0
    ? `<span class="recap-delta ${recap.workoutsDelta>0?'up':'down'}">${recap.workoutsDelta>0?'⬆':'⬇'} ${recap.workoutsDelta>0?'+':''}${recap.workoutsDelta} vs last month</span>`
    : '';
  const deltaVolumeHTML = recap.volumeDeltaPct !== null
    ? `<span class="recap-delta ${recap.volumeDeltaPct>=0?'up':'down'}">${recap.volumeDeltaPct>=0?'⬆':'⬇'} ${recap.volumeDeltaPct>=0?'+':''}${recap.volumeDeltaPct}%</span>`
    : '';

  const prHTML = recap.prs.length
    ? recap.prs.map(p=>`
        <div class="recap-pr-item">
          <span class="recap-pr-name">${escapeHTML(p.exercise)}</span>
          <span class="recap-pr-delta">+${Math.round(toDisplayWeight(p.delta)*10)/10}${unitLabel()}</span>
        </div>
      `).join('')
    : `<div class="recap-empty">No new PRs this month — keep pushing!</div>`;

  const bestLiftHTML = recap.bestLift
    ? recapStatRow('🏆', 'Best lift', `${escapeHTML(recap.bestLift.exercise)}`, `${toDisplayWeight(recap.bestLift.weight)}${unitLabel()} × ${recap.bestLift.reps}`)
    : '';
  const streakHTML = recap.longestStreak > 0
    ? recapStatRow('🔥', 'Longest streak', `${recap.longestStreak} day${recap.longestStreak===1?'':'s'}`, 'Keep it going!')
    : '';

  return `
    <div class="recap-mascot">${MASCOT_IMG_HTML}</div>
    <div class="recap-month-title">${escapeHTML(recap.monthLabel)}</div>

    ${recapStatRow('🏋️', 'Workouts completed', recap.workoutsCompleted, deltaWorkoutsHTML)}
    ${recapStatRow('⏱', 'Total training time', formatDurationLong(recap.totalDurationMs))}
    ${recapStatRow('💪', 'Total volume lifted', `${Math.round(toDisplayWeight(recap.totalVolume)).toLocaleString()} ${unitLabel()}`, deltaVolumeHTML)}
    ${recapStatRow('📅', 'Average workouts/week', recap.avgPerWeek)}
    ${bestLiftHTML}
    ${streakHTML}

    <div class="recap-section-title">🏆 Personal records</div>
    <div class="recap-pr-list">${prHTML}</div>

    ${recap.mostMuscle ? recapStatRow('⭐', 'Most trained muscle', escapeHTML(recap.mostMuscle)) : ''}
    ${recap.leastMuscle ? recapStatRow('⚠', 'Least trained muscle', escapeHTML(recap.leastMuscle)) : ''}
    ${recap.favoriteExercise ? recapStatRow('❤', 'Favorite exercise', escapeHTML(recap.favoriteExercise.name), `${recap.favoriteExercise.sessions} sessions`) : ''}

    ${recapStatRow('📊', 'Total sets', recap.totalSets)}
    ${recapStatRow('🔢', 'Total reps', recap.totalReps.toLocaleString())}
    ${recapStatRow('✅', 'Consistency score', `${recap.consistencyScore}/100`)}

    <div class="recap-footer">See you next month 👋</div>
  `;
}

async function getRecapSeen(monthKey){
  try{ const res = await window.storage.get(`recap-seen:${monthKey}`); return !!(res && res.value); }
  catch(e){ return false; }
}
async function setRecapSeen(monthKey){
  try{ await window.storage.set(`recap-seen:${monthKey}`, '1'); }
  catch(e){ console.error("Could not mark recap seen", e); }
}

let pendingRecapMonth = null;

async function checkForMonthlyRecap(){
  const now = new Date();
  const prevDate = new Date(now.getFullYear(), now.getMonth()-1, 1);
  const year = prevDate.getFullYear();
  const monthIndex = prevDate.getMonth();
  const monthKey = `${year}-${pad(monthIndex+1)}`;

  const allKeys = await getAllSessionKeys();
  const hasData = allKeys.some(k=> k.replace('session:','').startsWith(monthKey));
  if(!hasData) return;

  const seen = await getRecapSeen(monthKey);
  if(seen) return;

  pendingRecapMonth = { year, monthIndex, key: monthKey };
  const banner = $("recapBanner");
  const monthLabel = new Date(year, monthIndex, 1).toLocaleDateString(undefined, { month:'long' });
  $("recapBannerMascot").innerHTML = MASCOT_IMG_HTML;
  $("recapBannerText").textContent = `🎉 Your ${monthLabel} Recap is ready! Tap it.`;
  banner.style.display = 'flex';
}

let currentRecapYear = null;
let currentRecapMonthIndex = null;

function recapNavHTML(year, monthIndex){
  return `
    <div class="recap-nav">
      <button type="button" class="recap-nav-btn" id="recapPrevBtn">‹</button>
      <div class="recap-nav-month">${escapeHTML(new Date(year, monthIndex, 1).toLocaleDateString(undefined,{month:'long',year:'numeric'}))}</div>
      <button type="button" class="recap-nav-btn" id="recapNextBtn">›</button>
    </div>
  `;
}

async function openMonthlyRecap(year, monthIndex){
  currentRecapYear = year;
  currentRecapMonthIndex = monthIndex;
  const recap = await computeMonthlyRecap(year, monthIndex);
  $("recapModalBody").innerHTML = recapNavHTML(year, monthIndex) + renderRecapContent(recap);
  $("recapPrevBtn").addEventListener('click', ()=>{
    const d = new Date(currentRecapYear, currentRecapMonthIndex-1, 1);
    openMonthlyRecap(d.getFullYear(), d.getMonth());
  });
  $("recapNextBtn").addEventListener('click', ()=>{
    const d = new Date(currentRecapYear, currentRecapMonthIndex+1, 1);
    openMonthlyRecap(d.getFullYear(), d.getMonth());
  });
  $("recapModal").classList.add('open');
}

async function handleRecapBannerTap(){
  if(!pendingRecapMonth) return;
  await openMonthlyRecap(pendingRecapMonth.year, pendingRecapMonth.monthIndex);
  await setRecapSeen(pendingRecapMonth.key);
  $("recapBanner").style.display = 'none';
  pendingRecapMonth = null;
}

/* ---------- helpers ---------- */
function formatDuration(ms){
  const totalSec = Math.max(0, Math.floor(ms/1000));
  const h = Math.floor(totalSec/3600), m = Math.floor((totalSec%3600)/60), s = totalSec%60;
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
}

function slugify(str){
  return String(str).trim().toLowerCase().replace(/\s+/g,'-').replace(/['"/\\]/g,'');
}

function calcSuggestedIncrement(weightKg){
  if(weightKg >= 20) return 2.5;
  if(weightKg >= 10) return 1.25;
  return 0.5;
}

async function getWeightForExerciseInSession(session, exercise){
  const sets = session.sets.filter(s=>s.exercise === exercise);
  if(!sets.length) return null;
  return sets[sets.length - 1].weight;
}

async function countConsecutiveSessionsAtWeight(exercise, weight){
  const keys = await getAllSessionKeys();
  const dateKeys = keys.map(k=>k.replace('session:','')).sort((a,b)=> b.localeCompare(a));
  let count = 0;
  for(const key of dateKeys){
    const s = await getSession(key);
    const w = await getWeightForExerciseInSession(s, exercise);
    if(w === null) continue;
    if(w === weight) count++;
    else break;
  }
  return count;
}

let pendingOverload = null;
function openOverloadModal(exerciseName, currentWeight, newWeight){
  pendingOverload = { exerciseName, newWeight };
  $("overloadModalBody").textContent = `You've completed 5 workouts at ${toDisplayWeight(currentWeight)}${unitLabel()} for ${exerciseName}. Want to try ${toDisplayWeight(newWeight)}${unitLabel()}?`;
  $("overloadModal").classList.add('open');
}
function closeOverloadModal(){
  $("overloadModal").classList.remove('open');
  pendingOverload = null;
}
async function acceptOverload(){
  if(!pendingOverload) return;
  try{
    await window.storage.set(`weight-override:${slugify(pendingOverload.exerciseName)}`, String(pendingOverload.newWeight));
  }catch(e){ console.error("Could not save weight override", e); }
  showToast("Next time, we'll suggest the new weight");
  closeOverloadModal();
}

async function checkProgressiveOverload(exerciseName){
  const session = await getSession(todayKey);
  const weight = await getWeightForExerciseInSession(session, exerciseName);
  if(!weight || weight <= 0) return;

  const count = await countConsecutiveSessionsAtWeight(exerciseName, weight);
  if(count > 0 && count % 5 === 0){
    const increment = calcSuggestedIncrement(weight);
    const newWeight = Math.round((weight + increment) * 100) / 100;
    openOverloadModal(exerciseName, weight, newWeight);
  }
}

function prKey(exercise){
  const safe = String(exercise).trim().toLowerCase().replace(/\s+/g,'-').replace(/['"/\\]/g,'');
  return `pr:${safe}`;
}
async function getPRRecord(exercise){
  try{
    const res = await window.storage.get(prKey(exercise));
    if(res && res.value) return JSON.parse(res.value);
  }catch(e){ /* fall through */ }
  return { maxWeight:0, maxWeightReps:0, best1RM:0, best1RMWeight:0, best1RMReps:0, repsAtWeight:{} };
}
async function checkAndUpdatePR(exercise, weight, reps){
  const record = await getPRRecord(exercise);
  const events = [];
  if(weight > record.maxWeight){
    const prevMax = record.maxWeight;
    record.maxWeight = weight; record.maxWeightReps = reps;
    const delta = prevMax > 0 ? (weight - prevMax) : null;
    events.push({ type:'weight', detail:`Heaviest weight — ${toDisplayWeight(weight)}${unitLabel()} × ${reps}`, weight, delta });
  }
  const wKey = String(weight);
  if(reps > (record.repsAtWeight[wKey] || 0)){
    record.repsAtWeight[wKey] = reps;
    events.push({ type:'reps', detail:`Most reps at ${toDisplayWeight(weight)}${unitLabel()} — ${reps} reps` });
  }
  if(weight > 0){
    const est1RM = weight * (1 + reps/30);
    if(est1RM > record.best1RM){
      record.best1RM = est1RM; record.best1RMWeight = weight; record.best1RMReps = reps;
      events.push({ type:'1rm', detail:`Estimated 1-rep max — ~${Math.round(toDisplayWeight(est1RM))}${unitLabel()}` });
    }
  }
  if(events.length){
    try{ await window.storage.set(prKey(exercise), JSON.stringify(record)); }
    catch(e){ console.error("Could not save PR", e); }
  }
  return events;
}

function groupByExercise(sets){
  const map = new Map();
  sets.forEach(s=>{ if(!map.has(s.exercise)) map.set(s.exercise, []); map.get(s.exercise).push(s); });
  return map;
}
function volumeOf(sets){ return sets.reduce((sum,s)=> sum + (Number(s.weight)||0) * (Number(s.reps)||0), 0); }

/* ---------- image compression for check-in photos ---------- */
function compressImageFile(file){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not load image"));
      img.onload = () => {
        let { width, height } = img;
        const maxDim = 900;
        if(width > maxDim || height > maxDim){
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        let quality = 0.72;
        let dataUrl = canvas.toDataURL('image/jpeg', quality);
        while(dataUrl.length > 3500000 && quality > 0.3){
          quality -= 0.12;
          dataUrl = canvas.toDataURL('image/jpeg', quality);
        }
        resolve(dataUrl);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ---------- progression ---------- */
function getPhase(week){
  if(week<=2) return {label:'Learn the form', desc:'Focus on clean technique and full range of motion. Keep weight light — this block is about the movement, not the load.'};
  if(week<=4) return {label:'Increase reps', desc:'Form should feel steady now. Add a few reps per set before adding any weight.'};
  if(week<=6) return {label:'Increase weight / resistance', desc:'Reps feel manageable — this is the block to add weight or resistance.'};
  return {label:'Keep progressing', desc:'You are past the first 6-week cycle. Keep nudging weight or resistance up as it feels manageable.'};
}

function currentWeekFromStart(startStr){
  const [y,m,d] = startStr.split("-").map(Number);
  const start = new Date(y, m-1, d);
  const [ty,tm,td] = todayKey.split("-").map(Number);
  const now = new Date(ty, tm-1, td);
  const days = Math.round((now - start) / 86400000);
  return Math.max(1, Math.floor(days/7) + 1);
}

async function weekForDate(dateStr){
  const startStr = await getProgramStart();
  if(!startStr) return null;
  const [sy,sm,sd] = startStr.split("-").map(Number);
  const start = new Date(sy, sm-1, sd);
  const [dy,dm,dd] = dateStr.split("-").map(Number);
  const d = new Date(dy, dm-1, dd);
  const days = Math.round((d - start) / 86400000);
  if(days < 0) return null;
  return Math.max(1, Math.floor(days/7) + 1);
}

async function getPreviousPerformance(exerciseName){
  const keys = await getAllSessionKeys();
  const dateKeys = keys.map(k=>k.replace('session:','')).filter(k=>k !== todayKey).sort((a,b)=> b.localeCompare(a));
  for(const key of dateKeys){
    const s = await getSession(key);
    const matches = s.sets.filter(x=>x.exercise === exerciseName);
    if(matches.length > 0){
      const best = matches.reduce((a,b)=> (a.weight*a.reps >= b.weight*b.reps ? a : b));
      const week = await weekForDate(key);
      return { week, date:key, weight:best.weight, reps:best.reps };
    }
  }
  return null;
}

/* ---------- rest timer ---------- */
let restInterval = null;
function formatRestSeconds(sec){
  if(sec < 60) return `${sec}s`;
  const m = Math.floor(sec/60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function formatRestTime(sec){
  const m = Math.floor(sec/60), s = sec%60;
  return m > 0 ? `${m}:${s.toString().padStart(2,'0')}` : `0:${s.toString().padStart(2,'0')}`;
}
function playFallbackBeep(){
  try{
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  }catch(e){ /* audio not available on this device/browser, ignore */ }
}
function fireTimerAlert(mode){
  if(!mode || mode === 'silent') return;
  if(mode === 'sound' || mode === 'both'){
    try{
      const audio = new Audio('sounds/rest-complete.mp3');
      audio.volume = 0.6;
      audio.play().catch(()=> playFallbackBeep());
    }catch(e){ playFallbackBeep(); }
  }
  if(mode === 'vibration' || mode === 'both'){
    if(navigator.vibrate) navigator.vibrate([150,80,150]);
  }
}
function startRest(seconds, label, alertMode){
  clearInterval(restInterval);
  let remaining = seconds;
  const bar = $("restBar");
  $("restLabel").textContent = label;
  $("restTime").textContent = formatRestTime(remaining);
  bar.classList.add('show');

  const restScreen = $("restScreen");
  if(restScreen){
    $("restScreenLabel").textContent = label;
    $("restScreenTime").textContent = formatRestTime(remaining);
    restScreen.classList.add('open');
  }

  restInterval = setInterval(()=>{
    remaining--;
    if(remaining <= 0){
      clearInterval(restInterval);
      bar.classList.remove('show');
      if(restScreen) restScreen.classList.remove('open');
      showToast("Rest over — go!");
      fireTimerAlert(alertMode);
      return;
    }
    $("restTime").textContent = formatRestTime(remaining);
    if(restScreen) $("restScreenTime").textContent = formatRestTime(remaining);
  }, 1000);
}
function skipRest(){
  clearInterval(restInterval);
  $("restBar").classList.remove('show');
  const restScreen = $("restScreen");
  if(restScreen) restScreen.classList.remove('open');
}
function extractLeadingSets(target){
  if(!target) return null;
  const m = target.match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}
function parseRepGoal(target){
  if(!target || /sec|min/i.test(target)) return null;
  const m = target.match(/[×xX]\s*(\d+)/);
  return m ? Number(m[1]) : null;
}
function advanceToNextExercise(exerciseName){
  const current = document.querySelector(`.exercise-card[data-exercise="${CSS.escape(exerciseName)}"]`);
  if(!current) return;
  const next = current.nextElementSibling;
  if(next && next.classList.contains('exercise-card')){
    const qa = next.querySelector('.quick-add');
    if(qa) qa.classList.add('open');
    next.scrollIntoView({ behavior:'smooth', block:'center' });
  } else {
    showToast("That group is done — nice work!");
  }
}

async function renderCheckinRow(week){
  const data = await getWeekData(week);
  const row = $("checkinRow");
  const metricsRow = $("checkinMetrics");
  if(!row) return;
  row.innerHTML = data.photo
    ? `<img class="checkin-thumb" id="checkinThumb" src="${data.photo}" alt="Week ${week} check-in"><button class="checkin-btn" id="checkinRetakeBtn">Retake</button>`
    : `<div class="checkin-placeholder">＋</div><button class="checkin-btn" id="checkinAddBtn">Add photo</button>`;

  if(data.photo){
    $("checkinThumb").addEventListener('click', ()=>openPhotoModal(week));
    $("checkinRetakeBtn").addEventListener('click', ()=>{ currentCheckinWeek = week; $("checkinFileInput").click(); });
  } else {
    $("checkinAddBtn").addEventListener('click', ()=>{ currentCheckinWeek = week; $("checkinFileInput").click(); });
  }

  metricsRow.innerHTML = `
    <div class="checkin-metrics">
      <input type="number" id="checkinWeight" placeholder="Weight ${unitLabel()}" inputmode="decimal" step="0.1" value="${data.weight != null ? toDisplayWeight(data.weight) : ''}">
      <input type="number" id="checkinBodyFat" placeholder="Body fat %" inputmode="decimal" step="0.1" value="${data.bodyFat ?? ''}">
      <button id="checkinSaveMetrics">Save</button>
    </div>
  `;
  $("checkinSaveMetrics").addEventListener('click', async ()=>{
    const weight = $("checkinWeight").value;
    const bodyFat = $("checkinBodyFat").value;
    const current = await getWeekData(week);
    await saveWeekData(week, { photo: current.photo, weight: weight ? toStorageWeight(weight) : null, bodyFat: bodyFat ? Number(bodyFat) : null });
    showToast("Check-in stats saved");
  });
}

async function getStripTotalWeeks(currentWeek){
  try{
    const res = await window.storage.get('progression-total-weeks');
    const stored = res && res.value ? Number(res.value) : 0;
    return Math.max(currentWeek, 6, stored);
  }catch(e){ return Math.max(currentWeek, 6); }
}
async function addStripWeek(newTotal){
  try{ await window.storage.set('progression-total-weeks', String(newTotal)); }
  catch(e){ console.error("Could not extend weeks", e); }
}
async function renderPhotoStrip(currentWeek){
  const strip = $("photoStrip");
  if(!strip) return;
  const total = await getStripTotalWeeks(currentWeek);
  strip.innerHTML = "";
  for(let w=0; w<=total; w++){
    const data = await getWeekData(w);
    const item = document.createElement('div');
    item.className = 'photo-strip-item';
    const sub = data.weight ? `${toDisplayWeight(data.weight)}${unitLabel()}` : '\u00A0';
    const wkLabel = w === 0 ? 'Start' : `Wk ${w}`;
    item.innerHTML = data.photo
      ? `<img src="${data.photo}" alt="Week ${w}"><div class="ph-label">${wkLabel} · ${sub}</div>`
      : `<div class="ph-empty">${wkLabel}</div><div class="ph-label">&nbsp;</div>`;
    item.addEventListener('click', ()=>openPhotoModal(w));
    strip.appendChild(item);
  }
  const addTile = document.createElement('div');
  addTile.className = 'photo-strip-item';
  addTile.innerHTML = `<button class="photo-strip-add" id="addWeekBtn">+</button><div class="ph-label">Add</div>`;
  addTile.querySelector('#addWeekBtn').addEventListener('click', async ()=>{
    await addStripWeek(total + 1);
    await renderPhotoStrip(currentWeek);
  });
  strip.appendChild(addTile);
}

let modalOpenWeek = null;
async function openPhotoModal(week){
  modalOpenWeek = week;
  const data = await getWeekData(week);
  const label = week === 0 ? 'Start' : `Week ${week}`;
  $("photoModalLabel").textContent = label;
  $("photoModalImageWrap").innerHTML = data.photo
    ? `<img src="${data.photo}" alt="${label} check-in">`
    : `<div class="photo-modal-noimg">No photo yet</div>`;

  $("photoModalStats").innerHTML = `
    <button class="checkin-btn" id="modalPhotoBtn">${data.photo ? 'Retake photo' : 'Add photo'}</button>
    <div class="checkin-metrics">
      <input type="number" id="modalWeight" placeholder="Weight ${unitLabel()}" inputmode="decimal" step="0.1" value="${data.weight != null ? toDisplayWeight(data.weight) : ''}">
      <input type="number" id="modalBodyFat" placeholder="Body fat %" inputmode="decimal" step="0.1" value="${data.bodyFat ?? ''}">
      <button id="modalSaveMetrics">Save</button>
    </div>
  `;

  $("modalPhotoBtn").addEventListener('click', ()=>{ currentCheckinWeek = week; $("checkinFileInput").click(); });
  $("modalSaveMetrics").addEventListener('click', async ()=>{
    const weight = $("modalWeight").value;
    const bodyFat = $("modalBodyFat").value;
    const current = await getWeekData(week);
    await saveWeekData(week, { photo: current.photo, weight: weight ? toStorageWeight(weight) : null, bodyFat: bodyFat ? Number(bodyFat) : null });
    showToast("Check-in stats saved");
    closePhotoModal();
    await renderProgression();
  });

  $("photoModal").classList.add('open');
}
function closePhotoModal(){
  $("photoModal").classList.remove('open');
  $("photoModalImageWrap").innerHTML = "";
  $("photoModalStats").innerHTML = "";
  modalOpenWeek = null;
}
async function refreshCheckinViews(week){
  if(modalOpenWeek === week) await openPhotoModal(week);
  await renderProgression();
}

function getRollingWeekDateKeys(){
  const keys = [];
  const cursor = new Date();
  for(let i=0;i<7;i++){
    keys.push(dateKey(cursor));
    cursor.setDate(cursor.getDate()-1);
  }
  return keys;
}

async function computeThisWeekStats(){
  const dateKeys = getRollingWeekDateKeys();
  let sets=0, volume=0, workouts=0;
  for(const dk of dateKeys){
    const s = await getSession(dk);
    if(s.sets.length>0){ workouts++; sets+=s.sets.length; volume+=volumeOf(s.sets); }
  }
  return { sets, volume, workouts };
}

async function computeVolumeLast8Weeks(){
  const weeks = [];
  const now = new Date();
  for(let w=7; w>=0; w--){
    let vol = 0;
    for(let d=0; d<7; d++){
      const cursor = new Date(now);
      cursor.setDate(cursor.getDate() - (w*7+d));
      const s = await getSession(dateKey(cursor));
      vol += volumeOf(s.sets);
    }
    weeks.push(Math.round(toDisplayWeight(vol)));
  }
  return weeks;
}

async function computeMuscleBreakdown(dateKeysToCheck){
  const counts = {};
  let total = 0;
  for(const dk of dateKeysToCheck){
    const s = await getSession(dk);
    s.sets.forEach(set=>{
      const d = findExerciseData(set.exercise);
      if(d && d.muscle){ counts[d.muscle] = (counts[d.muscle]||0)+1; total++; }
    });
  }
  return MUSCLE_GROUP_OPTIONS
    .map(m=>({ key:m.key, label:m.label, count: counts[m.key]||0 }))
    .filter(m=>m.count>0)
    .sort((a,b)=> b.count-a.count)
    .map(m=>({ ...m, pct: total ? Math.round((m.count/total)*100) : 0 }));
}

let volumeChartInstance = null;
async function renderProgressOverviewTab(){
  const weekStats = await computeThisWeekStats();
  $("progWeekSets").textContent = weekStats.sets;
  $("progWeekVolume").textContent = Math.round(toDisplayWeight(weekStats.volume)).toLocaleString();
  $("progWeekWorkouts").textContent = weekStats.workouts;

  const weeklyVolumes = await computeVolumeLast8Weeks();
  const canvas = $("volumeChartCanvas");
  if(canvas && window.Chart){
    const ctx = canvas.getContext('2d');
    if(volumeChartInstance) volumeChartInstance.destroy();
    volumeChartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: ['W1','W2','W3','W4','W5','W6','W7','W8'],
        datasets: [{
          data: weeklyVolumes,
          borderColor: '#8DA55A',
          backgroundColor: 'rgba(141,165,90,0.15)',
          fill: true,
          tension: 0.35,
          pointRadius: 3,
          pointBackgroundColor: '#8DA55A'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display:false } },
        scales: {
          x: { ticks:{ color:'#A1A19A', font:{ size:10 } }, grid:{ display:false } },
          y: { ticks:{ color:'#A1A19A', font:{ size:10 } }, grid:{ color:'#23231F' } }
        }
      }
    });
  }

  const rollingWeek = getRollingWeekDateKeys();
  const muscles = await computeMuscleBreakdown(rollingWeek);
  $("muscleBreakdownList").innerHTML = muscles.length
    ? muscles.map(m=>`
        <div class="mb-row">
          <div class="mb-label">${escapeHTML(m.label)}</div>
          <div class="mb-bar-track"><div class="mb-bar-fill" style="width:${m.pct}%"></div></div>
          <div class="mb-pct">${m.pct}%</div>
        </div>
      `).join('')
    : `<div class="eim-empty">Log some sets this week to see your muscle balance.</div>`;
}

async function computeTrainingBreakdown(){
  const keys = await getAllSessionKeys();
  const dateKeys = keys.map(k=>k.replace('session:',''));
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate()-30);
  const recent = dateKeys.filter(dk=> new Date(dk) >= cutoff);
  const byPlan = {};
  for(const dk of recent){
    const s = await getSession(dk);
    for(const planKey of s.plan){
      const def = await getPlanDef(planKey);
      if(!def || def.type !== 'strength') continue;
      const template = await getWorkoutTemplate(planKey);
      const exNames = new Set(template.map(e=>e.name));
      const relevantSets = s.sets.filter(set=>exNames.has(set.exercise));
      if(!byPlan[def.label]) byPlan[def.label] = { sets:0, volume:0 };
      byPlan[def.label].sets += relevantSets.length;
      byPlan[def.label].volume += volumeOf(relevantSets);
    }
  }
  return Object.entries(byPlan).map(([label,v])=>({ label, ...v })).sort((a,b)=> b.volume-a.volume);
}
async function renderProgressTrainingTab(){
  const rows = await computeTrainingBreakdown();
  $("trainingBreakdownList").innerHTML = rows.length
    ? rows.map(r=>`
        <div class="training-row">
          <div class="training-name">${escapeHTML(r.label)}</div>
          <div class="training-stats">${r.sets} sets · ${Math.round(toDisplayWeight(r.volume))} ${unitLabel()}</div>
        </div>
      `).join('')
    : `<div class="eim-empty">No training logged in the last 30 days.</div>`;
}

async function renderProgressBodyTab(){
  const total = await getStripTotalWeeks(0);
  const rows = [];
  for(let w=total; w>=0; w--){
    const data = await getWeekData(w);
    if(data.weight != null || data.bodyFat != null){
      rows.push({ week:w, weight:data.weight, bodyFat:data.bodyFat });
    }
  }
  $("bodyHistoryList").innerHTML = rows.length
    ? rows.map(r=>`
        <div class="training-row">
          <div class="training-name">${r.week===0?'Start':'Week '+r.week}</div>
          <div class="training-stats">${r.weight!=null?`${toDisplayWeight(r.weight)}${unitLabel()}`:'—'}${r.bodyFat!=null?` · ${r.bodyFat}% BF`:''}</div>
        </div>
      `).join('')
    : `<div class="eim-empty">Add weight or body-fat during a weekly check-in to see it here.</div>`;
}

let progressSubTab = 'overview';
async function switchProgressSubTab(tab){
  progressSubTab = tab;
  document.querySelectorAll('.prog-subtab').forEach(b=> b.classList.remove('active'));
  const tabBtn = $(`progSubTab_${tab}`);
  if(tabBtn) tabBtn.classList.add('active');
  document.querySelectorAll('.prog-subpanel').forEach(p=> p.style.display = 'none');
  const panel = $(`progPanel_${tab}`);
  if(panel) panel.style.display = 'block';
  if(tab === 'overview') await renderProgressOverviewTab();
  if(tab === 'training') await renderProgressTrainingTab();
  if(tab === 'body') await renderProgressBodyTab();
  if(tab === 'photos') await renderProgression();
}

async function populateCompareSelectors(){
  const total = await getStripTotalWeeks(0);
  const options = [];
  for(let w=total; w>=0; w--) options.push(w);
  const optHTML = options.map(w=>`<option value="${w}">${w===0?'Start':'Week '+w}</option>`).join('');
  $("compareWeekA").innerHTML = optHTML;
  $("compareWeekB").innerHTML = optHTML;
  if(options.length > 1){
    $("compareWeekA").value = options[1];
    $("compareWeekB").value = options[0];
  }
}
function compareDeltaArrow(a, b){
  if(a == null || b == null) return '';
  if(b < a) return '<span class="compare-arrow down">↓</span>';
  if(b > a) return '<span class="compare-arrow up">↑</span>';
  return '';
}
async function renderCompareResult(){
  const wA = Number($("compareWeekA").value);
  const wB = Number($("compareWeekB").value);
  const dataA = await getWeekData(wA);
  const dataB = await getWeekData(wB);
  const imgA = $("compareImgA");
  const imgB = $("compareImgB");
  imgA.src = dataA.photo || '';
  imgA.style.display = dataA.photo ? 'block' : 'none';
  imgB.src = dataB.photo || '';
  imgB.style.display = dataB.photo ? 'block' : 'none';
  $("compareLabelA").textContent = wA===0 ? 'Start' : 'Week '+wA;
  $("compareLabelB").textContent = wB===0 ? 'Start' : 'Week '+wB;
  $("compareStatsBody").innerHTML = `
    <div class="compare-stat-row"><span>Weight</span><span>${dataA.weight!=null?toDisplayWeight(dataA.weight):'—'}${unitLabel()}</span><span>${dataB.weight!=null?toDisplayWeight(dataB.weight):'—'}${unitLabel()} ${compareDeltaArrow(dataA.weight,dataB.weight)}</span></div>
    <div class="compare-stat-row"><span>Body fat</span><span>${dataA.bodyFat!=null?dataA.bodyFat:'—'}%</span><span>${dataB.bodyFat!=null?dataB.bodyFat:'—'}% ${compareDeltaArrow(dataA.bodyFat,dataB.bodyFat)}</span></div>
  `;
}

async function renderProgression(){
  const startStr = await getProgramStart();
  const card = $("progCard");

  if(!startStr){
    card.innerHTML = `
      <div class="prog-desc" style="margin-top:0;">Start your 6-week progression plan to track which phase you're in, and log a weekly check-in photo.</div>
      <div class="prog-start-form"><button id="startProgBtn" style="flex:1;">Start today</button></div>
    `;
    $("startProgBtn").addEventListener('click', async ()=>{
      await setProgramStart(todayKey);
      await renderProgression();
      showToast("Progression started");
    });
    return;
  }

  const week = currentWeekFromStart(startStr);
  const phase = getPhase(week);
  const filledDots = Math.min(week, 6);

  card.innerHTML = `
    <div class="prog-top">
      <div>
        <div class="prog-week">Week ${week}</div>
        <div class="prog-phase">${escapeHTML(phase.label)}</div>
      </div>
      <button class="prog-edit" id="editStartBtn">Change start date</button>
    </div>
    <div class="prog-desc">${escapeHTML(phase.desc)}</div>
    <div class="prog-dots">${[1,2,3,4,5,6].map(i=>`<div class="prog-dot ${i<=filledDots?'filled':''}"></div>`).join("")}</div>
    <div id="startEditRow"></div>
    <div class="checkin-section">
      <div class="checkin-title">Week ${week} check-in photo</div>
      <div class="checkin-row" id="checkinRow"></div>
      <div id="checkinMetrics"></div>
      <div class="photo-strip" id="photoStrip"></div>
    </div>
  `;

  $("editStartBtn").addEventListener('click', ()=>{
    const row = $("startEditRow");
    row.innerHTML = `<div class="prog-start-form"><input type="date" id="startDateInput" value="${startStr}"><button id="saveStartBtn">Save</button></div>`;
    $("saveStartBtn").addEventListener('click', async ()=>{
      const val = $("startDateInput").value;
      if(val){ await setProgramStart(val); await renderProgression(); showToast("Start date updated"); }
    });
  });

  await renderCheckinRow(week);
  await renderPhotoStrip(week);
}

/* ---------- plan picker ---------- */
async function togglePlan(planKey){
  await updateSession(todayKey, (s)=>{
    if(s.plan.includes(planKey)) s.plan = s.plan.filter(p=>p!==planKey);
    else s.plan.push(planKey);
  });
  await renderAll();
}
let workoutLibraryFilter = 'all';
let workoutLibrarySearch = '';
let exerciseLibraryMuscleFilter = null;

async function renderPlanGrid(){
  const session = await getSession(todayKey);
  const grid = $("planGrid");
  grid.innerHTML = "";
  const defs = await getAllPlanDefs();
  const filtered = defs.filter(w=>{
    const matchesFilter = workoutLibraryFilter === 'all' || w.key === workoutLibraryFilter;
    const matchesSearch = !workoutLibrarySearch || w.label.toLowerCase().includes(workoutLibrarySearch.toLowerCase());
    return matchesFilter && matchesSearch;
  });
  for(const w of filtered){
    const active = session.plan.includes(w.key);
    const exercises = w.type === 'strength' ? await getWorkoutTemplate(w.key) : (w.exercises || []);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `wl-card ${active?'active':''}`;
    card.innerHTML = `
      <div class="wl-card-icon">${w.type==='checklist' ? '🧩' : '🏋️'}</div>
      <div class="wl-card-body">
        <div class="wl-card-title">${escapeHTML(w.label)}</div>
        <div class="wl-card-sub">${escapeHTML(w.focus || '')}</div>
        <div class="wl-card-count">${exercises.length} exercise${exercises.length===1?'':'s'}</div>
      </div>
    `;
    card.addEventListener('click', ()=>togglePlan(w.key));
    grid.appendChild(card);
  }
  const addBtn = document.createElement("button");
  addBtn.type = 'button';
  addBtn.className = 'plan-btn full-width';
  addBtn.textContent = '+ Create a new workout';
  addBtn.addEventListener('click', ()=>{
    $("newWorkoutForm").style.display = 'flex';
    $("newWorkoutName").focus();
  });
  grid.appendChild(addBtn);
}

async function createNewWorkout(){
  const name = $("newWorkoutName").value.trim();
  if(!name){ showToast("Give it a name first"); return; }
  const key = await addCustomWorkout(name);
  await updateSession(todayKey, (s)=>{ if(!s.plan.includes(key)) s.plan.push(key); });
  $("newWorkoutName").value = "";
  $("newWorkoutForm").style.display = 'none';
  showToast(`"${name}" created`);
  await renderAll();
}

/* ---------- plan section ---------- */
async function planExerciseNameSet(planKeys){
  const names = new Set();
  for(const k of planKeys){
    const w = await getPlanDef(k);
    if(w && w.type === 'strength'){
      const exercises = await getWorkoutTemplate(k);
      exercises.forEach(e=>names.add(e.name));
    }
  }
  return names;
}
async function quickLog(exercise, weightVal, repsVal, targetSets){
  const reps = Number(repsVal);
  if(!reps){ showToast("Add a rep count"); return; }
  const weight = weightVal ? toStorageWeight(weightVal) : 0;
  const newSet = { id:`${Date.now()}-${Math.random().toString(36).slice(2,7)}`, exercise, weight, reps, ts: Date.now() };
  const updated = await updateSession(todayKey, (s)=>{
    if(!s.startedAt) s.startedAt = Date.now();
    s.finishedAt = null;
    s.sets.push(newSet);
  });
  await saveExerciseName(exercise);

  const prEvents = await checkAndUpdatePR(exercise, weight, reps);
  if(prEvents.length){
    await updateSession(todayKey, (s)=>{
      s.newPRs = s.newPRs || [];
      prEvents.forEach(ev => s.newPRs.push({ exercise, ...ev, ts: Date.now() }));
    });
    showToast(`🏆 New PR — ${exercise}`);
  } else {
    showToast("Set logged");
  }
  await renderAll();

  const restSeconds = getExerciseRestSeconds(exercise);
  const countForExercise = updated.sets.filter(s=>s.exercise === exercise).length;
  if(targetSets && countForExercise % targetSets === 0){
    startRest(restSeconds, "Exercise done — rest before next", userTimerAlert);
  } else {
    startRest(restSeconds, "Rest between sets", userTimerAlert);
  }
}
async function deleteSet(id){
  await updateSession(todayKey, (s)=>{ s.sets = s.sets.filter(x=>x.id !== id); });
  await renderAll();
}
async function editSet(id, weightVal, repsVal){
  const reps = Number(repsVal);
  if(!reps){ showToast("Add a rep count"); return; }
  await updateSession(todayKey, (s)=>{
    const target = s.sets.find(x=>x.id === id);
    if(target){ target.weight = weightVal ? toStorageWeight(weightVal) : 0; target.reps = reps; }
  });
  showToast("Set updated");
  await renderAll();
}
function setItemHTML(s){
  return `
    <div class="set-item" data-id="${s.id}" data-weight="${s.weight}" data-reps="${s.reps}">
      <span class="val">${toDisplayWeight(s.weight)}${unitLabel()} × ${s.reps}</span>
      <span class="set-actions">
        <button class="edit-btn" data-edit="${s.id}">Edit</button>
        <button class="del-btn" data-del="${s.id}">Remove</button>
      </span>
    </div>`;
}
function wireSetItems(container){
  container.querySelectorAll('.set-item').forEach(item=>{
    const id = item.dataset.id;
    const editBtn = item.querySelector('[data-edit]');
    const delBtn = item.querySelector('[data-del]');
    if(editBtn) editBtn.addEventListener('click', (e)=>{
      e.stopPropagation();
      const w = toDisplayWeight(Number(item.dataset.weight)), r = item.dataset.reps;
      item.innerHTML = `
        <input type="number" class="edit-weight" value="${w}" inputmode="decimal" placeholder="${unitLabel()}">
        <input type="number" class="edit-reps" value="${r}" inputmode="numeric" placeholder="reps">
        <span class="set-actions">
          <button class="edit-save">Save</button>
          <button class="edit-cancel">Cancel</button>
        </span>
      `;
      item.querySelector('.edit-save').addEventListener('click', (ev)=>{
        ev.stopPropagation();
        editSet(id, item.querySelector('.edit-weight').value, item.querySelector('.edit-reps').value);
      });
      item.querySelector('.edit-cancel').addEventListener('click', (ev)=>{ ev.stopPropagation(); renderAll(); });
    });
    if(delBtn) delBtn.addEventListener('click', (e)=>{ e.stopPropagation(); deleteSet(id); });
  });
}
async function toggleChecklistItem(name){
  await updateSession(todayKey, (s)=>{
    if(s.checklist.includes(name)) s.checklist = s.checklist.filter(x=>x!==name);
    else s.checklist.push(name);
  });
  await renderAll();
}

async function buildExerciseCard(ex, loggedSets, isCompleted){
  const card = document.createElement("div");
  card.className = `exercise-card${isCompleted ? ' completed' : ''}`;
  card.dataset.exercise = ex.name;
  const iconSvg = getIcon(ex.name) || GENERIC_ICON;
  const prev = await getPreviousPerformance(ex.name);
  const prevLabel = prev ? (prev.week ? `Wk ${prev.week}` : prettyDate(prev.date)) : null;
  const targetSetsNum = extractLeadingSets(ex.target);
  const repGoal = parseRepGoal(ex.target);
  const setNumber = targetSetsNum ? Math.min(loggedSets.length + 1, targetSetsNum) : loggedSets.length + 1;
  const lastLogged = loggedSets.length ? loggedSets[loggedSets.length - 1] : null;
  let overrideWeight = null;
  if(!lastLogged){
    try{
      const res = await window.storage.get(`weight-override:${slugify(ex.name)}`);
      if(res && res.value) overrideWeight = Number(res.value);
    }catch(e){ /* ignore */ }
  }
  const weightDefault = lastLogged ? toDisplayWeight(lastLogged.weight) : (overrideWeight != null ? toDisplayWeight(overrideWeight) : (ex.weight != null ? toDisplayWeight(ex.weight) : (prev ? toDisplayWeight(prev.weight) : '')));

  const bodyHTML = repGoal
    ? `
      <div class="rep-tap-panel">
        <div class="rep-tap-setlabel">Set ${setNumber}${targetSetsNum ? ` of ${targetSetsNum}` : ''} · ${repGoal} reps</div>
        <input type="number" inputmode="decimal" placeholder="Weight kg" class="qa-weight" min="0" step="0.5" value="${weightDefault}">
        <button type="button" class="rep-tap-btn">
          <span class="rep-tap-count">Tap to log set</span>
          <div class="rep-tap-hint">${repGoal} reps at this weight</div>
        </button>
      </div>
      ${loggedSets.map(setItemHTML).join("")}
    `
    : `
      <div class="quick-add-row">
        <input type="number" inputmode="decimal" placeholder="Weight kg" class="qa-weight" min="0" step="0.5" value="${weightDefault}">
        <input type="number" inputmode="numeric" placeholder="Reps" class="qa-reps" min="1" step="1">
        <button class="qa-log">Log</button>
      </div>
      ${loggedSets.map(setItemHTML).join("")}
    `;

  card.innerHTML = `
    <div class="exercise-row" data-toggle>
      <div class="ex-icon-wrap" data-zoom>${iconSvg}</div>
      <div class="exercise-info">
        <div class="exercise-name">${escapeHTML(ex.name)}</div>
        <div class="exercise-target">${escapeHTML(ex.target)}${ex.weight != null ? ` · ${toDisplayWeight(ex.weight)}${unitLabel()}` : ''} · Rest ${formatRestSeconds(getExerciseRestSeconds(ex.name))}</div>
        ${ex.note ? `<div class="exercise-note">${escapeHTML(ex.note)}</div>` : ``}
        ${prev ? `<div class="exercise-prev">Previous (${escapeHTML(prevLabel)}): <b>${toDisplayWeight(prev.weight)}${unitLabel()} × ${prev.reps}</b></div>` : ``}
        <div class="tally">${tallySVG(loggedSets.length)}<span class="tally-count">${loggedSets.length} logged</span></div>
      </div>
      <div class="exercise-side">
        <div class="exercise-meta">${Math.round(toDisplayWeight(volumeOf(loggedSets)))} ${unitLabel()} vol</div>
        <button type="button" class="exercise-complete-btn ${isCompleted ? 'done' : ''}" data-complete="${escapeHTML(ex.name)}">${isCompleted ? '✓ Done' : 'Complete'}</button>
      </div>
    </div>
    <div class="quick-add">${bodyHTML}</div>
  `;
  card.querySelector('[data-toggle]').addEventListener('click', ()=>{ card.querySelector('.quick-add').classList.toggle('open'); });
  card.querySelector('.exercise-complete-btn').addEventListener('click', (e)=>{
    e.stopPropagation();
    toggleExerciseComplete(ex.name);
  });
  const zoomWrap = card.querySelector('[data-zoom]');
  const zoomImg = zoomWrap.querySelector('img');
  if(zoomImg){
    zoomWrap.addEventListener('click', (e)=>{
      e.stopPropagation();
      openExerciseImageModal(zoomImg.src, ex.name);
    });
  }

  if(repGoal){
    const tapBtn = card.querySelector('.rep-tap-btn');
    tapBtn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      if(tapBtn.disabled) return;
      tapBtn.disabled = true;
      const weight = card.querySelector('.qa-weight').value;
      await quickLog(ex.name, weight, repGoal, targetSetsNum);
      if(targetSetsNum){
        const freshSession = await getSession(todayKey);
        const countNow = freshSession.sets.filter(s=>s.exercise === ex.name).length;
        if(countNow % targetSetsNum === 0){
          const isAlreadyDone = (freshSession.completed || []).includes(ex.name);
          if(!isAlreadyDone){
            await updateSession(todayKey, (s)=>{
              s.completed = s.completed || [];
              s.completed.push(ex.name);
            });
            await renderAll();
          }
          advanceToNextExercise(ex.name);
          if(!isAlreadyDone) await checkProgressiveOverload(ex.name);
        }
      }
    });
  } else {
    card.querySelector('.qa-log').addEventListener('click', (e)=>{
      e.stopPropagation();
      quickLog(ex.name, card.querySelector('.qa-weight').value, card.querySelector('.qa-reps').value, targetSetsNum);
    });
  }
  wireSetItems(card);
  return card;
}

async function toggleExerciseComplete(name){
  const session = await getSession(todayKey);
  const isDone = (session.completed || []).includes(name);
  await updateSession(todayKey, (s)=>{
    s.completed = s.completed || [];
    s.completed = isDone ? s.completed.filter(n=>n!==name) : [...s.completed, name];
  });
  await renderAll();
  if(!isDone){
    advanceToNextExercise(name);
    await checkProgressiveOverload(name);
  }
}

async function renderPlanSection(){
  const session = await getSession(todayKey);
  const container = $("planSection");
  const grouped = groupByExercise(session.sets);
  const customList = await getCustomWorkouts();
  const orderedKeys = [...PLAN_ORDER, ...customList.map(c=>c.key)];
  const activePlans = orderedKeys.filter(k=>session.plan.includes(k));
  const profile = await getProfile();

  if(activePlans.length === 0){
    container.innerHTML = "";
    $("extrasTitle").textContent = "Today";
    return;
  }
  $("extrasTitle").textContent = "Extra sets";
  container.innerHTML = "";

  for(const key of activePlans){
    const w = await getPlanDef(key);
    if(!w) continue;
    const group = document.createElement("div");
    group.className = "plan-group";

    if(w.type === 'checklist'){
      group.innerHTML = `
        <div class="plan-group-header">
          <div class="plan-group-header-top">
            <div class="plan-group-title">${escapeHTML(w.label)}</div>
            <button class="group-edit-btn" data-group-edit="${key}">Delete</button>
          </div>
        </div>
      `;
      const delBtn = group.querySelector('.group-edit-btn');
      delBtn.addEventListener('click', async ()=>{
        if(delBtn.dataset.armed !== '1'){
          delBtn.dataset.armed = '1';
          delBtn.classList.add('group-edit-btn-delete');
          delBtn.textContent = 'Tap again to confirm';
          setTimeout(()=>{ if(delBtn.dataset.armed === '1'){ delBtn.dataset.armed = '0'; delBtn.classList.remove('group-edit-btn-delete'); delBtn.textContent = 'Delete'; } }, 4000);
          return;
        }
        await deleteWorkout(key);
      });
      const checklistExercises = (key === 'warmup') ? getWarmupExercises(profile) : w.exercises;
      checklistExercises.forEach(raw=>{
        const { name, detail } = normalizeChecklistItem(raw);
        const done = session.checklist.includes(name);
        const item = document.createElement("div");
        item.className = `checklist-item ${done?'done':''}`;
        const iconSvg = getIcon(name) || GENERIC_ICON;
        item.innerHTML = `
          <div class="ex-icon-wrap" data-zoom>${iconSvg}</div>
          <div class="checklist-label-wrap">
            <div class="checklist-label">${escapeHTML(name)}</div>
            ${detail ? `<div class="checklist-detail">${escapeHTML(detail)}</div>` : ``}
          </div>
          <div class="checkbox"><svg viewBox="0 0 24 24" fill="none"><path d="M4 12l5 5L20 6" stroke="#15140F" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        `;
        item.addEventListener('click', ()=>toggleChecklistItem(name));
        const zoomWrap = item.querySelector('[data-zoom]');
        const zoomImg = zoomWrap.querySelector('img');
        if(zoomImg){
          zoomWrap.addEventListener('click', (e)=>{
            e.stopPropagation();
            openExerciseImageModal(zoomImg.src, name);
          });
        }
        group.appendChild(item);
      });
    } else if(w.type === 'strength'){
      const exercises = await getWorkoutTemplate(key);
      if(exercises.length === 0) editingGroups.add(key);
      const isEditing = editingGroups.has(key);
      const toggleLabel = isEditing ? 'Delete' : 'Edit';
      const isCustom = key.startsWith('custom-');
      group.innerHTML = `
        <div class="plan-group-header">
          <div class="plan-group-header-top">
            <div class="plan-group-title-wrap">
              <div class="plan-group-title-row">
                <div class="plan-group-title">${escapeHTML(w.label)}</div>
                ${isCustom ? `<button type="button" class="plan-group-rename-btn" data-rename="${key}" aria-label="Rename">✎</button>` : ``}
              </div>
              <div class="plan-group-focus">${escapeHTML(w.focus)}</div>
              <div class="plan-group-rename-form" id="renameForm-${key}" style="display:none;">
                <input type="text" class="plan-group-rename-input" value="${escapeHTML(w.label)}">
                <button type="button" class="plan-group-rename-save" data-save-rename="${key}">Save</button>
                <button type="button" class="plan-group-rename-cancel" data-cancel-rename="${key}">Cancel</button>
              </div>
            </div>
            <button class="group-edit-btn ${isEditing ? 'group-edit-btn-delete' : ''}" data-group-edit="${key}">${toggleLabel}</button>
          </div>
        </div>
      `;
      if(isCustom){
        const renameBtn = group.querySelector('.plan-group-rename-btn');
        const renameForm = group.querySelector(`#renameForm-${key}`);
        const titleRow = group.querySelector('.plan-group-title-row');
        renameBtn.addEventListener('click', ()=>{
          titleRow.style.display = 'none';
          group.querySelector('.plan-group-focus').style.display = 'none';
          renameForm.style.display = 'flex';
          renameForm.querySelector('input').focus();
        });
        renameForm.querySelector('[data-save-rename]').addEventListener('click', async ()=>{
          const newLabel = renameForm.querySelector('input').value.trim();
          if(!newLabel){ showToast("Name can't be empty"); return; }
          await renameCustomWorkout(key, newLabel);
          showToast("Workout renamed");
          await renderPlanSection();
        });
        renameForm.querySelector('[data-cancel-rename]').addEventListener('click', ()=>{
          titleRow.style.display = 'flex';
          group.querySelector('.plan-group-focus').style.display = 'block';
          renameForm.style.display = 'none';
        });
      }
      const editBtn = group.querySelector('.group-edit-btn');
      if(editBtn) editBtn.addEventListener('click', async ()=>{
        if(isEditing){
          if(editBtn.dataset.armed !== '1'){
            editBtn.dataset.armed = '1';
            editBtn.textContent = 'Tap again to confirm';
            setTimeout(()=>{ if(editBtn.dataset.armed === '1'){ editBtn.dataset.armed = '0'; editBtn.textContent = 'Delete'; } }, 4000);
            return;
          }
          await deleteWorkout(key);
          return;
        }
        if(editingGroups.has(key)) editingGroups.delete(key); else editingGroups.add(key);
        await renderPlanSection();
      });

      if(isEditing){
        const profile = await getProfile();
        group.appendChild(buildTemplateEditor(key, exercises, profile.equipment));
      } else {
        const presentMuscles = new Set();
        exercises.forEach(ex=>{
          const d = findExerciseData(ex.name);
          if(d && d.muscle) presentMuscles.add(d.muscle);
        });
        if(presentMuscles.size > 1){
          const filterRow = document.createElement('div');
          filterRow.className = 'muscle-filter-row';
          const allChip = document.createElement('button');
          allChip.type = 'button';
          allChip.className = `muscle-filter-chip ${!exerciseLibraryMuscleFilter ? 'active' : ''}`;
          allChip.textContent = 'All';
          allChip.addEventListener('click', async ()=>{ exerciseLibraryMuscleFilter = null; await renderPlanSection(); });
          filterRow.appendChild(allChip);
          MUSCLE_GROUP_OPTIONS.filter(m=>presentMuscles.has(m.key)).forEach(m=>{
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = `muscle-filter-chip ${exerciseLibraryMuscleFilter===m.key ? 'active' : ''}`;
            chip.textContent = m.label;
            chip.addEventListener('click', async ()=>{ exerciseLibraryMuscleFilter = m.key; await renderPlanSection(); });
            filterRow.appendChild(chip);
          });
          group.appendChild(filterRow);
        }
        for(const ex of exercises){
          const d = findExerciseData(ex.name);
          if(exerciseLibraryMuscleFilter && (!d || d.muscle !== exerciseLibraryMuscleFilter)) continue;
          const logged = grouped.get(ex.name) || [];
          const isCompleted = (session.completed || []).includes(ex.name);
          const card = await buildExerciseCard(ex, logged, isCompleted);
          group.appendChild(card);
        }
      }
    }
    container.appendChild(group);
  }
}

function makeSortable(container, itemSelector){
  let dragEl = null;
  container.addEventListener('pointerdown', (e)=>{
    const handle = e.target.closest('.drag-handle');
    if(!handle) return;
    const item = handle.closest(itemSelector);
    if(!item) return;
    e.preventDefault();
    dragEl = item;
    dragEl.classList.add('dragging');
    try{ handle.setPointerCapture(e.pointerId); }catch(err){ /* ignore */ }

    const onMove = (ev)=>{
      if(!dragEl) return;
      const items = [...container.querySelectorAll(itemSelector)].filter(i=>i!==dragEl);
      const y = ev.clientY;
      for(const it of items){
        const rect = it.getBoundingClientRect();
        if(y > rect.top && y < rect.bottom){
          if(y < rect.top + rect.height/2) container.insertBefore(dragEl, it);
          else container.insertBefore(dragEl, it.nextSibling);
          break;
        }
      }
    };
    const onUp = ()=>{
      if(dragEl) dragEl.classList.remove('dragging');
      dragEl = null;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}

function buildTemplateEditor(key, exercises, equipmentKeys){
  const wrap = document.createElement('div');
  wrap.className = 'template-editor';

  const makeRow = (name, target, note, weight)=>{
    const row = document.createElement('div');
    row.className = 'template-row';
    row.innerHTML = `
      <span class="drag-handle" aria-label="Drag to reorder">⠿</span>
      <input class="t-name" value="${escapeHTML(name)}" placeholder="Exercise name">
      <input class="t-target" value="${escapeHTML(target)}" placeholder="e.g. 3 × 12">
      <input class="t-weight" type="number" inputmode="decimal" min="0" step="0.5" value="${weight != null ? weight : ''}" placeholder="kg">
      <button class="t-remove" type="button">✕</button>
    `;
    row.querySelector('.t-remove').addEventListener('click', ()=> row.remove());
    return row;
  };

  exercises.forEach(ex=> wrap.appendChild(makeRow(ex.name, ex.target || '', ex.note || '', ex.weight)));

  const addRow = document.createElement('div');
  addRow.className = 'template-row template-add-row';
  addRow.innerHTML = `
    <input class="t-name" placeholder="New exercise name" list="exerciseOptions" autocomplete="off">
    <input class="t-target" placeholder="e.g. 3 × 12">
    <input class="t-weight" type="number" inputmode="decimal" min="0" step="0.5" placeholder="kg">
    <button class="t-add" type="button">Add</button>
  `;
  addRow.querySelector('.t-add').addEventListener('click', ()=>{
    const name = addRow.querySelector('.t-name').value.trim();
    const target = addRow.querySelector('.t-target').value.trim();
    const weight = addRow.querySelector('.t-weight').value;
    if(!name || !target){ showToast("Add a name and target"); return; }
    wrap.insertBefore(makeRow(name, target, '', weight ? Number(weight) : null), addRow);
    addRow.querySelector('.t-name').value = '';
    addRow.querySelector('.t-target').value = '';
    addRow.querySelector('.t-weight').value = '';
  });

  const availableExercises = getAvailableExercises(equipmentKeys);
  if(availableExercises.length){
    const pickerHint = document.createElement('div');
    pickerHint.className = 'profile-hint';
    pickerHint.style.marginBottom = '6px';
    pickerHint.textContent = 'Filter by muscle, or tap an exercise from your equipment to add it:';
    wrap.appendChild(pickerHint);

    const presentMuscles = new Set(availableExercises.map(ex=>{
      const data = findExerciseData(ex.name);
      return data && data.muscle ? data.muscle : null;
    }).filter(Boolean));

    let activeMuscle = null;
    const muscleFilterRow = document.createElement('div');
    muscleFilterRow.className = 'muscle-filter-row';
    MUSCLE_GROUP_OPTIONS.filter(m=>presentMuscles.has(m.key)).forEach(m=>{
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'muscle-filter-chip';
      btn.dataset.muscle = m.key;
      btn.textContent = m.label;
      muscleFilterRow.appendChild(btn);
    });
    wrap.appendChild(muscleFilterRow);

    const picker = document.createElement('div');
    picker.className = 'exercise-picker';
    availableExercises.forEach(ex=>{
      const found = findExerciseImage(ex.name);
      const folder = found ? (IMAGE_FOLDERS[found.libKey] || found.libKey) : '';
      const src = found ? `${EXERCISE_IMAGE_BASE}${folder}/${found.img}` : '';
      const data = findExerciseData(ex.name);
      const muscle = data && data.muscle ? data.muscle : '';
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'exercise-picker-chip';
      chip.dataset.name = ex.name;
      chip.dataset.muscle = muscle;
      chip.innerHTML = `<img src="${src}" alt="${escapeHTML(ex.name)}"><span class="epc-label">${escapeHTML(ex.name)}</span>`;
      chip.addEventListener('click', ()=>{
        addRow.querySelector('.t-name').value = ex.name;
        if(!addRow.querySelector('.t-target').value) addRow.querySelector('.t-target').value = '3 × 12';
        addRow.querySelector('.t-target').focus();
      });
      chip.querySelector('img').addEventListener('click', (e)=>{
        e.stopPropagation();
        openExerciseImageModal(src, ex.name);
      });
      picker.appendChild(chip);
    });
    wrap.appendChild(picker);

    function applyFilters(){
      const query = addRow.querySelector('.t-name').value;
      const chips = [...picker.querySelectorAll('.exercise-picker-chip')];
      chips.forEach(chip=>{
        const matchesMuscle = !activeMuscle || chip.dataset.muscle === activeMuscle;
        if(!matchesMuscle){ chip.style.display = 'none'; chip.style.order=''; return; }
        if(!query.trim()){ chip.style.display=''; chip.style.order=''; return; }
        const score = fuzzyScore(query, chip.dataset.name);
        if(score < 0){ chip.style.display = 'none'; }
        else { chip.style.display = ''; chip.style.order = String(1000 - Math.round(score)); }
      });
    }

    muscleFilterRow.querySelectorAll('.muscle-filter-chip').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        activeMuscle = activeMuscle === btn.dataset.muscle ? null : btn.dataset.muscle;
        muscleFilterRow.querySelectorAll('.muscle-filter-chip').forEach(b=>{
          b.classList.toggle('active', b.dataset.muscle === activeMuscle);
        });
        applyFilters();
      });
    });

    addRow.querySelector('.t-name').addEventListener('input', applyFilters);
  }

  wrap.appendChild(addRow);
  makeSortable(wrap, '.template-row:not(.template-add-row)');

  const actions = document.createElement('div');
  actions.className = 'template-actions';
  actions.innerHTML = `
    <button class="template-save" type="button">Save changes</button>
    <button class="template-cancel" type="button">Cancel</button>
  `;
  actions.querySelector('.template-save').addEventListener('click', async ()=>{
    const rows = [...wrap.querySelectorAll('.template-row:not(.template-add-row)')];
    const newExercises = rows.map(r=>{
      const w = r.querySelector('.t-weight').value;
      return {
        name: r.querySelector('.t-name').value.trim(),
        target: r.querySelector('.t-target').value.trim(),
        weight: w ? Number(w) : null
      };
    }).filter(e=>e.name && e.target);
    if(newExercises.length === 0){ showToast("Add at least one exercise"); return; }
    await saveWorkoutTemplate(key, newExercises);
    editingGroups.delete(key);
    showToast("Workout updated");
    await renderPlanSection();
  });
  actions.querySelector('.template-cancel').addEventListener('click', async ()=>{
    editingGroups.delete(key);
    await renderPlanSection();
  });
  wrap.appendChild(actions);
  return wrap;
}

/* ---------- extras ---------- */
async function renderExtras(){
  const session = await getSession(todayKey);
  const planNames = await planExerciseNameSet(session.plan);
  const extraSets = session.sets.filter(s=>!planNames.has(s.exercise));
  const container = $("todayList");
  const title = $("extrasTitle");

  if(extraSets.length === 0){
    title.style.display = 'none';
    container.innerHTML = "";
    return;
  }
  title.style.display = 'flex';

  const grouped = groupByExercise(extraSets);
  container.innerHTML = "";
  grouped.forEach((exSets, name)=>{
    const card = document.createElement("div");
    card.className = "exercise-card";
    const vol = volumeOf(exSets);
    card.innerHTML = `
      <div class="exercise-row" data-toggle>
        <div class="ex-icon-wrap">${getIcon(name) || GENERIC_ICON}</div>
        <div class="exercise-info">
          <div class="exercise-name">${escapeHTML(name)}</div>
          <div class="tally">${tallySVG(exSets.length)}<span class="tally-count">${exSets.length} set${exSets.length===1?'':'s'}</span></div>
        </div>
        <div class="exercise-meta">${Math.round(toDisplayWeight(vol))} ${unitLabel()} vol</div>
      </div>
      <div class="quick-add">
        ${exSets.map(setItemHTML).join("")}
      </div>
    `;
    card.querySelector('[data-toggle]').addEventListener('click', ()=>{ card.querySelector('.quick-add').classList.toggle('open'); });
    wireSetItems(card);
    container.appendChild(card);
  });
}

/* ---------- stats + history ---------- */
async function renderStats(){
  const session = await getSession(todayKey);
  $("statSets").textContent = session.sets.length;
  $("statVolume").textContent = Math.round(toDisplayWeight(volumeOf(session.sets)));
  $("statVolumeLabel").textContent = `Volume (${unitLabel()})`;
}
async function updateStreak(){
  const keys = await getAllSessionKeys();
  const dateKeys = keys.map(k=>k.replace('session:','')).filter(k=>k !== todayKey).sort((a,b)=> b.localeCompare(a));
  const todaySession = await getSession(todayKey);

  const allActiveKeys = [];
  for(const key of dateKeys.slice(0,60)){
    const s = await getSession(key);
    if(s.sets.length > 0) allActiveKeys.push({key, sets:s.sets});
  }

  const allKeys = new Set([todayKey, ...allActiveKeys.map(x=>x.key)]);
  let streak = 0;
  let cursor = new Date(...todayKey.split("-").map((v,i)=> i===1 ? Number(v)-1 : Number(v)));
  while(true){
    const key = dateKey(cursor);
    if(allKeys.has(key)){
      const sets = key === todayKey ? todaySession.sets : (allActiveKeys.find(x=>x.key===key)||{}).sets;
      if(sets && sets.length > 0){ streak++; cursor.setDate(cursor.getDate()-1); continue; }
    }
    break;
  }
  $("statStreak").textContent = streak;
}
/* ---------- workout timer ---------- */
let workoutTimerInterval = null;
let workoutTimerStartedAt = null;
async function updateWorkoutBar(){
  const session = await getSession(todayKey);
  const bar = $("workoutBar");
  if(session.startedAt && !session.finishedAt){
    bar.style.display = 'flex';
    if(workoutTimerStartedAt !== session.startedAt){
      workoutTimerStartedAt = session.startedAt;
      clearInterval(workoutTimerInterval);
      const tick = ()=>{ $("workoutTimerText").textContent = formatDuration(Date.now() - session.startedAt); };
      tick();
      workoutTimerInterval = setInterval(tick, 1000);
    }
  } else {
    bar.style.display = 'none';
    clearInterval(workoutTimerInterval);
    workoutTimerInterval = null;
    workoutTimerStartedAt = null;
  }
}

/* ---------- finish workout ---------- */
async function handleFinishWorkout(){
  const session = await getSession(todayKey);
  if(!session.startedAt){ showToast("Log a set first"); return; }
  const duration = Date.now() - session.startedAt;
  const totalSets = session.sets.length;
  const exNames = new Set(session.sets.map(s=>s.exercise));
  (session.completed || []).forEach(name=>exNames.add(name));
  const uniqueExercises = exNames.size;
  const totalVolume = volumeOf(session.sets);
  const prs = session.newPRs || [];

  selectedMood = null;
  $("finishModalBody").innerHTML = `
    <div class="finish-stat-grid">
      <div class="finish-stat"><div class="finish-stat-num">${formatDuration(duration)}</div><div class="finish-stat-lbl">Duration</div></div>
      <div class="finish-stat"><div class="finish-stat-num">${totalSets}</div><div class="finish-stat-lbl">Total sets</div></div>
      <div class="finish-stat"><div class="finish-stat-num">${uniqueExercises}</div><div class="finish-stat-lbl">Exercises</div></div>
      <div class="finish-stat"><div class="finish-stat-num">${Math.round(toDisplayWeight(totalVolume))}</div><div class="finish-stat-lbl">Volume (${unitLabel()})</div></div>
    </div>
    ${prs.length
      ? `<div class="finish-pr-title">🏆 New personal records</div>${prs.map(p=>`<div class="finish-pr-item">${escapeHTML(p.exercise)}<br>${escapeHTML(p.detail)}</div>`).join("")}`
      : `<div class="finish-pr-title" style="color:var(--text-dim);">No new PRs this time — still solid work.</div>`}
    <div class="mood-label">How was your workout?</div>
    <div class="mood-row" id="moodRow">
      <button type="button" class="mood-btn" data-mood="1">😞</button>
      <button type="button" class="mood-btn" data-mood="2">🙁</button>
      <button type="button" class="mood-btn" data-mood="3">😐</button>
      <button type="button" class="mood-btn" data-mood="4">🙂</button>
      <button type="button" class="mood-btn" data-mood="5">😄</button>
    </div>
  `;
  $("moodRow").querySelectorAll('.mood-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      selectedMood = Number(btn.dataset.mood);
      $("moodRow").querySelectorAll('.mood-btn').forEach(b=> b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  $("finishModal").classList.add('open');
}
async function saveFinishedWorkout(){
  await updateSession(todayKey, (s)=>{ s.finishedAt = Date.now(); s.mood = selectedMood; });
  $("finishModal").classList.remove('open');
  await renderAll();
  showToast("Workout saved 💪");
}

/* ---------- copy previous workout ---------- */
async function findPreviousPlanDay(){
  const keys = await getAllSessionKeys();
  const dateKeys = keys.map(k=>k.replace('session:','')).filter(k=>k !== todayKey).sort((a,b)=> b.localeCompare(a));
  for(const key of dateKeys){
    const s = await getSession(key);
    if(s.plan && s.plan.length) return s.plan;
  }
  return null;
}
async function renderRepeatButton(){
  const session = await getSession(todayKey);
  const btn = $("repeatWorkoutBtn");
  if(session.plan.length){ btn.style.display = 'none'; return; }
  const prevPlan = await findPreviousPlanDay();
  btn.style.display = prevPlan ? 'block' : 'none';
  btn.onclick = async ()=>{
    await updateSession(todayKey, (s)=>{ s.plan = prevPlan; });
    showToast("Loaded previous workout");
    await renderAll();
  };
}

/* ---------- render all ---------- */
async function renderAll(){
  await refreshUserSettingsCache();
  await renderPlanGrid();
  await renderPlanSection();
  await renderExtras();
  await renderStats();
  await updateStreak();
  await renderRepeatButton();
  await updateWorkoutBar();
  await renderHomeWorkoutCard();
}

let splashProgressInterval = null;
function startSplashProgress(){
  const fill = document.getElementById('splashProgressFill');
  if(!fill) return;
  let pct = 0;
  splashProgressInterval = setInterval(()=>{
    pct = Math.min(90, pct + Math.random()*8);
    fill.style.width = pct + '%';
  }, 180);
}
function hideSplashScreen(){
  const fill = document.getElementById('splashProgressFill');
  clearInterval(splashProgressInterval);
  if(fill) fill.style.width = '100%';
  const splash = document.getElementById('splashScreen');
  setTimeout(()=>{
    if(splash){
      splash.classList.add('hide');
      setTimeout(()=> splash.remove(), 300);
    }
    document.body.classList.remove('splash-active');
  }, 250);
}

async function init(){
  document.body.classList.add('splash-active');
  startSplashProgress();
  const now = new Date();
  todayKey = dateKey(now);
  $("todayLabel").textContent = now.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' });

  await loadExerciseData();
  await loadExerciseNames();
  await renderGreeting();
  renderFocusTip();
  await renderProgression();
  await renderAll();

  $("photoModalClose").addEventListener('click', closePhotoModal);
  $("photoModal").addEventListener('click', (e)=>{ if(e.target.id === 'photoModal') closePhotoModal(); });
  $("restSkip").addEventListener('click', skipRest);

  $("exerciseImageModalClose").addEventListener('click', closeExerciseImageModal);
  $("exerciseImageModal").addEventListener('click', (e)=>{ if(e.target.id === 'exerciseImageModal') closeExerciseImageModal(); });

  $("recapBanner").addEventListener('click', handleRecapBannerTap);
  $("recapModalClose").addEventListener('click', ()=> $("recapModal").classList.remove('open'));
  $("recapModal").addEventListener('click', (e)=>{ if(e.target.id === 'recapModal') $("recapModal").classList.remove('open'); });

  await checkForMonthlyRecap();
  $("overloadModalClose").addEventListener('click', closeOverloadModal);
  $("overloadNotNowBtn").addEventListener('click', closeOverloadModal);
  $("overloadIncreaseBtn").addEventListener('click', acceptOverload);
  $("overloadModal").addEventListener('click', (e)=>{ if(e.target.id === 'overloadModal') closeOverloadModal(); });

  $("avatarBtn").addEventListener('click', ()=>{
    $("profileModal").classList.remove('tab-page');
    openProfileModal();
  });
  $("bellBtn").addEventListener('click', ()=> showToast("No new notifications yet"));

  $("workoutSearchInput").addEventListener('input', async (e)=>{
    workoutLibrarySearch = e.target.value;
    await renderPlanGrid();
  });
  document.querySelectorAll('#workoutFilterRow .muscle-filter-chip').forEach(chip=>{
    chip.addEventListener('click', async ()=>{
      document.querySelectorAll('#workoutFilterRow .muscle-filter-chip').forEach(c=> c.classList.remove('active'));
      chip.classList.add('active');
      workoutLibraryFilter = chip.dataset.filter;
      await renderPlanGrid();
    });
  });

  document.querySelectorAll('.prog-subtab').forEach(btn=>{
    btn.addEventListener('click', ()=> switchProgressSubTab(btn.dataset.tab));
  });

  $("openCompareBtn").addEventListener('click', async ()=>{
    await populateCompareSelectors();
    await renderCompareResult();
    $("compareModal").classList.add('open');
  });
  $("compareModalClose").addEventListener('click', ()=> $("compareModal").classList.remove('open'));
  $("compareModal").addEventListener('click', (e)=>{ if(e.target.id === 'compareModal') $("compareModal").classList.remove('open'); });
  $("compareWeekA").addEventListener('change', renderCompareResult);
  $("compareWeekB").addEventListener('change', renderCompareResult);

  $("wssBackBtn").addEventListener('click', closeWorkoutSession);

  $("loggingBackBtn").addEventListener('click', async ()=>{
    closeLoggingScreen();
    await renderWorkoutSessionOverview();
  });
  $("loggingGuideBtn").addEventListener('click', ()=>{
    if(!loggingScreenExercise) return;
    const found = findExerciseImage(loggingScreenExercise.name);
    const folder = found ? (IMAGE_FOLDERS[found.libKey] || found.libKey) : '';
    const src = found ? `${EXERCISE_IMAGE_BASE}${folder}/${found.img}` : '';
    openExerciseImageModal(src, loggingScreenExercise.name);
  });
  $("loggingRepsMinus").addEventListener('click', async ()=>{ loggingScreenReps = Math.max(1, loggingScreenReps-1); await renderLoggingScreen(); });
  $("loggingRepsPlus").addEventListener('click', async ()=>{ loggingScreenReps++; await renderLoggingScreen(); });
  $("loggingWeightMinus").addEventListener('click', async ()=>{
    const step = userUnits==='lbs' ? 5 : 2.5;
    loggingScreenWeight = Math.max(0, Math.round((loggingScreenWeight-step)*100)/100);
    await renderLoggingScreen();
  });
  $("loggingWeightPlus").addEventListener('click', async ()=>{
    const step = userUnits==='lbs' ? 5 : 2.5;
    loggingScreenWeight = Math.round((loggingScreenWeight+step)*100)/100;
    await renderLoggingScreen();
  });
  $("loggingLogSetBtn").addEventListener('click', async ()=>{
    const ex = loggingScreenExercise;
    if(!ex) return;
    const targetSetsNum = extractLeadingSets(ex.target);
    await quickLog(ex.name, loggingScreenWeight, loggingScreenReps, targetSetsNum);
    const session = await getSession(todayKey);
    const loggedCount = session.sets.filter(s=>s.exercise===ex.name).length;
    if(targetSetsNum && loggedCount >= targetSetsNum){
      await updateSession(todayKey, (s)=>{
        s.completed = s.completed || [];
        if(!s.completed.includes(ex.name)) s.completed.push(ex.name);
      });
      await checkProgressiveOverload(ex.name);
      closeLoggingScreen();
      await renderWorkoutSessionOverview();
    } else {
      loggingScreenSetIndex++;
      await renderLoggingScreen();
    }
  });

  $("restScreenSkipX").addEventListener('click', skipRest);
  $("restScreenSkipBtn").addEventListener('click', skipRest);

  $("qaWorkoutsBtn").addEventListener('click', ()=>{
    setActiveTab('tabWorkoutsBtn');
    showAppPage('workoutsPage');
  });
  $("qaLibraryBtn").addEventListener('click', ()=>{
    showToast("Exercise Library is coming soon");
    setActiveTab('tabWorkoutsBtn');
    showAppPage('workoutsPage');
  });
  $("qaNewWorkoutBtn").addEventListener('click', ()=>{
    setActiveTab('tabWorkoutsBtn');
    showAppPage('workoutsPage');
    $("newWorkoutForm").style.display = 'flex';
    $("newWorkoutName").focus();
  });

  function setActiveTab(id){
    document.querySelectorAll('.tab-btn').forEach(b=> b.classList.remove('active'));
    const btn = $(id);
    if(btn) btn.classList.add('active');
  }
  function showAppPage(pageId){
    document.querySelectorAll('.app-page').forEach(p=> p.classList.remove('active'));
    const target = $(pageId);
    if(target) target.classList.add('active');
    window.scrollTo({ top:0, behavior:'auto' });
  }
  $("tabHomeBtn").addEventListener('click', ()=>{
    setActiveTab('tabHomeBtn');
    $("profileModal").classList.remove('open');
    $("profileModal").classList.remove('tab-page');
    showAppPage('homePage');
  });
  $("tabWorkoutsBtn").addEventListener('click', ()=>{
    setActiveTab('tabWorkoutsBtn');
    $("profileModal").classList.remove('open');
    $("profileModal").classList.remove('tab-page');
    showAppPage('workoutsPage');
  });
  $("tabProgressBtn").addEventListener('click', async ()=>{
    setActiveTab('tabProgressBtn');
    $("profileModal").classList.remove('open');
    $("profileModal").classList.remove('tab-page');
    showAppPage('progressPage');
    await switchProgressSubTab('overview');
  });
  $("tabYouBtn").addEventListener('click', ()=>{
    setActiveTab('tabYouBtn');
    document.querySelectorAll('.app-page').forEach(p=> p.classList.remove('active'));
    profileView = 'hub';
    $("profileModal").classList.add('tab-page');
    $("profileModal").classList.add('open');
    renderProfileModal();
  });
  $("profileModalClose").addEventListener('click', ()=>{
    closeProfileModal();
    setActiveTab('tabHomeBtn');
    showAppPage('homePage');
  });
  $("profileModal").addEventListener('click', (e)=>{
    if(e.target.id === 'profileModal' && !$("profileModal").classList.contains('tab-page')){
      closeProfileModal();
    }
  });

  $("finishWorkoutBtn").addEventListener('click', handleFinishWorkout);
  $("finishModalClose").addEventListener('click', ()=> $("finishModal").classList.remove('open'));
  $("finishModal").addEventListener('click', (e)=>{ if(e.target.id === 'finishModal') $("finishModal").classList.remove('open'); });
  $("finishSaveBtn").addEventListener('click', saveFinishedWorkout);

  $("newWorkoutCreateBtn").addEventListener('click', createNewWorkout);
  $("newWorkoutName").addEventListener('keydown', (e)=>{ if(e.key === 'Enter') createNewWorkout(); });

  $("dataImportInput").addEventListener('change', async (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    await importAllData(file);
    e.target.value = "";
  });

    $("checkinFileInput").addEventListener('change', async (e)=>{
    const file = e.target.files[0];
    if(!file || currentCheckinWeek === null) return;
    try{
      showToast("Saving photo…");
      const dataUrl = await compressImageFile(file);
      const current = await getWeekData(currentCheckinWeek);
      await saveWeekData(currentCheckinWeek, { photo: dataUrl, weight: current.weight, bodyFat: current.bodyFat });
      await refreshCheckinViews(currentCheckinWeek);
      showToast("Check-in saved");
    }catch(err){
      console.error(err);
      showToast("Couldn't process that photo");
    }
    e.target.value = "";
  });

  hideSplashScreen();
}

init();