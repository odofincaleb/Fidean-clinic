/* Specialist diagram components for Fidean Clinic SaaS
 * Generic modular system — each specialist type registers its own interactive diagram.
 * Dental is the first template, now using the Universal Numbering System (#1–#32).
 */

(function (global) {
  'use strict';

  /* ── Dental: Universal Numbering System (U.S.) ──
   * Adult permanent teeth are numbered 1–32:
   * Upper row: #1 upper right third molar → #16 upper left third molar.
   * Lower row: #17 lower left third molar → #32 lower right third molar.
   */
  const UNIVERSAL_TEETH = [
    { id: '1', arch: 'upper', side: 'right', name: 'Third Molar' },
    { id: '2', arch: 'upper', side: 'right', name: 'Second Molar' },
    { id: '3', arch: 'upper', side: 'right', name: 'First Molar' },
    { id: '4', arch: 'upper', side: 'right', name: 'Second Bicuspid' },
    { id: '5', arch: 'upper', side: 'right', name: 'First Bicuspid' },
    { id: '6', arch: 'upper', side: 'right', name: 'Cuspid' },
    { id: '7', arch: 'upper', side: 'right', name: 'Lateral Incisor' },
    { id: '8', arch: 'upper', side: 'right', name: 'Central Incisor' },
    { id: '9', arch: 'upper', side: 'left', name: 'Central Incisor' },
    { id: '10', arch: 'upper', side: 'left', name: 'Lateral Incisor' },
    { id: '11', arch: 'upper', side: 'left', name: 'Cuspid' },
    { id: '12', arch: 'upper', side: 'left', name: 'First Bicuspid' },
    { id: '13', arch: 'upper', side: 'left', name: 'Second Bicuspid' },
    { id: '14', arch: 'upper', side: 'left', name: 'First Molar' },
    { id: '15', arch: 'upper', side: 'left', name: 'Second Molar' },
    { id: '16', arch: 'upper', side: 'left', name: 'Third Molar' },
    { id: '17', arch: 'lower', side: 'left', name: 'Third Molar' },
    { id: '18', arch: 'lower', side: 'left', name: 'Second Molar' },
    { id: '19', arch: 'lower', side: 'left', name: 'First Molar' },
    { id: '20', arch: 'lower', side: 'left', name: 'Second Bicuspid' },
    { id: '21', arch: 'lower', side: 'left', name: 'First Bicuspid' },
    { id: '22', arch: 'lower', side: 'left', name: 'Cuspid' },
    { id: '23', arch: 'lower', side: 'left', name: 'Lateral Incisor' },
    { id: '24', arch: 'lower', side: 'left', name: 'Central Incisor' },
    { id: '25', arch: 'lower', side: 'right', name: 'Central Incisor' },
    { id: '26', arch: 'lower', side: 'right', name: 'Lateral Incisor' },
    { id: '27', arch: 'lower', side: 'right', name: 'Cuspid' },
    { id: '28', arch: 'lower', side: 'right', name: 'First Bicuspid' },
    { id: '29', arch: 'lower', side: 'right', name: 'Second Bicuspid' },
    { id: '30', arch: 'lower', side: 'right', name: 'First Molar' },
    { id: '31', arch: 'lower', side: 'right', name: 'Second Molar' },
    { id: '32', arch: 'lower', side: 'right', name: 'Third Molar' },
  ];

  const FINDING_OPTIONS = [
    { value: 'caries', label: 'Decay / Caries', color: '#b45309' },
    { value: 'filling', label: 'Filling', color: '#2563eb' },
    { value: 'crown', label: 'Crown', color: '#7c3aed' },
    { value: 'implant', label: 'Implant', color: '#0d9488' },
    { value: 'missing', label: 'Missing', color: '#dc2626' },
    { value: 'fracture', label: 'Fracture', color: '#db2777' },
    { value: 'rootCanal', label: 'Root Canal', color: '#9333ea' },
    { value: 'gingivitis', label: 'Gum disease', color: '#ea580c' },
    { value: 'normal', label: 'Normal / Healthy', color: '#16a34a' },
  ];

  const FINDING_BY_VALUE = Object.fromEntries(FINDING_OPTIONS.map((f) => [f.value, f]));
  const TOOTH_BY_ID = Object.fromEntries(UNIVERSAL_TEETH.map((tooth) => [tooth.id, tooth]));

  function describeDentalTarget(toothId) {
    const tooth = TOOTH_BY_ID[String(toothId)];
    if (!tooth) return `Tooth #${toothId}`;
    const arch = tooth.arch === 'upper' ? 'Upper' : 'Lower';
    const side = tooth.side === 'right' ? 'Right' : 'Left';
    return `${arch} ${side} ${tooth.name}`;
  }

  function dentalCoordinates(toothId) {
    const tooth = TOOTH_BY_ID[String(toothId)];
    if (!tooth) return undefined;
    const upper = UNIVERSAL_TEETH.filter((t) => t.arch === 'upper');
    const lower = UNIVERSAL_TEETH.filter((t) => t.arch === 'lower');
    const row = tooth.arch === 'upper' ? upper : lower;
    const idx = row.findIndex((t) => t.id === String(toothId));
    if (idx < 0) return undefined;
    const toothSize = 30;
    const gap = 5;
    const startX = 152;
    const baseY = tooth.arch === 'upper' ? 82 : 226;
    const curve = Math.sin((idx / 15) * Math.PI) * (tooth.arch === 'upper' ? -42 : 42);
    return {
      x: Number((((startX + idx * (toothSize + gap) + 15) / 860) * 100).toFixed(2)),
      y: Number((((baseY + curve + 15) / 390) * 100).toFixed(2)),
    };
  }

  function escapeHtmlAttr(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function toothShape(tooth, finding, hasNote) {
    const toothFill = finding ? finding.color : '#fff7fb';
    const stroke = hasNote ? '#dc2626' : '#f0a8bf';
    const labelFill = finding ? '#ffffff' : '#4a3f8f';
    return `
      <rect class="tooth-hit-area" x="-8" y="-8" width="46" height="46" rx="15" fill="transparent" pointer-events="all" />
      <path class="actual-tooth-shape" d="M5 12 C8 4 22 4 25 12 C28 21 22 29 15 29 C8 29 2 21 5 12Z" fill="${toothFill}" opacity="${finding ? '0.96' : '0.92'}" stroke="${stroke}" stroke-width="1.8" />
      <text x="15" y="19" text-anchor="middle" font-size="9.5" font-weight="900" fill="${labelFill}">${tooth.id}</text>`;
  }

  function renderLabel(label, x1, y1, x2, y2, align, toothId) {
    const tooth = TOOTH_BY_ID[toothId];
    const textAnchor = align === 'right' ? 'end' : 'start';
    const labelX = align === 'right' ? x1 - 7 : x1 + 7;
    return `
      <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#b8c2d7" stroke-width="1.2" stroke-linecap="round" />
      <text x="${labelX}" y="${y1 + 3}" text-anchor="${textAnchor}" font-size="7.2" fill="#4b5563" font-weight="700">${escapeHtmlAttr(tooth.name)} ${tooth.id}</text>`;
  }

  /* ── Render full adult dentition, Universal #1–#32 ── */
  function renderToothChartSvg(container, findings = {}, onSelect = () => {}) {
    const upper = UNIVERSAL_TEETH.filter((t) => t.arch === 'upper'); // 1..16, right→left
    const lower = UNIVERSAL_TEETH.filter((t) => t.arch === 'lower'); // 17..32, left→right
    const toothSize = 30;
    const gap = 5;
    const startX = 152;
    const upperY = 82;
    const lowerY = 226;
    const cells = [];

    upper.forEach((tooth, idx) => {
      const find = findings[tooth.id] || {};
      const finding = find.value ? FINDING_BY_VALUE[find.value] : null;
      const x = startX + idx * (toothSize + gap);
      const y = upperY + Math.sin((idx / 15) * Math.PI) * -42;
      const rotate = (idx - 7.5) * 3;
      cells.push(`<g transform="translate(${x},${y}) rotate(${rotate},15,15)" data-tooth-id="${tooth.id}" class="tooth-cell" role="button" tabindex="0" aria-label="Tooth ${tooth.id} ${escapeHtmlAttr(tooth.name)}" data-finding="${find.value || ''}">${toothShape(tooth, finding, Boolean(find.note))}</g>`);
    });

    lower.forEach((tooth, idx) => {
      const find = findings[tooth.id] || {};
      const finding = find.value ? FINDING_BY_VALUE[find.value] : null;
      const x = startX + idx * (toothSize + gap);
      const y = lowerY + Math.sin((idx / 15) * Math.PI) * 42;
      const rotate = (7.5 - idx) * 3;
      cells.push(`<g transform="translate(${x},${y}) rotate(${rotate},15,15)" data-tooth-id="${tooth.id}" class="tooth-cell" role="button" tabindex="0" aria-label="Tooth ${tooth.id} ${escapeHtmlAttr(tooth.name)}" data-finding="${find.value || ''}">${toothShape(tooth, finding, Boolean(find.note))}</g>`);
    });

    const upperLeftLabels = [8, 7, 6, 5, 4, 3, 2, 1];
    const upperRightLabels = [9, 10, 11, 12, 13, 14, 15, 16];
    const lowerLeftLabels = [32, 31, 30, 29, 28, 27, 26, 25];
    const lowerRightLabels = [17, 18, 19, 20, 21, 22, 23, 24];

    const labels = [];
    upperLeftLabels.forEach((n, i) => labels.push(renderLabel(TOOTH_BY_ID[String(n)].name, 126, 38 + i * 18, 150 + (8 - i) * 8, upperY + Math.sin(((n - 1) / 15) * Math.PI) * -42 + 13, 'right', String(n))));
    upperRightLabels.forEach((n, i) => labels.push(renderLabel(TOOTH_BY_ID[String(n)].name, 738, 38 + i * 18, startX + (n - 1) * (toothSize + gap) + 30, upperY + Math.sin(((n - 1) / 15) * Math.PI) * -42 + 13, 'left', String(n))));
    lowerLeftLabels.forEach((n, i) => labels.push(renderLabel(TOOTH_BY_ID[String(n)].name, 126, 214 + i * 18, startX + (n - 17) * (toothSize + gap), lowerY + Math.sin(((n - 17) / 15) * Math.PI) * 42 + 13, 'right', String(n))));
    lowerRightLabels.forEach((n, i) => labels.push(renderLabel(TOOTH_BY_ID[String(n)].name, 738, 214 + i * 18, startX + (n - 17) * (toothSize + gap) + 30, lowerY + Math.sin(((n - 17) / 15) * Math.PI) * 42 + 13, 'left', String(n))));

    container.innerHTML = `
      <div class="specialist-diagram-card universal-dental-card">
        <div class="specialist-diagram-head">
          <strong>Dental Chart — Universal Numbering (#1–#32)</strong>
          <span class="specialist-hint">Click a tooth to open/edit notes · use Clear tooth to remove</span>
        </div>
        <svg class="tooth-chart-svg universal-tooth-chart" viewBox="0 0 860 390" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <radialGradient id="gumPink" cx="50%" cy="35%" r="70%">
              <stop offset="0%" stop-color="#ffd4de" />
              <stop offset="100%" stop-color="#f184a6" />
            </radialGradient>
          </defs>
          <rect x="8" y="8" width="844" height="374" rx="24" fill="#f8f5ff" stroke="#e0daf8" />
          <text x="430" y="30" text-anchor="middle" font-size="15" font-weight="900" fill="#4a3f8f">UNIVERSAL NUMBERING SYSTEM</text>
          <path d="M275 120 C310 32 550 32 585 120 C530 112 330 112 275 120Z" fill="url(#gumPink)" stroke="#f184a6" stroke-width="2" opacity=".8" />
          <path d="M275 250 C310 338 550 338 585 250 C530 258 330 258 275 250Z" fill="url(#gumPink)" stroke="#f184a6" stroke-width="2" opacity=".8" />
          <text x="430" y="95" text-anchor="middle" font-size="17" font-weight="900" fill="#ffffff">UPPER</text>
          <text x="430" y="276" text-anchor="middle" font-size="17" font-weight="900" fill="#ffffff">LOWER</text>
          ${labels.join('')}
          ${cells.join('')}
        </svg>
        <div class="specialist-legend">
          ${FINDING_OPTIONS.map((f) => `<span class="legend-item"><i style="background:${f.color}"></i>${f.label}</span>`).join('')}
        </div>
      </div>`;

    const svg = container.querySelector('svg');
    svg.addEventListener('click', (e) => {
      const cell = e.target.closest('.tooth-cell');
      if (!cell) return;
      onSelect(cell.dataset.toothId, cell);
    });
    svg.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const cell = e.target.closest('.tooth-cell');
      if (!cell) return;
      e.preventDefault();
      onSelect(cell.dataset.toothId, cell);
    });
  }

  function renderToothFindingPanel(container, toothId, current, onSave, onClear) {
    const currentValue = current?.value || '';
    const tooth = TOOTH_BY_ID[String(toothId)] || { id: toothId, name: 'Tooth' };
    container.innerHTML = `
      <div class="specialist-finding-panel" data-tooth-panel="${toothId}">
        <h4>Tooth #${tooth.id} — ${escapeHtmlAttr(tooth.name)}</h4>
        <div class="finding-picker">
          ${FINDING_OPTIONS.map((f) => `<button type="button" class="finding-pill ${currentValue === f.value ? 'active' : ''}" data-find-value="${f.value}" style="${currentValue === f.value ? `--pill-bg:${f.color}` : ''}"><i style="background:${f.color}"></i>${f.label}</button>`).join('')}
        </div>
        <input class="finding-note" placeholder="Optional note (e.g. pain, sensitivity, caries surface, pocket depth)" value="${escapeHtmlAttr(current?.note || '')}" />
        <div class="finding-actions">
          <button type="button" class="save-btn finding-save">Save finding</button>
          ${currentValue ? '<button type="button" class="delete-btn finding-clear">Clear tooth</button>' : ''}
        </div>
      </div>`;
    container.querySelector('.finding-picker').addEventListener('click', (e) => {
      const btn = e.target.closest('.finding-pill');
      if (!btn) return;
      container.querySelectorAll('.finding-pill').forEach((p) => {
        p.classList.remove('active');
        p.style.removeProperty('--pill-bg');
      });
      btn.classList.add('active');
      const f = FINDING_BY_VALUE[btn.dataset.findValue];
      if (f) btn.style.setProperty('--pill-bg', f.color);
    });
    container.querySelector('.finding-save').addEventListener('click', () => {
      const active = container.querySelector('.finding-pill.active');
      if (!active) return;
      onSave({
        value: active.dataset.findValue,
        toothName: tooth.name,
        numberingSystem: 'universal',
        note: container.querySelector('.finding-note').value.trim() || undefined,
      });
    });
    const clearBtn = container.querySelector('.finding-clear');
    if (clearBtn) clearBtn.addEventListener('click', onClear);
  }

  const DERM_FINDINGS = [
    { value: 'lesion', label: 'Lesion / Mole', color: '#7c3aed' },
    { value: 'rash', label: 'Rash', color: '#dc2626' },
    { value: 'burn', label: 'Burn', color: '#ea580c' },
    { value: 'biopsy', label: 'Biopsy site', color: '#2563eb' },
    { value: 'incision', label: 'Incision', color: '#db2777' },
    { value: 'scar', label: 'Scar', color: '#64748b' },
    { value: 'normal', label: 'Normal', color: '#16a34a' },
  ];

  const CARDIO_FINDINGS = [
    { value: 'normal', label: 'Normal motion', color: '#16a34a' },
    { value: 'hypokinesis', label: 'Hypokinesis', color: '#f59e0b' },
    { value: 'akinesis', label: 'Akinesis', color: '#dc2626' },
    { value: 'dyskinesis', label: 'Dyskinesis', color: '#db2777' },
    { value: 'scar', label: 'Scar / infarct', color: '#64748b' },
    { value: 'ischemia', label: 'Ischemia', color: '#7c3aed' },
  ];

  const DERMO_REGIONS = [
    { id: 'head_9', label: 'Head / Neck — 9%', x: 270, y: 48, w: 70, h: 64, pct: 9 },
    { id: 'anterior_trunk_18', label: 'Anterior Trunk — 18%', x: 244, y: 116, w: 122, h: 148, pct: 18 },
    { id: 'right_arm_9', label: 'Right Arm — 9%', x: 174, y: 126, w: 52, h: 140, pct: 9 },
    { id: 'left_arm_9', label: 'Left Arm — 9%', x: 384, y: 126, w: 52, h: 140, pct: 9 },
    { id: 'right_leg_18', label: 'Right Leg — 18%', x: 240, y: 276, w: 56, h: 170, pct: 18 },
    { id: 'left_leg_18', label: 'Left Leg — 18%', x: 314, y: 276, w: 56, h: 170, pct: 18 },
    { id: 'posterior_head_9', label: 'Posterior Head / Neck — 9%', x: 610, y: 48, w: 70, h: 64, pct: 9 },
    { id: 'posterior_trunk_18', label: 'Posterior Trunk — 18%', x: 584, y: 116, w: 122, h: 148, pct: 18 },
    { id: 'posterior_right_arm_9', label: 'Posterior Right Arm — 9%', x: 514, y: 126, w: 52, h: 140, pct: 9 },
    { id: 'posterior_left_arm_9', label: 'Posterior Left Arm — 9%', x: 724, y: 126, w: 52, h: 140, pct: 9 },
    { id: 'posterior_right_leg_18', label: 'Posterior Right Leg — 18%', x: 580, y: 276, w: 56, h: 170, pct: 18 },
    { id: 'posterior_left_leg_18', label: 'Posterior Left Leg — 18%', x: 654, y: 276, w: 56, h: 170, pct: 18 },
  ];
  const DERMO_BY_ID = Object.fromEntries(DERMO_REGIONS.map((r) => [r.id, r]));

  const AHA_SEGMENTS = [
    { id: '1', label: 'Basal Anterior', ring: 'basal', d: 'M250 54 A196 196 0 0 1 420 152 L341 197 A105 105 0 0 0 250 149 Z', x: 50, y: 16 },
    { id: '2', label: 'Basal Anteroseptal', ring: 'basal', d: 'M420 152 A196 196 0 0 1 420 348 L341 303 A105 105 0 0 0 341 197 Z', x: 78, y: 38 },
    { id: '3', label: 'Basal Inferoseptal', ring: 'basal', d: 'M420 348 A196 196 0 0 1 250 446 L250 351 A105 105 0 0 0 341 303 Z', x: 78, y: 62 },
    { id: '4', label: 'Basal Inferior', ring: 'basal', d: 'M250 446 A196 196 0 0 1 80 348 L159 303 A105 105 0 0 0 250 351 Z', x: 50, y: 84 },
    { id: '5', label: 'Basal Inferolateral', ring: 'basal', d: 'M80 348 A196 196 0 0 1 80 152 L159 197 A105 105 0 0 0 159 303 Z', x: 22, y: 62 },
    { id: '6', label: 'Basal Anterolateral', ring: 'basal', d: 'M80 152 A196 196 0 0 1 250 54 L250 149 A105 105 0 0 0 159 197 Z', x: 22, y: 38 },
    { id: '7', label: 'Mid Anterior', ring: 'mid', d: 'M250 150 A104 104 0 0 1 340 198 L286 230 A42 42 0 0 0 250 208 Z', x: 50, y: 31 },
    { id: '8', label: 'Mid Anteroseptal', ring: 'mid', d: 'M340 198 A104 104 0 0 1 340 302 L286 270 A42 42 0 0 0 286 230 Z', x: 65, y: 44 },
    { id: '9', label: 'Mid Inferoseptal', ring: 'mid', d: 'M340 302 A104 104 0 0 1 250 350 L250 292 A42 42 0 0 0 286 270 Z', x: 65, y: 56 },
    { id: '10', label: 'Mid Inferior', ring: 'mid', d: 'M250 350 A104 104 0 0 1 160 302 L214 270 A42 42 0 0 0 250 292 Z', x: 50, y: 69 },
    { id: '11', label: 'Mid Inferolateral', ring: 'mid', d: 'M160 302 A104 104 0 0 1 160 198 L214 230 A42 42 0 0 0 214 270 Z', x: 35, y: 56 },
    { id: '12', label: 'Mid Anterolateral', ring: 'mid', d: 'M160 198 A104 104 0 0 1 250 150 L250 208 A42 42 0 0 0 214 230 Z', x: 35, y: 44 },
    { id: '13', label: 'Apical Anterior', ring: 'apical', d: 'M250 209 A41 41 0 0 1 286 230 L250 250 Z', x: 50, y: 43 },
    { id: '14', label: 'Apical Septal', ring: 'apical', d: 'M286 230 A41 41 0 0 1 286 270 L250 250 Z', x: 58, y: 50 },
    { id: '15', label: 'Apical Inferior', ring: 'apical', d: 'M286 270 A41 41 0 0 1 250 291 L250 250 Z', x: 50, y: 57 },
    { id: '16', label: 'Apical Lateral', ring: 'apical', d: 'M250 291 A41 41 0 0 1 214 270 A41 41 0 0 1 214 230 A41 41 0 0 1 250 209 L250 250 Z', x: 42, y: 50 },
    { id: '17', label: 'Apex', ring: 'apex', d: 'M250 230 A20 20 0 1 1 249.9 230 Z', x: 50, y: 50 },
  ];
  const AHA_BY_ID = Object.fromEntries(AHA_SEGMENTS.map((s) => [s.id, s]));

  function renderRegionFindingPanel(container, targetId, current, onSave, onClear, config) {
    const options = config.options;
    const currentValue = current?.value || '';
    const target = config.byId[String(targetId)] || { id: targetId, label: `Region ${targetId}` };
    container.innerHTML = `
      <div class="specialist-finding-panel" data-region-panel="${escapeHtmlAttr(targetId)}">
        <h4>${escapeHtmlAttr(config.panelPrefix)} ${escapeHtmlAttr(target.id)} — ${escapeHtmlAttr(target.label)}</h4>
        <div class="finding-picker">
          ${options.map((f) => `<button type="button" class="finding-pill ${currentValue === f.value ? 'active' : ''}" data-find-value="${f.value}" style="${currentValue === f.value ? `--pill-bg:${f.color}` : ''}"><i style="background:${f.color}"></i>${f.label}</button>`).join('')}
        </div>
        <input class="finding-note" placeholder="${escapeHtmlAttr(config.placeholder)}" value="${escapeHtmlAttr(current?.note || '')}" />
        <div class="finding-actions">
          <button type="button" class="save-btn finding-save">Save annotation</button>
          ${currentValue ? `<button type="button" class="delete-btn finding-clear">Clear ${escapeHtmlAttr(config.clearLabel)}</button>` : ''}
        </div>
      </div>`;
    container.querySelector('.finding-picker').addEventListener('click', (e) => {
      const btn = e.target.closest('.finding-pill');
      if (!btn) return;
      container.querySelectorAll('.finding-pill').forEach((p) => { p.classList.remove('active'); p.style.removeProperty('--pill-bg'); });
      btn.classList.add('active');
      const item = options.find((f) => f.value === btn.dataset.findValue);
      if (item) btn.style.setProperty('--pill-bg', item.color);
    });
    container.querySelector('.finding-save').addEventListener('click', () => {
      const active = container.querySelector('.finding-pill.active');
      if (!active) return;
      onSave({
        value: active.dataset.findValue,
        targetLabel: target.label,
        numberingSystem: config.numberingSystem,
        note: container.querySelector('.finding-note').value.trim() || undefined,
      });
    });
    const clearBtn = container.querySelector('.finding-clear');
    if (clearBtn) clearBtn.addEventListener('click', onClear);
  }

  function renderDermatologyCanvas(container, findings = {}, onSelect = () => {}) {
    const regions = DERMO_REGIONS.map((r) => {
      const finding = findings[r.id]?.value ? DERM_FINDINGS.find((f) => f.value === findings[r.id].value) : null;
      const fill = finding ? finding.color : '#f7c7d9';
      return `<g class="body-region canvas-hotspot" data-region-id="${r.id}" data-finding="${findings[r.id]?.value || ''}" role="button" tabindex="0" aria-label="${escapeHtmlAttr(r.label)}">
        <rect class="canvas-hit-area" x="${r.x - 6}" y="${r.y - 6}" width="${r.w + 12}" height="${r.h + 12}" rx="18" fill="transparent" pointer-events="all" />
        <rect class="body-region-shape" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${Math.min(28, r.w / 2)}" fill="${fill}" opacity="${finding ? '.9' : '.55'}" stroke="#bd6f90" stroke-width="1.7" />
        <text x="${r.x + r.w / 2}" y="${r.y + r.h / 2}" text-anchor="middle" font-size="12" font-weight="900" fill="${finding ? '#fff' : '#5b2141'}">${r.pct}%</text>
      </g>`;
    }).join('');
    container.innerHTML = `<div class="specialist-diagram-card canvas-card body-map-card">
      <div class="specialist-diagram-head"><strong>Dermatology Body Surface Map — Rule of Nines</strong><span class="specialist-hint">Click a body region to add lesion, rash, burn, biopsy, incision, or scar notes</span></div>
      <svg class="specialist-canvas-svg body-map-svg" viewBox="0 0 950 500" xmlns="http://www.w3.org/2000/svg">
        <rect x="8" y="8" width="934" height="484" rx="24" fill="#f8f5ff" stroke="#e0daf8" />
        <text x="305" y="36" text-anchor="middle" font-size="16" font-weight="900" fill="#4a3f8f">ANTERIOR</text>
        <text x="645" y="36" text-anchor="middle" font-size="16" font-weight="900" fill="#4a3f8f">POSTERIOR</text>
        ${regions}
      </svg>
      <div class="specialist-legend">${DERM_FINDINGS.map((f) => `<span class="legend-item"><i style="background:${f.color}"></i>${f.label}</span>`).join('')}</div>
    </div>`;
    container.querySelector('svg').addEventListener('click', (e) => {
      const region = e.target.closest('.body-region');
      if (region) onSelect(region.dataset.regionId, region);
    });
  }

  function renderDermatologyFindingPanel(container, targetId, current, onSave, onClear) {
    renderRegionFindingPanel(container, targetId, current, onSave, onClear, {
      options: DERM_FINDINGS,
      byId: DERMO_BY_ID,
      panelPrefix: 'Body region',
      clearLabel: 'region',
      numberingSystem: 'rule_of_nines',
      placeholder: 'Optional note (e.g. mole size, rash description, burn depth, biopsy site)',
    });
  }

  function renderCardiologyCanvas(container, findings = {}, onSelect = () => {}) {
    const paths = AHA_SEGMENTS.map((s) => {
      const finding = findings[s.id]?.value ? CARDIO_FINDINGS.find((f) => f.value === findings[s.id].value) : null;
      const fill = finding ? finding.color : '#ede9fe';
      return `<g class="aha-region canvas-hotspot" data-segment-id="${s.id}" data-finding="${findings[s.id]?.value || ''}" role="button" tabindex="0" aria-label="AHA segment ${s.id}: ${escapeHtmlAttr(s.label)}">
        <path class="aha-region-shape" d="${s.d}" fill="${fill}" opacity="${finding ? '.95' : '.82'}" stroke="#9c8df4" stroke-width="2" />
        <text x="${s.x * 5}" y="${s.y * 5}" text-anchor="middle" font-size="18" font-weight="900" fill="${finding ? '#fff' : '#4a3f8f'}">${s.id}</text>
      </g>`;
    }).join('');
    container.innerHTML = `<div class="specialist-diagram-card canvas-card aha-card">
      <div class="specialist-diagram-head"><strong>Cardiology Canvas — AHA 17-Segment Model</strong><span class="specialist-hint">Click a numbered cardiac segment to mark wall motion, ischemia, scar, or infarct notes</span></div>
      <svg class="specialist-canvas-svg aha-svg" viewBox="0 0 500 500" xmlns="http://www.w3.org/2000/svg">
        <rect x="8" y="8" width="484" height="484" rx="24" fill="#f8f5ff" stroke="#e0daf8" />
        <text x="250" y="30" text-anchor="middle" font-size="15" font-weight="900" fill="#4a3f8f">AHA 17-SEGMENT BULLSEYE</text>
        ${paths}
      </svg>
      <div class="specialist-legend">${CARDIO_FINDINGS.map((f) => `<span class="legend-item"><i style="background:${f.color}"></i>${f.label}</span>`).join('')}</div>
    </div>`;
    container.querySelector('svg').addEventListener('click', (e) => {
      const segment = e.target.closest('.aha-region');
      if (segment) onSelect(segment.dataset.segmentId, segment);
    });
  }

  function renderCardiologyFindingPanel(container, targetId, current, onSave, onClear) {
    renderRegionFindingPanel(container, targetId, current, onSave, onClear, {
      options: CARDIO_FINDINGS,
      byId: AHA_BY_ID,
      panelPrefix: 'AHA segment',
      clearLabel: 'segment',
      numberingSystem: 'aha_17_segment',
      placeholder: 'Optional note (e.g. EF, wall-motion abnormality, ischemia territory, blockage %)',
    });
  }

  const modules = {
    dental: {
      name: 'Dental / Oral',
      chartType: 'Dental_Adult_Universal',
      specialty: 'dentistry',
      standard: 'Universal Numbering System',
      numberingSystem: 'universal',
      render: renderToothChartSvg,
      renderFinding: renderToothFindingPanel,
      empty: () => ({ type: 'dental', numberingSystem: 'universal', findings: {} }),
      describeTarget: describeDentalTarget,
      coordinatesFor: dentalCoordinates,
    },
    dermatology: {
      name: 'Dermatology — Body Surface Map',
      chartType: 'Dermatology_Body_Surface_RuleOfNines',
      specialty: 'dermatology',
      standard: 'Rule of Nines / Body Surface Mapping',
      numberingSystem: 'rule_of_nines',
      render: renderDermatologyCanvas,
      renderFinding: renderDermatologyFindingPanel,
      empty: () => ({ type: 'dermatology', numberingSystem: 'rule_of_nines', findings: {} }),
      describeTarget: (id) => DERMO_BY_ID[String(id)]?.label || `Body region ${id}`,
      coordinatesFor: (id) => {
        const r = DERMO_BY_ID[String(id)];
        return r ? { x: Number(((r.x + r.w / 2) / 950 * 100).toFixed(2)), y: Number(((r.y + r.h / 2) / 500 * 100).toFixed(2)) } : undefined;
      },
    },
    cardiology: {
      name: 'Cardiology — AHA 17-Segment',
      chartType: 'Cardiology_AHA_17_Segment',
      specialty: 'cardiology',
      standard: 'AHA 17-Segment Model',
      numberingSystem: 'aha_17_segment',
      render: renderCardiologyCanvas,
      renderFinding: renderCardiologyFindingPanel,
      empty: () => ({ type: 'cardiology', numberingSystem: 'aha_17_segment', findings: {} }),
      describeTarget: (id) => AHA_BY_ID[String(id)] ? `AHA Segment ${id} — ${AHA_BY_ID[String(id)].label}` : `AHA Segment ${id}`,
      coordinatesFor: (id) => {
        const s = AHA_BY_ID[String(id)];
        return s ? { x: s.x, y: s.y } : undefined;
      },
    },
    // Future templates: dental FDI, dermatome ASIA, skeletal maps, abdomen 9-region.
  };

  function getModule(type) {
    return modules[type] || null;
  }

  global.SpecialistCharts = {
    modules,
    getModule,
    describeTarget: (type, targetId) => getModule(type)?.describeTarget?.(targetId),
    coordinatesFor: (type, targetId) => getModule(type)?.coordinatesFor?.(targetId),
    teeth: UNIVERSAL_TEETH,
    findings: FINDING_OPTIONS,
  };
})(window);
