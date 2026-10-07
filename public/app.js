import {
  bindOfflineControls,
  isBrowserOffline,
  queueCreate,
  renderOfflinePanel,
  syncNow,
  warnIfUnsyncedThenClear,
} from './offline-sync.js';

const TOKEN_KEY = 'clinic_jwt';
const TENANT_KEY = 'clinic_tenant_id';

const seed = document.querySelector('#seed');
const logout = document.querySelector('#logout');
const dashboardLogout = document.querySelector('#dashboard-logout');
const patientDashboardLogout = document.querySelector('#patient-dashboard-logout');
const stats = document.querySelector('#stats');
const dashboard = document.querySelector('#dashboard');
const loginForm = document.querySelector('#login-form');
const registerForm = document.querySelector('#register-form');
const patientLoginForm = document.querySelector('#patient-login-form');
const authError = document.querySelector('#auth-error');
const showLogin = document.querySelector('#show-login');
const patientDashboard = document.querySelector('#patient-dashboard');
const MODE_KEY = 'clinic_session_mode';

let token = localStorage.getItem(TOKEN_KEY) || '';
let tenantId = localStorage.getItem(TENANT_KEY) || '';
let snapshot = null;
let sessionMode = localStorage.getItem(MODE_KEY) || 'staff';
let patientSummary = null;
let notifications = [];
let staffMessages = [];
let auditLogs = [];
let patientAccounts = [];
let systemStatus = null;
window.clinicToken = token;
let currentPatientId = null;
let currentMemberId = null;
let patientImportRows = [];
let patientImportHeaders = [];

const PATIENT_IMPORT_FIELDS = [
  ['clinicPatientId', 'Clinic Patient ID'],
  ['firstName', 'First Name *'],
  ['lastName', 'Last Name'],
  ['phone', 'Phone *'],
  ['email', 'Email'],
  ['altPhone', 'Alternate Phone'],
  ['dob', 'Date of Birth'],
  ['gender', 'Gender'],
  ['bloodGroup', 'Blood Group'],
  ['address', 'Address'],
  ['city', 'City'],
  ['state', 'State'],
  ['medicalHistory', 'Medical History'],
];
const PATIENT_TEMPLATE_HEADERS = ['Existing Patient ID','First Name','Last Name','Phone','Email','Alternate Phone','Date of Birth','Gender','Blood Group','Address','City','State','Medical History'];

const ROLE_PERMS = {
  owner:   ['manage_staff','manage_branches','manage_services','manage_appointments','create_appointment','view_patients','write_encounter','manage_prescriptions','view_billing','manage_billing','view_reports','manage_subscription','manage_inventory','send_staff_messages','manage_referrals'],
  admin:   ['manage_staff','manage_branches','manage_services','manage_appointments','create_appointment','view_patients','write_encounter','manage_prescriptions','view_billing','manage_billing','view_reports','manage_inventory','send_staff_messages','manage_referrals'],
  branch_manager: ['manage_staff','manage_branches','manage_appointments','create_appointment','view_patients','write_encounter','view_billing','manage_billing','view_reports','send_staff_messages','manage_referrals'],
  doctor:  ['view_patients','write_encounter','manage_prescriptions','create_appointment','view_billing','send_staff_messages','manage_referrals'],
  receptionist: ['create_appointment','view_patients'],
  nurse:   ['view_patients','write_encounter','send_staff_messages'],
  accountant: ['view_billing','manage_billing','manage_services','view_reports'],
  store_manager: ['manage_inventory','send_staff_messages'],
  viewer:  ['view_patients','view_reports'],
};
let currentRole = null;

function can(perm) {
  // Fail closed: before the session role is known, grant nothing.
  if (!currentRole) return false;
  return ROLE_PERMS[currentRole]?.includes(perm) ?? false;
}

function applyRBAC(force) {
  const h = (sel, perm) => {
    const el = document.querySelector(sel);
    if (el) el.hidden = force === 'show' ? false : !can(perm);
  };
  // Static forms
  h('#member-form', 'manage_staff');
  h('#branch-form', 'manage_branches');
  h('#encounter-form', 'write_encounter');
  h('#appointment-form', 'create_appointment');
  h('#prescription-form', 'manage_prescriptions');
  h('#invoice-form', 'manage_billing');
  h('#notification-form', 'manage_appointments');
  h('#document-form', 'write_encounter');
  h('#patient-invite-form', 'manage_staff');
  h('#patient-import-card', 'create_appointment');
  h('#availability-form', 'manage_appointments');
  h('#schedule-form', 'manage_appointments');
  h('#service-form', 'manage_services');
  h('#notification-filter', 'manage_appointments');
  // Admin tabs
  const setTab = document.querySelector('.sidebar-item[data-tab="settings"]');
  if (setTab) setTab.hidden = !can('manage_staff');
  const repTab = document.querySelector('.sidebar-item[data-tab="reports"]');
  if (repTab) repTab.hidden = !can('view_reports');
  const msgTab = document.querySelector('.sidebar-item[data-tab="messaging"]');
  if (msgTab) msgTab.hidden = !can('send_staff_messages');
  const invTab = document.querySelector('.sidebar-item[data-tab="inventory"]');
  if (invTab) invTab.hidden = !can('manage_inventory');
}

function headers() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

function showError(message) {
  authError.hidden = !message;
  authError.textContent = message || '';
}

function safeText(v, fb='—') { return (v ?? fb); }

function showSuccessToast(message) {
  const toast = document.querySelector('#success-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  toast.classList.add('show');
  window.clearTimeout(showSuccessToast.timer);
  showSuccessToast.timer = window.setTimeout(() => {
    toast.classList.remove('show');
    toast.hidden = true;
  }, 3600);
}

function compactFormData(data) {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => String(value ?? '').trim() !== ''));
}

/* ── Patient autocomplete helper ── */
function renderPatientAutocomplete(containerId, fieldName, selectedPatientId) {
  const container = document.querySelector(`#${containerId}`);
  if (!container) return;
  const patient = selectedPatientId && snapshot ? snapshot.patients.find(p => p.id === selectedPatientId) : null;
  const display = patient ? `${patient.firstName}${patient.lastName ? ' ' + patient.lastName : ''}` : '';
  container.innerHTML = `
    <input type="text" class="ac-input placeholder="Search patient by name, clinic ID, or phone..." value="${escapeHtml(display)}" autocomplete="off" data-ac-field="${fieldName}" />
    <input type="hidden" class="ac-hidden" name="${fieldName}" value="${selectedPatientId || ''}" />
    <div class="ac-dropdown" hidden></div>`;
  const textInput = container.querySelector('.ac-input');
  setupAutocomplete(textInput, container);
}

function setupAutocomplete(textInput, container) {
  const hidden = container.querySelector('.ac-hidden');
  const dropdown = container.querySelector('.ac-dropdown');

  textInput.addEventListener('input', () => {
    if (!snapshot) return;
    const q = textInput.value.toLowerCase().trim();
    hidden.value = '';
    if (!q) { dropdown.hidden = true; return; }
    const matches = snapshot.patients.filter(p =>
      `${p.firstName} ${p.lastName || ''}`.toLowerCase().includes(q) ||
      (p.clinicPatientId && p.clinicPatientId.toLowerCase().includes(q)) ||
      p.phone.includes(q) || p.patientCode.toLowerCase().includes(q)
    ).slice(0, 8);
    if (!matches.length) { dropdown.hidden = true; return; }
    dropdown.hidden = false;
    dropdown.innerHTML = matches.map(p =>
      `<div class="ac-item" data-patient-id="${p.id}"><strong>${escapeHtml(p.firstName)} ${escapeHtml(p.lastName || '')}</strong><small>${p.clinicPatientId ? 'ID: ' + p.clinicPatientId + ' · ' : ''}${p.phone}${p.email ? ' · ' + p.email : ''}</small></div>`
    ).join('');
  });

  dropdown.addEventListener('click', (e) => {
    const item = e.target.closest('.ac-item');
    if (!item) return;
    const pid = item.dataset.patientId;
    const patient = snapshot.patients.find(p => p.id === pid);
    if (!patient) return;
    textInput.value = `${patient.firstName}${patient.lastName ? ' ' + patient.lastName : ''}`;
    hidden.value = pid;
    dropdown.hidden = true;
    // Dispatch patient-selected event for billing autoload
    container.dispatchEvent(new CustomEvent('patient-selected', { detail: { patientId: pid, patient } }));
    // Auto-populate email field if this is the patient-invite autocomplete
    if (container.id === 'patient-invite-ac') {
      const emailInput = container.closest('form')?.querySelector('[name="email"]');
      if (emailInput && patient.email) emailInput.value = patient.email;
    }
  });

  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) dropdown.hidden = true;
  });

  textInput.addEventListener('blur', () => setTimeout(() => { dropdown.hidden = true; }, 200));
}

function syncPatientAutocompletes() {
  ['encounter-patient-ac', 'prescription-patient-ac', 'invoice-patient-ac', 'document-patient-ac', 'patient-invite-ac', 'appointment-patient-ac'].forEach(id => {
    const container = document.querySelector(`#${id}`);
    if (!container) return;
    const hidden = container.querySelector('.ac-hidden');
    if (hidden && !hidden.value) {
      // First-time render with empty value
      const textInput = container.querySelector('.ac-input');
      if (textInput && !textInput._bound) {
        textInput._bound = true;
        setupAutocomplete(textInput, container);
      }
    }
  });
}

/* ── Specialist chart state ── */
let currentEncounterSpecialistData = {};
let currentEncounterSpecialistType = '';

function renderCurrentSpecialistChart() {
  const area = document.querySelector('#diagram-render-area');
  if (!area) return;
  const type = currentEncounterSpecialistType;
  if (!type || !window.SpecialistCharts) {
    area.innerHTML = '';
    return;
  }
  const mod = window.SpecialistCharts.getModule(type);
  if (!mod) { area.innerHTML = '<p class="hint">Canvas type not available.</p>'; return; }
  mod.render(area, currentEncounterSpecialistData, (targetId) => {
    const existing = currentEncounterSpecialistData[targetId] || {};
    // Single-click behavior: always open/edit the panel. Never clear by clicking the tooth/target itself.
    area.querySelector('#diagram-finding-panel')?.remove();
    const panelDiv = document.createElement('div');
    panelDiv.id = 'diagram-finding-panel';
    area.appendChild(panelDiv);
    mod.renderFinding(panelDiv, targetId, existing,
      (saved) => {
        const tid = saved.toothId || targetId;
        currentEncounterSpecialistData[tid] = saved;
        renderCurrentSpecialistChart();
      },
      (tid) => {
        const key = tid || targetId;
        delete currentEncounterSpecialistData[key];
        renderCurrentSpecialistChart();
      }
    );
    panelDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

function buildSpecialistPayload() {
  if (!currentEncounterSpecialistType || !Object.keys(currentEncounterSpecialistData).length || !window.SpecialistCharts) return undefined;
  const mod = window.SpecialistCharts.getModule(currentEncounterSpecialistType);
  const annotations = Object.entries(currentEncounterSpecialistData).map(([targetId, finding], index) => ({
    id: `annotation_${index + 1}`,
    targetSystemNumber: targetId,
    anatomicalDescription: window.SpecialistCharts.describeTarget?.(currentEncounterSpecialistType, targetId) || `Target ${targetId}`,
    findingType: finding.value,
    note: finding.note,
    canvasCoordinates: window.SpecialistCharts.coordinatesFor?.(currentEncounterSpecialistType, targetId),
    numberingSystem: finding.numberingSystem || mod?.numberingSystem,
    createdAt: new Date().toISOString(),
  }));
  return {
    type: currentEncounterSpecialistType,
    chartType: mod?.chartType || currentEncounterSpecialistType,
    specialty: mod?.specialty,
    standard: mod?.standard,
    numberingSystem: mod?.numberingSystem,
    findings: currentEncounterSpecialistData,
    annotations,
  };
}

function initSpecialistCharts() {
  const select = document.querySelector('#diagram-type');
  if (!select || select._specialistBound) return;
  select._specialistBound = true;
  select.addEventListener('change', () => {
    currentEncounterSpecialistType = select.value;
    currentEncounterSpecialistData = {};
    renderCurrentSpecialistChart();
  });
}

window.addEventListener('pageshow', (event) => {
  if (event.persisted) window.location.reload();
});
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSpecialistCharts);
} else {
  initSpecialistCharts();
}

function formDataWithAc(formEl) {
  const data = Object.fromEntries(new FormData(formEl));
  // Merge hidden autocomplete values that FormData may not capture
  formEl.querySelectorAll('.patient-ac .ac-hidden').forEach(h => {
    if (h.name && h.value) data[h.name] = h.value;
  });
  return data;
}

/* ── Inventory autocomplete for billing ── */
var _invItems = [];
function setupInventoryAutocomplete() {
  var inp = document.querySelector('#inv-inv-search');
  var res = document.querySelector('#inv-inv-results');
  if (!inp) return;
  // Load inventory if not cached
  if (_invItems.length === 0) {
    fetch('/api/inventory', { headers: headers() }).then(r => r.json()).then(d => {
      if (d.ok) _invItems = d.items || [];
    }).catch(() => {});
  }
  inp.addEventListener('input', function() {
    var q = this.value.toLowerCase().trim();
    if (!q) { res.style.display = 'none'; return; }
    var matches = _invItems.filter(function(i) { return i.currentStock > 0 && i.name.toLowerCase().includes(q); }).slice(0, 8);
    if (matches.length === 0) { res.style.display = 'none'; return; }
    res.innerHTML = matches.map(function(i) {
      return '<div class="inv-item" data-id="' + i.id + '" data-price="' + i.sellingPriceKobo + '" data-stock="' + i.currentStock + '" style="padding:6px 10px;cursor:pointer;border-bottom:1px solid #eee;font-size:13px">' +
        '<strong>' + i.name + '</strong> <span style="float:right">₦' + i.sellingPriceKobo.toLocaleString() + '</span><br>' +
        '<small style="color:var(--text-tertiary)">Stock: ' + i.currentStock + ' · ' + (i.unit || '') + '</small>' +
        '</div>';
    }).join('');
    res.style.display = 'block';
    res.querySelectorAll('.inv-item').forEach(function(el) {
      el.addEventListener('click', function() {
        document.querySelector('#inv-desc').value = this.dataset.id ? this.querySelector('strong').textContent + ' (inv)' : '';
        document.querySelector('input[name="unitPrice"]').value = this.dataset.price;
        res.style.display = 'none';
        inp.value = this.querySelector('strong').textContent;
        // Store selected inventory id
        document.querySelector('#inv-desc').dataset.inventoryItemId = this.dataset.id;
      });
    });
  });
  document.addEventListener('click', function(e) {
    if (!inp.contains(e.target) && !res.contains(e.target)) res.style.display = 'none';
  });
}

function setSession(nextToken, nextTenantId, mode = 'staff') {
  token = nextToken;
  tenantId = nextTenantId;
  sessionMode = mode;
  window.clinicToken = token;
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(TENANT_KEY, tenantId);
  localStorage.setItem(MODE_KEY, mode);
  if (logout) logout.hidden = false;
  dashboard.hidden = mode !== 'staff';
  patientDashboard.hidden = mode !== 'patient';
  if (dashboardLogout) dashboardLogout.hidden = dashboard.hidden;
  if (patientDashboardLogout) patientDashboardLogout.hidden = patientDashboard.hidden;
  // Hide auth views and super admin when workspace is shown
  ['super-admin-view', 'register-view', 'tenant-view'].forEach(id => {
    const el = document.querySelector(`#${id}`);
    if (el) el.hidden = true;
  });
  const sa = document.querySelector('#super-admin-workspace');
  if (sa) sa.hidden = true;
  const dashHeader = document.querySelector('#dashboard > header');
  if (dashHeader) dashHeader.hidden = false;
  const ws = document.querySelector('#dashboard > .workspace-grid');
  if (ws) ws.hidden = false;
  const badge = document.querySelector('#role-badge');
  if (badge) badge.textContent = currentRole || '';
}

function clearSession() {
  token = '';
  tenantId = '';
  snapshot = null;
  patientSummary = null;
  notifications = [];
  auditLogs = [];
  patientAccounts = [];
  sessionMode = 'staff';
  currentRole = null;
  window.clinicToken = '';
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TENANT_KEY);
  localStorage.removeItem(MODE_KEY);
  if (logout) logout.hidden = true;
  dashboard.hidden = true;
  patientDashboard.hidden = true;
  const hero = document.querySelector('.hero');
  if (hero) hero.hidden = false;
  if (stats) stats.innerHTML = '';
  const badge = document.querySelector('#role-badge');
  if (badge) badge.textContent = '';
  const lastSlug = localStorage.getItem('lastTenantSlug');
  navigateTo(lastSlug ? `/${lastSlug}` : '/');
}

function card(label, value) {
  return `<article class="stat"><strong>${value}</strong><span>${label}</span></article>`;
}

function option(id, label) {
  return `<option value="${id}">${label}</option>`;
}


function renderDashboard() {
  const dash = document.querySelector('#dashboard-view');
  if (!dash || !snapshot) return;

  /* ── Metric cards ── */
  const totalRevenue = (snapshot.invoices || []).reduce((s, inv) => s + (inv.amountPaidKobo || 0), 0);
  document.querySelector('#dash-metrics').innerHTML = [
    { label: 'Patients', value: snapshot.patients.length, icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>' },
    { label: 'Appointments', value: snapshot.appointments.length, icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><circle cx="12" cy="16" r="1"/></svg>' },
    { label: 'Staff', value: snapshot.members.length, icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' },
    { label: 'Branches', value: snapshot.branches.length, icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>' },
    { label: 'Revenue', value: '₦' + totalRevenue.toLocaleString(), icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>' },
  ].map(m => `<article class="dash-metric"><span class="dash-metric-icon">${m.icon}</span><div><strong>${m.value}</strong><span>${m.label}</span></div></article>`).join('');

  /* ── Today's appointments ── */
  const today = new Date().toISOString().slice(0, 10);
  const todayAppts = (snapshot.appointments || []).filter(a => (a.startsAt || '').slice(0, 10) === today);
  document.querySelector('#today-count').textContent = todayAppts.length;
  if (todayAppts.length === 0) {
    document.querySelector('#dash-appointments-body').innerHTML = '<p class="dash-empty">No appointments for today.</p>';
  } else {
    document.querySelector('#dash-appointments-body').innerHTML = todayAppts.slice(0, 6).map(a => {
      const branch = snapshot.branches.find(b => b.id === a.branchId);
      const patient = snapshot.patients.find(p => p.id === a.patientId);
      const time = a.startsAt ? new Date(a.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      return `<div class="dash-appt-row ${a.status}">
        <span class="dash-appt-time">${time}</span>
        <span class="dash-appt-patient">${patient?.firstName || 'Patient'}</span>
        <span class="dash-appt-service">${a.serviceName}</span>
        <span class="dash-appt-branch">${branch?.name || ''}</span>
        <span class="dash-appt-status">${a.status}</span>
      </div>`;
    }).join('');
  }

  /* ── Recent encounters ── */
  const encounters = (snapshot.encounters || []).slice(-5).reverse();
  document.querySelector('#encounter-count').textContent = encounters.length;
  if (encounters.length === 0) {
    document.querySelector('#dash-activity-body').innerHTML = '<p class="dash-empty">No recent encounters.</p>';
  } else {
    document.querySelector('#dash-activity-body').innerHTML = encounters.map(e => {
      const patient = snapshot.patients.find(p => p.id === e.patientId);
      const date = e.createdAt ? new Date(e.createdAt).toLocaleDateString() : '';
      return `<div class="dash-activity-item">
        <span class="dash-activity-dot"></span>
        <div>
          <strong>${e.reason || 'Encounter'}</strong>
          <p>${patient?.firstName || 'Patient'} · ${e.status} · ${date}</p>
          ${e.diagnosis ? `<small>${e.diagnosis}</small>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  /* ── Pending items ── */
  const draftInvoices = (snapshot.invoices || []).filter(i => i.status === 'draft');
  const draftPrescriptions = (snapshot.prescriptions || []).filter(p => p.status === 'draft' || p.status === 'pending');
  const queuedNotifs = (snapshot.notificationJobs || []).filter(n => n.status === 'queued');
  const pendingParts = [];
  if (draftInvoices.length) pendingParts.push(`${draftInvoices.length} draft invoice${draftInvoices.length > 1 ? 's' : ''}`);
  if (draftPrescriptions.length) pendingParts.push(`${draftPrescriptions.length} pending prescription${draftPrescriptions.length > 1 ? 's' : ''}`);
  if (queuedNotifs.length) pendingParts.push(`${queuedNotifs.length} queued notification${queuedNotifs.length > 1 ? 's' : ''}`);
  document.querySelector('#dash-pending-body').innerHTML = pendingParts.length
    ? '<p class="dash-pending-list">' + pendingParts.join(' · ') + '</p>'
    : '<p class="dash-empty">All caught up — no pending items.</p>';

  /* ── Stats footer ── */
  document.querySelector('#dash-stats').innerHTML = [
    { label: 'Services', value: (snapshot.services || []).length },
    { label: 'Schedules', value: (snapshot.doctorSchedules || []).length },
    { label: 'Prescriptions', value: (snapshot.prescriptions || []).length },
    { label: 'Invoices', value: (snapshot.invoices || []).length },
    { label: 'Documents', value: (snapshot.patientDocuments || []).length },
    { label: 'Patient acc.', value: (snapshot.patientAccounts || patientAccounts).length },
    { label: 'Notifications', value: (snapshot.notificationJobs || notifications).length },
    { label: 'Audit logs', value: (snapshot.auditLogs || auditLogs).length },
    { label: 'Tenant', value: snapshot.tenant.name },
  ].map(s => `<article class="dash-stat"><strong>${s.value}</strong><span>${s.label}</span></article>`).join('');
}

function render() {
  if (!snapshot) return;
  document.querySelector('#app-loading')?.remove();
  dashboard.hidden = false;
  document.querySelector('.workspace-grid')?.classList.remove('auth-mode');
  document.querySelector('.sidebar')?.classList.remove('hidden');
  // Populate topbar clinic name from settings
  const s = snapshot.settings || {};
  const nameEl = document.querySelector('#topbar-clinic-name');
  if (nameEl) nameEl.textContent = (s.clinicName || 'Clinic') + ' Portal';
  const addrEl = document.querySelector('#topbar-clinic-addr');
  if (addrEl) addrEl.textContent = s.clinicAddress || '';
  const logoEl = document.querySelector('.topbar-logo');
  if (logoEl && s.clinicLogoUrl) logoEl.style.background = 'url(' + s.clinicLogoUrl + ') center/cover no-repeat';
  else if (logoEl) logoEl.style.background = 'linear-gradient(135deg,#7c5cfc,#5b3ae8)';
  document.querySelector('.topbar')?.classList.remove('hidden');
  if (logout) logout.hidden = false;
  try {
    renderDashboard();

  const canManageBranches = can('manage_branches');
  const canManageServices = can('manage_services');
  const canWriteEncounter = can('write_encounter');
  const canManagePrescriptions = can('manage_prescriptions');
  const canManageBilling = can('manage_billing');
  const canManageStaff = can('manage_staff');
  const canManageAppts = can('manage_appointments');
  const canCreateAppt = can('create_appointment');
  const canViewBilling = can('view_billing');
  const canViewPatients = can('view_patients');

  document.querySelector('#branch-list').innerHTML = snapshot.branches.map((branch) =>
    `<article class="card-rich card-clickable" data-branch-id="${branch.id}"><h3>${branch.name}</h3><p>${branch.address || 'No address yet'}</p><small>${branch.id}</small></article>`
  ).join('');

  /* Populate branch filter dropdown */
  const branchFilter = document.querySelector('#patient-branch-filter');
  if (branchFilter) {
    const currentVal = branchFilter.value;
    branchFilter.innerHTML = '<option value="">All branches</option>' + snapshot.branches.map((b) =>
      `<option value="${b.id}" ${b.id === currentVal ? 'selected' : ''}>${b.name}</option>`
    ).join('');
  }

  /* Populate import branch dropdown */
  const importBranch = document.querySelector('#patient-import-branch');
  if (importBranch) {
    const currentVal = importBranch.value;
    importBranch.innerHTML = '<option value="">No branch (unassigned)</option>' + snapshot.branches.map((b) =>
      `<option value="${b.id}" ${b.id === currentVal ? 'selected' : ''}>${b.name}</option>`
    ).join('');
  }

  /* Filter patients by branch + search */
  let displayPatients = snapshot.patients;
  const activeBranch = branchFilter?.value;
  if (activeBranch) {
    displayPatients = displayPatients.filter((p) => p.branchId === activeBranch);
  }
  const searchQ = (document.querySelector('#patient-search-input')?.value || '').trim().toLowerCase();
  if (searchQ) {
    displayPatients = displayPatients.filter((p) =>
      (p.firstName + ' ' + (p.lastName || '') + ' ' + (p.clinicPatientId || '') + ' ' + p.patientCode + ' ' + (p.phone || '')).toLowerCase().includes(searchQ)
    );
  }

  document.querySelector('#patient-list').innerHTML = displayPatients.map((patient) => {
    const branchName = snapshot.branches.find((b) => b.id === patient.branchId)?.name || '';
    const esc = (s) => { if (s == null) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
    return `<article class="card-rich card-clickable" data-patient-id="${patient.id}"><h3>${esc(patient.firstName)} ${esc(patient.lastName)}</h3><p class="card-meta">${patient.clinicPatientId ? 'Clinic ID: ' + esc(patient.clinicPatientId) + ' &middot; ' : ''}${patient.patientCode} &middot; ${esc(patient.phone)}${branchName ? ' <span class="badge badge-active">' + esc(branchName) + '</span>' : ''}</p><div class="card-details">${patient.email ? '<span>&#9993; ' + esc(patient.email) + '</span>' : ''}${patient.dob ? '<span>&#128197; DOB: ' + new Date(patient.dob).toLocaleDateString() + '</span>' : ''}${patient.gender ? '<span>&#9906; ' + esc(patient.gender) + '</span>' : ''}${patient.bloodGroup ? '<span>&#129656; ' + esc(patient.bloodGroup) + '</span>' : ''}${patient.address ? '<span>&#128205; ' + esc(patient.address) + (patient.city ? ', ' + esc(patient.city) : '') + (patient.state ? ', ' + esc(patient.state) : '') + '</span>' : ''}${patient.medicalHistory ? '<small class="card-note">&#128203; ' + esc(patient.medicalHistory.substring(0,80)) + '</small>' : ''}</div></article>`;
  }).join('');

  document.querySelector('#appointment-list').innerHTML = snapshot.appointments.map((appt) => {
    const branch = snapshot.branches.find((item) => item.id === appt.branchId);
    const patient = snapshot.patients.find((item) => item.id === appt.patientId);
    return `<article><h3>${appt.serviceName}</h3><p>${patient?.firstName || 'Patient'} at ${branch?.name || 'Branch'} · ${appt.status}</p><small>${new Date(appt.startsAt).toLocaleString()}</small></article>`;
  }).join('');

  document.querySelector('#member-list').innerHTML = snapshot.members.map((member) => {
    // The owner seat is never deletable (server also enforces this), and a user
    // may not delete their own seat — so don't render those Delete buttons.
    const deletable = canManageStaff && member.role !== 'owner' && member.id !== currentMemberId;
    const actions = canManageStaff
      ? `<div class="card-actions"><button data-edit-member="${member.id}" style="font-size:.78rem;padding:4px 10px" onclick="editMember('${member.id}')">Edit</button>${deletable ? `<button data-delete-member="${member.id}" style="font-size:.78rem;padding:4px 10px;background:var(--danger)" onclick="deleteMember('${member.id}')">Delete</button>` : ''}</div>`
      : '';
    return `<article class="card-rich card-clickable" data-member-id="${member.id}"><h3>${member.displayName || member.email}</h3><p class="card-meta"><span class="badge badge-${member.status}">${member.status}</span> <span class="badge badge-${member.role}">${member.role}</span></p><div class="card-details">${member.email ? `<span>✉ ${member.email}</span>` : ''}${member.phone ? `<span>📞 ${member.phone}</span>` : ''}${member.specialization ? `<span>🔬 ${member.specialization}</span>` : ''}</div>${actions}</article>`;
  }).join('');

  document.querySelector('#service-list').innerHTML = snapshot.services.map((service) =>
    `<article><h3>${service.name}</h3><p>${service.durationMinutes} min · ₦${service.priceKobo.toLocaleString()}</p>${
      canManageServices
        ? `<div class="card-actions"><button data-edit-service="${service.id}" style="font-size:.78rem;padding:4px 10px">Edit</button><button data-delete-service="${service.id}" style="font-size:.78rem;padding:4px 10px;background:var(--danger)">Delete</button></div>`
        : ''
    }</article>`
  ).join('');

  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const apptCard = (appt) => {
    const branch = snapshot.branches.find((item) => item.id === appt.branchId);
    const patient = snapshot.patients.find((item) => item.id === appt.patientId);
    return `<article><h3>${appt.serviceName}</h3><p>${patient?.firstName || 'Patient'} at ${branch?.name || 'Branch'} · ${appt.status}</p><small>${new Date(appt.startsAt).toLocaleString()}</small></article>`;
  };
  document.querySelector('#calendar-list').innerHTML = (snapshot.appointments || []).map(apptCard).join('');
  document.querySelector('#schedule-list').innerHTML = (snapshot.doctorSchedules || []).map((item) => {
    const doc = (snapshot.members || []).find(m => m.id === item.doctorMemberId);
    const branch = (snapshot.branches || []).find(b => b.id === item.branchId);
    const docName = doc ? (doc.displayName || doc.email || '') : '';
    const branchName = branch ? branch.name : '';
    return `<article class="card-rich card-clickable" data-schedule-id="${item.id}"><h3>${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][item.weekday] || item.weekday} ${item.startsAt}–${item.endsAt}</h3><p>${item.slotMinutes} min slots · ${docName}</p><small>${branchName}</small></article>`;
  }).join('');
  document.querySelector('#encounter-list').innerHTML = (snapshot.encounters || []).map((item) => {
    const hasSpecialist = item.specialistData && item.specialistData.type && item.specialistData.findings && Object.keys(item.specialistData.findings).length;
    const doctor = (snapshot.members || []).find(m => m.id === item.doctorMemberId);
    const doctorName = doctor ? (doctor.displayName || doctor.email || '') : '';
    return `<article class="card-rich card-clickable" data-encounter-id="${item.id}"><h3>${item.reason || 'Encounter'}</h3><p class="card-meta"><span class="badge badge-${item.status}">${item.status}</span>${doctorName ? ' · <span class="badge badge-active">' + esc(doctorName) + '</span>' : ''} · ${item.diagnosis || "No diagnosis"}${item.bloodPressure ? ' · BP ' + item.bloodPressure : ''}${item.temperatureC ? ' · ' + item.temperatureC + '°C' : ''}${hasSpecialist ? ' · <span class="specialist-badge">Chart</span>' : ''}${hasSpecialist ? ' <span class="dash-finding-note">' + Object.values(item.specialistData.findings).map(function(f){return f.note||''}).filter(Boolean).join('; ') + '</span>' : ''}</p>${item.status !== 'signed' && canWriteEncounter ? '<button data-sign="' + item.id + '">Sign</button>' : ''}</article>`;
  }).join('');
  document.querySelector('#prescription-list').innerHTML = (snapshot.prescriptions || []).map((item) => {
    const patient = snapshot.patients.find(p => p.id === item.patientId);
    const dateStr = item.issuedAt ? new Date(item.issuedAt).toLocaleDateString() : (item.createdAt ? new Date(item.createdAt).toLocaleDateString() : '');
    return `<article class="card-rich"><h3>${item.items?.[0]?.medication || 'Prescription'}</h3><p class="card-meta">${item.status}${item.items?.[0]?.dosage ? ' · ' + item.items[0].dosage : ''}${patient ? ' · ' + patient.firstName + (patient.lastName || '') : ''}${dateStr ? ' · ' + dateStr : ''}</p>${item.status === 'draft' && canManagePrescriptions ? '<button data-issue="' + item.id + '">Issue</button>' : ''}</article>`;
  }).join('');
  document.querySelector('#invoice-list').innerHTML = (snapshot.invoices || []).map((item) => {
    const balance = item.balanceKobo ?? Math.max((item.totalKobo || 0) - (item.amountPaidKobo || 0), 0);
    const canPay = item.status !== 'draft' && balance > 0;
    return `<article class="card-rich"><h3>${item.invoiceNumber}</h3><p class="card-meta"><span class="badge badge-${item.status}">${item.status}</span> · ₦${item.totalKobo.toLocaleString()}${item.hmoCoverageKobo ? ' · HMO covers ₦' + Math.round(item.hmoCoverageKobo).toLocaleString() : ''} · paid ₦${item.amountPaidKobo.toLocaleString()} · balance ₦${balance.toLocaleString()}</p><div class="card-actions">${item.status === 'draft' && canManageBilling ? '<button data-issue-invoice="' + item.id + '">Issue invoice</button>' : ''}${item.status !== 'draft' && canManageBilling ? '<button data-pay="' + item.id + '">Record payment</button>' : ''}${item.status !== 'void' && item.status !== 'paid' && canManageBilling ? '<button data-hmo-invoice="' + item.id + '">Apply HMO</button>' : ''}${canPay && canViewBilling ? '<button data-paystack="' + item.id + '" class="paystack-btn">Pay with Paystack</button>' : ''}${item.status !== 'draft' ? '<button data-print-invoice="' + item.id + '">🖨️ Print</button>' : ''}</div></article>`;
  }).join('');
  document.querySelector('#document-list').innerHTML = (snapshot.patientDocuments || []).map((item) =>
    `<article><h3>${item.title}</h3><p>${item.documentType}</p><small>${item.fileUrl || 'No file URL'}</small></article>`
  ).join('');

  const branchOptions = snapshot.branches.map((branch) => option(branch.id, branch.name)).join('');
    const doctorOptions = snapshot.members.filter((member) => member.role === 'doctor').map((member) => option(member.id, member.displayName || member.email)).join('');
    const apptOptions = `<option value="">None</option>` + snapshot.appointments.map((item) => option(item.id, item.serviceName)).join('');
    const encounterOptions = `<option value="">No encounter</option>` + snapshot.encounters.map((item) => option(item.id, item.reason || item.id)).join('');
    document.querySelector('#appointment-form [name=branchId]').innerHTML = branchOptions;
    document.querySelector('#appointment-form [name=doctorMemberId]').innerHTML = `<option value="">No doctor</option>${doctorOptions}`;
    const serviceOptions = snapshot.services.map((item) => option(item.id, `${item.name} (${item.durationMinutes}min · ₦${item.priceKobo.toLocaleString()})`)).join('');
    document.querySelector('#appointment-service-select').innerHTML = serviceOptions;
    document.querySelector('#availability-form [name=branchId]').innerHTML = branchOptions;
    document.querySelector('#availability-form [name=doctorMemberId]').innerHTML = doctorOptions;
    document.querySelector('#calendar-filter [name=branchId]').innerHTML = `<option value="">All branches</option>${branchOptions}`;
    document.querySelector('#calendar-filter [name=doctorMemberId]').innerHTML = `<option value="">All doctors</option>${doctorOptions}`;
    document.querySelector('#schedule-form [name=branchId]').innerHTML = branchOptions;
    document.querySelector('#schedule-form [name=doctorMemberId]').innerHTML = doctorOptions;
    document.querySelector('#encounter-form [name=branchId]').innerHTML = branchOptions;
    document.querySelector('#encounter-form [name=appointmentId]').innerHTML = apptOptions;
    document.querySelector('#encounter-form [name=doctorMemberId]').innerHTML = `<option value="">Unassigned</option>${doctorOptions}`;
    const isDoctorRole = currentRole === 'doctor' || currentRole === 'radiologist' || currentRole === 'therapist' || currentRole === 'lab_technician';
    const doctorSelect = document.querySelector('#encounter-form [name=doctorMemberId]');
    if (doctorSelect) {
      doctorSelect.closest('label').hidden = isDoctorRole;
      if (isDoctorRole) doctorSelect.value = '';
    }
    document.querySelector('#prescription-form [name=encounterId]').innerHTML = encounterOptions;
    document.querySelector('#invoice-form [name=branchId]').innerHTML = branchOptions;
    document.querySelector('#invoice-form [name=appointmentId]').innerHTML = apptOptions;
    document.querySelector('#invoice-form [name=encounterId]').innerHTML = `<option value="">No encounter</option>${encounterOptions}`;
    // Auto-fill invoice line items when appointment is selected
    const apptSelect = document.querySelector('#invoice-form [name=appointmentId]');
    apptSelect._invoiceBound = apptSelect._invoiceBound || (apptSelect.addEventListener('change', () => {
      const appt = snapshot.appointments.find(a => a.id === apptSelect.value);
      if (!appt) return;
      const serviceNames = (appt.serviceName || '').split(' + ').map(s => s.trim());
      const matched = snapshot.services.filter(s => serviceNames.includes(s.name));
      if (matched.length > 0) {
        const desc = matched.map(s => s.name).join(' + ');
        const totalPrice = matched.reduce((sum, s) => sum + s.priceKobo, 0);
        document.querySelector('#invoice-form [name="description"]').value = desc;
        document.querySelector('#invoice-form [name="unitPrice"]').value = totalPrice;
      } else if (serviceNames.length > 0) {
        document.querySelector('#invoice-form [name="description"]').value = serviceNames.join(' + ');
      }
    }), true);
    // Load HMO options when patient is selected
    const patientAc = document.querySelector('#invoice-patient-ac');
    patientAc._hmoBound = patientAc._hmoBound || (patientAc.addEventListener('patient-selected', async (e) => {
      const patientId = e.detail?.patientId;
      if (!patientId) return;
      try {
        const resp = await fetch(`/api/hmo?patientId=${patientId}`, { headers: headers() });
        const body = await resp.json();
        const sel = document.querySelector('#invoice-hmo-select');
        sel.innerHTML = '<option value="">No HMO</option>' + (body.insurances || []).filter(h => h.active).map(h =>
          `<option value="${h.id}" data-type="${h.coverageType}" data-value="${h.coverageValue}">${h.hmoName} (${h.coverageType === 'percentage' ? h.coverageValue + '%' : '₦' + Number(h.coverageValue).toLocaleString()})</option>`
        ).join('');
      } catch {}
      // Filter appointments and encounters for this patient
      const apptSel = document.querySelector('#invoice-form [name=appointmentId]');
      const patientAppts = (snapshot.appointments || []).filter(a => a.patientId === patientId && a.status !== 'cancelled');
      apptSel.innerHTML = '<option value="">None</option>' + patientAppts.map(a =>
        `<option value="${a.id}">${a.serviceName || 'Visit'} · ${new Date(a.startsAt).toLocaleDateString()}</option>`
      ).join('');
      const encSel = document.querySelector('#invoice-form [name=encounterId]');
      const patientEncs = (snapshot.encounters || []).filter(e => e.patientId === patientId);
      encSel.innerHTML = '<option value="">No encounter</option>' + patientEncs.map(e =>
        `<option value="${e.id}">${e.reason || 'Encounter'} · ${new Date(e.createdAt).toLocaleDateString()}</option>`
      ).join('');
    }), true);
    // Calculate HMO coverage when HMO is selected
    document.querySelector('#invoice-hmo-select').addEventListener('change', () => {
      const sel = document.querySelector('#invoice-hmo-select');
      const opt = sel.options[sel.selectedIndex];
      const price = Number(document.querySelector('#invoice-form [name="unitPrice"]').value);
      const qty = Number(document.querySelector('#invoice-form [name="quantity"]').value);
      const total = price * qty;
      if (opt && opt.value) {
        const type = opt.dataset.type;
        const val = Number(opt.dataset.value);
        // val is in Naira for fixed, percentage number for percentage
        const displayAmount = type === 'percentage' ? Math.round(total * val / 100) : val;
        document.querySelector('#hmo-coverage-display').textContent = '₦' + (displayAmount).toLocaleString();
      } else {
        document.querySelector('#hmo-coverage-display').textContent = '₦0';
      }
    });
    // Recalculate on price/quantity change
    document.querySelector('#invoice-form [name="unitPrice"]').addEventListener('input', () => {
      document.querySelector('#invoice-hmo-select').dispatchEvent(new Event('change'));
    });
    document.querySelector('#invoice-form [name="quantity"]').addEventListener('input', () => {
      document.querySelector('#invoice-hmo-select').dispatchEvent(new Event('change'));
    });

    /* Live invoice totals (discount + HMO preview) */
    function updateInvoiceTotals() {
      const price = Number(document.querySelector('#invoice-form [name="unitPrice"]')?.value || 0);
      const qty = Number(document.querySelector('#invoice-form [name="quantity"]')?.value || 1);
      const subtotal = price * qty;
      const discType = document.querySelector('#discount-type')?.value || 'fixed';
      const discVal = Number(document.querySelector('#discount-value')?.value || 0);
      let discountKobo = discType === 'percentage' ? Math.round(subtotal * discVal / 100) : discVal;
      if (discountKobo > subtotal) discountKobo = subtotal;
      const hmoSel = document.querySelector('#invoice-hmo-select');
      const hmoOpt = hmoSel?.options[hmoSel.selectedIndex];
      let hmoCover = 0;
      if (hmoOpt && hmoOpt.value) {
        hmoCover = hmoOpt.dataset.type === 'percentage'
          ? Math.round(subtotal * Number(hmoOpt.dataset.value) / 100)
          : Number(hmoOpt.dataset.value);
      }
      const afterDiscount = subtotal - discountKobo;
      const finalTotal = Math.max(afterDiscount - hmoCover, 0);
      document.querySelector('#inv-subtotal').textContent = '\u20A6' + subtotal.toLocaleString();
      document.querySelector('#inv-discount-display').textContent = '-\u20A6' + discountKobo.toLocaleString();
      document.querySelector('#inv-hmo-total').textContent = '\u20A6' + hmoCover.toLocaleString();
      document.querySelector('#inv-total').textContent = '\u20A6' + finalTotal.toLocaleString();
    }
    document.querySelector('#discount-type')?.addEventListener('change', updateInvoiceTotals);
    document.querySelector('#discount-value')?.addEventListener('input', updateInvoiceTotals);
    document.querySelector('#invoice-form [name="unitPrice"]').addEventListener('input', updateInvoiceTotals);
    document.querySelector('#invoice-form [name="quantity"]').addEventListener('input', updateInvoiceTotals);
    document.querySelector('#invoice-hmo-select')?.addEventListener('change', updateInvoiceTotals);
    updateInvoiceTotals();
    document.querySelector('#document-form [name=encounterId]').innerHTML = `<option value="">No encounter</option>${encounterOptions}`;
    renderPatientAutocomplete('appointment-patient-ac', 'patientId', '');
    renderPatientAutocomplete('invoice-patient-ac', 'patientId', '');
    renderPatientAutocomplete('appointment-patient-ac', 'patientId', '');
    setupInventoryAutocomplete(); // moved below refresh
    renderPatientAutocomplete('encounter-patient-ac', 'patientId', '');
    renderPatientAutocomplete('prescription-patient-ac', 'patientId', '');
    renderPatientAutocomplete('invoice-patient-ac', 'patientId', '');
    renderPatientAutocomplete('document-patient-ac', 'patientId', '');
    renderPatientAutocomplete('patient-invite-ac', 'patientId', '');
  document.querySelector('#patient-account-list').innerHTML = (patientAccounts.length ? patientAccounts : snapshot.patientAccounts || []).map((item) =>
    `<article><h3>${item.email}</h3><p>${item.status}</p><p>Expires ${item.activationTokenExpiresAt || 'n/a'} · used ${item.activationTokenUsedAt || 'never'}</p>${canManageStaff ? '<button data-resend="' + item.id + '">Resend invite</button><button data-disable-account="' + item.id + '">Disable</button>' : ''}</article>`
  ).join('') || '<p>No patient accounts yet.</p>';
  document.querySelector('#notification-list').innerHTML = (notifications.length ? notifications : snapshot.notificationJobs || []).map((item) => {
      let actions = '<div class="notif-actions">';
      if (item.status === 'queued') { actions += `<button class="btn-outline btn-sm" data-dry-run="${item.id}"><span class="btn-icon">>></span> Send</button>`; }
      if (canManageAppts) {
        actions += `<button class="btn-outline-success btn-sm" data-notif-sent="${item.id}"><span class="btn-icon">✓</span> Sent</button>`;
        actions += `<button class="btn-outline-warning btn-sm" data-notif-failed="${item.id}"><span class="btn-icon">✕</span> Failed</button>`;
        actions += `<button class="btn-outline-danger btn-sm" data-notif-cancel="${item.id}"><span class="btn-icon">⊘</span> Cancel</button>`;
      }
      actions += '</div>';
      return `<article class="card-rich"><h3>${item.type}</h3><p class="card-meta">${item.status} · ${item.channel} · ${item.recipient}</p><p class="card-body-text">${escapeHtml(item.body)}</p>${actions}</article>`;
    }).join('') || '<p>No notification jobs yet.</p>';
  // Referrals rendering
  document.querySelector('#referral-list').innerHTML = (snapshot.referrals || []).map((item) => {
    const patient = snapshot.patients.find(p => p.id === item.patientId);
    const fromDoc = snapshot.members.find(m => m.id === item.fromDoctorMemberId);
    const toDoc = snapshot.members.find(m => m.id === item.toDoctorMemberId);
    const pname = patient ? `${patient.firstName} ${patient.lastName || ''}` : '';
    return `<article class="card-rich${item.status === 'pending' ? ' msg-unread' : ''}"><h3>${item.referralType === 'inhouse_specialist' ? 'In-house specialist referral' : 'External clinic referral'}</h3><p class="card-meta">${item.status} · ${item.reason || ''}${pname ? ' · ' + pname : ''}</p><small style="color:var(--text-quaternary)">${fromDoc ? 'From: ' + (fromDoc.displayName || fromDoc.email) : ''} ${toDoc ? '→ To: ' + (toDoc.displayName || toDoc.email) : ''}${item.externalClinicName ? '→ ' + item.externalClinicName : ''}</small><p style="font-size:.78rem;color:var(--text-secondary)">${safeText(item.notes)}</p>${item.status === 'pending' && can('manage_referrals') ? '<div class="notif-actions"><button class="btn-outline-success btn-sm" data-ref-accept="' + item.id + '">Accept</button><button class="btn-outline-danger btn-sm" data-ref-cancel="' + item.id + '">Cancel</button></div>' : ''}</article>`;
  }).join('') || '';
  // Staff messaging
  document.querySelector('#staff-message-list').innerHTML = (staffMessages || []).map((item) => {
    const other = (snapshot.members || []).find(m => m.id === (item.senderMemberId === currentMemberId ? item.recipientMemberId : item.senderMemberId));
    const isSent = item.senderMemberId === currentMemberId;
    const otherName = other ? (other.displayName || other.email) : '';
    return `<div class="message-thread${!item.readAt && !isSent ? ' msg-unread' : ''}"><div class="${isSent ? 'msg-sent' : 'msg-received'}"><strong>${isSent ? 'You' : otherName}</strong><p>${escapeHtml(item.body)}</p><p class="msg-meta">${item.subject ? safeText(item.subject) : ''} · ${new Date(item.createdAt).toLocaleString()}${item.readAt ? ' · Read' : ''}</p></div></div>`;
  }).join('') || '<p class="detail-empty">No messages yet.</p>';
  // Inventory MVP dashboard/products/batches/reports
  const invItems = snapshot.inventoryItems || [];
  const invBatches = snapshot.inventoryBatches || [];
  const invMovements = snapshot.inventoryMovements || [];
  const invSuppliers = snapshot.suppliers || [];
  const lowItems = invItems.filter((item) => item.currentStock > 0 && item.reorderLevel > 0 && item.currentStock <= item.reorderLevel);
  const outItems = invItems.filter((item) => item.currentStock <= 0);
  const expiringBatches = invBatches.filter((batch) => {
    if (!batch.expiryDate || batch.quantityRemaining <= 0) return false;
    const days = Math.ceil((new Date(batch.expiryDate).getTime() - Date.now()) / 86400000);
    return days >= 0 && days <= 30;
  });
  const inventoryValue = invItems.reduce((sum, item) => sum + ((item.currentStock || 0) * (item.unitCostKobo || 0)), 0);
  const statusLabel = (item) => item.currentStock <= 0 ? 'Out of Stock' : (item.reorderLevel > 0 && item.currentStock <= item.reorderLevel ? 'Low Stock' : 'In Stock');
  const itemOptions = '<option value="">Select item</option>' + invItems.filter((item) => item.status === 'active').map((item) => `<option value="${item.id}">${escapeHtml(item.name)} (${item.currentStock} ${item.unit || ''})</option>`).join('');
  ['#stock-in-item', '#stock-out-item', '#adjust-item'].forEach((selector) => { const el = document.querySelector(selector); if (el) el.innerHTML = itemOptions; });
  const supplierOptions = '<option value="">Supplier</option>' + invSuppliers.filter((supplier) => supplier.status === 'active').map((supplier) => `<option value="${supplier.id}">${escapeHtml(supplier.name)}</option>`).join('');
  const supplierSelect = document.querySelector('#stock-in-supplier');
  if (supplierSelect) supplierSelect.innerHTML = supplierOptions;
  const invMetrics = document.querySelector('#inventory-metrics');
  if (invMetrics) invMetrics.innerHTML = [
    card('Total Items', invItems.length),
    card('Inventory Value', `₦${inventoryValue.toLocaleString()}`),
    card('Low Stock', lowItems.length),
    card('Out of Stock', outItems.length),
    card('Expiring Soon', expiringBatches.length),
  ].join('');
  const lowList = document.querySelector('#inventory-low-stock');
  if (lowList) lowList.innerHTML = (lowItems.length ? lowItems : outItems).map((item) => `<article class="card-rich"><h3>${escapeHtml(item.name)}</h3><p class="stock-low">${item.currentStock} ${item.unit || ''}</p><small>Minimum Level: ${item.reorderLevel}</small></article>`).join('') || '<p class="detail-empty">No low-stock items.</p>';
  const expiringList = document.querySelector('#inventory-expiring');
  if (expiringList) expiringList.innerHTML = expiringBatches.map((batch) => {
    const item = invItems.find((entry) => entry.id === batch.itemId);
    return `<article class="card-rich"><h3>${escapeHtml(item?.name || 'Inventory item')}</h3><p>Batch: ${escapeHtml(batch.batchNumber || '-')}</p><p>Qty: ${batch.quantityRemaining}</p><p>Expires: ${batch.expiryDate || '-'}</p></article>`;
  }).join('') || '<p class="detail-empty">No batches expiring within 30 days.</p>';
  const inventoryList = document.querySelector('#inventory-list');
  if (inventoryList) inventoryList.innerHTML = invItems.map((item) => {
    const low = item.reorderLevel > 0 && item.currentStock <= item.reorderLevel;
    const batches = invBatches.filter((batch) => batch.itemId === item.id && batch.quantityRemaining > 0);
    const batchHtml = batches.map((batch) => `<div class="batch-row"><strong>Batch ${escapeHtml(batch.batchNumber || '-')}</strong><span>Qty: ${batch.quantityRemaining}</span><span>Expiry: ${batch.expiryDate || '-'}</span></div>`).join('') || '<small>No batch records yet.</small>';
    return `<article class="card-rich"><h3>${escapeHtml(item.name)}</h3><p class="card-meta">${escapeHtml(item.sku || '')}${item.category ? ' · ' + escapeHtml(item.category) : ''}${item.unit ? ' · ' + escapeHtml(item.unit) : ''} · ${item.status}</p><p class="${low ? 'stock-low' : 'stock-ok'}" style="font-weight:700;font-size:1.1rem">Stock: ${item.currentStock}${item.unit ? ' ' + escapeHtml(item.unit) : ''}</p><p>Minimum Level: ${item.reorderLevel} · Status: ${statusLabel(item)}</p><p style="font-size:.75rem">Cost: ₦${((item.unitCostKobo || 0)).toFixed(2)} · Selling: ₦${((item.sellingPriceKobo || 0)).toFixed(2)}</p><div class="batch-list">${batchHtml}</div>${item.status === 'active' && can('manage_inventory') ? '<div class="notif-actions"><button class="btn-outline btn-sm" data-inv-receive="' + item.id + '">Receive</button><button class="btn-outline-warning btn-sm" data-inv-dispense="' + item.id + '">Dispense</button><button class="btn-outline-danger btn-sm" data-inv-adjust="' + item.id + '">Adjust</button></div>' : ''}</article>`;
  }).join('') || '<p class="detail-empty">No inventory items yet.</p>';
  const supplierList = document.querySelector('#supplier-list');
  if (supplierList) supplierList.innerHTML = invSuppliers.map((supplier) => `<article class="card-rich"><h3>${escapeHtml(supplier.name)}</h3><p>${escapeHtml(supplier.phone || '')}${supplier.email ? ' · ' + escapeHtml(supplier.email) : ''}</p><small>${supplier.status}</small></article>`).join('') || '<p class="detail-empty">No suppliers yet.</p>';
  const reportList = document.querySelector('#inventory-report-list');
  if (reportList) reportList.innerHTML = [
    ['Current Stock Report', `${invItems.length} products tracked`],
    ['Low Stock Report', `${lowItems.length} below minimum level`],
    ['Expiring Stock Report', `${expiringBatches.length} batches expire within 30 days`],
    ['Stock Movement Report', `${invMovements.length} movements recorded`],
    ['Stock Value Report', `₦${inventoryValue.toLocaleString()} current cost value`],
  ].map(([title, detail]) => `<article class="card-rich"><h3>${title}</h3><p>${detail}</p></article>`).join('');
  document.querySelector('#referral-list').innerHTML = (snapshot.referrals || []).map((item) => {
    const patient = snapshot.patients.find(p => p.id === item.patientId);
    const fromDoc = snapshot.members.find(m => m.id === item.fromDoctorMemberId);
    const toDoc = snapshot.members.find(m => m.id === item.toDoctorMemberId);
    const pname = patient ? `${patient.firstName} ${patient.lastName || ''}` : '';
    return `<article class="card-rich${item.status === 'pending' ? ' msg-unread' : ''}"><h3>${item.referralType === 'inhouse_specialist' ? 'In-house specialist' : 'External clinic'}</h3><p class="card-meta">${item.status} · ${item.reason || ''}${pname ? ' · ' + pname : ''}</p><small style="color:var(--text-quaternary)">${fromDoc ? 'From: ' + (fromDoc.displayName || fromDoc.email) : ''} ${toDoc ? '→ To: ' + (toDoc.displayName || toDoc.email) : ''}${item.externalClinicName ? '→ ' + item.externalClinicName : ''}</small>${item.status === 'pending' && can('manage_referrals') ? '<div class="notif-actions"><button class="btn-outline-success btn-sm" data-ref-accept="' + item.id + '">Accept</button><button class="btn-outline-danger btn-sm" data-ref-cancel="' + item.id + '">Cancel</button></div>' : ''}</article>`;
  }).join('') || '';
  document.querySelector('#audit-list').innerHTML = (auditLogs.length ? auditLogs : snapshot.auditLogs || []).map((item) =>
    `<article><h3>${item.action}</h3><p>${item.actorType || 'unknown'} · member ${item.actorMemberId || '-'} · patient ${item.actorPatientAccountId || '-'}</p><p>${item.objectType || ''} ${item.objectId || ''}</p><small>${item.createdAt}</small></article>`
  ).join('') || '<p>No audit logs yet.</p>';
  const status = systemStatus;
  document.querySelector('#system-status-view').innerHTML = status
    ? `<article><h3>${status.service} ${status.version}</h3><p>DB ${status.databaseMode} · notifications ${status.notificationProvider}</p><p>${status.time}</p><pre>${JSON.stringify(status.features, null, 2)}</pre></article>`
    : '<p>Status unavailable.</p>';
  renderOfflinePanel({ headers, onRefreshed: refresh });
    populateStaffSelects();
  applyRBAC();
  } catch (e) {
    console.error('render() error:', e);
    const errDiv = document.querySelector('#dash-metrics');
    if (errDiv) errDiv.innerHTML = `<article class="dash-metric" style="grid-column:1/-1;background:#fef2f2;color:#dc2626;padding:16px;border-radius:12px"><strong>⚠️ Render error</strong><span style="font-size:0.85rem">${e.message}</span></article>`;
  }
}

function renderPatientPortal() {
  if (!patientSummary) return;
  patientDashboard.hidden = false;
  dashboard.hidden = true;
  if (logout) logout.hidden = false;
  const counts = patientSummary.counts || {};
  document.querySelector('#patient-stats').innerHTML = [
    card('Patient', `${patientSummary.patient?.firstName || ''} ${patientSummary.patient?.lastName || ''}`),
    card('Appointments', counts.appointments || 0),
    card('Prescriptions', counts.prescriptions || 0),
    card('Invoices', counts.invoices || 0),
    card('Documents', counts.documents || 0),
  ].join('');
  document.querySelector('#patient-appointments').innerHTML = (patientSummary.upcomingAppointments || []).map((item) =>
    `<article><h3>${item.serviceName}</h3><p>${item.status}</p><small>${new Date(item.startsAt).toLocaleString()}</small></article>`
  ).join('') || '<p>No appointments.</p>';
  document.querySelector('#patient-prescriptions').innerHTML = (patientSummary.recentPrescriptions || []).map((item) =>
    `<article><h3>${item.items?.[0]?.medication || 'Prescription'}</h3><p>${item.status}</p></article>`
  ).join('') || '<p>No prescriptions.</p>';
  document.querySelector('#patient-invoices').innerHTML = (patientSummary.openInvoices || []).map((item) => {
    const balance = item.balanceKobo ?? Math.max((item.totalKobo || 0) - (item.amountPaidKobo || 0), 0);
    const bank = patientSummary.settings?.bankTransferEnabled && patientSummary.settings?.bankName ? `
      <div class="bank-info" style="margin-top:8px;padding:8px;background:#f5f3ff;border-radius:8px;font-size:.8rem">
        <strong>Bank Transfer</strong><br>
        Bank: ${patientSummary.settings.bankName}<br>
        Account: ${patientSummary.settings.bankAccountName || ''}<br>
        Number: ${patientSummary.settings.bankAccountNumber || ''}
      </div>` : '';
    return `<article><h3>${item.invoiceNumber}</h3><p>${item.status} · balance ₦${balance.toLocaleString()}</p>${bank}<div class="card-actions"><button data-patient-paystack="${item.id}">Pay now</button></div></article>`;
  }).join('') || '<p>No open invoices.</p>';
  document.querySelector('#patient-documents').innerHTML = (patientSummary.documents || []).map((item) =>
    `<article><h3>${item.title}</h3><p>${item.documentType}</p></article>`
  ).join('') || '<p>No documents.</p>';
}

async function refresh() {
  if (!tenantId || sessionMode !== 'staff') return;
  let response;
  try {
    response = await fetch(`/api/tenants/${tenantId}/snapshot`, { headers: headers() });
    const body = await response.json();
    if (body.snapshot) {
      snapshot = body.snapshot;
      if (body.snapshot.settings && typeof body.snapshot.settings === 'object') {
        currentSettings = { ...(currentSettings || {}), ...body.snapshot.settings };
      }
    }
  } catch (e) { console.warn('refresh snapshot fetch failed:', e); }
  let accountsRes, notifyRes, auditRes, statusRes, msgRes;
  try {
    [accountsRes, notifyRes, auditRes, statusRes, msgRes] = await Promise.all([
      fetch('/api/patient-accounts', { headers: headers() }),
      fetch('/api/notifications', { headers: headers() }),
      fetch('/api/audit-logs', { headers: headers() }),
      fetch('/api/system/status', { headers: headers() }),
      currentMemberId ? fetch('/api/staff-messages?memberId=' + currentMemberId, { headers: headers() }) : Promise.resolve(new Response('{}')),
    ]);
  } catch (e) { console.warn('refresh sub-fetches failed:', e); }
  patientAccounts = accountsRes.ok ? (await accountsRes.json()).accounts || [] : snapshot.patientAccounts || [];
  notifications = notifyRes.ok ? (await notifyRes.json()).notifications || [] : snapshot.notificationJobs || [];
  auditLogs = auditRes.ok ? (await auditRes.json()).auditLogs || [] : snapshot.auditLogs || [];
  systemStatus = statusRes.ok ? await statusRes.json() : null;
  staffMessages = msgRes.ok ? (await msgRes.json()).messages || [] : [];
  render();
  refreshBroadcastPreview();
  // Restore last active tab after page refresh
  const savedTab = localStorage.getItem('clinic_active_tab');
  if (savedTab) {
    const tabBtn = document.querySelector(`.sidebar-item[data-tab="${savedTab}"]`);
    if (tabBtn) tabBtn.click();
  }
}

async function refreshPatient() {
  const response = await fetch('/api/patient-portal/summary', { headers: headers() });
  if (!response.ok) {
    clearSession();
    return;
  }
  patientSummary = await response.json();
  renderPatientPortal();
}

async function loadFromToken() {
  // Don't restore session if on activation page
  if (window.location.pathname === '/activate' && new URLSearchParams(window.location.search).get('token')) return;
  if (!token) return;
  if (sessionMode === 'patient') {
    const response = await fetch('/api/patient-auth/me', { headers: headers() });
    if (!response.ok) {
      clearSession();
      return;
    }
    const body = await response.json();
    tenantId = body.tenant.id;
    localStorage.setItem(TENANT_KEY, tenantId);
    await refreshPatient();
    return;
  }
  const response = await fetch('/api/auth/me', { headers: headers() });
  if (!response.ok) {
    const patientMe = await fetch('/api/patient-auth/me', { headers: headers() });
    if (!patientMe.ok) {
      clearSession();
      return;
    }
    sessionMode = 'patient';
    localStorage.setItem(MODE_KEY, 'patient');
    const body = await patientMe.json();
    tenantId = body.tenant.id;
    await refreshPatient();
    return;
  }
  const body = await response.json();
  tenantId = body.tenant.id;
  currentRole = body.member?.role || 'viewer';
  currentMemberId = body.member?.id || '';
  localStorage.setItem(TENANT_KEY, tenantId);
  setSession(token, tenantId, 'staff');
  await refresh();
}

/* ── URL-based view routing ── */
let currentTenantSlug = '';
let _slugTimeout = null;

function showView(view) {
  ['super-admin-view', 'register-view', 'tenant-view', 'dashboard', 'patient-dashboard'].forEach(id => {
    const el = document.querySelector(`#${id}`);
    if (el) el.hidden = id !== view;
  });
  if (view !== 'dashboard' && view !== 'patient-dashboard') {
    document.querySelector('#app-loading')?.remove();
  }
  // Hide sidebar on auth pages, show on dashboard
  const isAuth = view !== 'dashboard' && view !== 'patient-dashboard';
  document.querySelector('.sidebar')?.classList.toggle('hidden', isAuth);
  document.querySelector('.topbar')?.classList.toggle('hidden', isAuth);
  document.querySelector('.workspace-grid')?.classList.toggle('auth-mode', isAuth);
}

function showTenantError(msg) {
  const el = document.querySelector('#tenant-error');
  if (el) { el.textContent = msg; el.hidden = !msg; }
}

function navigateTo(path) {
  window.history.pushState({}, '', path);
  handleRoute();
}

function handleRoute() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  const params = new URLSearchParams(window.location.search);
  if (path === '/payment-callback') {
      showView('super-admin-view');
      const ref = params.get('reference') || params.get('trxref') || '';
      // Try to verify — wallet top-up first, then invoice
      (async () => {
        try {
          const r = await fetch('/api/wallet/verify', {
            method: 'POST', headers: headers(), body: JSON.stringify({ reference: ref })
          });
          const d = await r.json();
          if (d.ok) {
            document.querySelector('#auth-error').textContent = `✅ Wallet funded successfully! ₦${d.amount.toLocaleString()} added. Redirecting...`;
            document.querySelector('#auth-error').hidden = false;
            document.querySelector('#login-form').hidden = true;
            const savedSlug = localStorage.getItem('lastTenantSlug');
            setTimeout(() => { window.location.href = savedSlug ? '/' + savedSlug : '/'; }, 2000);
            return;
          }
        } catch {}
        // fallback: just show generic success message and redirect
        document.querySelector('#auth-error').textContent = '✅ Payment successful! Reference: ' + ref + '. Redirecting...';
        document.querySelector('#auth-error').hidden = false;
        document.querySelector('#login-form').hidden = true;
        const savedSlug = localStorage.getItem('lastTenantSlug');
        setTimeout(() => { window.location.href = savedSlug ? '/' + savedSlug : '/'; }, 2000);
      })();
      return;
    }
  if (path === '/activate' && params.get('token')) {
    showActivateView(params.get('token'));
    return;
  }
  if (path === '/register') {
    showView('register-view');
    document.querySelector('#hero-view')?.classList.remove('hero');
    return;
  }
  if (path === '/') {
    // If already logged in as super admin, skip login form
    const savedToken = localStorage.getItem(TOKEN_KEY);
    const savedTenant = localStorage.getItem(TENANT_KEY);
    if (savedToken && savedTenant) {
      showView('dashboard');
      setSession(savedToken, savedTenant, 'staff');
      refresh();
      return;
    }
    showView('super-admin-view');
    return;
  }
  // Treat anything else as a tenant slug
  const slug = path.replace(/^\//, '').split('/')[0];
  if (!slug || slug === 'index.html') {
    showView('super-admin-view');
    return;
  }
  currentTenantSlug = slug;
  localStorage.setItem('lastTenantSlug', slug);
  // If already logged in with a token for this tenant, go straight to dashboard
  const savedToken = localStorage.getItem(TOKEN_KEY);
  const savedTenant = localStorage.getItem(TENANT_KEY);
  if (savedToken && savedTenant) {
    showView('dashboard');
    setSession(savedToken, savedTenant, 'staff');
    refresh();
    return;
  }
  showView('tenant-view');
  document.querySelector('#tenant-name').textContent = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) + ' Portal';
  // Resolve tenant from API
  fetch(`/api/tenants/resolve?slug=${encodeURIComponent(slug)}`)
    .then(r => r.json())
    .then(data => {
      if (data.ok && data.tenant) {
        document.querySelector('#tenant-name').textContent = data.tenant.name + ' Portal';
        if (data.settings?.clinicName) {
          document.querySelector('#tenant-name').textContent = data.settings.clinicName + ' Portal';
        }
      }
    })
    .catch(() => {});
}

function setTenantAuthPanel(which) {
  document.querySelector('#tenant-login-form').hidden = which !== 'staff';
  document.querySelector('#tenant-patient-login-form').hidden = which !== 'patient';
  document.querySelector('#show-tenant-staff-login').classList.toggle('active', which === 'staff');
  document.querySelector('#show-tenant-patient-login').classList.toggle('active', which === 'patient');
  showTenantError('');
}

document.querySelector('#show-tenant-staff-login')?.addEventListener('click', () => setTenantAuthPanel('staff'));
document.querySelector('#show-tenant-patient-login')?.addEventListener('click', () => setTenantAuthPanel('patient'));

document.querySelector('#login-link-from-register')?.addEventListener('click', (e) => {
  e.preventDefault();
  navigateTo('/');
});

/* ── Super Admin Login ── */
loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const el = document.querySelector('#auth-error');
  if (el) el.hidden = true;
  const data = Object.fromEntries(new FormData(event.target));
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await response.json();
  if (!response.ok) {
    if (el) { el.textContent = body.error || 'Login failed'; el.hidden = false; }
    return;
  }
  // Super admin login — no clinic/tenant
  if (body.isSuperAdmin) {
    setSession(body.token, '', 'staff');
    showSuperAdmin();
    return;
  }
  currentRole = body.member?.role || 'viewer';
  currentMemberId = body.member?.id || '';
  setSession(body.token, body.tenant.id, 'staff');
  applyRBAC();
  // If logged in at root URL, show super admin
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/' && (currentRole === 'owner' || currentRole === 'admin')) {
    showSuperAdmin();
  } else {
    await refresh();
  }
});

/* ── Register ── */
registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const el = document.querySelector('#register-error');
  if (el) el.hidden = true;
  const data = Object.fromEntries(new FormData(event.target));
  const response = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await response.json();
  if (!response.ok) {
    if (el) { el.textContent = body.error || 'Registration failed'; el.hidden = false; }
    return;
  }
  currentRole = body.member?.role || 'viewer';
  currentMemberId = body.member?.id || '';
  setSession(body.token, body.tenant.id, 'staff');
  applyRBAC();
  // Navigate to tenant portal after registration
  if (body.tenant?.slug) navigateTo('/' + body.tenant.slug);
  await refresh();
});

/* ── Tenant Staff Login ── */
document.querySelector('#tenant-login-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  showTenantError('');
  const data = Object.fromEntries(new FormData(event.target));
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await response.json();
  if (!response.ok) {
    showTenantError(body.error || 'Login failed');
    return;
  }
  currentRole = body.member?.role || 'viewer';
  currentMemberId = body.member?.id || '';
  setSession(body.token, body.tenant.id, 'staff');
  applyRBAC();
  await refresh();
});

/* ── Tenant Patient Login ── */
document.querySelector('#tenant-patient-login-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  showTenantError('');
  const data = Object.fromEntries(new FormData(event.target));
  const response = await fetch('/api/patient-auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...data, tenantSlug: currentTenantSlug }),
  });
  const body = await response.json();
  if (!response.ok) {
    showTenantError(body.error || 'Patient login failed');
    return;
  }
  setSession(body.token, body.tenant.id, 'patient');
  await refreshPatient();
});

/* ── Patient Activation ── */
let activationToken = '';

function showActivateView(token) {
  activationToken = token;
  ['super-admin-view', 'register-view', 'tenant-view', 'dashboard', 'patient-dashboard'].forEach(id => {
    const el = document.querySelector(`#${id}`);
    if (el) el.hidden = true;
  });
  document.querySelector('#activate-view').hidden = false;
  document.querySelector('#activate-error').hidden = true;
  document.querySelector('#activate-success').style.display = 'none';
}

document.querySelector('#activate-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const el = document.querySelector('#activate-error');
  el.hidden = true;
  const data = Object.fromEntries(new FormData(event.target));
  if (data.password !== data.confirm) {
    el.textContent = 'Passwords do not match'; el.hidden = false; return;
  }
  if (data.password.length < 8) {
    el.textContent = 'Password must be at least 8 characters'; el.hidden = false; return;
  }
  try {
    const resp = await fetch('/api/patient-auth/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: activationToken, password: data.password }),
    });
    const body = await resp.json();
    if (!resp.ok) {
      el.textContent = body.error || 'Activation failed'; el.hidden = false; return;
    }
    const tenantSlug = body.tenant?.slug || '';
    document.querySelector('#activate-form').hidden = true;
    document.querySelector('#activate-success').style.display = 'block';
    setTimeout(() => {
      window.location.href = tenantSlug ? `/${tenantSlug}` : '/';
    }, 2000);
  } catch (e) {
    el.textContent = 'Network error'; el.hidden = false;
  }
});

/* ── Init ── */
handleRoute();
window.addEventListener('popstate', handleRoute);

/* ── Super Admin ── */
async function showSuperAdmin() {
  document.querySelector('#super-admin-view').hidden = true;
  document.querySelector('#register-view').hidden = true;
  document.querySelector('#tenant-view').hidden = true;
  document.querySelector('#dashboard').hidden = false;
  const sa = document.querySelector('#super-admin-workspace');
  sa.hidden = false;
  // Hide clinic workspace content (sidebar + tabs + panels)
  const ws = document.querySelector('#dashboard > .workspace-grid');
  if (ws) ws.hidden = true;
  const dashHeader = document.querySelector('#dashboard > header');
  if (dashHeader) dashHeader.hidden = true;
  
  const grid = document.querySelector('#sa-tenant-grid');
  grid.innerHTML = '<p>Loading clinics...</p>';
  try {
    const resp = await fetch('/api/super-admin/tenants', { headers: headers() });
    const body = await resp.json();
    if (!body.ok || !body.tenants) { grid.innerHTML = '<p>Failed to load clinics</p>'; return; }
    grid.innerHTML = body.tenants.map(t => `
      <article class="card-rich card-clickable" data-sa-tenant="${t.slug}" style="cursor:pointer">
        <h3>${t.clinicName || t.name}</h3>
        <p class="card-meta">${t.status} · ${t.slug}</p>
        <div class="card-details">
          <span>👥 ${t.patientCount} patients</span>
          <span>📅 ${t.appointmentCount} appointments</span>
          <span>💰 ₦${t.revenueKobo.toLocaleString()}</span>
          <span>👤 ${t.staffCount} staff</span>
        </div>
      </article>
    `).join('');
    // Click handler — get tenant access token then navigate
    grid.querySelectorAll('[data-sa-tenant]').forEach(el => {
      el.addEventListener('click', async () => {
        const slug = el.dataset.saTenant;
        try {
          const resp = await fetch('/api/super-admin/tenant-access', {
            method: 'POST', headers: headers(), body: JSON.stringify({ slug })
          });
          const d = await resp.json();
          if (d.ok) {
            localStorage.setItem(TOKEN_KEY, d.token);
            localStorage.setItem(TENANT_KEY, d.tenantId);
            window.location.href = '/' + slug;
          } else {
            alert(d.error || 'Access denied');
          }
        } catch (err) {
          alert('Error: ' + err.message);
        }
      });
    });
  } catch (e) {
    grid.innerHTML = `<p>Error: ${e.message}</p>`;
  }
}

document.querySelector('#sa-logout')?.addEventListener('click', async () => {
  const proceed = await warnIfUnsyncedThenClear();
  if (!proceed) return;
  clearSession();
});

document.querySelectorAll('.sidebar-item').forEach((tab) => {
  tab.addEventListener('click', () => {
    const tabName = tab.dataset.tab;
    if (!tabName) return;
    document.querySelectorAll('.sidebar-item').forEach((item) => item.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((item) => item.classList.remove('active'));
    document.querySelectorAll('.auth-page').forEach((item) => item.classList.remove('active'));
    tab.classList.add('active');
    document.querySelector('.workspace-grid')?.classList.remove('auth-mode');
    const panel = document.querySelector(`#${tabName}`);
    if (panel) {
      panel.classList.add('active');
      console.log(`🔍 Tab "${tabName}": panel classList=${panel.className}, display=${getComputedStyle(panel).display}, innerHTML length=${panel.innerHTML.length}`);
    } else {
      console.error(`⚠️ Panel #${tabName} not found in DOM`);
    }
    // Persist tab selection
    localStorage.setItem('clinic_active_tab', tabName);
    // Lazy-load tab data
    if (tab.dataset.tab === 'settings') { loadSettings(); loadMessageLog(); }
    if (tab.dataset.tab === 'reports') { loadReport(); }
    if (tab.dataset.tab === 'ledger') { loadLedger(); }
  });
});

/* ── Mobile sidebar toggle ── */
document.querySelector('#sidebar-toggle')?.addEventListener('click', () => {
  document.querySelector('.sidebar')?.classList.toggle('open');
  document.querySelector('#sidebar-overlay')?.classList.toggle('show');
});
document.querySelector('#sidebar-overlay')?.addEventListener('click', () => {
  document.querySelector('.sidebar')?.classList.remove('open');
  document.querySelector('#sidebar-overlay')?.classList.remove('show');
});
// Close sidebar when clicking a tab on mobile
document.querySelectorAll('.sidebar-item').forEach(item => {
  item.addEventListener('click', () => {
    if (window.innerWidth <= 900) {
      document.querySelector('.sidebar')?.classList.remove('open');
      document.querySelector('#sidebar-overlay')?.classList.remove('show');
    }
  });
});

document.querySelectorAll('[data-menu-toggle]').forEach((toggle) => {
  toggle.addEventListener('click', () => {
    const menu = document.querySelector(`#${toggle.dataset.menuToggle}`);
    const expanded = toggle.getAttribute('aria-expanded') !== 'false';
    if (menu) menu.hidden = expanded;
    toggle.setAttribute('aria-expanded', String(!expanded));
    toggle.textContent = `Patients ${expanded ? '▸' : '▾'}`;
  });
});

seed?.addEventListener('click', async () => {
  seed.disabled = true;
  seed.textContent = 'Loading demo...';
  showError('');
  const response = await fetch('/api/demo/celon', { method: 'POST' });
  const body = await response.json();
  snapshot = body.snapshot;
  currentRole = 'owner';
  currentMemberId = (snapshot.members || []).find(m => m.role === 'owner')?.id || '';
  setSession(body.token, snapshot.tenant.id, 'staff');
  applyRBAC();
  await refresh();
  seed.disabled = false;
  seed.textContent = 'Celon demo loaded';
});

logout?.addEventListener('click', async () => {
  const proceed = await warnIfUnsyncedThenClear();
  if (!proceed) return;
  clearSession();
  seed.textContent = 'Load Celon 2-branch demo';
});

dashboardLogout?.addEventListener('click', async () => {
  const proceed = await warnIfUnsyncedThenClear();
  if (!proceed) return;
  clearSession();
  seed.textContent = 'Load Celon 2-branch demo';
});

patientDashboardLogout?.addEventListener('click', () => {
  clearSession();
});

document.querySelector('#branch-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  await fetch('/api/branches', { method: 'POST', headers: headers(), body: JSON.stringify({ tenantId, ...data }) });
  event.target.reset();
  await refresh();
});

document.querySelector('#patient-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = compactFormData(Object.fromEntries(new FormData(event.target)));
  const resultEl = document.querySelector('#patient-form-result');
  const result = await submitOrQueue(event.target, {
    entityType: 'patient',
    endpoint: '/api/patients',
    payload: { tenantId, ...data },
    errorEl: resultEl,
  });
  if (result.ok) { showSuccessToast('Patient added successfully.'); if (resultEl) resultEl.textContent = ''; }
  if (result.queued) showSuccessToast('Patient saved offline. It will sync when internet returns.');
});

document.querySelector('#appointment-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = formDataWithAc(event.target);
  const err = document.querySelector('#appointment-error');
  const serviceSelect = document.querySelector('#appointment-service-select');
  const selectedIds = Array.from(serviceSelect.selectedOptions).map(o => o.value).filter(Boolean);
  const selectedServices = (snapshot.services || []).filter(s => selectedIds.includes(s.id));
  const payload = {
    tenantId,
    ...data,
    serviceName: selectedServices.map(s => s.name).join(' + ') || data.serviceName,
    serviceId: selectedServices.length === 1 ? selectedServices[0].id : undefined,
    doctorMemberId: data.doctorMemberId || undefined,
    startsAt: new Date(data.startsAt).toISOString(),
  };
  const result = await submitOrQueue(event.target, {
    entityType: 'appointment',
    endpoint: '/api/appointments',
    payload,
    errorEl: err,
  });
  if (result.queued && err) err.textContent = '';
});

document.querySelector('#availability-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  const params = new URLSearchParams({ branchId: data.branchId, doctorMemberId: data.doctorMemberId, date: data.date });
  const response = await fetch(`/api/availability?${params.toString()}`, { headers: headers() });
  const body = await response.json();
  document.querySelector('#availability-slots').innerHTML = (body.slots || []).map((slot) => {
    const t = new Date(slot.startsAt);
    const time = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
    const reasonMap = {
      'DOCTOR_NOT_AVAILABLE': 'Doctor not available',
      'APPOINTMENT_CONFLICT': 'Not available',
      'PATIENT_APPOINTMENT_CONFLICT': 'You have another appointment',
      'NO_SCHEDULE': 'No schedule',
    };
    const status = slot.available ? 'available' : (reasonMap[slot.reason] || slot.reason || 'unavailable');
    const style = slot.available ? 'cursor:pointer' : 'opacity:0.5';
    return `<article class="card-clickable" data-slot="${slot.startsAt}" style="${style}"><h3>${time}</h3><p>${status}</p></article>`;
  }).join('') || `<p>${body.error || 'No slots'}</p>`;
  // Add click handler to fill appointment time
  document.querySelectorAll('#availability-slots article[data-slot]').forEach(el => {
    el.addEventListener('click', () => {
      const dt = new Date(el.dataset.slot);
      const local = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      document.querySelector('[name="startsAt"]').value = local;
      el.scrollIntoView({ behavior: 'smooth' });
    });
  });
});

document.querySelector('#member-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  const editId = form.dataset.editId;
  if (editId) {
    // Only send password if it was filled
    if (!data.password) delete data.password;
    const upResp = await fetch(`/api/staff/${editId}/update`, { method: 'POST', headers: headers(), body: JSON.stringify(data) });
    const upResult = await upResp.json().catch(() => ({}));
    if (!upResp.ok || !upResult.ok) { alert('❌ Update failed: ' + (upResult.error || 'Unknown error')); return; }
    delete form.dataset.editId;
    form.querySelector('button').textContent = 'Create Staff';
    document.querySelector('#staff-reset-pw').style.display = 'none';
    alert('✅ Staff updated successfully');
  } else {
    // Create staff: if password provided, create directly; otherwise send invite
    // Clean empty values and validate required fields
    if (!data.role) { alert('Please select a role'); return; }
    if (!data.displayName) { alert('Please enter display name'); return; }
    Object.keys(data).forEach(k => { if (!data[k]) delete data[k]; });
    const resp = await fetch(`/api/tenants/${tenantId}/invite`, { method: 'POST', headers: headers(), body: JSON.stringify(data) });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok || !result.ok) { alert('❌ Failed: ' + (result.error || 'Unknown error')); return; }
    alert('✅ Staff created successfully');
  }
  form.reset();
  await refresh();
});

/* ── HMO Insurance ── */
async function loadHmoList(patientId) {
  const list = document.querySelector('#hmo-list');
  try {
    const resp = await fetch(`/api/hmo?patientId=${patientId}`, { headers: headers() });
    const body = await resp.json();
    list.innerHTML = (body.insurances || []).map(h => `
      <article class="card-rich">
        <h3>${h.hmoName} ${h.active ? '' : '(disabled)'}</h3>
        <p>${h.hmoNumber || 'No ID'} · ${h.coverageType === 'percentage' ? h.coverageValue + '% coverage' : '₦' + Number(h.coverageValue).toLocaleString() + ' fixed'}</p>
        <div class="card-actions">
          <button data-toggle-hmo="${h.id}" data-active="${!h.active}">${h.active ? 'Disable' : 'Enable'}</button>
          <button data-delete-hmo="${h.id}" style="background:var(--danger)" onclick="fetch('/api/hmo/${h.id}/delete',{method:'POST',headers:{'Authorization':'Bearer '+localStorage.getItem('clinic_jwt')}}).then(r=>r.json()).then(d=>{if(d.ok){window._reloadHmo()}else{alert(d.error)}}).catch(e=>alert(e.message))">Delete</button>
        </div>
      </article>
    `).join('') || '<p>No HMO records for this patient.</p>';
    // Toggle handler only (delete is inline onclick)
    list.querySelectorAll('[data-toggle-hmo]').forEach(btn => {
      btn.onclick = async () => {
        await fetch(`/api/hmo/${btn.dataset.toggleHmo}`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ active: btn.dataset.active === 'true' }) });
        const pid = document.querySelector('#hmo-form [name="patientId"]')?.value;
        if (pid) loadHmoList(pid);
      };
    });
  } catch { list.innerHTML = '<p>Failed to load HMO records.</p>'; }
}

// Global helper for inline delete onclick (module scripts can't access module functions from global scope)
window._reloadHmo = function() {
  const pid = document.querySelector('#hmo-form [name="patientId"]')?.value;
  if (pid) loadHmoList(pid);
};

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('#hmo-form');
  if (!form) return;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  await fetch('/api/hmo', {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ patientId: data.patientId, hmoName: data.hmoName, hmoNumber: data.hmoNumber || undefined, coverageType: data.coverageType, coverageValue: Number(data.coverageValue) }),
  });
  form.reset();
  loadHmoList(data.patientId);
});

/* ── HMO toggle delegated click handler ── */
document.querySelector('#patient-detail-body')?.addEventListener('click', async (e) => {
  const toggle = e.target.closest('[data-toggle-hmo]');
  if (!toggle) return;
  await fetch(`/api/hmo/${toggle.dataset.toggleHmo}`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ active: toggle.dataset.active === 'true' }) });
  const pid = document.querySelector('#hmo-form [name="patientId"]')?.value;
  if (pid) loadHmoList(pid);
});

document.querySelector('#service-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  const editId = event.target.dataset.editId;
  const url = editId ? `/api/services/${editId}` : '/api/services';
  const method = editId ? 'PATCH' : 'POST';
  await fetch(url, {
    method,
    headers: headers(),
    body: JSON.stringify({ tenantId, name: data.name, durationMinutes: Number(data.durationMinutes), priceKobo: Number(data.price) }),
  });
  event.target.reset();
  delete event.target.dataset.editId;
  event.target.querySelector('button').textContent = 'Add service';
  await refresh();
});

document.querySelector('#calendar-filter').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  const params = new URLSearchParams();
  if (data.branchId) params.set('branchId', data.branchId);
  if (data.doctorMemberId) params.set('doctorMemberId', data.doctorMemberId);
  if (data.status) params.set('status', data.status);
  if (data.from) params.set('from', new Date(data.from).toISOString());
  if (data.to) params.set('to', new Date(`${data.to}T23:59:59.000Z`).toISOString());
  const response = await fetch(`/api/appointments?${params.toString()}`, { headers: headers() });
  const body = await response.json();
  const list = body.appointments || [];
  document.querySelector('#calendar-list').innerHTML = list.map((appt) => {
    const branch = snapshot.branches.find((item) => item.id === appt.branchId);
    const patient = snapshot.patients.find((item) => item.id === appt.patientId);
    return `<article><h3>${appt.serviceName}</h3><p>${patient?.firstName || 'Patient'} at ${branch?.name || 'Branch'} · ${appt.status}</p><small>${new Date(appt.startsAt).toLocaleString()}</small></article>`;
  }).join('');
});

document.querySelector('#schedule-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  await fetch('/api/doctor-schedules', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      tenantId,
      branchId: data.branchId,
      doctorMemberId: data.doctorMemberId,
      weekday: Number(data.weekday),
      startsAt: data.startsAt,
      endsAt: data.endsAt,
      slotMinutes: Number(data.slotMinutes),
    }),
  });
  event.target.reset();
  await refresh();
});

document.querySelector('#encounter-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = formDataWithAc(event.target);
  // Auto-assign doctor: if current user is a doctor/radiologist, use their member ID; otherwise use dropdown selection
  const isDoctorRole = currentRole === 'doctor' || currentRole === 'radiologist' || currentRole === 'therapist' || currentRole === 'lab_technician';
  const doctorMemberId = isDoctorRole ? currentMemberId : (data.doctorMemberId || undefined);
  const specialistPayload = buildSpecialistPayload();
  await submitOrQueue(event.target, {
    entityType: 'encounter',
    endpoint: '/api/encounters',
    payload: {
      tenantId,
      branchId: data.branchId,
      patientId: data.patientId,
      appointmentId: data.appointmentId || undefined,
      doctorMemberId,
      reason: data.reason,
      diagnosis: data.diagnosis,
      clinicalNotes: data.clinicalNotes,
      vitals: { bloodPressure: data.bloodPressure || undefined, temperatureC: data.temperatureC ? Number(data.temperatureC) : undefined },
      specialistData: specialistPayload,
    },
  });
  // Reset specialist chart after submission
  currentEncounterSpecialistData = {};
  currentEncounterSpecialistType = '';
  const diagramSelect = document.querySelector('#diagram-type');
  if (diagramSelect) { diagramSelect.value = ''; document.querySelector('#diagram-render-area').innerHTML = ''; }
});

document.querySelector('#prescription-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = formDataWithAc(event.target);
  const result = await submitOrQueue(event.target, {
    entityType: 'prescription',
    endpoint: '/api/prescriptions',
    payload: {
      tenantId,
      encounterId: data.encounterId || undefined,
      patientId: data.patientId || undefined,
      notes: data.instructions || undefined,
      items: [{ medication: data.medication, dosage: data.dosage, frequency: data.frequency, duration: data.duration, instructions: data.instructions }],
    },
  });
  if (result && result.ok) showSuccessToast('Prescription saved.');
});

document.querySelector('#invoice-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = formDataWithAc(event.target);
  // Calculate HMO coverage
  let hmoCoverageKobo = 0;
  const hmoSel = document.querySelector('#invoice-hmo-select');
  const hmoOpt = hmoSel.options[hmoSel.selectedIndex];
  if (hmoOpt && hmoOpt.value) {
    const total = Number(data.unitPrice) * Number(data.quantity);
    hmoCoverageKobo = hmoOpt.dataset.type === 'percentage'
      ? Math.round(total * Number(hmoOpt.dataset.value) / 100)
      : Number(hmoOpt.dataset.value);
  }
  // Calculate discount
  const discType = document.querySelector('#discount-type')?.value || 'fixed';
  const discVal = Number(document.querySelector('#discount-value')?.value || 0);
  const subtotal = Number(data.unitPrice) * Number(data.quantity);
  let discountKobo = discType === 'percentage' ? Math.round(subtotal * discVal / 100) : discVal;
  if (discountKobo > subtotal) discountKobo = subtotal;
  await submitOrQueue(event.target, {
    entityType: 'invoice',
    endpoint: '/api/invoices',
    payload: {
      tenantId,
      branchId: data.branchId,
      patientId: data.patientId,
      appointmentId: data.appointmentId || undefined,
      encounterId: data.encounterId || undefined,
      discountKobo,
      hmoInsuranceId: hmoOpt?.value || undefined,
      hmoCoverageKobo,
      lines: [{ description: data.description, quantity: Number(data.quantity), unitPriceKobo: Number(data.unitPrice), inventoryItemId: document.querySelector('#inv-desc')?.dataset?.inventoryItemId || undefined }],
    },
  });
});

document.querySelector('#document-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = formDataWithAc(form);
  const fileInput = form.querySelector('[name="file"]');
  let fileUrl = data.fileUrl || undefined;
  // Upload file first if selected
  if (fileInput?.files?.[0]) {
    const fd = new FormData();
    fd.append('file', fileInput.files[0]);
    const resp = await fetch('/api/upload', { method: 'POST', body: fd });
    const body = await resp.json();
    if (body.ok) fileUrl = body.url;
    else { alert('Upload failed: ' + (body.error || 'unknown')); return; }
  }
  await submitOrQueue(form, {
    entityType: 'patientDocument',
    endpoint: '/api/patient-documents',
    payload: {
      tenantId,
      patientId: data.patientId,
      encounterId: data.encounterId || undefined,
      title: data.title,
      documentType: data.documentType,
      fileUrl,
      notes: data.notes,
    },
  });
});

document.querySelector('#patient-invite-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = formDataWithAc(event.target);
  const response = await fetch('/api/patient-auth/invite', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ tenantId, patientId: data.patientId, email: data.email }),
  });
  const body = await response.json();
  document.querySelector('#activation-token').textContent = body.activationToken
    ? `Dev activation token: ${body.activationToken}`
    : (body.error || '');
  await refresh();
});

document.querySelector('#bulk-invite-btn')?.addEventListener('click', async () => {
  const patients = snapshot?.patients || [];
  const withEmail = patients.filter(p => p.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email));
  const alreadyInvited = (snapshot?.patientAccounts || []).filter(a => a.status === 'invited').map(a => a.email);
  const toInvite = withEmail.filter(p => !alreadyInvited.includes(p.email));
  
  if (toInvite.length === 0) {
    document.querySelector('#bulk-invite-result').textContent = 'No patients with valid email to invite.';
    return;
  }
  
  const btn = document.querySelector('#bulk-invite-btn');
  btn.disabled = true;
  btn.textContent = `Inviting ${toInvite.length} patients...`;
  
  try {
    const res = await fetch('/api/patient-auth/bulk-invite', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ tenantId, patientIds: toInvite.map(p => p.id) }),
    });
    const data = await res.json();
    if (data.ok) {
      document.querySelector('#bulk-invite-result').textContent = 
        `✅ ${data.summary.invited} invited, ${data.summary.skipped} skipped`;
      await refresh();
    } else {
      document.querySelector('#bulk-invite-result').textContent = `❌ ${data.error || 'Failed'}`;
    }
  } catch (e) {
    document.querySelector('#bulk-invite-result').textContent = `❌ ${e.message}`;
  }
  btn.disabled = false;
  btn.textContent = 'Bulk invite patients with email';
});

document.querySelector('#notification-filter').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  const params = new URLSearchParams();
  if (data.status) params.set('status', data.status);
  if (data.type) params.set('type', data.type);
  const response = await fetch(`/api/notifications?${params.toString()}`, { headers: headers() });
  const body = await response.json();
  notifications = body.notifications || [];
  render();
});

document.querySelector('#notification-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  await fetch('/api/notifications', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      channel: data.channel,
      type: data.type,
      recipient: data.recipient,
      subject: data.subject || undefined,
      body: data.body,
    }),
  });
  event.target.reset();
  await refresh();
});

document.querySelector('#audit-filter').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  const params = new URLSearchParams();
  if (data.action) params.set('action', data.action);
  if (data.objectType) params.set('objectType', data.objectType);
  const response = await fetch(`/api/audit-logs?${params.toString()}`, { headers: headers() });
  const body = await response.json();
  auditLogs = body.auditLogs || [];
  render();
});

document.addEventListener('click', async (event) => {
  const signBtn = event.target.closest('[data-sign]');
  const issueBtn = event.target.closest('[data-issue]');
  const issueInvoiceBtn = event.target.closest('[data-issue-invoice]');
  const signId = signBtn?.dataset?.sign;
  const issueId = issueBtn?.dataset?.issue;
  const issueInvoiceId = issueInvoiceBtn?.dataset?.issueInvoice;
  const payId = event.target.dataset?.pay;
  const hmoId = event.target.dataset?.hmoInvoice;
  const sentId = event.target.dataset?.notifSent;
  const failedId = event.target.dataset?.notifFailed;
  const cancelId = event.target.dataset?.notifCancel;
  const dryId = event.target.dataset?.dryRun;
  const resendId = event.target.dataset?.resend;
  const disableId = event.target.dataset?.disableAccount;
  const billingErr = document.querySelector('#billing-error');
  if (signId) await fetch(`/api/encounters/${signId}/sign`, { method: 'POST', headers: headers(), body: '{}' });
  if (issueId) await fetch(`/api/prescriptions/${issueId}/issue`, { method: 'POST', headers: headers(), body: '{}' });
  if (issueInvoiceId) {
    const resp = await fetch(`/api/invoices/${issueInvoiceId}/issue`, { method: 'POST', headers: headers(), body: '{}' });
    const body = await resp.json();
    if (billingErr) billingErr.textContent = resp.ok ? '✅ Invoice issued' : (body.error || 'Failed');
    if (resp.ok) await refresh();
  }
  if (payId) {
    const invoice = (snapshot.invoices || []).find(i => i.id === payId);
    if (!invoice) return;
    document.querySelector('#pay-modal-invoice').textContent = `Invoice: ${invoice.invoiceNumber} · Balance: ₦${((invoice.balanceKobo || invoice.totalKobo - invoice.amountPaidKobo)).toLocaleString()}`;
    document.querySelector('#pay-modal-amount').value = 0;
    document.querySelector('#pay-modal').hidden = false;
    document.querySelector('#pay-modal').dataset.invoiceId = payId;
    // Force overlay styling inline
    const pm = document.querySelector('#pay-modal');
    pm.style.cssText = 'position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;background:rgba(0,0,0,0.7)!important;z-index:99999!important;display:flex!important;align-items:center!important;justify-content:center!important';
    pm.querySelector('.modal-card').style.cssText = 'background:#fff!important;border-radius:12px;padding:24px;min-width:340px;max-width:90vw;box-shadow:0 8px 40px rgba(0,0,0,0.2);position:relative;z-index:100000';
  }
  if (hmoId) {
    // Find the invoice to get patientId
    const invoice = (snapshot.invoices || []).find(i => i.id === hmoId);
    if (!invoice) return;
    // Load patient HMOs
    try {
      const resp = await fetch(`/api/hmo?patientId=${invoice.patientId}`, { headers: headers() });
      const body = await resp.json();
      const sel = document.querySelector('#hmo-modal-select');
      sel.innerHTML = '<option value="">Select HMO</option>' + (body.insurances || []).filter(h => h.active).map(h =>
        `<option value="${h.id}" data-type="${h.coverageType}" data-value="${h.coverageValue}">${h.hmoName} (${h.coverageType === 'percentage' ? h.coverageValue + '%' : '₦' + Number(h.coverageValue).toLocaleString()})</option>`
      ).join('');
    } catch {}
    document.querySelector('#hmo-modal-invoice').textContent = `Invoice: ${invoice.invoiceNumber} · Balance: ₦${((invoice.balanceKobo || invoice.totalKobo - invoice.amountPaidKobo)).toLocaleString()}`;
    document.querySelector('#hmo-modal-amount').value = 0;
    document.querySelector('#hmo-modal').hidden = false;
    document.querySelector('#hmo-modal').dataset.invoiceId = hmoId;
    // Force overlay styling inline
    const hm = document.querySelector('#hmo-modal');
    hm.style.cssText = 'position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;background:rgba(0,0,0,0.7)!important;z-index:99999!important;display:flex!important;align-items:center!important;justify-content:center!important';
    hm.querySelector('.modal-card').style.cssText = 'background:#fff!important;border-radius:12px;padding:24px;min-width:340px;max-width:90vw;box-shadow:0 8px 40px rgba(0,0,0,0.2);position:relative;z-index:100000';
  }
  if (sentId) await fetch(`/api/notifications/${sentId}/mark-sent`, { method: 'POST', headers: headers(), body: '{}' });
  if (failedId) await fetch(`/api/notifications/${failedId}/mark-failed`, { method: 'POST', headers: headers(), body: JSON.stringify({ error: 'manual fail' }) });
  if (cancelId) await fetch(`/api/notifications/${cancelId}/cancel`, { method: 'POST', headers: headers(), body: '{}' });
  if (dryId) await fetch(`/api/notifications/${dryId}/send-dry-run`, { method: 'POST', headers: headers(), body: '{}' });
  if (resendId) {
    const response = await fetch(`/api/patient-auth/${resendId}/resend-invite`, { method: 'POST', headers: headers(), body: '{}' });
    const body = await response.json();
    document.querySelector('#activation-token').textContent = body.activationToken ? `Dev activation token: ${body.activationToken}` : (body.error || '');
  }
  if (disableId) await fetch(`/api/patient-auth/${disableId}/disable`, { method: 'POST', headers: headers(), body: '{}' });
  if (signId || issueId || issueInvoiceId || payId || sentId || failedId || cancelId || dryId || resendId || disableId) await refresh();
});

/* ── Patient import helpers ── */
function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parseCsvText(content) {
  const rows = [];
  let cell = '';
  let row = [];
  let quoted = false;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    const next = content[i + 1];
    if (ch === '"') {
      if (quoted && next === '"') { cell += '"'; i += 1; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      row.push(cell.trim()); cell = '';
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && next === '\n') i += 1;
      row.push(cell.trim()); cell = '';
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  const headers = rows.shift() || [];
  return rows.map((values) => Object.fromEntries(headers.map((header, idx) => [header, values[idx] || ''])));
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function bestImportHeader(field) {
  const aliases = {
    clinicPatientId: ['Existing Patient ID', 'Patient ID', 'Clinic Patient ID', 'Hospital Number', 'File Number', 'Card Number'],
    firstName: ['First Name', 'Firstname', 'Given Name', 'Name'],
    lastName: ['Last Name', 'Surname', 'Family Name'],
    phone: ['Phone', 'Phone Number', 'Mobile', 'Telephone'],
    email: ['Email', 'Email Address'],
    altPhone: ['Alternate Phone', 'Alt Phone', 'Other Phone'],
    dob: ['Date of Birth', 'DOB', 'Birth Date'],
    gender: ['Gender', 'Sex'],
    bloodGroup: ['Blood Group', 'Blood Type'],
    address: ['Address', 'Home Address'],
    city: ['City', 'Town'],
    state: ['State'],
    medicalHistory: ['Medical History', 'History', 'Allergies', 'Notes'],
  };
  return (aliases[field] || []).find((name) => patientImportHeaders.includes(name)) || '';
}

function renderPatientImportMapper() {
  const wrap = document.querySelector('#patient-import-mapping');
  const preview = document.querySelector('#patient-import-preview');
  if (!wrap) return;
  if (!patientImportRows.length) {
    wrap.hidden = true;
    preview.innerHTML = '';
    return;
  }
  wrap.hidden = false;
  const optionHtml = (selected) => `<option value="">Do not import</option>` + patientImportHeaders.map((header) => `<option value="${escapeHtml(header)}" ${header === selected ? 'selected' : ''}>${escapeHtml(header)}</option>`).join('');
  wrap.innerHTML = `
    <h4>Map your file columns</h4>
    <div class="mapping-grid">
      ${PATIENT_IMPORT_FIELDS.map(([field, label]) => `<label><span>${label}</span><select data-import-field="${field}">${optionHtml(bestImportHeader(field))}</select></label>`).join('')}
    </div>
    <button type="button" id="run-patient-import">Import ${patientImportRows.length} rows</button>`;
  const sampleRows = patientImportRows.slice(0, 5);
  preview.innerHTML = `<h4>Preview first ${sampleRows.length} rows</h4><div class="table-scroll"><table class="data-table"><thead><tr>${patientImportHeaders.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${sampleRows.map((row) => `<tr>${patientImportHeaders.map((h) => `<td>${escapeHtml(row[h] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  /* Populate branch dropdown */
  const branchSelect = document.querySelector('#patient-import-branch');
  if (branchSelect && snapshot) {
    const currentVal = branchSelect.value;
    branchSelect.innerHTML = '<option value="">No branch (unassigned)</option>' +
      (snapshot.branches || []).map((b) => `<option value="${b.id}" ${b.id === currentVal ? 'selected' : ''}>${b.name}</option>`).join('');
  }
}

async function parsePatientImportFile(file) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.csv')) {
    patientImportRows = parseCsvText(await readFileAsText(file));
  } else if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    if (!window.XLSX) throw new Error('Excel parser is still loading. Please retry in a moment or upload CSV.');
    const workbook = window.XLSX.read(await readFileAsArrayBuffer(file), { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    patientImportRows = window.XLSX.utils.sheet_to_json(sheet, { defval: '' });
  } else {
    throw new Error('Please upload a CSV or Excel file.');
  }
  patientImportHeaders = Object.keys(patientImportRows[0] || {});
  renderPatientImportMapper();
}

document.querySelector('#download-patient-template')?.addEventListener('click', () => {
  const sample = [
    PATIENT_TEMPLATE_HEADERS,
    ['CELON-001','Ada','Okafor','08011111111','ada@example.com','08099999999','1988-04-21','female','O+','12 Admiralty Way','Lekki','Lagos','No known allergies'],
    ['CELON-002','Bola','Tunde','08022222222','bola@example.com','','1991-09-13','male','A+','Allen Avenue','Ikeja','Lagos','Hypertension'],
  ].map((row) => row.map(csvEscape).join(',')).join('\n');
  const blob = new Blob([sample], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'fidean-clinic-patient-import-template.csv';
  a.click();
  URL.revokeObjectURL(a.href);
});

document.querySelector('#download-patient-xlsx-template')?.addEventListener('click', () => {
  const result = document.querySelector('#patient-import-result');
  if (!window.XLSX) {
    result.textContent = 'Excel template tool is still loading. Use CSV now or retry in a moment.';
    return;
  }
  const rows = [
    Object.fromEntries(PATIENT_TEMPLATE_HEADERS.map((h) => [h, ''])),
    { 'Existing Patient ID': 'CELON-001', 'First Name': 'Ada', 'Last Name': 'Okafor', Phone: '08011111111', Email: 'ada@example.com', 'Alternate Phone': '08099999999', 'Date of Birth': '1988-04-21', Gender: 'female', 'Blood Group': 'O+', Address: '12 Admiralty Way', City: 'Lekki', State: 'Lagos', 'Medical History': 'No known allergies' },
    { 'Existing Patient ID': 'CELON-002', 'First Name': 'Bola', 'Last Name': 'Tunde', Phone: '08022222222', Email: 'bola@example.com', 'Date of Birth': '1991-09-13', Gender: 'male', 'Blood Group': 'A+', Address: 'Allen Avenue', City: 'Ikeja', State: 'Lagos', 'Medical History': 'Hypertension' },
  ];
  const sheet = window.XLSX.utils.json_to_sheet(rows, { header: PATIENT_TEMPLATE_HEADERS });
  const book = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(book, sheet, 'Patients');
  window.XLSX.writeFile(book, 'fidean-clinic-patient-import-template.xlsx');
});

document.querySelector('#patient-import-file')?.addEventListener('change', async (event) => {
  const result = document.querySelector('#patient-import-result');
  try {
    result.textContent = 'Reading file...';
    const file = event.target.files?.[0];
    if (!file) return;
    await parsePatientImportFile(file);
    result.textContent = `Loaded ${patientImportRows.length} rows. Confirm mapping, then import.`;
  } catch (error) {
    result.textContent = error.message || 'Could not read import file.';
  }
});

/* ── Patient search filtering ── */
document.querySelector('#patient-search-input')?.addEventListener('input', () => {
  if (!snapshot) return;
  const q = document.querySelector('#patient-search-input').value.toLowerCase().trim();
  const list = document.querySelector('#patient-list');
  if (!q) {
    render();
    return;
  }
  list.querySelectorAll('article').forEach(a => {
    const text = a.textContent.toLowerCase();
    a.style.display = text.includes(q) ? '' : 'none';
  });
});

/* ── Patient branch filter (list-only update, no full re-render) ── */
document.querySelector('#patient-branch-filter')?.addEventListener('change', () => {
  if (!snapshot || !document.querySelector('#patient-list')) return;
  const filter = document.querySelector('#patient-branch-filter').value;
  const filtered = filter ? snapshot.patients.filter((p) => p.branchId === filter) : snapshot.patients;
  const esc = (s) => { if (s == null) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
  document.querySelector('#patient-list').innerHTML = filtered.map((patient) => {
    const branchName = snapshot.branches.find((b) => b.id === patient.branchId)?.name || '';
    return `<article class="card-rich card-clickable" data-patient-id="${patient.id}"><h3>${esc(patient.firstName)} ${esc(patient.lastName)}</h3><p class="card-meta">${patient.clinicPatientId ? 'Clinic ID: ' + esc(patient.clinicPatientId) + ' &middot; ' : ''}${patient.patientCode} &middot; ${esc(patient.phone)}${branchName ? ' <span class="badge badge-active">' + esc(branchName) + '</span>' : ''}</p><div class="card-details">${patient.email ? '<span>&#9993; ' + esc(patient.email) + '</span>' : ''}${patient.dob ? '<span>&#128197; DOB: ' + new Date(patient.dob).toLocaleDateString() + '</span>' : ''}${patient.gender ? '<span>&#9906; ' + esc(patient.gender) + '</span>' : ''}${patient.bloodGroup ? '<span>&#129656; ' + esc(patient.bloodGroup) + '</span>' : ''}${patient.address ? '<span>&#128205; ' + esc(patient.address) + (patient.city ? ', ' + esc(patient.city) : '') + (patient.state ? ', ' + esc(patient.state) : '') + '</span>' : ''}${patient.medicalHistory ? '<small class="card-note">&#128203; ' + esc(patient.medicalHistory.substring(0,80)) + '</small>' : ''}</div></article>`;
  }).join('');
});

/* ── Patient detail view ── */
function renderPatientDetail(patientId) {
  const patient = (snapshot.patients || []).find(p => p.id === patientId);
  if (!patient) return;
  currentPatientId = patientId;
  const pt = document.querySelector('#patients');
  pt.querySelector('.patient-search').hidden = true;
  pt.querySelector('#patient-list').hidden = true;
  const detail = pt.querySelector('#patient-detail');
  detail.hidden = false;

  const header = pt.querySelector('#patient-detail-header');
  header.innerHTML = `<h2>${patient.firstName} ${patient.lastName || ''}</h2>
    <p>${patient.clinicPatientId ? 'Clinic ID: ' + patient.clinicPatientId + ' · ' : ''}${patient.patientCode} · ${patient.phone}${patient.email ? ' · ' + patient.email : ''}</p>`;

  renderPatientSubTab('info', patient);
}

function renderPatientSubTab(subtab, patient) {
  const body = document.querySelector('#patient-detail-body');
  const tabs = document.querySelectorAll('.detail-tab');
  tabs.forEach(t => t.classList.toggle('active', t.dataset.subtab === subtab));

  if (subtab === 'info') {
    body.innerHTML = `<div class="detail-grid">
      <div class="detail-field"><label>Clinic Patient ID</label><input name="clinicPatientId" value="${escapeHtml(patient.clinicPatientId || '')}" /></div>
      <div class="detail-field"><label>System Patient Code</label><span>${escapeHtml(patient.patientCode)}</span></div>
      <div class="detail-field"><label>First Name</label><input name="firstName" value="${escapeHtml(patient.firstName)}" /></div>
      <div class="detail-field"><label>Last Name</label><input name="lastName" value="${escapeHtml(patient.lastName || '')}" /></div>
      <div class="detail-field"><label>Email</label><input name="email" type="email" value="${escapeHtml(patient.email || '')}" /></div>
      <div class="detail-field"><label>Phone</label><input name="phone" value="${escapeHtml(patient.phone)}" /></div>
      <div class="detail-field"><label>Alt Phone</label><input name="altPhone" value="${escapeHtml(patient.altPhone || '')}" /></div>
      <div class="detail-field"><label>Date of Birth</label><input name="dob" type="date" value="${patient.dob ? patient.dob.slice(0,10) : ''}" /></div>
      <div class="detail-field"><label>Gender</label><select name="gender"><option value="">Select</option><option value="male" ${patient.gender === 'male' ? 'selected' : ''}>Male</option><option value="female" ${patient.gender === 'female' ? 'selected' : ''}>Female</option><option value="other" ${patient.gender === 'other' ? 'selected' : ''}>Other</option></select></div>
      <div class="detail-field"><label>Blood Group</label><select name="bloodGroup"><option value="">Select</option>${['A+','A-','B+','B-','AB+','AB-','O+','O-'].map(g => `<option value="${g}" ${patient.bloodGroup === g ? 'selected' : ''}>${g}</option>`).join('')}</select></div>
      <div class="detail-field"><label>Address</label><input name="address" value="${escapeHtml(patient.address || '')}" /></div>
      <div class="detail-field"><label>City</label><input name="city" value="${escapeHtml(patient.city || '')}" /></div>
      <div class="detail-field"><label>State</label><input name="state" value="${escapeHtml(patient.state || '')}" /></div>
      <div class="detail-field full"><label>Medical History</label><textarea name="medicalHistory">${escapeHtml(patient.medicalHistory || '')}</textarea></div>
    </div>
    <div class="detail-edit-actions">
      <button class="detail-save-btn" data-save-patient="${patient.id}">Save changes</button>
      <button class="detail-cancel-btn" data-back-to-patients="1">Back</button>
    </div>`;
    return;
  }

  if (subtab === 'hmo') {
    body.innerHTML = `<h3>Insurance (HMO)</h3>
    <form id="hmo-form" class="form" style="margin-bottom:16px">
      <input name="patientId" type="hidden" value="${patient.id}" />
      <input name="hmoName" placeholder="HMO name (e.g. NHIS, AXA)" required />
      <input name="hmoNumber" placeholder="HMO number / ID" />
      <select name="coverageType">
        <option value="percentage">Percentage coverage</option>
        <option value="fixed">Fixed amount (₦)</option>
      </select>
      <input name="coverageValue" type="number" placeholder="Coverage value (e.g. 80 for 80%)" min="0" required />
      <button type="submit">Add HMO</button>
    </form>
    <div id="hmo-list"></div>`;
    loadHmoList(patient.id);
    return;
  }

  let items = [];
  const filterPatient = subtab === 'encounters' ? (snapshot.encounters || []).filter(e => e.patientId === patient.id) :
    subtab === 'prescriptions' ? (snapshot.prescriptions || []).filter(p => p.patientId === patient.id) :
    subtab === 'invoices' ? (snapshot.invoices || []).filter(i => i.patientId === patient.id) :
    (snapshot.patientDocuments || []).filter(d => d.patientId === patient.id);

  if (items.length === 0 && filterPatient.length > 0) items = filterPatient;
  else if (items.length === 0) items = [{ empty: true }];

  if (subtab === 'encounters') {
    body.innerHTML = items.length === 0 || items[0]?.empty
      ? '<p class="detail-empty">No encounters for this patient.</p>'
      : '<div class="detail-sub-list">' + items.map(e =>
        `<div class="detail-sub-item"><h4>${e.reason || 'Encounter'}</h4><p>${e.status}${e.diagnosis ? ' · ' + e.diagnosis : ''}</p><small>${new Date(e.createdAt).toLocaleString()}</small></div>`
      ).join('') + '</div>';
  } else if (subtab === 'prescriptions') {
    body.innerHTML = items.length === 0 || items[0]?.empty
      ? '<p class="detail-empty">No prescriptions for this patient.</p>'
      : '<div class="detail-sub-list">' + items.map(p =>
        `<div class="detail-sub-item"><h4>${p.items?.[0]?.medication || 'Prescription'}</h4><p>${p.status}${p.items?.[0]?.dosage ? ' · ' + p.items[0].dosage : ''}</p><small>${new Date(p.createdAt).toLocaleString()}</small></div>`
      ).join('') + '</div>';
  } else if (subtab === 'invoices') {
    body.innerHTML = items.length === 0 || items[0]?.empty
      ? '<p class="detail-empty">No invoices for this patient.</p>'
      : '<div class="detail-sub-list">' + items.map(i =>
        `<div class="detail-sub-item"><h4>${i.invoiceNumber}</h4><p>₦${i.totalKobo.toLocaleString()} · ${i.status}</p><small>${new Date(i.createdAt).toLocaleString()}</small></div>`
      ).join('') + '</div>';
  } else if (subtab === 'documents') {
    body.innerHTML = items.length === 0 || items[0]?.empty
      ? '<p class="detail-empty">No documents for this patient.</p>'
      : '<div class="detail-sub-list">' + items.map(d =>
        `<div class="detail-sub-item"><h4>${d.title}</h4><p>${d.documentType}${d.fileUrl ? ' · <a href="' + escapeHtml(d.fileUrl) + '" target="_blank">View</a>' : ''}</p><small>${new Date(d.createdAt).toLocaleString()}</small></div>`
      ).join('') + '</div>';
  }
}

function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── Staff detail view ── */
function renderStaffDetail(memberId) {
  const member = (snapshot.members || []).find(m => m.id === memberId);
  if (!member) return;
  const st = document.querySelector('#staff');
  st.querySelector('#member-form').hidden = true;
  st.querySelector('#member-list').hidden = true;
  const detail = st.querySelector('#staff-detail');
  detail.hidden = false;

  const header = st.querySelector('#staff-detail-header');
  header.innerHTML = `<h2>${member.displayName || member.email}</h2>
    <p>${member.role}${member.email ? ' · ' + member.email : ''}</p>`;

  const body = st.querySelector('#staff-detail-body');
  body.innerHTML = `<div class="detail-grid">
    <div class="detail-field"><label>Email</label><span>${escapeHtml(member.email)}</span></div>
    <div class="detail-field"><label>Display Name</label><span>${escapeHtml(member.displayName || '—')}</span></div>
    <div class="detail-field"><label>Role</label><span>${member.role}</span></div>
    <div class="detail-field"><label>Status</label><span>${member.status}</span></div>
    <div class="detail-field"><label>Phone</label><span>${escapeHtml(member.phone || '—')}</span></div>
    <div class="detail-field"><label>Specialization</label><span>${member.specialization ? escapeHtml(member.specialization) : '—'}</span></div>
    <div class="detail-field"><label>Qualifications</label><span>${escapeHtml(member.qualifications || '—')}</span></div>
    <div class="detail-field"><label>License Number</label><span>${escapeHtml(member.licenseNumber || '—')}</span></div>
    <div class="detail-field"><label>Branch IDs</label><span>${(member.branchIds || []).join(', ') || '—'}</span></div>
  </div>
  <div class="detail-edit-actions">
    <button class="detail-cancel-btn" data-back-to-staff="1">Back to staff list</button>
  </div>`;
}

window.deleteMember = function(id) {
  fetch('/api/staff/' + id + '/delete', { method: 'POST', headers: headers(), body: '{}' }).then(r => r.json()).then(d => { if (d.ok) refresh(); else alert(d.error); });
};
window.editMember = function(id) {
  var member = (snapshot.members || []).find(function(m) { return m.id === id; });
  if (!member) return;
  var form = document.querySelector('#member-form');
  var nameEl = form.querySelector('[name="displayName"]');
  if (nameEl) nameEl.value = member.displayName || '';
  var phoneEl = form.querySelector('[name="phone"]');
  if (phoneEl) phoneEl.value = member.phone || '';
  var roleEl = form.querySelector('[name="role"]');
  if (roleEl) roleEl.value = member.role || '';
  var specEl = form.querySelector('[name="specialization"]');
  if (specEl && member.specialization) specEl.value = member.specialization;
  form.dataset.editId = member.id;
  var btn = form.querySelector('#staff-submit-btn');
  if (btn) btn.textContent = 'Update Staff';
  form.querySelector('#staff-pw-hint').textContent = 'Fill to change password, leave blank to keep current';
  document.querySelector('#staff-reset-pw').style.display = '';
  document.querySelector('#staff-reset-pw').dataset.resetId = member.id;
  form.scrollIntoView({ behavior: 'smooth' });
};

// Reset password handler
document.querySelector('#staff-reset-pw')?.addEventListener('click', async function() {
  var id = this.dataset.resetId;
  if (!id || !confirm('Reset password for this staff? A new temporary password will be set.')) return;
  var pw = prompt('Enter new temporary password (min 8 chars):', 'temp1234');
  if (!pw || pw.length < 8) { alert('Password must be at least 8 characters'); return; }
  await fetch('/api/staff/' + id + '/update', { method: 'POST', headers: headers(), body: JSON.stringify({ password: pw }) });
  alert('Password reset successfully');
  document.querySelector('#member-form').reset();
  document.querySelector('#staff-submit-btn').textContent = 'Create Staff';
  document.querySelector('#staff-reset-pw').style.display = 'none';
  document.querySelector('#staff-pw-hint').textContent = 'Leave blank to send invite email instead';
  delete document.querySelector('#member-form').dataset.editId;
});

/* ── Detail click handlers ── */
document.addEventListener('click', async (e) => {
  const runImport = e.target.closest('#run-patient-import');
  if (runImport) {
    const result = document.querySelector('#patient-import-result');
    const mapping = {};
    document.querySelectorAll('[data-import-field]').forEach((select) => {
      if (select.value) mapping[select.dataset.importField] = select.value;
    });
    if (!mapping.firstName || !mapping.phone) {
      result.textContent = 'Map First Name and Phone before importing.';
      return;
    }
    const branchId = document.querySelector('#patient-import-branch')?.value;
    if (!branchId) {
      result.textContent = 'Select a Target branch before importing.';
      return;
    }
    runImport.disabled = true;
    result.textContent = 'Importing patients...';
    try {
      const payload = { tenantId, format: 'excel', rows: patientImportRows, mapping, branchId };
      const response = await fetch('/api/patients/bulk-import', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Import failed');
      result.textContent = `Imported ${body.summary.imported}/${body.summary.total}. Failed/skipped ${body.summary.failed}.`;
      if (body.errors?.length) {
        document.querySelector('#patient-import-preview').innerHTML += `<div class="import-errors"><h4>Rows needing cleanup</h4>${body.errors.slice(0, 20).map((err) => `<p>Row ${err.row}: ${err.error}${err.details ? ' — ' + escapeHtml(err.details) : ''}</p>`).join('')}</div>`;
      }
      await refresh();
    } catch (error) {
      result.textContent = error.message || 'Import failed';
    } finally {
      runImport.disabled = false;
    }
    return;
  }

  /* ── Branch click-to-edit ── */
  const branchCard = e.target.closest('[data-branch-id]');
  if (branchCard && !e.target.closest('[data-save-branch]') && !e.target.closest('[data-cancel-branch]') && !e.target.closest('[data-delete-branch]')) {
    const branch = (snapshot.branches || []).find((b) => b.id === branchCard.dataset.branchId);
    if (!branch) return;
    const prev = branchCard.innerHTML;
    branchCard.dataset.prevHtml = prev;
    branchCard.innerHTML = `<div class="edit-inline">
      <input name="name" value="${escapeHtml(branch.name)}" placeholder="Branch name" class="edit-input[name="unitPrice"] />
      <input name="address" value="${escapeHtml(branch.address || '')}" placeholder="Address" class="edit-input[name="unitPrice"] />
      <div class="edit-actions">
        <button data-save-branch="${branch.id}" class="save-btn">Save</button>
        <button data-cancel-branch="${branch.id}" class="cancel-btn">Cancel</button>
        <button data-delete-branch="${branch.id}" class="delete-btn">Delete</button>
      </div>
    </div>`;
    return;
  }

  const saveBranch = e.target.closest('[data-save-branch]');
  if (saveBranch) {
    const card = saveBranch.closest('[data-branch-id]');
    const inputs = card.querySelectorAll('.edit-inline input');
    const data = {};
    inputs.forEach((input) => { if (input.name) data[input.name] = input.value; });
    await fetch(`/api/branches/${saveBranch.dataset.saveBranch}`, { method: 'PATCH', headers: headers(), body: JSON.stringify(data) });
    await refresh();
    showSuccessToast('Branch updated.');
    return;
  }

  const cancelBranch = e.target.closest('[data-cancel-branch]');
  if (cancelBranch) {
    const card = cancelBranch.closest('[data-branch-id]');
    card.innerHTML = card.dataset.prevHtml || '';
    delete card.dataset.prevHtml;
    return;
  }

  const deleteBranch = e.target.closest('[data-delete-branch]');
  if (deleteBranch) {
    if (!confirm('Delete this branch? This cannot be undone.')) return;
    await fetch(`/api/branches/${deleteBranch.dataset.deleteBranch}`, { method: 'DELETE', headers: headers() });
    await refresh();
    showSuccessToast('Branch deleted.');
    return;
  }

  /* ── Schedule click-to-edit ── */
  const scheduleCard = e.target.closest('[data-schedule-id]');
  if (scheduleCard && !e.target.closest('[data-save-schedule]') && !e.target.closest('[data-cancel-schedule]') && !e.target.closest('[data-delete-schedule]')) {
    const schedule = (snapshot.doctorSchedules || []).find((s) => s.id === scheduleCard.dataset.scheduleId);
    if (!schedule) return;
    const prev = scheduleCard.innerHTML;
    scheduleCard.dataset.prevHtml = prev;
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const weekdayOpts = days.map((d, i) => `<option value="${i}" ${schedule.weekday === i ? 'selected' : ''}>${d}</option>`).join('');
    scheduleCard.innerHTML = `<div class="edit-inline edit-grid">
      <select name="weekday" class="edit-input">${weekdayOpts}</select>
      <input name="startsAt" type="time" value="${schedule.startsAt}" class="edit-input[name="unitPrice"] />
      <input name="endsAt" type="time" value="${schedule.endsAt}" class="edit-input[name="unitPrice"] />
      <input name="slotMinutes" type="number" value="${schedule.slotMinutes}" min="5" class="edit-input[name="unitPrice"] />
      <div class="edit-actions">
        <button data-save-schedule="${schedule.id}" class="save-btn">Save</button>
        <button data-cancel-schedule="${schedule.id}" class="cancel-btn">Cancel</button>
        <button data-delete-schedule="${schedule.id}" class="delete-btn">Delete</button>
      </div>
    </div>`;
    return;
  }

  const saveSchedule = e.target.closest('[data-save-schedule]');
  if (saveSchedule) {
    const card = saveSchedule.closest('[data-schedule-id]');
    const inputs = card.querySelectorAll('.edit-inline input, .edit-inline select');
    const data = {};
    inputs.forEach((input) => { if (input.name) data[input.name] = input.value; });
    if (data.weekday) data.weekday = Number(data.weekday);
    if (data.slotMinutes) data.slotMinutes = Number(data.slotMinutes);
    await fetch(`/api/doctor-schedules/${saveSchedule.dataset.saveSchedule}`, { method: 'PATCH', headers: headers(), body: JSON.stringify(data) });
    await refresh();
    showSuccessToast('Schedule updated.');
    return;
  }

  const cancelSchedule = e.target.closest('[data-cancel-schedule]');
  if (cancelSchedule) {
    const card = cancelSchedule.closest('[data-schedule-id]');
    card.innerHTML = card.dataset.prevHtml || '';
    delete card.dataset.prevHtml;
    return;
  }

  const deleteSchedule = e.target.closest('[data-delete-schedule]');
  if (deleteSchedule) {
    if (!confirm('Delete this schedule slot?')) return;
    await fetch(`/api/doctor-schedules/${deleteSchedule.dataset.deleteSchedule}`, { method: 'DELETE', headers: headers() });
    await refresh();
    showSuccessToast('Schedule deleted.');
    return;
  }

  /* ── Encounter click-to-edit CRUD ── */
  const encounterCard = e.target.closest('[data-encounter-id]');
  if (encounterCard && !e.target.closest('[data-save-encounter]') && !e.target.closest('[data-cancel-encounter]') && !e.target.closest('[data-delete-encounter]') && !e.target.closest('[data-sign]')) {
    const enc = (snapshot.encounters || []).find((s) => s.id === encounterCard.dataset.encounterId);
    if (!enc) return;
    const prev = encounterCard.innerHTML;
    encounterCard.dataset.prevHtml = prev;
    encounterCard.innerHTML = `<div class="edit-inline edit-grid">
      <input name="reason" value="${escapeHtml(enc.reason || '')}" placeholder="Reason" class="edit-input[name="unitPrice"] />
      <input name="diagnosis" value="${escapeHtml(enc.diagnosis || '')}" placeholder="Diagnosis" class="edit-input[name="unitPrice"] />
      <input name="clinicalNotes" value="${escapeHtml(enc.clinicalNotes || '')}" placeholder="Clinical notes" class="edit-input[name="unitPrice"] />
      <input name="bloodPressure" value="${escapeHtml(enc.bloodPressure || '')}" placeholder="BP" class="edit-input[name="unitPrice"] />
      <input name="temperatureC" type="number" step="0.1" value="${enc.temperatureC || ''}" placeholder="Temp C" class="edit-input[name="unitPrice"] />
      <div class="edit-actions">
        <button data-save-encounter="${enc.id}" class="save-btn">Save</button>
        <button data-cancel-encounter="${enc.id}" class="cancel-btn">Cancel</button>
        <button data-delete-encounter="${enc.id}" class="delete-btn">Delete</button>
      </div>
    </div>`;
    return;
  }

  const saveEncounter = e.target.closest('[data-save-encounter]');
  if (saveEncounter) {
    const card = saveEncounter.closest('[data-encounter-id]');
    const inputs = card.querySelectorAll('.edit-inline input');
    const data = {};
    inputs.forEach((input) => { if (input.name) data[input.name] = input.value; });
    if (data.temperatureC) data.temperatureC = Number(data.temperatureC);
    await fetch(`/api/encounters/${saveEncounter.dataset.saveEncounter}`, { method: 'PATCH', headers: headers(), body: JSON.stringify(data) });
    await refresh();
    showSuccessToast('Encounter updated.');
    return;
  }

  const cancelEncounter = e.target.closest('[data-cancel-encounter]');
  if (cancelEncounter) {
    const card = cancelEncounter.closest('[data-encounter-id]');
    card.innerHTML = card.dataset.prevHtml || '';
    delete card.dataset.prevHtml;
    return;
  }

  const deleteEncounter = e.target.closest('[data-delete-encounter]');
  if (deleteEncounter) {
    if (!confirm('Delete this encounter?')) return;
    await fetch(`/api/encounters/${deleteEncounter.dataset.deleteEncounter}`, { method: 'DELETE', headers: headers() });
    await refresh();
    showSuccessToast('Encounter deleted.');
    return;
  }

  const patientCard = e.target.closest('[data-patient-id]');
  if (patientCard) {
    renderPatientDetail(patientCard.dataset.patientId);
    return;
  }

  // Member edit
  const editMember = e.target.closest('[data-edit-member]');
  if (editMember) {
    const member = (snapshot.members || []).find(m => m.id === editMember.dataset.editMember);
    if (!member) return;
    const form = document.querySelector('#member-form');
    form.querySelector('[name="displayName"]').value = member.displayName || '';
    form.querySelector('[name="phone"]').value = member.phone || '';
    form.querySelector('[name="role"]').value = member.role || '';
    const spec = form.querySelector('[name="specialization"]');
    if (spec && member.specialization) spec.value = member.specialization;
    form.dataset.editId = member.id;
    form.querySelector('button').textContent = 'Update staff';
    form.scrollIntoView({ behavior: 'smooth' });
    return;
  }

  // Member delete
  const deleteMember = e.target.closest('[data-delete-member]');
  if (deleteMember) {
    const id = deleteMember.dataset.deleteMember;
    fetch(`/api/staff/${id}/delete`, { method: 'POST', headers: headers(), body: '{}' }).then(r => r.json()).then(d => { if (d.ok) refresh(); else alert(d.error); });
    return;
  }

  const memberCard = e.target.closest('[data-member-id]');
  if (memberCard) {
    renderStaffDetail(memberCard.dataset.memberId);
    return;
  }

  if (e.target.closest('#patient-detail-back') || e.target.dataset.backToPatients) {
    const pt = document.querySelector('#patients');
    pt.querySelector('.patient-search').hidden = false;
    pt.querySelector('#patient-list').hidden = false;
    pt.querySelector('#patient-detail').hidden = true;
    return;
  }

  if (e.target.closest('#staff-detail-back') || e.target.dataset.backToStaff) {
    const st = document.querySelector('#staff');
    st.querySelector('#member-form').hidden = false;
    st.querySelector('#member-list').hidden = false;
    st.querySelector('#staff-detail').hidden = true;
    return;
  }

  const saveBtn = e.target.closest('[data-save-patient]');
  if (saveBtn) {
    const patientId = saveBtn.dataset.savePatient;
    const body = document.querySelector('#patient-detail-body');
    const inputs = body.querySelectorAll('input, select, textarea');
    const data = {};
    inputs.forEach(i => { if (i.name && i.value.trim()) data[i.name] = i.value.trim(); });
    await fetch(`/api/patients/${patientId}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify(data),
    });
    showSuccessToast('Patient saved successfully ✅');
    alert('✅ Patient saved successfully');
    await refresh();
    renderPatientDetail(patientId);
    return;
  }

  const subTab = e.target.closest('.detail-tab');
  if (subTab) {
    const patient = (snapshot.patients || []).find(p => p.id === currentPatientId);
    if (patient) renderPatientSubTab(subTab.dataset.subtab, patient);
  }

  // Service edit
  const editService = e.target.closest('[data-edit-service]');
  if (editService) {
    const service = (snapshot.services || []).find(s => s.id === editService.dataset.editService);
    if (!service) return;
    const form = document.querySelector('#service-form');
    form.querySelector('[name="name"]').value = service.name;
    form.querySelector('[name="durationMinutes"]').value = service.durationMinutes;
    form.querySelector('[name="price"]').value = service.priceKobo;
    form.dataset.editId = service.id;
    form.querySelector('button').textContent = 'Update service';
    form.scrollIntoView({ behavior: 'smooth' });
    return;
  }

  // Service delete
  const deleteService = e.target.closest('[data-delete-service]');
  if (deleteService) {
    if (!confirm('Delete this service?')) return;
    await fetch(`/api/services/${deleteService.dataset.deleteService}`, { method: 'DELETE', headers: headers() });
    await refresh();
    return;
  }

  // Print invoice
  const printBtn = e.target.closest('[data-print-invoice]');
  if (printBtn) {
    const invoice = (snapshot.invoices || []).find(i => i.id === printBtn.dataset.printInvoice);
    const patient = invoice ? (snapshot.patients || []).find(p => p.id === invoice.patientId) : null;
    if (!invoice) return;
    const settings = await fetch('/api/settings', { headers: headers() }).then(r => r.json()).catch(() => ({}));
    let hmoName = '';
    if (invoice.hmoInsuranceId) {
      const hmoResp = await fetch('/api/hmo?patientId=' + invoice.patientId, { headers: headers() }).then(r => r.json()).catch(() => ({}));
      const hmo = (hmoResp.insurances || []).find(h => h.id === invoice.hmoInsuranceId);
      if (hmo) hmoName = hmo.hmoName;
    }
    const printWindow = window.open('', '_blank', 'width=800,height=600');
    printWindow.document.write(`<!DOCTYPE html><html><head><title>Invoice ${invoice.invoiceNumber}</title>
<style>
  @page { margin: 20mm; }
  body { font-family: 'Inter', Arial, sans-serif; color: #1a1a2e; margin: 0; padding: 40px; }
  .header { display: flex; align-items: center; gap: 16px; margin-bottom: 32px; padding-bottom: 16px; border-bottom: 2px solid #6c5ce7; }
  .header img { max-height: 50px; }
  .header h1 { margin: 0; font-size: 1.4rem; color: #1a1a2e; }
  .header small { color: #666; }
  .meta { display: flex; justify-content: space-between; margin-bottom: 24px; }
  .meta div { font-size: .85rem; color: #555; }
  .meta strong { color: #1a1a2e; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  th { background: #f5f3ff; color: #4c1d95; text-align: left; padding: 10px 12px; font-size: .8rem; text-transform: uppercase; }
  td { padding: 10px 12px; border-bottom: 1px solid #eee; font-size: .9rem; }
  .totals { text-align: right; margin-top: 16px; }
  .totals div { margin: 4px 0; font-size: .9rem; }
  .totals .grand { font-size: 1.2rem; font-weight: 900; color: #1a1a2e; margin-top: 8px; padding-top: 8px; border-top: 2px solid #6c5ce7; }
  .footer { margin-top: 40px; text-align: center; font-size: .78rem; color: #999; border-top: 1px solid #eee; padding-top: 16px; }
  @media print { body { padding: 0; } }
</style></head><body>
  <div class="header">
    ${settings.clinicLogoUrl ? `<img src="${settings.clinicLogoUrl}" alt="Logo" />` : `<div style="width:50px;height:50px;background:linear-gradient(135deg,#7c5cfc,#5b3ae8);border-radius:12px"></div>`}
    <div>
      <h1>${settings.clinicName || 'Clinic'}</h1>
      <small>${settings.clinicAddress || ''}</small>
    </div>
  </div>
  <div class="meta">
    <div><strong>Invoice:</strong> ${invoice.invoiceNumber}<br><strong>Date:</strong> ${new Date(invoice.createdAt).toLocaleDateString()}<br><strong>Status:</strong> ${invoice.status}</div>
    <div><strong>Patient:</strong> ${patient ? patient.firstName + ' ' + (patient.lastName || '') : 'N/A'}<br><strong>Phone:</strong> ${patient?.phone || ''}<br>${patient?.email ? '<strong>Email:</strong> ' + patient.email : ''}</div>
  </div>
  <table><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead><tbody>
    ${(invoice.lines || []).map(l => `<tr><td>${l.description}</td><td>${l.quantity}</td><td>₦${l.unitPriceKobo.toLocaleString()}</td><td>₦${((l.quantity || 1) * l.unitPriceKobo).toLocaleString()}</td></tr>`).join('')}
  </tbody></table>
  <div class="totals">
    <div>Subtotal: ₦${invoice.subtotalKobo.toLocaleString()}</div>
    ${invoice.discountKobo ? `<div>Discount: -₦${invoice.discountKobo.toLocaleString()}</div>` : ''}
    ${invoice.taxKobo ? `<div>Tax: ₦${invoice.taxKobo.toLocaleString()}</div>` : ''}
    ${invoice.hmoCoverageKobo ? `<div>${hmoName || 'HMO'} covers: -₦${Math.round(invoice.hmoCoverageKobo).toLocaleString()}</div>` : ''}
    <div class="grand">Total: ₦${invoice.totalKobo.toLocaleString()}</div>
    <div style="color:#666">Paid: ₦${invoice.amountPaidKobo.toLocaleString()} · Balance: ₦${Math.max((invoice.totalKobo - (invoice.hmoCoverageKobo || 0) - invoice.amountPaidKobo), 0).toLocaleString()}${(invoice.totalKobo - (invoice.hmoCoverageKobo || 0) - invoice.amountPaidKobo) < 0 ? ' (₦' + Math.abs((invoice.totalKobo - (invoice.hmoCoverageKobo || 0) - invoice.amountPaidKobo)).toLocaleString() + ' overpaid)' : ''}</div>
  </div>
  <div class="footer">Generated by Fidean Clinic OS · ${new Date().toLocaleString()}</div>
</body></html>`);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => printWindow.print(), 500);
    return;
  }
});

/* ── Referral type toggle ── */
document.addEventListener('change', (e) => {
  const typeEl = e.target.closest('[name="referralType"]');
  if (!typeEl) return;
  const doctorField = document.querySelector('#referral-doctor-field');
  const clinicField = document.querySelector('#referral-clinic-field');
  if (doctorField && clinicField) {
    doctorField.hidden = typeEl.value !== 'inhouse_specialist';
    clinicField.hidden = typeEl.value !== 'external_clinic';
  }
});
/* ── Logo upload with crop/resize ── */
document.querySelector('#logo-file-input')?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      // Crop center square, resize to 512x512
      const size = Math.min(img.width, img.height);
      const offsetX = (img.width - size) / 2;
      const offsetY = (img.height - size) / 2;
      const canvas = document.createElement('canvas');
      canvas.width = 512; canvas.height = 512;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, offsetX, offsetY, size, size, 0, 0, 512, 512);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
      document.querySelector('#logo-data-url-input').value = dataUrl;
      document.querySelector('#logo-preview-img').src = dataUrl;
      document.querySelector('#logo-preview-wrap').hidden = false;
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
});
/* ── Staff messaging ── */
document.querySelector('#staff-message-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const data = Object.fromEntries(fd.entries());
  await fetch('/api/staff-messages', { method: 'POST', headers: headers(), body: JSON.stringify(data) });
  e.target.reset();
  await refresh();
});

/* ── Broadcast (WhatsApp / SMS) ── */
function broadcastCostPerMsg(channel) {
    return channel === 'whatsapp'
    ? (currentSettings?.whatsappCostPerMsg ?? 80)
    : (currentSettings?.smsCostPerMsg ?? 6);
}

function broadcastRecipients() {
  if (!snapshot || !Array.isArray(snapshot.patients)) return [];
  const patients = snapshot.patients.filter((p) => p && p.phone && String(p.phone).trim().length >= 5);
  const filter = document.querySelector('#broadcast-filter')?.value || 'all';

  if (filter === 'department') {
    const dept = (document.querySelector('#broadcast-department')?.value || '').trim().toLowerCase();
    if (!dept) return [];
    const apptPatients = new Set((snapshot.appointments || [])
      .filter((a) => a && a.serviceName && a.serviceName.toLowerCase().includes(dept))
      .map((a) => a.patientId));
    return patients.filter((p) => apptPatients.has(p.id));
  }

  if (filter === 'recent') {
    const days = Math.max(1, Number(document.querySelector('#broadcast-recent-days')?.value) || 30);
    const cutoff = Date.now() - days * 86400 * 1000;
    const recentPatients = new Set((snapshot.encounters || [])
      .filter((enc) => enc && enc.createdAt && new Date(enc.createdAt).getTime() >= cutoff)
      .map((enc) => enc.patientId));
    return patients.filter((p) => recentPatients.has(p.id));
  }

  if (filter === 'specific') {
    const selected = window._specificPatients || {};
    const ids = Object.keys(selected);
    if (ids.length === 0) return [];
    return patients.filter((p) => selected[p.id]);
  }

  return patients; // all
}

function updateBroadcastPreview() {
  const channel = document.querySelector('#broadcast-channel')?.value || 'whatsapp';
  const recipients = broadcastRecipients();
  const costPerMsg = broadcastCostPerMsg(channel);
  const totalCost = recipients.length * costPerMsg;
  document.querySelector('#broadcast-preview').innerHTML =
    `<strong>${recipients.length}</strong> recipient${recipients.length === 1 ? '' : 's'} · Cost: <strong>₦${totalCost.toLocaleString()}</strong> <span style="color:var(--text-tertiary)">(${recipients.length} × ₦${costPerMsg})</span>`;

  const balance = currentSettings?.walletBalance ?? 0;
  const warning = document.querySelector('#broadcast-balance-warning');
  const enabled = !!currentSettings?.messagingEnabled;
  if (!enabled) {
    warning.style.display = 'block';
    warning.textContent = '⚠️ Messaging is disabled. Enable it in Settings → Messaging & Wallet.';
  } else if (balance < totalCost && recipients.length > 0) {
    warning.style.display = 'block';
    warning.textContent = `⚠️ Wallet balance (₦${balance.toLocaleString()}) is less than the estimated cost (₦${totalCost.toLocaleString()}). Top up in Settings → Messaging & Wallet.`;
  } else {
    warning.style.display = 'none';
  }
}

/* ── Specific patients: searchable checkbox picker ── */
window._specificPatients = {};

function buildPatientCheckboxList(query) {
  const container = document.querySelector('#broadcast-patient-checkbox-list');
  if (!container) return;
  const q = (query || '').trim().toLowerCase();
  const allPatients = (snapshot?.patients || []).filter((p) => p && p.phone && String(p.phone).trim().length >= 5);
  const filtered = q
    ? allPatients.filter((p) => (p.firstName + ' ' + (p.lastName || '') + ' ' + (p.phone || '')).toLowerCase().includes(q))
    : allPatients;
  const maxShow = q ? filtered.length : Math.min(filtered.length, 20);
  container.innerHTML = filtered.slice(0, maxShow).map((p) => {
    const name = escapeHtml(p.firstName + ' ' + (p.lastName || ''));
    const phone = escapeHtml(String(p.phone));
    const checked = window._specificPatients[p.id] ? 'checked' : '';
    return `<label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:.85rem">
      <input type="checkbox" data-patient-id="${p.id}" ${checked} />
      <span>${name} <span style="color:var(--text-tertiary);font-size:.78rem">${phone}</span></span>
    </label>`;
  }).join('');
  if (filtered.length === 0) {
    container.innerHTML = '<p style="padding:12px;text-align:center;color:var(--text-tertiary);font-size:.85rem">No patients match.</p>';
  } else if (!q && filtered.length > 20) {
    container.innerHTML += `<p style="padding:6px 8px;text-align:center;color:var(--text-tertiary);font-size:.78rem">Showing 20 of ${filtered.length} — type to narrow</p>`;
  }
  // Wire checkbox changes to selection state
  container.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', function() {
      if (this.checked) window._specificPatients[this.dataset.patientId] = true;
      else delete window._specificPatients[this.dataset.patientId];
      updateBroadcastPreview();
    });
  });
}

document.querySelector('#broadcast-patient-search')?.addEventListener('input', function() {
  buildPatientCheckboxList(this.value);
});

/* ── Template-specific input fields ── */
function renderTemplateFields() {
  const wrap = document.querySelector('#broadcast-template-fields');
  if (!wrap) return;
  const template = document.querySelector('#broadcast-template')?.value || 'clinic_announcement_msg';
  const channel = document.querySelector('#broadcast-channel')?.value;
  if (channel !== 'whatsapp') { wrap.innerHTML = ''; return; }
  const fieldHtml = {
    clinic_announcement_msg: '',
    clinic_appointment_reminder: `<label>Appointment time
        <input id="template-field-appointment" type="text" placeholder="e.g. 10:00 AM" />
        <small style="color:var(--text-tertiary)">Template: "Your appointment at [Clinic] is tomorrow at {{time}}."</small>
      </label>`,
    clinic_payment_receipt_msg: `<label>Amount (₦)
        <input id="template-field-amount" type="number" min="0" placeholder="e.g. 15000" />
      </label>
      <label>Receipt number
        <input id="template-field-receipt" type="text" placeholder="e.g. INV-2026-001" />
        <small style="color:var(--text-tertiary)">Template: "Thank you for your payment of ₦{{amount}} to [Clinic]. Your receipt number is {{receipt}}."</small>
      </label>`,
    clinic_health_tip_msg: `<label>Health tip
        <input id="template-field-tip" type="text" placeholder="e.g. Drink water regularly" />
        <small style="color:var(--text-tertiary)">Template: "Health tip from [Clinic]: {{tip}}..."</small>
      </label>`,
  }[template] || '';
  wrap.innerHTML = fieldHtml;
  updateTemplatePreview();
}

function buildTemplateParams(patient) {
  const template = document.querySelector('#broadcast-template')?.value || 'clinic_announcement_msg';
  const clinicName = currentSettings?.clinicName || (snapshot?.tenant?.name || 'Fidean Clinic');
  switch (template) {
    case 'clinic_appointment_reminder':
      return [clinicName, document.querySelector('#template-field-appointment')?.value || 'your scheduled time'];
    case 'clinic_payment_receipt_msg':
      return [String(document.querySelector('#template-field-amount')?.value || '0'),
              clinicName,
              document.querySelector('#template-field-receipt')?.value || 'INV-0000'];
    case 'clinic_health_tip_msg':
      return [clinicName, document.querySelector('#template-field-tip')?.value || ''];
    case 'clinic_announcement_msg':
    default:
      return [clinicName, (document.querySelector('#broadcast-body')?.value || '').trim()];
  }
}
function getTemplatePreviewHtml(template, body, clinicName) {
  const name = clinicName || 'Clinic';
  switch (template) {
    case 'clinic_appointment_reminder':
      return `<strong style="color:#374151">📅 Appointment Reminder</strong><br><span style="color:#6b7280">Your appointment at ${escapeHtml(name)} is tomorrow at <strong>{{time}}</strong>.</span><br><span style="color:#6b7280">Reply R to reschedule or C to confirm.</span><br><hr style="margin:6px 0;border:none;border-top:1px dashed #d1d5db"><span style="color:#374151">${escapeHtml(body)}</span>`;
    case 'clinic_payment_receipt_msg':
      return `<strong style="color:#374151">💳 Payment Receipt</strong><br><span style="color:#6b7280">Thank you for your payment of NGN<strong>{{amount}}</strong> to ${escapeHtml(name)}. Your receipt number is <strong>{{receipt}}</strong>.</span><br><span style="color:#6b7280">This confirms your payment has been received.</span><br><hr style="margin:6px 0;border:none;border-top:1px dashed #d1d5db"><span style="color:#374151">${escapeHtml(body)}</span>`;
    case 'clinic_health_tip_msg':
      return `<strong style="color:#374151">🩺 Health Tip</strong><br><span style="color:#6b7280">Health tip from ${escapeHtml(name)}: <strong>{{tip}}</strong></span><br><span style="color:#6b7280">For more health tips and to book an appointment, visit our website.</span><br><hr style="margin:6px 0;border:none;border-top:1px dashed #d1d5db"><span style="color:#374151">${escapeHtml(body)}</span>`;
    case 'clinic_announcement_msg':
    default:
      return `<strong style="color:#374151">📢 Announcement from ${escapeHtml(name)}</strong><br><span style="color:#6b7280">Hello, this is an update from ${escapeHtml(name)}. <strong>{{message}}</strong></span><br><span style="color:#6b7280">For more information, please visit our website or contact us.</span><br><hr style="margin:6px 0;border:none;border-top:1px dashed #d1d5db"><span style="color:#374151">${escapeHtml(body)}</span>`;
  }
}

function updateTemplatePreview() {
  const channel = document.querySelector('#broadcast-channel')?.value;
  const wrap = document.querySelector('#broadcast-template-wrap');
  if (channel !== 'whatsapp') { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  const template = document.querySelector('#broadcast-template')?.value || 'clinic_announcement_msg';
  const body = (document.querySelector('#broadcast-body')?.value || '').trim();
  const clinicName = currentSettings?.clinicName || (snapshot?.tenant?.name || '');
  const preview = document.querySelector('#broadcast-template-preview');
  if (!body) {
    preview.innerHTML = '<span style="color:var(--text-tertiary)">Type a message to see how it wraps in the template.</span>';
    return;
  }
  preview.innerHTML = getTemplatePreviewHtml(template, body, clinicName);
}

/* Wire channel change to template show/hide */
document.querySelector('#broadcast-channel')?.addEventListener('change', function() {
  updateTemplatePreview();
  updateBroadcastPreview();
});

/* Wire template selector + body to preview update */
document.querySelector('#broadcast-template')?.addEventListener('change', () => {
  renderTemplateFields();
  updateTemplatePreview();
});
document.querySelector('#broadcast-body')?.addEventListener('input', updateTemplatePreview);

/* Modify updateBroadcastPreview to also update template preview */
const _origUpdateBroadcastPreview = updateBroadcastPreview;
updateBroadcastPreview = function() {
  updateTemplatePreview();
  _origUpdateBroadcastPreview();
};

document.querySelector('#broadcast-filter')?.addEventListener('change', () => {
  const filter = document.querySelector('#broadcast-filter')?.value;
  document.querySelector('#broadcast-department-wrap').style.display = filter === 'department' ? 'block' : 'none';
  document.querySelector('#broadcast-recent-wrap').style.display = filter === 'recent' ? 'block' : 'none';
  document.querySelector('#broadcast-specific-wrap').style.display = filter === 'specific' ? 'block' : 'none';
  updateBroadcastPreview();
});
['#broadcast-channel', '#broadcast-department', '#broadcast-recent-days', '#broadcast-body'].forEach((sel) => {
  document.querySelector(sel)?.addEventListener('input', updateBroadcastPreview);
  document.querySelector(sel)?.addEventListener('change', updateBroadcastPreview);
});

document.querySelector('#broadcast-send-btn')?.addEventListener('click', async () => {
  const channel = document.querySelector('#broadcast-channel')?.value || 'whatsapp';
  const body = (document.querySelector('#broadcast-body')?.value || '').trim();
  const patients = broadcastRecipients();
  const resultBox = document.querySelector('#broadcast-result');

  if (!body) { showError('Enter a message body first.'); return; }
  if (patients.length === 0) { showError('No recipients match the selected filter.'); return; }
  if (!currentSettings?.messagingEnabled) { showError('Messaging is disabled. Enable it in Settings → Messaging & Wallet.'); return; }
  const totalCost = patients.length * broadcastCostPerMsg(channel);
  if ((currentSettings?.walletBalance ?? 0) < totalCost) {
    showError(`Insufficient wallet balance. Need ₦${totalCost.toLocaleString()}, have ₦${(currentSettings?.walletBalance ?? 0).toLocaleString()}.`);
    return;
  }
  if (!confirm(`Send ${channel === 'whatsapp' ? 'WhatsApp' : 'SMS'} to ${patients.length} patient(s)?\nEstimated cost: ₦${totalCost.toLocaleString()}`)) return;

  const btn = document.querySelector('#broadcast-send-btn');
  btn.disabled = true;
  btn.textContent = `Sending 0/${patients.length}...`;
  resultBox.innerHTML = '';
  let sent = 0, failed = 0;

  for (let i = 0; i < patients.length; i++) {
    const p = patients[i];
    try {
      const payload = { channel, recipient: String(p.phone).trim(), body };
      if (channel === 'whatsapp') {
        payload.templateName = document.querySelector('#broadcast-template')?.value || 'clinic_announcement_msg';
        // Build per-recipient template params (patient name auto-filled)
        const paramValues = buildTemplateParams(p);
        if (paramValues.some(v => v && String(v).trim())) payload.templateParams = paramValues;
      }
      const resp = await fetch('/api/messages/send', {
        method: 'POST', headers: headers(),
        body: JSON.stringify(payload),
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data && data.ok) {
        sent++;
      } else {
        failed++;
        const err = data && data.error ? data.error : `HTTP ${resp.status}`;
        const item = document.createElement('div');
        item.className = 'card-rich';
        item.style.borderLeft = '3px solid #f87171';
        item.innerHTML = `<p><strong>${escapeHtml(p.firstName + ' ' + (p.lastName || ''))}</strong> <span style="float:right;color:#b91c1c">✗ ${escapeHtml(err)}</span></p><p style="font-size:.78rem;color:var(--text-tertiary)">${escapeHtml(String(p.phone))}</p>`;
        resultBox.appendChild(item);
      }
    } catch (err) {
      failed++;
      const item = document.createElement('div');
      item.className = 'card-rich';
      item.style.borderLeft = '3px solid #f87171';
      item.innerHTML = `<p><strong>${escapeHtml(p.firstName + ' ' + (p.lastName || ''))}</strong> <span style="float:right;color:#b91c1c">✗ ${escapeHtml(String(err && err.message || 'network'))}</span></p>`;
      resultBox.appendChild(item);
    }
    btn.textContent = `Sending ${i + 1}/${patients.length}...`;
  }

  btn.disabled = false;
  btn.textContent = 'Send broadcast';
  const summary = document.createElement('div');
  summary.className = 'card-rich';
  summary.style.borderLeft = `3px solid ${failed ? '#f59e0b' : '#22c55e'}`;
  summary.innerHTML = `<p><strong>Done.</strong> ${sent} sent ✅ ${failed ? '· ' + failed + ' failed ❌' : ''}</p>`;
  resultBox.prepend(summary);
  showSuccessToast(`Broadcast complete: ${sent} sent, ${failed} failed`);
  await refresh();
});

/* refresh broadcast preview whenever data loads */
function refreshBroadcastPreview() {
  if (document.querySelector('#broadcast-preview')) {
    updateBroadcastPreview();
    // Rebuild patient checkbox list if specific picker is visible
    if (document.querySelector('#broadcast-specific-wrap')?.style?.display === 'block') {
      buildPatientCheckboxList(document.querySelector('#broadcast-patient-search')?.value || '');
    }
  }
}
/* ── Inventory form ── */
document.querySelector('#inventory-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const data = Object.fromEntries(fd.entries());
  data.currentStock = 0;
  data.reorderLevel = parseInt(data.reorderLevel) || 0;
  data.unitCostKobo = parseInt(data.unitCost) || 0;
  data.sellingPriceKobo = parseInt(data.sellingPrice) || 0;
  data.tenantId = tenantId;
  const response = await fetch('/api/inventory', { method: 'POST', headers: headers(), body: JSON.stringify(data) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    showError(result.error || 'Could not add inventory item.');
    return;
  }
  e.target.reset();
  showSuccessToast('Inventory product added. Use Stock In to receive batches.');
  await refresh();
});

function inventoryFormData(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  ['quantity', 'costPrice'].forEach((key) => { if (data[key] !== undefined && data[key] !== '') data[key] = parseInt(data[key], 10); data.costPriceKobo = data.costPrice; });
  return data;
}

async function postInventoryMovement(data, successPrefix) {
  const itemId = data.itemId;
  delete data.itemId;
  const response = await fetch(`/api/inventory/${itemId}/movement`, { method: 'POST', headers: headers(), body: JSON.stringify(data) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    showError(result.error || 'Could not record inventory movement.');
    return false;
  }
  showSuccessToast(`${successPrefix}. New stock: ${result.item.currentStock}${result.item.unit ? ' ' + result.item.unit : ''}`);
  await refresh();
  return true;
}

document.querySelector('#inventory-stock-in-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = inventoryFormData(e.target);
  data.movementType = 'purchase';
  const ok = await postInventoryMovement(data, 'Stock in recorded');
  if (ok) e.target.reset();
});

document.querySelector('#inventory-stock-out-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = inventoryFormData(e.target);
  const ok = await postInventoryMovement(data, data.movementType === 'usage' ? 'Department usage recorded' : 'Dispense recorded');
  if (ok) e.target.reset();
});

document.querySelector('#inventory-adjust-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = inventoryFormData(e.target);
  data.movementType = 'adjustment';
  const ok = await postInventoryMovement(data, 'Stock adjustment recorded');
  if (ok) e.target.reset();
});

/* ── HMO Modal handlers ── */
document.querySelector('#hmo-modal-select')?.addEventListener('change', () => {
  const sel = document.querySelector('#hmo-modal-select');
  const opt = sel.options[sel.selectedIndex];
  if (opt && opt.value) {
    const val = Number(opt.dataset.value);
    document.querySelector('#hmo-modal-amount').value = opt.dataset.type === 'fixed' ? val : 0;
  }
});
document.querySelector('#hmo-modal-confirm')?.addEventListener('click', async () => {
  const modal = document.querySelector('#hmo-modal');
  const invoiceId = modal.dataset.invoiceId;
  const sel = document.querySelector('#hmo-modal-select');
  const opt = sel.options[sel.selectedIndex];
  const amount = Number(document.querySelector('#hmo-modal-amount').value);
  if (!opt.value || amount <= 0) { alert('Select an HMO and enter amount'); return; }
  await fetch(`/api/invoices/${invoiceId}`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ hmoCoverageKobo: amount, hmoInsuranceId: opt.value }) });
  modal.hidden = true;
  await refresh();
});
/* ── Ledger filter handlers ── */
document.querySelector('#ledger-refresh')?.addEventListener('click', loadLedger);
document.querySelector('#ledger-type-filter')?.addEventListener('change', loadLedger);
document.querySelector('#ledger-date-from')?.addEventListener('change', loadLedger);
document.querySelector('#ledger-date-to')?.addEventListener('change', loadLedger);

document.querySelector('#hmo-modal-cancel')?.addEventListener('click', () => {
  document.querySelector('#hmo-modal').hidden = true;
});

/* ── Payment Modal handlers ── */
document.querySelector('#pay-modal-confirm')?.addEventListener('click', async () => {
  const modal = document.querySelector('#pay-modal');
  const invoiceId = modal.dataset.invoiceId;
  const amount = Number(document.querySelector('#pay-modal-amount').value);
  if (!amount || amount <= 0) { alert('Enter a valid amount'); return; }
  await fetch(`/api/invoices/${invoiceId}/payment`, { method: 'POST', headers: headers(), body: JSON.stringify({ amountKobo: amount }) });
  modal.hidden = true;
  await refresh();
});
document.querySelector('#pay-modal-cancel')?.addEventListener('click', () => {
  document.querySelector('#pay-modal').hidden = true;
});

document.querySelector('#supplier-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target).entries());
  data.tenantId = tenantId;
  const response = await fetch('/api/inventory/suppliers', { method: 'POST', headers: headers(), body: JSON.stringify(data) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    showError(result.error || 'Could not add supplier.');
    return;
  }
  e.target.reset();
  showSuccessToast('Supplier added.');
  await refresh();
});
/* ── Referral form ── */
document.querySelector('#referral-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const data = Object.fromEntries(fd.entries());
  // Get the current encounter being worked on
  const encSel = document.querySelector('#encounter-form [name="appointmentId"]');
  // We need an encounter context - get the most recent open encounter for the current patient
  // For simplicity, attach to the last open encounter
  const openEnc = (snapshot.encounters || []).filter(enc => enc.status === 'open' && enc.patientId === currentEncounterPatientId).pop();
  if (openEnc) data.encounterId = openEnc.id;
  await fetch('/api/referrals', { method: 'POST', headers: headers(), body: JSON.stringify(data) });
  e.target.reset();
  await refresh();
});
/* ── Inventory internal menu ── */
document.querySelector('#inventory-mini-tabs')?.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-inv-panel]');
  if (!tab) return;
  document.querySelectorAll('#inventory-mini-tabs .mini-tab').forEach((item) => item.classList.remove('active'));
  document.querySelectorAll('#inventory .inventory-subpanel').forEach((item) => item.classList.remove('active'));
  tab.classList.add('active');
  document.querySelector(`#${tab.dataset.invPanel}`)?.classList.add('active');
});

/* ── Inventory movement buttons ── */
document.addEventListener('click', async (e) => {
  const receiveId = e.target.closest('[data-inv-receive]')?.dataset?.invReceive;
  const dispenseId = e.target.closest('[data-inv-dispense]')?.dataset?.invDispense;
  const adjustId = e.target.closest('[data-inv-adjust]')?.dataset?.invAdjust;
  const refAcceptId = e.target.closest('[data-ref-accept]')?.dataset?.refAccept;
  const refCancelId = e.target.closest('[data-ref-cancel]')?.dataset?.refCancel;
  if (receiveId || dispenseId || adjustId) {
    const type = receiveId ? 'receive' : dispenseId ? 'dispense' : 'adjust';
    const defaultQty = type === 'adjust' ? '0' : '1';
    const qty = prompt(`Enter quantity for ${type}${type === 'adjust' ? ' (use negative to reduce, positive to increase)' : ''}:`, defaultQty);
    const parsedQty = parseInt(qty || '', 10);
    if (Number.isNaN(parsedQty) || (type !== 'adjust' && parsedQty <= 0) || (type === 'adjust' && parsedQty === 0)) return;
    const id = receiveId || dispenseId || adjustId;
    const response = await fetch(`/api/inventory/${id}/movement`, { method: 'POST', headers: headers(), body: JSON.stringify({ movementType: type, quantity: parsedQty }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      showError(result.error || `Could not ${type} inventory item.`);
      return;
    }
    showSuccessToast(`Inventory ${type} recorded. New stock: ${result.item.currentStock}${result.item.unit ? ' ' + result.item.unit : ''}`);
    await refresh();
  }
  if (refAcceptId) {
    await fetch(`/api/referrals/${refAcceptId}`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ status: 'accepted' }) });
    await refresh();
  }
  if (refCancelId) {
    await fetch(`/api/referrals/${refCancelId}`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ status: 'cancelled' }) });
    await refresh();
  }
});
/* ── Select populator for messaging recipient + referral doctors ── */
async function populateStaffSelects() {
  // Messaging recipient
  const msgSel = document.querySelector('#msg-recipient-select');
  if (msgSel && snapshot) {
    msgSel.innerHTML = '<option value="">Select recipient...</option>' + (snapshot.members || [])
      .filter(m => m.status === 'active')
      .map(m => `<option value="${m.id}">${m.displayName || m.email} (${m.role})</option>`).join('');
  }
  // Referral doctor select
  const refDocSel = document.querySelector('#referral-form [name="toDoctorMemberId"]');
  if (refDocSel && snapshot) {
    refDocSel.innerHTML = '<option value="">Select specialist doctor...</option>' + (snapshot.members || [])
      .filter(m => m.role === 'doctor' && m.status === 'active')
      .map(m => `<option value="${m.id}">${m.displayName || m.email}${m.specialization ? ' (' + m.specialization + ')' : ''}</option>`).join('');
  }
}
// Call from render() after snapshot renders
// Inject call at end of render()
/* ── End new handlers ── */

/* ── Settings ── */
async function saveSettingsForm(formEl, buttonText) {
  const fd = new FormData(formEl);
  const data = Object.fromEntries(fd.entries());
  // Handle checkboxes: if checked, value is "on", convert to boolean
  formEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    data[cb.name] = cb.checked;
  });
  // Merge with existing settings so we don't lose other fields
  const existing = await fetch('/api/settings', { headers: headers() }).then(r => r.json()).catch(() => ({}));
  const merged = { ...existing, ...data };
  await fetch('/api/settings', { method: 'PUT', headers: headers(), body: JSON.stringify(merged) });
  const btn = formEl.querySelector('button');
  const original = btn.textContent;
  btn.textContent = 'Saved ✓';
  setTimeout(() => btn.textContent = original, 2000);
}

['#settings-form', '#paystack-form', '#bank-form', '#smtp-form'].forEach(id => {
  document.querySelector(id)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveSettingsForm(e.target);
  });
});

/* ── Ledger ── */
async function loadLedger() {
  const inv = snapshot.invoices || [];
  const pay = snapshot.paystackTransactions || [];
  const typeFilter = document.querySelector('#ledger-type-filter')?.value || '';
  const fromDate = document.querySelector('#ledger-date-from')?.value;
  const toDate = document.querySelector('#ledger-date-to')?.value;
  const entries = [];
  inv.forEach(i => {
    if (typeFilter === 'payment' || typeFilter === 'expense') return;
    const d = new Date(i.createdAt).toISOString().slice(0,10);
    if (fromDate && d < fromDate) return;
    if (toDate && d > toDate) return;
    entries.push({ date: d, type: 'Invoice', ref: i.invoiceNumber, desc: (i.lines||[]).map(l=>l.description).join(', '), total: i.totalKobo, hmo: i.hmoCoverageKobo || 0, paid: i.amountPaidKobo || 0 });
  });
  (pay || []).forEach(p => {
    if (typeFilter === 'invoice' || typeFilter === 'expense') return;
    const d = new Date(p.createdAt).toISOString().slice(0,10);
    if (fromDate && d < fromDate) return;
    if (toDate && d > toDate) return;
    entries.push({ date: d, type: 'Payment', ref: p.reference || p.id, desc: 'Paystack ' + (p.status || 'txn'), total: 0, hmo: 0, paid: p.amountKobo || 0 });
  });
  // Wallet transactions (expenses)
  const wt = (snapshot.walletTransactions || []).filter(t => t.type === 'debit');
  wt.forEach(t => {
    if (typeFilter === 'invoice' || typeFilter === 'payment') return;
    const d = new Date(t.createdAt).toISOString().slice(0,10);
    if (fromDate && d < fromDate) return;
    if (toDate && d > toDate) return;
    entries.push({ date: d, type: 'Expense', ref: t.reason || 'debit', desc: t.description || '', total: 0, hmo: 0, paid: -t.amount });
  });
  entries.sort((a,b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));
  const totalRevenue = entries.reduce((s,e) => s + e.paid, 0);
  const totalHmo = entries.reduce((s,e) => s + e.hmo, 0);
  const totalInvoiced = entries.reduce((s,e) => s + e.total, 0);
  document.querySelector('#ledger-summary').innerHTML = `
    <article class="stat"><strong>₦${totalInvoiced.toLocaleString()}</strong><span>Invoiced</span></article>
    <article class="stat"><strong>₦${totalHmo.toLocaleString()}</strong><span>HMO covers</span></article>
    <article class="stat"><strong>₦${totalRevenue.toLocaleString()}</strong><span>Collected</span></article>
    <article class="stat"><strong>${entries.length}</strong><span>Entries</span></article>`;
  document.querySelector('#ledger-list').innerHTML = entries.length
    ? entries.map(e => `<article class="card-rich" style="padding:10px 14px"><div style="display:flex;justify-content:space-between;align-items:center"><div><strong style="font-size:13px">${e.ref}</strong><br><span style="font-size:11px;color:var(--text-tertiary)">${e.date} · ${e.type} · ${e.desc}</span></div><div style="text-align:right"><span style="font-size:13px;font-weight:600">₦${e.paid.toLocaleString()}</span>${e.hmo ? `<br><span style="font-size:11px;color:var(--success)">HMO: -₦${e.hmo.toLocaleString()}</span>` : ''}</div></div></article>`).join('')
    : '<p class="hint" style="text-align:center;padding:24px">No ledger entries found.</p>';
}

async function loadSettings() {
  try {
    const resp = await fetch('/api/settings', { headers: headers() });
    const data = await resp.json();
    if (data && Object.keys(data).length > 0) {
      ['settings-form', 'paystack-form', 'bank-form', 'smtp-form'].forEach(formId => {
        const form = document.querySelector(`#${formId}`);
        if (!form) return;
        Object.keys(data).forEach(k => {
          const input = form.querySelector(`[name="${k}"]`);
          if (!input) return;
          if (input.type === 'checkbox') {
            input.checked = !!data[k];
          } else if (data[k] !== undefined && data[k] !== null && data[k] !== '') {
            input.value = data[k];
          }
        });
      });
      // Messaging & Wallet
      const msgEnabled = document.querySelector('#messaging-enabled');
      if (msgEnabled) msgEnabled.checked = !!data.messagingEnabled;
      const senderIdInput = document.querySelector('#sms-sender-id');
      if (senderIdInput) senderIdInput.value = data.smsSenderId || '';
      const balDisp = document.querySelector('#wallet-balance-display');
      if (balDisp) balDisp.textContent = (data.walletBalance ?? 0).toLocaleString();
      currentSettings = data;
    }
  } catch {}
}

/* ── Messaging settings save ── */
document.querySelector('#messaging-enabled')?.addEventListener('change', async (e) => {
  await fetch('/api/settings', {
    method: 'PUT', headers: headers(), body: JSON.stringify({ messagingEnabled: e.target.checked })
  }).then(r => r.json()).then(d => { if (d && d.tenantId) showSuccessToast('Messaging ' + (e.target.checked ? 'enabled' : 'disabled')); }).catch(() => {});
});

/* ── Wallet top-up ── */
document.querySelector('#wallet-topup-btn')?.addEventListener('click', () => {
  const modal = document.querySelector('#wallet-topup-modal');
  if (!modal) return;
  modal.style.cssText = 'position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;background:rgba(0,0,0,0.7)!important;z-index:99999!important;display:flex!important;align-items:center!important;justify-content:center!important';
  modal.querySelector('.modal-card').style.cssText = 'background:#fff!important;border-radius:12px;padding:24px;min-width:340px;max-width:90vw;box-shadow:0 8px 40px rgba(0,0,0,0.2);position:relative;z-index:100000';
  document.querySelector('#wallet-topup-amount').value = 5000;
});

/* ── Wallet transactions link ── */
document.querySelector('#wallet-transactions-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  // Switch to Ledger tab with Expense filter
  document.querySelectorAll('.sidebar-item').forEach(item => item.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(item => item.classList.remove('active'));
  document.querySelector('[data-tab="ledger"]')?.classList.add('active');
  document.querySelector('#ledger')?.classList.add('active');
  document.querySelector('#ledger-type-filter').value = 'expense';
  localStorage.setItem('clinic_active_tab', 'ledger');
  loadLedger();
});

/* ── SMS Sender ID save ── */
document.querySelector('#sms-sender-id')?.addEventListener('change', async (e) => {
  const v = e.target.value.trim();
  await fetch('/api/settings', {
    method: 'PUT', headers: headers(), body: JSON.stringify({ smsSenderId: v || undefined })
  }).then(r => r.json()).then(d => { if (d && d.tenantId) showSuccessToast('Sender ID saved'); }).catch(() => {});
});

/* ── Notification Templates ── */
let currentSettings = {};

document.querySelector('#template-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const key = fd.get('templateKey');
  const body = fd.get('templateBody');
  try {
    const resp = await fetch('/api/settings', { headers: headers() });
    currentSettings = await resp.json();
    currentSettings.notificationTemplates = currentSettings.notificationTemplates || {};
    currentSettings.notificationTemplates[key] = body;
    await fetch('/api/settings', { method: 'PUT', headers: headers(), body: JSON.stringify(currentSettings) });
    renderTemplates();
  } catch {}
});

function renderTemplates() {
  const templates = currentSettings.notificationTemplates || {};
  const container = document.querySelector('#template-preview');
  const keys = Object.keys(templates);
  if (keys.length === 0) {
    container.innerHTML = '<p class="detail-empty">No templates saved yet.</p>';
    return;
  }
  container.innerHTML = keys.map(k =>
    `<div class="card-rich"><small style="color:var(--text-quaternary);text-transform:uppercase;letter-spacing:.05em">${k.replace(/_/g,' ')}</small><p style="font-size:.82rem;color:var(--text-secondary);margin:4px 0 0">${escapeHtml(templates[k]).substring(0, 120)}${templates[k].length > 120 ? '…' : ''}</p></div>`
  ).join('');
}

/* ── Message Log ── */
async function loadMessageLog() {
  try {
    const resp = await fetch('/api/messages', { headers: headers() });
    const msgs = await resp.json();
    const container = document.querySelector('#message-log-list');
    if (!msgs || msgs.length === 0) {
      container.innerHTML = '<p class="detail-empty">No messages sent yet.</p>';
      return;
    }
    container.innerHTML = msgs.map(m =>
      `<div class="card-rich"><h4 style="margin:0 0 2px;font-size:.85rem;">${escapeHtml(m.subject || m.channel)}</h4><p style="margin:0;font-size:.78rem;color:var(--text-tertiary)">${m.channel} → ${escapeHtml(m.recipient)} · ${m.status}${m.sentAt ? ' · ' + new Date(m.sentAt).toLocaleString() : ''}</p></div>`
    ).join('');
  } catch {}
}

/* ── Reports ── */
document.querySelector('#report-filter')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  await loadReport();
});

document.querySelector('#export-csv')?.addEventListener('click', async () => {
  const from = document.querySelector('#report-filter [name="from"]').value;
  const to = document.querySelector('#report-filter [name="to"]').value;
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const resp = await fetch(`/api/reports/revenue?${qs}`, { headers: headers() });
  const report = await resp.json();
  if (!report.daily || report.daily.length === 0) return;
  let csv = 'Date,Revenue (NGN),Transactions\n';
  csv += report.daily.map(d => `${d.date},${(d.totalKobo).toFixed(2)},${d.count}`).join('\n');
  csv += `\n\nTotal,${(report.totalRevenueKobo).toFixed(2)},${report.totalInvoices}`;
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'revenue-report.csv'; a.click();
  URL.revokeObjectURL(url);
});

/* ── Data backup export ── */
async function exportData(format) {
  const result = document.querySelector('#export-result');
  result.textContent = 'Exporting...';
  try {
    const resp = await fetch(`/api/backup/json`, { headers: headers() });
    const body = await resp.json();
    if (!body.ok) { result.textContent = 'Export failed'; return; }
    
    if (format === 'csv') {
      const data = body.data;
      let csv = '=== PATIENTS ===\nFirst Name,Last Name,Phone,Email,Gender,DOB,Blood Group,Address,City\n';
      csv += (data.patients || []).map(p => 
        `"${p.firstName}","${p.lastName || ''}","${p.phone}","${p.email || ''}","${p.gender || ''}","${p.dob || ''}","${p.bloodGroup || ''}","${p.address || ''}","${p.city || ''}"`
      ).join('\n');
      csv += '\n\n=== APPOINTMENTS ===\nService,Status,Date,Branch\n';
      csv += (data.appointments || []).map(a => 
        `"${a.serviceName}","${a.status}","${a.startsAt}","${a.branchId}"`
      ).join('\n');
      downloadBlob(csv, `clinic-backup-${new Date().toISOString().slice(0,10)}.csv`, 'text/csv');
    } else {
      downloadBlob(JSON.stringify(body.data, null, 2), `clinic-backup-${new Date().toISOString().slice(0,10)}.json`, 'application/json');
    }
    result.textContent = `✅ Exported ${(body.data.patients || []).length} patients, ${(body.data.appointments || []).length} appointments`;
  } catch (e) {
    result.textContent = `❌ ${e.message}`;
  }
}

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

document.querySelector('#export-json-btn')?.addEventListener('click', () => exportData('json'));
document.querySelector('#export-csv-btn')?.addEventListener('click', () => exportData('csv'));

async function loadReport() {
  const from = document.querySelector('#report-filter [name="from"]').value;
  const to = document.querySelector('#report-filter [name="to"]').value;
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  try {
    const resp = await fetch(`/api/reports/revenue?${qs}`, { headers: headers() });
    const report = await resp.json();
    if (!report) return;

    // Summary cards
    const revenueKobo = report.totalRevenueKobo || 0;
    const withDefault = (v, d=0) => (v ?? d);
    document.querySelector('#report-summary').innerHTML = [
      { label: 'Total Revenue', value: `₦${(withDefault(revenueKobo)).toLocaleString()}` },
      { label: 'Total Invoices', value: withDefault(report.totalInvoices) },
      { label: 'Paid', value: withDefault(report.paidInvoices) },
      { label: 'Unpaid', value: withDefault(report.unpaidInvoices) },
    ].map(s => `<div class="report-stat-card"><strong>${s.value}</strong><span>${s.label}</span></div>`).join('');

    // Chart bars
    const daily = report.daily || [];
    if (daily.length === 0) {
      document.querySelector('#report-chart').innerHTML = '<p class="detail-empty">No revenue data for this period.</p>';
      document.querySelector('#report-tbody').innerHTML = '<tr><td colspan="3" class="detail-empty">No data</td></tr>';
      return;
    }
    const maxVal = Math.max(...daily.map(d => d.totalKobo), 1);
    document.querySelector('#report-chart').innerHTML = daily.map(d =>
      `<div class="bar" style="height:${Math.max((d.totalKobo / maxVal) * 180, 4)}px">
        <span class="bar-tooltip">₦${d.totalKobo.toLocaleString()} · ${d.count} txns</span>
        <span class="bar-label">${new Date(d.date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
      </div>`
    ).join('');

    // Table
    document.querySelector('#report-tbody').innerHTML = daily.map(d =>
      `<tr><td>${new Date(d.date + 'T00:00:00').toLocaleDateString()}</td><td>₦${d.totalKobo.toLocaleString()}</td><td>${d.count}</td></tr>`
    ).join('');
  } catch {}
}

/* ── Paystack payment in billing ── */
document.addEventListener('click', async (e) => {
  const payBtn = e.target.closest('[data-paystack]');
  const patientPayBtn = e.target.closest('[data-patient-paystack]');
  const invoiceId = payBtn?.dataset?.paystack || patientPayBtn?.dataset?.patientPaystack;
  if (payBtn || patientPayBtn) {
    try {
      const resp = await fetch('/api/payments/initialize', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ invoiceId }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        alert(data.error || 'Payment initialization failed');
        return;
      }
      if (data.authorizationUrl) {
        window.location.href = data.authorizationUrl;
        return;
      }
      if (data.reference) {
        alert(`Payment ref: ${data.reference}\nAmount: ₦${(data.amountKobo || 0).toLocaleString()}\nRedirect URL: ${data.authorizationUrl || 'NONE'}`);
        if (data.authorizationUrl) {
          window.location.href = data.authorizationUrl;
        }
        await refresh();
      }
    } catch (err) {
      alert('Payment initialization failed');
    }
  }
});

loadFromToken();
bindOfflineControls();
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
window.addEventListener('online', async () => {
  try {
    await syncNow(headers);
    await refresh();
  } catch {
    await renderOfflinePanel({ headers, onRefreshed: refresh });
  }
});
if ('serviceWorker' in navigator && 'sync' in window.ServiceWorkerRegistration.prototype) {
  navigator.serviceWorker.ready.then((reg) => reg.sync.register('clinic-sync')).catch(() => {});
}

async function submitOrQueue(form, { entityType, endpoint, payload, errorEl }) {
  const notice = document.querySelector('#offline-notice');
  try {
    if (isBrowserOffline()) throw new Error('offline');
    const response = await fetch(endpoint, { method: 'POST', headers: headers(), body: JSON.stringify(payload) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(body.error || 'Request failed');
      err.clientError = response.status < 500;
      if (errorEl) errorEl.textContent = err.message;
      throw err;
    }
    if (notice) notice.textContent = '';
    if (errorEl) errorEl.textContent = '';
    form.reset();
    await refresh();
    return { ok: true };
  } catch (error) {
    if (error.clientError) return { ok: false };
    await queueCreate({ tenantId, entityType, payload, endpoint });
    if (notice) notice.textContent = 'Saved offline. It will sync when internet returns.';
    form.reset();
    await renderOfflinePanel({ headers, onRefreshed: refresh });
    return { queued: true };
  }
}
