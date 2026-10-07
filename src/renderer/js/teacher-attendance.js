/**
 * Teacher Attendance view - mark attendance by date range.
 */
'use strict';

const TeacherAttendance = {
  rows: [],
  teacherId: '',
  dateFrom: '',
  dateTo: '',

  async load() {
    const view = $('#view-teacher-attendance');
    view.innerHTML = '<div class="empty"><span class="spinner"></span> Loading...</div>';

    this.rows = await window.api.teacherAttendance.list({
      teacherId: this.teacherId ? Number(this.teacherId) : undefined,
      dateFrom: this.dateFrom,
      dateTo: this.dateTo,
    });

    view.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>Teacher Attendance</h3>
          <div class="search-row no-print">
            <select id="taTeacher">
              <option value="">All Teachers</option>
            </select>
            <input type="date" id="taDateFrom" value="${this.dateFrom}" />
            <span class="muted">to</span>
            <input type="date" id="taDateTo" value="${this.dateTo}" />
            <button class="btn" id="taRefresh">Refresh</button>
            <button class="btn primary" id="taMark">Mark Attendance</button>
          </div>
        </div>
        <div class="card-body tight">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th><th>Teacher</th><th>Code</th><th>Status</th><th class="actions">Actions</th>
                </tr>
              </thead>
              <tbody>${
                this.rows.length
                  ? this.rows.map((r) => this.row(r)).join('')
                  : emptyRow(5, 'No attendance records found.', '📅')
              }</tbody>
            </table>
          </div>
        </div>
      </div>`;

    // Populate teacher dropdown
    const teachers = await window.api.teachers.list();
    const select = $('#taTeacher');
    if (select) {
      teachers.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.fullName;
        select.appendChild(opt);
      });
      if (this.teacherId) select.value = this.teacherId;
    }

    this.bind(view);
    this.bindKeys();
  },

  bindKeys() {
    Keys.register('teacher-attendance', {
      n: { keys: 'N', label: 'Mark attendance', run: () => $('#taMark').click() },
    });
  },

  row(r) {
    return `<tr data-id="${r.id}">
      <td>${esc(r.date)}</td>
      <td><strong>${esc(r.fullName)}</strong></td>
      <td class="mono">${esc(r.employeeCode)}</td>
      <td>${statusBadge(r.status)}</td>
      <td class="actions">
        <button class="btn danger sm delete-btn" data-id="${r.id}" title="Delete">🗑️</button>
      </td>
    </tr>`;
  },

  bind(view) {
    on(view, 'change', '#taTeacher', (e) => {
      this.teacherId = e.target.value;
      this.load();
    });
    on(view, 'change', '#taDateFrom', (e) => {
      this.dateFrom = e.target.value;
      this.load();
    });
    on(view, 'change', '#taDateTo', (e) => {
      this.dateTo = e.target.value;
      this.load();
    });
    on(view, 'click', '#taRefresh', () => this.load());
    on(view, 'click', '#taMark', () => this.openMarkModal());
    on(view, 'click', '.delete-btn', async (e, btn) => {
      const id = Number(btn.dataset.id);
      await window.api.teacherAttendance.remove(id);
      notify.ok('Record deleted');
      selfRendered();
      await this.load();
    });
  },

  async openMarkModal() {
    const teachers = await window.api.teachers.list();
    if (!teachers.length) {
      notify.warn('No teachers', 'Please add teachers first.');
      return;
    }

    await openModal((close) =>
      el('div', { class: 'modal' }, [
        el('div', { class: 'modal-head' }, [
          el('h3', { text: 'Mark Attendance' }),
          el('button', { class: 'btn ghost sm', text: 'Close', onClick: close }),
        ]),
        el('div', { class: 'modal-body' }, [
          el('div', { class: 'form-grid' }, [
            el('div', { class: 'field full' }, [
              el('label', { for: 'mark_teacher', text: 'Teacher' }),
              el('select', {
                id: 'mark_teacher',
                value: teachers[0]?.id ?? '',
              }, teachers.map((t) => el('option', { value: t.id, text: t.fullName }))),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'mark_date', text: 'Date' }),
              el('input', { id: 'mark_date', type: 'date', value: new Date().toISOString().split('T')[0] }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'mark_status', text: 'Status' }),
              el('select', { id: 'mark_status' }, [
                el('option', { value: 'Present', text: 'Present' }),
                el('option', { value: 'Absent', text: 'Absent' }),
                el('option', { value: 'Leave', text: 'Leave' }),
              ]),
            ]),
          ]),
        ]),
        el('div', { class: 'modal-foot' }, [
          el('button', { class: 'btn ghost', text: 'Cancel', onClick: close }),
          el('button', {
            class: 'btn primary',
            text: 'Save',
            onClick: (e) => withBusy(e.currentTarget, () => this.save(close)),
          }),
        ]),
      ]),
    );
  },

  async save(close) {
    const teacherId = Number($('#mark_teacher').value);
    const date = $('#mark_date').value.trim();
    const status = $('#mark_status').value;

    if (!teacherId || !date) {
      notify.warn('Missing fields', 'Please select a teacher and date.');
      return;
    }

    try {
      await window.api.teacherAttendance.upsert({ teacherId, date, status });
      notify.ok('Attendance saved', `${date}: ${status}`);
      close();
      selfRendered();
      await this.load();
    } catch (err) {
      notify.error('Failed', err.message);
    }
  },
};