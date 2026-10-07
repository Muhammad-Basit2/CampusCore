/**
 * Teachers view - searchable roster, create/edit/delete teachers.
 */
'use strict';

const Teachers = {
  rows: [],
  search: '',

  async load() {
    const view = $('#view-teachers');
    view.innerHTML = '<div class="empty"><span class="spinner"></span> Loading teachers...</div>';

    this.rows = await window.api.teachers.list(this.search);

    view.innerHTML = `
      <div class="grid cols-4">
        ${kpi('Total teachers', this.rows.length, 'on staff', 'accent-brand')}
      </div>

      <div class="card mt">
        <div class="card-head">
          <h3>Teachers</h3>
          <div class="search-row no-print">
            <input type="search" id="teacherSearch" placeholder="Search name, code or specialization..."
                   value="${esc(this.search)}" />
            <button class="btn primary" id="addTeacher">+ New teacher</button>
          </div>
        </div>
        <div class="card-body tight">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Code</th><th>Name</th><th>Specialization</th><th>Phone</th><th>Join Date</th>
                  <th class="num">Salary</th><th class="actions">Actions</th>
                </tr>
              </thead>
              <tbody>${
                this.rows.length
                  ? this.rows.map((r) => this.row(r)).join('')
                  : emptyRow(6, this.search ? 'No teachers match your search.' : 'No teachers yet.', '👤')
              }</tbody>
            </table>
          </div>
        </div>
      </div>`;

    this.bind(view);
    this.bindKeys();
  },

  bindKeys() {
    Keys.register('teachers', {
      n: { keys: 'N', label: 'New teacher', run: () => $('#addTeacher').click() },
      e: { keys: 'E', label: 'Edit the highlighted teacher', run: () => Keys.act('edit') },
      d: { keys: 'Del', label: 'Delete the highlighted teacher', run: () => Keys.act('delete') },
    });
  },

  bind(view) {
    on(view, 'input', '#teacherSearch', (e) => {
      this.search = e.target.value;
      this.load();
    });
    on(view, 'click', '#addTeacher', () => this.openForm());
    on(view, 'click', '.edit-btn', async (e) => {
      const id = Number(e.target.closest('[data-id]').dataset.id);
      const teacher = this.rows.find((r) => r.id === id);
      if (teacher) await this.openForm(teacher);
    });
    on(view, 'click', '.delete-btn', async (e) => {
      const id = Number(e.target.closest('[data-id]').dataset.id);
      const teacher = this.rows.find((r) => r.id === id);
      if (teacher) await this.remove(teacher);
    });
  },

  row(r) {
    return `<tr data-id="${r.id}">
      <td class="mono">${esc(r.employeeCode)}</td>
      <td><strong>${esc(r.fullName)}</strong></td>
      <td>${esc(r.specialization || '-')}</td>
      <td>${esc(r.phone || '-')}</td>
      <td>${esc(r.joiningDate || '-')}</td>
      <td class="num">${money(r.baseSalary)}</td>
      <td class="actions">
        <button class="btn ghost sm edit-btn" data-id="${r.id}" title="Edit">✏️</button>
        <button class="btn danger sm delete-btn" data-id="${r.id}" title="Delete">🗑️</button>
      </td>
    </tr>`;
  },

  async openForm(existing = null) {
    await openModal((close) =>
      el('div', { class: 'modal' }, [
        el('div', { class: 'modal-head' }, [
          el('h3', { text: existing ? 'Edit teacher' : 'Add teacher' }),
          el('button', { class: 'btn ghost sm', text: 'Close', onClick: close }),
        ]),
        el('div', { class: 'modal-body' }, [
          el('div', { class: 'form-grid' }, [
            el('div', { class: 'field' }, [
              el('label', { for: 't_fullName', text: 'Full Name' }),
              el('input', { id: 't_fullName', value: existing ? existing.fullName : '', placeholder: 'e.g. Mr. Ahmed Khan' }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 't_code', text: 'Employee Code' }),
              el('input', { id: 't_code', value: existing ? existing.employeeCode : '', placeholder: 'e.g. TCH-001' }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 't_spec', text: 'Specialization' }),
              el('input', { id: 't_spec', value: existing ? existing.specialization : '', placeholder: 'e.g. Mathematics' }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 't_phone', text: 'Phone' }),
              el('input', { id: 't_phone', value: existing ? existing.phone : '', placeholder: 'e.g. +92 300 1234567' }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 't_email', text: 'Email' }),
              el('input', { id: 't_email', type: 'email', value: existing ? existing.email : '', placeholder: 'teacher@school.edu' }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 't_join', text: 'Joining Date' }),
              el('input', { id: 't_join', type: 'date', value: existing ? existing.joiningDate : '' }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 't_salary', text: 'Base Salary' }),
              el('input', { id: 't_salary', type: 'number', min: '0', value: existing ? existing.baseSalary : '' }),
            ]),
          ]),
        ]),
        el('div', { class: 'modal-foot' }, [
          el('button', { class: 'btn ghost', text: 'Cancel', onClick: close }),
          el('button', {
            class: 'btn primary',
            text: existing ? 'Save changes' : 'Add teacher',
            onClick: (e) => withBusy(e.currentTarget, () => this.submit(existing, close)),
          }),
        ]),
      ]),
    );

    const first = existing ? $('#t_fullName') : $('#t_code');
    if (first) first.focus();
  },

  async submit(existing, close) {
    const val = (id) => ($(id) ? $(id).value.trim() : '');
    const payload = {
      fullName: val('#t_fullName'),
      employeeCode: val('#t_code'),
      specialization: val('#t_spec'),
      phone: val('#t_phone'),
      email: val('#t_email'),
      joiningDate: val('#t_join'),
      baseSalary: Number(val('#t_salary')) || 0,
    };

    if (!payload.fullName) {
      notify.warn('Name required', 'Please enter the teacher full name.');
      $('#t_fullName').focus();
      return;
    }
    if (!payload.employeeCode) {
      notify.warn('Code required', 'Please enter the employee code.');
      $('#t_code').focus();
      return;
    }

    try {
      if (existing && existing.id) {
        await window.api.teachers.update({ id: existing.id, ...payload });
        notify.ok('Teacher updated', payload.fullName);
      } else {
        await window.api.teachers.create(payload);
        notify.ok('Teacher added', payload.fullName);
      }
      close();
      selfRendered();
      await this.load();
    } catch (err) {
      notify.error('Failed', err.message);
    }
  },

  async remove(teacher) {
    const ok = await confirmDialog({
      title: 'Delete teacher',
      message: 'Delete ' + teacher.fullName + '?',
      detail: 'This action cannot be undone.',
      confirmText: 'Delete teacher',
      danger: true,
    });
    if (!ok) return;
    await window.api.teachers.remove(teacher.id);
    notify.ok('Teacher deleted', teacher.fullName + ' has been removed.');
    selfRendered();
    await this.load();
  },
};