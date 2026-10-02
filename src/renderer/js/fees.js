/**
 * Fee & Invoicing view.
 *
 * Owns the invoice list, invoice create/edit, payment recording and the two
 * document engines: a full A4 invoice and a compact 58 mm thermal receipt.
 */
'use strict';

const Fees = {
  rows: [],
  search: '',
  status: '',

  async load() {
    const view = $('#view-fees');
    view.innerHTML = '<div class="empty"><span class="spinner"></span> Loading invoices...</div>';

    // A student may be handed over from the Students view.
    const preselect = Nav.params && Nav.params.studentId;
    if (preselect) {
      Nav.params = {};
      await this.load();
      await this.openForm({ studentId: Number(preselect) });
      return;
    }

    this.rows = await window.api.invoices.list({ search: this.search, status: this.status });

    const totals = this.rows.reduce(
      (acc, r) => {
        const billed = Number(r.amountDue) - Number(r.discount);
        const paid = Number(r.amountPaid);
        acc.billed += billed;
        acc.paid += paid;
        acc.due += Math.max(billed - paid, 0);
        return acc;
      },
      { billed: 0, paid: 0, due: 0 },
    );

    view.innerHTML = `
      <div class="grid cols-4">
        ${kpi('Total billed', money(totals.billed), this.rows.length + ' invoice(s)', 'accent-brand')}
        ${kpi('Collected', money(totals.paid), 'payments received', 'accent-ok')}
        ${kpi('Outstanding', money(totals.due), 'still to be paid', totals.due > 0 ? 'accent-danger' : 'accent-ok')}
        ${kpi('Default period', currentMonthLabel(), 'pre-filled for new invoices')}
      </div>

      <div class="card mt">
        <div class="card-head"><h3>Invoices</h3></div>
        <div class="card-body">
          <div class="search-row no-print">
            <input type="search" id="invoiceSearch" placeholder="Search invoice no, student or roll no..."
                   value="${esc(this.search)}" />
            <select id="invoiceStatus">
              <option value="">All statuses</option>
              ${['Paid', 'Partial', 'Unpaid']
                .map((s) => `<option value="${s}" ${s === this.status ? 'selected' : ''}>${s}</option>`)
                .join('')}
            </select>
            <button class="btn primary" id="addInvoice">+ New invoice</button>
          </div>
        </div>
        <div class="card-body tight">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Invoice No</th><th>Student</th><th>Class</th><th>Fee Month</th>
                  <th class="num">Billed</th><th class="num">Paid</th><th class="num">Due</th>
                  <th>Status</th><th class="actions">Actions</th>
                </tr>
              </thead>
              <tbody>${
                this.rows.length
                  ? this.rows.map((r) => this.row(r)).join('')
                  : emptyRow(9, this.search ? 'No invoices match your search.' : 'No invoices yet. Create your first invoice.', '&#128203;')
              }</tbody>
            </table>
          </div>
        </div>
      </div>`;

    this.bind(view);
  },

  row(r) {
    const billed = Number(r.amountDue) - Number(r.discount);
    const due = Math.max(billed - Number(r.amountPaid), 0);
    return `<tr data-id="${r.id}">
      <td class="mono">${esc(r.invoiceNo)}</td>
      <td><strong>${esc(r.studentName)}</strong></td>
      <td>${esc(r.studentClass)}</td>
      <td>${esc(r.feeMonth)}</td>
      <td class="num">${money(billed)}</td>
      <td class="num">${money(r.amountPaid)}</td>
      <td class="num">${due > 0 ? `<span style="color:var(--warn)">${money(due)}</span>` : '<span class="muted">0.00</span>'}</td>
      <td>${statusBadge(r.status)}</td>
      <td class="actions no-print">
        <button class="btn sm" data-act="pay" data-id="${r.id}">Pay</button>
        <button class="btn sm" data-act="a4" data-id="${r.id}">A4</button>
        <button class="btn sm" data-act="thermal" data-id="${r.id}">Receipt</button>
        <button class="btn sm" data-act="edit" data-id="${r.id}">Edit</button>
        <button class="btn sm danger" data-act="delete" data-id="${r.id}">Delete</button>
      </td>
    </tr>`;
  },

  bind(view) {
    let timer = null;
    $('#invoiceSearch', view).addEventListener('input', (e) => {
      clearTimeout(timer);
      const value = e.target.value;
      timer = setTimeout(async () => {
        this.search = value;
        await this.load();
        const box = $('#invoiceSearch');
        if (box) {
          box.focus();
          box.setSelectionRange(box.value.length, box.value.length);
        }
      }, 220);
    });

    $('#invoiceStatus', view).addEventListener('change', async (e) => {
      this.status = e.target.value;
      await this.load();
    });

    $('#addInvoice', view).addEventListener('click', () => this.openForm());

    on(view, 'click', 'button[data-act]', async (e, btn) => {
      const invoice = this.rows.find((r) => r.id === Number(btn.dataset.id));
      if (!invoice) return;
      switch (btn.dataset.act) {
        case 'pay':
          await this.openPayment(invoice);
          break;
        case 'a4':
          await this.print(invoice, 'invoice');
          break;
        case 'thermal':
          await this.print(invoice, 'thermal');
          break;
        case 'edit':
          await this.openForm(invoice);
          break;
        case 'delete':
          await this.remove(invoice);
          break;
        default:
          break;
      }
    });
  },

  /* ------------------------------------------------------------------ */
  /* Invoice create / edit                                               */
  /* ------------------------------------------------------------------ */

  async openForm(existing = null) {
    // A brand new form may carry a {studentId} hint; an existing invoice is
    // identified by its own id.
    const hintId = existing ? existing.studentId : (Nav.params && Nav.params.studentId) || null;
    const editing = !!(existing && existing.id);

    const students = await window.api.students.list('');
    if (!students.length) {
      notify.warn('No students yet', 'Add a student before creating an invoice.');
      Nav.go('students');
      return;
    }

    let suggestedNo = '';
    if (!editing) {
      suggestedNo = await window.api.invoices.nextNumber();
    }

    openModal((close) =>
      el('div', { class: 'modal' }, [
        el('div', { class: 'modal-head' }, [
          el('h3', { text: editing ? 'Edit ' + existing.invoiceNo : 'New Invoice' }),
        ]),
        el('div', { class: 'modal-body' }, [
          el('div', { class: 'form-grid' }, [
            el('div', { class: 'field full' }, [
              el('label', { for: 'f_studentId', text: 'Student' }),
              el(
                'select',
                { id: 'f_studentId' },
                students.map((s) =>
                  el('option', {
                    value: s.id,
                    text: s.name + ' (' + s.rollNo + ') - ' + s.studentClass,
                    selected: Number(s.id) === Number(hintId),
                  }),
                ),
              ),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'f_invoiceNo', text: 'Invoice No' }),
              el('input', { id: 'f_invoiceNo', maxlength: '40', value: editing ? existing.invoiceNo : suggestedNo }),
              el('span', { class: 'hint', text: 'Suggested automatically - edit to override.' }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'f_feeMonth', text: 'Fee month' }),
              el('input', { id: 'f_feeMonth', maxlength: '40', value: editing ? existing.feeMonth : currentMonthLabel() }),
            ]),
            el('div', { class: 'field full' }, [
              el('label', { for: 'f_description', text: 'Description' }),
              el('input', { id: 'f_description', maxlength: '160', value: editing ? existing.description : 'Tuition Fee' }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'f_amountDue', text: 'Amount due' }),
              el('input', { id: 'f_amountDue', type: 'number', min: '0', step: '0.01', value: editing ? existing.amountDue : '0' }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'f_discount', text: 'Discount' }),
              el('input', { id: 'f_discount', type: 'number', min: '0', step: '0.01', value: editing ? existing.discount : '0' }),
            ]),
            editing
              ? null
              : el('div', { class: 'field' }, [
                  el('label', { for: 'f_amountPaid', text: 'Opening payment' }),
                  el('input', { id: 'f_amountPaid', type: 'number', min: '0', step: '0.01', value: '0' }),
                ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'f_method', text: 'Payment method' }),
              el(
                'select',
                { id: 'f_method' },
                ['Cash', 'Card', 'Bank Transfer', 'Cheque', 'Online'].map((m) =>
                  el('option', { value: m, text: m }),
                ),
              ),
            ]),
            el('div', { class: 'field full' }, [
              el('label', { for: 'f_notes', text: 'Notes' }),
              el('textarea', { id: 'f_notes', maxlength: '400' }, editing ? existing.notes || '' : ''),
            ]),
          ]),
          el('div', { class: 'kv', id: 'invoiceSummary', style: 'margin-top:16px;border-top:1px solid var(--line);padding-top:12px' }),
        ]),
        el('div', { class: 'modal-foot' }, [
          el('button', { class: 'btn ghost', text: 'Cancel', onClick: close }),
          el('button', {
            class: 'btn primary',
            text: editing ? 'Save changes' : 'Create invoice',
            onClick: (e) => withBusy(e.currentTarget, () => this.submit(existing, close)),
          }),
        ]),
      ]),
    );

    this.bindLiveTotal();
  },

  /** Keeps the payable summary in the dialog in sync with the amount inputs. */
  bindLiveTotal() {
    const update = () => {
      const read = (sel) => (($(sel) ? $(sel).value : '') || 0);
      const amountDue = Number(read('#f_amountDue')) || 0;
      const discount = Number(read('#f_discount')) || 0;
      const paid = Number(read('#f_amountPaid')) || 0;
      const payable = amountDue - discount;
      const balance = payable - paid;
      const status = payable <= 0 || paid >= payable ? 'Paid' : paid > 0 ? 'Partial' : 'Unpaid';
      const box = $('#invoiceSummary');
      if (!box) return;
      box.innerHTML =
        '<span class="k">Net payable</span><span class="v">' + money(payable) + '</span>' +
        '<span class="k">Balance after payment</span><span class="v">' + money(Math.max(balance, 0)) + '</span>' +
        '<span class="k">Status</span><span class="v">' + statusBadge(status) + '</span>';
    };
    ['#f_amountDue', '#f_discount', '#f_amountPaid'].forEach((sel) => {
      const node = $(sel);
      if (node) node.addEventListener('input', update);
    });
    update();
  },

  async submit(existing, close) {
    const val = (sel) => ($(sel) ? $(sel).value.trim() : '');
    const payload = {
      studentId: Number(val('#f_studentId')),
      invoiceNo: val('#f_invoiceNo'),
      feeMonth: val('#f_feeMonth'),
      description: val('#f_description'),
      amountDue: Number(val('#f_amountDue')) || 0,
      discount: Number(val('#f_discount')) || 0,
      amountPaid: Number(val('#f_amountPaid')) || 0,
      method: val('#f_method'),
      notes: $('#f_notes') ? $('#f_notes').value.trim() : '',
    };

    if (!payload.studentId) {
      notify.warn('Select a student', 'Please choose which student this invoice is for.');
      return;
    }
    if (!payload.feeMonth) {
      notify.warn('Fee month required', 'Please enter the fee period.');
      $('#f_feeMonth').focus();
      return;
    }
    if (payload.discount > payload.amountDue) {
      notify.warn('Invalid discount', 'The discount cannot exceed the amount due.');
      $('#f_discount').focus();
      return;
    }
    if (payload.amountPaid > payload.amountDue - payload.discount) {
      notify.warn('Invalid payment', 'The opening payment cannot exceed the net payable amount.');
      $('#f_amountPaid').focus();
      return;
    }

    if (existing && existing.id) {
      await window.api.invoices.update({ id: existing.id, ...payload });
      notify.ok('Invoice updated', existing.invoiceNo + ' has been updated.');
    } else {
      const created = await window.api.invoices.create(payload);
      notify.ok('Invoice created', created.invoiceNo + ' is ready to print.');
    }
    close();
    await this.load();
  },

  /* ------------------------------------------------------------------ */
  /* Payments                                                            */
  /* ------------------------------------------------------------------ */

  async openPayment(invoice) {
    const data = await window.api.invoices.get(invoice.id);
    const inv = data.invoice;
    const billed = Number(inv.amountDue) - Number(inv.discount);
    const balance = Math.max(billed - Number(inv.amountPaid), 0);

    openModal((close) =>
      el('div', { class: 'modal' }, [
        el('div', { class: 'modal-head' }, [el('h3', { text: 'Record Payment - ' + inv.invoiceNo })]),
        el('div', { class: 'modal-body' }, [
          el('div', { class: 'kv' }, [
            el('span', { class: 'k', text: 'Student' }),
            el('span', { class: 'v', text: inv.studentName + ' (' + inv.rollNo + ')' }),
            el('span', { class: 'k', text: 'Net payable' }),
            el('span', { class: 'v', text: money(billed) }),
            el('span', { class: 'k', text: 'Already paid' }),
            el('span', { class: 'v', text: money(inv.amountPaid) }),
            el('span', { class: 'k', text: 'Balance due' }),
            el('span', { class: 'v', style: 'color:var(--warn)', text: money(balance) }),
          ]),
          el('div', { class: 'form-grid', style: 'margin-top:18px' }, [
            el('div', { class: 'field' }, [
              el('label', { for: 'p_amount', text: 'Amount received' }),
              el('input', { id: 'p_amount', type: 'number', min: '0.01', step: '0.01', value: balance.toFixed(2) }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'p_method', text: 'Method' }),
              el(
                'select',
                { id: 'p_method' },
                ['Cash', 'Card', 'Bank Transfer', 'Cheque', 'Online'].map((m) => el('option', { value: m, text: m })),
              ),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'p_reference', text: 'Reference' }),
              el('input', { id: 'p_reference', maxlength: '80' }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'p_note', text: 'Note' }),
              el('input', { id: 'p_note', maxlength: '200' }),
            ]),
          ]),
          el('div', { style: 'margin-top:20px' }, [
            el('h4', {
              class: 'muted',
              text: 'Payment history',
              style: 'margin:0 0 8px;font-size:11px;letter-spacing:1px;text-transform:uppercase',
            }),
            data.payments.length
              ? el('table', {
                  html:
                    '<thead><tr><th>Date</th><th>Method</th><th>Reference</th><th class="num">Amount</th></tr></thead><tbody>' +
                    data.payments
                      .map(
                        (p) =>
                          '<tr><td>' + formatDate(p.paidOn) + '</td><td>' + esc(p.method) + '</td><td>' +
                          (esc(p.reference) || '-') + '</td><td class="num">' + money(p.amount) + '</td></tr>',
                      )
                      .join('') +
                    '</tbody>',
                })
              : el('p', { class: 'muted', text: 'No payments recorded yet.', style: 'margin:0;font-size:12.5px' }),
          ]),
        ]),
        el('div', { class: 'modal-foot' }, [
          el('button', { class: 'btn ghost', text: 'Cancel', onClick: close }),
          balance <= 0
            ? null
            : el('button', {
                class: 'btn primary',
                text: 'Record payment',
                onClick: (e) => withBusy(e.currentTarget, () => this.submitPayment(invoice, close)),
              }),
        ]),
      ]),
    );

    const amount = $('#p_amount');
    if (amount) {
      amount.focus();
      amount.select();
    }
  },

  async submitPayment(invoice, close) {
    const val = (sel) => ($(sel) ? $(sel).value.trim() : '');
    const amount = Number(val('#p_amount'));
    if (!(amount > 0)) {
      notify.warn('Invalid amount', 'Enter an amount greater than zero.');
      return;
    }
    await window.api.invoices.addPayment({
      invoiceId: invoice.id,
      amount,
      method: val('#p_method') || 'Cash',
      reference: val('#p_reference'),
      note: val('#p_note'),
    });
    notify.ok('Payment recorded', money(amount) + ' received against ' + invoice.invoiceNo + '.');
    close();
    await this.load();
  },

  async remove(invoice) {
    const ok = await confirmDialog({
      title: 'Delete invoice',
      message: 'Delete invoice ' + invoice.invoiceNo + '?',
      detail: 'Every payment recorded against this invoice is removed as well.',
      confirmText: 'Delete invoice',
      danger: true,
    });
    if (!ok) return;
    await window.api.invoices.remove(invoice.id);
    notify.ok('Invoice deleted', invoice.invoiceNo + ' has been removed.');
    await this.load();
  },

  /* ------------------------------------------------------------------ */
  /* Documents                                                           */
  /* ------------------------------------------------------------------ */

  /** Builds the document and hands it to the shared print pipeline. */
  async print(invoice, mode) {
    const data = await window.api.invoices.get(invoice.id);
    printDocument(mode === 'thermal' ? thermalReceipt(data) : a4Invoice(data), mode);
  },

  /** Screen preview of a document (identical markup to what is printed). */
  async preview(invoice, mode) {
    const data = await window.api.invoices.get(invoice.id);
    const holder = el('div', {});
    renderPreview(holder, mode === 'thermal' ? thermalReceipt(data) : a4Invoice(data));

    openModal((close) =>
      el('div', { class: 'modal wide' }, [
        el('div', { class: 'modal-head' }, [
          el('h3', { text: mode === 'thermal' ? 'Receipt preview' : 'Invoice preview' }),
          el('button', { class: 'btn ghost sm', text: 'Close', onClick: close }),
        ]),
        el('div', { class: 'modal-body' }, [holder]),
        el('div', { class: 'modal-foot' }, [
          el('button', { class: 'btn ghost', text: 'Close', onClick: close }),
          el('button', {
            class: 'btn primary',
            text: 'Print',
            onClick: () => printDocument(mode === 'thermal' ? thermalReceipt(data) : a4Invoice(data), mode),
          }),
        ]),
      ]),
    );
  },
};

/* ====================================================================== */
/* Shared document fragments                                              */
/* ====================================================================== */

function docHead(settings) {
  const s = settings || State.settings;
  const logo = s.schoolLogo
    ? '<img class="logo" src="' + esc(s.schoolLogo) + '" alt="" />'
    : '<div class="logo" style="display:flex;align-items:center;justify-content:center;background:#1e3a8a;color:#fff;font-weight:800;font-size:22px;border-radius:10px">CC</div>';
  return (
    '<div class="doc-school-head">' + logo +
    '<div class="who"><div class="name">' + esc(s.schoolName || 'School') + '</div>' +
    '<div class="tagline">' + esc(s.schoolTagline || '') + '</div>' +
    '<div class="contact">' + docContact(s) + '</div></div></div>'
  );
}

function docContact(s) {
  const parts = [];
  if (s.schoolAddress) parts.push(esc(s.schoolAddress));
  const line = [s.schoolPhone, s.schoolEmail].filter(Boolean).map(esc);
  if (line.length) parts.push(line.join(' &middot; '));
  return parts.join('<br />');
}

/* ---------------------------------------------------------------------- */
/* A4 / Letter invoice                                                      */
/* ---------------------------------------------------------------------- */

function a4Invoice({ invoice, student, payments, settings }) {
  const s = settings || State.settings;
  const billed = Number(invoice.amountDue) - Number(invoice.discount);
  const balance = Math.max(billed - Number(invoice.amountPaid), 0);

  const party = (title, rows) =>
    '<div class="box"><h4>' + title + '</h4>' +
    rows.map(([k, v]) => '<div class="row"><span class="k">' + esc(k) + '</span><span class="v">' + (v || '-') + '</span></div>').join('') +
    '</div>';

  return (
    '<div class="paper">' + docHead(s) +
    '<div class="doc-title-band"><h2>Fee Invoice</h2><span class="no">' + esc(invoice.invoiceNo) + '</span></div>' +
    '<div class="doc-parties">' +
      party('Billed To', [
        ['Name', esc(invoice.studentName)],
        ['Roll No', esc(invoice.rollNo)],
        ['Class', esc(invoice.studentClass)],
        ['Guardian', student && student.guardian ? esc(student.guardian) : ''],
        ['Contact', student && student.phone ? esc(student.phone) : ''],
      ]) +
      party('Invoice Details', [
        ['Invoice date', formatDate(invoice.createdAt)],
        ['Fee month', esc(invoice.feeMonth)],
        ['Academic year', s.academicYear ? esc(s.academicYear) : ''],
        ['Status', '<span class="status-stamp ' + esc(invoice.status) + '">' + esc(invoice.status) + '</span>'],
      ]) +
    '</div>' +
    '<table class="doc-table">' +
      '<thead><tr><th style="width:34px">#</th><th>Description</th><th class="num" style="width:120px">Amount</th></tr></thead>' +
      '<tbody><tr><td>1</td><td>' + esc(invoice.description) +
        (invoice.notes ? '<br /><span style="color:#64748b">' + esc(invoice.notes) + '</span>' : '') +
        '</td><td class="num">' + money(invoice.amountDue) + '</td></tr></tbody>' +
    '</table>' +
    '<div class="doc-totals"><div class="inner">' +
      '<div class="row"><span>Amount due</span><span>' + money(invoice.amountDue) + '</span></div>' +
      '<div class="row"><span>Discount</span><span>- ' + money(invoice.discount) + '</span></div>' +
      '<div class="row"><span>Net payable</span><span>' + money(billed) + '</span></div>' +
      '<div class="row"><span>Amount paid</span><span>' + money(invoice.amountPaid) + '</span></div>' +
      '<div class="row grand"><span>Balance due</span><span>' + money(balance) + '</span></div>' +
    '</div></div>' +
    (payments && payments.length
      ? '<h4 class="doc-sub">Payments received</h4>' +
        '<table class="doc-table"><thead><tr><th>Date</th><th>Method</th><th>Reference</th><th class="num">Amount</th></tr></thead><tbody>' +
        payments
          .map(
            (p) =>
              '<tr><td>' + formatDate(p.paidOn) + '</td><td>' + esc(p.method) + '</td><td>' +
              (esc(p.reference) || '-') + '</td><td class="num">' + money(p.amount) + '</td></tr>',
          )
          .join('') +
        '</tbody></table>'
      : '') +
    '<div class="doc-signs">' +
      '<div class="sign"><div class="line">Guardian signature</div></div>' +
      '<div class="sign"><div class="line">' + esc(s.teacherName || 'Class teacher') + '</div></div>' +
      '<div class="sign"><div class="line">' + esc(s.principalName || 'Principal') + '</div></div>' +
    '</div>' +
    '<div class="doc-foot-note">' + esc(s.invoiceFooter || '') + '</div>' +
    '</div>'
  );
}

/* ---------------------------------------------------------------------- */
/* 58 mm thermal receipt                                                    */
/* ---------------------------------------------------------------------- */

function thermalReceipt({ invoice, payments, settings }) {
  const s = settings || State.settings;
  const billed = Number(invoice.amountDue) - Number(invoice.discount);
  const balance = Math.max(billed - Number(invoice.amountPaid), 0);
  const rule = '<div class="t-rule"></div>';
  const line = (k, v) => '<div class="t-row"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>';

  return (
    '<div class="paper thermal">' +
    '<div class="t-center">' +
      (s.schoolLogo ? '<img class="t-logo" src="' + esc(s.schoolLogo) + '" alt="" />' : '') +
      '<div class="t-school">' + esc(s.schoolName || 'School') + '</div>' +
      (s.schoolAddress ? '<div class="t-sub">' + esc(s.schoolAddress) + '</div>' : '') +
      ([s.schoolPhone, s.schoolEmail].filter(Boolean).length
        ? '<div class="t-sub">' + [s.schoolPhone, s.schoolEmail].filter(Boolean).map(esc).join(' | ') + '</div>'
        : '') +
    '</div>' +
    rule + '<div class="t-center t-big">FEE INVOICE</div>' +
    '<div class="t-center t-sub">' + esc(invoice.invoiceNo) + '</div>' + rule +
    line('Date', formatDate(invoice.createdAt)) +
    line('Roll', invoice.rollNo) +
    line('Name', invoice.studentName) +
    line('Class', invoice.studentClass) +
    line('Period', invoice.feeMonth) +
    rule +
    '<div class="t-row"><span class="k">' + esc(invoice.description) + '</span><span class="v">' + money(invoice.amountDue) + '</span></div>' +
    rule +
    '<div class="t-total"><span>NET</span><span>' + money(billed) + '</span></div>' +
    (Number(invoice.discount) > 0 ? line('Discount', '- ' + money(invoice.discount)) : '') +
    line('Paid', money(invoice.amountPaid)) +
    '<div class="t-total"><span>BALANCE</span><span>' + money(balance) + '</span></div>' +
    rule + '<div class="t-center t-big">' + esc(String(invoice.status).toUpperCase()) + '</div>' +
    (payments && payments.length
      ? rule + payments
          .map(
            (p) =>
              '<div class="t-row"><span class="k">' + formatDate(p.paidOn) + ' ' + esc(p.method) +
              '</span><span class="v">' + money(p.amount) + '</span></div>',
          )
          .join('')
      : '') +
    (invoice.notes ? rule + '<div class="t-sub t-center">' + esc(invoice.notes) + '</div>' : '') +
    rule +
    '<div class="t-foot">' + esc(s.invoiceFooter || 'Thank you!') + '</div>' +
    '<div class="t-foot t-sub">Printed ' + formatDateTime(todayISO()) + '</div>' +
    '</div>'
  );
}
