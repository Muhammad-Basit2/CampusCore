/**
 * Settings view - school profile, branding (logo upload) and print options.
 */
'use strict';

const Settings = {
  pendingLogo: undefined,

  fields: [
    { key: 'schoolName', label: 'School name', type: 'text' },
    { key: 'schoolTagline', label: 'Tagline', type: 'text' },
    { key: 'schoolAddress', label: 'Address', type: 'text' },
    { key: 'schoolPhone', label: 'Phone', type: 'text' },
    { key: 'schoolEmail', label: 'Email', type: 'text' },
    { key: 'principalName', label: 'Principal', type: 'text' },
    { key: 'teacherName', label: 'Class teacher', type: 'text' },
    { key: 'academicYear', label: 'Academic year', type: 'text', hint: 'e.g. 2026-2027' },
    { key: 'reportHeading', label: 'Report card heading', type: 'text' },
    { key: 'currencySymbol', label: 'Currency symbol', type: 'text', hint: 'e.g. Rs, $, EUR, ₨' },
    { key: 'invoicePrefix', label: 'Invoice number prefix', type: 'text', hint: 'e.g. INV- gives INV-2026-0001' },
    { key: 'passMarkPercentage', label: 'Pass mark (%)', type: 'number', hint: 'Applies to each subject and the overall result' },
    { key: 'invoiceFooter', label: 'Invoice footer note', type: 'textarea' },
  ],

  async load() {
    const view = $('#view-settings');
    const settings = await window.api.settings.getAll();
    State.settings = settings;

    view.innerHTML = `
      <div class="grid cols-2">
        <div class="card">
          <div class="card-head"><h3>School Profile &amp; Branding</h3></div>
          <div class="card-body">
            <div class="form-grid">
              ${this.fields
                .map(
                  (f) => `
                <div class="field ${f.type === 'textarea' ? 'full' : ''}">
                  <label for="set_${f.key}">${esc(f.label)}</label>
                  ${f.type === 'textarea'
                    ? `<textarea id="set_${f.key}" data-key="${f.key}">${esc(settings[f.key] || '')}</textarea>`
                    : `<input id="set_${f.key}" data-key="${f.key}" type="${f.type}" value="${esc(settings[f.key] || '')}" />`}
                  ${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}
                </div>`,
                )
                .join('')}
            </div>
          </div>
        </div>

        <div>
          <div class="card">
            <div class="card-head">
              <h3>School Logo</h3>
              <span class="sub">PNG, JPG, SVG or WebP &middot; max 2 MB</span>
            </div>
            <div class="card-body">
              <div style="display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap">
                <img class="logo-preview" id="logoPreview"
                     src="${settings.schoolLogo || 'styles/logo-placeholder.svg'}" alt="School logo" />
                <div class="field" style="flex:1;min-width:220px">
                  <label for="logoFile">Upload logo</label>
                  <input type="file" id="logoFile" accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif" />
                  <span class="hint">Stored locally in the database. Appears on invoices and report cards.</span>
                  <div class="btn-row" style="margin-top:10px">
                    <button class="btn danger sm" id="logoClear">Remove logo</button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><h3>Save</h3></div>
            <div class="card-body">
              <p class="muted" style="margin:0 0 12px;font-size:12.5px">
                Changes apply immediately across invoices, receipts and report cards.
              </p>
              <div class="btn-row" style="margin:0">
                <button class="btn primary" id="saveSettings">Save settings</button>
                <button class="btn ghost" id="resetSettings">Restore defaults</button>
              </div>
            </div>
          </div>
        </div>
      </div>`;

    this.bind(view);
    this.bindKeys();
  },

  /**
   * Shortcuts for this view.
   *
   * `s` is the one that matters: a settings form is a wall of fields with a save
   * button at the bottom, and Ctrl+S is taken by "go to Students" - so plain S
   * saves. The dispatcher only claims Ctrl+Enter for save, which works from
   * inside any field; this adds the same action to a plain keystroke.
   */
  bindKeys() {
    const view = $('#view-settings');
    Keys.register('settings', {
      s: {
        keys: 'S',
        label: 'Save settings',
        run: () => $('#saveSettings', view).click(),
      },
      r: {
        keys: 'R',
        label: 'Restore the default settings',
        run: () => $('#resetSettings', view).click(),
      },
    });
  },


  bind(view) {
    // Live preview of the logo selection before saving.
    const file = $('#logoFile', view);
    file.addEventListener('change', async () => {
      const chosen = file.files && file.files[0];
      if (!chosen) return;
      if (chosen.size > 2 * 1024 * 1024) {
        notify.warn('Image too large', 'Please choose an image under 2 MB.');
        file.value = '';
        return;
      }
      try {
        const dataUrl = await readFileAsDataUrl(chosen);
        $('#logoPreview', view).src = dataUrl;
        Settings.pendingLogo = dataUrl;
      } catch (err) {
        notify.error('Could not read image', err.message);
      }
    });

    $('#logoClear', view).addEventListener('click', () => {
      $('#logoPreview', view).src = 'styles/logo-placeholder.svg';
      Settings.pendingLogo = '';
      file.value = '';
    });

    $('#saveSettings', view).addEventListener('click', (e) => withBusy(e.currentTarget, () => this.save(view)));

    $('#resetSettings', view).addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Restore default settings',
        message: 'Reset every setting back to its default value?',
        detail: 'School name, logo, invoice options and pass mark will be reverted.',
        confirmText: 'Restore defaults',
        danger: true,
      });
      if (!ok) return;
      const result = await window.api.settings.reset();
      if (result.cancelled) return;
      State.settings = result.settings;
      await this.load();
      notify.ok('Settings restored', 'Default values have been reapplied.');
    });
  },

  async save(view) {
    const payload = {};
    $$('[data-key]', view).forEach((input) => {
      payload[input.dataset.key] = input.value.trim();
    });

    if (!payload.schoolName) {
      notify.warn('School name required', 'Please enter a school name before saving.');
      $('#set_schoolName', view).focus();
      return;
    }
    const passMark = Number(payload.passMarkPercentage);
    if (!Number.isFinite(passMark) || passMark < 0 || passMark > 100) {
      notify.warn('Invalid pass mark', 'Pass mark must be a number between 0 and 100.');
      $('#set_passMarkPercentage', view).focus();
      return;
    }
    if (Settings.pendingLogo !== undefined) payload.schoolLogo = Settings.pendingLogo;

    await window.api.settings.save(payload);
    Settings.pendingLogo = undefined;

    State.settings = await window.api.settings.getAll();
    Settings.applyBranding();
    notify.ok('Settings saved', 'Your changes have been applied.');
  },

  /** Pushes branding values into the sidebar, topbar and every document. */
  applyBranding() {
    const s = State.settings;
    $('#brandName').textContent = s.schoolName || 'CampusCore';
    document.title = `${s.schoolName || 'CampusCore'} - School Management & Invoicing`;
    $('#brandLogo').src = s.schoolLogo || 'styles/logo-placeholder.svg';
    $('#schoolPill').textContent = s.schoolName || 'School';
    $('#termPill').textContent = s.academicYear || 'Academic year not set';
  },
};

/** FileReader wrapper returning a base64 data URL. */
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('The file could not be read'));
    reader.readAsDataURL(file);
  });
}
