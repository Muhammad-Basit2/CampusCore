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

    // If no specific teacher selected, show due salaries
    if (!this.teacherId) {
      this.rows = await window.api.teacherPayroll.dueSalaries({
        monthYear: this.monthYear,
      });
    } else {
      this.rows = await window.api.teacherPayroll.list({
        teacherId: this.teacherId ? Number(this.teacherId) : undefined,
        monthYear: this.monthYear,
      });
    }

    view.innerHTML = `
      <div class="grid cols-4">
        ${kpi('Total Payroll', this.rows.length, 'records', 'accent-brand')}
        ${kpi('Paid', this.rows.filter(r => r.status === 'Paid').length, 'processed', 'accent-ok')}
        ${kpi('Unpaid', this.rows.filter(r => r.status === 'Unpaid').length, 'pending', 'accent-danger')}
        ${kpi('Total Net', money(this.rows.reduce((a, r) => a + (r.netSalary || 0), 0)), 'this period')}
      </div>

      <div class="card mt">
        <div class="card-head">
          <h3>${this.teacherId ? 'Payroll Records' : 'Due Salaries'}</h3>
          <div class="search-row no-print">
            <select id="payroll_teacher">
              <option value="">All Teachers</option>
            </select>
            <input type="month" id="payroll_month" value="${this.monthYear}" />
            <button class="btn" id="payroll_refresh">Refresh</button>
            ${!this.teacherId ? '<button class="btn success" id="payroll_pay_all">💳 Pay All Unpaid</button>' : ''}
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
    on(view, 'click', '#payroll_pay_all', () => this.payAllUnpaid());
    on(view, 'click', '.print-btn', async (e) => {
      const id = Number(e.target.dataset.id);
      const row = this.rows.find(r => r.id === id);
      if (row) {
        await this.printSalaryInvoice(row);
      }
    });
    on(view, 'click', '.edit-btn', async (e) => {
      const id = Number(e.target.dataset.id);
      const row = this.rows.find(r => r.id === id);
      if (row) {
        await this.openForm(row);
      }
    });
    on(view, 'click', '.mark-paid', async (e) => {
      const row = this.rows.find(r => r.id === Number(e.target.dataset.id));
      if (row && !row.id) {
        // New record - need to save first
        await this.saveAndPay(row);
      } else {
        // Existing record - just mark as paid
        const id = Number(e.target.dataset.id);
        try {
          await window.api.teacherPayroll.markPaid({ id });
          notify.ok('Marked as paid');
          await this.load();
        } catch (err) {
          notify.error('Failed', err.message);
        }
      }
    });
    on(view, 'click', '.delete-btn', async (e) => {
      const id = Number(e.target.dataset.id);
      if (!id) {
        notify.warn('Cannot delete', 'This record has not been saved yet.');
        return;
      }
      const ok = await confirmDialog({
        title: 'Delete payroll record',
        message: 'Delete this payroll record?',
        confirmText: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        await window.api.teacherPayroll.remove(id);
        notify.ok('Payroll deleted');
        await this.load();
      } catch (err) {
        notify.error('Failed', err.message);
      }
    });
  },

  async saveAndPay(row) {
    try {
      // First save the record
      await window.api.teacherPayroll.upsert({
        teacherId: row.teacherId,
        monthYear: row.monthYear,
        totalDays: row.totalDays,
        presentDays: row.presentDays,
        deductions: row.deductions,
        bonus: row.bonus,
      });
      
      // Get the saved record to get its ID
      const saved = await window.api.teacherPayroll.list({
        teacherId: row.teacherId,
        monthYear: row.monthYear,
      });
      
      if (saved.length > 0) {
        const id = saved[0].id;
        await window.api.teacherPayroll.markPaid({ id });
        notify.ok('Salary paid successfully');
        await this.load();
      }
    } catch (err) {
      notify.error('Failed', err.message);
    }
  },

  async payAllUnpaid() {
    const unpaid = this.rows.filter(r => r.status === 'Unpaid');
    if (!unpaid.length) {
      notify.warn('No unpaid records', 'All salaries have been paid.');
      return;
    }

    const ok = await confirmDialog({
      title: 'Pay All Unpaid Salaries',
      message: `Mark ${unpaid.length} salary record(s) as paid?`,
      confirmText: 'Pay All',
    });
    
    if (!ok) return;

    try {
      for (const row of unpaid) {
        if (!row.id) {
          // New record - save first
          await window.api.teacherPayroll.upsert({
            teacherId: row.teacherId,
            monthYear: row.monthYear,
            totalDays: row.totalDays,
            presentDays: row.presentDays,
            deductions: row.deductions,
            bonus: row.bonus,
          });
          
          // Get the saved record to get its ID
          const saved = await window.api.teacherPayroll.list({
            teacherId: row.teacherId,
            monthYear: row.monthYear,
          });
          
          if (saved.length > 0) {
            await window.api.teacherPayroll.markPaid({ id: saved[0].id });
          }
        } else {
          // Existing record - just mark as paid
          await window.api.teacherPayroll.markPaid({ id: row.id });
        }
      }
      notify.ok(`${unpaid.length} salaries paid successfully`);
      await this.load();
    } catch (err) {
      notify.error('Failed', err.message);
    }
  },


  row(r) {
    return `<tr data-id="${r.id}">
      <td class="mono">${esc(r.monthYear)}</td>
      <td><strong>${esc(r.fullName)}</strong></td>
      <td>${esc(r.presentDays)} / ${esc(r.totalDays)}</td>
      <td class="num">${money(r.netSalary)}</td>
      <td>${statusBadge(r.status)}</td>
      <td class="actions">
        <button class="btn ghost sm print-btn" data-id="${r.id}" title="Print Invoice">🖨️</button>
        <button class="btn ghost sm edit-btn" data-id="${r.id}" title="Edit">✏️</button>
        ${r.status === 'Unpaid' ? `<button class="btn ghost sm mark-paid" data-id="${r.id}" title="Pay Salary">💳</button>` : ''}
        <button class="btn danger sm delete-btn" data-id="${r.id}" title="Delete">🗑️</button>
      </td>
    </tr>`;
  },

  async openForm(existing = null) {
    const teachers = await window.api.teachers.list();
    if (!teachers.length) {
      notify.warn('No teachers', 'Please add teachers first.');
      return;
    }

    const isEdit = !!existing;
    const defaultMonth = existing ? existing.monthYear : new Date().toISOString().slice(0, 7);

    await openModal((close) =>
      el('div', { class: 'modal' }, [
        el('div', { class: 'modal-head' }, [
          el('h3', { text: isEdit ? 'Edit Payroll Record' : 'Add Payroll Record' }),
          el('button', { class: 'btn ghost sm', text: 'Close', onClick: close }),
        ]),
        el('div', { class: 'modal-body' }, [
          el('div', { class: 'form-grid' }, [
            el('div', { class: 'field full' }, [
              el('label', { for: 'payroll_teacher_form', text: 'Teacher' }),
              el('select', { id: 'payroll_teacher_form', disabled: isEdit },
                teachers.map((t) => el('option', { value: t.id, text: t.fullName, selected: existing?.teacherId === t.id }))
              ),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'payroll_month', text: 'Month/Year' }),
              el('input', { id: 'payroll_month', type: 'month', value: defaultMonth, disabled: isEdit }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'payroll_total', text: 'Total Days' }),
              el('input', { id: 'payroll_total', type: 'number', value: existing?.totalDays || '30' }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'payroll_present', text: 'Present Days' }),
              el('input', { id: 'payroll_present', type: 'number', value: existing?.presentDays || '30' }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'payroll_salary', text: 'Salary (Optional)' }),
              el('input', { id: 'payroll_salary', type: 'number', placeholder: 'Leave blank to use base salary', value: existing?.salary || '' }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'payroll_deduct', text: 'Deductions' }),
              el('input', { id: 'payroll_deduct', type: 'number', value: existing?.deductions || '0' }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'payroll_bonus', text: 'Bonus' }),
              el('input', { id: 'payroll_bonus', type: 'number', value: existing?.bonus || '0' }),
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
    const salary = Number($('#payroll_salary').value) || 0;
    const deductions = Number($('#payroll_deduct').value) || 0;
    const bonus = Number($('#payroll_bonus').value) || 0;

    if (!teacherId || !monthYear) {
      notify.warn('Missing fields', 'Please select a teacher and month.');
      return;
    }

    try {
      await window.api.teacherPayroll.upsert({
        teacherId, monthYear, totalDays, presentDays, salary, deductions, bonus,
      });
      notify.ok('Payroll saved');
      close();
      selfRendered();
      await this.load();
    } catch (err) {
      notify.error('Failed', err.message);
    }
  },

  async printSalaryInvoice(payrollRecord) {
    try {
      const data = await window.api.teacherPayroll.get(payrollRecord.id);
      printDocument(salaryInvoice(data), 'invoice');
    } catch (err) {
      notify.error('Failed', err.message);
    }
  },
};

/* ====================================================================== */
/* Salary Invoice Template                                                */
/* ====================================================================== */

function salaryInvoice(data) {
  const s = State.settings || {};
  const { teacher, payroll } = data;
  const monthDate = new Date(payroll.monthYear + '-01');
  const monthName = monthDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return `
    <div class="paper a4">
      <div class="doc-header">
        ${s.schoolLogo ? `<img src="${s.schoolLogo}" alt="Logo" class="school-logo" />` : ''}
        <div class="school-info">
          <h1>${esc(s.schoolName || 'CampusCore School')}</h1>
          <p>${esc(s.schoolTagline || '')}</p>
          <p>${esc(s.schoolAddress || '')} | ${esc(s.schoolPhone || '')}</p>
          <p>${esc(s.schoolEmail || '')}</p>
        </div>
      </div>

      <div class="doc-body">
        <h2>SALARY PAYMENT SLIP</h2>
        
        <div class="invoice-meta">
          <div class="meta-item">
            <span class="label">Month:</span>
            <span class="value">${monthName}</span>
          </div>
          <div class="meta-item">
            <span class="label">Date:</span>
            <span class="value">${new Date().toLocaleDateString()}</span>
          </div>
        </div>

        <div class="teacher-info">
          <h3>Teacher Information</h3>
          <div class="info-grid">
            <div class="info-item">
              <span class="label">Name:</span>
              <span class="value">${esc(teacher.fullName || '')}</span>
            </div>
            <div class="info-item">
              <span class="label">Phone:</span>
              <span class="value">${esc(teacher.phone || 'N/A')}</span>
            </div>
            <div class="info-item">
              <span class="label">Email:</span>
              <span class="value">${esc(teacher.email || 'N/A')}</span>
            </div>
            <div class="info-item">
              <span class="label">Attendance:</span>
              <span class="value">${payroll.presentDays} / ${payroll.totalDays} days</span>
            </div>
          </div>
        </div>

        <table class="salary-breakdown">
          <thead>
            <tr>
              <th>Description</th>
              <th class="amount">Amount (${s.currencySymbol || 'Rs'})</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Gross Salary</td>
              <td class="amount">${money(payroll.salary || 0)}</td>
            </tr>
            ${payroll.deductions > 0 ? `
            <tr class="deduction">
              <td>Deductions</td>
              <td class="amount">-${money(payroll.deductions)}</td>
            </tr>
            ` : ''}
            ${payroll.bonus > 0 ? `
            <tr class="bonus">
              <td>Bonus</td>
              <td class="amount">+${money(payroll.bonus)}</td>
            </tr>
            ` : ''}
            <tr class="total">
              <td><strong>Net Salary</strong></td>
              <td class="amount"><strong>${money(payroll.netSalary)}</strong></td>
            </tr>
          </tbody>
        </table>

        <div class="payment-status">
          <p><strong>Payment Status:</strong> ${payroll.status === 'Paid' ? `<span class="badge ok">PAID on ${payroll.paymentDate}</span>` : '<span class="badge pending">UNPAID</span>'}</p>
        </div>

        <div class="footer-text">
          <p>${s.invoiceFooter || 'Thank you for your service. Please keep this slip safe.'}</p>
          <p style="margin-top: 20px; color: #666; font-size: 12px;">
            Generated by ${s.schoolName || 'CampusCore'} on ${new Date().toLocaleString()}
          </p>
        </div>
      </div>
    </div>
  `;
}