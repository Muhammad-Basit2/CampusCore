/**
 * Teacher Payroll view - salary processing and management.
 */
'use strict';

const Payroll = {
  rows: [],
  teacherId: '',
  monthYear: '',

  async load() {
    const view = $('#view-payroll');
    view.innerHTML = '<div class="empty"><span class="spinner"></span> Loading...</div>';

    this.rows = await window.api.teacherPayroll.list({
      teacherId: this.teacherId ? Number(this.teacherId) : undefined,
      monthYear: this.monthYear,
    });

    view.innerHTML = `
      <div class="grid cols-4">
        ${kpi('Total Payroll', this.rows.length, 'records', 'accent-brand')}
        ${kpi('Paid', this.rows.filter(r => r.status === 'Paid').length, 'processed', 'accent-ok')}
        ${kpi('Pending', this.rows.filter(r => r.status === 'Pending').length, 'unpaid', 'accent-danger')}
        ${kpi('Total Net', money(this.rows.reduce((a, r) => a + (r.netSalary || 0), 0)), 'this period')}
      </div>

      <div class="card mt">
        <div class="card-head">
          <h3>Payroll Records</h3>
          <div class="search-row no-print">
            <select id="payroll_teacher">
              <option value="">All Teachers</option>
            </select>
            <input type="month" id="payroll_month" value="${this.monthYear}" />
            <button class="btn" id="payroll_refresh">Refresh</button>
            <button class="btn primary" id="payroll_add">+ Add Record</button>
          </div>
        </div>
        <div class="card-body tight">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Month</th><th>Teacher</th><th>Present Days</th>
                  <th class="num">Net Salary</th><th>Status</th><th class="actions">Actions</th>
                </tr>
              </thead>
              <tbody>${
                this.rows.length
                  ? this.rows.map((r) => this.row(r)).join('')
                  : emptyRow(6, 'No payroll records found.', '💰')
              }</tbody>
            </table>
          </div>
        </div>
      </div>`;

    const teachers = await window.api.teachers.list();
    const select = $('#payroll_teacher');
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
    Keys.register('payroll', {
      n: { keys: 'N', label: 'Add payroll record', run: () => $('#payroll_add').click() },
    });
  },

  bind(view) {
    on(view, 'change', '#payroll_teacher', (e) => {
      this.teacherId = e.target.value;
      this.load();
    });
    on(view, 'change', '#payroll_month', (e) => {
      this.monthYear = e.target.value;
      this.load();
    });
    on(view, 'click', '#payroll_refresh', () => this.load());
    on(view, 'click', '#payroll_add', () => this.openForm());
    on(view, 'click', '.mark-paid', async (e) => {
      const id = Number(e.target.dataset.id);
      try {
        await window.api.teacherPayroll.markPaid({ id });
        notify.ok('Marked as paid');
        await this.load();
      } catch (err) {
        notify.error('Failed', err.message);
      }
    });
    on(view, 'click', '.delete-btn', async (e) => {
      const id = Number(e.target.dataset.id);
      const ok = await confirmDialog({
        title: 'Delete payroll record',
        message: 'Delete this payroll record?',
        confirmText: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        await window.api.teacherPayroll.remove({ id });
        notify.ok('Payroll deleted');
        await this.load();
      } catch (err) {
        notify.error('Failed', err.message);
      }
    });
  },

  row(r) {
    return `<tr data-id="${r.id}">
      <td class="mono">${esc(r.monthYear)}</td>
      <td><strong>${esc(r.fullName)}</strong></td>
      <td>${esc(r.presentDays)} / ${esc(r.totalDays)}</td>
      <td class="num">${money(r.netSalary)}</td>
      <td>${statusBadge(r.status)}</td>
      <td class="actions">
        ${r.status === 'Pending' ? `<button class="btn ghost sm mark-paid" data-id="${r.id}" title="Mark Paid">✓</button>` : ''}
        <button class="btn danger sm delete-btn" data-id="${r.id}" title="Delete">🗑️</button>
      </td>
    </tr>`;
  },

  async openForm() {
    const teachers = await window.api.teachers.list();
    if (!teachers.length) {
      notify.warn('No teachers', 'Please add teachers first.');
      return;
    }

    await openModal((close) =>
      el('div', { class: 'modal' }, [
        el('div', { class: 'modal-head' }, [
          el('h3', { text: 'Add Payroll Record' }),
          el('button', { class: 'btn ghost sm', text: 'Close', onClick: close }),
        ]),
        el('div', { class: 'modal-body' }, [
          el('div', { class: 'form-grid' }, [
            el('div', { class: 'field full' }, [
              el('label', { for: 'payroll_teacher_form', text: 'Teacher' }),
              el('select', { id: 'payroll_teacher_form' },
                teachers.map((t) => el('option', { value: t.id, text: t.fullName }))
              ),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'payroll_month', text: 'Month/Year' }),
              el('input', { id: 'payroll_month', type: 'month', value: new Date().toISOString().slice(0, 7) }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'payroll_total', text: 'Total Days' }),
              el('input', { id: 'payroll_total', type: 'number', value: '30' }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'payroll_present', text: 'Present Days' }),
              el('input', { id: 'payroll_present', type: 'number', value: '30' }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'payroll_deduct', text: 'Deductions' }),
              el('input', { id: 'payroll_deduct', type: 'number', value: '0' }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'payroll_bonus', text: 'Bonus' }),
              el('input', { id: 'payroll_bonus', type: 'number', value: '0' }),
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
    const teacherId = Number($('#payroll_teacher_form').value);
    const monthYear = $('#payroll_month').value.trim();
    const totalDays = Number($('#payroll_total').value) || 30;
    const presentDays = Number($('#payroll_present').value) || 30;
    const deductions = Number($('#payroll_deduct').value) || 0;
    const bonus = Number($('#payroll_bonus').value) || 0;

    if (!teacherId || !monthYear) {
      notify.warn('Missing fields', 'Please select a teacher and month.');
      return;
    }

    try {
      await window.api.teacherPayroll.upsert({
        teacherId, monthYear, totalDays, presentDays, deductions, bonus,
      });
      notify.ok('Payroll saved');
      close();
      selfRendered();
      await this.load();
    } catch (err) {
      notify.error('Failed', err.message);
    }
  },
};