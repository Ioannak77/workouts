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

/* ---------- data loaded from data/exercises.json ---------- */
let EQUIPMENT_OPTIONS = [];
let GOALS_OPTIONS = [];
let REST_TIMER_OPTIONS = [30, 45, 60, 90, 120];
let TIMER_ALERT_OPTIONS = [];
let MUSCLE_GROUP_OPTIONS = [];
let IMAGE_FOLDERS = {};
let EXERCISE_LIBRARY = {};
let WORKOUTS = {};
let WARMUP_VARIANTS = {};
const EXERCISE_IMAGE_BASE = 'exercise-images/';

async function loadExerciseData(){
  try{
    const res = await fetch('data/exercises.json');
    const data = await res.json();
    EQUIPMENT_OPTIONS = data.equipmentOptions || [];
    GOALS_OPTIONS = data.goalsOptions || [];
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

function defaultSession(){ return { plan: [], checklist: [], sets: [], startedAt: null, finishedAt: null, newPRs: [], completed: [] }; }
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
    goals: [],
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
async function toggleProfileGoal(key){
  const profile = await getProfile();
  const goals = new Set(profile.goals || []);
  goals.has(key) ? goals.delete(key) : goals.add(key);
  profile.goals = [...goals];
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
      <button type="button" class="profile-menu-item" data-view="goals"><span>Goals</span><span class="pmi-arrow">›</span></button>
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
function goalsPageHTML(){
  return `
    ${subPageHeaderHTML('Goals')}
    <div class="profile-hint" style="margin-top:0;">Select what you're working toward.</div>
    <div id="goalsList"></div>
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
    <div class="profile-hint" style="margin-top:0;">Default rest between sets.</div>
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
          <div class="progress-history-stats">${data.weight != null ? `${data.weight}kg` : '—'} · ${data.bodyFat != null ? `${data.bodyFat}% BF` : '—'}</div>
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
  `;
}
function dataPageHTML(){
  return `
    ${subPageHeaderHTML('Data')}
    <div class="profile-hint" style="margin-top:0;">Your workouts, sets, and photos are stored on this device only.</div>
    <button type="button" class="checkin-btn" id="exportDataBtn" style="width:100%; margin-bottom:10px;">Export backup</button>
    <button type="button" class="checkin-btn" id="importDataBtn" style="width:100%; margin-bottom:10px;">Import backup</button>
    <button type="button" class="checkin-btn" id="resetProfileBtn" style="width:100%; margin-bottom:10px;">Reset profile info</button>
    <button type="button" class="checkin-btn" id="clearHistoryBtn" style="width:100%; margin-bottom:10px; color:var(--rust); border-color:var(--rust);">Clear all workout history</button>
    <div class="reset-app-warning">⚠️ This erases everything — export a backup first if you want to keep your data.</div>
    <button type="button" class="checkin-btn" id="resetAppBtn" style="width:100%; color:var(--rust); border-color:var(--rust);">Reset app (erase everything)</button>
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
    a.download = `rep-log-backup-${todayKey}.json`;
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
      Rep Log tracks your workouts, rest timers, and weekly progress photos — all stored privately on this device.
      <br><br>
      Tap a workout to log sets, or Edit to build your own from your available equipment.
    </div>
    <div class="profile-menu" style="margin-top:16px;">
      <a class="profile-menu-item" href="${mailtoLink('Rep Log — Bug report', 'Describe the bug here:')}"><span>🐞 Report a bug</span></a>
      <a class="profile-menu-item" href="${mailtoLink('Rep Log — Feature suggestion', 'Describe your idea here:')}"><span>💡 Suggest a feature</span></a>
      <a class="profile-menu-item" href="${mailtoLink('Rep Log — Exercise request', 'Which exercise would you like added?')}"><span>🏋 Request an exercise</span></a>
    </div>
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
      item.innerHTML = `
        <div class="checklist-label">${escapeHTML(opt.label)}</div>
        <div class="checkbox"><svg viewBox="0 0 24 24" fill="none"><path d="M4 12l5 5L20 6" stroke="#15140F" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      `;
      item.addEventListener('click', ()=>toggleProfileEquipment(opt.key));
      eqList.appendChild(item);
    });
    wireBackButton();
    return;
  }

  if(profileView === 'goals'){
    body.innerHTML = goalsPageHTML();
    const goalsList = $("goalsList");
    GOALS_OPTIONS.forEach(opt=>{
      const done = (profile.goals || []).includes(opt.key);
      const item = document.createElement('div');
      item.className = `checklist-item ${done?'done':''}`;
      item.innerHTML = `
        <div class="checklist-label">${escapeHTML(opt.label)}</div>
        <div class="checkbox"><svg viewBox="0 0 24 24" fill="none"><path d="M4 12l5 5L20 6" stroke="#15140F" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      `;
      item.addEventListener('click', ()=>toggleProfileGoal(opt.key));
      goalsList.appendChild(item);
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
      btn.textContent = `${sec} sec`;
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
    wireBackButton();
    return;
  }

  if(profileView === 'data'){
    body.innerHTML = dataPageHTML();
    $("exportDataBtn").addEventListener('click', exportAllData);
    $("importDataBtn").addEventListener('click', ()=> $("dataImportInput").click());
    $("resetProfileBtn").addEventListener('click', async ()=>{
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
        setTimeout(()=>{ if(clearBtn.dataset.armed === '1'){ clearBtn.dataset.armed='0'; clearBtn.textContent = 'Clear all workout history'; } }, 3000);
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
        resetAppBtn.textContent = 'Export a backup first! Tap again to erase everything';
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
function openExerciseImageModal(src, name){
  if(!src) return;
  $("exerciseImageModalImg").src = src;
  $("exerciseImageModalImg").alt = name;
  $("exerciseImageModalLabel").textContent = name;

  const data = findExerciseData(name);
  const body = $("exerciseImageModalBody");
  body.innerHTML = `
    ${eimListHTML('Step-by-step', data && data.steps)}
    ${eimListHTML('Common mistakes', data && data.mistakes)}
    ${eimListHTML('Tips', data && data.tips)}
  `;

  $("exerciseImageModal").classList.add('open');
}
function closeExerciseImageModal(){
  $("exerciseImageModal").classList.remove('open');
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
}

/* ---------- helpers ---------- */
function formatDuration(ms){
  const totalSec = Math.max(0, Math.floor(ms/1000));
  const h = Math.floor(totalSec/3600), m = Math.floor((totalSec%3600)/60), s = totalSec%60;
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
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
    record.maxWeight = weight; record.maxWeightReps = reps;
    events.push({ type:'weight', detail:`Heaviest weight — ${toDisplayWeight(weight)}${unitLabel()} × ${reps}` });
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
  restInterval = setInterval(()=>{
    remaining--;
    if(remaining <= 0){
      clearInterval(restInterval);
      bar.classList.remove('show');
      showToast("Rest over — go!");
      fireTimerAlert(alertMode);
      return;
    }
    $("restTime").textContent = formatRestTime(remaining);
  }, 1000);
}
function skipRest(){
  clearInterval(restInterval);
  $("restBar").classList.remove('show');
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
      <input type="number" id="checkinWeight" placeholder="Weight kg" inputmode="decimal" step="0.1" value="${data.weight ?? ''}">
      <input type="number" id="checkinBodyFat" placeholder="Body fat %" inputmode="decimal" step="0.1" value="${data.bodyFat ?? ''}">
      <button id="checkinSaveMetrics">Save</button>
    </div>
  `;
  $("checkinSaveMetrics").addEventListener('click', async ()=>{
    const weight = $("checkinWeight").value;
    const bodyFat = $("checkinBodyFat").value;
    const current = await getWeekData(week);
    await saveWeekData(week, { photo: current.photo, weight: weight ? Number(weight) : null, bodyFat: bodyFat ? Number(bodyFat) : null });
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
    const sub = data.weight ? `${data.weight}kg` : '\u00A0';
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
      <input type="number" id="modalWeight" placeholder="Weight kg" inputmode="decimal" step="0.1" value="${data.weight ?? ''}">
      <input type="number" id="modalBodyFat" placeholder="Body fat %" inputmode="decimal" step="0.1" value="${data.bodyFat ?? ''}">
      <button id="modalSaveMetrics">Save</button>
    </div>
  `;

  $("modalPhotoBtn").addEventListener('click', ()=>{ currentCheckinWeek = week; $("checkinFileInput").click(); });
  $("modalSaveMetrics").addEventListener('click', async ()=>{
    const weight = $("modalWeight").value;
    const bodyFat = $("modalBodyFat").value;
    const current = await getWeekData(week);
    await saveWeekData(week, { photo: current.photo, weight: weight ? Number(weight) : null, bodyFat: bodyFat ? Number(bodyFat) : null });
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
async function renderPlanGrid(){
  const session = await getSession(todayKey);
  const grid = $("planGrid");
  grid.innerHTML = "";
  const defs = await getAllPlanDefs();
  defs.forEach(w=>{
    const btn = document.createElement("button");
    const active = session.plan.includes(w.key);
    btn.className = `plan-btn ${active?'active':''}`;
    btn.textContent = w.label;
    btn.addEventListener('click', ()=>togglePlan(w.key));
    grid.appendChild(btn);
  });
  const addBtn = document.createElement("button");
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

  const countForExercise = updated.sets.filter(s=>s.exercise === exercise).length;
  if(targetSets && countForExercise % targetSets === 0){
    startRest(userRestSeconds, "Exercise done — rest before next", userTimerAlert);
  } else {
    startRest(userRestSeconds, "Rest between sets", userTimerAlert);
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
  const weightDefault = lastLogged ? toDisplayWeight(lastLogged.weight) : (ex.weight != null ? toDisplayWeight(ex.weight) : (prev ? toDisplayWeight(prev.weight) : ''));

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
        <div class="exercise-target">${escapeHTML(ex.target)}${ex.weight != null ? ` · ${toDisplayWeight(ex.weight)}${unitLabel()}` : ''}</div>
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
  if(!isDone) advanceToNextExercise(name);
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
          delBtn.textContent = 'Tap again to delete';
          setTimeout(()=>{ if(delBtn.dataset.armed === '1'){ delBtn.dataset.armed = '0'; delBtn.classList.remove('group-edit-btn-delete'); delBtn.textContent = 'Delete'; } }, 3000);
          return;
        }
        await deleteWorkout(key);
      });
      w.exercises.forEach(name=>{
        const done = session.checklist.includes(name);
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
      group.innerHTML = `
        <div class="plan-group-header">
          <div class="plan-group-header-top">
            <div>
              <div class="plan-group-title">${escapeHTML(w.label)}</div>
              <div class="plan-group-focus">${escapeHTML(w.focus)}</div>
            </div>
            <button class="group-edit-btn ${isEditing ? 'group-edit-btn-delete' : ''}" data-group-edit="${key}">${toggleLabel}</button>
          </div>
        </div>
      `;
      const editBtn = group.querySelector('.group-edit-btn');
      if(editBtn) editBtn.addEventListener('click', async ()=>{
        if(isEditing){
          if(editBtn.dataset.armed !== '1'){
            editBtn.dataset.armed = '1';
            editBtn.textContent = 'Tap again to delete';
            setTimeout(()=>{ if(editBtn.dataset.armed === '1'){ editBtn.dataset.armed = '0'; editBtn.textContent = 'Delete'; } }, 3000);
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
        for(const ex of exercises){
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

function buildTemplateEditor(key, exercises, equipmentKeys){
  const wrap = document.createElement('div');
  wrap.className = 'template-editor';

  const makeRow = (name, target, note, weight)=>{
    const row = document.createElement('div');
    row.className = 'template-row';
    row.innerHTML = `
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
async function renderHistory(){
  const keys = await getAllSessionKeys();
  const dateKeys = keys.map(k=>k.replace('session:','')).filter(k=>k !== todayKey).sort((a,b)=> b.localeCompare(a));
  const container = $("historyList");
  const todaySession = await getSession(todayKey);

  const allActiveKeys = [];
  for(const key of dateKeys.slice(0,60)){
    const s = await getSession(key);
    if(s.sets.length > 0) allActiveKeys.push({key, sets:s.sets});
  }

  if(allActiveKeys.length === 0){
    container.innerHTML = `<div class="empty">Past sessions will show up here.</div>`;
  } else {
    container.innerHTML = "";
    allActiveKeys.forEach(({key, sets})=>{
      const grouped = groupByExercise(sets);
      const item = document.createElement("div");
      item.className = "history-item";
      item.innerHTML = `
        <div>
          <div class="history-date">${prettyDate(key)}</div>
          <div class="history-sub">${grouped.size} exercise${grouped.size===1?'':'s'} · ${sets.length} sets</div>
        </div>
        <div class="history-vol">${Math.round(toDisplayWeight(volumeOf(sets)))} ${unitLabel()}</div>
      `;
      container.appendChild(item);
    });
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
  `;
  $("finishModal").classList.add('open');
}
async function saveFinishedWorkout(){
  await updateSession(todayKey, (s)=>{ s.finishedAt = Date.now(); });
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
  await renderHistory();
  await renderRepeatButton();
  await updateWorkoutBar();
}

async function init(){
  const now = new Date();
  todayKey = dateKey(now);
  $("todayLabel").textContent = now.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' });

  await loadExerciseData();
  await loadExerciseNames();
  await renderProgression();
  await renderAll();

  $("photoModalClose").addEventListener('click', closePhotoModal);
  $("photoModal").addEventListener('click', (e)=>{ if(e.target.id === 'photoModal') closePhotoModal(); });
  $("restSkip").addEventListener('click', skipRest);

  $("exerciseImageModalClose").addEventListener('click', closeExerciseImageModal);
  $("exerciseImageModal").addEventListener('click', (e)=>{ if(e.target.id === 'exerciseImageModal') closeExerciseImageModal(); });

  $("profileBtn").addEventListener('click', openProfileModal);
  $("profileModalClose").addEventListener('click', closeProfileModal);
  $("profileModal").addEventListener('click', (e)=>{ if(e.target.id === 'profileModal') closeProfileModal(); });

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
}

init();